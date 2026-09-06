# Matches the official wppconnect/wppconnect-server Dockerfile environment exactly.
# Alpine Linux + Chromium from apk — no Xvfb, no display server needed.
# See: https://github.com/wppconnect-team/wppconnect-server/blob/main/Dockerfile

FROM node:20-alpine

WORKDIR /app

# Install Chromium and ALL required native libraries (mirrors the official WPPConnect image).
# Alpine's Chromium package runs headlessly without a display server.
RUN apk update && apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    dumb-init \
    && rm -rf /var/cache/apk/*

# Tell Puppeteer to use the system Chromium, skip its own download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PORT=8080 \
    TOKEN_DIR=/app/tokens \
    NODE_ENV=production

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

EXPOSE 8080

# dumb-init ensures signals are forwarded to Node correctly (PID 1 problem)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/server.js"]
