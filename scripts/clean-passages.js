/**
 * 清洗外部素材的文本瑕疵。
 *
 * 处理三类问题：
 *   1. 单词粘连（新东方页面录入时丢了空格）—— 用词库做切分还原
 *   2. PDF 提取断字（"w ell"、"p hysiological"）—— 合并回去
 *   3. 无法还原的真乱码段落 —— 剔除该条材料
 *
 * 用法：node scripts/clean-passages.js [--dry-run] [--prune]
 *   --prune  额外剔除疑似乱码的材料（默认只报告、不删，避免误删正常文章）
 * 改完记得跑 npm run export:passages 重新导出，否则线上不会更新。
 */
import { openDatabase } from '../src/db.js';
import { config } from '../src/config.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune');
const MIN_GLUED_LENGTH = 12;
const MAX_WORD_LENGTH = 18;

// seed: false —— 否则会拿上次导出的旧 JSON 把刚清洗好的内容盖回去
const db = openDatabase(config.dbPath, { seed: false });

/* ---------- 词表 ---------- */

const vocab = new Set();
for (const row of db.prepare('SELECT headword FROM words').all()) {
  vocab.add(row.headword.toLowerCase());
}
for (const row of db.prepare('SELECT form FROM word_forms').all()) {
  vocab.add(row.form.toLowerCase());
}
console.log(`词表：${vocab.size} 个词`);

/* ---------- 清洗规则 ---------- */

/**
 * 站点水印：PDF 里嵌的网址，属于噪声，直接删掉。
 *
 * 实际形式并不统一 —— 有的是完整 URL，有的只剩裸域名（zhenti.burningvocabulary.com/），
 * 所以既匹配 URL，也直接匹配域名关键字。早先只写了 zhentiburningvocabulary（中间漏了点），
 * 结果一个都没匹配上。
 */
const WATERMARK_PATTERN =
  /https?:\/\/\S+|\S*(?:burningvocabulary|koolearn)\S*|www\.[a-z]+\.(?:com|cn|org)\S*/gi;

/**
 * 尝试把粘连的长 token 切成多个单词（最长优先的贪心匹配）。
 *
 * 允许出现「未登录片段」：例如 instinctiveratherthana 里的 instinctive 不在考纲词表，
 * 但其余部分仍应被切开 —— 若一遇到不认识的片段就整体放弃，绝大多数粘连都修不了。
 * 返回 null 表示不值得改动（本身是词、太短、或切不出有意义的结果）。
 */
function splitGlued(token) {
  if (token.length < MIN_GLUED_LENGTH || vocab.has(token)) return null;
  if (!/^[a-z]+$/.test(token)) return null;

  const parts = [];
  let cursor = 0;
  let pending = '';

  while (cursor < token.length) {
    let matched = null;
    const furthest = Math.min(token.length, cursor + MAX_WORD_LENGTH);

    for (let end = furthest; end > cursor + 1; end -= 1) {
      const candidate = token.slice(cursor, end);
      if (vocab.has(candidate)) {
        matched = candidate;
        break;
      }
    }

    if (matched) {
      if (pending) {
        parts.push(pending);
        pending = '';
      }
      parts.push(matched);
      cursor += matched.length;
    } else {
      pending += token[cursor];
      cursor += 1;
    }
  }
  if (pending) parts.push(pending);

  // 约束：至少切出 2 段；每段不短于 4 个字母（避免把 therapist 切成 the + rapist）；
  // 最长的一段不能占掉大半个 token
  if (parts.length < 2) return null;
  if (parts.some((part) => part.length < 4)) return null;
  const longest = Math.max(...parts.map((part) => part.length));
  if (longest > token.length * 0.7) return null;

  return parts;
}

/** 修复 PDF 提取导致的断字：只有单个辅音字母时才合并，避免误伤 "a cat" */
function fixBrokenLetters(text) {
  return text.replace(/\b([bcdfghjklmnpqrstvwxyz]) (?=[a-z])/g, '$1');
}

/**
 * 剥掉开头的 Directions 残留。
 *
 * PDF 提取时换行信息丢失，「答题说明」的最后半句会粘在正文前面，例如
 *   in the bank more than once. Researchers, writing in the journal Heart, ...
 * 英文正文必定以大写字母开头，所以开头不是大写就说明前面粘了东西，
 * 丢到第一个句末标点为止即可。残留过长（>200 字符）时保守不动，宁可留着。
 */
function stripLeadingDirections(text) {
  if (/^[A-Z"'(]/.test(text)) return text;
  const end = text.search(/[.!?]\s/);
  if (end < 0 || end > 200) return text;
  return text.slice(end + 1).trimStart();
}

/** 逐 token 清洗：先去水印，再切粘连，最后修断字 */
function cleanText(text) {
  const tokens = text.replace(WATERMARK_PATTERN, ' ').split(/\s+/);
  const output = [];
  let gluedFixed = 0;

  for (const token of tokens) {
    if (!token) continue;

    // 保留标点，只对纯字母部分尝试切分
    const match = token.match(/^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/);
    if (match) {
      const [, prefix, word, suffix] = match;
      const pieces = splitGlued(word.toLowerCase());
      if (pieces) {
        gluedFixed += 1;
        output.push(prefix + pieces.join(' ') + suffix);
        continue;
      }
    }
    output.push(token);
  }

  const joined = fixBrokenLetters(output.join(' '));
  return { text: stripLeadingDirections(joined), gluedFixed };
}

/**
 * 判断整条材料是否属于无法还原的乱码。
 *
 * 注意：考纲词表只有 3.4 万词，像 disproportionately、underrepresented 这类
 * 正常长词并不在其中，不能因为「不认识」就判定为乱码。所以要求乱码 token
 * 在长 token 中占到相当比例，才认定整条材料有问题。
 */
function looksLikeGarbage(text) {
  const tokens = text.replace(WATERMARK_PATTERN, ' ').split(/\s+/);
  let longTokens = 0;
  let garbageTokens = 0;

  for (const token of tokens) {
    const word = token.replace(/[^A-Za-z]/g, '').toLowerCase();
    if (word.length < 16) continue;
    longTokens += 1;
    if (vocab.has(word)) continue;

    const pieces = splitGlued(word);
    if (!pieces || pieces.some((piece) => piece.length >= 16)) garbageTokens += 1;
  }

  if (garbageTokens < 3 || longTokens === 0) return false;
  return garbageTokens / longTokens >= 0.4;
}

/* ---------- 主流程 ---------- */

const rows = db
  .prepare("SELECT id, title, content, source FROM passages WHERE source LIKE 'cet%'")
  .all();

const update = db.prepare('UPDATE passages SET content = ?, word_count = ? WHERE id = ?');
const remove = db.prepare('DELETE FROM passages WHERE id = ?');

let fixedGlue = 0;
let fixedBroken = 0;
let removed = 0;
let suspicious = 0;
let touched = 0;

db.exec('BEGIN');

for (const row of rows) {
  const original = row.content;

  if (looksLikeGarbage(original)) {
    suspicious += 1;
    if (PRUNE) {
      removed += 1;
      if (!DRY_RUN) remove.run(row.id);
      console.log(`  剔除疑似乱码：${row.title.slice(0, 46)}`);
      continue;
    }
    console.log(`  疑似乱码（已保留，可加 --prune 剔除）：${row.title.slice(0, 40)}`);
  }

  const { text, gluedFixed } = cleanText(original);
  const before = original.split(/\s+/).length;
  const after = text.split(/\s+/).length;

  if (text === original) continue;

  touched += 1;
  if (gluedFixed > 0) fixedGlue += gluedFixed;
  if (after !== before) fixedBroken += 1;

  if (!DRY_RUN) update.run(text, after, row.id);
}

if (DRY_RUN) {
  db.exec('ROLLBACK');
} else {
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

db.close();

console.log('');
console.log(`检查材料 ${rows.length} 条`);
console.log(`  修复粘连词 ${fixedGlue} 处（改动材料 ${touched} 条）`);
console.log(`  疑似乱码 ${suspicious} 条${PRUNE ? `，已剔除 ${removed} 条` : '（默认保留）'}`);
console.log(DRY_RUN ? '\n（dry-run，未写入）' : '\n（已写入，请执行 npm run export:passages 同步到代码）');
