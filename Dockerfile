# Playwright base image ships Chromium + all OS deps preinstalled.
# Keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci

# Build the TypeScript.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies to slim the runtime image.
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "dist/index.js"]
