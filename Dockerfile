# Node.js 24 LTS, pinned to the exact patch that ships the October 21, 2026
# security fixes (CVE-2026-111497 Brotli OOB write, CVE-2026-106069 /
# CVE-2026-105483 / CVE-2026-106072 TLS hostname-check bypasses,
# CVE-2026-105482 dns.resolve NUL truncation, CVE-2026-106074 snapshot RNG).
# Node 20 reached end-of-life on 2026-04-30 and no longer receives security
# releases. Bump this tag (never a floating major) when a new advisory lands:
# https://nodejs.org/en/blog/vulnerability/
FROM node:24.22.1-bookworm

# Install required dependencies for node-canvas and FFmpeg
RUN apt-get update && apt-get install -y \
    build-essential \
    libvips-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ffmpeg \
    fontconfig \
    fonts-liberation \
    fonts-roboto \
    && rm -rf /var/lib/apt/lists/*

# Install Microsoft Core Fonts (includes Impact)
# Need to enable contrib repository for ttf-mscorefonts-installer
RUN echo "deb http://deb.debian.org/debian bookworm contrib" >> /etc/apt/sources.list \
    && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
    && apt-get update \
    && apt-get install -y --no-install-recommends ttf-mscorefonts-installer \
    && fc-cache -f -v \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files. .npmrc must come along BEFORE npm ci — it carries the
# min-release-age quarantine window, and without it the image build would
# resolve dependencies with no protection against a freshly-published
# compromised version (the Shai-Hulud npm worm delivery path).
COPY package*.json .npmrc ./
COPY scripts/check-npm-hardening.js ./scripts/

# node:24.22.1 bundles npm 11.19.1, which honors min-release-age (needs npm
# >= 11.10). Node 20/22 images bundle npm 10.x and SILENTLY IGNORE it, so if
# the base image is ever moved back, the global npm upgrade must return too.
# Assert the quarantine window is actually in effect before installing: the
# check turns a silent downgrade into a failed build.
RUN node scripts/check-npm-hardening.js

# Install dependencies
RUN npm ci --legacy-peer-deps

# Copy rest of the application
COPY . .

# Make sure the tmp directory exists and has correct permissions
RUN mkdir -p /tmp/video-gen && chmod 777 /tmp/video-gen

# Create and set permissions for dbs directory (from your prebuild script)
RUN mkdir -p dbs && chmod 755 dbs

# Create logs directory for nostr bot zap-receipt dumps (kind 9734/9735).
# Logger creates this on demand too, but pre-creating keeps perms predictable.
RUN mkdir -p logs/nostr-bot && chmod 755 logs logs/nostr-bot

# Create RAM disk mount point
RUN mkdir -p /dev/shm/frames && chmod 777 /dev/shm/frames

# Add environment variable
ENV FRAMES_DIR=/dev/shm/frames

# Expose the port your app runs on
EXPOSE 4131

# Start the application
CMD ["node", "server.js"]