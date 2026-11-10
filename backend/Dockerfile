# syntax=docker/dockerfile:1
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --bin hackai-server \
    && cp target/release/hackai-server /hackai-server

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 hackai && mkdir /data && chown hackai /data
COPY --from=build /hackai-server /usr/local/bin/hackai-server
USER hackai
ENV DATABASE_URL=sqlite:///data/hackai.db \
    BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info,sqlx=warn
EXPOSE 8080
VOLUME /data
CMD ["hackai-server"]
