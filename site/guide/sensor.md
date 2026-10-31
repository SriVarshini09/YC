---
description: "SHAPI's optional traffic sensor for Node and Python: what it sends (field names and types, never values), dry run, turning it on, and the three-account rule."
---

# Traffic sensor (optional)

The traffic sensor tells SHAPI what the APIs you call actually return, so a provider's change is caught as it reaches real traffic, not only in SHAPI's own test accounts. It is opt-in, sends no values, and a change counts only once three accounts see it.

## What it sends

The sensor runs in your app. It looks only at responses from endpoints that a SHAPI advisory names (the GitHub, Stripe, OpenAI, Anthropic, HubSpot, Shopify, Xero, Twilio and other endpoints in the [advisory database](/advisories)). For each response it records:

| Recorded | Not recorded |
| --- | --- |
| Provider, HTTP method, and the advisory's endpoint pattern, such as `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` | The request's own URL, path or query: no owner, repository or ids |
| Status code | Request bodies |
| Field names and their JSON types (`items[].id: integer`) | Field values, or hashes of them |
| Version and deprecation headers (`Sunset`, `Deprecation`, `Stripe-Version`, `X-GitHub-Api-Version-Selected` and similar) | Credentials, cookies and every other header |

Identical responses are counted together in memory and sent once a minute in one batch. Requests to anything else are never read. The sensor reads a copy of each response, so your code gets it unchanged, and an error inside the sensor never fails a request.

## Try it without sending anything

Dry-run mode prints each batch instead of sending it:

```js
// Node 18+, before your app's first request
import { installSensor } from "@shapi/sensor";
installSensor({ dryRun: true });
```

```python
# Python 3.9+: wraps requests and httpx (sync and async), standard library only
import shapi_sensor
shapi_sensor.install(dry_run=True)
```

Each line starts with `[shapi-sensor] dry run, would send:` followed by the batch, exactly as it would go out.

## Turn it on

1. In the web app, open **Settings → Traffic sensor** and create a sensor token. It is shown once; SHAPI keeps only its hash.
2. Set it as `SHAPI_SENSOR_TOKEN` where your app runs, and drop `dryRun`:

```js
installSensor({ token: process.env.SHAPI_SENSOR_TOKEN });
```

```python
shapi_sensor.install(token=os.environ["SHAPI_SENSOR_TOKEN"])
```

To turn it off, remove the call, or revoke the token in Settings: uploads with a revoked token are refused.

The sensor isn't published to npm or PyPI yet. Until it is, it lives in SHAPI's repository (`packages/sensor` for Node, `packages/sensor/python/shapi_sensor` for Python).

## Send it through OpenTelemetry instead

If your app already exports OpenTelemetry logs, the sensor can hand each shape to your logger instead of uploading it. You then route it with your Collector like any other telemetry. Each distinct shape becomes one `shapi.sensor.observation` event with `shapi.sensor.*` attributes, defined in a [Weaver](https://github.com/open-telemetry/weaver) registry (`packages/sensor/otel/registry`) that CI checks with `weaver registry check`:

| Attribute | Example |
| --- | --- |
| `shapi.sensor.provider` | `github` |
| `shapi.sensor.request.method` | `POST` |
| `shapi.sensor.endpoint` | `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` |
| `shapi.sensor.response.status_code` | `204` |
| `shapi.sensor.response.body_kind` | `empty`, `json` or `text` |
| `shapi.sensor.response.fields` | `["items[].id:integer", "name:string|null"]` |
| `shapi.sensor.response.headers` | `["sunset=Wed, 11 Nov 2026 23:59:59 GMT"]` |
| `shapi.sensor.count` | `12` |
| `shapi.sensor.wire_version` | `1` |

```js
import { logs } from "@opentelemetry/api-logs";
import { installSensor, otelSink } from "@shapi/sensor";
installSensor({ sink: otelSink(logs.getLogger("shapi-sensor")) });
```

```python
import shapi_sensor
shapi_sensor.install(sink=shapi_sensor.otel_sink(my_logger))  # anything with emit(event_name=..., attributes=...)
```

No token is needed in this mode, and nothing goes to SHAPI unless your Collector sends it there.

## What SHAPI does with it

Each account's shapes are stored apart from every other account's. SHAPI compares each account's shapes over time per endpoint. A difference (a status code, a field gone or added, a type, a version header) counts as a change only when **at least three accounts** see the same change on the same endpoint. That way one customer's setup, an experiment or a flaky response is never reported as the provider's change.

SHAPI's canary probes the same endpoints from its own test accounts. A counted change the canary saw too is marked confirmed. An upload for an endpoint the sensor doesn't watch is dropped, so nothing else can be put on record.
