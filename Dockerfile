# syntax=docker/dockerfile:1

FROM node:20-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY client ./client
COPY server ./server
COPY shared ./shared
RUN pnpm -C shared build
RUN pnpm -C server build
RUN pnpm -C client build

FROM base AS server
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/shared/dist ./shared/dist
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
EXPOSE 2567
CMD ["node", "server/dist/index.js"]

FROM nginx:alpine AS client
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80

FROM base AS allinone
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx curl \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY --from=build /app/client/public/animations /app/animations
COPY --from=build /app/client/public/config /app/config
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx.main.conf /etc/nginx/nginx.conf
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 80
CMD ["/start.sh"]
