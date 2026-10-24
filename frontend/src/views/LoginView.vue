<script setup>
import { computed, onMounted, ref } from 'vue';

import { showToast } from '../composables/useToast.js';
import { api } from '../lib/api.js';

const mode = ref('login');
const username = ref('');
const password = ref('');
const submitting = ref(false);

const hint = computed(() => (mode.value === 'login' ? '' : '用户名 2-20 位；密码至少 6 位'));
const submitLabel = computed(() => (mode.value === 'login' ? '登录' : '注册并登录'));
const passwordAutocomplete = computed(() =>
  mode.value === 'login' ? 'current-password' : 'new-password'
);

onMounted(() => {
  // 已登录用户直接进入首页
  api('/api/auth/me')
    .then(() => {
      location.href = '/index.html';
    })
    .catch(() => {
      // 未登录是正常情况，停留在表单
    });
});

function setMode(next) {
  mode.value = next;
}

async function submit() {
  submitting.value = true;

  try {
    await api(`/api/auth/${mode.value}`, {
      method: 'POST',
      body: { username: username.value.trim(), password: password.value },
    });
    location.href = '/index.html';
  } catch (error) {
    showToast(error.message);
    submitting.value = false;
  }
}
</script>

<template>
  <main class="container-narrow">
    <h1 class="center">英语学习</h1>
    <p class="center muted small" style="margin-top:-6px;margin-bottom:28px;">
      单词 · 听力 · 阅读 · AI 对话
    </p>

    <div class="card">
      <div class="row" style="margin-bottom:20px;">
        <button
          class="btn btn-sm"
          :class="{ 'btn-primary': mode === 'login' }"
          id="tab-login"
          type="button"
          @click="setMode('login')"
        >
          登录
        </button>
        <button
          class="btn btn-sm"
          :class="{ 'btn-primary': mode === 'register' }"
          id="tab-register"
          type="button"
          @click="setMode('register')"
        >
          注册
        </button>
      </div>

      <form id="auth-form" @submit.prevent="submit">
        <label class="field">
          <span class="field-label">用户名</span>
          <input class="input" id="username" v-model="username" autocomplete="username" required>
        </label>

        <label class="field">
          <span class="field-label">密码</span>
          <input
            class="input"
            id="password"
            v-model="password"
            type="password"
            :autocomplete="passwordAutocomplete"
            required
          >
        </label>

        <p class="small muted" id="hint" style="min-height:20px;margin-top:-4px;">{{ hint }}</p>

        <button class="btn btn-primary btn-block" id="submit" type="submit" :disabled="submitting">
          {{ submitLabel }}
        </button>
      </form>
    </div>
  </main>
</template>
