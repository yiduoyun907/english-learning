/**
 * 浏览器原生语音合成。零成本、无需后端；浏览器不支持时静默失败，
 * 不打断学习流程。
 */
export function speak(text, accent = 'us') {
  if (!('speechSynthesis' in window)) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = accent === 'uk' ? 'en-GB' : 'en-US';
  utterance.rate = 0.9;

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

/** 停止当前朗读，页面卸载或切换句子时调用 */
export function stopSpeaking() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}
