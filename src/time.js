/**
 * 时间口径约定：
 *  - 用于「比较先后」的时间（session 过期、卡片到期、最近复习）统一存 ISO UTC 字符串，字典序即时间序；
 *  - 用于「按天统计」的时间（注册时间、复习记录）统一存服务器本地时间字符串，
 *    SQLite 的 date() 可直接截取日期。容器部署时通过 TZ 环境变量指定时区（如 Asia/Shanghai）。
 */

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间字符串：'YYYY-MM-DD HH:MM:SS' */
export function localStamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 今天 0 点的本地时间字符串，用于「今日」口径的区间比较 */
export function startOfToday(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return localStamp(start);
}

/** 从某个本地时间字符串回推 n 天前的 0 点 */
export function daysAgoStart(days, date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - days);
  return localStamp(start);
}
