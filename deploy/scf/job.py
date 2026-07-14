from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import requests


_JOB_ID_RE = re.compile(r"^[0-9a-f-]{36}$")
_ANALYSTS = (
    "market",
    "social",
    "news",
    "fundamentals",
    "policy",
    "hot_money",
    "lockup",
)
_CALLBACK_TIMEOUT_SECONDS = 20
_CALLBACK_ATTEMPTS = 4


def _validate_event(event: object) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise ValueError("event must be a JSON object")

    job_id = str(event.get("job_id", "")).strip().lower()
    if not _JOB_ID_RE.fullmatch(job_id):
        raise ValueError("job_id must be a UUID")

    ticker = str(event.get("ticker", "")).strip()
    if not re.fullmatch(r"\d{6}", ticker):
        raise ValueError("ticker must be a 6-digit A-share code")

    trade_date = str(event.get("trade_date", "")).strip()
    try:
        parsed_date = date.fromisoformat(trade_date)
    except ValueError as exc:
        raise ValueError("trade_date must use YYYY-MM-DD") from exc

    shanghai_today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    if parsed_date > shanghai_today:
        raise ValueError("trade_date cannot be in the future")

    raw_analysts = event.get("analysts", list(_ANALYSTS))
    if not isinstance(raw_analysts, list) or not raw_analysts:
        raise ValueError("analysts must be a non-empty list")
    analysts = [str(item).strip() for item in raw_analysts]
    invalid = sorted(set(analysts) - set(_ANALYSTS))
    if invalid:
        raise ValueError(f"unsupported analysts: {', '.join(invalid)}")

    return {
        "job_id": job_id,
        "ticker": ticker,
        "trade_date": trade_date,
        "analysts": analysts,
    }


def _callback_signature(secret: str, timestamp: str, body: bytes) -> str:
    message = timestamp.encode("ascii") + b"." + body
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def _send_callback(payload: dict[str, Any], *, required: bool = False) -> None:
    callback_url = os.getenv("CALLBACK_URL", "").strip()
    callback_secret = os.getenv("CALLBACK_SECRET", "").strip()
    if not callback_url or not callback_secret:
        if required:
            raise RuntimeError("CALLBACK_URL and CALLBACK_SECRET must be configured")
        print(json.dumps({"message": "callback skipped", "status": payload.get("status")}))
        return

    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(_CALLBACK_ATTEMPTS):
        timestamp = str(int(time.time()))
        signature = _callback_signature(callback_secret, timestamp, body)
        try:
            response = requests.post(
                callback_url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Job-Timestamp": timestamp,
                    "X-Job-Signature": signature,
                },
                timeout=_CALLBACK_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            return
        except requests.RequestException as exc:
            last_error = exc
            if attempt + 1 < _CALLBACK_ATTEMPTS:
                time.sleep(2**attempt)

    if required:
        raise RuntimeError(f"callback failed after {_CALLBACK_ATTEMPTS} attempts") from last_error
    print(json.dumps({"message": "callback failed", "error": str(last_error)}))


def _build_config(job_id: str) -> dict[str, Any]:
    from tradingagents.default_config import DEFAULT_CONFIG

    workspace = Path("/tmp/tradingagents") / job_id
    config = copy.deepcopy(DEFAULT_CONFIG)
    config.update(
        {
            "results_dir": str(workspace / "results"),
            "data_cache_dir": str(workspace / "cache"),
            "memory_log_path": str(workspace / "memory" / "trading_memory.md"),
            "llm_provider": os.getenv("LLM_PROVIDER", "openai").strip() or "openai",
            "deep_think_llm": os.getenv("DEEP_THINK_LLM", "gpt-4o-mini").strip()
            or "gpt-4o-mini",
            "quick_think_llm": os.getenv("QUICK_THINK_LLM", "gpt-4o-mini").strip()
            or "gpt-4o-mini",
            "backend_url": os.getenv("BACKEND_URL", "").strip() or None,
            "max_debate_rounds": 1,
            "max_risk_discuss_rounds": 1,
            "checkpoint_enabled": False,
            "output_language": "Chinese",
        }
    )
    return config


def run_job(raw_event: object) -> dict[str, Any]:
    event = _validate_event(raw_event)
    started_at = datetime.now(ZoneInfo("Asia/Shanghai"))
    _send_callback(
        {
            **event,
            "status": "running",
            "started_at": started_at.isoformat(),
        }
    )

    try:
        from cli.main import save_report_to_disk
        from tradingagents.graph.trading_graph import TradingAgentsGraph

        config = _build_config(event["job_id"])
        graph = TradingAgentsGraph(
            selected_analysts=event["analysts"],
            debug=False,
            config=config,
        )
        final_state, decision = graph.propagate(event["ticker"], event["trade_date"])

        report_dir = (
            Path(config["results_dir"])
            / event["ticker"]
            / event["trade_date"]
            / "reports"
        )
        report_path = save_report_to_disk(final_state, event["ticker"], report_dir)
        report = report_path.read_text(encoding="utf-8")
        completed_at = datetime.now(ZoneInfo("Asia/Shanghai"))

        result = {
            **event,
            "status": "succeeded",
            "decision": str(decision),
            "report": report,
            "started_at": started_at.isoformat(),
            "completed_at": completed_at.isoformat(),
            "duration_seconds": round((completed_at - started_at).total_seconds(), 2),
            "model": config["quick_think_llm"],
        }
        _send_callback(result, required=True)
        return {key: value for key, value in result.items() if key != "report"}
    except Exception as exc:
        completed_at = datetime.now(ZoneInfo("Asia/Shanghai"))
        failure = {
            **event,
            "status": "failed",
            "error": str(exc)[:2000],
            "started_at": started_at.isoformat(),
            "completed_at": completed_at.isoformat(),
            "duration_seconds": round((completed_at - started_at).total_seconds(), 2),
        }
        _send_callback(failure)
        raise


__all__ = ["run_job"]
