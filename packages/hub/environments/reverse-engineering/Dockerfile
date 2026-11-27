# syntax=docker/dockerfile:1.7
###############################################################################
# omp-hub reverse-engineering environment
#
# omp plus REA (https://github.com/morluto/rea): its MCP server and
# reverse-engineer-anything skill, loaded as an omp extension package, and the
# engines REA drives, preconfigured through REA_* variables:
#
#   Ghidra 12.2 + Temurin JDK 25   native decompilation (also omp's own Ghidra backend)
#   JADX headless MCP 0.8.0        Android APK/DEX decompilation
#   Apktool 3.0.3                  Android resources and manifests
#   Binwalk 3.1.0, Unblob 26.6.4   firmware inspection and extraction
#   Rizin 0.9.1, GDB, objdump      disassembly and debugging
#   WABT 1.0.42                    WebAssembly
#   Wakaru 1.14.0                  JavaScript bundle recovery
#   pwntools 4.15.0                recorded crashes and binary diagnostics
#   TShark                         packet captures
#
# Not included: Hopper, IDA and JEB are commercial; Kuna is unverified on
# Linux. Every download is pinned to a SHA-256. linux/amd64 only: Ghidra's
# release ships x86-64 Linux decompiler natives only.
#
# Build (from the repository root, after `bun run pi:image`):
#     docker build -t omp-hub/reverse-engineering:dev packages/hub/environments/reverse-engineering
# Optional Chromium for REA's browser and web-capture tools (it runs without its
# own sandbox, since the hub's container drops the privileges that sandbox needs):
#     docker build --build-arg WITH_BROWSER=1 ...
###############################################################################

ARG BASE=oh-my-pi/pi:dev
ARG RUST_IMAGE=rust:1.86-slim-bookworm

############################
# Binwalk 3 is a Rust tool published on crates.io, not as release binaries.
############################
FROM ${RUST_IMAGE} AS binwalk
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libfontconfig1-dev liblzma-dev libbz2-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install binwalk --version 3.1.0 --locked --root /out

############################
FROM ${BASE}

ARG WITH_BROWSER=
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.2_build/ghidra_12.2_PUBLIC_20261016.zip
ARG GHIDRA_SHA256=2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67
ARG JDK_URL=https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5.1%2B2/OpenJDK25U-jdk_x64_linux_hotspot_25.0.5.1_2.tar.gz
ARG JDK_SHA256=760f91b22c3efc9bd1b64ff950598231be82928cc807e30691a0e7a2995a62c0
ARG NODE_URL=https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz
ARG NODE_SHA256=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
ARG REA_URL=https://registry.npmjs.org/rea-agents/-/rea-agents-6.10.1.tgz
ARG REA_SHA256=e8cf08c9fa954e998fc8868c23fa8e5f518cdb9553488ec227b31a3bb6903150
ARG JADX_URL=https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.8.0/jadx-headless-mcp-0.8.0-all.jar
ARG JADX_SHA256=4b9a01c23845c123c217840182d2b5f2c26a7ca20dec3d08810b310fc80a2372
ARG APKTOOL_URL=https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar
ARG APKTOOL_SHA256=dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423
ARG RIZIN_URL=https://github.com/rizinorg/rizin/releases/download/v0.9.1/rizin-v0.9.1-static-x86_64.tar.xz
ARG RIZIN_SHA256=9102249a9f0b6319c5334a2e5cf8d9cc3f2035e1d3def027c41f6a90f647e8cf
ARG WABT_URL=https://github.com/WebAssembly/wabt/releases/download/1.0.42/wabt-1.0.42-linux-x64.tar.gz
ARG WABT_SHA256=84895407a6bbb80e918f33b16b2fb2206021c150b6bc9ff6f761263a745ab131
ARG WAKARU_URL=https://github.com/pionxzh/wakaru/releases/download/v1.14.0/wakaru-linux-x64.tar.gz
ARG WAKARU_SHA256=db0e620034723195ab426e94d00d55dbd8fd0106a928ada2563f1103196d09fa

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive

RUN if [ "$(dpkg --print-architecture)" != amd64 ]; then \
      echo "this image is linux/amd64 only: Ghidra ships x86-64 Linux decompiler natives only" >&2; exit 1; \
    fi

# procps: REA's process supervisor needs a real `ps`; util-linux: `prlimit`.
# The rest are analysis tools and the external extractors Unblob calls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        procps util-linux file xxd binutils gdb strace ltrace patchelf tshark libfontconfig1 \
        e2fsprogs p7zip-full lz4 lzop zstd xz-utils unar squashfs-tools cabextract android-sdk-libsparse-utils \
    && if [ -n "$WITH_BROWSER" ]; then apt-get install -y --no-install-recommends chromium; fi \
    && rm -rf /var/lib/apt/lists/*

# fetch <url> <sha256> <file>: download and refuse anything but the pinned bytes.
RUN printf '%s\n' '#!/bin/sh' 'set -eu' \
      'curl -fsSL --retry 3 -o "$3" "$1"' \
      'echo "$2  $3" | sha256sum -c --quiet -' > /usr/local/bin/fetch-pinned \
    && chmod +x /usr/local/bin/fetch-pinned

RUN fetch-pinned "$JDK_URL" "$JDK_SHA256" /tmp/jdk.tar.gz \
    && mkdir -p /opt/java && tar -xzf /tmp/jdk.tar.gz -C /opt/java --strip-components=1 && rm /tmp/jdk.tar.gz

RUN fetch-pinned "$GHIDRA_URL" "$GHIDRA_SHA256" /tmp/ghidra.zip \
    && unzip -q /tmp/ghidra.zip -d /opt && mv /opt/ghidra_12.2_PUBLIC /opt/ghidra && rm /tmp/ghidra.zip \
    && python3 -m venv /opt/pyghidra \
    && /opt/pyghidra/bin/pip install --no-cache-dir --no-index \
        --find-links /opt/ghidra/Ghidra/Features/PyGhidra/pypkg/dist pyghidra

RUN fetch-pinned "$NODE_URL" "$NODE_SHA256" /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE \
    && rm /tmp/node.tar.xz && node --version

# The package bundles its dependency tree (npm-shrinkwrap.json) and the skill
# matching this server version.
RUN fetch-pinned "$REA_URL" "$REA_SHA256" /tmp/rea-agents.tgz \
    && npm install --global --no-fund --no-audit /tmp/rea-agents.tgz && rm /tmp/rea-agents.tgz \
    && npm cache clean --force && rea --version

RUN mkdir -p /opt/jadx-headless-mcp /opt/apktool /opt/rizin /opt/wabt /opt/wakaru \
    && fetch-pinned "$JADX_URL" "$JADX_SHA256" /opt/jadx-headless-mcp/jadx-headless-mcp-0.8.0-all.jar \
    && fetch-pinned "$APKTOOL_URL" "$APKTOOL_SHA256" /opt/apktool/apktool.jar \
    && printf '%s\n' '#!/bin/sh' 'exec "$JAVA_HOME/bin/java" -jar /opt/apktool/apktool.jar "$@"' > /usr/local/bin/apktool \
    && chmod +x /usr/local/bin/apktool \
    && fetch-pinned "$RIZIN_URL" "$RIZIN_SHA256" /tmp/rizin.tar.xz \
    && tar -xJf /tmp/rizin.tar.xz -C /opt/rizin && rm /tmp/rizin.tar.xz \
    && fetch-pinned "$WABT_URL" "$WABT_SHA256" /tmp/wabt.tar.gz \
    && tar -xzf /tmp/wabt.tar.gz -C /opt/wabt --strip-components=1 && rm /tmp/wabt.tar.gz \
    && fetch-pinned "$WAKARU_URL" "$WAKARU_SHA256" /tmp/wakaru.tar.gz \
    && tar -xzf /tmp/wakaru.tar.gz -C /opt/wakaru wakaru && rm /tmp/wakaru.tar.gz

COPY --from=binwalk /out/bin/binwalk /usr/local/bin/binwalk

# Separate environments: REA requires exact pwntools/pyelftools/unicorn versions.
RUN python3 -m venv /opt/unblob && /opt/unblob/bin/pip install --no-cache-dir unblob==26.6.4 \
    && python3 -m venv /opt/pwntools \
    && /opt/pwntools/bin/pip install --no-cache-dir pwntools==4.15.0 pyelftools==0.33 unicorn==2.1.2

ENV JAVA_HOME=/opt/java \
    GHIDRA_INSTALL_DIR=/opt/ghidra \
    PATH=/opt/java/bin:/opt/rizin/bin:/opt/wabt/bin:${PATH} \
    PI_CONFIG_FILES=/opt/omp/config.yml \
    REA_ANALYSIS_PROVIDER=ghidra \
    REA_JADX_MCP_JAR=/opt/jadx-headless-mcp/jadx-headless-mcp-0.8.0-all.jar \
    REA_APKTOOL_COMMAND=/usr/local/bin/apktool \
    REA_RIZIN_COMMAND=/opt/rizin/bin/rizin \
    REA_WABT_BIN_DIRECTORY=/opt/wabt/bin \
    REA_WAKARU_COMMAND=/opt/wakaru/wakaru \
    REA_BINWALK_COMMAND=/usr/local/bin/binwalk \
    REA_UNBLOB_COMMAND=/opt/unblob/bin/unblob \
    REA_PWNTOOLS_PYTHON=/opt/pwntools/bin/python \
    REA_TSHARK_COMMAND=/usr/bin/tshark \
    REA_BROWSER_EXECUTABLE=${WITH_BROWSER:+/usr/bin/chromium} \
    REA_BROWSER_NO_SANDBOX=${WITH_BROWSER:+true}

# omp defaults for this image (lowest precedence: the hub's settings page and the
# environment's settings override them), and the REA extension package the hub
# loads from /opt/omp/extensions.
COPY config.yml /opt/omp/config.yml
COPY extension/ /opt/omp/extensions/rea/
RUN cp -R "$(npm root --global)/rea-agents/skills" /opt/omp/extensions/rea/skills
