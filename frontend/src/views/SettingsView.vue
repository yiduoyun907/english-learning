<script setup>
import { ref } from 'vue';

import { showToast } from '../composables/useToast.js';
import { api } from '../lib/api.js';
import { THEME_STORAGE_KEY } from '../lib/theme.js';
import { getSession, logoutUser, updateSettings } from '../stores/session.js';

const session = getSession();

const reviewLimit = ref(session.settings.reviewLimit);
const accent = ref(session.settings.accent);
const theme = ref(session.settings.theme);
const currentPassword = ref('');
const newPassword = ref('');
const saving = ref(false);
const changingPassword = ref(false);

function previewTheme() {
  document.documentElement.dataset.theme = theme.value;
}

async function saveSettings() {
  saving.value = true;

  try {
    const settings = await api('/api/settings', {
      method: 'PUT',
      body: {
        // dailyNewLimit 不在这里改 —— 已移到首页的「每日学习单词」板块
        reviewLimit: Number(reviewLimit.value),
        accent: accent.value,
        theme: theme.value,
      },
    });

    localStorage.setItem(THEME_STORAGE_KEY, settings.theme);
    document.documentElement.dataset.theme = settings.theme;
    updateSettings(settings);
    showToast('设置已保存');
  } catch (error) {
    showToast(error.message);
  } finally {
    saving.value = false;
  }
}

async function changePassword() {
  if (!currentPassword.value || !newPassword.value) {
    showToast('请填写当前密码与新密码');
    return;
  }

  changingPassword.value = true;

  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      },
    });
    showToast('密码已修改，请重新登录');
    setTimeout(() => {
      location.href = '/login.html';
    }, 1200);
  } catch (error) {
    showToast(error.message);
    changingPassword.value = false;
  }
}
</script>

<template>
  <main class="container">
    <h1>设置</h1>

    <div class="card" style="margin-top:20px;">
      <h2>学习偏好</h2>

      <p class="small muted" style="margin-top:0;">
        每日学习量已移到<strong>首页</strong>的「每日学习单词」，在那里直接改。
      </p>

      <label class="field">
        <span class="field-label">复习队列上限（10-500）</span>
        <input
          class="input"
          id="review-limit"
          v-model="reviewLimit"
          type="number"
          min="10"
          max="500"
          step="10"
        >
        <span class="small muted">
          每次复习最多考多少个词。已学词少于这个数时全部复习；
          超出时按学习时间加权抽取，越早学的出现得越少。
        </span>
      </label>

      <label class="field">
        <span class="field-label">发音口音</span>
        <select class="input" id="accent" v-model="accent">
          <option value="us">美式</option>
          <option value="uk">英式</option>
        </select>
      </label>

      <label class="field">
        <span class="field-label">主题</span>
        <select class="input" id="theme" v-model="theme" @change="previewTheme">
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>

      <button class="btn btn-primary" id="save-settings" type="button" :disabled="saving" @click="saveSettings">
        保存
      </button>
    </div>

    <div class="card">
      <h2>修改密码</h2>

      <label class="field">
        <span class="field-label">当前密码</span>
        <input
          class="input"
          id="current-password"
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
        >
      </label>

      <label class="field">
        <span class="field-label">新密码（至少 6 位）</span>
        <input
          class="input"
          id="new-password"
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
        >
      </label>

      <button
        class="btn"
        id="change-password"
        type="button"
        :disabled="changingPassword"
        @click="changePassword"
      >
        修改密码
      </button>
      <p class="small muted" style="margin-bottom:0;">修改后需重新登录</p>
    </div>

    <div class="card">
      <h2>账号</h2>
      <p class="muted small" id="account-line">当前账号：{{ session.user.username }}</p>
      <button class="btn" id="logout" type="button" @click="logoutUser">退出登录</button>
    </div>
  </main>
</template>
