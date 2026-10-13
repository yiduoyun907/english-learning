/**
 * 从 manythings.org 的 VOA Special English 归档抓取听力素材。
 *
 * 版权说明：VOA Special English 是美国联邦政府作品，依 17 U.S.C. § 105 属公有领域，
 * 可自由使用。抓取遵守目标站 robots.txt（对普通爬虫仅禁止 /0_copyright_by/），
 * 每篇之间留有间隔，不对站点造成压力。
 *
 * 用法：node scripts/import-voa.js [--per-section=5]
 * 可重复执行：以 slug 去重，已存在的材料更新内容。
 */
import { openDatabase } from '../src/db.js';
import { config } from '../src/config.js';
import { localStamp } from '../src/time.js';

const BASE = 'https://www.manythings.org/voa';
const USER_AGENT = 'EnglishLearning/0.1 (personal study tool)';
const DELAY_MS = 800;

/**
 * 抓取哪些栏目、每栏取几篇。
 * 仅保留确实有文章列表的栏目 —— animals / health / sports 等栏目页只有导航链接，
 * 抓取它们只会得到站点说明页。
 */
const SECTIONS = [
  { path: 'words', topic: '词汇故事', limit: 5 },
  { path: 'stories', topic: '美国故事', limit: 4 },
  { path: 'people', topic: '人物', limit: 4 },
  { path: 'history', topic: '美国历史', limit: 3 },
  { path: 'america', topic: '美国万象', limit: 3, genre: 'essay' },
  { path: 'space', topic: '太空探索', limit: 3 },
  { path: 'study', topic: '留学美国', limit: 3 },
  { path: 'places', topic: '风物地点', limit: 3 },
  // 以下栏目打上 genre，供阅读模块当非虚构材料用；不打的只做听力材料
  { path: 'usa', topic: '美国掠影', limit: 5, genre: 'essay' },
  { path: 'things', topic: '世间万物', limit: 3, genre: 'essay' },
  { path: 'how', topic: '生活指南', limit: 3, genre: 'essay' },
];

/** 常见缩写，补空格时要跳过，避免把「Mr. Smith」错切成两句 */
const ABBREVIATIONS = ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'St', 'Jr', 'Sr', 'vs', 'etc', 'No'];

// 占位标记用几乎不可能出现在正文里的 ASCII 串，不依赖不可见字符
const MARK_START = '<<ABBR';
const MARK_END = '>>';

const perSectionOverride = Number(
  (process.argv.find((arg) => arg.startsWith('--per-section=')) || '').split('=')[1]
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/**
 * 从栏目页提取文章链接与标题。
 *
 * 各栏目页的写法并不统一：href 有双引号也有单引号，标题里还常夹着
 * `<tt>2012-02-19</tt>` 这类日期标记，所以这里放宽匹配再统一清洗。
 */
function parseSectionIndex(html) {
  const found = [];
  const pattern = /<a[^>]+href=["']([^"']+\.html)["'][^>]*>([\s\S]{3,220}?)<\/a>/gi;

  for (const match of html.matchAll(pattern)) {
    const href = match[1];
    const title = decodeEntities(match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      // 去掉「2012-02-19 - 」这样的日期前缀
      .replace(/^\d{4}-\d{2}-\d{2}\s*[-–—]\s*/, '')
      .trim();

    // 排除导航类链接：上级目录、站外地址、站点说明页
    if (!title || href.startsWith('http') || href.startsWith('..')) continue;
    if (/^(about|copyright|index|help)/i.test(href)) continue;

    if (found.some((item) => item.href === href)) continue;
    found.push({ href, title });
  }
  return found;
}

/** 提取正文：取最长的段落，并排除站点页脚说明 */
function parseArticle(html) {
  const body = (html.match(/<body[\s\S]*<\/body>/i) || [''])[0];

  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => decodeEntities(match[1].replace(/<[^>]+>/g, ' ')))
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter((text) => text.length >= 40)
    .filter((text) => !/^This page is part of/i.test(text))
    .filter((text) => !/^The following are just a few of the edits/i.test(text));

  if (paragraphs.length === 0) return null;

  // 正文常常由数十个段落组成（故事类尤甚），必须全部保留；
  // 只取最长的一段会得到一篇残缺的材料。
  // 逐段清洗后用空行连接 —— 早先是直接 join(' ')，整篇会被挤成一坨。
  return paragraphs.map((para) => normalizeVoaText(para)).join('\n\n');
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * 清洗正文。manythings 的文本里，句末标点与下一句首字母之间没有空格
 * （如 "STORIES.Cold weather"），直接断句会失败，这里统一补齐。
 */
function normalizeVoaText(text) {
  let working = text;

  // 先保护缩写，避免 "Mr. Smith" 被误判为句末
  ABBREVIATIONS.forEach((abbr, index) => {
    working = working.replace(
      new RegExp(`\\b${abbr}\\.`, 'gi'),
      `${MARK_START}${index}${MARK_END}`
    );
  });

  // 句末标点后紧跟大写字母时补一个空格，恢复出正常的句子边界
  working = working.replace(/([.!?])(?=[A-Z"'])/g, '$1 ');

  const markPattern = new RegExp(`${MARK_START}(\\d+)${MARK_END}`, 'g');
  working = working.replace(markPattern, (_, index) => `${ABBREVIATIONS[Number(index)]}.`);

  return working
    .replace(/\s+([.!?,;:])/g, '$1') // 源页面存在「STORIES .」这类标点前带空格的写法
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从页面标题里去掉站名与括号说明 */
function cleanTitle(rawTitle) {
  return rawTitle
    .replace(/\s*\((?:VOA\s*)?Special English\)\s*$/i, '')
    .replace(/\s*-\s*Interesting Things for ESL.*$/i, '')
    .trim();
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

async function main() {
  // seed: false —— 否则会用上次导出的旧 JSON 覆盖库里的素材（也会盖掉另一个抓取脚本的成果）
  const db = openDatabase(config.dbPath, { seed: false });

  const upsert = db.prepare(
    `INSERT INTO passages
       (slug, title, title_zh, level, topic, content, word_count, source, genre,
        attribution, source_url, created_at)
     VALUES (?, ?, NULL, 'intermediate', ?, ?, ?, 'voa', ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title       = excluded.title,
       topic       = excluded.topic,
       content     = excluded.content,
       word_count  = excluded.word_count,
       genre       = excluded.genre,
       attribution = excluded.attribution,
       source_url  = excluded.source_url`
  );

  const now = localStamp();
  let imported = 0;
  let skipped = 0;

  for (const section of SECTIONS) {
    const limit = perSectionOverride > 0 ? perSectionOverride : section.limit;
    console.log(`\n[${section.path}] ${section.topic} —— 取前 ${limit} 篇`);

    let indexHtml;
    try {
      indexHtml = await fetchText(`${BASE}/${section.path}/`);
    } catch (error) {
      console.error(`  栏目页获取失败：${error.message}`);
      continue;
    }

    const articles = parseSectionIndex(indexHtml).slice(0, limit);
    if (articles.length === 0) {
      console.error('  未解析到文章链接');
      continue;
    }

    for (const article of articles) {
      const url = `${BASE}/${section.path}/${article.href}`;
      const slug = `voa-${section.path}-${article.href.replace(/\.html$/, '')}`;

      try {
        await sleep(DELAY_MS);
        const pageHtml = await fetchText(url);
        const content = parseArticle(pageHtml);

        if (!content || content.length < 400) {
          console.error(`  跳过（正文过短）：${article.title}`);
          skipped += 1;
          continue;
        }

        const title = cleanTitle(article.title);
        const attribution = `VOA Special English · ${
          title.includes(':') ? title.split(':')[0].trim() : section.topic
        }`;

        upsert.run(
          slug,
          title,
          section.topic,
          content,
          countWords(content),
          section.genre || null,
          attribution,
          url,
          now
        );

        console.log(`  ✓ ${title.slice(0, 50)}（${countWords(content)} 词）`);
        imported += 1;
      } catch (error) {
        console.error(`  抓取失败 ${article.href}：${error.message}`);
        skipped += 1;
      }
    }
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const total = db.prepare("SELECT COUNT(*) AS n FROM passages WHERE source = 'voa'").get().n;
  db.close();

  console.log('');
  console.log(`本次写入 ${imported} 篇，跳过 ${skipped} 篇。`);
  console.log(`库中共有 VOA 听力材料 ${total} 篇。`);
  console.log('版权：VOA Special English 为美国联邦政府作品，属公有领域。');
}

main().catch((error) => {
  console.error('导入失败：', error);
  process.exit(1);
});
