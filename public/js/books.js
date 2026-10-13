import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, esc } from './ui.js';

let listEl;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  mountNav('/books.html');

  listEl = document.getElementById('book-list');
  await refresh();
}

async function refresh() {
  const data = await api('/api/wordbooks');
  render(data);
}

function render(data) {
  listEl.replaceChildren();

  for (const book of data.books) {
    const isActive = book.code === data.activeBook;
    const percent = book.wordCount > 0 ? Math.round((book.learnedCount / book.wordCount) * 100) : 0;

    const item = document.createElement('div');
    item.className = 'list-item selectable';
    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div class="row" style="gap:8px;">
          <strong>${esc(book.name)}</strong>
          ${isActive ? '<span class="badge">当前使用</span>' : ''}
        </div>
        <div class="small muted">${esc(book.description)}</div>
        <div class="progress-bar"><span style="width:${percent}%"></span></div>
        <div class="small muted" style="margin-top:4px;">已学 ${book.learnedCount} / ${book.wordCount}</div>
      </div>
      <span class="small muted">${percent}%</span>
    `;

    if (!isActive) {
      item.addEventListener('click', () => selectBook(book));
    }

    listEl.appendChild(item);
  }
}

async function selectBook(book) {
  try {
    await api(`/api/wordbooks/${book.code}/select`, { method: 'POST' });
    toast(`已切换到《${book.name}》`);
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

main().catch((error) => toast(error.message));
