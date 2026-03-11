FROM node:20-slim

# Playwright system dependencies for Chromium + Xvfb for headed mode
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libwayland-client0 \
    fonts-liberation fonts-noto-color-emoji \
    ca-certificates \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

# Install Chromium browser binary
RUN npx playwright install chromium

COPY . .

# Cookie persistence directory
RUN mkdir -p .profiles

EXPOSE 3000

# Start Xvfb virtual display, then run the server
# Xvfb provides a display so Chromium runs in headed mode (bypasses Cloudflare Turnstile)
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &  sleep 1 && DISPLAY=:99 node server.js"]
