import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, speak, esc } from './ui.js';

/**
 * 两档自评。
 *
 * 后端仍接受四档（SM-2 的评分空间摆在那里），这里只发最两极的两种：
 * 记得 → GOOD、忘记 → AGAIN。去掉「模糊 / 简单」是为了让学习者不用在
 * 「这算模糊还是算记得」上反复纠结 —— 判断标准越简单，评得越诚实。
 */
const RATING_OPTIONS = [
  { rating: 0, label: '忘记' },
  { rating: 4, label: '记得' },
];

/** 学习队列的存储位置；结构变动就升版本号，让旧存档作废 */
const SESSION_KEY = 'el_study_session';
const SESSION_VERSION = 1;
/** 闲置超过这个时长就重新取队列，免得翻出几天前做了一半的进度 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let queue = [];
let position = 0;
let revealed = false;
let shownAt = 0;
let accent = 'us';

/** 本次学习的现场：队列本身与做到第几张 */
let studySession = null;
let sessionFingerprint = '';

let stageEl;
let progressEl;
let countsEl;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  accent = session.settings.accent || 'us';
  mountNav('/study.html');

  stageEl = document.getElementById('stage');
  progressEl = document.getElementById('progress');
  countsEl = document.getElementById('counts');

  sessionFingerprint = settingsFingerprint(session.settings);
  studySession = loadSession(sessionFingerprint);

  // 切去别的模块再回来时接着上次那张卡，而不是重新取一遍队列 ——
  // 重新取会导致刚学过的词从「新词」里消失，整个队列和进度都变了样
  if (studySession) {
    queue = studySession.cards;
    position = studySession.position;
    updateCounts();
    renderCard();
    return;
  }

  const data = await api('/api/study/queue?limit=20');
  queue = data.cards;

  if (queue.length === 0) {
    countsEl.textContent = `今日新词 ${data.counts.learnedToday} / ${data.counts.dailyNewLimit}`;
    renderEmpty(data.counts);
    return;
  }

  studySession = {
    version: SESSION_VERSION,
    fingerprint: sessionFingerprint,
    cards: queue,
    position: 0,
    // 记数字而不是记文案：上限和学习进度都会变，存死字符串会让「今日新词」
    // 一直停在进页面那一刻的值
    learnedToday: data.counts.learnedToday,
    dailyNewLimit: data.counts.dailyNewLimit,
    updatedAt: Date.now(),
  };
  updateCounts();
  syncSession();

  renderCard();
}

/**
 * 刷新顶部的「今日新词 已学 / 上限」。
 * 用会话里的数字本地累加，不重新请求 —— 学一张就 +1，当场可见。
 */
function updateCounts() {
  if (!studySession) return;
  countsEl.textContent = `今日新词 ${studySession.learnedToday} / ${studySession.dailyNewLimit}`;
}

/* ---------- 学习会话 ---------- */

/** 把当前队列与进度写回本地，离开页面后仍能恢复 */
function syncSession() {
  if (!studySession) return;

  studySession.position = position;
  studySession.updatedAt = Date.now();

  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(studySession));
  } catch {
    // 本地存储不可用（隐私模式等）时静默降级：学习照常，只是不保留进度
  }
}

function clearSession() {
  studySession = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // 清不掉也不影响本次学习
  }
}

function loadSession(fingerprint) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }

  if (!saved || saved.version !== SESSION_VERSION) return null;
  // 换了词书或改了每日新词上限 → 旧队列作废，重新取
  if (saved.fingerprint !== fingerprint) return null;
  if (Date.now() - (saved.updatedAt || 0) > SESSION_TTL_MS) return null;
  if (!Array.isArray(saved.cards) || saved.cards.length === 0) return null;

  return saved;
}

/**
 * 影响学习队列的设置指纹：当前词书与每日新词上限。
 * 词书决定学哪些新词，上限决定一次给多少；主题、发音口音不改题目内容，不该清掉进度。
 */
function settingsFingerprint(settings) {
  return `${settings.activeBook || ''}|${settings.dailyNewLimit}`;
}

function renderCard() {
  const card = queue[position];
  if (!card) {
    renderDone();
    return;
  }

  revealed = false;
  shownAt = performance.now();
  progressEl.textContent = `${position + 1} / ${queue.length}`;

  stageEl.innerHTML = `
    <div class="card study-card">
      <div class="word-headword">${esc(card.headword)}</div>
      <div class="word-phonetic">${card.phonetic ? `/${esc(card.phonetic)}/` : ''}</div>

      <div class="center" style="margin-top:14px;">
        <button class="btn btn-sm" id="speak-btn" type="button">发音</button>
      </div>

      <div class="center" style="margin-top:28px;" id="reveal-wrap">
        <button class="btn btn-primary" id="reveal-btn" type="button">显示释义</button>
        <div class="small muted" style="margin-top:8px;">按空格键显示</div>
      </div>

      <div id="answer-area"></div>
    </div>
  `;

  document.getElementById('speak-btn').addEventListener('click', () => speak(card.headword, accent));
  document.getElementById('reveal-btn').addEventListener('click', reveal);
}

function reveal() {
  if (revealed) return;
  revealed = true;

  const card = queue[position];
  document.getElementById('reveal-wrap').remove();

  const area = document.getElementById('answer-area');
  area.innerHTML = `
    <div class="answer">
      ${
        card.icon
          ? `<div class="answer-icon" aria-hidden="true">${esc(card.icon)}</div>`
          : ''
      }
      <div class="answer-block">
        <div class="answer-label">中文释义</div>
        <div class="answer-text">${esc(card.translation) || '—'}</div>
      </div>
      ${
        card.definition
          ? `<div class="answer-block">
               <div class="answer-label">英文释义</div>
               <div class="answer-text en">${esc(card.definition)}</div>
             </div>`
          : ''
      }
      ${
        card.exchange
          ? `<div class="answer-block">
               <div class="answer-label">词形变化</div>
               <div class="answer-text en">${esc(card.exchange)}</div>
             </div>`
          : ''
      }

      <div class="row" style="margin-top:18px;">
        <button class="btn btn-sm" id="notebook-btn" type="button">加入生词本</button>
      </div>

      <div class="rating-grid" id="rating-grid"></div>
    </div>
  `;

  const grid = document.getElementById('rating-grid');
  for (const option of RATING_OPTIONS) {
    const button = document.createElement('button');
    button.className = 'rating-btn';
    button.type = 'button';
    button.dataset.rating = String(option.rating);
    button.textContent = option.label;
    button.addEventListener('click', () => submitRating(option.rating));
    grid.appendChild(button);
  }

  document.getElementById('notebook-btn').addEventListener('click', addToNotebook);
}

async function submitRating(rating) {
  if (!revealed) return;

  const card = queue[position];
  const elapsedMs = Math.round(performance.now() - shownAt);

  // 先推进到下一张，保证交互跟手；提交失败只提示，不回退
  position += 1;
  if (studySession) studySession.learnedToday += 1;
  updateCounts();
  syncSession();

  const submitted = api('/api/study/review', {
    method: 'POST',
    body: { wordId: card.wordId, rating, elapsedMs },
  }).catch((error) => toast(error.message));

  if (queue[position]) {
    renderCard();
    return;
  }

  // 最后一张必须等评分落库再渲染完成页 ——
  // 完成页的「今日已学」来自服务端统计，抢在前面渲染会少算这一张
  await submitted;
  renderDone();
}

async function addToNotebook() {
  const card = queue[position];
  if (!card) return;
  try {
    await api('/api/notebook', { method: 'POST', body: { wordId: card.wordId, action: 'add' } });
    toast('已加入生词本');
  } catch (error) {
    toast(error.message);
  }
}

function renderEmpty(counts) {
  progressEl.textContent = '已完成';
  stageEl.innerHTML = `
    <div class="card center" style="padding:48px 24px;">
      <h2>今天的新词已学完</h2>
      <p class="muted small">${
        counts.activeBook
          ? `今日已学 ${counts.learnedToday} 个 · 上限 ${counts.dailyNewLimit}`
          : '还没有选择词书，先去挑一本吧'
      }</p>
      <div class="row" style="justify-content:center;margin-top:20px;">
        <a class="btn" href="/index.html">返回首页</a>
        <a class="btn btn-primary" href="/books.html">选择词书</a>
      </div>
    </div>
  `;
}

async function renderDone() {
  progressEl.textContent = '本轮完成';
  // 这一轮队列做完了，下次进来重新取一批
  clearSession();
  try {
    // 顺手探一次检验题：今天有学过的词才提供入口
    const [stats, quiz] = await Promise.all([
      api('/api/stats/overview'),
      api('/api/quiz/daily').catch(() => ({ questions: [] })),
    ]);

    const quizCount = (quiz.questions || []).length;

    stageEl.innerHTML = `
      <div class="card center" style="padding:48px 24px;">
        <h2>本轮学习完成</h2>
        <p class="muted small">
          今日新词 ${stats.today.learnedToday} / ${studySession ? studySession.dailyNewLimit : stats.today.learnedToday} · 正确率 ${
            stats.today.accuracy === null ? '—' : stats.today.accuracy + '%'
          } · 连续打卡 ${stats.streakDays} 天
        </p>
        <div class="row" style="justify-content:center;margin-top:20px;">
          <a class="btn" href="/index.html">返回首页</a>
          <a class="btn" href="/study.html">再来一轮</a>
        </div>

        ${
          quizCount > 0
            ? `<div style="margin-top:22px;padding-top:22px;border-top:1px solid var(--border);">
                 <p class="small muted" style="margin-bottom:10px;">
                   检验一下今天学的词，看是否真的记住了
                 </p>
                 <a class="btn btn-primary" href="/quiz.html">检验今天学的词</a>
               </div>`
            : ''
        }
      </div>
    `;
  } catch (error) {
    toast(error.message);
  }
}

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;

  if (event.code === 'Space' || event.code === 'Enter') {
    if (!revealed) {
      event.preventDefault();
      reveal();
    }
    return;
  }

  const shortcut = { Digit1: 0, Digit2: 4 };
  if (revealed && shortcut[event.code] !== undefined) {
    submitRating(shortcut[event.code]);
  }
});

main().catch((error) => toast(error.message));
