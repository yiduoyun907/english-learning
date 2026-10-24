<script setup>
import { onMounted, ref } from 'vue';

import { showToast } from '../composables/useToast.js';
import { api } from '../lib/api.js';

const scenes = ref([]);
const conversations = ref([]);
const startingSceneId = ref(null);

onMounted(async () => {
  try {
    const [sceneData, conversationData] = await Promise.all([
      api('/api/chat/scenes'),
      api('/api/chat/conversations'),
    ]);

    scenes.value = sceneData.scenes;
    conversations.value = conversationData.conversations;
  } catch (error) {
    showToast(error.message);
  }
});

async function startScene(scene) {
  startingSceneId.value = scene.id;

  try {
    const data = await api('/api/chat/conversations', {
      method: 'POST',
      body: { scene: scene.id },
    });
    location.href = `/chat-room.html?id=${data.conversation.id}`;
  } catch (error) {
    startingSceneId.value = null;
    showToast(error.message);
  }
}

function openConversation(conversation) {
  location.href = `/chat-room.html?id=${conversation.id}`;
}

async function removeConversation(conversation) {
  if (!confirm('删除这段对话？')) return;

  try {
    await api(`/api/chat/conversations/${conversation.id}`, { method: 'DELETE' });
    showToast('已删除');
    const data = await api('/api/chat/conversations');
    conversations.value = data.conversations;
  } catch (error) {
    showToast(error.message);
  }
}
</script>

<template>
  <main class="container">
    <h1>AI 对话</h1>
    <p class="muted small">
      选一个场景开始对话。对方会用英文回应，并在每轮之后指出你句子里的错误。
    </p>

    <div class="group-heading" style="margin-top:24px;">
      <strong>选择场景</strong>
    </div>
    <div id="scene-list">
      <div class="card">
        <div
          v-for="scene in scenes"
          :key="scene.id"
          class="list-item selectable"
          :style="{ opacity: startingSceneId === scene.id ? '0.5' : '' }"
          @click="startScene(scene)"
        >
          <div style="flex:1;min-width:0;">
            <strong>{{ scene.nameZh }}</strong>
            <span class="muted small">{{ scene.name }}</span>
            <div class="small muted">{{ scene.hint }}</div>
          </div>
          <span class="small muted">开始</span>
        </div>
      </div>
    </div>

    <div class="group-heading" style="margin-top:28px;">
      <strong>我的会话</strong>
      <span class="muted small">继续之前没聊完的</span>
    </div>
    <div class="card" id="conversation-list">
      <div v-if="conversations.length === 0" class="empty">还没有会话，从上面挑一个场景开始吧</div>

      <div
        v-for="conversation in conversations"
        :key="conversation.id"
        class="list-item selectable"
        @click="openConversation(conversation)"
      >
        <div style="flex:1;min-width:0;">
          <strong>{{ conversation.sceneNameZh || conversation.sceneName }}</strong>
          <div class="small muted">{{ conversation.lastMessage || '（空）' }}</div>
          <div class="small muted">
            {{ conversation.messageCount }} 条消息 · {{ conversation.updatedAt }}
          </div>
        </div>
        <button
          class="btn btn-sm"
          data-action="delete"
          type="button"
          @click.stop="removeConversation(conversation)"
        >
          删除
        </button>
      </div>
    </div>
  </main>
</template>
