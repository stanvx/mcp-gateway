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

# Environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install dependencies for Puppeteer
RUN apk add --no-cache wget gnupg \
  && apk add --no-cache fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  libgtk2.0-0 libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 \
  && apk add --no-cache chromium \
  && apk clean

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

# Note: config.yaml should be mounted at runtime:
# docker run -v /path/to/your/config.yaml:/app/config.yaml ...

# Use node user (already exists in Alpine image)
USER node

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]