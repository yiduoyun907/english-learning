import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 提供 public/ 下的静态文件。
 * 命中并已响应返回 true；未命中（不存在或路径非法）返回 false，由上层决定 404。
 */
export async function serveStatic(req, res, pathname, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (relativePath === '/' || relativePath === '') relativePath = '/index.html';

  // 拼成绝对路径后再校验是否仍位于 publicDir 之内，防止 ../ 目录穿越
  const filePath = resolve(publicDir, `.${relativePath}`);
  if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) return false;

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const extension = extname(filePath).toLowerCase();
  const isHtml = extension === '.html';

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': info.size,
    // HTML 不缓存以便迭代，其余静态资源短缓存
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  createReadStream(filePath).pipe(res);
  return true;
}
