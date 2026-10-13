import { Buffer } from 'node:buffer';

/** 请求体上限：256KB，足够覆盖本站所有 JSON 请求 */
const MAX_BODY_BYTES = 256 * 1024;

/** 统一成功响应：{ ok: true, data } */
export function sendOk(res, data = null, status = 200) {
  sendJson(res, status, { ok: true, data });
}

/** 统一错误响应：{ ok: false, error: { code, message } } */
export function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * 读取并解析 JSON 请求体。
 * 超限或格式非法时抛出带 status/code 的错误，由上层统一转成错误响应。
 */
export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw httpError(413, 'BODY_TOO_LARGE', '请求体过大');
    }
    chunks.push(chunk);
  }

  if (total === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
}

/** 构造带 HTTP 语义的错误对象 */
export function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** 解析 Cookie 头为普通对象 */
export function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}
