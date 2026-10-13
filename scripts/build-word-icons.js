/**
 * 给单词配一个 emoji 图标，用于单词卡片的辅助理解。
 *
 * 为什么用 emoji 而不是图片：试过的图库路线要么网络不通（Wikimedia、
 * Openverse），要么需要 API Key 且检索质量不可控。emoji 零网络、零版权、
 * 零存储，对「可具象化」的词（apple / run / fire）足够直观；模型还会主动
 * 给抽象词（however / might）留空，不需要额外写判定规则。
 *
 * 可重复执行：已有 icon 的词会跳过，中断后接着跑即可。
 *
 * 用法：
 *   node --use-system-ca scripts/build-word-icons.js --limit=50
 *   node --use-system-ca scripts/build-word-icons.js            # 全量
 * 必须加 --use-system-ca：本机有中间人代理证书，Node 默认 TLS 校验会失败。
 */
import { DatabaseSync } from 'node:sqlite';

import { config } from '../src/config.js';

const BATCH_SIZE = 20;

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : null;

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA busy_timeout = 5000');

const columns = new Set(db.prepare('PRAGMA table_info(words)').all().map((row) => row.name));
if (!columns.has('icon')) {
  db.exec('ALTER TABLE words ADD COLUMN icon TEXT');
  console.log('已新增列 words.icon');
}

if (!config.llm.baseUrl || !config.llm.authToken) {
  console.error('未配置 AI 凭证（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN），无法生成图标');
  process.exit(1);
}

/**
 * 待处理的词：只取属于某本词书的词，随机排序。
 *
 * 为什么不按词频排序：词频最高的一批恰恰是语义最宽泛的词（make / have / go /
 * say），它们配不出贴切的 emoji，硬配就是 the👉 这种干扰项；而 apple / fire /
 * dog 这类真正可具象化的词，词频并不靠前。「高频」与「可配图」是两个正交的维度。
 * 随机抽样让候选覆盖各种词性，也避免每次都从同一批词开始。
 *
 * 另外限定在词书内：words 表里还装着 the / of / in 这类功能词，本就不该出现在
 * 学习卡片上。
 */
const pending = db
  .prepare(
    `SELECT w.id, w.headword, w.translation_brief, w.translation_zh
       FROM words w
       JOIN wordbook_words wbw ON wbw.word_id = w.id
      WHERE w.icon IS NULL AND length(w.translation_zh) > 0
      GROUP BY w.id
      ORDER BY RANDOM()
      LIMIT ?`
  )
  .all(LIMIT ?? 999999);

console.log(`待配图标 ${pending.length} 个词，模型 ${config.llm.model}\n`);

const update = db.prepare('UPDATE words SET icon = ? WHERE id = ?');

async function generateBatch(batch) {
  const list = batch
    .map((row) => `${row.headword} — ${(row.translation_brief || row.translation_zh).replace(/\n/g, ' / ')}`)
    .join('\n');

  const res = await fetch(`${config.llm.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.llm.authToken}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      system:
        '你给英语单词配一个 emoji，用于单词卡片的辅助理解。' +
        '只输出 JSON 数组，每项形如 {"word":"apple","emoji":"🍎"}，顺序与输入一致，不要漏词。\n' +
        '判断标准：只有当 emoji 能让人**直接联想到**该词的具体含义时才配（apple→🍎、run→🏃、fire→🔥）。\n' +
        '以下一律留空：虚词（the/of/be/make）、抽象词（however/might/issue）、' +
        '以及语义宽泛的词（have/go/one/time）—— 它们只能配上牵强的图标，反而干扰记忆。\n' +
        '宁缺勿滥：拿不准就留空。不要输出解释或代码块标记。',
      messages: [{ role: 'user', content: list }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const text = (data.content || []).map((block) => block.text || '').join('');
  const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());

  const byWord = new Map(parsed.map((item) => [String(item.word).toLowerCase(), item.emoji || '']));
  return byWord;
}

let assigned = 0;
let blank = 0;
let failed = 0;

for (let start = 0; start < pending.length; start += BATCH_SIZE) {
  const batch = pending.slice(start, start + BATCH_SIZE);
  const label = `[${start + 1}-${Math.min(start + BATCH_SIZE, pending.length)}/${pending.length}]`;

  let byWord;
  try {
    byWord = await generateBatch(batch);
  } catch (error) {
    failed += batch.length;
    console.error(`${label} 失败：${error.message}`);
    continue;
  }

  for (const row of batch) {
    const emoji = byWord.get(row.headword.toLowerCase());
    if (emoji === undefined) {
      failed += 1;
      continue;
    }
    // 空字符串也要写进去 —— 表示「这个词模型判断没有贴切的图标」，
    // 否则下次跑还会再问一遍
    update.run(emoji, row.id);
    if (emoji) assigned += 1;
    else blank += 1;
  }

  const preview = batch
    .map((row) => {
      const emoji = byWord.get(row.headword.toLowerCase());
      return emoji ? `${row.headword}${emoji}` : null;
    })
    .filter(Boolean)
    .slice(0, 8)
    .join(' ');

  console.log(`${label} 命中 ${preview || '(本批无)'}`);
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

const remaining = db.prepare('SELECT COUNT(*) AS n FROM words WHERE icon IS NULL').get().n;
db.close();

console.log('');
console.log(`配上图标 ${assigned} 个，判定无贴切图标 ${blank} 个，处理失败 ${failed} 个`);
console.log(`剩余未处理 ${remaining} 个`);
console.log('（词表随种子库分发，重新部署前记得跑 npm run build:seed）');
