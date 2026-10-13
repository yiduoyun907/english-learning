/**
 * 把抓取到的外部听力材料导出为项目内的数据文件。
 *
 * 为什么需要这一步：VOA 材料是抓取后写入数据库的，而线上容器的数据库是从卷里读的，
 * 不会自动获得新抓取的内容。把结果固化成 src/content/voa-passages.json 后，
 * 材料随代码一起分发，部署时由启动流程写入数据库 —— 线上不再依赖抓取。
 *
 * 用法：先 npm run import:voa 抓取，再 node scripts/export-passages.js
 */
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { config } from '../src/config.js';

// 用裸连接而非 openDatabase：后者会执行 seedPassages，
// 拿上一次导出的旧 JSON 反过来覆盖刚抓进库的新内容 —— 导出结果就成了旧的。
const db = new DatabaseSync(config.dbPath);

const rows = db
  .prepare(
    `SELECT slug, title, topic, content, level, genre, source, attribution, source_url
       FROM passages
      WHERE source <> 'original'
      ORDER BY id`
  )
  .all();

db.close();

if (rows.length === 0) {
  console.error('库中没有外部素材，请先运行 npm run import:voa / import:cet');
  process.exit(1);
}

const payload = rows.map((row) => ({
  slug: row.slug,
  title: row.title,
  topic: row.topic,
  content: row.content,
  level: row.level,
  genre: row.genre,
  source: row.source,
  attribution: row.attribution,
  sourceUrl: row.source_url,
}));

const target = new URL('../src/content/external-passages.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

const totalWords = rows.reduce((sum, row) => sum + row.content.split(/\s+/).length, 0);
const bySource = {};
for (const row of rows) bySource[row.source] = (bySource[row.source] || 0) + 1;

console.log(`已导出 ${payload.length} 篇外部素材（约 ${totalWords} 词）`);
for (const [source, count] of Object.entries(bySource).sort()) {
  console.log(`  ${source}: ${count} 篇`);
}
console.log('输出：src/content/external-passages.json');
