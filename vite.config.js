import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(projectRoot, 'frontend');

/** 多页应用：frontend/ 下每个 HTML 都是独立入口，保留现有 .html URL */
const pageInputs = Object.fromEntries(
  readdirSync(frontendDir)
    .filter((name) => name.endsWith('.html'))
    .map((name) => [name.replace(/\.html$/, ''), resolve(frontendDir, name)])
);

export default {
  root: frontendDir,
  // public/ 只放需要原样复制的静态资源（目前是 tutor-orb.png）
  publicDir: resolve(projectRoot, 'public'),
  plugins: [vue()],
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: pageInputs,
    },
  },
  server: {
    // 开发时前端走 Vite，接口与 SSE 代理到 Node 服务
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
};
