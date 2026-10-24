import { createApp } from 'vue';

import { requireLogin } from '../stores/session.js';
import { ensureSharedUi, mountNav } from '../mount-shared.js';
import { initThemeFromStorage, readStoredTheme } from './theme.js';

/**
 * 多页架构下每个 Vue 页面的统一入口：
 * 同步恢复主题 → 校验登录 → 挂载共享导航 → 挂载页面组件。
 */
export async function mountPage(View, { activeNav = '', requiresAuth = true } = {}) {
  // 先按本地缓存设置主题，避免等待接口期间闪白
  initThemeFromStorage();
  // 登录页没有导航，但也需要 ToastHost
  ensureSharedUi();

  if (requiresAuth) {
    const session = await requireLogin();
    if (!session) return null;

    document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
    if (activeNav) mountNav(activeNav);
  }

  const host = document.getElementById('app');
  if (!host) throw new Error('页面缺少挂载点 #app');

  const app = createApp(View);
  app.mount(host);
  return app;
}
