FROM node:22.12.0-bookworm-slim AS node

FROM rust:1.88.0-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev sqlite3 python3 make g++ \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g pnpm@12.18.0 \
 && node --version && pnpm --version && cargo --version
ENV CARGO_HOME=/cache/cargo CARGO_TARGET_DIR=/cache/target npm_config_store_dir=/cache/pnpm/store PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /fuentes
