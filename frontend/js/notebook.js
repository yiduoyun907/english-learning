import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, esc, speak } from './ui.js';

let accent = 'us';
let listEl;
let countEl;
let searchTimer = null;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  accent = session.settings.accent || 'us';
  mountNav('/notebook.html');

  listEl = document.getElementById('notebook-list');
  countEl = document.getElementById('notebook-count');

  document.getElementById('search-input').addEventListener('input', onSearchInput);

  await refreshNotebook();
}

async function refreshNotebook() {
  const data = await api('/api/notebook?pageSize=100');
  countEl.textContent = `共 ${data.total} 个`;

  if (data.words.length === 0) {
    listEl.innerHTML = '<div class="empty">生词本还是空的<br><span class="small">学习时点击「加入生词本」，或在上方检索后添加</span></div>';
    return;
  }

  listEl.replaceChildren();
  for (const word of data.words) {
    listEl.appendChild(buildNotebookRow(word));
  }
}

function buildNotebookRow(word) {
  const row = document.createElement('div');
  row.className = 'list-item';
  row.innerHTML = `
    <div style="flex:1;min-width:0;">
      <div class="row" style="gap:8px;">
        <strong>${esc(word.headword)}</strong>
        <span class="muted small">${word.phonetic ? `/${esc(word.phonetic)}/` : ''}</span>
      </div>
      <div class="small muted" style="white-space:pre-wrap;">${esc(word.translation) || '—'}</div>
    </div>
    <div class="row" style="gap:6px;">
      <button class="btn btn-sm" data-action="speak" type="button">发音</button>
      <button class="btn btn-sm" data-action="remove" type="button">移除</button>
    </div>
  `;

  row.querySelector('[data-action="speak"]').addEventListener('click', () =>
    speak(word.headword, accent)
  );
  row.querySelector('[data-action="remove"]').addEventListener('click', () => removeWord(word));

  return row;
}

function onSearchInput(event) {
  clearTimeout(searchTimer);
  const keyword = event.target.value.trim();
  const results = document.getElementById('search-results');

  if (!keyword) {
    results.replaceChildren();
    return;
  }

  // 输入停顿 300ms 再查询，避免频繁请求
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/words/search?q=${encodeURIComponent(keyword)}&limit=15`);
      renderSearchResults(data.words);
    } catch (error) {
      toast(error.message);
    }
  }, 300);
}

function renderSearchResults(words) {
  const results = document.getElementById('search-results');

  if (words.length === 0) {
    results.innerHTML = '<p class="small muted">没有找到匹配的单词</p>';
    return;
  }

  results.replaceChildren();
  for (const word of words) {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <strong>${esc(word.headword)}</strong>
        <span class="muted small">${word.phonetic ? `/${esc(word.phonetic)}/` : ''}</span>
        <div class="small muted" style="white-space:pre-wrap;">${esc(word.translation) || '—'}</div>
      </div>
      <button class="btn btn-sm" type="button">加入</button>
    `;

    row.querySelector('button').addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        await api('/api/notebook', { method: 'POST', body: { wordId: word.id, action: 'add' } });
        toast('已加入生词本');
        await refreshNotebook();
      } catch (error) {
        toast(error.message);
        event.target.disabled = false;
      }
    });

    results.appendChild(row);
  }
}

async function removeWord(word) {
  try {
    await api('/api/notebook', { method: 'POST', body: { wordId: word.id, action: 'remove' } });
    toast('已移出生词本');
    await refreshNotebook();
  } catch (error) {
    toast(error.message);
  }
}

main().catch((error) => toast(error.message));
