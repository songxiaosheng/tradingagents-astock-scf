from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from deploy.scf.job import _callback_signature, _validate_event


def _valid_event() -> dict:
    return {
        "job_id": "12345678-1234-1234-1234-1234567890ab",
        "ticker": "600519",
        "trade_date": datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat(),
    }


def test_validate_event_applies_all_analysts() -> None:
    event = _validate_event(_valid_event())

    assert event["ticker"] == "600519"
    assert event["analysts"] == [
        "market",
        "social",
        "news",
        "fundamentals",
        "policy",
        "hot_money",
        "lockup",
    ]


@pytest.mark.parametrize("ticker", ["", "AAPL", "60051", "600519.SH", "../../tmp"])
def test_validate_event_rejects_invalid_ticker(ticker: str) -> None:
    event = _valid_event()
    event["ticker"] = ticker

    with pytest.raises(ValueError, match="6-digit"):
        _validate_event(event)


def test_callback_signature_is_stable() -> None:
    assert _callback_signature("secret", "123", b'{"status":"running"}') == (
        "1653212fa08b76d9523f25ac2ea17fa69a067f8b065ad79f96f605d69ae0e08e"
    )
