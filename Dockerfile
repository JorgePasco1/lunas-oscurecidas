# Playwright base image ships Chromium + all OS deps preinstalled.
# Keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Enable pnpm via corepack (bundled with Node in the base image).
RUN corepack enable

# Install deps first for better layer caching.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Build the TypeScript.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Drop dev dependencies to slim the runtime image.
RUN pnpm prune --prod

ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "dist/index.js"]
