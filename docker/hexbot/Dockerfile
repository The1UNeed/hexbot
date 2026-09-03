FROM python:3.11-slim

ENV HEXBOT_HOME=/data \
    PATH=/opt/hexbot/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
    && apt-get install --no-install-recommends -y git ripgrep curl ca-certificates \
    && pip install --no-cache-dir uv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/hexbot
COPY . .
RUN uv sync --extra all --locked \
    && useradd --create-home --uid 10000 hexbot \
    && mkdir -p /data \
    && chown -R hexbot:hexbot /data /opt/hexbot

USER hexbot
VOLUME ["/data"]
EXPOSE 9119
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:9119/api/health >/dev/null || exit 1
CMD ["hexbot", "serve", "--lan", "--port", "9119"]
