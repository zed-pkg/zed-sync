import type { Observable } from "rxjs";

import type { AppCapabilities, AppLifecycleSnapshot, AppLifecycleView } from "./index.mjs";

/**
 * Lift a formal lifecycle view into one shared, replaying, read-only stream.
 * Unsubscribing the last observer releases the underlying machine listener.
 */
export function observeLifecycle(lifecycle: AppLifecycleView): Observable<AppLifecycleSnapshot>;

/** Derive capabilities from validated snapshots; never creates parallel state. */
export function observeCapabilities(lifecycle: AppLifecycleView): Observable<AppCapabilities>;
