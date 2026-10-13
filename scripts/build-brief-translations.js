/**
 * 生成精简释义 translation_brief。
 *
 * 原释义来自 ECDICT，是一条词性一段的完整罗列，例如 point：
 *   n. 点, 小数点, 标点, 地点, 要点, 特点, 尖端, 分数, 得分, 穴位
 *   vt. 弄尖, 强调, 指出, 加标点于, 瞄准
 *   vi. 指, 指向, 表明
 * 卡片上全量展示会抓不住重点，这里每段只保留前 2 个含义。
 *
 * 同时丢掉领域标记段落（[经] / [计] / [医] 等）—— 它们通常是专业用法，
 * 而且内容常与通用释义重复（government 的 [经] 段就是「政府, 政治, 政体」）。
 *
 * 注意：本脚本只做「截断 + 去噪」，不判断哪个词性最常用 ——
 * ECDICT 按词性排序而非按频率，所以 might 的 aux. 仍会排在三 n. 之后。
 * 词性排序要靠 LLM 那一层解决，这里不越权。
 *
 * 用法：node scripts/build-brief-translations.js [--dry-run]
 */
import { DatabaseSync } from 'node:sqlite';

import { config } from '../src/config.js';

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_SENSES = 2;

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA busy_timeout = 5000');

const columns = new Set(db.prepare('PRAGMA table_info(words)').all().map((row) => row.name));
if (!columns.has('translation_brief')) {
  db.exec('ALTER TABLE words ADD COLUMN translation_brief TEXT');
  console.log('已新增列 words.translation_brief');
}

/** 领域标记段落，整段丢弃 */
const FIELD_MARKER = /^\[[^\]]*\]/;
/** 词性前缀，如 "n."、"vt."、"a./ad." */
const POS_PREFIX = /^([a-z]{1,6}(?:\.[a-z]{1,6})*\.)\s*/i;

function briefTranslation(raw) {
  const paragraphs = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const general = [];
  const field = [];

  for (const paragraph of paragraphs) {
    const isField = FIELD_MARKER.test(paragraph);
    const text = isField ? paragraph.replace(FIELD_MARKER, '').trim() : paragraph;

    const matched = text.match(POS_PREFIX);
    const pos = matched ? matched[1] : '';
    const body = matched ? text.slice(matched[0].length) : text;

    const senses = body
      .split(/[,;，；]/)
      .map((sense) => sense.trim())
      .filter(Boolean)
      .slice(0, MAX_SENSES);

    if (senses.length === 0) continue;
    const entry = pos ? `${pos} ${senses.join(', ')}` : senses.join(', ');
    (isField ? field : general).push(entry);
  }

  // 极少数词只带了领域释义（accelerating 的 [计] 加速、aquifer 的 [化] 含水层），
  // 这时退回用它们 —— 总比精简完什么都不剩强
  const picked = general.length > 0 ? general : field;
  return [...new Set(picked)].join('\n');
}

const rows = db.prepare('SELECT id, headword, translation_zh AS raw FROM words').all();
const update = db.prepare('UPDATE words SET translation_brief = ? WHERE id = ?');

db.exec('BEGIN');

let changed = 0;
let shortened = 0;
let emptied = 0;
let beforeTotal = 0;
let afterTotal = 0;

for (const row of rows) {
  const brief = briefTranslation(row.raw);
  beforeTotal += (row.raw || '').length;
  afterTotal += brief.length;

  if (!brief) {
    emptied += 1;
    if (emptied <= 5) console.log(`  ⚠ 精简后为空：${row.headword} ← ${JSON.stringify(row.raw)}`);
  }
  if (brief !== (row.raw || '').trim()) changed += 1;
  if (brief.length < (row.raw || '').length * 0.8) shortened += 1;

  if (!DRY_RUN) update.run(brief, row.id);
}

if (DRY_RUN) {
  db.exec('ROLLBACK');
} else {
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

console.log('');
console.log(`处理 ${rows.length} 个词`);
console.log(`  释义有变化   ${changed}`);
console.log(`  明显缩短     ${shortened}`);
console.log(`  精简后为空   ${emptied}`);
console.log(`  平均长度     ${(beforeTotal / rows.length).toFixed(0)} → ${(afterTotal / rows.length).toFixed(0)} 字符`);
console.log(DRY_RUN ? '\n（dry-run，未写入）' : '\n（已写入，请执行 npm run export — 词表随种子库分发）');

db.close();
