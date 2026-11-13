FROM rust:1-slim-bookworm AS compilar
WORKDIR /fuentes
COPY nucleo ./nucleo
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/fuentes/nucleo/target \
    cargo build --release --locked --manifest-path nucleo/Cargo.toml \
    && cp nucleo/target/release/campusia-nucleo /campusia-nucleo

FROM node:22-bookworm-slim AS web
RUN npm install -g pnpm@12.18.0
WORKDIR /fuentes
COPY interfaz ./interfaz
RUN cd interfaz && pnpm install --frozen-lockfile && pnpm run build
COPY sdk ./sdk
RUN cd sdk && pnpm install --frozen-lockfile && pnpm run build
COPY plantilla-curso ./plantilla-curso
COPY pruebas/australis/imagenes/fijar-sdk.mjs /fijar-sdk.mjs
RUN cd sdk && pnpm pack --pack-destination /empaque && node /fijar-sdk.mjs /empaque /fuentes/plantilla-curso/pnpm-lock.yaml

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@12.18.0 \
 && pnpm --version && node --version && git --version
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=compilar /campusia-nucleo /usr/local/bin/campusia-nucleo
COPY --from=web /fuentes/interfaz/dist /app/interfaz/dist
COPY --from=web /fuentes/sdk /app/sdk
COPY --from=web /fuentes/plantilla-curso /app/plantilla-curso
COPY --from=web /empaque/bloqueo-sdk.json /app/bloqueo-sdk.json
ENV INTERFAZ_DIR=/app/interfaz/dist \
    PLANTILLA_CURSO_DIR=/app/plantilla-curso \
    SDK_DIR=/app/sdk \
    npm_config_store_dir=/pnpm-store
WORKDIR /app
ENTRYPOINT ["campusia-nucleo"]
