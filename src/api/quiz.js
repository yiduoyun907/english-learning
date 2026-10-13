import { requireUser, getSettings } from '../context.js';
import { startOfToday, localStamp } from '../time.js';
import { readJsonBody, sendOk, httpError } from '../http.js';

/** 单次检验的题量上限，超出的从今日词里随机抽样 */
const MAX_QUESTIONS = 30;
/** 选择题的选项个数（1 个正确 + 3 个干扰） */
const CHOICE_OPTIONS = 4;

/**
 * 复习队列的取词条件：今天之前学过（reps > 0）且有中文释义的词。
 * 出题与首页的状态查询共用这一段，避免两处条件漂移。
 */
const REVIEW_CONDITIONS = `
  uw.user_id = ?
    AND uw.created_at < ?
    AND uw.reps > 0
    AND length(w.translation_zh) > 0
`;

/** 学习后的检验：今日校验（只考新词）与复习队列（考旧词） */
export function registerQuizRoutes(router, { db }) {
  // 今日校验：只考「今天新加入学习」的词，范围与今天的学习严格一致。
  // 题目里带答案，由前端即时判定。
  router.get('/api/quiz/daily', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const today = startOfToday();

    // reps > 0 才算「真的学过」—— 仅从词典加进生词本、从未在队列里学过的词
    // (reps = 0) 不算，否则会考出用户没学过的词
    const todayWords = db
      .prepare(
        `SELECT w.id AS wordId, w.headword AS headword, w.phonetic AS phonetic,
                w.translation_zh AS translation
           FROM user_words uw
           JOIN words w ON w.id = uw.word_id
          WHERE uw.user_id = ?
            AND uw.created_at >= ?
            AND uw.reps > 0
            AND length(w.translation_zh) > 0
          ORDER BY uw.id`
      )
      .all(user.id, today);

    if (todayWords.length === 0) {
      return sendOk(res, {
        questions: [],
        reviewUnlocked: hasDoneDaily(db, user.id, today),
        reason: '今天还没有学新词，先去学几个吧',
      });
    }

    const picked = shuffle(todayWords).slice(0, MAX_QUESTIONS);
    const questions = buildQuestions(db, user, picked);

    sendOk(res, {
      questions,
      reviewUnlocked: hasDoneDaily(db, user.id, today),
      counts: summarize(questions),
    });
  });

  // 复习入口状态：供首页展示「是否已解锁 / 有多少词可复习」。
  // 只做计数，不出题 —— 首页每次加载都跑一遍干扰项计算太浪费。
  router.get('/api/quiz/review/status', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const today = startOfToday();

    const poolSize = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM user_words uw
           JOIN words w ON w.id = uw.word_id
          WHERE ${REVIEW_CONDITIONS}`
      )
      .get(user.id, today).n;

    sendOk(res, {
      unlocked: hasDoneDaily(db, user.id, today),
      poolSize,
    });
  });

  // 复习队列：考「今天之前学过」的词。
  // 必须先完成今日校验，否则 403 —— 这是真拦截，不只是界面上藏按钮。
  //
  // 用 POST 而非 GET，是因为要带上 exclude（本会话已经复习过的词），
  // 好让一轮做完之后的下一轮不再重复考它们，一轮轮把已学词覆盖完。
  router.post('/api/quiz/review', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const today = startOfToday();
    const body = await readJsonBody(req);

    if (!hasDoneDaily(db, user.id, today)) {
      throw httpError(403, 'DAILY_QUIZ_REQUIRED', '请先完成今日校验，再来复习');
    }

    const excluded = new Set(
      Array.isArray(body.exclude) ? body.exclude.map(Number).filter(Number.isInteger) : []
    );

    const settings = getSettings(db, user.id);
    const reviewLimit = Math.min(Math.max(settings.reviewLimit, 10), 500);

    const pool = db
      .prepare(
        `SELECT w.id AS wordId, w.headword AS headword, w.phonetic AS phonetic,
                w.translation_zh AS translation, uw.created_at AS learnedAt
           FROM user_words uw
           JOIN words w ON w.id = uw.word_id
          WHERE ${REVIEW_CONDITIONS}`
      )
      .all(user.id, today);

    if (pool.length === 0) {
      return sendOk(res, {
        questions: [],
        poolSize: 0,
        remaining: 0,
        reason: '暂无可复习的旧词',
      });
    }

    const candidates = pool.filter((row) => !excluded.has(row.wordId));

    // 池子里的词都复习过了 —— 前端据此清空记录、从头开启新一轮
    if (candidates.length === 0) {
      return sendOk(res, {
        questions: [],
        poolSize: pool.length,
        remaining: 0,
        reason: '已覆盖全部已学词',
      });
    }

    // 词少时全过一遍；词多时按学习时间加权抽取，越早学的越少出现
    const picked =
      candidates.length <= reviewLimit
        ? candidates
        : weightedSample(candidates, reviewLimit);

    const questions = buildQuestions(db, user, shuffle(picked));

    sendOk(res, {
      questions,
      counts: summarize(questions),
      poolSize: pool.length,
      remaining: candidates.length,
    });
  });

  router.post('/api/quiz/result', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const body = await readJsonBody(req);

    // 非法 scope 直接拒绝 —— 静默按 daily 处理会把复习成绩记成校验成绩
    if (body.scope !== undefined && body.scope !== 'daily' && body.scope !== 'review') {
      throw httpError(400, 'INVALID_SCOPE', 'scope 只能是 daily 或 review');
    }
    const scope = body.scope === 'review' ? 'review' : 'daily';
    const total = Number(body.total);
    const correct = Number(body.correct);
    const spellTotal = Number(body.spellTotal) || 0;
    const spellCorrect = Number(body.spellCorrect) || 0;
    const maxTotal = scope === 'review' ? 500 : MAX_QUESTIONS;

    if (!Number.isInteger(total) || total <= 0 || total > maxTotal) {
      throw httpError(400, 'INVALID_RESULT', '题量无效');
    }
    if (!Number.isInteger(correct) || correct < 0 || correct > total) {
      throw httpError(400, 'INVALID_RESULT', '得分无效');
    }

    db.prepare(
      `INSERT INTO quiz_results (user_id, scope, total, correct, spell_total, spell_correct, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(user.id, scope, total, correct, spellTotal, spellCorrect, localStamp());

    sendOk(res, { scope, total, correct });
  });

  // 检验历史，供统计页展示趋势
  router.get('/api/quiz/history', async (req, res, ctx) => {
    const user = requireUser(ctx);

    const rows = db
      .prepare(
        `SELECT scope, total, correct, spell_total AS spellTotal, spell_correct AS spellCorrect,
                created_at AS createdAt
           FROM quiz_results
          WHERE user_id = ?
          ORDER BY id DESC
          LIMIT 20`
      )
      .all(user.id);

    sendOk(res, {
      results: rows.map((row) => ({
        ...row,
        accuracy: row.total > 0 ? Math.round((row.correct / row.total) * 100) : null,
      })),
    });
  });
}

/** 当天是否已提交过今日校验的成绩 */
function hasDoneDaily(db, userId, today) {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM quiz_results
          WHERE user_id = ? AND scope = 'daily' AND created_at >= ?`
      )
      .get(userId, today).n > 0
  );
}

function summarize(questions) {
  return {
    total: questions.length,
    spell: questions.filter((item) => item.type === 'spell').length,
    choice: questions.filter((item) => item.type === 'choice').length,
  };
}

/**
 * 加权随机抽样（轮盘赌）。
 *
 * 权重 = 1 / (1 + 已学天数 / 30)：刚学的接近 1，30 天前 0.5，90 天前 0.25。
 * 权重**始终大于 0**，所以早期词不会被彻底排除，只是出现频率变低 ——
 * 正对应「慢慢降低最早学习的单词的复习频率，偶尔插入几个」。
 */
function weightedSample(items, count) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const pool = items.map((item) => {
    const learnedAt = parseStamp(item.learnedAt);
    const ageDays = Math.max(0, (now - learnedAt) / DAY_MS);
    return { item, weight: 1 / (1 + ageDays / 30) };
  });

  const picked = [];

  while (picked.length < count && pool.length > 0) {
    const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let point = Math.random() * totalWeight;
    let index = 0;

    for (; index < pool.length - 1; index += 1) {
      point -= pool[index].weight;
      if (point <= 0) break;
    }

    picked.push(pool[index].item);
    pool.splice(index, 1);
  }

  return picked;
}

/** 把表里的本地时间字符串解析为时间戳 */
function parseStamp(stamp) {
  const parsed = new Date(String(stamp || '').replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

/**
 * 组装题目。两种题型按索引交替，最后整体打乱 ——
 * 今日词不足 4 个时无法凑齐选项，自动降级为只出拼写题。
 */
function buildQuestions(db, user, words) {
  const canChoice = words.length >= CHOICE_OPTIONS;
  const bookId = canChoice ? resolveBookId(db, user) : null;

  const questions = words.map((word, index) => {
    const base = {
      wordId: word.wordId,
      headword: word.headword,
      phonetic: word.phonetic || '',
      translation: word.translation,
    };

    const wantChoice = canChoice && index % 2 === 1;
    if (!wantChoice) {
      return { ...base, type: 'spell', answer: word.headword };
    }

    // 干扰项逐题现取，不再共用同一个候选池 ——
    // 否则同一轮里所有选择题的错误选项会一模一样，一眼就能认出答案
    const distractors = pickDistractors(db, bookId, word);
    if (distractors.length < CHOICE_OPTIONS - 1) {
      return { ...base, type: 'spell', answer: word.headword };
    }

    return {
      ...base,
      type: 'choice',
      options: shuffle([word.translation, ...distractors]),
    };
  });

  return shuffle(questions);
}

function resolveBookId(db, user) {
  const settings = getSettings(db, user.id);
  if (!settings.activeBook) return null;

  const row = db.prepare('SELECT id FROM wordbooks WHERE code = ?').get(settings.activeBook);
  return row ? row.id : null;
}

/** 拼写最多差几个字母仍算「形似」 */
const MAX_SHAPE_DISTANCE = 3;
/** 字符集合重叠度的下限，低于此值不可能是形似词（仅用于预筛，不影响判定结果） */
const MIN_CHAR_OVERLAP = 0.5;
/**
 * 候选池大小：只在拼写最近的一小批里随机。
 * 取太大（如 15）会让距离最近的词常常抽不到，干扰项就不够「形似」了。
 */
const SHAPE_POOL_SIZE = 6;

/** 同词书词表缓存：出题时会反复比对拼写，缓存在内存里以免每次扫库 */
const candidateCache = new Map();

function loadCandidates(db, bookId) {
  const key = bookId || 0;
  const cached = candidateCache.get(key);
  if (cached) return cached;

  const rows = bookId
    ? db
        .prepare(
          `SELECT w.id AS wordId, w.headword AS headword, w.translation_zh AS translation
             FROM wordbook_words wbw
             JOIN words w ON w.id = wbw.word_id
            WHERE wbw.wordbook_id = ? AND length(w.translation_zh) > 0`
        )
        .all(bookId)
    : db
        .prepare(
          `SELECT id AS wordId, headword, translation_zh AS translation
             FROM words WHERE length(translation_zh) > 0`
        )
        .all();

  candidateCache.set(key, rows);
  return rows;
}

/**
 * 为本词挑 3 个干扰项。
 *
 * 判定「容易混淆」用的是**整体拼写相近**而不是共同前缀 ——
 * hire/fire、close/clone 这类词并没有共同前缀，却最容易看错。
 * 另外把**同词根**（employ / employee / employer）视为最优先，
 * 这类词的释义相关但不同，干扰效果最好。
 *
 * 释义层面严格排除：与正确答案的释义完全相同、或共享任何中文实词的，
 * 一律不作干扰项，避免出现两个都说得通的选项。
 */
function pickDistractors(db, bookId, word) {
  const candidates = loadCandidates(db, bookId);
  const target = word.headword.toLowerCase();

  const scored = [];
  const used = new Set([word.wordId]);

  for (const candidate of candidates) {
    if (used.has(candidate.wordId)) continue;
    if (isConflicting(candidate.translation, word.translation)) continue;

    const other = candidate.headword.toLowerCase();

    // 先用字符集合做一道廉价预筛：hire/fire、close/clone 这类形似词重叠度都很高，
    // 重叠度低的直接跳过，省下对整池每个词都算编辑距离的开销
    if (charOverlap(target, other) < MIN_CHAR_OVERLAP) continue;

    const distance = shapeScore(target, other);
    if (distance > MAX_SHAPE_DISTANCE) continue;

    scored.push({ wordId: candidate.wordId, translation: candidate.translation, distance });
  }

  // 拼写越近越靠前，同分打散
  scored.sort((a, b) => a.distance - b.distance);

  const picked = [];
  for (const item of shuffle(scored.slice(0, SHAPE_POOL_SIZE))) {
    picked.push(item.translation);
    if (picked.length >= CHOICE_OPTIONS - 1) break;
  }

  // 形似词不够时，用同词书内的其它词补齐，保证单选题始终成立
  if (picked.length < CHOICE_OPTIONS - 1) {
    const takenTranslations = new Set([word.translation, ...picked]);
    const fallback = shuffle(candidates).filter(
      (candidate) =>
        !takenTranslations.has(candidate.translation) &&
        !isConflicting(candidate.translation, word.translation)
    );

    for (const candidate of fallback) {
      picked.push(candidate.translation);
      if (picked.length >= CHOICE_OPTIONS - 1) break;
    }
  }

  return picked;
}

/**
 * 相似度：越小越像。同词根记 0 分（最优先），否则用编辑距离。
 * 词根关系要求共同部分不短于 4 个字母，避免把 at / ate 这类巧合当成同根。
 */
function shapeScore(target, candidate) {
  const [shorter, longer] =
    target.length <= candidate.length ? [target, candidate] : [candidate, target];

  if (shorter.length >= 4 && longer.startsWith(shorter)) return 0;

  return editDistance(target, candidate, MAX_SHAPE_DISTANCE + 1);
}

/**
 * 两个词共有多少个不重复字母，占较长一方字符集的比例。
 * 只用来快速排除明显不像的词，真正判定仍看编辑距离。
 */
function charOverlap(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);

  let shared = 0;
  for (const char of setB) {
    if (setA.has(char)) shared += 1;
  }

  return shared / Math.max(setA.size, setB.size);
}

/** 带阈值早退的编辑距离，超过 max 直接返回 max + 1 */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const width = b.length;
  let previous = Array.from({ length: width + 1 }, (_, index) => index);
  let current = new Array(width + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= width; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < rowMin) rowMin = current[j];
    }

    if (rowMin > max) return max + 1;
    [previous, current] = [current, previous];
  }

  return previous[width];
}

/**
 * 释义是否与正确答案冲突。
 * 只要两者共享任何一个中文实词，就认为区分度不足 —— 宁可换一个干扰项，
 * 也不能让题面出现两个都讲得通的选项。
 */
function isConflicting(candidate, answer) {
  const text = String(candidate || '').trim();
  if (text === String(answer || '').trim()) return true;

  const answerWords = new Set(extractChineseWords(answer));
  if (answerWords.size === 0) return false;

  for (const word of extractChineseWords(candidate)) {
    if (answerWords.has(word)) return true;
  }
  return false;
}

/** 取出释义中的中文实词，去掉词性标记与 [领域] 标注 */
function extractChineseWords(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^[a-z]{1,6}(?:\.[a-z]{1,6})*\./i, ' ')
    .split(/[,;，；、\s]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && /[一-龥]/.test(word));
}

/** Fisher–Yates 洗牌，返回新数组 */
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
