/**
 * 素材质量扫描：对 passages 表逐篇做结构与排版断言。
 *
 * 抓取来的长文本，排版比清洗更容易出错，而且不会报错 —— 只会在读者眼前
 * 变成一堵墙或丢掉诗的换行。这里把「什么样算合格」固化成可重复跑的检查。
 *
 * 只读数据库，不修改任何数据。用法：node tests/content-quality.mjs
 */
import { DatabaseSync } from 'node:sqlite';

import { config } from '../src/config.js';

const db = new DatabaseSync(config.dbPath, { readOnly: true });

/** 抓取源残留的噪音 */
const NOISE = /^(produced by|transcribed from|e-?text prepared|this ebook|title page|frontispiece|\[illustration|\[picture)/im;
/** 正文里不该出现的标记 */
const STRAY_MARK = /\*\*\*\s*(START|END) OF/;
const VALID_LEVELS = new Set(['beginner', 'intermediate', 'advanced']);

/**
 * 各来源的合理篇幅区间（词数）。
 * 超出不一定是错，但值得人工看一眼，所以按「提示」而非「失败」处理。
 */
const WORD_RANGE = {
  fiction: [800, 5000],
  poem: [200, 9000],
  essay: [150, 3000],
};

const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

/** 只有阅读类素材才要求分段；听力原文本就是一段连续文本 */
const READING_GENRES = new Set(['fiction', 'poem', 'essay']);

const rows = db
  .prepare(
    `SELECT slug, title, level, genre, source, content, word_count AS wordCount
       FROM passages ORDER BY source, id`
  )
  .all();
db.close();

const failures = [];
const warnings = [];

const fail = (slug, message) => failures.push(`${slug} — ${message}`);
const warn = (slug, message) => warnings.push(`${slug} — ${message}`);

for (const row of rows) {
  const { slug, title, level, genre, source, content, wordCount } = row;

  // 1. 存储的词数与正文实算是否一致
  const actual = countWords(content);
  if (wordCount > 0 && Math.abs(actual - wordCount) / wordCount > 0.05) {
    fail(slug, `word_count 记为 ${wordCount}，实测 ${actual}`);
  }

  // 2. 抓取源的噪音是否清理干净
  if (NOISE.test(content)) {
    fail(slug, '正文残留抓取源噪音（署名/版本说明/插图标记）');
  }
  if (STRAY_MARK.test(content)) {
    fail(slug, '正文残留 *** START/END *** 标记');
  }

  // 3. 标题是否干净（只抓明显的「点线 + 页码」，尾部单个数字多是题号，不算问题）
  if (/[.\s]{3,}\d+\s*$/.test(title)) {
    fail(slug, `标题疑似带页码或点线：「${title}」`);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(title)) {
    warn(slug, `标题带日期前缀：「${title}」`);
  }

  // 4. 段落结构（阅读类才要求，听力原文本就是连续文本）
  const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  if (READING_GENRES.has(genre) && paragraphs.length <= 1 && actual > 300) {
    fail(slug, `整篇只有 1 段（${actual} 词），段落分隔可能丢了`);
  }
  if (genre === 'poem' && !content.includes('\n')) {
    fail(slug, '诗歌没有任何换行，诗句分行可能被合并了');
  }

  // 5. 结尾是否完整（防抓取截断）
  const tail = content.trim().slice(-1);
  if (!/[.!?"'”’)\]」』…—]/.test(tail)) {
    warn(slug, `结尾是「${tail}」，可能被截断`);
  }

  // 6. 难度标注
  if (!VALID_LEVELS.has(level)) {
    fail(slug, `level 取值非法：${level}`);
  }

  // 7. 篇幅
  const range = WORD_RANGE[genre];
  if (range && (actual < range[0] || actual > range[1])) {
    warn(slug, `${genre} 篇幅 ${actual} 词，超出参考区间 ${range[0]}–${range[1]}`);
  }
}

console.log(`扫描 ${rows.length} 篇素材…\n`);

if (failures.length === 0) {
  console.log('✓ 结构检查全部通过');
} else {
  console.log(`✗ ${failures.length} 项不合格：`);
  for (const item of failures) console.log(`  · ${item}`);
}

if (warnings.length > 0) {
  console.log(`\n提示（需人工看一眼，不一定是错，共 ${warnings.length} 项）：`);
  for (const item of warnings.slice(0, 20)) console.log(`  · ${item}`);
  if (warnings.length > 20) console.log(`  … 另有 ${warnings.length - 20} 项`);
}

process.exit(failures.length > 0 ? 1 : 0);
