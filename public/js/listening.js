import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, esc } from './ui.js';

const LEVEL_LABELS = { beginner: '初级', intermediate: '中级', advanced: '高级' };

let listEl;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  mountNav('/listening.html');

  listEl = document.getElementById('material-list');

  if (!('speechSynthesis' in window)) {
    listEl.innerHTML =
      '<div class="card"><p class="muted small" style="margin:0;">当前浏览器不支持语音合成，听力练习需要 Chrome、Edge 或 Safari。</p></div>';
    return;
  }

  const data = await api('/api/listening/materials');
  render(data.materials);
}

function render(materials) {
  listEl.replaceChildren();

  const cet = materials.filter((item) => item.source.startsWith('cet'));
  const voa = materials.filter((item) => item.source === 'voa');
  const original = materials.filter((item) => item.source === 'original');

  if (voa.length > 0) {
    appendSection(
      'VOA 慢速英语',
      '美国之音为学习者编写 · 美国政府作品，公有领域',
      voa,
      (item) => item.topic || '综合'
    );
  }

  if (cet.length > 0) {
    appendSection(
      '四六级听力真题',
      '历年真题听力原文 · 著作权归考试主办方，仅供个人学习使用',
      cet,
      (item) => `${item.source.startsWith('cet6') ? '六级' : '四级'} · ${item.topic || '真题'}`
    );
  }

  if (original.length > 0) {
    appendSection(
      '本站原创短文',
      '读过之后可以到「阅读」模块精读同一篇',
      original,
      (item) => LEVEL_LABELS[item.level] || item.level
    );
  }
}

/** 一个来源分区：标题 + 卡片，卡片内按 groupKey 分小节 */
function appendSection(title, hint, items, groupKey) {
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
      sub.textContent = group.key;
      card.appendChild(sub);
    }
    group.items.forEach((item) => card.appendChild(buildRow(item)));
  });

  listEl.appendChild(card);
}

function buildRow(material) {
  const practiced = material.attemptCount > 0;
  const accuracyText = practiced ? `${Math.round(material.avgAccuracy * 100)}%` : '未练习';
  const target = `/listen.html?slug=${encodeURIComponent(material.slug)}`;

  const subtitle = material.titleZh
    ? `${esc(material.titleZh)} · ${material.sentenceCount} 句`
    : `${material.sentenceCount} 句`;

  const attribution = material.attribution
    ? `<a class="small muted" href="${esc(material.sourceUrl || '#')}" target="_blank" rel="noopener noreferrer">${esc(
        material.attribution
      )}</a>`
    : '';

  const row = document.createElement('div');
  row.className = 'list-item selectable';
  row.innerHTML = `
    <div style="flex:1;min-width:0;">
      <strong>${esc(material.title)}</strong>
      <div class="small muted">${subtitle}${practiced ? ` · 练过 ${material.attemptCount} 次` : ''}</div>
      ${attribution}
    </div>
    <span class="small ${practiced ? 'badge' : 'muted'}">${accuracyText}</span>
  `;

  row.addEventListener('click', (event) => {
    // 来源链接自己处理跳转，不触发进入练习
    if (event.target.closest('a')) return;
    location.href = target;
  });

  return row;
}

main().catch((error) => toast(error.message));
