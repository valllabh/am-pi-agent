# syntax=docker/dockerfile:1.7
# pi-agent sandbox runner. Pattern adopted from web-exposure-detection.
# Bedrock via IAM (no api key); pi-coding-agent drives the LLM.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --omit=dev=false
COPY src ./src
RUN npx tsc -b

FROM debian:bookworm-slim AS runner
ARG PI_VERSION=0.73.1
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HOME=/home/agent

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl jq unzip python3; \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    npm install -g --no-audit --no-fund --omit=dev "@mariozechner/pi-coding-agent@${PI_VERSION}"; \
    npm cache clean --force; \
    rm -rf /root/.npm /tmp/* /var/tmp/*; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /var/log/apt /var/log/dpkg.log; \
    useradd --create-home --shell /bin/bash --uid 1000 agent; \
    mkdir -p /work /home/agent/.cache /home/agent/.config /home/agent/.local; \
    chown -R agent:agent /work /home/agent; \
    node --version && pi --version && jq --version

# nuclei v3.4.7 linux/amd64 pre-staged on the host before docker build so we
# don't need network egress to GitHub releases from inside buildkit.
COPY nuclei /usr/local/bin/nuclei
RUN chmod 755 /usr/local/bin/nuclei && nuclei -version

WORKDIR /app
COPY --from=build --chown=agent:agent /app/dist ./dist
COPY --from=build --chown=agent:agent /app/node_modules ./node_modules
COPY --chown=agent:agent package.json ./

USER agent
ENTRYPOINT ["node", "dist/runner.js"]
