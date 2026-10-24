import { reactive } from 'vue';

import { api } from '../lib/api.js';

/**
 * 当前登录会话。多页架构下每个页面加载时请求一次；
 * 后续迁移为 SPA 后，这份状态会在路由间持续共享。
 */
const state = reactive({
  user: null,
  settings: null,
  loaded: false,
});

let pending = null;

export function getSession() {
  return state;
}

export function isLoggedIn() {
  return state.user !== null;
}

/**
 * 页面进入前调用：未登录则跳转登录页并中断后续逻辑。
 * 并发调用会复用同一个请求，避免同一页重复请求 /api/auth/me。
 */
export async function requireLogin({ redirectTo = '/login.html' } = {}) {
  if (state.loaded) return state;
  if (pending) return pending;

  pending = api('/api/auth/me')
    .then((session) => {
      state.user = session.user;
      state.settings = session.settings;
      state.loaded = true;
      return state;
    })
    .catch((error) => {
      if (error.status === 401) {
        if (redirectTo) location.href = redirectTo;
        return null;
      }
      throw error;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

/** 设置保存或词书切换后同步内存状态，避免同一页面读到旧值 */
export function updateSettings(patch) {
  if (!state.settings) return;
  Object.assign(state.settings, patch);
}

export function clearSession() {
  state.user = null;
  state.settings = null;
  state.loaded = false;
}

/** 登出并回到登录页 */
export async function logoutUser() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    clearSession();
    location.href = '/login.html';
  }
}
