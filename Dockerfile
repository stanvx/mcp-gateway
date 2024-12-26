# Use official Node.js Alpine image as base
FROM node:22-alpine
# Copy uv files
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install Python and pytz
RUN apk add --no-cache python3 openssl libffi py3-pip

# Install playwright
RUN npx playwright install

# Install Chromium browser
RUN npx playwright install chromium

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
