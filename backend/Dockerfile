# syntax=docker/dockerfile:1
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --bin australis-server \
    && cp target/release/australis-server /australis-server

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 australis && mkdir /data && chown australis /data
COPY --from=build /australis-server /usr/local/bin/australis-server
USER australis
ENV DATABASE_URL=sqlite:///data/australis.db \
    BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info,sqlx=warn
EXPOSE 8080
VOLUME /data
CMD ["australis-server"]
