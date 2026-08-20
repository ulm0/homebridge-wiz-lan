import { PlatformAccessory } from "homebridge";

import HomebridgeWizLan from "../../wiz";
import { isOffline, recordFailureOnce, recordSuccess } from "../../util/offline";
import { Device } from "../../types";
import {
  getPilot as _getPilot,
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

// Bumped twice per setPilot: once when the write is optimistically committed
// to cachedPilot, and again when it resolves (ack, send error, or timeout). A
// getPilot probe captures the value when it is transmitted; if it differs when
// the reply lands, the device generated that reply before the write reached it
// — or while the write was still unresolved, so it may have. Committing such a
// reply would roll cachedPilot — and the HomeKit tile — back to pre-write
// state (cache-first reads leave probes in flight long enough for a user write
// to interleave, and its ack can beat the delayed reply).
//
// The resolution bump is what covers a write that is committed but not yet on
// the wire: between the two bumps the cache is ahead of the device, so a probe
// transmitted in that window reads pre-write state while its snapshot already
// matches the commit bump. Nothing would mark that reply stale — see the
// failed-write reconciliation in setPilot, which probes while the write queued
// behind it is still waiting its turn on the wire.
export const writeGeneration: { [mac: string]: number } = {};

// writeGeneration snapshot taken when the underlying UDP probe was actually
// transmitted (via the network layer's onTransmit hook). Probes are coalesced
// per device and may be deferred by the rate limiter, so a getPilot call can
// be answered by a probe transmitted well after the call was made. Every
// callback in that batch shares one reply and must compare against the
// transmitting probe's snapshot, not one taken when they happened to call.
const probeStartGeneration: { [mac: string]: number } = {};

// Re-publishing a value HomeKit already holds still emits an event
// notification, and controllers answer notifications by reading — which starts
// another probe, which pushes again. Only publish real changes. `force` covers
// clearing a "No Response" error state, which value equality can't detect.
function updatePilot(
  wiz: HomebridgeWizLan,
  accessory: PlatformAccessory,
  _: Device,
  pilot: Pilot | Error,
  force = false
) {
  const { Service } = wiz;
  const service = accessory.getService(Service.Outlet)!;

  const characteristic = service.getCharacteristic(wiz.Characteristic.On);
  const value = pilot instanceof Error ? pilot : transformOnOff(pilot);
  if (force || pilot instanceof Error || characteristic.value !== value) {
    characteristic.updateValue(value);
  }
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

  const handleReply = (error: Error | null, pilot: Pilot) => {
    // Read at reply time, not call time: the network layer may have deferred
    // and coalesced this call onto a probe transmitted later, and every
    // callback in that batch shares the transmitting probe's snapshot. Safe to
    // read from the map because a probe's callbacks all run synchronously
    // before any later probe for the same device can transmit.
    const generationAtProbeStart = probeStartGeneration[device.mac] ?? 0;
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
      // fresh state so the tile converges on reality. Only changed values go
      // out, except when the device just came back: HomeKit is holding an
      // error state that a value-equality check can't see.
      updatePilot(wiz, accessory, device, pilot, cameBack);
    } else {
      onSuccess(pilot);
    }
  };

  _getPilot<Pilot>(wiz, device, handleReply, {
    // Only retransmit when HomeKit is actually blocked on this reply. If the
    // GET was already answered from cache (or with "No Response"), the second
    // copy is invisible to the user and only doubles the load on a device that
    // is already slow to answer.
    retransmit: !responded,
    onTransmit: () => {
      probeStartGeneration[device.mac] = writeGeneration[device.mac] ?? 0;
    },
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
    // Resolution bump — see writeGeneration. Must happen before the
    // reconciliation probe below so that probe's snapshot includes this
    // write's resolution and its reply is not discarded on our account; a
    // write still queued behind us bumps again when it resolves, which is
    // exactly what invalidates a probe transmitted before it was sent.
    writeGeneration[device.mac] = (writeGeneration[device.mac] ?? 0) + 1;
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