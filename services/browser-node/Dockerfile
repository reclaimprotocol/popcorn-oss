ARG BASE_IMAGE=local/chromium-headful:latest
FROM ${BASE_IMAGE}

USER root
RUN apt-get update && apt-get install -y curl jq && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
