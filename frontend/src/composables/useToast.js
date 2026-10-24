import { reactive } from 'vue';

/** 全局唯一的轻提示状态，由 ToastHost 渲染 */
export const toastState = reactive({
  message: '',
  visible: false,
});

let hideTimer = null;

export function showToast(message, durationMs = 2000) {
  toastState.message = message;
  toastState.visible = true;

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    toastState.visible = false;
  }, durationMs);
}

export function hideToast() {
  clearTimeout(hideTimer);
  toastState.visible = false;
}
