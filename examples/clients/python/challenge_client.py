"""A challenge service client for Python suites to copy; it needs only the standard library.

`bazam exec` and runner targets set BAZAM_CHALLENGE_URL and BAZAM_CHALLENGE_TOKEN;
docs/challenge-service.md has the contract.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

URL_VAR = "BAZAM_CHALLENGE_URL"
TOKEN_VAR = "BAZAM_CHALLENGE_TOKEN"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ChallengeRequestFailed(Exception):
    """The service answered with a status other than 200, or with a body that is not an answer."""

    def __init__(self, status: int, error: str) -> None:
        super().__init__(f"challenge service answered {status}: {error}")
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_challenge(
    kind: str,
    case_id: str,
    params: dict[str, str] | None = None,
    identity: str | None = None,
    step: int | None = None,
    timeout: float | None = None,
) -> dict:
    """Asks the service for an answer: {"value": "..."} or {"done": True}.

    It waits until the service answers unless `timeout`, in seconds, is set; the limit counts the time a
    prompt waits in the queue. Refuses a URL that is not loopback http before sending, and raises
    ChallengeRequestFailed for any status other than 200.
    """
    url = os.environ.get(URL_VAR)
    token = os.environ.get(TOKEN_VAR)
    if not url or not token:
        raise RuntimeError(
            f"the challenge client needs {URL_VAR} and {TOKEN_VAR}: "
            "run this test under `bazam exec` or a runner target"
        )
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "http" or parts.hostname not in _LOOPBACK_HOSTS:
        raise ValueError("the challenge service URL must be a loopback http URL")
    body: dict = {"kind": kind, "caseId": case_id}
    if params is not None:
        body["params"] = params
    if identity is not None:
        body["identity"] = identity
    if step is not None:
        body["step"] = step
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    # no proxy setting routes the request and no redirect is followed
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            status, text = response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        status, text = error.code, error.read().decode("utf-8")
    return _answer_of(status, text)


def _answer_of(status: int, text: str) -> dict:
    try:
        answer = json.loads(text)
    except ValueError:
        answer = None
    if not isinstance(answer, dict):
        answer = {}
    if status == 200 and isinstance(answer.get("value"), str):
        return {"value": answer["value"]}
    if status == 200 and answer.get("done") is True:
        return {"done": True}
    error = answer.get("error")
    raise ChallengeRequestFailed(status, error if isinstance(error, str) else text)
