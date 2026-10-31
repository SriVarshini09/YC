import { WIRE_VERSION, type SensorBatch, type SensorObservation } from "./shape";

/**
 * The traffic sensor as OpenTelemetry (execution plan F-02): instead of uploading to SHAPI, each distinct response
 * shape becomes one `shapi.sensor.observation` event on the app's own OpenTelemetry logger, with the attributes in
 * otel/registry (checked with `weaver registry check`). The app's Collector routes them wherever it sends logs.
 *
 *   import { logs } from "@opentelemetry/api-logs";
 *   installSensor({ sink: otelSink(logs.getLogger("shapi-sensor")) });
 */

export const OTEL_EVENT_NAME = "shapi.sensor.observation";

/** What the sensor needs of an OpenTelemetry Logs API logger (`@opentelemetry/api-logs` Logger.emit). */
export interface OtelLogger {
  emit(record: { eventName?: string; timestamp?: Date; attributes?: Record<string, string | number | string[]>; body?: string }): void;
}

/** One observation as the event's attributes, named as in the registry. */
export function otelAttributes(o: SensorObservation): Record<string, string | number | string[]> {
  return {
    "shapi.sensor.provider": o.provider,
    "shapi.sensor.request.method": o.method,
    "shapi.sensor.endpoint": o.endpoint,
    "shapi.sensor.response.status_code": o.shape.status,
    "shapi.sensor.response.body_kind": o.shape.body.kind,
    "shapi.sensor.response.fields": o.shape.body.fields.map((f) => `${f.path}:${f.types.join("|")}`),
    "shapi.sensor.response.headers": Object.entries(o.shape.headers).map(([k, v]) => `${k}=${v}`),
    "shapi.sensor.count": o.count,
    "shapi.sensor.wire_version": WIRE_VERSION,
  };
}

/** A sensor sink that emits each observation as an OpenTelemetry event. */
export function otelSink(logger: OtelLogger): (batch: SensorBatch) => void {
  return (batch) => {
    for (const o of batch.observations) logger.emit({ eventName: OTEL_EVENT_NAME, timestamp: new Date(o.lastSeen), attributes: otelAttributes(o) });
  };
}
