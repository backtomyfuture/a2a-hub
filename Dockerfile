FROM node:24-slim

WORKDIR /app

# 零外部 npm 依赖，直接复制源码与协议 Skill 资源即可运行。
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY skills ./skills
COPY schema ./schema
COPY config ./config

ENV AH_HOME=/data \
    PORT=8787 \
    NODE_ENV=production

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# 容器首次启动若未设 AH_API_TOKEN，将自动生成高强度随机密钥并写入 /data/app.env（0600）。
# 推荐在云平台环境变量中显式配置 AH_API_TOKEN（以及可选 AH_PUBLIC_URL / AH_DISABLE_WEB_UI=1）。
CMD ["node", "bin/ah.mjs", "up", "--config", "/data", "--skip-skill"]
