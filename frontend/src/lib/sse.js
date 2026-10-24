/**
 * 解析服务端推送的 SSE 事件流。
 *
 * 对话页与助教共用同一套协议：块之间以空行分隔，块内是 event: / data: 行，
 * data 为 JSON。无法解析的片段直接忽略，避免单个坏帧中断整条回复。
 */
export async function readSse(response, handlers, { signal } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';

      for (const block of blocks) {
        dispatchBlock(block, handlers);
      }
    }
  } finally {
    reader.cancel().catch(() => {
      // 流已经结束时取消失败属正常情况
    });
  }
}

function dispatchBlock(block, handlers) {
  let event = 'message';
  let data = '';

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;

  try {
    const payload = JSON.parse(data);
    if (handlers[event]) handlers[event](payload);
  } catch {
    // 忽略无法解析的片段
  }
}
