"""SHAPI's opt-in traffic add-on for Python (execution plan F-01).

It wraps ``requests`` and ``httpx``, and for each response from an endpoint a SHAPI advisory names it records the
value-free shape: status, field names and JSON types, and the deprecation and version headers. Requests to anything
else are not looked at. Shapes are counted in memory and sent in one batch every ``flush_seconds``, or printed
instead with ``dry_run=True``, so you can see exactly what would leave. Standard library only.

    import shapi_sensor
    shapi_sensor.install(token=os.environ["SHAPI_SENSOR_TOKEN"])   # or install(dry_run=True)

The wire format (shapi.sensor/v1) is the same as the Node sensor's: see packages/sensor/src/shape.ts.
"""

from __future__ import annotations

import json
import os
import re
import threading
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlsplit

WIRE_VERSION = 1
DEFAULT_ENDPOINT = "https://app.shapi.dev/api/v1/sensor/observations"
SIGNAL_HEADERS = {
    "anthropic-version", "api-version", "deprecation", "intuit-minor-version", "link-deprecation", "openai-version",
    "stripe-version", "sunset", "x-api-version", "x-github-api-version-selected", "x-shopify-api-deprecated-reason",
    "x-shopify-api-version",
}
MAX_DEPTH = 32
MAX_FIELDS = 500

with open(os.path.join(os.path.dirname(__file__), "endpoints.json"), encoding="utf-8") as _f:
    ENDPOINTS = json.load(_f)
for _e in ENDPOINTS:
    _e["_re"] = re.compile(_e["re"])


def _host_matches(host: str, pattern: str) -> bool:
    return host.endswith(pattern[1:]) if pattern.startswith("*.") else host == pattern


def _specificity(path: str) -> int:
    return len(re.sub(r"\*|\{[^}]*\}", "", path))


def match_endpoint(method: str, url: str, endpoints=None):
    """The endpoint a request belongs to, or None (the most specific pattern when several match)."""
    parts = urlsplit(url)
    host, path, m = (parts.hostname or ""), (parts.path or "/"), method.upper()
    best = None
    for e in endpoints if endpoints is not None else ENDPOINTS:
        if e["method"] not in ("*", m) or not any(_host_matches(host, h) for h in e["hosts"]):
            continue
        if not (e.get("_re") or re.compile(e["re"])).match(path):
            continue
        if best is None or _specificity(e["path"]) > _specificity(best["path"]):
            best = e
    return best


def _type_of(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "integer" if v.is_integer() else "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def _escape(key: str) -> str:
    return re.sub(r"([\\.\[])", r"\\\1", key)


def sensor_shape(status: int, headers, body: str) -> dict:
    """The value-free shape of one response, in the wire format."""
    kept = {}
    for name, value in headers:
        n = name.lower()
        if n in SIGNAL_HEADERS:
            kept[n] = value
    kept = dict(sorted(kept.items()))
    if not body or not body.strip():
        return {"status": status, "headers": kept, "body": {"kind": "empty", "fields": []}}
    try:
        parsed = json.loads(body)
    except ValueError:
        return {"status": status, "headers": kept, "body": {"kind": "text", "fields": []}}
    fields: dict[str, set] = {}

    def walk(v, path: str, depth: int) -> None:
        if path:
            if path not in fields:
                if len(fields) >= MAX_FIELDS:
                    return
                fields[path] = set()
            fields[path].add(_type_of(v))
        if depth >= MAX_DEPTH:
            return
        if isinstance(v, list):
            for item in v:
                walk(item, path + "[]", depth + 1)
        elif isinstance(v, dict):
            for k, c in v.items():
                walk(c, f"{path}.{_escape(k)}" if path else _escape(k), depth + 1)

    walk(parsed, "", 0)
    return {
        "status": status,
        "headers": kept,
        "body": {
            "kind": "json",
            "rootType": _type_of(parsed),
            "fields": [{"path": p, "types": sorted(t)} for p, t in sorted(fields.items())],
        },
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Sensor:
    def __init__(self, token=None, dry_run=False, endpoint=DEFAULT_ENDPOINT, flush_seconds=60.0, log=print, endpoints=None, sink=None):
        if not dry_run and not token and not sink:
            raise ValueError("shapi_sensor: pass a token, a sink, or dry_run=True")
        self.sink = sink
        self.token, self.dry_run, self.endpoint, self.log = token, dry_run, endpoint, log
        self.endpoints = endpoints if endpoints is not None else ENDPOINTS
        self.flush_seconds = flush_seconds
        self._pending: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._timer = None
        self._undo = []

    def observe(self, method: str, url: str, status: int, headers, body: str) -> None:
        """Record one response, if its endpoint is one SHAPI watches. Never raises."""
        try:
            e = match_endpoint(method, url, self.endpoints)
            if not e:
                return
            shape = sensor_shape(status, headers, body)
            m = method.upper()
            key = json.dumps([e["provider"], m, e["path"], shape], sort_keys=True)
            at = _now()
            with self._lock:
                seen = self._pending.get(key)
                if seen:
                    seen["count"] += 1
                    seen["lastSeen"] = at
                else:
                    self._pending[key] = {"provider": e["provider"], "method": m, "endpoint": e["path"], "shape": shape, "count": 1, "firstSeen": at, "lastSeen": at}
        except Exception:  # the sensor never breaks the request
            pass

    def flush(self):
        """Send (or print) what was recorded so far; returns the batch."""
        with self._lock:
            if not self._pending:
                return None
            batch = {"v": WIRE_VERSION, "sdk": "python", "observations": list(self._pending.values())}
            self._pending = {}
        if self.sink:
            try:
                self.sink(batch)
            except Exception as err:
                self.log(f"[shapi-sensor] sink failed: {err}")
            return batch
        data = json.dumps(batch, separators=(",", ":"))
        if self.dry_run:
            self.log(f"[shapi-sensor] dry run, would send: {data}")
            return batch
        req = urllib.request.Request(self.endpoint, data=data.encode(), method="POST", headers={"content-type": "application/json", "authorization": f"Bearer {self.token}"})
        try:
            urllib.request.urlopen(req, timeout=10).close()
        except Exception as err:
            self.log(f"[shapi-sensor] upload failed: {err}")
        return batch

    def _schedule(self) -> None:
        self._timer = threading.Timer(self.flush_seconds, self._tick)
        self._timer.daemon = True
        self._timer.start()

    def _tick(self) -> None:
        self.flush()
        self._schedule()

    def install(self) -> "Sensor":
        """Wrap requests and httpx (whichever are installed) and start the flush timer."""
        sensor = self
        try:
            import requests

            original = requests.Session.send

            def send(session, request, **kw):
                res = original(session, request, **kw)
                if not kw.get("stream"):
                    sensor.observe(request.method or "GET", request.url, res.status_code, res.headers.items(), res.text)
                return res

            requests.Session.send = send
            self._undo.append(lambda: setattr(requests.Session, "send", original))
        except ImportError:
            pass
        try:
            import httpx

            original_sync = httpx.Client.send

            def send_sync(client, request, **kw):
                res = original_sync(client, request, **kw)
                if not kw.get("stream"):
                    sensor.observe(request.method, str(request.url), res.status_code, res.headers.items(), res.text)
                return res

            original_async = httpx.AsyncClient.send

            async def send_async(client, request, **kw):
                res = await original_async(client, request, **kw)
                if not kw.get("stream"):
                    sensor.observe(request.method, str(request.url), res.status_code, res.headers.items(), res.text)
                return res

            httpx.Client.send = send_sync
            httpx.AsyncClient.send = send_async
            self._undo.append(lambda: (setattr(httpx.Client, "send", original_sync), setattr(httpx.AsyncClient, "send", original_async)))
        except ImportError:
            pass
        self._schedule()
        return self

    def stop(self) -> None:
        """Put requests and httpx back, after a last flush."""
        if self._timer:
            self._timer.cancel()
        for undo in reversed(self._undo):
            undo()
        self._undo = []
        self.flush()


OTEL_EVENT_NAME = "shapi.sensor.observation"


def otel_attributes(o: dict) -> dict:
    """One observation as OpenTelemetry attributes, named as in packages/sensor/otel/registry (F-02)."""
    shape = o["shape"]
    return {
        "shapi.sensor.provider": o["provider"],
        "shapi.sensor.request.method": o["method"],
        "shapi.sensor.endpoint": o["endpoint"],
        "shapi.sensor.response.status_code": shape["status"],
        "shapi.sensor.response.body_kind": shape["body"]["kind"],
        "shapi.sensor.response.fields": [f"{f['path']}:{'|'.join(f['types'])}" for f in shape["body"]["fields"]],
        "shapi.sensor.response.headers": [f"{k}={v}" for k, v in shape["headers"].items()],
        "shapi.sensor.count": o["count"],
        "shapi.sensor.wire_version": WIRE_VERSION,
    }


def otel_sink(logger):
    """A sink that emits each observation as a `shapi.sensor.observation` event on an OpenTelemetry logger.

    `logger` is anything with `emit(event_name=..., attributes=...)`; with the OpenTelemetry SDK, pass a function
    that builds a LogRecord, or use `otel_attributes` directly.
    """

    def sink(batch):
        for o in batch["observations"]:
            logger.emit(event_name=OTEL_EVENT_NAME, attributes=otel_attributes(o))

    return sink


def install(**kwargs) -> Sensor:
    """Create a sensor and install it: ``install(token=...)`` or ``install(dry_run=True)``."""
    return Sensor(**kwargs).install()
