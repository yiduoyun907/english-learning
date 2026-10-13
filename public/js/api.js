/** 统一的接口调用封装：自动处理 { ok, data } / { ok, error } 协议 */

export async function api(path, { method = 'GET', body } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: {},
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

/** 页面进入前调用：未登录则跳转登录页并中断后续逻辑 */
export async function requireLogin() {
  try {
    return await api('/api/auth/me');
  } catch (error) {
    if (error.status === 401) {
      location.href = '/login.html';
      return null;
    }
    throw error;
  }
}
