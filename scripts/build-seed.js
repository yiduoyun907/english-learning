/**
 * 生成用于部署的干净种子数据库。
 *
 * 为什么需要它：data/app.db 既是本地开发库、又要作为容器首次启动的数据源，
 * 若直接打包，本地注册的账号、学习记录会被带上线。这个脚本从开发库复制一份，
 * 清空全部用户数据后另存为 data/seed.db，部署时只用后者。
 *
 * 用法：npm run build:seed
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { config, projectRoot } from '../src/config.js';
import { openDatabase } from '../src/db.js';

const sourcePath = config.dbPath;
const outputPath = resolve(projectRoot, process.env.SEED_OUTPUT || 'data/seed.db');

if (!existsSync(sourcePath)) {
  console.error(`找不到开发库：${sourcePath}`);
  console.error('请先执行 npm run import:ecdict 导入词库。');
  process.exit(1);
}

// 先打开一次，确保 schema 与内置短文、词形索引都是最新的
const source = openDatabase(sourcePath);
const stats = {
  words: source.prepare('SELECT COUNT(*) AS n FROM words').get().n,
  books: source.prepare('SELECT COUNT(*) AS n FROM wordbooks').get().n,
  passages: source.prepare('SELECT COUNT(*) AS n FROM passages').get().n,
  forms: source.prepare('SELECT COUNT(*) AS n FROM word_forms').get().n,
  users: source.prepare('SELECT COUNT(*) AS n FROM users').get().n,
};
source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
source.close();

console.log('开发库统计：');
console.log(`  词条 ${stats.words} · 词书 ${stats.books} · 文章 ${stats.passages} · 词形索引 ${stats.forms}`);
console.log(`  将被剔除的用户账号：${stats.users} 个`);

// 复制一份再清理，避免动到开发库本身
if (existsSync(outputPath)) rmSync(outputPath);
copyFileSync(sourcePath, outputPath);

const seed = new DatabaseSync(outputPath);
// users 的级联会一并清掉 sessions / settings / user_words / review_logs / user_passages
seed.exec('DELETE FROM users');
seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');

const leftoverUsers = seed.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const leftoverProgress = seed.prepare('SELECT COUNT(*) AS n FROM user_words').get().n;
seed.close();

if (leftoverUsers !== 0 || leftoverProgress !== 0) {
  console.error('清理未彻底，种子库中仍有用户数据，已中止。');
  process.exit(1);
}

console.log('');
console.log(`种子库已生成：${outputPath}`);
console.log('其中不含任何用户数据，可直接用于部署。');
