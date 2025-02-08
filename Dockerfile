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
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy rest of the application
COPY . .

# Make sure the tmp directory exists and has correct permissions
RUN mkdir -p /tmp/video-gen && chmod 777 /tmp/video-gen

# Create and set permissions for dbs directory (from your prebuild script)
RUN mkdir -p dbs && chmod 755 dbs

# Create RAM disk mount point
RUN mkdir -p /dev/shm/frames && chmod 777 /dev/shm/frames

# Add environment variable
ENV FRAMES_DIR=/dev/shm/frames

# Expose the port your app runs on
EXPOSE 4131

# Start the application
CMD ["node", "server.js"]