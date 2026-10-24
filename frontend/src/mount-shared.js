import { createApp, h, ref } from 'vue';

import AppNav from './components/AppNav.vue';
import ToastHost from './components/ToastHost.vue';

/**
 * 多页架构下的共享 UI 挂载点：导航与 Toast 都是 Vue 组件，
 * 但页面本身仍由各自的 HTML/原生模块驱动。
 *
 * 容器使用 display: contents，让导航继续作为 body 的直接布局子节点，
 * 否则 .nav 的 position: sticky 会被外层容器限制而失效。
 */
let mounted = false;
let activeNav = null;

export function ensureSharedUi() {
  if (mounted) return;
  mounted = true;
  activeNav = ref('');

  const host = document.createElement('div');
  host.dataset.sharedUi = '';
  host.style.display = 'contents';
  document.body.prepend(host);

  createApp({
    render() {
      return [
        activeNav.value ? h(AppNav, { active: activeNav.value }) : null,
        h(ToastHost),
      ];
    },
  }).mount(host);
}

/** 注入顶部导航，active 为当前所属模块路径 */
export function mountNav(active) {
  ensureSharedUi();
  activeNav.value = active;
}
