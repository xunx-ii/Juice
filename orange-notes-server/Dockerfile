# --- Build Stage ---
FROM rust:1.85-slim AS build

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      pkg-config \
      libsqlite3-dev \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Cache dependencies so container re-builds are fast when only source changes.
COPY Cargo.toml ./
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    cargo generate-lockfile && \
    cargo build --release && \
    rm -f target/release/deps/orange-notes-server* target/release/orange-notes-server*

COPY src ./src

# Force re-compile of the actual source (file mtimes changed above).
RUN touch src/main.rs && \
    cargo build --release

# --- Runtime Stage ---
FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      gosu \
      libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/src/app/target/release/orange-notes-server /usr/local/bin/orange-notes-server
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN useradd --create-home appuser && \
    mkdir /data && \
    chown appuser:appuser /data && \
    chmod +x /usr/local/bin/docker-entrypoint.sh
WORKDIR /data

ENV DATABASE_URL=/data/notes.sqlite
EXPOSE 8777

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
