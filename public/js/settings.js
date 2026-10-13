import { api, requireLogin } from './api.js';
import { mountNav, toast, logout } from './ui.js';

const reviewLimitEl = document.getElementById('review-limit');
const accentEl = document.getElementById('accent');
const themeEl = document.getElementById('theme');

async function main() {
  const session = await requireLogin();
  if (!session) return;

  mountNav('/settings.html');

  document.documentElement.dataset.theme = session.settings.theme || 'light';
  reviewLimitEl.value = session.settings.reviewLimit;
  accentEl.value = session.settings.accent;
  themeEl.value = session.settings.theme;

  document.getElementById('account-line').textContent = `当前账号：${session.user.username}`;

  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('change-password').addEventListener('click', changePassword);
  document.getElementById('logout').addEventListener('click', logout);

  // 主题下拉即时预览
  themeEl.addEventListener('change', () => {
    document.documentElement.dataset.theme = themeEl.value;
  });
}

async function saveSettings() {
  const button = document.getElementById('save-settings');
  button.disabled = true;

  try {
    const settings = await api('/api/settings', {
      method: 'PUT',
      body: {
        // dailyNewLimit 不在这里改 —— 已移到首页的「每日学习单词」板块
        reviewLimit: Number(reviewLimitEl.value),
        accent: accentEl.value,
        theme: themeEl.value,
      },
    });

    localStorage.setItem('el_theme', settings.theme);
    document.documentElement.dataset.theme = settings.theme;
    toast('设置已保存');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function changePassword() {
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;

  if (!currentPassword || !newPassword) {
    toast('请填写当前密码与新密码');
    return;
  }

  const button = document.getElementById('change-password');
  button.disabled = true;

  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    toast('密码已修改，请重新登录');
    setTimeout(() => {
      location.href = '/login.html';
    }, 1200);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

main().catch((error) => toast(error.message));
