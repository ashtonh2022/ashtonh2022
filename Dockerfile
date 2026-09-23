# Build stage: install everything and build the client and the server bundle
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY docs ./docs
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Runtime stage: only the built server bundle and the static client
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 8080
USER node
CMD ["node", "apps/server/dist/index.js"]
