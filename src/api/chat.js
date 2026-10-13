import { requireUser } from '../context.js';
import { readJsonBody, sendOk, httpError } from '../http.js';
import { localStamp } from '../time.js';
import {
  SCENES,
  findScene,
  buildSystemPrompt,
  requestChatStream,
  parseAssistantReply,
  streamTextDeltas,
} from '../chat.js';

/** 送往模型的历史消息条数上限，避免上下文无限增长 */
const HISTORY_LIMIT = 24;
const FIX_MARKER_TEXT = '---FIX---';

/** AI 对话模块：场景、会话、消息（流式） */
export function registerChatRoutes(router, { db }) {
  router.get('/api/chat/scenes', async (req, res, ctx) => {
    requireUser(ctx);
    sendOk(res, {
      scenes: SCENES.map((scene) => ({
        id: scene.id,
        name: scene.name,
        nameZh: scene.nameZh,
        hint: scene.hint,
      })),
    });
  });

  router.get('/api/chat/conversations', async (req, res, ctx) => {
    const user = requireUser(ctx);

    const rows = db
      .prepare(
        `SELECT c.id AS id, c.scene AS scene, c.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS messageCount,
                (SELECT content FROM chat_messages m WHERE m.conversation_id = c.id
                  ORDER BY m.id DESC LIMIT 1) AS lastMessage
           FROM conversations c
          WHERE c.user_id = ?
          ORDER BY c.updated_at DESC
          LIMIT 50`
      )
      .all(user.id);

    sendOk(res, {
      conversations: rows.map((row) => {
        const scene = findScene(row.scene);
        return {
          id: row.id,
          scene: row.scene,
          sceneName: scene ? scene.name : row.scene,
          sceneNameZh: scene ? scene.nameZh : '',
          messageCount: row.messageCount,
          lastMessage: (row.lastMessage || '').slice(0, 80),
          updatedAt: row.updatedAt,
        };
      }),
    });
  });

  router.post('/api/chat/conversations', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const body = await readJsonBody(req);

    const scene = findScene(String(body.scene || ''));
    if (!scene) throw httpError(400, 'INVALID_SCENE', '场景不存在');

    const now = localStamp();
    const result = db
      .prepare('INSERT INTO conversations (user_id, scene, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(user.id, scene.id, now, now);

    const conversationId = Number(result.lastInsertRowid);
    const opening = insertMessage(db, conversationId, 'assistant', scene.opening, []);

    sendOk(res, {
      conversation: { id: conversationId, scene: scene.id, sceneName: scene.name },
      messages: [
        {
          id: opening.id,
          role: 'assistant',
          content: scene.opening,
          corrections: [],
          createdAt: now,
        },
      ],
    });
  });

  router.get('/api/chat/conversations/:id', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const conversation = findOwnedConversation(db, user.id, ctx.params.id);
    const scene = findScene(conversation.scene);

    const messages = db
      .prepare(
        `SELECT id, role, content, corrections, created_at AS createdAt
           FROM chat_messages WHERE conversation_id = ? ORDER BY id`
      )
      .all(conversation.id)
      .map((row) => ({
        ...row,
        corrections: row.corrections ? JSON.parse(row.corrections) : [],
      }));

    sendOk(res, {
      conversation: {
        id: conversation.id,
        scene: conversation.scene,
        sceneName: scene ? scene.name : conversation.scene,
        sceneNameZh: scene ? scene.nameZh : '',
      },
      messages,
    });
  });

  router.delete('/api/chat/conversations/:id', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const conversation = findOwnedConversation(db, user.id, ctx.params.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation.id);
    sendOk(res, { id: conversation.id });
  });

  // 发送一条消息，以 SSE 流式返回模型回复
  router.post('/api/chat/conversations/:id/messages', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const conversation = findOwnedConversation(db, user.id, ctx.params.id);
    const scene = findScene(conversation.scene);
    if (!scene) throw httpError(500, 'SCENE_MISSING', '会话场景已失效');

    const body = await readJsonBody(req);
    const content = String(body.content || '').trim();
    if (!content) throw httpError(400, 'EMPTY_MESSAGE', '请输入内容');
    if (content.length > 2000) throw httpError(400, 'MESSAGE_TOO_LONG', '单条消息不能超过 2000 字');

    const userMessageId = insertMessage(db, conversation.id, 'user', content, []).id;
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
      localStamp(),
      conversation.id
    );

    const history = db
      .prepare(
        `SELECT role, content FROM chat_messages
          WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(conversation.id, HISTORY_LIMIT)
      .reverse()
      .map((row) => ({ role: row.role, content: row.content }));

    // 先完成「发起请求」这一步，失败时还能返回正常的 JSON 错误；
    // 同时撤回刚保存的用户消息，避免用户重试后留下重复记录
    let upstream;
    try {
      upstream = await requestChatStream({
        system: buildSystemPrompt(scene),
        messages: history,
      });
    } catch (error) {
      db.prepare('DELETE FROM chat_messages WHERE id = ?').run(userMessageId);
      throw error;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let full = '';
    let visibleLength = 0;

    try {
      for await (const delta of streamTextDeltas(upstream.body)) {
        full += delta;

        // 只把纠错标记之前的内容推给前端
        const markerIndex = full.indexOf(FIX_MARKER_TEXT);
        const visibleEnd = markerIndex === -1 ? full.length : markerIndex;

        if (visibleEnd > visibleLength) {
          writeSse(res, 'delta', { text: full.slice(visibleLength, visibleEnd) });
          visibleLength = visibleEnd;
        }
      }
    } catch (error) {
      writeSse(res, 'error', { message: '生成中断，请重试' });
      res.end();
      console.error('对话流中断：', error.message);
      return;
    }

    const { content: reply, corrections } = parseAssistantReply(full);
    const saved = insertMessage(db, conversation.id, 'assistant', reply, corrections);

    writeSse(res, 'done', {
      id: saved.id,
      content: reply,
      corrections,
      createdAt: saved.createdAt,
    });
    res.end();
  });
}

function findOwnedConversation(db, userId, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, 'INVALID_CONVERSATION', '会话 ID 无效');
  }

  const conversation = db
    .prepare('SELECT id, scene FROM conversations WHERE id = ? AND user_id = ?')
    .get(id, userId);

  if (!conversation) throw httpError(404, 'CONVERSATION_NOT_FOUND', '会话不存在');
  return conversation;
}

function insertMessage(db, conversationId, role, content, corrections) {
  const createdAt = localStamp();
  const result = db
    .prepare(
      `INSERT INTO chat_messages (conversation_id, role, content, corrections, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(conversationId, role, content, corrections && corrections.length ? JSON.stringify(corrections) : null, createdAt);

  return { id: Number(result.lastInsertRowid), createdAt };
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
