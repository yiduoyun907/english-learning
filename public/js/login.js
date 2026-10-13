import { api } from './api.js';
import { toast, readStoredTheme } from './ui.js';

document.documentElement.dataset.theme = readStoredTheme();

const tabs = {
  login: document.getElementById('tab-login'),
  register: document.getElementById('tab-register'),
};

const form = document.getElementById('auth-form');
const hint = document.getElementById('hint');
const submit = document.getElementById('submit');
const passwordInput = document.getElementById('password');

let mode = 'login';

function setMode(next) {
  mode = next;
  tabs.login.classList.toggle('btn-primary', mode === 'login');
  tabs.register.classList.toggle('btn-primary', mode === 'register');
  submit.textContent = mode === 'login' ? '登录' : '注册并登录';
  hint.textContent = mode === 'login' ? '' : '用户名 2-20 位；密码至少 6 位';
  passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}

tabs.login.addEventListener('click', () => setMode('login'));
tabs.register.addEventListener('click', () => setMode('register'));

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const username = document.getElementById('username').value.trim();
  const password = passwordInput.value;

  submit.disabled = true;
  try {
    await api(`/api/auth/${mode}`, { method: 'POST', body: { username, password } });
    location.href = '/index.html';
  } catch (error) {
    toast(error.message);
    submit.disabled = false;
  }
});

// 已登录用户直接进入首页
api('/api/auth/me')
  .then(() => {
    location.href = '/index.html';
  })
  .catch(() => {
    setMode('login');
  });
