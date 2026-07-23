import { beforeEach, describe, expect, it, mock } from "bun:test";

// initAdaptiveLighting reaches into pilot.getPilot when the timeout fires.
// Mock the network so no UDP I/O happens.
const getPilotMock = mock(
  (_w: any, _d: any, _cb: (e: Error | null, p: any) => void) => {},
);
mock.module("../../../src/util/network", () => ({
  getPilot: getPilotMock,
  setPilot: mock(() => {}),
  hasInFlightGetPilot: () => false,
}));

import { initAdaptiveLighting } from "../../../src/accessories/WizLight/AdaptiveLighting";
import {
  cachedPilot,
  disabledAdaptiveLightingCallback,
} from "../../../src/accessories/WizLight/pilot";
import {
  makeAccessoryWithService,
  makeDevice,
  makeFakeWiz,
} from "../../__helpers__/factories";

beforeEach(() => {
  for (const k of Object.keys(cachedPilot)) delete cachedPilot[k];
  for (const k of Object.keys(disabledAdaptiveLightingCallback))
    delete disabledAdaptiveLightingCallback[k];
  getPilotMock.mockClear();
});

describe("AdaptiveLighting", () => {
  it("registers a disable callback keyed by device.mac", () => {
    const wiz = makeFakeWiz();
    const accessory = makeAccessoryWithService("Lightbulb");
    const device = makeDevice({ mac: "AL_MAC_1" });
    const service = accessory.getService(wiz.Service.Lightbulb)!;
    initAdaptiveLighting(wiz, service as any, accessory as any, device);
    expect(disabledAdaptiveLightingCallback["AL_MAC_1"]).toBeDefined();
  });

  it("disables adaptive lighting controller when the registered callback fires", () => {
    const wiz = makeFakeWiz();
    const accessory = makeAccessoryWithService("Lightbulb");
    const device = makeDevice({ mac: "AL_MAC_2" });
    const service = accessory.getService(wiz.Service.Lightbulb)!;
    initAdaptiveLighting(wiz, service as any, accessory as any, device);
    // configureController was called with our FakeAdaptiveLightingController
    expect(accessory.configureController).toHaveBeenCalled();
    const controller = (accessory.configureController as any).mock.calls[0][0];
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    disabledAdaptiveLightingCallback["AL_MAC_2"]();
    expect(controller.disableAdaptiveLighting).toHaveBeenCalled();
    expect(controller.isAdaptiveLightingActive()).toBe(false);
  });

  it("schedules a pre-update check via getPilot when temperature is set", async () => {
    const wiz = makeFakeWiz();
    const accessory = makeAccessoryWithService("Lightbulb");
    const device = makeDevice({ mac: "AL_MAC_3" });
    const service = accessory.getService(wiz.Service.Lightbulb)!;
    initAdaptiveLighting(wiz, service as any, accessory as any, device);

    // Make the next update interval short enough for the test (default 60s).
    // FakeAdaptiveLightingController returns 60_000ms; the schedule is
    // interval - 2_000ms. We swap to a short interval directly on the
    // controller instance to keep tests fast.
    const controller = (accessory.configureController as any).mock.calls[0][0];
    controller.getAdaptiveLightingUpdateInterval = () => 2_050;

    // fire the temperature 'set' event
    service.getCharacteristic(wiz.Characteristic.ColorTemperature).emit("set");

    // wait > 50ms (interval - 2000 = 50ms) for the scheduled getPilot
    await new Promise((r) => setTimeout(r, 100));
    expect(getPilotMock).toHaveBeenCalled();
  });

  it("does not schedule when adaptive lighting is already inactive", async () => {
    const wiz = makeFakeWiz();
    const accessory = makeAccessoryWithService("Lightbulb");
    const device = makeDevice({ mac: "AL_MAC_4" });
    const service = accessory.getService(wiz.Service.Lightbulb)!;
    initAdaptiveLighting(wiz, service as any, accessory as any, device);
    const controller = (accessory.configureController as any).mock.calls[0][0];
    controller.disableAdaptiveLighting();
    getPilotMock.mockClear();
    service.getCharacteristic(wiz.Characteristic.ColorTemperature).emit("set");
    await new Promise((r) => setTimeout(r, 100));
    expect(getPilotMock).not.toHaveBeenCalled();
  });
});
