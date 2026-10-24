/** 主题读取与应用。localStorage 是首屏缓存，服务端 settings.theme 是登录用户的主值 */

export const THEME_STORAGE_KEY = 'el_theme';

export function readStoredTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) || 'light';
}

export function normalizeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

/** 应用到文档根节点，并写入本地缓存。返回实际生效的主题 */
export function applyTheme(theme) {
  const next = normalizeTheme(theme);
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_STORAGE_KEY, next);
  return next;
}

/** 在应用挂载前同步执行，避免暗色主题首屏闪白 */
export function initThemeFromStorage() {
  const stored = readStoredTheme();
  document.documentElement.dataset.theme = normalizeTheme(stored);
  return stored;
}
