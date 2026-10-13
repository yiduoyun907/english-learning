/**
 * 端到端冒烟测试：注册 → 选词书 → 学习卡片 → 键盘操作 → 统计 → 生词本 → 设置。
 *
 * 这个脚本依赖 Playwright，不属于项目运行时依赖（项目本身零 npm 依赖）。
 * 需要先启动服务（npm start），然后在临时目录安装 Playwright 后运行：
 *
 *   mkdir -p /tmp/pwtest && cd /tmp/pwtest && npm init -y
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
 *   npx playwright install chromium
 *   node <本文件路径>
 *
 * 截图输出到系统临时目录，不污染项目。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const SHOTS = process.env.E2E_SHOTS_DIR || tmpdir();
const user = `e2e${Date.now().toString().slice(-6)}`;
const password = 'test123456';

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

const shot = (name) => join(SHOTS, `${name}.png`);
const log = (step, detail = '') => console.log(`  ${step}${detail ? ' → ' + detail : ''}`);

// 1. 注册
await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
await page.click('#tab-register');
await page.fill('#username', user);
await page.fill('#password', password);
await page.click('#submit');
await page.waitForURL('**/index.html', { timeout: 10000 });
await page.waitForLoadState('networkidle');
log('注册并跳转首页', `用户 ${user}`);
log('首页问候语', await page.textContent('#greeting'));
await page.screenshot({ path: shot('01-home'), fullPage: true });

// 2. 选择词书
await page.goto(`${BASE}/books.html`, { waitUntil: 'networkidle' });
log('词书数量', String(await page.locator('#book-list .list-item').count()));
await page.locator('#book-list .list-item').first().click();
await page.waitForTimeout(700);
log('词书已选中', (await page.textContent('#book-list')).includes('当前使用') ? '是' : '否');
await page.screenshot({ path: shot('02-books'), fullPage: true });

// 3. 学习卡片
await page.goto(`${BASE}/study.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('.word-headword', { timeout: 10000 });
log('第一个单词', await page.textContent('.word-headword'));
log('进度', await page.textContent('#progress'));

await page.click('#reveal-btn');
await page.waitForSelector('#rating-grid');
const translation = (await page.textContent('.answer-text')) || '';
log('释义片段', translation.slice(0, 26).replace(/\s+/g, ' '));
await page.screenshot({ path: shot('03-study-revealed'), fullPage: true });

await page.locator('.rating-btn[data-rating="4"]').click();
await page.waitForTimeout(600);
log('鼠标评分后进度', await page.textContent('#progress'));
log('第二个单词', await page.textContent('.word-headword'));

// 4. 键盘操作：空格显示释义、数字键评分
await page.keyboard.press('Space');
await page.waitForSelector('#rating-grid', { timeout: 5000 });
log('空格键显示释义', '成功');
await page.keyboard.press('Digit3');
await page.waitForTimeout(500);
log('数字键评分后进度', await page.textContent('#progress'));

// 5. 统计
await page.goto(`${BASE}/stats.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
log('累计已学', await page.textContent('#learned'));
log('连续打卡', await page.textContent('#streak'));
log('今日数据', await page.textContent('#today-line'));
log('30 天柱状条数', String(await page.locator('.chart-bar').count()));
await page.screenshot({ path: shot('04-stats'), fullPage: true });

// 6. 生词本检索与添加
await page.goto(`${BASE}/notebook.html`, { waitUntil: 'networkidle' });
await page.fill('#search-input', 'abandon');
await page.waitForTimeout(900);
const found = await page.locator('#search-results .list-item').count();
log('检索 abandon 命中', String(found));
if (found > 0) {
  await page.locator('#search-results .list-item button').first().click();
  await page.waitForTimeout(900);
  log('生词本计数', await page.textContent('#notebook-count'));
}
await page.screenshot({ path: shot('05-notebook'), fullPage: true });

// 7. 设置：切换深色主题并验证跨页保持
await page.goto(`${BASE}/settings.html`, { waitUntil: 'networkidle' });
await page.selectOption('#theme', 'dark');
await page.click('#save-settings');
await page.waitForTimeout(800);
log('主题属性', await page.locator('html').getAttribute('data-theme'));

await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
log('首页主题继承', await page.locator('html').getAttribute('data-theme'));
await page.screenshot({ path: shot('06-home-dark'), fullPage: true });

console.log('');
// 未登录时 /api/auth/me 返回 401 是登录态探测的预期行为，不计入异常
const realErrors = consoleErrors.filter((text) => !text.includes('401'));
console.log(realErrors.length ? `异常控制台错误 ${realErrors.length} 条：` : '无非预期控制台错误');
for (const error of realErrors) console.log('  -', error);
console.log(`截图目录：${SHOTS}`);

await browser.close();
