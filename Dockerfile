# JATA Qi — Production Docker Image
# Multi-stage build: compile TypeScript, then run on slim Node.js

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY tsconfig.base.json ./
COPY scripts/ ./scripts/
RUN npm ci --ignore-scripts
RUN bash scripts/build-all.sh

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV LOG_LEVEL=info
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY --from=builder /app/packages/*/dist ./packages/*/dist
COPY provenance/ ./provenance/
COPY .env.example ./.env.example
RUN npm ci --omit=dev --ignore-scripts
EXPOSE 7400
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7400/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/cli/dist/src/index.js", "serve"]
