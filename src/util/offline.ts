const failureCounts: { [mac: string]: number } = {};
const offlineSet: Set<string> = new Set();

/** Increments failure count. Returns true the first time the threshold is crossed. */
export function recordFailure(mac: string, threshold: number): boolean {
  failureCounts[mac] = (failureCounts[mac] ?? 0) + 1;
  if (failureCounts[mac] >= threshold && !offlineSet.has(mac)) {
    offlineSet.add(mac);
    return true;
  }
  return false;
}

/** Resets failure count. Returns true if the device was previously offline. */
export function recordSuccess(mac: string): boolean {
  const wasOffline = offlineSet.has(mac);
  failureCounts[mac] = 0;
  offlineSet.delete(mac);
  return wasOffline;
}

export function isOffline(mac: string): boolean {
  return offlineSet.has(mac);
}

type TrackedError = Error & { wizFailureRecorded?: boolean };

/**
 * Like recordFailure, but counts a shared probe error only once. All
 * callbacks coalesced onto one in-flight UDP request receive the same Error
 * instance, so one dropped packet must count as one failure — not one per
 * piggybacked characteristic.
 */
export function recordFailureOnce(
  error: Error,
  mac: string,
  threshold: number
): boolean {
  const tracked = error as TrackedError;
  if (tracked.wizFailureRecorded) {
    return false;
  }
  tracked.wizFailureRecorded = true;
  return recordFailure(mac, threshold);
}
