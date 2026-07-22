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
  clampRgb,
  colorTemperature2rgb,
  kelvinToMired,
  rgb2colorTemperature,
  rgbToHsv,
} from "../../util/color";
import { isRGB, isTW } from "./util";
import {
  transformDimming,
  transformHue,
  transformOnOff,
  transformSaturation,
  transformTemperature,
} from "./characteristics";
import {
  transformEffectId,
} from "./characteristics/scenes";
import { WizPilot } from "../WizAccessory";

export interface Pilot extends WizPilot {
  mac: string;
  rssi: number;
  src: string;
  state: boolean;
  sceneId?: number;
  speed?: number;
  temp?: number;
  dimming?: number;
  r?: number;
  g?: number;
  b?: number;
}

// We need to cache all the state values
// since we need to send them all when
// updating, otherwise the bulb resets
// to default values
export const cachedPilot: { [mac: string]: Pilot } = {};

// Bumped on every transmitted setPilot. A getPilot probe captures the value
// when it starts; if a write advanced it before the reply returns, the bulb
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

export const disabledAdaptiveLightingCallback: {
  [mac: string]: () => void;
} = {};

function updatePilot(
  wiz: HomebridgeWizLan,
  accessory: PlatformAccessory,
  device: Device,
  pilot: Pilot | Error
) {
  const { Service } = wiz;
  const service = accessory.getService(Service.Lightbulb)!;

  service
    .getCharacteristic(wiz.Characteristic.On)
    .updateValue(pilot instanceof Error ? pilot : transformOnOff(pilot));
  service
    .getCharacteristic(wiz.Characteristic.Brightness)
    .updateValue(pilot instanceof Error ? pilot : transformDimming(pilot));
  if (isTW(device) || isRGB(device)) {
    let useCT = true;
    if (!(pilot instanceof Error) && pilot.sceneId && pilot.sceneId > 0) {
      useCT = false;
    }
    if (useCT) {
      service
        .getCharacteristic(wiz.Characteristic.ColorTemperature)
        .updateValue(
          pilot instanceof Error ? pilot : transformTemperature(pilot)
        );
    }
  }
  if (isRGB(device)) {
    service
      .getCharacteristic(wiz.Characteristic.Hue)
      .updateValue(pilot instanceof Error ? pilot : transformHue(pilot));
    service
      .getCharacteristic(wiz.Characteristic.Saturation)
      .updateValue(pilot instanceof Error ? pilot : transformSaturation(pilot));
  }

  const scenesService = accessory.getService(Service.Television);

  if (scenesService != null) {
    scenesService
      .getCharacteristic(wiz.Characteristic.Active)
      .updateValue(
        pilot instanceof Error ? pilot : transformOnOff(pilot)
      );
    scenesService!
      .getCharacteristic(wiz.Characteristic.ActiveIdentifier)
      .updateValue(pilot instanceof Error ? pilot : transformEffectId(pilot));
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

    const old = cachedPilot[device.mac];
    if (
      typeof old !== "undefined" &&
      (pilot.sceneId !== 0 ||
        pilot.r !== old.r ||
        pilot.g !== old.g ||
        pilot.b !== old.b ||
        pilot.temp !== old.temp)
    ) {
      disabledAdaptiveLightingCallback[device.mac]?.();
    }
    cachedPilot[device.mac] = {
      dimming: (pilot.state ?? old?.state) ? 100 : 10,
      ...pilot
    };
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
    dimming: oldPilot.dimming ?? 10,
    ...pilot,
  };
  const isStateOnlyUpdate =
    Object.keys(pilot).length === 1 && typeof pilot.state === "boolean";

  if (pilot.sceneId !== undefined) {
    newPilot.temp = undefined;
    newPilot.r = undefined;
    newPilot.g = undefined;
    newPilot.b = undefined;
  } else if (newPilot.r || newPilot.g || newPilot.b || newPilot.temp) {
    newPilot.sceneId = undefined;
    newPilot.speed = undefined;
  }

  const optimisticPilot = {
    ...oldPilot,
    ...newPilot,
  } as Pilot;
  // Mark in-flight probes stale before the cache commit: their replies
  // predate this write, and a delayed one landing after the ack must not
  // clobber the newer state. Not undone on rollback — a timed-out write may
  // still have reached the bulb, so pre-write replies stay untrustworthy.
  writeGeneration[device.mac] = (writeGeneration[device.mac] ?? 0) + 1;
  cachedPilot[device.mac] = optimisticPilot;
  const outboundPilot =
    wiz.config.lastStatus && isStateOnlyUpdate ? { state: pilot.state } : newPilot;
  return _setPilot(wiz, device, outboundPilot, (error) => {
    // Roll back only while this write still owns the cache entry. A newer
    // queued write (or a fresh getPilot) may have replaced it by the time
    // this write times out — the queued command is still transmitted after
    // the failure and can succeed, so restoring this write's older snapshot
    // would leave the cache behind the confirmed device state.
    if (error !== null && cachedPilot[device.mac] === optimisticPilot) {
      cachedPilot[device.mac] = oldPilot;
    }
    callback(error);
  });
}

export function pilotToColor(pilot: Pilot | undefined) {
  // Neutral-white fallback when the cache entry is missing — defends
  // updateColorTemp() against a setPilot callback firing after the cache
  // was cleared (regression guard for issue #145).
  if (!pilot) {
    return { hue: 0, saturation: 0, temp: 2700 };
  }
  if (typeof pilot.temp === "number") {
    return {
      ...rgbToHsv(colorTemperature2rgb(Number(pilot.temp))),
      temp: Number(pilot.temp),
    };
  }
  const rgb = clampRgb({
    r: Number(pilot.r) || 0,
    g: Number(pilot.g) || 0,
    b: Number(pilot.b) || 0,
  });
  return { ...rgbToHsv(rgb), temp: rgb2colorTemperature(rgb) };
}

// Need to update hue, saturation, and temp when ANY of these change
export function updateColorTemp(
  device: Device,
  accessory: PlatformAccessory,
  wiz: HomebridgeWizLan,
  next: (error: Error | null) => void
) {
  const { Service } = wiz;
  const service = accessory.getService(Service.Lightbulb)!;
  return (error: Error | null) => {
    if (isTW(device) || isRGB(device)) {
      if (error === null) {
        const color = pilotToColor(cachedPilot[device.mac]);
        service
          .getCharacteristic(wiz.Characteristic.ColorTemperature)
          .updateValue(kelvinToMired(color.temp));
        if (isRGB(device)) {
          service
            .getCharacteristic(wiz.Characteristic.Saturation)
            .updateValue(color.saturation);
          service
            .getCharacteristic(wiz.Characteristic.Hue)
            .updateValue(color.hue);
        }
      }
    }
    next(error);
  };
}
