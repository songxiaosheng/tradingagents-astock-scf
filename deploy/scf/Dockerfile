FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY . .
RUN pip install --no-cache-dir .

FROM python:3.12-slim AS runtime

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TRADINGAGENTS_RESULTS_DIR=/tmp/tradingagents/results \
    TRADINGAGENTS_CACHE_DIR=/tmp/tradingagents/cache \
    TRADINGAGENTS_MEMORY_LOG_PATH=/tmp/tradingagents/memory/trading_memory.md

RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /tmp/tradingagents \
    && chown -R appuser:appuser /tmp/tradingagents

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder --chown=appuser:appuser /build /app

USER appuser
WORKDIR /app

ENTRYPOINT ["python", "-u", "deploy/scf/runtime.py"]
