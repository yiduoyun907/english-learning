import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PASSAGES } from './content/passages.js';
import { localStamp } from './time.js';

/** 预置词书：(code, 名称, 说明, 对应 ECDICT tag) */
export const WORD_BOOKS = [
  { code: 'cet4', name: '四级核心词汇', description: '大学英语四级考试大纲词汇', tag: 'cet4' },
  { code: 'cet6', name: '六级核心词汇', description: '大学英语六级考试大纲词汇', tag: 'cet6' },
  { code: 'ky', name: '考研词汇', description: '硕士研究生入学考试大纲词汇', tag: 'ky' },
  { code: 'ielts', name: '雅思词汇', description: 'IELTS 考试核心词汇', tag: 'ielts' },
  { code: 'toefl', name: '托福词汇', description: 'TOEFL 考试核心词汇', tag: 'toefl' },
  { code: 'gre', name: 'GRE 词汇', description: 'GRE 考试核心词汇', tag: 'gre' },
  { code: 'oxford', name: '牛津核心 3000', description: 'Oxford 3000 高频核心词', tag: null },
];

/** 打开（必要时创建）数据库，并确保 schema 与预置数据就绪 */
export function openDatabase(dbPath, { seed = true, seedDbPath = null } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  initSchema(db);
  ensureAddedColumns(db);
  seedWordBooks(db);
  // 抓取脚本要传 seed: false —— seedPassages 会拿上一次导出的旧 JSON
  // 覆盖刚抓进库的新内容，两个抓取脚本还会互相覆盖
  if (seed) seedPassages(db);
  ensureWordForms(db);
  // 词表增强数据（精简释义、图标）不随 seedPassages 走，得单独同步
  if (seed) syncWordEnrichment(db, seedDbPath);
  return db;
}

/**
 * 把种子库里的词表增强数据（translation_brief、icon）补进当前库。
 *
 * words 表只在「卷为空、首次启动」时从种子库整体复制，而已有部署的卷不会重新
 * 初始化 —— 后加的这两列会一直是空的，线上看到的还是旧释义、没有图标。
 * 这里补上：只在本库确实缺数据时跑一遍，之后每次启动只是一次 COUNT 判断。
 * 失败不阻断启动 —— 少个图标总比服务起不来强。
 */
function syncWordEnrichment(db, seedDbPath) {
  if (!seedDbPath || !existsSync(seedDbPath)) return;

  const missing = db
    .prepare('SELECT COUNT(*) AS n FROM words WHERE translation_brief IS NULL')
    .get().n;
  if (missing === 0) return;

  let seed = null;
  try {
    seed = new DatabaseSync(seedDbPath, { readOnly: true });
    const rows = seed
      .prepare('SELECT headword, translation_brief, icon FROM words WHERE translation_brief IS NOT NULL')
      .all();

    const update = db.prepare(
      `UPDATE words SET translation_brief = ?, icon = ?
        WHERE headword = ? AND translation_brief IS NULL`
    );

    db.exec('BEGIN');
    for (const row of rows) {
      update.run(row.translation_brief, row.icon ?? null, row.headword);
    }
    db.exec('COMMIT');

    console.log(`已从种子库补入词表增强数据：${rows.length} 条`);
  } catch (error) {
    console.warn('词表增强数据同步失败（不影响启动）：', error.message);
  } finally {
    seed?.close();
  }
}

/**
 * schema 迁移：给已存在的表补上后来新增的列。
 * CREATE TABLE IF NOT EXISTS 不会改动已存在的表，因此线上卷里的老库需要这一步。
 */
function ensureAddedColumns(db) {
  addColumnIfMissing(db, 'passages', 'source', "TEXT NOT NULL DEFAULT 'original'");
  addColumnIfMissing(db, 'passages', 'attribution', 'TEXT');
  addColumnIfMissing(db, 'passages', 'source_url', 'TEXT');
  addColumnIfMissing(db, 'passages', 'genre', 'TEXT');

  // 单词内容增强：精简释义与 emoji 图标。数据由 build-brief-translations /
  // build-word-icons 生成，线上老库靠 syncWordEnrichment 从种子库补入，
  // 但列本身必须先在这里建出来。
  addColumnIfMissing(db, 'words', 'translation_brief', 'TEXT');
  addColumnIfMissing(db, 'words', 'icon', 'TEXT');

  addColumnIfMissing(db, 'settings', 'review_limit', 'INTEGER NOT NULL DEFAULT 100');

  addColumnIfMissing(db, 'quiz_results', 'scope', "TEXT NOT NULL DEFAULT 'daily'");

  // 学习助教：Dify 侧的会话 ID。每个用户维持一条持续会话，
  // 所以放在 settings 上，而不是单独开表。
  addColumnIfMissing(db, 'settings', 'tutor_conversation_id', 'TEXT');
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
  );
  if (!columns.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * 写入内置材料，两类来源一并处理：
 *   - 本站原创短文（src/content/passages.js）
 *   - 外部公共素材（src/content/voa-passages.json，由 scripts/export-passages.js 固化）
 * 以 slug 为唯一键，已存在则更新内容，因此改文章或重新导出后重启即可生效。
 */
function seedPassages(db) {
  const upsert = db.prepare(
    `INSERT INTO passages
       (slug, title, title_zh, level, topic, content, word_count, source, genre, attribution, source_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title       = excluded.title,
       title_zh    = excluded.title_zh,
       level       = excluded.level,
       topic       = excluded.topic,
       content     = excluded.content,
       word_count  = excluded.word_count,
       genre       = excluded.genre,
       attribution = excluded.attribution,
       source_url  = excluded.source_url`
  );

  const now = localStamp();

  for (const passage of PASSAGES) {
    upsert.run(
      passage.slug,
      passage.title,
      passage.titleZh,
      passage.level,
      passage.topic,
      passage.content,
      countWords(passage.content),
      'original',
      null,
      null,
      null,
      now
    );
  }

  for (const passage of loadExternalPassages()) {
    upsert.run(
      passage.slug,
      passage.title,
      null,
      passage.level || 'intermediate',
      passage.topic,
      passage.content,
      countWords(passage.content),
      passage.source || 'voa',
      passage.genre || null,
      passage.attribution,
      passage.sourceUrl,
      now
    );
  }
}

/** 读取随代码分发的外部素材（VOA、四六级真题等）；文件缺失时静默跳过，不影响启动 */
function loadExternalPassages() {
  try {
    const raw = readFileSync(new URL('./content/external-passages.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * 建立「变形 → 原形」索引。
 * ECDICT 的 exchange 字段形如 `p:was/3:is/d:been/i:being`，
 * 据此可以把文章里的变形词（was、does、running）映射回词库中的原形。
 * 幂等：已有数据时直接跳过，因此线上卷里的老数据库会在首次启动时自动补齐。
 */
function ensureWordForms(db) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM word_forms').get().n;
  if (existing > 0) return;

  const rows = db
    .prepare("SELECT id, exchange FROM words WHERE exchange IS NOT NULL AND exchange <> ''")
    .all();
  if (rows.length === 0) return;

  const insert = db.prepare('INSERT OR IGNORE INTO word_forms (form, word_id) VALUES (?, ?)');

  db.exec('BEGIN');
  for (const row of rows) {
    for (const form of parseForms(row.exchange)) {
      insert.run(form, row.id);
    }
  }
  db.exec('COMMIT');
}

/** 从 exchange 字符串解析出词形，跳过原型标记与词组 */
function parseForms(exchange) {
  const forms = [];
  for (const segment of exchange.split('/')) {
    const separator = segment.indexOf(':');
    if (separator === -1) continue;

    const type = segment.slice(0, separator);
    const value = segment.slice(separator + 1).trim();

    // 0 表示原型、1 是类型标记，都不作为变形索引
    if (type === '0' || type === '1') continue;
    if (!value || value.includes(' ')) continue;

    forms.push(value.toLowerCase());
  }
  return forms;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      salt          TEXT    NOT NULL,
      created_at    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT    NOT NULL,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS settings (
      user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      daily_new_limit INTEGER NOT NULL DEFAULT 20,
      review_limit    INTEGER NOT NULL DEFAULT 100,
      accent          TEXT    NOT NULL DEFAULT 'us',
      theme           TEXT    NOT NULL DEFAULT 'light',
      active_book     TEXT
    );

    -- 共享词典：由 ECDICT 导入，所有用户公用
    CREATE TABLE IF NOT EXISTS words (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      headword       TEXT    NOT NULL UNIQUE,
      phonetic       TEXT,
      translation_zh TEXT,
      definition_en  TEXT,
      pos            TEXT,
      collins        INTEGER NOT NULL DEFAULT 0,
      oxford         INTEGER NOT NULL DEFAULT 0,
      bnc            INTEGER NOT NULL DEFAULT 0,
      frq            INTEGER NOT NULL DEFAULT 0,
      exchange       TEXT,
      tags           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_words_bnc ON words(bnc);
    CREATE INDEX IF NOT EXISTS idx_words_frq ON words(frq);

    CREATE TABLE IF NOT EXISTS wordbooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT    NOT NULL UNIQUE,
      name        TEXT    NOT NULL,
      description TEXT,
      word_count  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS wordbook_words (
      wordbook_id INTEGER NOT NULL REFERENCES wordbooks(id) ON DELETE CASCADE,
      word_id     INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      seq         INTEGER NOT NULL,
      PRIMARY KEY (wordbook_id, word_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wbw_book_seq ON wordbook_words(wordbook_id, seq);

    -- 每个用户对每个词的学习状态（SRS 卡片）
    CREATE TABLE IF NOT EXISTS user_words (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      word_id        INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      source         TEXT    NOT NULL DEFAULT 'book',  -- book | notebook
      state          TEXT    NOT NULL DEFAULT 'new',   -- new | learning | review | relearning
      ease           REAL    NOT NULL DEFAULT 2.5,
      interval_days  REAL    NOT NULL DEFAULT 0,
      learning_step  INTEGER NOT NULL DEFAULT 0,
      reps           INTEGER NOT NULL DEFAULT 0,
      lapses         INTEGER NOT NULL DEFAULT 0,
      due_date       TEXT,
      last_review_at TEXT,
      created_at     TEXT    NOT NULL,
      UNIQUE (user_id, word_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_words_due ON user_words(user_id, due_date);
    CREATE INDEX IF NOT EXISTS idx_user_words_state ON user_words(user_id, state);

    CREATE TABLE IF NOT EXISTS review_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      word_id     INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      rating      INTEGER NOT NULL,
      elapsed_ms  INTEGER NOT NULL DEFAULT 0,
      reviewed_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_logs_user_time ON review_logs(user_id, reviewed_at);

    -- 短文与听力材料。source 区分素材来源：
    --   original  本站原创（用于阅读与听写）
    --   voa       外部公共素材（美国之音慢速英语，美国政府作品，属公有领域）
    CREATE TABLE IF NOT EXISTS passages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT    NOT NULL UNIQUE,
      title       TEXT    NOT NULL,
      title_zh    TEXT,
      level       TEXT    NOT NULL,              -- beginner | intermediate | advanced
      topic       TEXT,
      content     TEXT    NOT NULL,
      word_count  INTEGER NOT NULL DEFAULT 0,
      source      TEXT    NOT NULL DEFAULT 'original',
      genre       TEXT,                          -- fiction | poem | news | essay | exam
      attribution TEXT,                          -- 来源说明，如「VOA Special English · Words and Their Stories」
      source_url  TEXT,                          -- 原文链接
      created_at  TEXT    NOT NULL
    );

    -- 阅读模块：每用户的阅读进度
    CREATE TABLE IF NOT EXISTS user_passages (
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      passage_id   INTEGER NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
      status       TEXT    NOT NULL DEFAULT 'reading',   -- reading | completed
      lookup_count INTEGER NOT NULL DEFAULT 0,
      last_read_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (user_id, passage_id)
    );

    -- 词形索引：由 words.exchange 生成，用于阅读时点击变形词能查到原形
    CREATE TABLE IF NOT EXISTS word_forms (
      form    TEXT    PRIMARY KEY,
      word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE
    );

    -- 听力模块：每次听写尝试的结果
    CREATE TABLE IF NOT EXISTS dictation_attempts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      passage_id     INTEGER NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
      sentence_index INTEGER NOT NULL,
      accuracy       REAL    NOT NULL,
      input_text     TEXT,
      created_at     TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dictation_user_material
      ON dictation_attempts(user_id, passage_id, sentence_index);

    -- AI 对话：会话
    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scene      TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      updated_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

    -- AI 对话：消息
    CREATE TABLE IF NOT EXISTS chat_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT    NOT NULL,   -- user | assistant
      content         TEXT    NOT NULL,
      corrections     TEXT,               -- JSON 数组：语法纠错，仅 assistant 消息有
      created_at      TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, id);

    -- 学习助教：消息记录。助教的会话上下文由 Dify 侧维护，
    -- 这里存一份只是为了前端能回显历史。
    CREATE TABLE IF NOT EXISTS tutor_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT    NOT NULL,   -- user | assistant
      content    TEXT    NOT NULL,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tutor_messages_user ON tutor_messages(user_id, id);

    -- 检验成绩（拼写 / 选择）。scope 区分两类：
    --   daily   今日校验（只考当天新学的词）
    --   review  复习队列（今天之前学过的词）
    CREATE TABLE IF NOT EXISTS quiz_results (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope         TEXT    NOT NULL DEFAULT 'daily',
      total         INTEGER NOT NULL,
      correct       INTEGER NOT NULL,
      spell_total   INTEGER NOT NULL DEFAULT 0,
      spell_correct INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quiz_results_user ON quiz_results(user_id, created_at DESC);
  `);
}

/** 写入预置词书（幂等，已存在则跳过） */
function seedWordBooks(db) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO wordbooks (code, name, description) VALUES (?, ?, ?)'
  );
  for (const book of WORD_BOOKS) {
    insert.run(book.code, book.name, book.description);
  }
}
