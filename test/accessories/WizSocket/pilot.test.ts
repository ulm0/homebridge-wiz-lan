import { beforeEach, describe, expect, it, mock } from "bun:test";

const pendingGet: ((e: Error | null, p: any) => void)[] = [];
const pendingSet: ((e: Error | null) => void)[] = [];
const getPilotMock = mock(
  (_w: any, _d: any, cb: (e: Error | null, p: any) => void) => {
    pendingGet.push(cb);
  },
);
const setPilotMock = mock(
  (_w: any, _d: any, _p: any, cb: (e: Error | null) => void) => {
    pendingSet.push(cb);
  },
);

mock.module("../../../src/util/network", () => ({
  getPilot: getPilotMock,
  setPilot: setPilotMock,
}));

import {
  cachedPilot,
  getPilot,
  setPilot,
} from "../../../src/accessories/WizSocket/pilot";
import { isOffline, recordFailure, recordSuccess as _recordSuccess } from "../../../src/util/offline";
import {
  makeDevice,
  makeFakeWiz,
  makeSocketPilot,
} from "../../__helpers__/factories";
import { FakePlatformAccessory, FakeServiceCtors } from "../../__mocks__/homebridge";

const TEST_MAC = "SOCKETMAC1";

const makeOutletAccessory = () => {
  const acc = new FakePlatformAccessory("Test Outlet", "uuid-socket");
  acc.addService(FakeServiceCtors.Outlet, "Test Outlet");
  return acc;
};

beforeEach(() => {
  for (const k of Object.keys(cachedPilot)) delete cachedPilot[k];
  pendingGet.length = 0;
  pendingSet.length = 0;
  getPilotMock.mockClear();
  setPilotMock.mockClear();
  // Reset offline state for any MAC a test might use
  _recordSuccess(TEST_MAC);
  _recordSuccess(`${TEST_MAC}_T1`);
  _recordSuccess(`${TEST_MAC}_T2`);
  for (const s of ["F1", "F2", "F3", "F4", "F5"]) {
    _recordSuccess(`${TEST_MAC}_${s}`);
  }
});

describe("WizSocket/pilot: getPilot", () => {
  it("populates cachedPilot and onSuccess on a successful reply", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: TEST_MAC, model: "ESP10_SOCKET_06" });
    let received: any = null;
    getPilot(
      wiz,
      accessory as any,
      device,
      (p) => (received = p),
      () => {},
    );
    pendingGet[0](null, makeSocketPilot({ mac: TEST_MAC, state: true }));
    expect(received).not.toBeNull();
    expect(cachedPilot[TEST_MAC]).toBeDefined();
    expect(cachedPilot[TEST_MAC].state).toBe(true);
  });

  it("serves cached state (cache-first) and stays silent when the probe later errors under threshold", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: `${TEST_MAC}_T1`, model: "ESP10_SOCKET_06" });
    cachedPilot[device.mac] = makeSocketPilot({ mac: device.mac, state: true });
    let received: any = null;
    const onError = mock((_: Error) => {});
    getPilot(
      wiz,
      accessory as any,
      device,
      (p) => (received = p),
      onError,
    );
    pendingGet[0](new Error("timeout"), null);
    expect(received?.state).toBe(true);
    // The probe error must not surface after HomeKit was already answered.
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls onError when the network errors and no cache exists", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: `${TEST_MAC}_T2`, model: "ESP10_SOCKET_06" });
    let err: Error | null = null;
    getPilot(
      wiz,
      accessory as any,
      device,
      () => {},
      (e) => (err = e),
    );
    pendingGet[0](new Error("timeout"), null);
    expect(err).not.toBeNull();
  });
});

describe("WizSocket/pilot: cache-first responses", () => {
  it("answers synchronously from cache while the probe is still in flight", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: TEST_MAC, model: "ESP10_SOCKET_06" });
    cachedPilot[TEST_MAC] = makeSocketPilot({ mac: TEST_MAC, state: true });
    let received: any = null;
    getPilot(
      wiz,
      accessory as any,
      device,
      (p) => (received = p),
      () => {},
    );
    expect(received?.state).toBe(true);
    expect(pendingGet.length).toBe(1);
  });

  it("pushes the probe result to the Outlet characteristic after answering from cache", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: TEST_MAC, model: "ESP10_SOCKET_06" });
    cachedPilot[TEST_MAC] = makeSocketPilot({ mac: TEST_MAC, state: false });
    getPilot(
      wiz,
      accessory as any,
      device,
      () => {},
      () => {},
    );
    pendingGet[0](null, makeSocketPilot({ mac: TEST_MAC, state: true }));
    expect(cachedPilot[TEST_MAC].state).toBe(true);
    const svc = accessory.getService(wiz.Service.Outlet)!;
    expect(svc.getCharacteristic(wiz.Characteristic.On).updateValue)
      .toHaveBeenCalled();
  });
});

describe("WizSocket/pilot: offline detection", () => {
  it("marks device offline after pingFailuresBeforeOffline failures and emits HapStatusError", () => {
    const mac = `${TEST_MAC}_F1`;
    const wiz = makeFakeWiz({ pingFailuresBeforeOffline: 2 } as any);
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac, model: "ESP10_SOCKET_06" });

    // First failure: under threshold — onError is the original network error (not HAP).
    let err: any = null;
    getPilot(wiz, accessory as any, device, () => {}, (e) => (err = e));
    pendingGet[0](new Error("timeout"), null);
    expect(err).not.toBeNull();
    expect(err.hapStatus).toBeUndefined();

    // Second failure: crosses threshold — HapStatusError emitted.
    err = null;
    pendingGet.length = 0;
    getPilot(wiz, accessory as any, device, () => {}, (e) => (err = e));
    pendingGet[0](new Error("timeout"), null);
    expect(err).not.toBeNull();
    expect(err.hapStatus).toBeDefined();
    expect(wiz.log.warn).toHaveBeenCalled();
    expect(isOffline(mac)).toBe(true);
  });

  it("fast-path: offline device gets immediate HapStatusError before the UDP reply", () => {
    const mac = `${TEST_MAC}_F2`;
    const wiz = makeFakeWiz({ pingFailuresBeforeOffline: 1 } as any);
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac, model: "ESP10_SOCKET_06" });
    recordFailure(mac, 1);
    expect(isOffline(mac)).toBe(true);

    let err: any = null;
    getPilot(wiz, accessory as any, device, () => {}, (e) => (err = e));
    expect(err).not.toBeNull();
    expect(err.hapStatus).toBeDefined();
    // _getPilot still fired so recovery can be detected.
    expect(getPilotMock).toHaveBeenCalledTimes(1);
  });

  it("fast-path suppression: only one onError when a still-offline device fails again", () => {
    const mac = `${TEST_MAC}_F3`;
    const wiz = makeFakeWiz({ pingFailuresBeforeOffline: 1 } as any);
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac, model: "ESP10_SOCKET_06" });
    recordFailure(mac, 1);

    const onError = mock((_: Error) => {});
    getPilot(wiz, accessory as any, device, () => {}, onError);
    pendingGet[0](new Error("timeout"), null);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("recovery: offline device replying successfully triggers updatePilot and clears offline state", () => {
    const mac = `${TEST_MAC}_F4`;
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac, model: "ESP10_SOCKET_06" });
    recordFailure(mac, 1);

    getPilot(wiz, accessory as any, device, () => {}, () => {});
    pendingGet[0](null, makeSocketPilot({ mac, state: true }));

    expect(isOffline(mac)).toBe(false);
    expect(wiz.log.info).toHaveBeenCalled();
    // updatePilot pushed a fresh value into the Outlet On characteristic.
    const svc = accessory.getService(wiz.Service.Outlet)!;
    expect(svc.getCharacteristic(wiz.Characteristic.On).updateValue)
      .toHaveBeenCalled();
  });

  it("setPilot fast-fails with HapStatusError when device is offline", () => {
    const mac = `${TEST_MAC}_F5`;
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac, model: "ESP10_SOCKET_06" });
    cachedPilot[mac] = makeSocketPilot({ mac, state: true });
    recordFailure(mac, 1);

    let err: any = null;
    setPilot(wiz, accessory as any, device, { state: false }, (e) => (err = e));
    expect(err).not.toBeNull();
    expect(err.hapStatus).toBeDefined();
    expect(setPilotMock).not.toHaveBeenCalled();
    expect(cachedPilot[mac].state).toBe(true);
  });
});

describe("WizSocket/pilot: setPilot", () => {
  it("calls callback with an error when there is no cached state", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: TEST_MAC, model: "ESP10_SOCKET_06" });
    let err: Error | null = null;
    setPilot(wiz, accessory as any, device, { state: false }, (e) => (err = e));
    expect(err).not.toBeNull();
    expect((err as any).message).toMatch(/No cached state/);
    expect(setPilotMock).not.toHaveBeenCalled();
  });

  it("merges new state into cache and sends to network", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: TEST_MAC, model: "ESP10_SOCKET_06" });
    cachedPilot[TEST_MAC] = makeSocketPilot({ mac: TEST_MAC, state: true });
    setPilot(wiz, accessory as any, device, { state: false }, () => {});
    expect(setPilotMock).toHaveBeenCalledTimes(1);
    const sent = setPilotMock.mock.calls[0][2];
    expect(sent.state).toBe(false);
    // sockets have no scene support — sceneId is always undefined
    expect(sent.sceneId).toBeUndefined();
    expect(cachedPilot[TEST_MAC].state).toBe(false);
  });

  it("reverts the cache when the network call fails", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: TEST_MAC, model: "ESP10_SOCKET_06" });
    const oldPilot = makeSocketPilot({ mac: TEST_MAC, state: true });
    cachedPilot[TEST_MAC] = oldPilot;
    setPilot(wiz, accessory as any, device, { state: false }, () => {});
    expect(cachedPilot[TEST_MAC].state).toBe(false); // optimistic
    pendingSet[0](new Error("oops"));
    expect(cachedPilot[TEST_MAC]).toBe(oldPilot);
  });

  it("does not revert the cache when a newer write replaced it before the failure", () => {
    const wiz = makeFakeWiz();
    const accessory = makeOutletAccessory();
    const device = makeDevice({ mac: TEST_MAC, model: "ESP10_SOCKET_06" });
    cachedPilot[TEST_MAC] = makeSocketPilot({ mac: TEST_MAC, state: false });
    setPilot(wiz, accessory as any, device, { state: true }, () => {});
    setPilot(wiz, accessory as any, device, { state: true }, () => {});
    // The second write owns the cache now; the first write's failure must not
    // restore the snapshot that predates both writes.
    pendingSet[0](new Error("ack timeout"));
    expect(cachedPilot[TEST_MAC].state).toBe(true);
    pendingSet[1](null);
    expect(cachedPilot[TEST_MAC].state).toBe(true);
  });
});
