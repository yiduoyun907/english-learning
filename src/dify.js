/**
 * 学习助教：调用 Dify 托管的 Agent。
 *
 * 与 src/chat.js 不是一套东西 —— 那边走 Anthropic Messages API，
 * 这里走 Dify 的 Service API：POST {baseUrl}/chat-messages。
 * 事件格式也不同：Dify 是 `event: message` + data.answer 文本增量，
 * 不是 Anthropic 的 content_block_delta。所以解析器要另写一份。
 *
 * 同样只用 Node 内置 fetch，不引入 SDK。
 */
import { config } from './config.js';

/**
 * 发起一次助教对话（流式）。返回原始的 Response，由调用方逐块读取。
 * conversationId 为空表示开新会话，Dify 会在响应里回传新的 ID。
 */
export async function requestTutorStream({ query, user, conversationId }) {
  const { baseUrl, apiKey, timeoutMs } = config.dify;

  if (!apiKey) {
    const error = new Error('尚未配置助教所需的凭证');
    error.code = 'TUTOR_NOT_CONFIGURED';
    error.status = 503;
    error.expose = true; // 可预期的失败，如实告诉前端原因
    throw error;
  }

  const response = await fetch(`${baseUrl}/chat-messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      inputs: {},
      query,
      // Dify 默认是阻塞式响应，必须显式要求流式
      response_mode: 'streaming',
      conversation_id: conversationId || '',
      // Dify 要求带一个用户标识，用于会话隔离与统计
      user,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`助教接口返回 ${response.status}`);
    error.code = 'TUTOR_REQUEST_FAILED';
    error.status = 502;
    error.expose = true;
    error.detail = detail.slice(0, 400);
    throw error;
  }

  return response;
}

/**
 * 从 Dify 的 SSE 流里抽出文本增量、会话 ID 与错误。
 *
 * Dify 会推很多种事件（agent_thought、message_file、ping…），
 * 这里只认三种：message（正文增量）、message_end（收尾）、error。
 * 其余一律忽略 —— 全都要处理的话，每种 Agent 配置都得跟着改。
 */
export async function* streamTutorEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;

      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      if (event.event === 'message' && typeof event.answer === 'string') {
        yield { type: 'delta', text: event.answer, conversationId: event.conversation_id };
      } else if (event.event === 'message_end') {
        yield { type: 'end', conversationId: event.conversation_id };
      } else if (event.event === 'error') {
        yield { type: 'error', message: event.message || '助教返回了错误' };
      }
    }
  }
}
