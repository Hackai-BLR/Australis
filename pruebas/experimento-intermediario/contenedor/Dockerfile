FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@2.1.322 \
 && npm cache clean --force \
 && rm -rf /root/.npm /root/.claude /root/.claude.json

ENV DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    HOME=/tmp

RUN git config --system --add safe.directory '*'

WORKDIR /tmp
CMD ["claude", "--version"]
