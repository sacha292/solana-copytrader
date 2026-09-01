# --- build stage -----------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so dependency install is cached across code edits.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public

# Persisted state lives on the mounted Fly volume, not in the image.
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

# Run unprivileged; the node image ships a `node` user for exactly this.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
