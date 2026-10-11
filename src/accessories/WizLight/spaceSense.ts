import { PlatformAccessory } from "homebridge";

import { Device } from "../../types";
import { makeLogger } from "../../util/logger";
import { isSpaceSenseEnabled, registerPushTarget, SyncPilotParams } from "../../util/push";
import HomebridgeWizLan from "../../wiz";

// SpaceSense has no local API of its own. What is observable is its effect:
// when a SpaceSense automation (configured in the WiZ app) changes a bulb, the
// bulb pushes a syncPilot whose `src` names the trigger. Reported so far:
//   - "wfsens" + state:true on entry (HA core #166799, #183799)
//   - "intl" + state:false on vacancy, with the On/Off action (#183799)
// "pir" is the same mechanism for WiZ's PIR motion-sensor accessory, which
// Home Assistant has mapped to occupancy since 2022.
const DEFAULT_OCCUPANCY_SOURCES = ["wfsens", "pir"];
// "intl" is configurable rather than built in: it is from a single report,
// and if schedules or timers also use it, those would read as vacancy.
const DEFAULT_VACANCY_SOURCES = ["intl"];

/**
 * Exposes SpaceSense as a HomeKit occupancy (or motion) sensor on the bulb.
 *
 * Occupied when a push from an occupancy source turns the bulb on; vacant when
 * one turns it off, or when a vacancy source turns it off. Every other push —
 * heartbeats, app or HomeKit control, WiZmote — leaves the sensor alone.
 */
export function initSpaceSense(
  wiz: HomebridgeWizLan,
  accessory: PlatformAccessory,
  device: Device
) {
  const { Characteristic, Service } = wiz;
  const config = wiz.config.spaceSense ?? {};
  const log = makeLogger(wiz, "SpaceSense");

  const useMotion = config.sensorType === "motion";
  const [wanted, unwanted] = useMotion
    ? [Service.MotionSensor, Service.OccupancySensor]
    : [Service.OccupancySensor, Service.MotionSensor];

  // Clean up services left in the cache by an earlier configuration
  const stale = accessory.getService(unwanted);
  if (typeof stale !== "undefined") {
    accessory.removeService(stale);
  }
  if (!isSpaceSenseEnabled(wiz)) {
    const service = accessory.getService(wanted);
    if (typeof service !== "undefined") {
      accessory.removeService(service);
    }
    return;
  }

  let service = accessory.getService(wanted);
  if (typeof service === "undefined") {
    // No subtype: one sensor per accessory, and initScenes treats every
    // subtyped service as a scene input.
    service = new wanted(`${accessory.displayName} SpaceSense`);
    accessory.addService(service);
  }
  const characteristic = service.getCharacteristic(
    useMotion ? Characteristic.MotionDetected : Characteristic.OccupancyDetected
  );
  const toValue = (detected: boolean) =>
    useMotion
      ? detected
      : detected
        ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;

  // An empty list would make the sensor inert, and the config UI saves one
  // as soon as the field is touched — fall back to the defaults instead.
  const occupancySources = config.occupancySources?.length
    ? config.occupancySources
    : DEFAULT_OCCUPANCY_SOURCES;
  const vacancySources = config.vacancySources ?? DEFAULT_VACANCY_SOURCES;
  const timeout = Math.max(0, Number(config.timeout ?? 0)) * 1000;

  // HomeKit has no notion of a detection expiring; a lost vacancy push would
  // otherwise leave the sensor latched until the next SpaceSense event.
  let clearTimer: NodeJS.Timeout | undefined;
  let detected = false;
  const setDetected = (next: boolean, src: string) => {
    clearTimeout(clearTimer);
    clearTimer = undefined;
    if (next && timeout > 0) {
      clearTimer = setTimeout(() => setDetected(false, "timeout"), timeout);
      clearTimer.unref?.();
    }
    if (next === detected) {
      return;
    }
    detected = next;
    log.debug(
      `[${device.mac}] ${useMotion ? "Motion" : "Occupancy"} ${next ? "detected" : "cleared"} (${src})`
    );
    characteristic.updateValue(toValue(next));
  };
  // Nothing is known at startup; HomeKit's cached value would otherwise
  // survive a restart that missed the vacancy push.
  characteristic.updateValue(toValue(false));

  registerPushTarget(accessory, ({ src, state }: SyncPilotParams) => {
    if (typeof src !== "string" || typeof state !== "boolean") {
      return;
    }
    if (occupancySources.includes(src)) {
      setDetected(state, src);
    } else if (vacancySources.includes(src) && !state) {
      setDetected(false, src);
    }
  });

  wiz.api.on("shutdown", () => clearTimeout(clearTimer));
}
