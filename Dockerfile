FROM node:20-alpine

# Enable corepack and activate latest pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install required system utilities
RUN apk add --no-cache zip unzip bash

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy application source
COPY server.js ./

# Create required runtime directories
RUN mkdir -p /tmp/builds /tmp/uploads

# Create non-root user and set ownership
RUN addgroup -S builder && adduser -S builder -G builder \
    && chown -R builder:builder /tmp/builds /tmp/uploads /app

USER builder

EXPOSE 3000

CMD ["node", "server.js"]
