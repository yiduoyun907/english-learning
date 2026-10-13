/**
 * 范围不变量测试：学习队列 / 今日校验 / 复习队列 三者的取词范围关系。
 *
 * 这个项目在「范围」上踩过几次坑，根因都是同一个语义没在每处生效 ——
 * user_words 表既装「学过」(reps > 0)，也装「只收藏」(reps = 0)。
 * 一旦某处查询漏了判据，就会考出用户从没学过的词。
 *
 * 测试跑在数据库副本上（见 harness.mjs），不碰开发库。
 * 用法：node tests/invariants.mjs
 */
import { startTestServer, createClient } from './harness.mjs';

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** 集合差：a 里有、b 里没有的 */
const minus = (a, b) => [...a].filter((x) => !b.has(x));

const server = await startTestServer({ port: 3199 });
const api = createClient(server.base);

try {
  // ── 1. 注册并选词书 ──
  const username = 'inv' + Math.floor(Math.random() * 100000);
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'passw0rd' }),
  });
  const userId = reg.body.data.user.id;
  await api('/api/wordbooks/cet4/select', { method: 'POST', body: '{}' });

  // ── 2. 学 10 个词（走完整队列 + 评分）──
  const queue = await api('/api/study/queue?limit=20');
  const learned = queue.body.data.cards.slice(0, 10);
  for (const card of learned) {
    await api('/api/study/review', {
      method: 'POST',
      body: JSON.stringify({ wordId: card.wordId, rating: 4, elapsedMs: 900 }),
    });
  }
  const allLearnedIds = learned.map((c) => c.wordId);

  const db = server.db();
  db.exec('PRAGMA busy_timeout = 5000');

  // 前 5 个留在今天（A 组），后 5 个挪到昨天（B 组）
  const groupA = allLearnedIds.slice(0, 5);
  const groupB = allLearnedIds.slice(5, 10);
  for (const wordId of groupB) {
    db.prepare(
      `UPDATE user_words SET created_at = datetime('now','localtime','-1 day')
        WHERE user_id = ? AND word_id = ?`
    ).run(userId, wordId);
  }

  // B 组里挑 3 个同时加进生词本 → D 组（学过 + 已收藏）
  const groupD = groupB.slice(0, 3);
  for (const wordId of groupD) {
    await api('/api/notebook', {
      method: 'POST',
      body: JSON.stringify({ wordId, action: 'add' }),
    });
  }
  const groupBOnly = groupB.slice(3);

  // 再挑若干从没学过的词，只收藏 → C 组
  const groupC = [];
  for (const keyword of ['apple', 'banana', 'orange', 'grape', 'lemon', 'peach', 'melon']) {
    if (groupC.length >= 5) break;
    const found = await api(`/api/words/search?q=${keyword}&limit=1`);
    const word = found.body.data.words?.[0];
    if (!word || allLearnedIds.includes(word.id)) continue;
    await api('/api/notebook', {
      method: 'POST',
      body: JSON.stringify({ wordId: word.id, action: 'add' }),
    });
    groupC.push(word.id);
  }

  // C 组拆两半：一半把收藏时间挪到昨天，用来检验「复习」的判据；
  // 另一半留在今天，用来检验「今日校验」的判据。
  // 两类都要覆盖 —— 只放今天的话，去掉复习那处的 reps > 0 也抓不出来。
  const groupCYesterday = groupC.slice(0, 3);
  const groupCToday = groupC.slice(3);
  for (const wordId of groupCYesterday) {
    db.prepare(
      `UPDATE user_words SET created_at = datetime('now','localtime','-1 day')
        WHERE user_id = ? AND word_id = ?`
    ).run(userId, wordId);
  }

  const setA = new Set(groupA);
  const setD = new Set(groupD);
  const setB = new Set([...groupBOnly, ...groupD]); // B ∪ D：今天之前学过的全部
  const setC = new Set(groupC);

  console.log(`\n数据构造（账号 ${username}, id=${userId}）：`);
  console.log(`  A 今天学过      ${groupA.length} 个`);
  console.log(`  B 昨天学过      ${groupB.length} 个（其中 ${groupD.length} 个同时进了生词本）`);
  console.log(
    `  C 只收藏未学    ${groupC.length} 个（${groupCYesterday.length} 个收藏于昨天，${groupCToday.length} 个收藏于今天）`
  );
  console.log('');

  // ── 3. 断言 ──
  console.log('取词范围不变量：');

  const daily = await api('/api/quiz/daily');
  const dailyIds = (daily.body.data.questions || []).map((q) => q.wordId);

  await api('/api/quiz/result', {
    method: 'POST',
    body: JSON.stringify({ scope: 'daily', total: 1, correct: 1 }),
  });

  const review = await api('/api/quiz/review', {
    method: 'POST',
    body: JSON.stringify({ exclude: [] }),
  });
  const reviewIds = (review.body.data.questions || []).map((q) => q.wordId);

  const status = await api('/api/quiz/review/status');
  const queueAgain = await api('/api/study/queue?limit=20');
  const newIds = (queueAgain.body.data.cards || []).filter((c) => c.kind === 'new').map((c) => c.wordId);

  // 不变量 1：今日校验只考今天学的
  const dailyOutside = minus(dailyIds, setA);
  check(
    `今日校验 ⊆ 今天学过的（${dailyIds.length} 题）`,
    dailyOutside.length === 0,
    dailyOutside.length ? `越界 wordId: ${dailyOutside.join(', ')}` : ''
  );

  // 不变量 2：复习只考今天之前学过的
  const reviewOutside = minus(reviewIds, setB);
  check(
    `复习队列 ⊆ 今天之前学过的（${reviewIds.length} 题）`,
    reviewOutside.length === 0,
    reviewOutside.length ? `越界 wordId: ${reviewOutside.join(', ')}` : ''
  );

  // 不变量 3：两者不重叠
  const overlap = dailyIds.filter((id) => reviewIds.includes(id));
  check('今日校验 ∩ 复习队列 = ∅', overlap.length === 0, overlap.length ? `重复: ${overlap.join(', ')}` : '');

  // 不变量 4：绝不考只收藏、没学过的词
  const fromNotebookOnly = [...dailyIds, ...reviewIds].filter((id) => setC.has(id));
  check(
    '任何题目都不来自「只收藏未学」的词',
    fromNotebookOnly.length === 0,
    fromNotebookOnly.length ? `混入: ${fromNotebookOnly.join(', ')}` : ''
  );

  // 不变量 5：状态接口报的可复习池 = 实际候选
  const withTranslation = db
    .prepare(
      `SELECT COUNT(*) AS n FROM user_words uw
         JOIN words w ON w.id = uw.word_id
        WHERE uw.user_id = ? AND uw.created_at < date('now','localtime') || ' 00:00:00'
          AND uw.reps > 0 AND length(w.translation_zh) > 0`
    )
    .get(userId).n;
  check(
    `复习池大小 ${status.body.data.poolSize} = 实际候选 ${withTranslation}`,
    status.body.data.poolSize === withTranslation,
    status.body.data.poolSize !== withTranslation
      ? `接口报 ${status.body.data.poolSize}，库里实际 ${withTranslation}`
      : ''
  );

  // 不变量 6：学习队列的新词不含已学过的
  const learnedSet = new Set(allLearnedIds);
  const dupInNew = newIds.filter((id) => learnedSet.has(id));
  check(
    `学习队列的新词不含已学过的（${newIds.length} 个新词）`,
    dupInNew.length === 0,
    dupInNew.length ? `重复: ${dupInNew.join(', ')}` : ''
  );

  // ── 4. 边界：created_at 恰好是今天 0 点 ──
  console.log('\n边界用例：');
  const boundaryWord = groupB[groupB.length - 1];
  db.prepare(
    `UPDATE user_words SET created_at = date('now','localtime') || ' 00:00:00'
      WHERE user_id = ? AND word_id = ?`
  ).run(userId, boundaryWord);

  const dailyAfter = await api('/api/quiz/daily');
  const dailyAfterIds = (dailyAfter.body.data.questions || []).map((q) => q.wordId);
  check(
    'created_at = 今天 00:00:00 的词归入「今天」（今天校验能考到）',
    dailyAfterIds.includes(boundaryWord),
    `wordId ${boundaryWord} 不在今日校验里`
  );

  // ── 5. 生词本语义 ──
  console.log('\n生词本与学习队列的联动：');
  const collectOnly = groupC[0];

  await api('/api/notebook', {
    method: 'POST',
    body: JSON.stringify({ wordId: collectOnly, action: 'remove' }),
  });
  const record = db
    .prepare('SELECT reps FROM user_words WHERE user_id = ? AND word_id = ?')
    .get(userId, collectOnly);

  check(
    '从未学过的词移出生词本后记录被删除（不会变成「学过」）',
    record === undefined,
    record ? `记录仍在，reps=${record.reps}` : ''
  );

  // 只收藏、没学过的词不该计入「累计已学」
  const stats = await api('/api/stats/overview');
  const reported = stats.body.data.totals.learned;
  check(
    `「累计已学」只算真正学过的（应为 ${allLearnedIds.length}，实际 ${reported}）`,
    reported === allLearnedIds.length,
    reported !== allLearnedIds.length
      ? `收藏了 ${groupC.length} 个未学词，被多算了 ${reported - allLearnedIds.length}`
      : ''
  );

  db.close();
} catch (error) {
  console.error('\n测试执行出错：', error);
  failures.push('脚本异常中止');
} finally {
  await server.stop();

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  · ${name}`);
  }
  process.exit(failures.length > 0 ? 1 : 0);
}
