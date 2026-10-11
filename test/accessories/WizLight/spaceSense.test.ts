import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { initSpaceSense } from "../../../src/accessories/WizLight/spaceSense";
import { handleSyncPilot, resetPushForTesting } from "../../../src/util/push";
import { initScenes } from "../../../src/accessories/WizLight/characteristics/scenes";
import { FakeCharacteristicCtors, FakeServiceCtors } from "../../__mocks__/homebridge";
import {
  makeAccessoryWithService,
  makeDevice,
  makeFakeWiz,
} from "../../__helpers__/factories";

const setup = (spaceSense: any = { enabled: true }, extra: any = {}) => {
  const wiz = makeFakeWiz({ spaceSense, ...extra } as any);
  const device = makeDevice({ mac: "a8bb5006033d" });
  const accessory = makeAccessoryWithService("Lightbulb", "Desk Lamp");
  accessory.context = device;
  initSpaceSense(wiz, accessory as any, device);
  const push = (params: any) =>
    handleSyncPilot(wiz, { mac: device.mac, ...params }, device.ip);
  return { wiz, device, accessory, push };
};

const occupancy = (accessory: any) =>
  accessory
    .getService(FakeServiceCtors.OccupancySensor)
    ?.getCharacteristic(FakeCharacteristicCtors.OccupancyDetected).value;

beforeEach(() => resetPushForTesting());
afterEach(() => jest.useRealTimers());

describe("SpaceSense: service lifecycle", () => {
  it("adds an occupancy sensor starting at 'not detected' when enabled", () => {
    const { accessory } = setup();
    const service = accessory.getService(FakeServiceCtors.OccupancySensor);
    expect(service).toBeDefined();
    expect(service!.displayName).toBe("Desk Lamp SpaceSense");
    expect(occupancy(accessory)).toBe(0);
  });

  it("adds a motion sensor instead when sensorType is 'motion'", () => {
    const { accessory, push } = setup({ enabled: true, sensorType: "motion" });
    expect(accessory.getService(FakeServiceCtors.OccupancySensor)).toBeUndefined();
    const motion = accessory
      .getService(FakeServiceCtors.MotionSensor)!
      .getCharacteristic("MotionDetected");
    expect(motion.value).toBe(false);
    push({ src: "wfsens", state: true });
    expect(motion.value).toBe(true);
  });

  it("removes a cached sensor when the feature is disabled", () => {
    const { wiz, device, accessory } = setup();
    wiz.config.spaceSense = { enabled: false };
    initSpaceSense(wiz, accessory as any, device);
    expect(accessory.getService(FakeServiceCtors.OccupancySensor)).toBeUndefined();
  });

  it("does not add anything when the option is absent", () => {
    // null, not undefined — undefined would pick up setup()'s default
    const { accessory } = setup(null);
    expect(accessory.getService(FakeServiceCtors.OccupancySensor)).toBeUndefined();
    expect(accessory.getService(FakeServiceCtors.MotionSensor)).toBeUndefined();
  });

  it("swaps the cached service when sensorType changes", () => {
    const { wiz, device, accessory } = setup();
    wiz.config.spaceSense = { enabled: true, sensorType: "motion" };
    initSpaceSense(wiz, accessory as any, device);
    expect(accessory.getService(FakeServiceCtors.OccupancySensor)).toBeUndefined();
    expect(accessory.getService(FakeServiceCtors.MotionSensor)).toBeDefined();
  });

  it("reuses the cached service on restart instead of adding a second one", () => {
    const { wiz, device, accessory } = setup();
    initSpaceSense(wiz, accessory as any, device);
    expect(
      accessory.services.filter((s: any) => s.UUID === "OccupancySensor").length,
    ).toBe(1);
  });

  it("survives initScenes with scenes disabled (it strips subtyped services)", () => {
    const { wiz, device, accessory } = setup({ enabled: true }, { enableScenes: false });
    initScenes(wiz, accessory as any, device);
    expect(accessory.getService(FakeServiceCtors.OccupancySensor)).toBeDefined();
  });
});

describe("SpaceSense: occupancy state machine", () => {
  it("detects on wfsens turning the light on, clears on intl turning it off", () => {
    const { accessory, push } = setup();
    push({ src: "wfsens", state: true });
    expect(occupancy(accessory)).toBe(1);
    push({ src: "intl", state: false });
    expect(occupancy(accessory)).toBe(0);
  });

  it("clears on wfsens turning the light off", () => {
    const { accessory, push } = setup();
    push({ src: "wfsens", state: true });
    push({ src: "wfsens", state: false });
    expect(occupancy(accessory)).toBe(0);
  });

  it("treats the PIR accessory the same way", () => {
    const { accessory, push } = setup();
    push({ src: "pir", state: true, sceneId: 27 });
    expect(occupancy(accessory)).toBe(1);
    push({ src: "pir", state: false, sceneId: 0 });
    expect(occupancy(accessory)).toBe(0);
  });

  it("ignores heartbeats, app, HomeKit and WiZmote changes", () => {
    const { accessory, push } = setup();
    push({ src: "wfsens", state: true });
    for (const src of ["hb", "udp", "ios", "andr", "wfa2"]) {
      push({ src, state: false });
    }
    expect(occupancy(accessory)).toBe(1);
  });

  it("ignores intl turning the light on (brightness-mode vacancy is ambiguous)", () => {
    const { accessory, push } = setup();
    push({ src: "intl", state: true });
    expect(occupancy(accessory)).toBe(0);
  });

  it("ignores pushes without a boolean state", () => {
    const { accessory, push } = setup();
    push({ src: "wfsens" });
    push({ state: true });
    expect(occupancy(accessory)).toBe(0);
  });

  it("only publishes changes, not repeats", () => {
    const { accessory, push } = setup();
    const ch = accessory
      .getService(FakeServiceCtors.OccupancySensor)!
      .getCharacteristic(FakeCharacteristicCtors.OccupancyDetected);
    const before = ch.updateValue.mock.calls.length;
    push({ src: "wfsens", state: true });
    push({ src: "wfsens", state: true });
    expect(ch.updateValue.mock.calls.length).toBe(before + 1);
  });

  it("routes by MAC regardless of case or separators", () => {
    const { wiz, device, accessory } = setup();
    handleSyncPilot(wiz, { mac: "A8:BB:50:06:03:3D", src: "wfsens", state: true }, device.ip);
    expect(occupancy(accessory)).toBe(1);
  });

  it("honours custom occupancy and vacancy sources", () => {
    const { accessory, push } = setup({
      enabled: true,
      occupancySources: ["evt"],
      vacancySources: [],
    });
    push({ src: "wfsens", state: true });
    expect(occupancy(accessory)).toBe(0);
    push({ src: "evt", state: true });
    expect(occupancy(accessory)).toBe(1);
    push({ src: "intl", state: false });
    expect(occupancy(accessory)).toBe(1);
  });

  it("falls back to the default occupancy sources for an empty list", () => {
    const { accessory, push } = setup({ enabled: true, occupancySources: [] });
    push({ src: "wfsens", state: true });
    expect(occupancy(accessory)).toBe(1);
  });
});

describe("SpaceSense: timeout", () => {
  it("auto-clears after the configured timeout", () => {
    jest.useFakeTimers();
    const { accessory, push } = setup({ enabled: true, timeout: 60 });
    push({ src: "wfsens", state: true });
    jest.advanceTimersByTime(59_000);
    expect(occupancy(accessory)).toBe(1);
    jest.advanceTimersByTime(1_000);
    expect(occupancy(accessory)).toBe(0);
  });

  it("re-arms on each detection", () => {
    jest.useFakeTimers();
    const { accessory, push } = setup({ enabled: true, timeout: 60 });
    push({ src: "wfsens", state: true });
    jest.advanceTimersByTime(50_000);
    push({ src: "wfsens", state: true });
    jest.advanceTimersByTime(50_000);
    expect(occupancy(accessory)).toBe(1);
    jest.advanceTimersByTime(10_000);
    expect(occupancy(accessory)).toBe(0);
  });

  it("never auto-clears with the default timeout of 0", () => {
    jest.useFakeTimers();
    const { accessory, push } = setup();
    push({ src: "wfsens", state: true });
    jest.advanceTimersByTime(24 * 3600_000);
    expect(occupancy(accessory)).toBe(1);
  });

  it("a vacancy push cancels the pending auto-clear", () => {
    jest.useFakeTimers();
    const { accessory, push } = setup({ enabled: true, timeout: 60 });
    push({ src: "wfsens", state: true });
    push({ src: "intl", state: false });
    push({ src: "wfsens", state: true });
    jest.advanceTimersByTime(30_000);
    push({ src: "wfsens", state: true });
    jest.advanceTimersByTime(45_000);
    expect(occupancy(accessory)).toBe(1);
  });
});
