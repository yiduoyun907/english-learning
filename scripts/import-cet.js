/**
 * 抓取四六级真题的听力原文与阅读文章，来源为新东方在线。
 *
 * ⚠️ 版权提示：大学英语四六级真题的著作权归考试主办方所有。本脚本抓取的内容
 * 仅供个人学习使用，请勿公开传播或用于商业用途。站点页面已设 noindex。
 *
 * 用法：
 *   node scripts/import-cet.js                    # 抓取四级与六级
 *   node scripts/import-cet.js --level=4          # 只抓四级
 *   node scripts/import-cet.js --pages=20         # 只翻前 20 页（调试用）
 *   node scripts/import-cet.js --limit=6          # 最多解析 6 个页面（调试用）
 *
 * 只取文本素材：听力部分保留原文（去掉题目），阅读部分保留文章正文。
 */
import { openDatabase } from '../src/db.js';
import { config } from '../src/config.js';
import { localStamp } from '../src/time.js';

const LEVELS = [
  { level: '4', name: '四级', host: 'https://cet4.koolearn.com' },
  { level: '6', name: '六级', host: 'https://cet6.koolearn.com' },
];

const readArg = (key, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${key}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const LIST_PAGES = Number(readArg('pages', 95));
const MAX_ARTICLES = Number(readArg('limit', 0)) || Infinity;
const ONLY_LEVEL = readArg('level', null);
const DELAY_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (personal study tool)' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/* ---------------- 列表收集 ---------------- */

/** 翻列表页，收集 { url, date, title } */
async function collectArticles(host, pages) {
  const found = new Map();

  for (let page = 1; page <= pages; page += 1) {
    const url = page === 1 ? `${host}/zhenti/` : `${host}/zhenti/${page}.html`;

    let html;
    try {
      html = await fetchHtml(url);
    } catch {
      continue;
    }

    const pattern = /<a[^>]+href="(https?:\/\/[^"]*?koolearn\.com\/(\d{8})\/\d+\.html)"[^>]*>([^<]{6,90})<\/a>/gi;
    for (const match of html.matchAll(pattern)) {
      const target = match[1].replace(/^http:/, 'https:');
      const title = decodeEntities(match[3].replace(/\s+/g, ' ').trim());
      if (!found.has(target)) found.set(target, { url: target, date: match[2], title });
    }

    await sleep(DELAY_MS * 0.5);
  }

  return [...found.values()];
}

/** 从标题解析考次与套号 */
function parseExam(title) {
  const exam = title.match(/(\d{4})年(\d{1,2})月/);
  if (!exam) return null;
  const set = title.match(/第([一二三四])套/);
  return {
    examKey: `${exam[1]}-${String(exam[2]).padStart(2, '0')}`,
    setName: set ? `第${set[1]}套` : '',
  };
}

/** 挑选目标页面：每（考次 + 套号 + 类型）只保留一个 */
function pickTargets(articles, kind) {
  const wanted = kind === 'listening' ? /听力原文|听力真题及答案/ : /仔细阅读真题及答案|长篇阅读真题及答案/;
  const chosen = new Map();

  for (const article of articles) {
    if (!wanted.test(article.title)) continue;
    const parsed = parseExam(article.title);
    if (!parsed) continue;

    const key = `${kind}:${parsed.examKey}:${parsed.setName}`;
    const score = /原文/.test(article.title) ? 2 : 1; // 优先取「原文」版
    const existing = chosen.get(key);
    if (!existing || score > existing.score) {
      chosen.set(key, { ...article, ...parsed, kind, score });
    }
  }

  return [...chosen.values()];
}

/* ---------------- 正文提取 ---------------- */

/** 取出 xqy_core_text 正文容器并转为纯文本 */
function extractBody(html) {
  // 从容器「开始标签之后」取内容，否则 class="..." 本身会被带进正文
  const match = html.match(/<div[^>]*class="[^"]*xqy_core_text[^"]*"[^>]*>([\s\S]{200,})/i);
  if (!match) return null;

  const chunk = match[1].slice(0, 60000);
  const end = chunk.search(/<div[^>]+class="[^"]*(xqy_core_btn|core_main_keyword)/i);
  const raw = end > 0 ? chunk.slice(0, end) : chunk;

  return decodeEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[ \t　]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/** 该行是否是站点推广 / 导航 / 题目 / 代码样式行，需要丢弃 */
function isNoise(line) {
  if (line.length < 6) return true;
  if (/^[↑↓\s]*点击/.test(line)) return true;
  if (/^【[^】]*(领取|查看|直播|公众号)/.test(line)) return true;
  if (/公众号|领取|直播|估成绩|成绩查询|扫码/.test(line) && line.length < 60) return true;
  if (/^Questions?\s*\d+/i.test(line)) return true; // 题目行
  if (/^Q\d+[.、]/.test(line)) return true;
  if (/^\[?新东方/.test(line)) return true;
  if (/^提示[:：]/.test(line)) return true;

  // CSS / JS 残留
  if (/[{}]|=>|\$\(|setTimeout|addClass|function\s|var\s|window\.|document\./.test(line)) return true;
  if (
    /(^|\s)(transform|transition|background|border|margin|padding|display|position|color|font|width|height|left|top|opacity|z-index|align|justify)\s*:/i.test(
      line
    )
  ) {
    return true;
  }
  if (/url\(|\d+px|\d+%;|solid \d/.test(line)) return true;

  // 中英混排或代码行：字母占比过低
  const letters = (line.match(/[A-Za-z]/g) || []).length;
  if (line.length >= 20 && letters / line.length < 0.5) return true;

  return false;
}

/** 听力：从「听力原文」标记处开始，按 Section / 新闻 / 对话 / Passage 切分 */
function parseListening(body) {
  const anchor = body.search(/听力原文/);
  let text = anchor >= 0 ? body.slice(anchor) : body;

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const kept = lines.filter((line) => {
    if (isNoise(line)) return false;
    if (/听力原音重现|听力原文[】\]]?$|^【/.test(line)) return false;
    return /[A-Za-z]{3,}/.test(line); // 必须含英文正文
  });

  if (kept.length === 0) return [];

  // 以 Section 为界拆成若干段材料
  const blocks = [];
  let current = null;

  for (const line of kept) {
    const isHeading = /^(Sec?e?ction\s*[ABC]|[一二三]\s*、?\s*(新闻|对话|短文)|新闻\s*\d|对话\s*\d|Passage\s*\d|Conversation\s*\d)/i.test(
      line
    );

    if (isHeading || !current) {
      current = { heading: isHeading ? line : '', lines: [] };
      blocks.push(current);
      if (isHeading) continue;
    }
    current.lines.push(line);
  }

  return blocks
    .map((block, index) => {
      const content = block.lines.join(' ').replace(/\s+/g, ' ').trim();
      return { index, heading: block.heading, content };
    })
    .filter((block) => block.content.length >= 200);
}

/** 阅读：取出 Passage One / Two 的文章正文，丢掉题目与选项 */
function parseReading(body) {
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const kept = lines.filter((line) => {
    if (isNoise(line)) return false;
    // 丢掉选项行与「Questions xx to xx」提示行
    if (/^\s*[A-D][.)、]\s/.test(line)) return false;
    if (/^Questions?\s+\d+/i.test(line)) return false;
    if (/^Directions/i.test(line)) return false;
    if (/阅读真题及答案|仔细阅读|长篇阅读|选词填空/.test(line) && line.length < 40) return false;
    return /[A-Za-z]{4,}/.test(line);
  });

  const blocks = [];
  let current = null;

  for (const line of kept) {
    const isHeading = /^(Passage\s+(One|Two|Three|1|2|3)|Section\s*[ABC])/i.test(line);
    if (isHeading || !current) {
      current = { heading: isHeading ? line : '', lines: [] };
      blocks.push(current);
      if (isHeading) continue;
    }
    current.lines.push(line);
  }

  return blocks
    .map((block, index) => ({
      index,
      heading: block.heading,
      content: block.lines.join(' ').replace(/\s+/g, ' ').trim(),
    }))
    .filter((block) => block.content.length >= 400);
}

/* ---------------- 主流程 ---------------- */

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

async function main() {
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

  const now = localStamp();
  let saved = 0;
  let parsed = 0;
  let skipped = 0;

  const activeLevels = LEVELS.filter((item) => !ONLY_LEVEL || item.level === ONLY_LEVEL);

  for (const { level, name, host } of activeLevels) {
    console.log(`\n===== ${name} =====`);
    const articles = await collectArticles(host, LIST_PAGES);
    console.log(`列表收集完成，共 ${articles.length} 篇`);

    const targets = [
      ...pickTargets(articles, 'listening'),
      ...pickTargets(articles, 'reading'),
    ].sort((a, b) => a.date.localeCompare(b.date));

    console.log(`命中目标页面 ${targets.length} 个（听力 + 阅读）`);

    for (const target of targets) {
      if (parsed >= MAX_ARTICLES) break;
      parsed += 1;

      let body;
      try {
        await sleep(DELAY_MS);
        body = extractBody(await fetchHtml(target.url));
      } catch (error) {
        console.error(`  抓取失败 ${target.title}：${error.message}`);
        continue;
      }
      if (!body) {
        // 2025 年起新东方把真题页改成引流页，正文只有推广文案，无容器
        skipped += 1;
        continue;
      }

      const blocks =
        target.kind === 'listening' ? parseListening(body) : parseReading(body);

      if (blocks.length === 0) {
        skipped += 1;
        continue;
      }

      console.log(
        `  ${target.kind.padEnd(9)} ${String(blocks.length).padStart(2)} 段  ${target.title.slice(0, 42)}`
      );

      for (const block of blocks) {
        const label = block.heading ? block.heading.replace(/\s+/g, ' ') : `第${block.index + 1}段`;
        const title = `${target.examKey} ${name}${target.setName ? target.setName : ''} ${
          target.kind === 'listening' ? '听力' : '阅读'
        } · ${label}`;
        const slug = `cet${level}-${target.kind}-${target.date}-${target.url.match(/\/(\d+)\.html$/)?.[1] || parsed}-${block.index}`;

        upsert.run(
          slug,
          title,
          target.kind === 'listening' ? '四六级听力真题' : '四六级阅读真题',
          block.content,
          countWords(block.content),
          `cet${level}-${target.kind}`,
          `真题（新东方在线整理）· ${target.examKey}`,
          target.url,
          now
        );
        saved += 1;
      }
    }
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const summary = db
    .prepare("SELECT source, COUNT(*) AS n FROM passages WHERE source LIKE 'cet%' GROUP BY source")
    .all();
  db.close();

  console.log('');
  console.log(`本次写入 ${saved} 条材料，跳过 ${skipped} 个页面（引流页或无正文）。`);
  summary.forEach((row) => console.log(`  ${row.source}: ${row.n} 条`));
  console.log('');
  console.log('版权提示：四六级真题著作权归考试主办方，请仅作个人学习使用。');
}

main().catch((error) => {
  console.error('导入失败：', error);
  process.exit(1);
});
