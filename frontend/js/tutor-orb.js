/**
 * 首页的助教悬浮球：可拖动、点击展开对话面板。
 *
 * 位置存在浏览器本地，下次打开停在原处。拖动与点击用同一个手势，
 * 靠位移阈值区分 —— 否则按住球稍微一晃就会被当成拖动，面板再也打不开。
 */
import { api } from './api.js';
import { esc, toast } from './ui.js';
import { readSse } from '../src/lib/sse.js';

/** 球的位置存储键 */
const POS_KEY = 'el_tutor_orb_pos';
/** 位移小于这个距离算"点击"，大于算"拖动" */
const DRAG_THRESHOLD = 4;
const ORB_SIZE = 64;
const PANEL_W = 380;

let orbEl = null;
let panelEl = null;
let logEl = null;
let inputEl = null;
let sendEl = null;

let opened = false;
let sending = false;
let historyLoaded = false;

/** 挂在首页上；重复调用只生效一次 */
export function mountTutorOrb() {
  if (orbEl) return;
  buildOrb();
  buildPanel();
  restorePosition();
}

/* ---------- 球 ---------- */

function buildOrb() {
  orbEl = document.createElement('button');
  orbEl.className = 'tutor-orb';
  orbEl.type = 'button';
  orbEl.setAttribute('aria-label', '打开学习助教');
  document.body.appendChild(orbEl);

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let grabX = 0;
  let grabY = 0;

  orbEl.addEventListener('pointerdown', (event) => {
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;

    const rect = orbEl.getBoundingClientRect();
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;

    orbEl.setPointerCapture(event.pointerId);
  });

  orbEl.addEventListener('pointermove', (event) => {
    if (!dragging) return;

    // 超过阈值才算拖动，避免手抖误判
    if (!moved) {
      const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
      if (distance < DRAG_THRESHOLD) return;
      moved = true;
      orbEl.classList.add('is-dragging');
      if (opened) closePanel();
    }

    applyPosition(event.clientX - grabX, event.clientY - grabY);
  });

  orbEl.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    dragging = false;
    orbEl.releasePointerCapture(event.pointerId);
    orbEl.classList.remove('is-dragging');

    if (moved) {
      savePosition();
      return;
    }
    togglePanel();
  });

  // 球被拖到窗口外后（比如旋转屏幕），拉回来
  window.addEventListener('resize', () => {
    const rect = orbEl.getBoundingClientRect();
    applyPosition(rect.left, rect.top);
    if (opened) positionPanel();
  });
}

function applyPosition(left, top) {
  const maxLeft = window.innerWidth - ORB_SIZE;
  const maxTop = window.innerHeight - ORB_SIZE;
  orbEl.style.left = `${Math.min(Math.max(0, left), Math.max(0, maxLeft))}px`;
  orbEl.style.top = `${Math.min(Math.max(0, top), Math.max(0, maxTop))}px`;
}

function savePosition() {
  const rect = orbEl.getBoundingClientRect();
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
  } catch {
    // 本地存储不可用（隐私模式等）时静默降级：球照常能拖，只是记不住位置
  }
}

function restorePosition() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
  } catch {
    saved = null;
  }

  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    applyPosition(saved.left, saved.top);
    return;
  }
  // 默认停在左侧、垂直居中——首页内容最大 720px 居中，宽屏时这里正好是空白区
  applyPosition(24, (window.innerHeight - ORB_SIZE) / 2);
}

/* ---------- 面板 ---------- */

function buildPanel() {
  panelEl = document.createElement('div');
  panelEl.className = 'tutor-panel';
  panelEl.hidden = true;
  panelEl.innerHTML = `
    <div class="tutor-head">
      <img src="/img/tutor-orb.png" alt="">
      <div>
        <div class="tutor-name">助教 Emma</div>
        <div class="tutor-status">英语学习助手</div>
      </div>
      <button class="tutor-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="tutor-log"></div>
    <div class="tutor-input-row">
      <textarea class="tutor-input" rows="1"
                placeholder="问英语学习，或这个网站怎么用…"></textarea>
      <button class="tutor-send" type="button">发送</button>
    </div>
  `;
  document.body.appendChild(panelEl);

  logEl = panelEl.querySelector('.tutor-log');
  inputEl = panelEl.querySelector('.tutor-input');
  sendEl = panelEl.querySelector('.tutor-send');

  panelEl.querySelector('.tutor-close').addEventListener('click', closePanel);
  sendEl.addEventListener('click', send);
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && opened) closePanel();
  });
}

function togglePanel() {
  if (opened) closePanel();
  else openPanel();
}

function openPanel() {
  opened = true;
  panelEl.hidden = false;
  positionPanel();
  inputEl.focus();

  if (!historyLoaded) {
    historyLoaded = true;
    loadHistory();
  }
}

function closePanel() {
  opened = false;
  panelEl.hidden = true;
  orbEl.focus();
}

/** 面板贴着球展开；靠右时翻到球左侧，避免出屏 */
function positionPanel() {
  if (window.innerWidth <= 640) return; // 手机上面板全屏，交给 CSS

  const rect = orbEl.getBoundingClientRect();
  const panelH = Math.min(560, window.innerHeight - 40);

  let left = rect.right + 16;
  if (left + PANEL_W > window.innerWidth - 12) {
    left = rect.left - PANEL_W - 16;
  }

  panelEl.style.left = `${Math.max(12, Math.min(left, window.innerWidth - PANEL_W - 12))}px`;
  panelEl.style.top = `${Math.max(12, Math.min(rect.top + rect.height / 2 - panelH / 2, window.innerHeight - panelH - 12))}px`;
}

/* ---------- 对话 ---------- */

async function loadHistory() {
  try {
    const data = await api('/api/tutor/messages');
    const messages = data.messages || [];

    if (messages.length === 0) {
      appendHint('想聊点什么？英语学习的问题，或者这个网站怎么用，都可以问我。');
      return;
    }
    for (const message of messages) {
      appendMessage(message.role, message.content);
    }
  } catch (error) {
    appendHint('暂时连不上助教');
    console.warn('拉取助教历史失败：', error.message);
  }
}

async function send() {
  const content = inputEl.value.trim();
  if (!content || sending) return;

  sending = true;
  sendEl.disabled = true;
  inputEl.value = '';
  autoGrow();

  appendMessage('user', content);
  const aiEl = appendMessage('assistant', '');
  aiEl.classList.add('is-streaming');

  try {
    const response = await fetch('/api/tutor/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
    }

    let full = '';
    await readSse(response, {
      delta: ({ text }) => {
        full += text;
        renderInto(aiEl, full);
        scrollToEnd();
      },
      error: ({ message }) => {
        throw new Error(message);
      },
    });

    if (!full) renderInto(aiEl, '（没有收到回复，请再试一次）');
  } catch (error) {
    // 把具体原因写进气泡。只弹 toast 的话两秒就没了，
    // 用户只看到一条空回复，分不清是没配凭证还是网络断了
    if (!aiEl.textContent) {
      renderInto(aiEl, `（${error.message || '没能回复，请稍后再试'}）`);
    }
    toast(error.message);
  } finally {
    aiEl.classList.remove('is-streaming');
    sending = false;
    sendEl.disabled = false;
    inputEl.focus();
  }
}

function appendMessage(role, text) {
  const el = document.createElement('div');
  el.className = `tutor-msg tutor-msg-${role === 'user' ? 'user' : 'ai'}`;
  if (text) renderInto(el, text);
  logEl.appendChild(el);
  scrollToEnd();
  return el;
}

function appendHint(text) {
  const el = document.createElement('div');
  el.className = 'tutor-hint';
  el.textContent = text;
  logEl.appendChild(el);
  scrollToEnd();
}

function renderInto(el, text) {
  el.innerHTML = renderMarkdown(text);
}

function scrollToEnd() {
  logEl.scrollTop = logEl.scrollHeight;
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 96)}px`;
}

/**
 * 极简 Markdown 渲染：链接、粗体、行内代码、列表、段落。
 *
 * 项目零依赖，不引 marked。**先整体转义再替换标记** —— 顺序反了会把
 * 用户输入里的标签当 HTML 执行，那是 XSS。
 */
function renderMarkdown(text) {
  let html = esc(text);

  html = html.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  return html
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').filter((line) => line.trim() !== '');
      if (lines.length === 0) return '';

      const isList = lines.every((line) => /^\s*[-*]\s+/.test(line));
      if (isList) {
        const items = lines
          .map((line) => `<li>${line.replace(/^\s*[-*]\s+/, '')}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('');
}

