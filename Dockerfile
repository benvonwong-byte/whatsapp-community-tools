FROM node:20-slim

# Install Chromium and dependencies for whatsapp-web.js
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Use system Chromium instead of bundled one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Copy frontend
COPY public/ ./public/

# Mount point for persistent volume (SQLite DB + WhatsApp session)
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "dist/index.js"]
