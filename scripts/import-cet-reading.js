/**
 * 把 parse-cet-pdf.py 解析出的阅读文章写入数据库。
 *
 * ⚠️ 四六级真题著作权归考试主办方所有，此处仅作个人学习使用。
 *
 * 用法：
 *   uv run --with pypdf python scripts/parse-cet-pdf.py <pdf目录> <json>
 *   node scripts/import-cet-reading.js <json>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { openDatabase } from '../src/db.js';
import { config } from '../src/config.js';
import { localStamp } from '../src/time.js';

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('用法：node scripts/import-cet-reading.js <json文件>');
  process.exit(1);
}

let items;
try {
  items = JSON.parse(readFileSync(resolve(process.cwd(), jsonPath), 'utf8'));
} catch (error) {
  console.error(`读取失败：${error.message}`);
  process.exit(1);
}

if (!Array.isArray(items) || items.length === 0) {
  console.error('JSON 中没有文章数据');
  process.exit(1);
}

const db = openDatabase(config.dbPath);

const upsert = db.prepare(
  `INSERT INTO passages
     (slug, title, title_zh, level, topic, content, word_count, source, attribution, source_url, created_at)
   VALUES (?, ?, NULL, 'intermediate', ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(slug) DO UPDATE SET
     title       = excluded.title,
     topic       = excluded.topic,
     content     = excluded.content,
     word_count  = excluded.word_count,
     attribution = excluded.attribution,
     source_url  = excluded.source_url`
);

const countWords = (text) => text.split(/\s+/).filter(Boolean).length;
const now = localStamp();
let saved = 0;

for (const item of items) {
  const levelName = item.level === '6' ? '六级' : '四级';
  const heading = item.heading ? ` · ${item.heading}` : '';
  const title = `${item.examKey} ${levelName}${item.setName || ''} 阅读${heading}`;
  const slug = `cet${item.level}-reading-${item.examKey}-${(item.setName || 'x').replace(/第|套/g, '')}-${saved}`;

  upsert.run(
    slug,
    title,
    '四六级阅读真题',
    item.content,
    countWords(item.content),
    `cet${item.level}-reading`,
    `真题（cet4-download 整理）· ${item.examKey}`,
    null,
    now
  );
  saved += 1;
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const summary = db
  .prepare("SELECT source, COUNT(*) AS n FROM passages WHERE source LIKE 'cet%reading' GROUP BY source")
  .all();
db.close();

console.log(`写入阅读文章 ${saved} 篇。`);
summary.forEach((row) => console.log(`  ${row.source}: ${row.n} 篇`));
console.log('版权提示：四六级真题著作权归考试主办方，请仅作个人学习使用。');
