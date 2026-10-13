import { requireUser } from '../context.js';
import { readJsonBody, sendOk, httpError } from '../http.js';
import { localStamp } from '../time.js';
import { requestTutorStream, streamTutorEvents } from '../dify.js';

/** 学习助教：历史消息、清空、发消息（SSE） */
export function registerTutorRoutes(router, { db }) {
  router.get('/api/tutor/messages', async (req, res, ctx) => {
    const user = requireUser(ctx);

    const rows = db
      .prepare(
        `SELECT role, content, created_at AS createdAt
           FROM tutor_messages
          WHERE user_id = ?
          ORDER BY id`
      )
      .all(user.id);

    sendOk(res, { messages: rows });
  });

  router.delete('/api/tutor/messages', async (req, res, ctx) => {
    const user = requireUser(ctx);

    db.prepare('DELETE FROM tutor_messages WHERE user_id = ?').run(user.id);
    // 会话也要一并作废 —— 只清本地记录的话，Dify 那边还记着之前聊过什么，
    // 用户以为重新开始了，助教却还接着旧话题
    db.prepare('UPDATE settings SET tutor_conversation_id = NULL WHERE user_id = ?').run(user.id);

    sendOk(res, { cleared: true });
  });

  // 发一条消息，以 SSE 流式返回助教回复
  router.post('/api/tutor/messages', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const body = await readJsonBody(req);

    const content = String(body.content || '').trim();
    if (!content) throw httpError(400, 'EMPTY_MESSAGE', '请输入内容');
    if (content.length > 2000) throw httpError(400, 'MESSAGE_TOO_LONG', '单条消息不能超过 2000 字');

    const conversationId = loadConversationId(db, user.id);

    // 先完成「发起请求」这一步：失败时还能返回正常的 JSON 错误，
    // 也不会留下一条永远没有回复的用户消息
    const upstream = await requestTutorStream({
      query: content,
      user: `user-${user.id}`,
      conversationId,
    });

    insertMessage(db, user.id, 'user', content);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let full = '';
    let latestConversationId = conversationId;

    try {
      for await (const event of streamTutorEvents(upstream.body)) {
        if (event.type === 'error') {
          writeSse(res, 'error', { message: event.message });
          res.end();
          return;
        }

        if (event.conversationId) latestConversationId = event.conversationId;

        if (event.type === 'delta') {
          full += event.text;
          writeSse(res, 'delta', { text: event.text });
        }
      }
    } catch (error) {
      writeSse(res, 'error', { message: '生成中断，请重试' });
      res.end();
      console.error('助教流中断：', error.message);
      return;
    }

    if (latestConversationId && latestConversationId !== conversationId) {
      saveConversationId(db, user.id, latestConversationId);
    }
    if (full) insertMessage(db, user.id, 'assistant', full);

    writeSse(res, 'done', { ok: true });
    res.end();
  });
}

function loadConversationId(db, userId) {
  const row = db
    .prepare('SELECT tutor_conversation_id AS id FROM settings WHERE user_id = ?')
    .get(userId);
  return row?.id || '';
}

function saveConversationId(db, userId, conversationId) {
  db.prepare('UPDATE settings SET tutor_conversation_id = ? WHERE user_id = ?').run(
    conversationId,
    userId
  );
}

function insertMessage(db, userId, role, content) {
  db.prepare(
    'INSERT INTO tutor_messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(userId, role, content, localStamp());
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
