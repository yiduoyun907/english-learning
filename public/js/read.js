import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, speak, esc } from './ui.js';

const LEVEL_LABELS = { beginner: '初级', intermediate: '中级', advanced: '高级' };

const slug = new URLSearchParams(location.search).get('slug');

let accent = 'us';
let articleText = '';
let activeWord = null;

let sheetEl;
let lookupCount = 0;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  accent = session.settings.accent || 'us';
  mountNav('/reading.html');

  if (!slug) {
    location.href = '/reading.html';
    return;
  }

  sheetEl = document.getElementById('sheet');
  bindSheet();

  const data = await api(`/api/passages/${encodeURIComponent(slug)}`);
  render(data);
}

function render(data) {
  const passage = data.passage;
  articleText = passage.content;
  lookupCount = data.progress.lookupCount || 0;

  document.getElementById('title').textContent = passage.title;
  // 外文素材没有中文标题，过滤掉空值免得显示成字面量 null
  document.getElementById('meta').textContent = [
    passage.titleZh,
    LEVEL_LABELS[passage.level] || passage.level,
    `${passage.wordCount} 词`,
  ]
    .filter(Boolean)
    .join(' · ');
  updateLookupStat();

  const container = document.getElementById('passage');
  container.innerHTML = renderContent(passage.content);
  container.addEventListener('click', onContentClick);

  document.getElementById('speak-all').addEventListener('click', () => speak(articleText, accent));

  const completeButton = document.getElementById('complete');
  if (data.progress.status === 'completed') {
    completeButton.textContent = '已读完';
    completeButton.disabled = true;
  }
  completeButton.addEventListener('click', markCompleted);
}

/**
 * 把正文按词切分成可点击的 span。
 * 标点与空格保留在 span 外，因此复制出来的文本仍是原文。
 * 段内的换行是诗行（散文在抓取阶段已把折行接回一段），用 <br> 保留住。
 */
function renderContent(content) {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => {
      const html = paragraph
        .trim()
        .split('\n')
        .map((line) => markWords(line.trim()))
        .join('<br />');
      return `<p class="passage-p">${html}</p>`;
    })
    .join('');
}

function markWords(paragraph) {
  return paragraph
    .split(/(\s+)/)
    .map((token) => {
      if (!token || /^\s+$/.test(token)) return token;

      const match = token.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'-]*)([^A-Za-z]*)$/);
      if (!match) return esc(token);

      const [, leading, word, trailing] = match;
      return `${esc(leading)}<span class="w" data-word="${esc(word)}">${esc(word)}</span>${esc(trailing)}`;
    })
    .join('');
}

function onContentClick(event) {
  const target = event.target.closest('.w');
  if (!target) return;
  openSheet(target.dataset.word);
}

async function openSheet(rawWord) {
  sheetEl.hidden = false;
  document.getElementById('sheet-word').textContent = rawWord;
  document.getElementById('sheet-phonetic').textContent = '';
  document.getElementById('sheet-body').innerHTML = '<p class="muted small">查询中…</p>';

  const notebookButton = document.getElementById('sheet-notebook');
  notebookButton.disabled = true;
  notebookButton.textContent = '加入生词本';
  activeWord = null;

  try {
    const data = await api(`/api/words/lookup?word=${encodeURIComponent(rawWord)}`);
    recordLookup();

    if (!data.word) {
      document.getElementById('sheet-body').innerHTML =
        `<p class="muted small">词库未收录「${esc(data.query)}」。可以到生词本页用词典检索试试。</p>`;
      return;
    }

    activeWord = data.word;
    document.getElementById('sheet-word').textContent = data.word.headword;
    document.getElementById('sheet-phonetic').textContent = data.word.phonetic
      ? `/${data.word.phonetic}/`
      : '';

    // 两种情况互斥：查的是变形（返回了原形），或该词本身是词条但另有原形
    const restoredFrom = data.query !== data.word.headword
      ? `<p class="small muted">原形：<strong>${esc(data.word.headword)}</strong></p>`
      : '';
    const alsoAForm = data.baseForm
      ? `<p class="small muted">该词也是 <a href="#" data-base="${esc(data.baseForm.headword)}">${esc(
          data.baseForm.headword
        )}</a> 的变形形式，点击查看原形</p>`
      : '';

    document.getElementById('sheet-body').innerHTML = `
      ${restoredFrom}
      ${alsoAForm}
      <div class="answer-block">
        <div class="answer-label">中文释义</div>
        <div class="answer-text">${esc(data.word.translation) || '—'}</div>
      </div>
      ${
        data.word.definition
          ? `<div class="answer-block">
               <div class="answer-label">英文释义</div>
               <div class="answer-text en">${esc(data.word.definition)}</div>
             </div>`
          : ''
      }
    `;

    notebookButton.disabled = data.inNotebook;
    notebookButton.textContent = data.inNotebook ? '已在生词本' : '加入生词本';
  } catch (error) {
    document.getElementById('sheet-body').innerHTML =
      `<p class="muted small">${esc(error.message)}</p>`;
  }
}

function closeSheet() {
  sheetEl.hidden = true;
  activeWord = null;
}

function bindSheet() {
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  sheetEl.querySelector('[data-close]').addEventListener('click', closeSheet);

  // 点击「该词也是 xxx 的变形形式」时切换到原形释义
  document.getElementById('sheet-body').addEventListener('click', (event) => {
    const link = event.target.closest('[data-base]');
    if (!link) return;
    event.preventDefault();
    openSheet(link.dataset.base);
  });

  document.getElementById('sheet-speak').addEventListener('click', () => {
    if (activeWord) speak(activeWord.headword, accent);
  });

  document.getElementById('sheet-notebook').addEventListener('click', async () => {
    if (!activeWord) return;
    const button = document.getElementById('sheet-notebook');
    button.disabled = true;
    try {
      await api('/api/notebook', {
        method: 'POST',
        body: { wordId: activeWord.id, action: 'add' },
      });
      button.textContent = '已在生词本';
      toast('已加入生词本');
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheetEl.hidden) closeSheet();
  });
}

function recordLookup() {
  lookupCount += 1;
  updateLookupStat();
  api(`/api/passages/${encodeURIComponent(slug)}/lookup`, { method: 'POST' }).catch(() => {});
}

function updateLookupStat() {
  document.getElementById('lookup-stat').textContent =
    lookupCount > 0 ? `本文已查 ${lookupCount} 个词` : '点击正文中的单词可查看释义';
}

async function markCompleted() {
  const button = document.getElementById('complete');
  button.disabled = true;
  try {
    await api(`/api/passages/${encodeURIComponent(slug)}/progress`, {
      method: 'POST',
      body: { status: 'completed' },
    });
    button.textContent = '已读完';
    toast('已标记为读完');
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

main().catch((error) => toast(error.message));
