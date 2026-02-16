ARG BASE_IMAGE=popcorn-base:local
FROM ${BASE_IMAGE}

USER root
# Install build dependencies, compile helper, and cleanup
COPY snp_ioctl.c /tmp/snp_ioctl.c
RUN apt-get update && \
    apt-get install -y gcc libc6-dev && \
    gcc -o /usr/local/bin/snp_ioctl /tmp/snp_ioctl.c && \
    apt-get purge -y gcc libc6-dev && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/* /tmp/snp_ioctl.c

# Install runtime tools
RUN apt-get update && apt-get install -y curl jq && rm -rf /var/lib/apt/lists/*

COPY attest.js /attest.js
COPY entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
