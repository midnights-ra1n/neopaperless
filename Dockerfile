# Build stage runs on the host arch: its output (dist + pure-JS deps) is the same for every platform.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-fra \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/server server
ENV NODE_ENV=production DATA_DIR=/data PORT=3001
VOLUME /data
EXPOSE 3001
USER node
HEALTHCHECK CMD node -e "fetch('http://localhost:3001/api/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
