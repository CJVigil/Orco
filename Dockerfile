# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
COPY integrations ./integrations
COPY LICENSE NOTICE TRADEMARKS.md README.md ./
# orco.tgz is handed to computers joining this server, so `npx <server>/install/…` runs Orco there.
RUN npm run build && npm pack --ignore-scripts && mv orco-*.tgz orco.tgz && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    ORCO_HOST=0.0.0.0 \
    ORCO_PORT=7420 \
    ORCO_DB=/data/orco.db \
    ORCO_BACKUP_DIR=/backups
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/orco.tgz ./orco.tgz
COPY package.json LICENSE NOTICE TRADEMARKS.md README.md ./
COPY web ./web
COPY integrations ./integrations
RUN mkdir -p /data /backups && chown node:node /data /backups \
 && printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/orco && chmod +x /usr/local/bin/orco
USER node
VOLUME ["/data", "/backups"]
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ORCO_PORT||7420)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["orco"]
CMD ["serve"]
