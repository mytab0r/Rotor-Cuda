# syntax=docker/dockerfile:1
FROM rust:1-slim-bookworm AS build
WORKDIR /src
# The coordinator client uses native-tls (OpenSSL on Linux).
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY web ./web
RUN cargo build --release --bin rotor-coord

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home rotor \
    && mkdir -p /data && chown rotor:rotor /data
COPY --from=build /src/target/release/rotor-coord /usr/local/bin/rotor-coord
USER rotor
VOLUME ["/data"]
EXPOSE 7878
ENTRYPOINT ["rotor-coord"]
CMD ["--bind", "0.0.0.0:7878", "--state", "/data/coordinator.json"]
