from __future__ import annotations

import json
import os
import sys
import traceback

import requests

from deploy.scf.job import run_job


def _runtime_loop() -> None:
    host = os.environ["SCF_RUNTIME_API"]
    port = os.environ["SCF_RUNTIME_API_PORT"]
    base_url = f"http://{host}:{port}/runtime"
    session = requests.Session()

    ready = session.post(f"{base_url}/init/ready", timeout=10)
    ready.raise_for_status()
    print(json.dumps({"message": "SCF runtime ready"}), flush=True)

    while True:
        response = session.get(f"{base_url}/invocation/next", timeout=(10, None))
        response.raise_for_status()
        try:
            result = run_job(response.json())
        except Exception as exc:
            error = {
                "errorMessage": str(exc),
                "errorType": type(exc).__name__,
                "stackTrace": traceback.format_exc().splitlines(),
            }
            error_response = session.post(
                f"{base_url}/invocation/error",
                json=error,
                timeout=10,
            )
            error_response.raise_for_status()
        else:
            result_response = session.post(
                f"{base_url}/invocation/response",
                json=result,
                timeout=10,
            )
            result_response.raise_for_status()


def main() -> None:
    if os.getenv("SCF_RUNTIME_API"):
        _runtime_loop()
        return

    raw_event = os.getenv("SCF_LOCAL_EVENT")
    if not raw_event and len(sys.argv) > 1:
        raw_event = sys.argv[1]
    if not raw_event:
        raise SystemExit("set SCF_LOCAL_EVENT or pass a JSON event argument")
    print(json.dumps(run_job(json.loads(raw_event)), ensure_ascii=False))


if __name__ == "__main__":
    main()
