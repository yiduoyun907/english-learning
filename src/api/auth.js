import {
  registerUser,
  authenticateUser,
  createSession,
  destroySession,
  changePassword,
  buildSessionCookie,
  buildLogoutCookie,
} from '../auth.js';
import { readJsonBody, sendOk } from '../http.js';
import { requireUser, getSettings } from '../context.js';

/** 账号相关接口：注册 / 登录 / 登出 / 当前用户 */
export function registerAuthRoutes(router, { db }) {
  router.post('/api/auth/register', async (req, res) => {
    const body = await readJsonBody(req);
    const user = registerUser(db, toText(body.username), toText(body.password));

    const token = createSession(db, user.id);
    res.setHeader('Set-Cookie', buildSessionCookie(token));
    sendOk(res, { user, settings: getSettings(db, user.id) });
  });

  router.post('/api/auth/login', async (req, res) => {
    const body = await readJsonBody(req);
    const user = authenticateUser(db, toText(body.username), toText(body.password));

    const token = createSession(db, user.id);
    res.setHeader('Set-Cookie', buildSessionCookie(token));
    sendOk(res, { user, settings: getSettings(db, user.id) });
  });

  router.post('/api/auth/logout', async (req, res, ctx) => {
    destroySession(db, ctx.sessionToken);
    res.setHeader('Set-Cookie', buildLogoutCookie());
    sendOk(res, null);
  });

  router.get('/api/auth/me', async (req, res, ctx) => {
    requireUser(ctx);
    sendOk(res, { user: ctx.user, settings: getSettings(db, ctx.user.id) });
  });

  router.post('/api/auth/password', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const body = await readJsonBody(req);

    changePassword(db, user, toText(body.currentPassword), toText(body.newPassword));
    sendOk(res, null);
  });
}

function toText(value) {
  return typeof value === 'string' ? value : '';
}
