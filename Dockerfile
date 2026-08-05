# Use Node.js LTS version as base
FROM node:20-bullseye

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
RUN echo "deb http://deb.debian.org/debian bullseye contrib" >> /etc/apt/sources.list \
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

# node:20-bullseye bundles npm 10.8.2, which does not support min-release-age
# and SILENTLY IGNORES it — no warning, no error, just unprotected resolution.
# Every Node 20 and 22 release is affected; only Node 24+ bundles npm >= 11.10.
# So upgrade npm before installing anything, then assert the window is actually
# in effect. The check turns a silent downgrade into a failed build.
RUN npm install -g npm@11.10.0 \
    && node scripts/check-npm-hardening.js

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