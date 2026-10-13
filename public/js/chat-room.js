import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, speak, esc } from './ui.js';

const conversationId = new URLSearchParams(location.search).get('id');

let accent = 'us';
let sending = false;
let recognition = null;
let recognizing = false;

let logEl;
let inputEl;
let sendBtn;
let voiceBtn;
let voiceStatusEl;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  accent = session.settings.accent || 'us';
  mountNav('/chat.html');

  if (!conversationId) {
    location.href = '/chat.html';
    return;
  }

  logEl = document.getElementById('chat-log');
  inputEl = document.getElementById('chat-input');
  sendBtn = document.getElementById('send-btn');
  voiceBtn = document.getElementById('voice-btn');
  voiceStatusEl = document.getElementById('voice-status');

  const data = await api(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
  document.getElementById('scene-name').textContent = data.conversation.sceneNameZh || '';

  for (const message of data.messages) {
    appendMessage(message);
  }
  scrollToBottom();

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  setupVoice();
  inputEl.focus();
}

/* ---------- 消息渲染 ---------- */

function appendMessage(message) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg msg-${message.role === 'user' ? 'user' : 'ai'}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = message.content || '';
  wrapper.appendChild(bubble);

  if (message.role === 'assistant') {
    wrapper.appendChild(buildSpeakButton(message.content));
  }

  logEl.appendChild(wrapper);
  return wrapper;
}

function buildSpeakButton(text) {
  const row = document.createElement('div');
  row.className = 'msg-actions';
  const button = document.createElement('button');
  button.className = 'btn btn-sm';
  button.type = 'button';
  button.textContent = '朗读';
  button.addEventListener('click', () => speak(text, accent));
  row.appendChild(button);
  return row;
}

/** 把纠错挂到某条用户消息下面 */
function attachCorrections(userWrapper, corrections) {
  if (!corrections || corrections.length === 0) return;

  const box = document.createElement('div');
  box.className = 'msg-fix';
  box.innerHTML = corrections
    .map(
      (item) => `
        <div class="fix-item">
          <div><span class="fix-wrong">${esc(item.wrong)}</span> → <span class="fix-right">${esc(
            item.right
          )}</span></div>
          ${item.note ? `<div class="small muted">${esc(item.note)}</div>` : ''}
        </div>`
    )
    .join('');

  userWrapper.appendChild(box);
}

/* ---------- 发送与流式接收 ---------- */

async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content || sending) return;

  sending = true;
  sendBtn.disabled = true;
  inputEl.value = '';

  const userWrapper = appendMessage({ role: 'user', content });
  const aiWrapper = appendMessage({ role: 'assistant', content: '' });
  const bubble = aiWrapper.querySelector('.msg-bubble');
  bubble.classList.add('is-streaming');
  scrollToBottom();

  let finished = false;

  try {
    const response = await fetch(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content }),
      }
    );

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
    }

    await readSse(response, {
      delta: ({ text }) => {
        bubble.textContent += text;
        scrollToBottom();
      },
      done: ({ content: reply, corrections }) => {
        finished = true;
        bubble.classList.remove('is-streaming');
        bubble.textContent = reply;

        // 建立气泡时已加过朗读按钮（绑的是空文本），这里先移除再按最终内容重建，
        // 否则会出现两个重复的「朗读」
        const existingActions = aiWrapper.querySelector('.msg-actions');
        if (existingActions) existingActions.remove();
        aiWrapper.appendChild(buildSpeakButton(reply));

        attachCorrections(userWrapper, corrections);
        scrollToBottom();
      },
      error: ({ message }) => {
        throw new Error(message);
      },
    });

    if (!finished) bubble.classList.remove('is-streaming');
  } catch (error) {
    bubble.classList.remove('is-streaming');
    if (!bubble.textContent) bubble.textContent = '（生成失败）';
    toast(error.message);
  } finally {
    sending = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

/** 解析服务端推送的 SSE 事件流 */
async function readSse(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      let event = 'message';
      let data = '';

      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;

      try {
        const payload = JSON.parse(data);
        if (handlers[event]) handlers[event](payload);
      } catch {
        // 忽略无法解析的片段
      }
    }
  }
}

/* ---------- 语音输入 ---------- */

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    voiceBtn.hidden = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript;
    inputEl.value = `${inputEl.value} ${text}`.trim();
  };

  recognition.onerror = (event) => {
    voiceStatusEl.textContent = event.error === 'not-allowed' ? '没有麦克风权限' : '识别失败';
  };

  recognition.onend = () => {
    recognizing = false;
    voiceBtn.textContent = '语音输入';
    voiceStatusEl.textContent = '';
  };

  voiceBtn.addEventListener('click', () => {
    if (recognizing) {
      recognition.stop();
      return;
    }
    recognizing = true;
    voiceBtn.textContent = '停止';
    voiceStatusEl.textContent = '正在听…';
    recognition.start();
  });
}

function scrollToBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

main().catch((error) => toast(error.message));
