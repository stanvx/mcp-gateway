# Use official Node.js Alpine image as base
FROM node:22-alpine
# Copy uv files
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install Python and pytz
RUN apk add --no-cache python3 openssl libffi py3-pip

# Install yt-dlp
RUN set -x \
&& apk add --no-cache ca-certificates curl ffmpeg python3 \
   # Install yt-dlp
&& curl -Lo /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
&& chmod a+rx /usr/local/bin/yt-dlp \
   # Create directory to hold downloads.
&& mkdir /downloads \
&& chmod a+rw /downloads \
   # Basic check it works.
&& yt-dlp --version \
&& mkdir -p /.cache \
&& chmod 777 /.cache

# Install dependencies for Puppeteer
RUN apk upgrade --no-cache --available \
    && apk add --no-cache \
      chromium-swiftshader \
      ttf-freefont \
      font-noto-emoji \
    && apk add --no-cache \
      --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community \
      font-wqy-zenhei
RUN apk add --no-cache xvfb

# Environment variables for Puppeteer
ENV DOCKER_CONTAINER=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD 1
ENV PUPPETEER_EXECUTABLE_PATH /usr/bin/chromium-browser
ENV CHROMIUM_FLAGS="--disable-software-rasterizer --disable-dev-shm-usage"
ENV CHROME_BIN=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/lib/chromium/

ENV DISPLAY :99
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

VOLUME ["/downloads"]

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

COPY --chown=node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Use node user (already exists in Alpine image)
USER node

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]

# Note: config.yaml should be mounted at runtime:
# docker run -v /path/to/your/config.yaml:/app/config.yaml ...