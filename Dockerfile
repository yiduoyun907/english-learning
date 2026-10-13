# 零 npm 依赖，因此无需 npm install 步骤，镜像构建极快
FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DB_PATH=/data/app.db \
    SEED_DB_PATH=/app/seed.db

# 仅复制运行所需内容（见 .dockerignore）
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# 种子库由 npm run build:seed 生成，只含词库与文章，不含任何用户数据
COPY data/seed.db ./seed.db

# 数据库落在挂载卷上；容器首次启动时会从内置种子库初始化。
# 挂载点由部署平台侧配置（Railway: Volumes 挂载到 /data），此处不声明 VOLUME 以免歧义。

EXPOSE 3000

# --use-system-ca 让 Node 采用系统证书链：本机网络带中间人代理证书，
# 不加这个参数时调用外部 API 会报 SELF_SIGNED_CERT_IN_CHAIN
CMD ["node", "--use-system-ca", "server.js"]
