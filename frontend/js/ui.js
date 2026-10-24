import { ensureSharedUi, mountNav as mountNavComponent } from '../src/mount-shared.js';
import { showToast } from '../src/composables/useToast.js';
import { applyTheme, readStoredTheme, initThemeFromStorage } from '../src/lib/theme.js';
import { speak as speakText, stopSpeaking } from '../src/lib/speech.js';
import { logoutUser } from '../src/stores/session.js';

export { applyTheme, readStoredTheme, initThemeFromStorage, stopSpeaking };

/** 注入顶部导航，active 为当前页所属模块路径 */
export function mountNav(active) {
  mountNavComponent(active);
}

/** 轻提示 */
export function toast(message) {
  ensureSharedUi();
  showToast(message);
}

/**
 * 朗读单词。使用浏览器原生语音合成，零成本、无需后端。
 * 浏览器不支持时静默失败，不打断学习流程。
 */
export function speak(text, accent = 'us') {
  speakText(text, accent);
}

/** HTML 转义，用于把词库文本安全地插入模板字符串 */
export function esc(value) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (char) => replacements[char]);
}

/** 元素快捷创建 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    node.append(child);
  }
  return node;
}

/** 登出并回到登录页 */
export async function logout() {
  await logoutUser();
}
