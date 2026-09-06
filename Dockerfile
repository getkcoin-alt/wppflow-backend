FROM node:20-bookworm-slim

# Install Chromium, Xvfb (virtual framebuffer), and all required dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    dumb-init \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Environment setup for Puppeteer & Chromium
# DISPLAY=:99 points Chromium at the Xvfb virtual display started by entrypoint.sh
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    PORT=8080 \
    TOKEN_DIR=/app/tokens \
    NODE_ENV=production

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# entrypoint.sh: starts Xvfb then hands off to the Node process
RUN chmod +x /app/entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/entrypoint.sh"]
