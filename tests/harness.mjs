/**
 * 测试脚手架：在独立副本上起一个服务实例，供各测试脚本复用。
 *
 * 为什么不直接打开发库：测试要构造数据（改 created_at、插记录），
 * 打在开发库上会污染正在使用的账号。这里用 VACUUM INTO 复制一份，
 * 起独立端口的服务连副本，跑完即删。
 */
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from '../src/config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 复制一份数据库，起服务，返回 { base, dbPath, db(), stop() } */
export async function startTestServer({ port = 3199 } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'el-test-'));
  const dbPath = join(workDir, 'test.db');

  const source = new DatabaseSync(config.dbPath, { readOnly: true });
  source.exec(`VACUUM INTO '${dbPath.replace(/\\/g, '/')}'`);
  source.close();

  const server = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: String(port),
      SEED_DB_PATH: '', // 副本已存在，不触发种子初始化
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  server.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const base = `http://127.0.0.1:${port}`;

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // 还没起来
    }
    await sleep(250);
  }

  if (!ready) {
    server.kill();
    throw new Error(`测试服务未能启动：\n${output}`);
  }

  return {
    base,
    dbPath,
    /** 打开副本库连接（测试里用来直接构造数据、断言不变量） */
    db: () => new DatabaseSync(dbPath),
    async stop() {
      server.kill();
      await sleep(300);
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // 清不掉就交给系统回收
      }
    },
  };
}

/** 带 cookie 的接口客户端 */
export function createClient(base) {
  let cookie = '';

  async function call(path, options = {}) {
    const res = await fetch(base + path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(options.headers || {}),
      },
    });

    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length > 0) cookie = setCookie.map((item) => item.split(';')[0]).join('; ');

    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }

  call.reset = () => {
    cookie = '';
  };

  return call;
}

/** 注册一个账号并可选地选好词书，返回 { username, userId, call } */
export async function registerUser(base, { book = 'cet4' } = {}) {
  const call = createClient(base);
  const username = 't' + Math.floor(Math.random() * 1e9);
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'passw0rd' }),
  });
  if (book) await call(`/api/wordbooks/${book}/select`, { method: 'POST', body: '{}' });
  return { username, userId: reg.body.data.user.id, call };
}

export { sleep };
