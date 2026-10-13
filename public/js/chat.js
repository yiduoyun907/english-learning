import { api, requireLogin } from './api.js';
import { mountNav, readStoredTheme, toast, esc } from './ui.js';

let sceneListEl;
let conversationListEl;

async function main() {
  const session = await requireLogin();
  if (!session) return;

  document.documentElement.dataset.theme = session.settings.theme || readStoredTheme();
  mountNav('/chat.html');

  sceneListEl = document.getElementById('scene-list');
  conversationListEl = document.getElementById('conversation-list');

  const [sceneData, conversationData] = await Promise.all([
    api('/api/chat/scenes'),
    api('/api/chat/conversations'),
  ]);

  renderScenes(sceneData.scenes);
  renderConversations(conversationData.conversations);
}

function renderScenes(scenes) {
  sceneListEl.replaceChildren();
  const card = document.createElement('div');
  card.className = 'card';

  for (const scene of scenes) {
    const item = document.createElement('div');
    item.className = 'list-item selectable';
    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <strong>${esc(scene.nameZh)}</strong>
        <span class="muted small">${esc(scene.name)}</span>
        <div class="small muted">${esc(scene.hint)}</div>
      </div>
      <span class="small muted">开始</span>
    `;
    item.addEventListener('click', () => startScene(scene, item));
    card.appendChild(item);
  }

  sceneListEl.appendChild(card);
}

async function startScene(scene, element) {
  element.style.opacity = '0.5';
  try {
    const data = await api('/api/chat/conversations', {
      method: 'POST',
      body: { scene: scene.id },
    });
    location.href = `/chat-room.html?id=${data.conversation.id}`;
  } catch (error) {
    element.style.opacity = '';
    toast(error.message);
  }
}

function renderConversations(conversations) {
  conversationListEl.replaceChildren();

  if (conversations.length === 0) {
    conversationListEl.innerHTML =
      '<div class="empty">还没有会话，从上面挑一个场景开始吧</div>';
    return;
  }

  for (const conversation of conversations) {
    const item = document.createElement('div');
    item.className = 'list-item selectable';
    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <strong>${esc(conversation.sceneNameZh || conversation.sceneName)}</strong>
        <div class="small muted">${esc(conversation.lastMessage) || '（空）'}</div>
        <div class="small muted">${conversation.messageCount} 条消息 · ${esc(
          conversation.updatedAt
        )}</div>
      </div>
      <button class="btn btn-sm" data-action="delete" type="button">删除</button>
    `;

    item.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="delete"]')) return;
      location.href = `/chat-room.html?id=${conversation.id}`;
    });

    item.querySelector('[data-action="delete"]').addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm('删除这段对话？')) return;
      try {
        await api(`/api/chat/conversations/${conversation.id}`, { method: 'DELETE' });
        toast('已删除');
        const data = await api('/api/chat/conversations');
        renderConversations(data.conversations);
      } catch (error) {
        toast(error.message);
      }
    });

    conversationListEl.appendChild(item);
  }
}

main().catch((error) => toast(error.message));
