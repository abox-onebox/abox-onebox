# ---- build ----
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api-server ./apps/api-server
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter api-server build

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api-server/dist ./dist
COPY --from=builder /app/apps/api-server/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/main.js"]
