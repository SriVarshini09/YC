# PB-96: The traffic sensor as OpenTelemetry (execution plan F-02)

## What changes

- **The registry:** `packages/sensor/otel/registry/shapi-sensor.yaml` is a Weaver semantic-convention registry. It defines an attribute group of 9 `shapi.sensor.*` attributes, all `development` stability, with briefs and examples. It also defines one event, `shapi.sensor.observation`, which references them all with requirement levels.
- **Emitting:** both sensors take a `sink`. `otelSink(logger)` (Node, for an `@opentelemetry/api-logs` Logger) and `shapi_sensor.otel_sink(logger)` (Python) emit one `shapi.sensor.observation` event per distinct shape, with those attributes. No token is needed: the app's Collector routes the events.
- **CI:** a new `otel-registry` job runs `weaver registry check` on the registry, in Weaver's official image (`otel/weaver:v0.27.0`, pinned).
- **Docs:** `/guide/sensor` gains an OpenTelemetry section with the attribute table.

## Verified

- The `otel-registry` CI job passes `weaver registry check` on the registry (see the PR's checks).
- The package tests:
  - the Node sink emits exactly the 9 attributes, and the set equals the attribute ids the registry defines;
  - the event references every one of them;
  - the Python sink emits the same attribute set with the same field encoding.
