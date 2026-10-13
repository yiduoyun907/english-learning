import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, esc } from './ui.js';

const LEVEL_LABELS = { beginner: '初级', intermediate: '中级', advanced: '高级' };
const LEVEL_HINTS = {
  beginner: '短句为主，用词简单',
  intermediate: '完整段落，句式多样',
  advanced: '长句与论证，适合精读',
};

let listEl;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  mountNav('/reading.html');

  listEl = document.getElementById('passage-list');

  const data = await api('/api/passages');
  render(data.passages);
}

function render(passages) {
  listEl.replaceChildren();
  if (passages.length === 0) {
    listEl.innerHTML = '<div class="empty">暂无文章</div>';
    return;
  }

  const own = passages.filter((item) => item.source === 'original');
  const fiction = passages.filter((item) => item.genre === 'fiction');
  const poems = passages.filter((item) => item.genre === 'poem');
  const essays = passages.filter((item) => item.genre === 'essay');
  const cet = passages.filter((item) => item.source.startsWith('cet'));

  if (own.length > 0) {
    appendSection('本站原创短文', '读完可以到「听力」模块做同一篇的听写', own, (item) => item.level, LEVEL_LABELS, LEVEL_HINTS);
  }
  if (fiction.length > 0) {
    appendSection(
      '短篇小说',
      '公版名著 · 点正文里任意单词即可查释义',
      fiction,
      (item) => item.level,
      LEVEL_LABELS,
      LEVEL_HINTS
    );
  }
  if (poems.length > 0) {
    appendSection(
      '诗歌',
      '公版诗集 · 篇幅短，适合反复读',
      poems,
      (item) => item.level,
      LEVEL_LABELS,
      LEVEL_HINTS
    );
  }
  if (essays.length > 0) {
    appendSection(
      '社会与文化',
      'VOA 慢速英语 · 非虚构短文',
      essays,
      (item) => item.level,
      LEVEL_LABELS,
      LEVEL_HINTS
    );
  }
  if (cet.length > 0) {
    appendSection(
      '四六级阅读真题',
      '历年真题文章 · 著作权归考试主办方，仅供个人学习使用',
      cet,
      (item) => item.source.replace('cet', '').replace('-reading', '') + '级',
      null,
      null
    );
  }
}

/** 一个来源分区，内部按 groupKey 分小节 */
function appendSection(title, hint, items, groupKey, labels, hints) {
  const heading = document.createElement('div');
  heading.className = 'group-heading';
  heading.innerHTML = `<strong>${esc(title)}</strong><span class="muted small">${esc(hint)}</span>`;
  listEl.appendChild(heading);

  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '20px';

  const groups = [];
  for (const item of items) {
    const key = groupKey(item);
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      group = { key, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }

  groups.forEach((group, index) => {
    if (groups.length > 1) {
      const sub = document.createElement('div');
      sub.className = 'small muted';
      sub.style.cssText = `padding:12px 0 4px;${index > 0 ? 'border-top:1px solid var(--border);margin-top:6px;' : ''}`;
      sub.textContent = (labels && labels[group.key]) || group.key;
      card.appendChild(sub);
    }
    group.items.forEach((item) => card.appendChild(buildRow(item)));
  });

  listEl.appendChild(card);
}

function buildRow(passage) {
  const statusText = {
    completed: '已读完',
    reading: '读了一部分',
    unread: '',
  }[passage.status];

  const row = document.createElement('div');
  row.className = 'list-item selectable';
  row.innerHTML = `
    <div style="flex:1;min-width:0;">
      <div class="row" style="gap:8px;">
        <strong>${esc(passage.title)}</strong>
        ${statusText ? `<span class="badge">${statusText}</span>` : ''}
      </div>
      <div class="small muted">${[passage.titleZh, `${passage.wordCount} 词`, passage.topic]
        .filter(Boolean)
        .map(esc)
        .join(' · ')}</div>
    </div>
    <span class="small muted">阅读</span>
  `;

  row.addEventListener('click', () => {
    location.href = `/read.html?slug=${encodeURIComponent(passage.slug)}`;
  });

  return row;
}

main().catch((error) => toast(error.message));
