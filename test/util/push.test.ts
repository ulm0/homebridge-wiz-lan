import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { FakeSocket, makeDevice, makeFakeWiz } from "../__helpers__/factories";
import { FakePlatformAccessory } from "../__mocks__/homebridge";

// startPushUpdates opens its own sockets (the renewal sender, and a listener
// when the main socket isn't on 38900). Hand out fresh FakeSockets and keep
// them so tests can inspect what was sent and inject replies.
const created: FakeSocket[] = [];
mock.module("dgram", () => {
  const createSocket = () => {
    const socket = new FakeSocket();
    created.push(socket);
    return socket as any;
  };
  return { default: { createSocket }, createSocket };
});

import {
  handleSyncPilot,
  normalizeMac,
  registerPushTarget,
  renewPushAfterDiscovery,
  resetPushForTesting,
  startPushUpdates,
} from "../../src/util/push";

const baseConfig = (overrides: any = {}) =>
  ({
    mac: "AA:BB:CC:00:11:22",
    address: "10.0.0.1",
    port: 38900,
    spaceSense: { enabled: true },
    ...overrides,
  }) as any;

const addTarget = (mac: string, ip: string, handler = mock(() => {})) => {
  const accessory = new FakePlatformAccessory(mac, `uuid-${mac}`);
  accessory.context = makeDevice({ mac, ip });
  registerPushTarget(accessory as any, handler);
  return { accessory, handler };
};

const registrations = (socket: FakeSocket) =>
  socket.sent.filter((s) => s.msg.includes('"registration"'));

const push = (socket: FakeSocket, params: any, ip = "10.0.0.50") =>
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ method: "syncPilot", env: "pro", params })),
    { address: ip, port: 38899 },
  );

const infoLines = (wiz: any) =>
  wiz.log.info.mock.calls.map((c: any[]) => String(c[0]));
const warnLines = (wiz: any) =>
  wiz.log.warn.mock.calls.map((c: any[]) => String(c[0]));

beforeEach(() => {
  resetPushForTesting();
  created.length = 0;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe("push: registration renewal", () => {
  it("sends register:true to every target on 38899 from its own socket", () => {
    const wiz = makeFakeWiz(baseConfig());
    addTarget("a8bb5006033d", "10.0.0.50");
    addTarget("a8bb5006033e", "10.0.0.51");
    startPushUpdates(wiz);
    // Default port: no extra listener, so the only socket created is the sender
    expect(created.length).toBe(1);
    const sender = created[0];
    expect(sender.bind).toHaveBeenCalledWith(0, "10.0.0.1");
    jest.advanceTimersByTime(100);
    const sent = registrations(sender);
    expect(sent.map((s) => s.ip)).toEqual(["10.0.0.50", "10.0.0.51"]);
    expect(sent.every((s) => s.port === 38899)).toBe(true);
    expect(JSON.parse(sent[0].msg)).toEqual({
      method: "registration",
      params: { phoneIp: "10.0.0.1", register: true, phoneMac: "aabbcc001122" },
    });
    // Nothing goes out on the main socket — its handler would treat the
    // replies as newly discovered bulbs
    expect(registrations(wiz.socket)).toEqual([]);
  });

  it("staggers the sweep instead of sending every packet in one tick", () => {
    const wiz = makeFakeWiz(baseConfig());
    addTarget("000000000001", "10.0.0.1");
    addTarget("000000000002", "10.0.0.2");
    addTarget("000000000003", "10.0.0.3");
    startPushUpdates(wiz);
    expect(registrations(created[0]).length).toBe(1);
    jest.advanceTimersByTime(100);
    expect(registrations(created[0]).length).toBe(3);
  });

  it("renews every 15 seconds", () => {
    const wiz = makeFakeWiz(baseConfig());
    addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    expect(registrations(created[0]).length).toBe(1);
    jest.advanceTimersByTime(15_000);
    expect(registrations(created[0]).length).toBe(2);
    jest.advanceTimersByTime(30_000);
    expect(registrations(created[0]).length).toBe(4);
  });

  it("follows the accessory's current IP (context replaced on a new lease)", () => {
    const wiz = makeFakeWiz(baseConfig());
    const { accessory } = addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    accessory.context = makeDevice({ mac: "a8bb5006033d", ip: "10.0.0.77" });
    jest.advanceTimersByTime(15_000);
    expect(registrations(created[0]).at(-1)!.ip).toBe("10.0.0.77");
  });

  it("renews 2s after a discovery broadcast, coalescing repeats", () => {
    const wiz = makeFakeWiz(baseConfig());
    addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    renewPushAfterDiscovery();
    jest.advanceTimersByTime(1_000);
    renewPushAfterDiscovery();
    jest.advanceTimersByTime(1_999);
    expect(registrations(created[0]).length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(registrations(created[0]).length).toBe(2);
  });

  it("renewPushAfterDiscovery is a no-op before push updates start", () => {
    renewPushAfterDiscovery();
    jest.advanceTimersByTime(5_000);
    expect(created.length).toBe(0);
  });

  it("warns once per bulb when it rejects the registration", () => {
    const wiz = makeFakeWiz(baseConfig());
    startPushUpdates(wiz);
    const reply = Buffer.from(
      JSON.stringify({
        method: "registration",
        env: "pro",
        error: { code: -32602, message: "Invalid params" },
      }),
    );
    created[0].emit("message", reply, { address: "10.0.0.50", port: 38899 });
    created[0].emit("message", reply, { address: "10.0.0.50", port: 38899 });
    expect(warnLines(wiz).filter((l: string) => l.includes("rejected")).length).toBe(1);
    created[0].emit(
      "message",
      Buffer.from(JSON.stringify({ method: "registration", result: { mac: "x", success: true } })),
      { address: "10.0.0.50", port: 38899 },
    );
    // An accepted renewal re-arms the warning
    created[0].emit("message", reply, { address: "10.0.0.50", port: 38899 });
    expect(warnLines(wiz).filter((l: string) => l.includes("rejected")).length).toBe(2);
  });

  it("ignores junk and unrelated replies on the sender socket", () => {
    const wiz = makeFakeWiz(baseConfig());
    startPushUpdates(wiz);
    created[0].emit("message", Buffer.from("test"), { address: "10.0.0.50", port: 38899 });
    created[0].emit(
      "message",
      Buffer.from(JSON.stringify({ method: "getPilot", error: {} })),
      { address: "10.0.0.50", port: 38899 },
    );
    expect(warnLines(wiz)).toEqual([]);
  });

  it("stops renewing and closes its sockets on shutdown", () => {
    const wiz = makeFakeWiz(baseConfig({ port: 38901 }));
    addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    const [listener, sender] = created;
    wiz.api.emit("shutdown");
    jest.advanceTimersByTime(60_000);
    expect(registrations(sender).length).toBe(1);
    expect(sender.close).toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalled();
    expect(warnLines(wiz)).toEqual([]);
  });
});

describe("push: listening", () => {
  it("reads pushes off the main socket when it is bound to 38900", () => {
    const wiz = makeFakeWiz(baseConfig());
    const { handler } = addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    push(wiz.socket, { mac: "a8bb5006033d", src: "wfsens", state: true });
    expect(handler).toHaveBeenCalledWith({
      mac: "a8bb5006033d",
      src: "wfsens",
      state: true,
    });
  });

  it("binds a dedicated listener on 38900 when port is something else", () => {
    const wiz = makeFakeWiz(baseConfig({ port: 38901 }));
    const { handler } = addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    const listener = created[0];
    expect(listener.bind).toHaveBeenCalledWith(38900, "10.0.0.1");
    push(listener, { mac: "a8bb5006033d", src: "wfsens", state: true });
    expect(handler).toHaveBeenCalledTimes(1);
    // The main socket isn't listened on in that case
    push(wiz.socket, { mac: "a8bb5006033d", src: "wfsens", state: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("warns without crashing when 38900 is taken", () => {
    const wiz = makeFakeWiz(baseConfig({ port: 38901 }));
    startPushUpdates(wiz);
    const listener = created[0];
    const error: any = new Error("bind EADDRINUSE");
    error.code = "EADDRINUSE";
    listener.emit("error", error);
    expect(listener.close).toHaveBeenCalled();
    expect(warnLines(wiz).some((l: string) => l.includes("EADDRINUSE"))).toBe(true);
    // Shutdown must not close it a second time
    listener.close.mockClear();
    wiz.api.emit("shutdown");
    expect(listener.close).not.toHaveBeenCalled();
  });

  it("ignores non-JSON datagrams, other methods and syncPilot replies", () => {
    const wiz = makeFakeWiz(baseConfig());
    const { handler } = addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    const rinfo = { address: "10.0.0.50", port: 38899 };
    wiz.socket.emit("message", Buffer.from("test"), rinfo);
    wiz.socket.emit("message", Buffer.from("{syncPilot"), rinfo);
    wiz.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ method: "getPilot", result: { mac: "a8bb5006033d", src: "syncPilot" } })),
      rinfo,
    );
    wiz.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ method: "syncPilot", result: { mac: "a8bb5006033d" } })),
      rinfo,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("warns after 60s if no push has arrived at all", () => {
    const wiz = makeFakeWiz(baseConfig());
    addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    jest.advanceTimersByTime(60_000);
    expect(warnLines(wiz).some((l: string) => l.includes("No push updates"))).toBe(true);
  });

  it("does not warn when pushes are arriving", () => {
    const wiz = makeFakeWiz(baseConfig());
    addTarget("a8bb5006033d", "10.0.0.50");
    startPushUpdates(wiz);
    push(wiz.socket, { mac: "a8bb5006033d", src: "hb", state: false });
    jest.advanceTimersByTime(60_000);
    expect(warnLines(wiz)).toEqual([]);
  });
});

describe("push: handleSyncPilot", () => {
  it("logs the first push and each new src value once", () => {
    const wiz = makeFakeWiz(baseConfig());
    addTarget("a8bb5006033d", "10.0.0.50");
    handleSyncPilot(wiz, { mac: "a8bb5006033d", src: "hb" }, "10.0.0.50");
    handleSyncPilot(wiz, { mac: "a8bb5006033d", src: "hb" }, "10.0.0.50");
    handleSyncPilot(wiz, { mac: "a8bb5006033d", src: "wfsens" }, "10.0.0.50");
    const lines = infoLines(wiz);
    expect(lines.filter((l: string) => l.includes("Receiving push updates")).length).toBe(1);
    expect(lines.filter((l: string) => l.includes('"hb"')).length).toBe(1);
    expect(lines.filter((l: string) => l.includes('"wfsens"')).length).toBe(1);
  });

  it("drops pushes without a MAC or params, and from untracked devices", () => {
    const wiz = makeFakeWiz(baseConfig());
    const { handler } = addTarget("a8bb5006033d", "10.0.0.50");
    handleSyncPilot(wiz, null, "10.0.0.50");
    handleSyncPilot(wiz, { src: "wfsens" }, "10.0.0.50");
    handleSyncPilot(wiz, { mac: "ffffffffffff", src: "wfsens" }, "10.0.0.99");
    expect(handler).not.toHaveBeenCalled();
  });

  it("normalizeMac lowercases and strips separators", () => {
    expect(normalizeMac("A8:BB:50:06:03:3D")).toBe("a8bb5006033d");
  });
});
