# Reproducible Linux build of OpenBench (x86_64): .deb, .rpm and .AppImage.
#
#   docker build -f packaging/linux/Dockerfile --output type=local,dest=dist-linux .
#
# Ubuntu 22.04 is used as the base so that the binaries run on distributions with
# glibc ≥ 2.35 (Ubuntu 22.04+, Debian 12+, Fedora 36+, …).

FROM ubuntu:22.04 AS build
ARG NODE_VERSION=24.15.0
ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:/opt/node/bin:$PATH \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    CI=true

# Tauri 2 system dependencies (https://v2.tauri.app/start/prerequisites/#linux)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates xz-utils pkg-config \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      patchelf rpm \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
      | tar -xJ -C /opt && mv /opt/node-v${NODE_VERSION}-linux-x64 /opt/node \
    && curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mcp-server/package.json apps/mcp-server/
RUN npm ci

COPY . .
# Same checks as on other platforms, then the bundles and the MCP server.
RUN npm run lint && npm run typecheck && npm test && npm run test:rust
RUN npm run tauri build && npm run build -w @openbench/mcp-server

RUN mkdir -p /out \
    && cp apps/desktop/src-tauri/target/release/bundle/deb/*.deb /out/ \
    && cp apps/desktop/src-tauri/target/release/bundle/rpm/*.rpm /out/ \
    && cp apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage /out/ \
    && cp apps/mcp-server/dist/openbench-mcp.mjs /out/

FROM scratch AS artifacts
COPY --from=build /out/ /
