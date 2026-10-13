import { api } from './api.js';

const NAV_ITEMS = [
  { href: '/index.html', label: '今日' },
  { href: '/study.html', label: '学习' },
  { href: '/reading.html', label: '阅读' },
  { href: '/listening.html', label: '听力' },
  { href: '/chat.html', label: '对话' },
  { href: '/books.html', label: '词书' },
  { href: '/notebook.html', label: '生词本' },
  { href: '/stats.html', label: '统计' },
  { href: '/settings.html', label: '设置' },
];

/** 注入顶部导航，active 为当前页路径 */
export function mountNav(active) {
  const nav = document.createElement('nav');
  nav.className = 'nav';

  const inner = document.createElement('div');
  inner.className = 'nav-inner';

  const brand = document.createElement('a');
  brand.className = 'nav-brand';
  brand.href = '/index.html';
  brand.textContent = '英语学习';
  inner.appendChild(brand);

  for (const item of NAV_ITEMS) {
    const link = document.createElement('a');
    link.className = 'nav-link' + (item.href === active ? ' active' : '');
    link.href = item.href;
    link.textContent = item.label;
    inner.appendChild(link);
  }

  nav.appendChild(inner);
  document.body.prepend(nav);
}

/** 全局主题应用（在页面渲染前尽早调用，避免闪烁） */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  const stored = localStorage.getItem('el_theme');
  if (theme) localStorage.setItem('el_theme', theme);
  return stored;
}

export function readStoredTheme() {
  return localStorage.getItem('el_theme') || 'light';
}

let toastTimer = null;

/** 轻提示 */
export function toast(message) {
  let element = document.querySelector('.toast');
  if (!element) {
    element = document.createElement('div');
    element.className = 'toast';
    document.body.appendChild(element);
  }
  element.textContent = message;
  element.classList.add('show');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2000);
}

/**
 * 朗读单词。使用浏览器原生语音合成，零成本、无需后端。
 * 浏览器不支持时静默失败，不打断学习流程。
 */
export function speak(text, accent = 'us') {
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = accent === 'uk' ? 'en-GB' : 'en-US';
  utterance.rate = 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
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
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    location.href = '/login.html';
  }
}
