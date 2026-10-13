import http from 'node:http';
import { Buffer } from 'node:buffer';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './src/config.js';
import { openDatabase } from './src/db.js';
import { createRouter } from './src/router.js';
import { serveStatic } from './src/static.js';
import { sendError, sendOk, parseCookies } from './src/http.js';
import { resolveSession, purgeExpiredSessions, SESSION_COOKIE } from './src/auth.js';

import { registerAuthRoutes } from './src/api/auth.js';
import { registerWordbookRoutes } from './src/api/wordbooks.js';
import { registerStudyRoutes } from './src/api/study.js';
import { registerWordRoutes } from './src/api/words.js';
import { registerPassageRoutes } from './src/api/passages.js';
import { registerListeningRoutes } from './src/api/listening.js';
import { registerChatRoutes } from './src/api/chat.js';
import { registerTutorRoutes } from './src/api/tutor.js';
import { registerQuizRoutes } from './src/api/quiz.js';
import { registerStatsRoutes } from './src/api/stats.js';
import { registerSettingsRoutes } from './src/api/settings.js';

// 容器首次启动：挂载卷为空时，从镜像内置的种子数据库初始化词库
if (config.seedDbPath && !existsSync(config.dbPath) && existsSync(config.seedDbPath)) {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  copyFileSync(config.seedDbPath, config.dbPath);
  console.log(`已从种子数据库初始化：${config.seedDbPath} → ${config.dbPath}`);
}

const db = openDatabase(config.dbPath, { seedDbPath: config.seedDbPath });
purgeExpiredSessions(db);

const router = createRouter();
const deps = { db };

registerAuthRoutes(router, deps);
registerWordbookRoutes(router, deps);
registerStudyRoutes(router, deps);
registerWordRoutes(router, deps);
registerPassageRoutes(router, deps);
registerListeningRoutes(router, deps);
registerChatRoutes(router, deps);
registerTutorRoutes(router, deps);
registerQuizRoutes(router, deps);
registerStatsRoutes(router, deps);
registerSettingsRoutes(router, deps);

router.get('/api/health', async (req, res) => {
  const words = db.prepare('SELECT COUNT(*) AS n FROM words').get().n;
  sendOk(res, { status: 'ok', words, uptimeSeconds: Math.round(process.uptime()) });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 站内含四六级真题等受版权保护的材料，禁止搜索引擎收录，避免公开传播
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  // 同时对爬虫声明整站不抓取
  if (pathname === '/robots.txt') {
    const body = 'User-agent: *\nDisallow: /\n';
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (pathname.startsWith('/api/')) {
    const hit = router.match(req.method, pathname);
    if (!hit) {
      sendError(res, 404, 'NOT_FOUND', '接口不存在');
      return;
    }

    const sessionToken = parseCookies(req)[SESSION_COOKIE];

    try {
      const user = resolveSession(db, sessionToken);
      await hit.handler(req, res, {
        params: hit.params,
        query: url.searchParams,
        user,
        sessionToken,
      });
    } catch (error) {
      respondWithError(res, error);
    }
    return;
  }

  // 浏览器默认会请求站点图标，无图标时直接返回空响应，避免控制台出现 404
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (await serveStatic(req, res, pathname, config.publicDir)) return;
  } catch (error) {
    console.error('静态资源服务失败：', error);
  }

  sendError(res, 404, 'NOT_FOUND', '页面不存在');
});

function respondWithError(res, error) {
  // 响应已开始发送时无法再改状态码，直接结束以免悬挂
  if (res.headersSent) {
    res.end();
    return;
  }

  const status = Number(error?.status) || 500;

  // 标了 expose 的是主动抛出的、可预期的失败（如上游接口不可用），
  // 应按声明的状态码如实返回；其余 5xx 视为未预期，统一兜底，避免暴露内部细节
  if (status >= 500 && !error?.expose) {
    console.error('未预期的服务器错误：', error);
    sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
    return;
  }

  sendError(res, status, error.code || 'REQUEST_FAILED', error.message || '请求失败');
}

server.listen(config.port, () => {
  console.log(`英语学习平台已启动：http://localhost:${config.port}`);
  console.log(`数据库：${config.dbPath}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
