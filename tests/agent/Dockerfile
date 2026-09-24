# Stand-in for a Plesk server, only for testing the deploy agent: same user/group model (site user in group psacln),
# a fake `plesk` CLI that records its calls, and a tiny Host-based web server for the agent's local health check.
FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl jq unzip openssl util-linux coreutils python3 procps ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd psacln && useradd -m -g psacln wcuser
COPY plesk /usr/local/bin/plesk
COPY webserver.py /usr/local/bin/webserver.py
RUN chmod +x /usr/local/bin/plesk
CMD ["sleep", "infinity"]
