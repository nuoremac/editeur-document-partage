# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=@journal/api --include-workspace-root=false \
      --fetch-retries=5 --fetch-timeout=300000
WORKDIR /app/apps/api
COPY apps/api/tsconfig.json ./tsconfig.json
COPY apps/api/src ./src
COPY db/init /app/db/init
RUN npm run build && npm prune --omit=dev --workspace=@journal/api --include-workspace-root=false
EXPOSE 3000
CMD ["npm", "run", "start"]
