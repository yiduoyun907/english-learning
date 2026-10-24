import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, speak, esc } from './ui.js';

/** daily = 今日校验（只考今天新学的词）；review = 复习队列（考今天之前的旧词） */
const scope = new URLSearchParams(location.search).get('scope') === 'review' ? 'review' : 'daily';

/**
 * 复习会话的存储位置。
 *
 * 版本号要跟着「取词判据」一起走：早先修正 reps > 0 判据时忘了升版本，
 * 结果旧会话里存着修正前取到的题（含只收藏未学的词），恢复后直接渲染，
 * 绕过了后端的新判据 —— 现象就是「复习里又出现没学过的词」。
 */
const SESSION_KEY = 'el_quiz_session';
const SESSION_VERSION = 2;
/** 会话闲置超过这个时长就丢弃，免得翻出很久以前做了一半的题 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let questions = [];
let results = [];
let position = 0;
let answered = false;
let accent = 'us';

/** 仅 review 使用：当前复习会话，记着跨轮次累计复习过的词 */
let reviewSession = null;
/** 当前会话对应的设置指纹，影响题目的设置一变就重新开始 */
let sessionFingerprint = '';

let stageEl;
let progressEl;
let poolInfoEl;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  accent = session.settings.accent || 'us';
  mountNav('/study.html');

  stageEl = document.getElementById('stage');
  progressEl = document.getElementById('progress');
  poolInfoEl = document.getElementById('pool-info');

  if (scope === 'review') {
    await startReview(session.settings);
    return;
  }

  const data = await api('/api/quiz/daily');
  questions = data.questions;

  if (questions.length === 0) {
    renderEmpty(data.reason);
    return;
  }

  renderQuestion();
}

/* ---------- 复习会话 ---------- */

/**
 * 复习是一段可以中断、可以接着做的过程，不是一回合就结束。
 * 现场存在浏览器本地：切去阅读/听力再回来、刷新、关掉浏览器重开，都能接着上次那道题继续。
 * 所以这里优先恢复旧会话，只有没有可恢复的现场时才去取题。
 */
async function startReview(settings) {
  sessionFingerprint = settingsFingerprint(settings);
  reviewSession = loadSession(sessionFingerprint);

  if (reviewSession) {
    // 上一轮已经把池子里的旧词都过了一遍：回到提示页，等用户决定要不要再来
    if (reviewSession.exhausted) {
      renderAllCovered(reviewSession.poolSize);
      return;
    }

    // 无论是做到一半还是已经答完一轮，都先把现场摆回来
    questions = reviewSession.questions;
    results = reviewSession.results;
    position = reviewSession.position;

    if (position >= questions.length) {
      renderSummary();
    } else {
      renderQuestion();
    }
    return;
  }

  await startNextRound();
}

/** 取下一轮的题：排除本会话已复习过的词；都覆盖过了就清空记录，从头再来一轮 */
async function startNextRound() {
  const reviewedIds = reviewSession ? reviewSession.reviewedIds : [];

  let data;
  try {
    data = await api('/api/quiz/review', { method: 'POST', body: { exclude: reviewedIds } });
  } catch (error) {
    // 复习队列有前置条件：今日校验没做完会被后端挡下
    if (error.status === 403) {
      renderLocked(error.message);
      return;
    }
    throw error;
  }

  // 池子非空却被排除干净 —— 说明池子里的旧词都复习过了。
  // 这里不自动开新一轮：池子小的时候那只会原地重复同一批词，让人误以为进度被清掉了。
  if (data.questions.length === 0 && data.poolSize > 0) {
    reviewSession.exhausted = true;
    reviewSession.poolSize = data.poolSize;
    syncSession();
    renderAllCovered(data.poolSize);
    return;
  }

  if (data.questions.length === 0) {
    renderEmpty(data.reason);
    return;
  }

  reviewSession = {
    version: SESSION_VERSION,
    scope: 'review',
    fingerprint: sessionFingerprint,
    questions: data.questions,
    results: [],
    position: 0,
    reviewedIds: [...reviewedIds],
    poolSize: data.poolSize,
    reported: false,
    updatedAt: Date.now(),
  };

  questions = data.questions;
  results = [];
  position = 0;

  syncSession();
  renderQuestion();
}

/** 把内存里的答题现场写回会话并落盘 */
function syncSession() {
  if (!reviewSession) return;

  reviewSession.questions = questions;
  reviewSession.results = results;
  reviewSession.position = position;
  reviewSession.updatedAt = Date.now();

  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(reviewSession));
  } catch {
    // 本地存储不可用（隐私模式等）时静默降级：复习照常，只是不保留进度
  }
}

function loadSession(fingerprint) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }

  if (!saved || saved.version !== SESSION_VERSION || saved.scope !== 'review') return null;
  // 影响题目的设置变了（换词书、改复习上限）→ 旧进度作废，重新来过
  if (saved.fingerprint !== fingerprint) return null;
  if (Date.now() - (saved.updatedAt || 0) > SESSION_TTL_MS) return null;
  if (!Array.isArray(saved.questions) || !Array.isArray(saved.results)) return null;

  return saved;
}

/**
 * 影响复习题目的设置指纹：只取当前词书与复习上限。
 * 词书决定干扰项从哪本书里挑，上限决定一轮出多少题；
 * 主题、发音口音不改变题目内容，改了不该把复习进度清掉。
 */
function settingsFingerprint(settings) {
  return `${settings.activeBook || ''}|${settings.reviewLimit}`;
}

/* ---------- 出题 ---------- */

function renderQuestion() {
  const question = questions[position];
  if (!question) {
    renderSummary();
    return;
  }

  answered = false;
  progressEl.textContent = `${position + 1} / ${questions.length}`;
  updatePoolInfo();

  if (question.type === 'spell') {
    renderSpellQuestion(question);
  } else {
    renderChoiceQuestion(question);
  }
}

/** 看中文拼写英文 */
function renderSpellQuestion(question) {
  stageEl.innerHTML = `
    <div class="card study-card">
      <div class="answer-label center">看中文，拼出英文</div>
      <div class="quiz-prompt" style="margin-top:12px;">${esc(question.translation)}</div>

      <div class="center" style="margin-top:10px;">
        <span class="muted small">${question.headword.length} 个字母</span>
      </div>

      <div style="margin-top:24px;">
        <input class="input" id="spell-input" autocomplete="off" autocapitalize="off"
               spellcheck="false" placeholder="输入英文单词">
        <div class="row" style="margin-top:12px;">
          <span style="flex:1;"></span>
          <button class="btn btn-primary" id="submit-spell" type="button">提交</button>
        </div>
      </div>

      <div id="feedback"></div>
    </div>
  `;

  const input = document.getElementById('spell-input');
  input.focus();
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSpell(question);
    }
  });
  document.getElementById('submit-spell').addEventListener('click', () => submitSpell(question));
}

function submitSpell(question) {
  if (answered) return;
  const input = document.getElementById('spell-input');
  const given = input.value.trim();
  if (!given) {
    toast('先写下答案');
    return;
  }

  // 忽略大小写与首尾标点，和听写模块的比对口径一致
  const correct = normalize(given) === normalize(question.headword);
  finishQuestion(question, correct, given, input);
}

/** 看英文选中文释义 */
function renderChoiceQuestion(question) {
  stageEl.innerHTML = `
    <div class="card study-card">
      <div class="answer-label center">看英文，选出中文释义</div>
      <div class="word-headword" style="margin-top:12px;">${esc(question.headword)}</div>
      <div class="word-phonetic">${question.phonetic ? `/${esc(question.phonetic)}/` : ''}</div>

      <div class="center" style="margin-top:10px;">
        <button class="btn btn-sm" id="quiz-speak" type="button">发音</button>
      </div>

      <div class="quiz-options" id="quiz-options" style="margin-top:24px;"></div>
      <div id="feedback"></div>
    </div>
  `;

  document.getElementById('quiz-speak').addEventListener('click', () => speak(question.headword, accent));

  const list = document.getElementById('quiz-options');
  question.options.forEach((option) => {
    const button = document.createElement('button');
    button.className = 'quiz-option';
    button.type = 'button';
    button.textContent = option;
    button.addEventListener('click', () => {
      if (answered) return;
      const correct = option === question.translation;
      button.classList.add(correct ? 'is-correct' : 'is-wrong');
      if (!correct) {
        markCorrectOption(list, question.translation);
      } else {
        markCorrectOption(list, question.translation);
      }
      finishQuestion(question, correct, option);
    });
    list.appendChild(button);
  });
}

function markCorrectOption(container, translation) {
  for (const button of container.querySelectorAll('.quiz-option')) {
    if (button.textContent === translation) button.classList.add('is-correct');
  }
}

/* ---------- 判定与推进 ---------- */

function finishQuestion(question, correct, given, inputEl) {
  answered = true;
  results.push({
    wordId: question.wordId,
    headword: question.headword,
    translation: question.translation,
    type: question.type,
    correct,
  });

  // 记进会话：下一轮取题时排除这些词，把已学词一轮轮覆盖完
  if (reviewSession && !reviewSession.reviewedIds.includes(question.wordId)) {
    reviewSession.reviewedIds.push(question.wordId);
    updatePoolInfo();
  }

  if (inputEl) inputEl.disabled = true;
  document.querySelectorAll('.quiz-option').forEach((button) => button.classList.add('is-locked'));

  const feedback = document.getElementById('feedback');
  feedback.innerHTML = `
    <div class="answer" style="margin-top:20px;">
      <div class="row-between">
        <span class="answer-label">${correct ? '答对了' : '答错了'}</span>
        <span class="score score-${correct ? 'good' : 'poor'}">${correct ? '✓' : '✗'}</span>
      </div>
      ${
        correct
          ? ''
          : `<div class="small muted" style="margin-top:6px;">
               你写的是「${esc(given)}」，正确答案是 <strong>${esc(question.headword)}</strong>
             </div>`
      }
      ${
        question.type === 'spell'
          ? `<div class="small muted" style="margin-top:6px;">${esc(question.translation)}</div>`
          : ''
      }
      <div class="row" style="margin-top:14px;">
        <button class="btn btn-sm" id="fb-speak" type="button">发音</button>
        <span style="flex:1;"></span>
        <button class="btn btn-primary" id="fb-next" type="button">
          ${position + 1 < questions.length ? '下一题' : '看结果'}
        </button>
      </div>
    </div>
  `;

  document.getElementById('fb-speak').addEventListener('click', () => speak(question.headword, accent));
  const next = document.getElementById('fb-next');
  next.addEventListener('click', () => {
    position += 1;
    syncSession();
    renderQuestion();
  });
  next.focus();
}

/* ---------- 结束 ---------- */

function renderEmpty(reason) {
  progressEl.textContent = '';
  stageEl.innerHTML = `
    <div class="card center" style="padding:48px 24px;">
      <h2>暂时没有可检验的词</h2>
      <p class="muted small">${esc(reason || '先去学几个词吧')}</p>
      <div class="row" style="justify-content:center;margin-top:20px;">
        <a class="btn" href="/index.html">返回首页</a>
        <a class="btn btn-primary" href="/study.html">去学习</a>
      </div>
    </div>
  `;
}

/** 顶部池子信息：让「为什么只有这几题」一眼可见 */
function updatePoolInfo() {
  if (!poolInfoEl) return;

  if (!reviewSession || reviewSession.exhausted) {
    poolInfoEl.hidden = true;
    return;
  }

  const covered = reviewSession.reviewedIds.length;
  const total = Math.max(reviewSession.poolSize || 0, covered);

  poolInfoEl.textContent = `复习池共 ${total} 个词 · 已覆盖 ${covered} 个`;
  poolInfoEl.hidden = false;
}

/**
 * 池子里的旧词都复习完了。
 * 这里不自动开新一轮 —— 池子小的时候那样只会把同一批词反复考，看不出任何进度。
 */
function renderAllCovered(poolSize) {
  progressEl.textContent = '';
  updatePoolInfo();

  stageEl.innerHTML = `
    <div class="card center" style="padding:48px 24px;">
      <h2>当前旧词已复习完</h2>
      <p class="muted small">复习池里的 ${poolSize} 个词都过了一遍</p>
      <div class="row" style="justify-content:center;margin-top:20px;">
        <a class="btn" href="/index.html">返回首页</a>
        <button class="btn btn-primary" id="restart-review" type="button">再复习一轮</button>
      </div>
    </div>
  `;

  document.getElementById('restart-review').addEventListener('click', restartRound);
}

/** 清掉覆盖记录，重新从池子里抽一轮 */
async function restartRound() {
  if (reviewSession) {
    reviewSession.reviewedIds = [];
    reviewSession.exhausted = false;
  }
  await startNextRound();
}

/** 复习队列的前置条件没满足 */
function renderLocked(message) {
  progressEl.textContent = '';
  stageEl.innerHTML = `
    <div class="card center" style="padding:48px 24px;">
      <h2>先完成今日校验</h2>
      <p class="muted small">${esc(message || '完成今天的校验之后，才能开始复习之前的单词')}</p>
      <div class="row" style="justify-content:center;margin-top:20px;">
        <a class="btn" href="/index.html">返回首页</a>
        <a class="btn btn-primary" href="/quiz.html">去做今日校验</a>
      </div>
    </div>
  `;
}

async function renderSummary() {
  progressEl.textContent = '已完成';

  const total = results.length;
  const correct = results.filter((item) => item.correct).length;
  const spellResults = results.filter((item) => item.type === 'spell');
  const spellCorrect = spellResults.filter((item) => item.correct).length;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
  const wrong = results.filter((item) => !item.correct);

  const isReview = scope === 'review';

  // 池子进度交给顶部那条常驻信息显示，结束页不再重复一遍
  updatePoolInfo();

  stageEl.innerHTML = `
    <div class="card center" style="padding:36px 24px;">
      <h2>${isReview ? '这一轮复习完成' : '今日校验完成'}</h2>
      <div class="score score-${accuracy >= 80 ? 'good' : accuracy >= 60 ? 'ok' : 'poor'}"
           style="font-size:40px;margin:8px 0;">${accuracy}%</div>
      <p class="muted small">
        共 ${total} 题，答对 ${correct} 题${spellResults.length ? ` · 拼写 ${spellCorrect}/${spellResults.length}` : ''}
      </p>
    </div>
  `;

  if (wrong.length > 0) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>需要再看一眼（${wrong.length}）</h2>`;

    for (const item of wrong) {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <strong>${esc(item.headword)}</strong>
          <div class="small muted">${esc(item.translation)}</div>
        </div>
        <button class="btn btn-sm" type="button">加入生词本</button>
      `;
      row.querySelector('button').addEventListener('click', async (event) => {
        event.target.disabled = true;
        try {
          await api('/api/notebook', { method: 'POST', body: { wordId: item.wordId, action: 'add' } });
          event.target.textContent = '已加入';
          toast('已加入生词本');
        } catch (error) {
          event.target.disabled = false;
          toast(error.message);
        }
      });
      card.appendChild(row);
    }
    stageEl.appendChild(card);
  }

  // 先提交成绩 —— 今日校验提交成功后,复习入口才应解锁。
  // 复习会跨页面恢复现场，同一轮可能再次走到这里，所以要防重复上报。
  let submitted = Boolean(reviewSession && reviewSession.reported);
  if (!submitted) {
    try {
      await api('/api/quiz/result', {
        method: 'POST',
        body: { scope, total, correct, spellTotal: spellResults.length, spellCorrect },
      });
      submitted = true;
      if (reviewSession) reviewSession.reported = true;
    } catch (error) {
      console.warn('成绩上报失败：', error.message);
    }
  }

  // 一轮走完，把「已完成」这个位置落盘，中途离开再回来能直接回到本页
  position = questions.length;
  syncSession();

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.cssText = 'justify-content:center;margin-top:20px;';

  if (isReview) {
    // 复习没有「结束」这个状态：接着下一轮，已学词都覆盖完了会自动从头再来
    actions.innerHTML = `
      <a class="btn" href="/index.html">返回首页</a>
      <button class="btn btn-primary" id="continue-review" type="button">继续复习</button>
    `;
    actions.querySelector('#continue-review').addEventListener('click', startNextRound);
  } else if (submitted) {
    actions.innerHTML = `
      <a class="btn" href="/index.html">返回首页</a>
      <a class="btn btn-primary" href="/quiz.html?scope=review">复习之前的单词</a>
    `;
  } else {
    actions.innerHTML = `
      <a class="btn" href="/index.html">返回首页</a>
      <a class="btn btn-primary" href="/quiz.html">再检验一次</a>
    `;
  }
  stageEl.appendChild(actions);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

main().catch((error) => toast(error.message));
