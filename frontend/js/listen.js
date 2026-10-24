import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, esc } from './ui.js';

const slug = new URLSearchParams(location.search).get('slug');

const RATE_NORMAL = 0.95;
const RATE_SLOW = 0.65;

let sentences = [];
let current = 0;
let submitted = false;
let accent = 'us';
let voice = null;
let loopTimer = null;

let titleEl;
let metaEl;
let progressEl;
let hintEl;
let answerEl;
let resultEl;
let loopEl;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  accent = session.settings.accent || 'us';
  mountNav('/listening.html');

  if (!slug) {
    location.href = '/listening.html';
    return;
  }

  if (!('speechSynthesis' in window)) {
    toast('当前浏览器不支持语音合成');
    return;
  }

  titleEl = document.getElementById('title');
  metaEl = document.getElementById('meta');
  progressEl = document.getElementById('progress');
  hintEl = document.getElementById('hint');
  answerEl = document.getElementById('answer');
  resultEl = document.getElementById('result');
  loopEl = document.getElementById('loop');

  bindControls();
  prepareVoices();

  const data = await api(`/api/listening/${encodeURIComponent(slug)}`);
  sentences = data.sentences;
  titleEl.textContent = data.material.title;
  metaEl.textContent = `${data.material.titleZh} · 共 ${sentences.length} 句`;

  if (sentences.length === 0) {
    toast('这篇材料没有可练习的句子');
    return;
  }

  showSentence(0);
}

/* ---------- 语音 ---------- */

function prepareVoices() {
  const load = () => {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    const preferred = accent === 'uk' ? 'en-GB' : 'en-US';
    voice =
      voices.find((item) => item.lang === preferred) ||
      voices.find((item) => item.lang && item.lang.startsWith('en')) ||
      null;
  };

  load();
  window.speechSynthesis.onvoiceschanged = load;
}

function speak(text, rateOverride) {
  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = accent === 'uk' ? 'en-GB' : 'en-US';
  utterance.rate =
    rateOverride ?? (document.getElementById('slow').checked ? RATE_SLOW : RATE_NORMAL);
  if (voice) utterance.voice = voice;

  // 循环播放：播完停顿一下再播一遍
  utterance.onend = () => {
    if (loopEl.checked && !submitted) {
      loopTimer = setTimeout(() => speak(text), 800);
    }
  };

  synth.speak(utterance);
}

function stopSpeaking() {
  clearTimeout(loopTimer);
  window.speechSynthesis.cancel();
}

/* ---------- 句子切换 ---------- */

function showSentence(index) {
  current = index;
  submitted = false;
  stopSpeaking();

  const sentence = sentences[index];
  progressEl.textContent = `${index + 1} / ${sentences.length}`;
  hintEl.textContent = `这句话有 ${sentence.wordCount} 个词`;

  answerEl.value = '';
  answerEl.disabled = false;
  resultEl.replaceChildren();
  document.getElementById('submit').disabled = false;

  document.getElementById('prev').disabled = index === 0;
  document.getElementById('next').disabled = index === sentences.length - 1;

  if (sentence.latestAccuracy !== null) {
    hintEl.textContent += ` · 上次 ${Math.round(sentence.latestAccuracy * 100)}%`;
  }

  // 进入新句自动朗读一次，省一次点击
  speak(sentence.text);
}

/* ---------- 提交与结果 ---------- */

async function submit() {
  const input = answerEl.value.trim();
  if (!input) {
    toast('请先写下听到的内容');
    return;
  }

  stopSpeaking();
  const button = document.getElementById('submit');
  button.disabled = true;

  try {
    const result = await api(`/api/listening/${encodeURIComponent(slug)}/attempt`, {
      method: 'POST',
      body: { sentenceIndex: current, input },
    });

    submitted = true;
    answerEl.disabled = true;
    sentences[current].latestAccuracy = result.accuracy;
    renderResult(result);
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

function renderResult(result) {
  const percent = Math.round(result.accuracy * 100);
  const tone = percent >= 90 ? 'good' : percent >= 60 ? 'ok' : 'poor';

  const tokens = result.tokens
    .map(
      (token) =>
        `<span class="tk tk-${token.status}">${esc(token.text)}</span>`
    )
    .join(' ');

  const legend = [];
  if (result.tokens.some((token) => token.status === 'missing')) {
    legend.push('<span class="tk tk-missing">红字</span> 是你漏掉或写错的词');
  }
  if (result.tokens.some((token) => token.status === 'extra')) {
    legend.push('<span class="tk tk-extra">灰字</span> 是你多写的词');
  }

  resultEl.innerHTML = `
    <div class="answer" style="margin-top:18px;">
      <div class="row-between">
        <div class="answer-label">比对结果</div>
        <span class="score score-${tone}">${percent}%</span>
      </div>
      <div class="tk-line">${tokens}</div>
      <p class="small muted" style="margin:8px 0 0;">
        写对 ${result.correctCount} / ${result.expectedCount} 个词${legend.length ? ' · ' + legend.join(' · ') : ''}
      </p>

      <div class="answer-block" style="margin-top:14px;">
        <div class="answer-label">原句</div>
        <div class="answer-text">${esc(result.answer)}</div>
      </div>

      <div class="row" style="margin-top:14px;">
        <button class="btn btn-sm" id="result-play" type="button">再听一遍</button>
        <button class="btn btn-sm" id="result-slow" type="button">慢速跟读</button>
        <button class="btn btn-sm btn-primary" id="result-next" type="button">下一句</button>
      </div>
    </div>
  `;

  document.getElementById('result-play').addEventListener('click', () => speak(result.answer));
  document.getElementById('result-slow').addEventListener('click', () =>
    speak(result.answer, RATE_SLOW)
  );
  document.getElementById('result-next').addEventListener('click', () => {
    if (current < sentences.length - 1) showSentence(current + 1);
  });
}

/* ---------- 事件绑定 ---------- */

function bindControls() {
  document.getElementById('play').addEventListener('click', () => {
    speak(sentences[current].text);
  });

  document.getElementById('submit').addEventListener('click', submit);

  document.getElementById('prev').addEventListener('click', () => {
    if (current > 0) showSentence(current - 1);
  });

  document.getElementById('next').addEventListener('click', () => {
    if (current < sentences.length - 1) showSentence(current + 1);
  });

  // Ctrl/Cmd + Enter 提交；输入框里按 Enter 不换行而是提交
  answerEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!submitted) submit();
    }
  });

  // 离开页面时停止朗读，避免切走后还在响
  window.addEventListener('beforeunload', stopSpeaking);
}

main().catch((error) => toast(error.message));
