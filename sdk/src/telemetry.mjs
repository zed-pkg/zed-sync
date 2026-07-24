// Telemetry boundary. The SDK stays dependency-free: it emits structured events
// through this tiny interface and never imports an instrumentation library.
// Adapters translate events into the host's backend — the OpenTelemetry adapter
// accepts injected @opentelemetry/api objects without this package depending on
// them.
//
// Event names (stable, dot-separated):
//   sync.write.start / .local / .acked / .queued / .failed
//   sync.flush.start / .done / .failed
//   sync.change   (attribute `outcome`: applied | echo-adopted | conflict-resolved | refreshed | ignored)
//   sync.hydrate
//   sync.status   (transport up/down/reconnect)

/** @typedef {{ event(name: string, attributes?: Record<string, unknown>): void }} Telemetry */

/** Swallow everything (default). @type {Telemetry} */
export const noopTelemetry = Object.freeze({ event() {} });

/** Log every event to the console — dev aid. @param {string} [prefix] @returns {Telemetry} */
export function makeConsoleTelemetry(prefix = "[zed-sync]") {
  return {
    event(name, attributes) {
      if (attributes && attributes.error !== undefined) console.warn(`${prefix} ${name}`, attributes);
      else console.debug(`${prefix} ${name}`, attributes);
    },
  };
}

/** Fan one event out to several sinks; one sink failing never breaks the others.
 * @param {...(Telemetry|null|undefined)} sinks @returns {Telemetry} */
export function combineTelemetry(...sinks) {
  const live = sinks.filter(Boolean);
  return {
    event(name, attributes) {
      for (const sink of live) {
        try {
          sink.event(name, attributes);
        } catch {
          // A telemetry sink must never break the write path.
        }
      }
    },
  };
}

/**
 * OpenTelemetry adapter. Pass any of `tracer`, `meter`, `logger` from
 * @opentelemetry/api / @opentelemetry/api-logs; each is optional.
 * - tracer: each event becomes a zero-duration span (error events get status
 *   ERROR + an exception record).
 * - meter: counters zed_sync_events_total{event} and zed_sync_errors_total{event}.
 * - logger: a log record per event.
 * @param {{ tracer?: any, meter?: any, logger?: any }} [deps]
 * @returns {Telemetry}
 */
export function makeOtelTelemetry({ tracer, meter, logger } = {}) {
  const eventCounter = meter?.createCounter?.("zed_sync_events_total", {
    description: "zed-sync SDK events by name",
  });
  const errorCounter = meter?.createCounter?.("zed_sync_errors_total", {
    description: "zed-sync SDK error events by name",
  });
  return {
    event(name, attributes = {}) {
      const { error, ...attrs } = attributes;
      const isError = error !== undefined;
      eventCounter?.add(1, { event: name });
      if (isError) errorCounter?.add(1, { event: name });
      if (tracer) {
        const flat = flatten(attrs);
        const span = tracer.startSpan(name, { attributes: flat });
        // Also set post-creation: span processors and tracer wrappers that
        // ignore start options still see the attributes.
        span.setAttributes?.(flat);
        if (isError) {
          span.recordException?.(error instanceof Error ? error : new Error(String(error)));
          span.setStatus?.({ code: 2, message: String(error?.message ?? error) }); // ERROR
        }
        span.end();
      }
      logger?.emit?.({
        severityNumber: isError ? 17 : 9,
        severityText: isError ? "ERROR" : "INFO",
        body: name,
        attributes: flatten(isError ? { ...attrs, error: String(error?.message ?? error) } : attrs),
      });
    },
  };
}

/** OTel attributes must be primitives; stringify anything else. */
function flatten(attrs) {
  /** @type {Record<string, string|number|boolean>} */
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = v == null || typeof v === "object" ? JSON.stringify(v) : v;
  }
  return out;
}
