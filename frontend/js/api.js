/** 页面统一从这里取接口客户端与登录态，具体实现位于 frontend/src */

export { api } from '../src/lib/api.js';
export { requireLogin } from '../src/stores/session.js';
