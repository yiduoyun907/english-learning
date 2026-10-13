import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { httpError } from './http.js';
import { localStamp } from './time.js';

export const SESSION_COOKIE = 'el_session';

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const USERNAME_PATTERN = /^[a-zA-Z0-9_一-龥]{2,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 72;

/** 注册新用户：校验 → 建账号 → 初始化默认设置 */
export function registerUser(db, username, password) {
  validateCredentials(username, password);

  const taken = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (taken) {
    throw httpError(409, 'USERNAME_TAKEN', '该用户名已被注册');
  }

  const salt = randomBytes(SALT_BYTES).toString('hex');
  const passwordHash = deriveHash(password, salt);

  const insertResult = db
    .prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, salt, localStamp());

  const userId = Number(insertResult.lastInsertRowid);
  db.prepare('INSERT INTO settings (user_id, daily_new_limit) VALUES (?, ?)').run(
    userId,
    config.defaultDailyNewLimit
  );

  return { id: userId, username };
}

/** 校验用户名与密码，成功返回用户标识 */
export function authenticateUser(db, username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw httpError(400, 'INVALID_CREDENTIALS', '用户名或密码错误');
  }

  const user = db
    .prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?')
    .get(username);

  // 用户不存在时也走一次哈希运算，避免通过响应耗时区分账号是否存在
  const salt = user ? user.salt : randomBytes(SALT_BYTES).toString('hex');
  const expected = Buffer.from(user ? user.password_hash : '', 'hex');
  const actual = scryptSync(password, salt, KEY_LENGTH);
  const matched = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!user || !matched) {
    throw httpError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
  }

  return { id: user.id, username: user.username };
}

/**
 * 修改密码：先校验当前密码，成功后更新哈希并失效该用户的全部会话。
 */
export function changePassword(db, user, currentPassword, newPassword) {
  authenticateUser(db, user.username, currentPassword);

  if (
    typeof newPassword !== 'string' ||
    newPassword.length < MIN_PASSWORD_LENGTH ||
    newPassword.length > MAX_PASSWORD_LENGTH
  ) {
    throw httpError(400, 'INVALID_PASSWORD', `新密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`);
  }

  const salt = randomBytes(SALT_BYTES).toString('hex');
  const passwordHash = deriveHash(newPassword, salt);

  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(
    passwordHash,
    salt,
    user.id
  );
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
}

/** 登录成功后下发 session，返回 token */
export function createSession(db, userId) {
  const token = `${randomUUID()}${randomBytes(16).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlMs).toISOString();

  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    expiresAt,
    now.toISOString()
  );

  return token;
}

/** 由 token 解析出当前用户；无效或过期返回 null（过期会顺手清理） */
export function resolveSession(db, token) {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT s.expires_at AS expires_at, u.id AS id, u.username AS username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);

  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return { id: row.id, username: row.username };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 清理所有已过期 session（服务启动时调用一次即可） */
export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

export function buildSessionCookie(token) {
  return serializeCookie(token, Math.floor(config.sessionTtlMs / 1000));
}

export function buildLogoutCookie() {
  return serializeCookie('', 0);
}

function serializeCookie(value, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.isProduction) parts.push('Secure');
  return parts.join('; ');
}

function deriveHash(password, salt) {
  return scryptSync(password, salt, KEY_LENGTH).toString('hex');
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw httpError(400, 'INVALID_USERNAME', '用户名需为 2-20 位字母、数字、下划线或中文');
  }
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw httpError(400, 'INVALID_PASSWORD', `密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`);
  }
}
