/**
 * AI 对话陪练的核心逻辑：场景定义、提示词构建、流式调用与回复解析。
 *
 * 调用走 Anthropic Messages API 格式（POST {baseUrl}/v1/messages），
 * 实际模型由 ANTHROPIC_BASE_URL 指向的端点决定 —— 本机指向 DeepSeek。
 * 只用 Node 内置 fetch，不引入 SDK，以保持项目零依赖。
 */
import { config } from './config.js';

/** 对话场景。persona 直接进系统提示词，决定 AI 扮演的角色 */
export const SCENES = [
  {
    id: 'interview',
    name: 'Job Interview',
    nameZh: '求职面试',
    hint: '面试官会追问你的经历和技能',
    persona:
      'You are a hiring manager at a technology company, interviewing the user for a software engineering role. Ask realistic follow-up questions about their experience, skills and motivation. Stay in character as the interviewer.',
    opening: 'Thanks for coming in today. To start, could you tell me a little about yourself?',
  },
  {
    id: 'restaurant',
    name: 'At a Restaurant',
    nameZh: '餐厅点餐',
    hint: '练习点餐、询问菜品与结账',
    persona:
      'You are a friendly waiter at a casual restaurant. Guide the user through ordering: greet them, describe dishes when asked, take their order, and handle the bill. Stay in character as the waiter.',
    opening: 'Good evening! Welcome in. Table for one, or are you expecting someone?',
  },
  {
    id: 'airport',
    name: 'At the Airport',
    nameZh: '机场值机',
    hint: '值机、托运行李、安检问询',
    persona:
      'You are a check-in agent at an international airport. Help the user check in, ask about luggage and seat preference, and answer questions about boarding. Stay in character.',
    opening: 'Good morning. May I see your passport and ticket, please?',
  },
  {
    id: 'meeting',
    name: 'Business Meeting',
    nameZh: '商务会议',
    hint: '表达观点、讨论方案、提出异议',
    persona:
      'You are a colleague in a business meeting, discussing a project timeline with the user. Ask for their opinion, raise practical concerns, and negotiate priorities. Stay in character.',
    opening: "Before we go further, I'd like to hear your view on the timeline. Do you think it's realistic?",
  },
  {
    id: 'doctor',
    name: "At the Doctor's",
    nameZh: '看医生',
    hint: '描述症状、回答问诊',
    persona:
      "You are a general practitioner. Ask the user about their symptoms, how long they have had them, and any related history. Be warm and professional. Stay in character.",
    opening: 'Come on in and have a seat. What brings you in today?',
  },
  {
    id: 'smalltalk',
    name: 'Small Talk',
    nameZh: '日常闲聊',
    hint: '聊天气、周末、兴趣爱好',
    persona:
      'You are a friendly acquaintance chatting casually with the user. Keep the conversation light and natural — weather, weekend plans, hobbies, food. Stay in character.',
    opening: "Hey! Long time no see. How have you been lately?",
  },
];

export function findScene(sceneId) {
  return SCENES.find((scene) => scene.id === sceneId) || null;
}

/** 正文与纠错之间的分隔标记 */
export const FIX_MARKER = '\n---FIX---\n';

/**
 * 系统提示词。要求模型在正文之后附一段 JSON 纠错，
 * 便于服务端一次调用同时拿到回复与批改结果。
 */
export function buildSystemPrompt(scene) {
  return [
    scene.persona,
    '',
    'Rules:',
    '1. Reply in English only. Keep each turn short and natural — usually 1 to 3 sentences.',
    '2. Always end your turn with a question or prompt that invites the user to speak again.',
    '3. If the user makes grammar, word-choice or word-order mistakes, note them in the corrections section.',
    `4. After your reply, output the exact marker ${JSON.stringify(FIX_MARKER.trim())} on its own line, then a JSON array of corrections.`,
    '   Each item: {"wrong": "<the user\'s original phrase>", "right": "<corrected phrase>", "note": "<brief explanation in Chinese>"}.',
    '   If the user made no mistakes, output an empty array []. Do not wrap the JSON in code fences.',
  ].join('\n');
}

/** 调用模型（流式）。返回原始的 Response，由调用方逐块读取 */
export async function requestChatStream({ system, messages }) {
  const { baseUrl, authToken, model, timeoutMs } = config.llm;

  if (!baseUrl || !authToken) {
    const error = new Error('尚未配置 AI 对话所需的凭证');
    error.code = 'LLM_NOT_CONFIGURED';
    error.status = 503;
    error.expose = true; // 属于可预期的失败，应把原因如实返回给前端
    throw error;
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages,
      // 对话陪练不需要长链思考，关掉可显著降低延迟
      thinking: { type: 'disabled' },
      stream: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`模型接口返回 ${response.status}`);
    error.code = 'LLM_REQUEST_FAILED';
    error.status = 502;
    error.expose = true;
    error.detail = detail.slice(0, 400);
    throw error;
  }

  return response;
}

/**
 * 解析模型输出：拆成「给用户看的正文」与「纠错数组」。
 * 模型偶尔不守格式，这里做容错 —— 解析不出纠错就当没有，不影响对话主体。
 */
export function parseAssistantReply(raw) {
  const markerIndex = raw.indexOf(FIX_MARKER.trim());

  if (markerIndex === -1) {
    return { content: raw.trim(), corrections: [] };
  }

  const content = raw.slice(0, markerIndex).trim();
  const jsonPart = raw.slice(markerIndex + FIX_MARKER.trim().length).trim();

  return { content, corrections: safeParseCorrections(jsonPart) };
}

function safeParseCorrections(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && typeof item.wrong === 'string' && typeof item.right === 'string')
      .slice(0, 5)
      .map((item) => ({
        wrong: item.wrong.slice(0, 120),
        right: String(item.right).slice(0, 120),
        note: String(item.note || '').slice(0, 160),
      }));
  } catch {
    return [];
  }
}

/**
 * 从 SSE 数据流中逐块抽出文本增量。
 * 只关心 content_block_delta 里的 text_delta，其余事件忽略。
 */
export async function* streamTextDeltas(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const event = JSON.parse(payload);
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield event.delta.text;
        }
      } catch {
        // 忽略无法解析的行（如 ping）
      }
    }
  }
}
