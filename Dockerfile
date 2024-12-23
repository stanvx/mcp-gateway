# Use official Node.js Alpine image as base
FROM node:20-alpine

# Install Python and pytz for MCP time server
RUN apk add --no-cache \
    python3 \
    py3-pip \
    py3-pytz \
    openssl \
    libffi \
    build-base

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
