FROM node:23-alpine

# Copy uv files
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    py3-pip \
    openssl \
    libffi \
    ca-certificates \
    curl \
    ffmpeg \
    tini \
    xvfb \
    coreutils \
    # Chrome dependencies
    chromium-swiftshader \
    ttf-freefont \
    font-noto-emoji \
    && apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community \
    font-wqy-zenhei

# Install yt-dlp
RUN curl -Lo /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && mkdir -p /downloads /.cache \
    && chmod 777 /.cache \
    && chmod a+rw /downloads

# Set environment variables
ENV DOCKER_CONTAINER=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CHROMIUM_FLAGS="--disable-software-rasterizer --disable-dev-shm-usage" \
    CHROME_BIN=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/lib/chromium/ \
    DISPLAY=:99 \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

VOLUME ["/downloads"]
WORKDIR /app

# Install dependencies first to cache them
COPY package*.json ./
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY --chown=node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER node
EXPOSE 3000

ENTRYPOINT ["tini", "--", "/app/docker-entrypoint.sh"]
CMD ["npm", "start"]