import { fileURLToPath } from 'node:url';
import { join, resolve, isAbsolute } from 'node:path';

/** 项目根目录（src/ 的上一级） */
export const projectRoot = fileURLToPath(new URL('..', import.meta.url));

// DB_PATH 可能是绝对路径（容器里挂载卷通常为 /data/app.db），
// 也可能是相对路径（本地开发），需要区别对待。
const rawDbPath = process.env.DB_PATH || 'data/app.db';

/**
 * 集中读取环境变量。其余模块一律从这里取值，不得直接访问 process.env，
 * 以免凭证散落在代码各处。
 */
export const config = {
  port: Number(process.env.PORT) || 3000,
  dbPath: isAbsolute(rawDbPath) ? rawDbPath : resolve(projectRoot, rawDbPath),
  /**
   * 可选的种子数据库路径。容器首次启动、挂载卷为空时，会用它初始化数据，
   * 避免线上重新解析 200MB 的词库 CSV。
   */
  seedDbPath: process.env.SEED_DB_PATH
    ? isAbsolute(process.env.SEED_DB_PATH)
      ? process.env.SEED_DB_PATH
      : resolve(projectRoot, process.env.SEED_DB_PATH)
    : null,
  // 前端由 Vite 构建到 dist/，运行阶段只服务产物目录
  publicDir: join(projectRoot, 'dist'),
  /** session 有效期：30 天 */
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  isProduction: process.env.NODE_ENV === 'production',
  /** 每日新词默认上限，用户可在设置中覆盖 */
  defaultDailyNewLimit: 20,

  /**
   * AI 对话所用的模型端点。走 Anthropic Messages API 格式，
   * 实际模型由 ANTHROPIC_BASE_URL 指向的端点决定，因此这里不写死供应商。
   * 凭证只在此处读取，代码其余部分不得直接访问 process.env，更不得写入日志。
   */
  llm: {
    baseUrl: (process.env.ANTHROPIC_BASE_URL || '').replace(/\/$/, ''),
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
    model: normalizeModelName(
      process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ),
    timeoutMs: 60_000,
  },

  /**
   * 学习助教所用的 Dify 应用。走 Dify 的 Service API，与 llm 是两套独立凭证
   * （llm 是文本模型端点，这里是 Dify 托管的 Agent）。同样只在此处读取。
   */
  dify: {
    baseUrl: (process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1').replace(/\/$/, ''),
    apiKey: process.env.DIFY_API_KEY || '',
    /** Dify 侧的 Agent 可能要跑多轮工具调用，超时给得比对话模块宽 */
    timeoutMs: 90_000,
  },
};

/**
 * 环境里的模型名可能带运行环境的专用后缀（如 deepseek-flash[1m]），
 * 而接口只认基础名，这里统一清理。
 */
function normalizeModelName(raw) {
  const cleaned = String(raw || '')
    .replace(/\[[^\]]*\]$/, '')
    .trim();
  return cleaned || 'deepseek-flash';
}
