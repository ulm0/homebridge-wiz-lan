import { PlatformAccessory } from "homebridge";

import HomebridgeWizLan from "../../wiz";
import { isOffline, recordFailureOnce, recordSuccess } from "../../util/offline";
import { Device } from "../../types";
import {
  getPilot as _getPilot,
  hasInFlightGetPilot,
  setPilot as _setPilot,
} from "../../util/network";
import {
  transformOnOff,
} from "./characteristics";
import { WizPilot } from "../WizAccessory";

export interface Pilot extends WizPilot {
  mac: string;
  rssi: number;
  src: string;
  state: boolean;
}

// We need to cache all the state values
// since we need to send them all when
// updating, otherwise the bulb resets
// to default values
export const cachedPilot: { [mac: string]: Pilot } = {};

// Bumped on every transmitted setPilot. A getPilot probe captures the value
// when it starts; if a write advanced it before the reply returns, the device
// generated that reply before the write reached it. Committing such a reply
// would roll cachedPilot — and the HomeKit tile — back to pre-write state
// (cache-first reads leave probes in flight long enough for a user write to
// interleave, and its ack can beat the delayed reply).
export const writeGeneration: { [mac: string]: number } = {};

// writeGeneration snapshot taken when the underlying UDP probe was actually
// transmitted. The network layer coalesces probes per device, so a getPilot
// call landing while one is in flight shares that probe's reply and must
// compare against the transmitting call's snapshot — a write can land between
// transmission and join, and the shared reply predates it for every callback
// in the batch.
const probeStartGeneration: { [mac: string]: number } = {};

function updatePilot(
  wiz: HomebridgeWizLan,
  accessory: PlatformAccessory,
  _: Device,
  pilot: Pilot | Error
) {
  const { Service } = wiz;
  const service = accessory.getService(Service.Outlet)!;

  service
    .getCharacteristic(wiz.Characteristic.On)
    .updateValue(pilot instanceof Error ? pilot : transformOnOff(pilot));
}

// Write a custom getPilot/setPilot that takes this
// caching into account
export function getPilot(
  wiz: HomebridgeWizLan,
  accessory: PlatformAccessory,
  device: Device,
  onSuccess: (pilot: Pilot) => void,
  onError: (error: Error) => void
) {
  const deviceIsOffline = isOffline(device.mac);
  // Once HomeKit has been answered, the probe below only refreshes
  // characteristics via updatePilot — the callbacks must not fire twice.
  let responded = false;

  if (deviceIsOffline) {
    // Respond immediately so HomeKit doesn't wait for the UDP timeout
    onError(new wiz.api.hap.HapStatusError(wiz.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    responded = true;
    // Fall through to still probe the device so recovery is detected
  } else if (typeof cachedPilot[device.mac] !== "undefined") {
    // Answer from cache right away instead of holding HomeKit ("Updating...")
    // through a live UDP round trip; the probe pushes fresh state when it lands
    onSuccess(cachedPilot[device.mac]);
    responded = true;
  }

  // Only the call that actually transmits a probe takes a fresh snapshot;
  // calls that piggyback on an in-flight probe inherit the starter's.
  if (!hasInFlightGetPilot(device.mac)) {
    probeStartGeneration[device.mac] = writeGeneration[device.mac] ?? 0;
  }
  const generationAtProbeStart = probeStartGeneration[device.mac] ?? 0;

  _getPilot<Pilot>(wiz, device, (error, pilot) => {
    if (error !== null) {
      const threshold = Math.max(1, Number(wiz.config.pingFailuresBeforeOffline ?? 3));
      const newlyOffline = recordFailureOnce(error, device.mac, threshold);
      if (newlyOffline) {
        wiz.log.warn(`[${device.mac}] Device is now offline (${threshold} missed pings)`);
        updatePilot(wiz, accessory, device, new wiz.api.hap.HapStatusError(wiz.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        if (!responded) {
          onError(new wiz.api.hap.HapStatusError(wiz.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
        return;
      }
      if (responded) {
        // HomeKit already got the cached state (or the offline error)
        wiz.log.debug(`[getPilot] No response from ${device.mac}, HomeKit was answered from cache`);
        return;
      }
      // responded=false means no cache existed when the probe started (a
      // probe success would have resolved this same coalesced batch), so
      // there is no cached state to fall back on
      onError(error);
      return;
    }

    const cameBack = recordSuccess(device.mac);
    if (cameBack) {
      wiz.log.info(`[${device.mac}] Device is back online`);
    }
    if ((writeGeneration[device.mac] ?? 0) !== generationAtProbeStart) {
      // A write went out while this probe was in flight, so the reply is
      // stale even though it arrived last. Drop it — the next probe reports
      // post-write truth — but recordSuccess above still counted the reply
      // for offline tracking (the device did answer).
      wiz.log.debug(
        `[getPilot] Discarding stale reply from ${device.mac}: a write raced ahead of it`
      );
      if (!responded) {
        // HomeKit is still waiting on this GET — answer with the freshest
        // known state instead of the pre-write reply.
        onSuccess(cachedPilot[device.mac] ?? pilot);
      }
      return;
    }
    cachedPilot[device.mac] = pilot;
    if (responded) {
      // HomeKit was answered from cache (or shown "No Response") — push the
      // fresh state so the tile converges on reality
      updatePilot(wiz, accessory, device, pilot);
    } else {
      onSuccess(pilot);
    }
  });
}

export function setPilot(
  wiz: HomebridgeWizLan,
  accessory: PlatformAccessory,
  device: Device,
  pilot: Partial<Pilot>,
  callback: (error: Error | null) => void
) {
  if (isOffline(device.mac)) {
    callback(new wiz.api.hap.HapStatusError(wiz.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    return;
  }
  const oldPilot = cachedPilot[device.mac];
  if (typeof oldPilot == "undefined") {
    callback(new Error(`No cached state for ${device.mac}`));
    return;
  }
  const newPilot = {
    ...oldPilot,
    state: oldPilot.state ?? false,
    ...pilot,
    sceneId: undefined,
  };

  const optimisticPilot = {
    ...oldPilot,
    ...newPilot,
  } as Pilot;
  // Mark in-flight probes stale before the cache commit: their replies
  // predate this write, and a delayed one landing after the ack must not
  // clobber the newer state. Not undone on rollback — a timed-out write may
  // still have reached the device, so pre-write replies stay untrustworthy.
  writeGeneration[device.mac] = (writeGeneration[device.mac] ?? 0) + 1;
  cachedPilot[device.mac] = optimisticPilot;
  return _setPilot(wiz, device, newPilot, (error) => {
    // Roll back only while this write still owns the cache entry. A newer
    // queued write (or a fresh getPilot) may have replaced it by the time
    // this write times out — the queued command is still transmitted after
    // the failure and can succeed, so restoring this write's older snapshot
    // would leave the cache behind the confirmed device state.
    if (error !== null && cachedPilot[device.mac] === optimisticPilot) {
      cachedPilot[device.mac] = oldPilot;
    }
    if (error !== null) {
      // A timed-out write may still have reached the device (lost ack), so
      // neither the rolled-back snapshot nor the optimistic state is
      // trustworthy now — probe the device so cache and HomeKit converge on
      // truth instead of waiting for the next poll. Coalesces with any probe
      // already in flight.
      getPilot(wiz, accessory, device, () => {}, () => {});
    }
    callback(error);
  });
}