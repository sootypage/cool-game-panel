FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    git \
    cmake \
    python3-pip \
    ninja-build \
    clang \
    build-essential \
    pkg-config \
    libbsd-dev \
    patchelf \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir cmake==3.29.6

WORKDIR /opt/blockheads

COPY runtime-install.sh .
COPY blockheads_server171 .

RUN chmod +x runtime-install.sh blockheads_server171 \
 && bash ./runtime-install.sh

COPY start.sh /usr/local/bin/start-blockheads
RUN chmod +x /usr/local/bin/start-blockheads \
 && mkdir -p /server

WORKDIR /server
ENTRYPOINT ["/usr/local/bin/start-blockheads"]