# syntax=docker/dockerfile:1
ARG FRONTEND_SOURCE=build
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmjs.org
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM scratch AS prebuilt
COPY dist /app/dist

FROM ${FRONTEND_SOURCE} AS frontend

# Frontend dependencies are compiled into dist; only the DAV bridge runs in Node.
FROM --platform=$BUILDPLATFORM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e "const fs=require('fs');const p=require('./package.json');const l=require('./package-lock.json');p.dependencies=Object.fromEntries(['webdav','fast-xml-parser'].map(k=>[k,p.dependencies[k]]));delete p.devDependencies;delete p.scripts;l.packages[''].dependencies=p.dependencies;delete l.packages[''].devDependencies;fs.writeFileSync('package.json',JSON.stringify(p));fs.writeFileSync('package-lock.json',JSON.stringify(l));" \
    && npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org \
    && npm prune --omit=dev --ignore-scripts --registry=https://registry.npmjs.org

FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/shiranzby/Writide" \
      org.opencontainers.image.title="Writide" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=5173 WRITIDE_DATA_DIR=/data WRITIDE_CACHE_DIR=/data/image-cache
WORKDIR /app
COPY --from=dependencies /app/package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=frontend /app/dist ./dist
COPY server.mjs ./
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5173/api/health',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
