"""The demo-otp-hook resolver as a process plugin in Python, with only the standard library.

It answers otp-email and otp-sms from the demo's /test/otp hook, read once at params.url through
host.http. List it in plugins: as { command: [python3, plugins/python-resolver/plugin.py] }.
docs/plugin-protocol.md has the protocol.
"""

from __future__ import annotations

import json
import sys
import threading

PROTOCOL_VERSION = 1
API_VERSION = 1
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603

RESOLVER = {
    "name": "demo-otp-hook",
    "kinds": ["otp-email", "otp-sms"],
    "requires": [],
    "automated": True,
    "arm": False,
}


class RpcError(Exception):
    """An error answer: one the host gave to a callback, or one this plugin gives."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class _Pending:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.answer: dict = {}


class Host:
    """Writes messages to the host and matches its answers to the callbacks waiting for them."""

    def __init__(self) -> None:
        self._write_lock = threading.Lock()
        self._lock = threading.Lock()
        self._pending: dict[int, _Pending] = {}
        self._next_id = 0
        self._open = True

    def send(self, message: dict) -> None:
        # stdout carries protocol lines only, so logs go to stderr
        with self._write_lock:
            sys.stdout.write(json.dumps(message) + "\n")
            sys.stdout.flush()

    def call(self, method: str, params: dict):
        """Sends a host.* request and waits for its result; raises RpcError when the host answers an error."""
        pending = _Pending()
        with self._lock:
            if not self._open:
                raise RpcError(INTERNAL_ERROR, "the host closed the connection")
            self._next_id += 1
            request_id = self._next_id
            self._pending[request_id] = pending
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        pending.done.wait()
        error = pending.answer.get("error")
        if error is not None:
            raise RpcError(error.get("code", INTERNAL_ERROR), error.get("message", ""))
        return pending.answer.get("result")

    def settle(self, answer: dict) -> None:
        with self._lock:
            pending = self._pending.pop(answer.get("id"), None)
        if pending is not None:
            pending.answer = answer
            pending.done.set()

    def close(self) -> None:
        """Fails every callback still waiting, so the handlers that sent them can finish."""
        with self._lock:
            self._open = False
            waiting = list(self._pending.values())
            self._pending.clear()
        for pending in waiting:
            pending.answer = {"error": {"code": INTERNAL_ERROR, "message": "the host closed the connection"}}
            pending.done.set()


host = Host()


def resolve(request: dict, context_id: str) -> dict | None:
    url = request["params"].get("url")
    if not url:
        raise ValueError("demo-otp-hook needs params.url, the hook to GET")
    response = host.call(
        "host.http",
        {
            "contextId": context_id,
            "request": {"method": "GET", "url": url, "headers": {"accept": "application/json"}},
        },
    )
    # no code is waiting
    if response["status"] == 404:
        return None
    # the query may hold the recipient, so the message leaves the URL out
    if response["status"] != 200:
        raise ValueError(f"the hook answered {response['status']}")
    body = response["body"]
    code = body.get("code") if isinstance(body, dict) else None
    if not isinstance(code, str):
        raise ValueError("the hook's answer holds no code")
    return {"kind": "value", "value": code}


def answer(method: str, params: dict):
    if method == "initialize":
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "name": "demo-python-resolver",
            "apiVersion": API_VERSION,
            "contributions": {"resolvers": [RESOLVER]},
        }
    if method == "shutdown":
        return None
    if method == "resolver.resolve":
        return resolve(params["request"], params["context"]["contextId"])
    raise RpcError(METHOD_NOT_FOUND, f"unknown method {method}")


def handle(message: dict) -> None:
    reply: dict = {"jsonrpc": "2.0", "id": message["id"]}
    try:
        reply["result"] = answer(message["method"], message.get("params") or {})
    except RpcError as error:
        # an error the host answered, -32001 in particular, goes back unchanged
        reply["error"] = {"code": error.code, "message": str(error)}
    except Exception as error:
        reply["error"] = {"code": INTERNAL_ERROR, "message": str(error)}
    host.send(reply)


def main() -> None:
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if "method" not in message:
            host.settle(message)
        elif "id" in message:
            # a thread per request, so a handler can wait for a host.* answer while this loop reads it
            threading.Thread(target=handle, args=(message,)).start()
        # notifications such as $/cancelRequest need nothing here
    host.close()


if __name__ == "__main__":
    main()
