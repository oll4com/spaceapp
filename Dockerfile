FROM runtime-base

# Install dependencies for core service
RUN npm install --only=production
COPY . /app/deploy/docker/core

# Build core service
RUN npm run build

# Install dependencies for CLI service
RUN npm install --only=production
COPY . /app/deploy/docker/cli

# Build CLI service
RUN npm run build

# Install dependencies for browser service
RUN npm install --only=production
COPY . /app/deploy/docker/browser

# Build browser service
RUN npm run build
