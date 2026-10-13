/**
 * 从 Project Gutenberg 导入公版短篇小说。
 *
 * 用法：node scripts/import-gutenberg.js
 *
 * 只使用作者逝世超过 70 年（或作品出版于 1930 年前）的公版作品，
 * 素材来源与版权状态由 Project Gutenberg 审核。抓下来的文本会剥掉
 * Gutenberg 的许可头尾与志愿者署名，按目录切分成单篇再入库。
 *
 * 难度分档：Flesch Reading Ease 反映句法复杂度，长词占比反映词汇复杂度，
 * 两者作为参考值给出初档；ECDICT 的词频字段对变形词不可靠（is/was/are
 * 都没有排名也没有大纲标签），所以不做纯自动分级。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const DB_PATH = process.env.DB_PATH || 'data/app.db';
const USER_AGENT = 'Mozilla/5.0 (self-study English learning tool)';

/** 书目：均属公有领域。minWords/maxWords 用于筛掉过短片段与过长篇目 */
const BOOKS = [
  {
    id: 2776,
    author: 'O. Henry',
    collection: 'The Four Million',
    year: 1906,
    genre: 'fiction',
    minWords: 1200,
    maxWords: 3600,
    limit: 12,
  },
  {
    id: 2814,
    author: 'James Joyce',
    collection: 'Dubliners',
    year: 1914,
    genre: 'fiction',
    minWords: 1200,
    maxWords: 3600,
    limit: 10,
  },
  {
    id: 44385,
    author: 'Katherine Mansfield',
    collection: 'Bliss and Other Stories',
    year: 1920,
    genre: 'fiction',
    minWords: 1200,
    maxWords: 3600,
    limit: 8,
  },
  {
    id: 902,
    author: 'Oscar Wilde',
    collection: 'The Happy Prince and Other Tales',
    year: 1888,
    genre: 'fiction',
    minWords: 1000,
    maxWords: 4600,
    limit: 5,
  },
  // 诗集整本入库：诗没有统一的目录结构，按篇拆不现实，整本作为一篇材料读
  {
    id: 1065,
    author: 'Edgar Allan Poe',
    collection: 'The Raven',
    year: 1845,
    genre: 'poem',
    whole: true,
    minWords: 300,
    maxWords: 4000,
  },
  {
    id: 3021,
    author: 'Robert Frost',
    collection: "A Boy's Will",
    year: 1913,
    genre: 'poem',
    whole: true,
    minWords: 300,
    maxWords: 8000,
  },
  {
    id: 1934,
    author: 'William Blake',
    collection: 'Songs of Innocence and of Experience',
    year: 1794,
    genre: 'poem',
    whole: true,
    minWords: 300,
    maxWords: 9000,
  },
];

/**
 * 难度定档以作者为基准，个别人工覆盖。
 *
 * Flesch 只看句长与音节数，对文学系统性偏高：曼斯菲尔德句短词短，
 * 会被算成「非常容易」，但她写的是现代主义文本，暗示与心理描写很密。
 * 所以自动分只作参考，真正的档位在这里定。
 */
const LEVEL_BY_AUTHOR = {
  'Oscar Wilde': 'beginner', // 童话，语言优美但不艰深
  'Katherine Mansfield': 'intermediate',
  'O. Henry': 'intermediate',
  'James Joyce': 'intermediate',
};

/** key 用小写，匹配时对篇名做小写化 */
const LEVEL_EXCEPTIONS = {
  'the devoted friend': 'intermediate',   // 比前几篇童话更长、讽刺更重
  'the remarkable rocket': 'intermediate',
  'eveline': 'beginner',                  // Dubliners 里语言最简单的一篇
  'clay': 'beginner',
  'a cosmopolite in a café': 'advanced',  // 长句与用典最重
  'the cop and the anthem': 'advanced',
};

const countWordTokens = (text) => (text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;

/** 启发式音节计数：数元音组，去掉不发音的词尾 */
function countSyllables(raw) {
  let word = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = word.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

/** Flesch Reading Ease：分数越高越容易 */
function fleschScore(content) {
  const sentences = (content.match(/[.!?]+(?=\s|$)/g) || []).length || 1;
  const tokens = content.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
  if (!tokens.length) return 0;
  const syllables = tokens.reduce((sum, token) => sum + countSyllables(token), 0);
  return 206.835 - 1.015 * (tokens.length / sentences) - 84.6 * (syllables / tokens.length);
}

/** 长词（≥7 字母）占比，作为词汇复杂度的粗略参考 */
function longWordRatio(content) {
  const tokens = content.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
  if (!tokens.length) return 0;
  return tokens.filter((token) => token.length >= 7).length / tokens.length;
}

/** 初档建议，仅供人工定档时参考 */
function suggestLevel(flesch, longRatio) {
  if (flesch > 75 && longRatio < 0.13) return 'beginner';
  if (flesch >= 60 && longRatio <= 0.17) return 'intermediate';
  return 'advanced';
}

function stripGutenbergWrapper(raw) {
  const start = raw.indexOf('*** START OF');
  const end = raw.lastIndexOf('*** END OF');
  if (start < 0 || end < 0) return null;
  return raw.slice(raw.indexOf('\n', start) + 1, end);
}

/** Gutenberg 志愿者署名、插图占位、版本说明等噪音行 */
const NOISE_LINE =
  /^(produced by|transcribed from|e-?text prepared|this ebook|updated editions?|title page|frontispiece|cover|\[illustration|\[picture|illustration\])/i;

function cleanStory(rawText, { preserveLines = false } = {}) {
  const paragraphs = rawText
    .replace(/\r/g, '')
    .replace(/_([^_]+)_/g, '$1')
    .split(/\n\s*\n/)
    .map((para) => {
      const lines = para.split('\n').map((line) => line.trim()).filter(Boolean);
      // 诗歌的换行就是分行，必须原样保留；散文的换行只是排版折行，接回一段
      return preserveLines ? lines.join('\n') : lines.join(' ');
    })
    .filter(Boolean)
    .filter((para) => !NOISE_LINE.test(para));

  // 掐掉开头的书名页：连续的短段、且不以句末标点收尾
  while (paragraphs.length > 0 && paragraphs[0].length < 80 && !/[.!?"')\]]$/.test(paragraphs[0])) {
    paragraphs.shift();
  }

  return paragraphs.join('\n\n');
}

/**
 * 目录行可能带点线与页码（如 `The Happy Prince . . . . . 1`），
 * 先剥掉它们，否则会混进篇名里。
 */
function cleanTocLine(line) {
  return line
    .replace(/\s*\.\s*\.\s*\..*$/, '')
    .replace(/\s+\d+\s*$/, '')
    .trim();
}

/** 归一化标题行，抹平罗马数字前缀、标点与大小写差异 */
function normalizeHeading(line) {
  return line
    .replace(/^(chapter\s+)?([ivxlc]+|\d+)[.):]?\s+/i, '')
    .replace(/[^a-z\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 从正文里读目录：Contents 之后连续的短行 */
function extractContents(lines) {
  const startIndex = lines.findIndex((line) => /^\s*contents?[:.]?\s*$/i.test(line));
  if (startIndex < 0) return { names: [], searchFrom: 0 };

  const names = [];
  let blankStreak = 0;
  let index = startIndex + 1;

  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      blankStreak += 1;
      if (blankStreak >= 2 && names.length >= 2) break;
      continue;
    }
    blankStreak = 0;
    if (line.length > 70) break;
    if (line.length < 2) continue;
    const name = cleanTocLine(line);
    if (name.length >= 2) names.push(name);
  }

  return { names, searchFrom: index };
}

/** 按目录篇名在正文里定位标题行（顶格、短行、归一化后相同） */
function locateStories(lines, names, searchFrom) {
  const marks = [];

  for (const name of names) {
    const target = normalizeHeading(name);
    if (!target) continue;

    for (let i = searchFrom; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || line.length > 90) continue;
      if (/^\s/.test(line)) continue;
      if (normalizeHeading(line) !== target) continue;
      marks.push({ name, index: i });
      break;
    }
  }

  marks.sort((a, b) => a.index - b.index);
  return marks;
}

function splitCollection(body) {
  const lines = body.split('\n');
  const { names, searchFrom } = extractContents(lines);
  if (names.length < 2) return [];

  const marks = locateStories(lines, names, searchFrom);
  return marks.map((mark, i) => ({
    title: mark.name.replace(/^([ivxlc]+|\d+)[.):]?\s+/i, '').trim(),
    raw: lines.slice(mark.index, marks[i + 1] ? marks[i + 1].index : lines.length).join('\n'),
  }));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function ensureGenreColumn(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(passages)').all().map((row) => row.name));
  if (!columns.has('genre')) db.exec('ALTER TABLE passages ADD COLUMN genre TEXT');
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`找不到数据库 ${DB_PATH}，先启动一次服务让它初始化`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  ensureGenreColumn(db);

  const upsert = db.prepare(
    `INSERT INTO passages
       (slug, title, title_zh, level, topic, content, word_count, source, genre,
        attribution, source_url, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'gutenberg', ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title       = excluded.title,
       level       = excluded.level,
       topic       = excluded.topic,
       content     = excluded.content,
       word_count  = excluded.word_count,
       genre       = excluded.genre,
       attribution = excluded.attribution,
       source_url  = excluded.source_url`
  );

  let imported = 0;

  for (const book of BOOKS) {
    const url = `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.txt`;
    let body;
    try {
      body = stripGutenbergWrapper(await fetchText(url));
    } catch (error) {
      console.log(`✗ ${book.collection} 下载失败：${error.message}`);
      continue;
    }
    if (!body) {
      console.log(`✗ ${book.collection} 缺少 START/END 标记`);
      continue;
    }

    const stories = book.whole
      ? [{ title: book.collection, raw: body }]
      : splitCollection(body);
    console.log(
      `\n【${book.collection}】${book.author} → ${
        book.whole ? '整本入库' : `切出 ${stories.length} 篇`
      }`
    );

    let taken = 0;
    for (const story of stories) {
      if (taken >= book.limit) break;

      const content = cleanStory(story.raw, { preserveLines: book.genre === 'poem' });
      const words = countWordTokens(content);
      if (words < book.minWords || words > book.maxWords) continue;

      const flesch = Number(fleschScore(content).toFixed(1));
      const longRatio = Number((longWordRatio(content) * 100).toFixed(1));
      const level =
        LEVEL_EXCEPTIONS[story.title.toLowerCase()] ||
        LEVEL_BY_AUTHOR[book.author] ||
        suggestLevel(flesch, longRatio / 100);

      const slug = `gutenberg-${book.id}-${taken + 1}`;
      const attribution = `${book.author}《${book.collection}》(${book.year}) · 公有领域 · 来源 Project Gutenberg`;
      upsert.run(
        slug,
        story.title,
        level,
        book.author,
        content,
        words,
        book.genre,
        attribution,
        `https://www.gutenberg.org/ebooks/${book.id}`,
        new Date().toISOString().slice(0, 19).replace('T', ' ')
      );

      console.log(
        `   ✓ ${story.title.slice(0, 38).padEnd(40)} ${String(words).padStart(5)}词  F${String(flesch).padStart(5)}  长词${longRatio}%  → ${level}`
      );
      taken += 1;
      imported += 1;
    }
    console.log(`   入库 ${taken} 篇`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  db.close();
  console.log(`\n共导入 ${imported} 篇。记得跑 npm run export:passages 把素材固化进代码。`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
