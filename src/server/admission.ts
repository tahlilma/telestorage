import "server-only";
import { config } from "./config";
import { WeightedSemaphore } from "./lb";
import { metrics } from "./metrics";

const g = globalThis as unknown as { __tsAdmission?: WeightedSemaphore };

function semaphore(): WeightedSemaphore {
  return (g.__tsAdmission ??= new WeightedSemaphore(config().uploads.admissionBytes, 512));
}

function publish(sem: WeightedSemaphore) {
  metrics.gauges.admissionBytes = sem.used;
  metrics.gauges.admissionQueued = sem.queued;
}

/**
 * Reserves room for `bytes` of upload data in the server's in-flight budget.
 * Spikes queue briefly; past the timeout the caller gets an OverloadedError
 * (→ 503 + Retry-After), which the browser engine answers by shrinking its
 * concurrency window. Memory use stays bounded no matter how many clients push.
 */
export async function admitUploadBytes(bytes: number): Promise<() => void> {
  const sem = semaphore();
  try {
    const release = await sem.acquire(bytes, config().uploads.admissionTimeoutMs);
    publish(sem);
    return () => {
      release();
      publish(sem);
    };
  } catch (e) {
    metrics.inc("admission.rejected");
    publish(sem);
    throw e;
  }
}

export function admissionStats() {
  const sem = semaphore();
  return { used: sem.used, capacity: sem.capacity, queued: sem.queued, rejected: sem.rejected };
}
