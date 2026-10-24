/** 统一的接口调用封装：自动处理 { ok, data } / { ok, error } 协议 */

export async function api(path, { method = 'GET', body, signal } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: {},
    signal,
  };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(path, options);

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || payload.ok !== true) {
    const message = payload?.error?.message || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }

  return payload.data;
}
