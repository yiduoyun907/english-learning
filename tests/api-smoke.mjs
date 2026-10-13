/**
 * 接口回归：认证、输入校验、越权、正常流。
 *
 * 用法：node tests/api-smoke.mjs
 */
import { startTestServer, createClient, registerUser } from './harness.mjs';

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
  }
}

const server = await startTestServer({ port: 3198 });

try {
  // ── 认证 ──
  console.log('认证：');
  const anon = createClient(server.base);
  const protectedPaths = [
    '/api/wordbooks',
    '/api/study/queue',
    '/api/quiz/daily',
    '/api/quiz/review/status',
    '/api/stats/overview',
    '/api/notebook',
    '/api/passages',
    '/api/settings',
  ];
  for (const path of protectedPaths) {
    const res = await anon(path);
    check(`未登录访问 ${path} → 401`, res.status === 401, `实际 ${res.status}`);
  }

  const { call, username } = await registerUser(server.base);

  const dup = await createClient(server.base)('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'passw0rd' }),
  });
  check('重复注册同名账号被拒 → 409', dup.status === 409, `实际 ${dup.status}`);

  const badLogin = await createClient(server.base)('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'wrong-password' }),
  });
  check('密码错误被拒', badLogin.status === 401, `实际 ${badLogin.status}`);

  // ── 输入校验 ──
  console.log('\n输入校验：');
  const invalidBodies = [
    ['scope 传非法值', '/api/quiz/result', { scope: 'bogus', total: 1, correct: 1 }],
    ['题量为 0', '/api/quiz/result', { scope: 'daily', total: 0, correct: 0 }],
    ['得分大于题量', '/api/quiz/result', { scope: 'daily', total: 3, correct: 5 }],
    ['题量超出上限', '/api/quiz/result', { scope: 'daily', total: 99999, correct: 1 }],
    ['每日新词上限越界', '/api/settings', { dailyNewLimit: 9999 }],
    ['复习上限越界', '/api/settings', { reviewLimit: 1 }],
  ];

  for (const [label, path, body] of invalidBodies) {
    const method = path === '/api/settings' ? 'PUT' : 'POST';
    const res = await call(path, { method, body: JSON.stringify(body) });
    check(`${label} → 400`, res.status === 400, `实际 ${res.status}`);
  }

  const queue = await call('/api/study/queue?limit=5');
  const firstCard = queue.body.data.cards[0];

  if (firstCard) {
    const badRating = await call('/api/study/review', {
      method: 'POST',
      body: JSON.stringify({ wordId: firstCard.wordId, rating: 99 }),
    });
    check('评分传非法值 → 400', badRating.status === 400, `实际 ${badRating.status}`);

    const badWordId = await call('/api/study/review', {
      method: 'POST',
      body: JSON.stringify({ wordId: -1, rating: 4 }),
    });
    check('wordId 非法 → 400', badWordId.status === 400, `实际 ${badWordId.status}`);
  }

  const badNotebook = await call('/api/notebook', {
    method: 'POST',
    body: JSON.stringify({ wordId: -1, action: 'add' }),
  });
  check('生词本 wordId 非法 → 400', badNotebook.status === 400, `实际 ${badNotebook.status}`);

  const missingWord = await call('/api/notebook', {
    method: 'POST',
    body: JSON.stringify({ wordId: 99999999, action: 'add' }),
  });
  check('生词本指向不存在的词 → 404', missingWord.status === 404, `实际 ${missingWord.status}`);

  const badSlug = await call('/api/passages/not-a-real-slug');
  check('不存在的文章 → 404', badSlug.status === 404, `实际 ${badSlug.status}`);

  // ── 越权 ──
  console.log('\n越权隔离：');
  const other = await registerUser(server.base);
  const list = await call('/api/passages');
  const slug = list.body.data.passages[0].slug;

  await call(`/api/passages/${slug}/progress`, {
    method: 'POST',
    body: JSON.stringify({ status: 'completed' }),
  });

  const mine = await call(`/api/passages/${slug}`);
  const theirs = await other.call(`/api/passages/${slug}`);
  check(
    '阅读进度不串号（A 读完，B 仍是未读）',
    mine.body.data.progress.status === 'completed' && theirs.body.data.progress.status === 'unread',
    `A=${mine.body.data.progress.status}, B=${theirs.body.data.progress.status}`
  );

  await call('/api/notebook', {
    method: 'POST',
    body: JSON.stringify({ wordId: (await call('/api/words/search?q=apple&limit=1')).body.data.words[0].id, action: 'add' }),
  });
  const myNotebook = await call('/api/notebook');
  const theirNotebook = await other.call('/api/notebook');
  check(
    '生词本不串号（A 收藏，B 看不见）',
    myNotebook.body.data.total > 0 && theirNotebook.body.data.total === 0,
    `A=${myNotebook.body.data.total}, B=${theirNotebook.body.data.total}`
  );

  // ── 正常流 ──
  console.log('\n正常流：');
  const stats = await call('/api/stats/overview');
  check('统计接口返回结构完整',
    stats.status === 200 && stats.body.data.today && stats.body.data.totals,
    `实际 ${stats.status}`);

  const books = await call('/api/wordbooks');
  check('词书列表非空', books.status === 200 && books.body.data.books.length >= 7,
    `实际 ${books.body.data.books?.length} 本`);

  const passages = await call('/api/passages');
  const genres = {};
  for (const p of passages.body.data.passages) genres[p.genre || 'other'] = (genres[p.genre || 'other'] || 0) + 1;
  check('阅读素材含四个分区', ['fiction', 'poem', 'essay'].every((g) => genres[g] > 0),
    JSON.stringify(genres));

  const listening = await call('/api/listening/materials');
  check('听力材料接口可用', listening.status === 200, `实际 ${listening.status}`);
} catch (error) {
  console.error('\n执行出错：', error);
  failures.push('脚本异常中止');
} finally {
  await server.stop();
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  · ${name}`);
}
process.exit(failures.length > 0 ? 1 : 0);
