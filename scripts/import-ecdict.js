/**
 * 从 ECDICT 的 ecdict.csv 中筛出各考试词书所需词条并导入 SQLite。
 *
 * 用法：node scripts/import-ecdict.js [csv路径]
 * 默认读取 data/ecdict.csv。脚本可重复执行（会先清空词库相关表）。
 *
 * 只导入命中词书标签的词（而非全部 77 万词条），
 * 使 words 表保持在数万量级，保证线上查询性能。
 */
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

import { config, projectRoot } from '../src/config.js';
import { openDatabase, WORD_BOOKS } from '../src/db.js';

const csvPath = resolve(process.cwd(), process.argv[2] || resolve(projectRoot, 'data/ecdict.csv'));

try {
  statSync(csvPath);
} catch {
  console.error(`找不到词库文件：${csvPath}`);
  console.error('请先下载 ECDICT 的 ecdict.csv 到 data/ 目录，或通过参数指定路径。');
  process.exit(1);
}

const tagToBook = new Map(WORD_BOOKS.filter((book) => book.tag).map((book) => [book.tag, book.code]));
const oxfordBook = WORD_BOOKS.find((book) => book.code === 'oxford');

const db = openDatabase(config.dbPath);

console.log(`数据库：${config.dbPath}`);
console.log(`词库源：${csvPath}`);

// 重建词库。注意：user_words / review_logs 通过外键级联到 words，
// 因此重新导入会一并清空所有用户的学习记录，仅建议在初始化阶段执行。
console.log('提示：将重建词库表，已有的用户学习记录会随之清空。');
db.exec('DELETE FROM wordbook_words');
db.exec('DELETE FROM words');

const bookIdByCode = new Map(
  db.prepare('SELECT id, code FROM wordbooks').all().map((row) => [row.code, row.id])
);

const insertWord = db.prepare(
  `INSERT OR IGNORE INTO words
     (headword, phonetic, translation_zh, definition_en, pos, collins, oxford, bnc, frq, exchange, tags)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const selectWordId = db.prepare('SELECT id FROM words WHERE headword = ?');
const linkWord = db.prepare(
  'INSERT OR IGNORE INTO wordbook_words (wordbook_id, word_id, seq) VALUES (?, ?, ?)'
);

const seqCursor = new Map();
const bookCounts = new Map();

let scanned = 0;
let imported = 0;
let isHeader = true;

const lines = createInterface({
  input: createReadStream(csvPath, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

db.exec('BEGIN');

for await (const line of lines) {
  if (isHeader) {
    isHeader = false;
    continue;
  }
  if (!line) continue;
  scanned += 1;

  const fields = parseCsvLine(line);
  if (fields.length < 11) continue;

  const [headword, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange] = fields;

  // 没有中文释义的词条对学习卡片没有价值，直接跳过
  if (!headword || !translation) continue;

  const matchedBooks = collectBooks(tag, oxford);
  if (matchedBooks.length === 0) continue;

  insertWord.run(
    headword,
    emptyToNull(phonetic),
    emptyToNull(normalizeText(translation)),
    emptyToNull(normalizeText(definition)),
    emptyToNull(pos),
    toInt(collins),
    oxford === '1' ? 1 : 0,
    toInt(bnc),
    toInt(frq),
    emptyToNull(exchange),
    emptyToNull(tag)
  );

  const wordRow = selectWordId.get(headword);
  if (!wordRow) continue;
  imported += 1;

  for (const code of matchedBooks) {
    const bookId = bookIdByCode.get(code);
    if (!bookId) continue;
    const seq = (seqCursor.get(code) || 0) + 1;
    seqCursor.set(code, seq);
    linkWord.run(bookId, wordRow.id, seq);
    bookCounts.set(code, (bookCounts.get(code) || 0) + 1);
  }
}

db.exec('COMMIT');

// 学习顺序改为「高频词优先」：按 BNC 词频排序重编号（无词频数据的排最后）
reorderByFrequency();

// 回填每本词书的实际词数
db.prepare(
  `UPDATE wordbooks
      SET word_count = (SELECT COUNT(*) FROM wordbook_words WHERE wordbook_id = wordbooks.id)`
).run();

console.log('');
console.log(`扫描词条：${scanned.toLocaleString()}`);
console.log(`导入词条：${imported.toLocaleString()}（去重后写入 words 表）`);
console.log('');
console.log('各词书词数：');
for (const book of WORD_BOOKS) {
  console.log(`  ${book.code.padEnd(8)} ${book.name.padEnd(14)} ${(bookCounts.get(book.code) || 0).toLocaleString()}`);
}
console.log('');
console.log('导入完成。');

// 把 WAL 中的内容写回主库文件，使 data/app.db 成为可直接分发/打包的完整数据库
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

/** 把每本词书的 seq 重排为按 BNC 词频升序（越常见越小） */
function reorderByFrequency() {
  const selectOrdered = db.prepare(
    `SELECT wbw.word_id AS word_id
       FROM wordbook_words wbw
       JOIN words w ON w.id = wbw.word_id
      WHERE wbw.wordbook_id = ?
      ORDER BY CASE WHEN w.bnc > 0 THEN w.bnc ELSE 999999 END ASC, w.id ASC`
  );
  const updateSeq = db.prepare(
    'UPDATE wordbook_words SET seq = ? WHERE wordbook_id = ? AND word_id = ?'
  );

  for (const book of WORD_BOOKS) {
    const bookId = bookIdByCode.get(book.code);
    if (!bookId) continue;
    const rows = selectOrdered.all(bookId);
    db.exec('BEGIN');
    rows.forEach((row, index) => updateSeq.run(index + 1, bookId, row.word_id));
    db.exec('COMMIT');
  }
}

/** 判断一个词条属于哪些词书 */
function collectBooks(tag, oxford) {
  const codes = [];
  for (const token of String(tag || '').split(/\s+/)) {
    const code = tagToBook.get(token);
    if (code) codes.push(code);
  }
  if (oxford === '1' && oxfordBook) codes.push(oxfordBook.code);
  return codes;
}

/**
 * 解析单行 CSV。字段内的逗号被双引号包裹，
 * 引号内的双引号以 "" 转义。ECDICT 的换行在字段内是字面量 \n，因此可按行处理。
 */
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

function emptyToNull(value) {
  return value === undefined || value === '' ? null : value;
}

/**
 * ECDICT 的释义字段用字面量 \n 表示换行（而非真实换行符），
 * 这里还原成真实换行，前端配合 white-space: pre-wrap 才能正确分行。
 */
function normalizeText(value) {
  if (!value) return value;
  return value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}
