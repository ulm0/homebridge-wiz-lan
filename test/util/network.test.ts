import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import {
  getPilot,
  hasInFlightGetPilot,
  registerDiscoveryHandler,
  sendDiscoveryBroadcast,
  setPilot,
} from "../../src/util/network";
import {
  cachedPilot,
  setPilot as setLightPilot,
} from "../../src/accessories/WizLight/pilot";
import {
  FakeSocket,
  makeAccessoryWithService,
  makeDevice,
  makeFakeWiz,
  makeLightPilot,
} from "../__helpers__/factories";

// The util/network module keeps per-mac/per-ip callback queues at module
// scope. Tests use unique MACs/IPs to avoid cross-pollination.
let uid = 0;
const uniqueDevice = (overrides: any = {}) =>
  makeDevice({
    mac: `NETMAC${++uid}`,
    ip: `10.99.0.${(uid % 250) + 1}`,
    ...overrides,
  });

const baseConfig = () =>
  ({
    mac: "PHONEMAC",
    address: "10.0.0.1",
    broadcast: "10.0.0.255",
    port: 38900,
  }) as any;

describe("network: getPilot in-flight dedup", () => {
  it("first call sends immediately; concurrent calls piggyback on it (one UDP send total)", async () => {
    const wiz = makeFakeWiz(baseConfig());
    const device = uniqueDevice();
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    const cb3 = mock(() => {});
    getPilot(wiz, device, cb1);
    // First call sends right away — no debounce delay
    expect(
      (wiz.socket as FakeSocket).sent.filter((s) => s.msg.includes('"getPilot"'))
        .length,
    ).toBe(1);
    getPilot(wiz, device, cb2);
    getPilot(wiz, device, cb3);
    // Still only one in-flight packet
    expect(
      (wiz.socket as FakeSocket).sent.filter((s) => s.msg.includes('"getPilot"'))
        .length,
    ).toBe(1);
  });

  it("hasInFlightGetPilot tracks the probe lifecycle across coalesced joins", () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice();
    expect(hasInFlightGetPilot(device.mac)).toBe(false);
    getPilot(wiz, device, () => {});
    expect(hasInFlightGetPilot(device.mac)).toBe(true);
    // A piggybacked join keeps the same probe open — no new transmission.
    getPilot(wiz, device, () => {});
    expect(hasInFlightGetPilot(device.mac)).toBe(true);
    wiz.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          method: "getPilot",
          result: { mac: device.mac, state: true },
        }),
      ),
      { address: device.ip, port: 38899 },
    );
    expect(hasInFlightGetPilot(device.mac)).toBe(false);
  });

  it("sends to the device IP on port 38899", () => {
    const wiz = makeFakeWiz(baseConfig());
    const device = uniqueDevice({ ip: "10.5.5.5" });
    getPilot(wiz, device, () => {});
    const sent = (wiz.socket as FakeSocket).sent[0];
    expect(sent.ip).toBe("10.5.5.5");
    expect(sent.port).toBe(38899);
    expect(JSON.parse(sent.msg)).toEqual({
      method: "getPilot",
      params: {},
    });
  });

  it("fires all queued callbacks with an error after 1s if no reply arrives", async () => {
    const wiz = makeFakeWiz(baseConfig());
    const device = uniqueDevice();
    const errors: (Error | null)[] = [];
    getPilot(wiz, device, (e) => errors.push(e));
    getPilot(wiz, device, (e) => errors.push(e));
    await new Promise((r) => setTimeout(r, 1050));
    expect(errors.length).toBe(2);
    expect(errors[0]).not.toBeNull();
    expect(errors[1]).not.toBeNull();
    expect(errors[0]!.message).toMatch(/No response/);
    // All coalesced callbacks must receive the SAME Error instance — the
    // accessory layer dedupes offline-failure counting on it, so one dropped
    // packet counts as one failure rather than one per characteristic.
    expect(errors[0]).toBe(errors[1]!);
  }, 5000);
});

describe("network: getPilot retransmits", () => {
  it("retransmits the request once while unanswered (2 packets inside the 1s window)", async () => {
    const wiz = makeFakeWiz(baseConfig());
    const device = uniqueDevice();
    getPilot(wiz, device, () => {});
    // The retransmit fires at 400ms; sample well past it but before the 1s
    // deadline.
    await new Promise((r) => setTimeout(r, 750));
    const sends = (wiz.socket as FakeSocket).sent.filter((s) =>
      s.msg.includes('"getPilot"'),
    );
    expect(sends.length).toBe(2);
    expect(sends.every((s) => s.ip === device.ip)).toBe(true);
  }, 5000);

  it("stops retransmitting once a reply arrives", async () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice();
    getPilot(wiz, device, () => {});
    wiz.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          method: "getPilot",
          result: { mac: device.mac, state: true },
        }),
      ),
      { address: device.ip, port: 38899 },
    );
    await new Promise((r) => setTimeout(r, 800));
    expect(
      (wiz.socket as FakeSocket).sent.filter((s) => s.msg.includes('"getPilot"'))
        .length,
    ).toBe(1);
  }, 5000);
});

describe("network: duplicate reply absorption", () => {
  const reply = (wiz: any, device: any, extra: any = {}) =>
    wiz.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          method: "getPilot",
          result: { mac: device.mac, state: false, ...extra },
        }),
      ),
      { address: device.ip, port: 38899 },
    );

  it("absorbs the duplicate a retransmitted probe can elicit instead of resolving the next probe with it", async () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice();
    const first: any[] = [];
    getPilot(wiz, device, (_e, p) => first.push(p));
    // Let the 400ms retransmit fire so two copies of the probe are on the wire.
    await new Promise((r) => setTimeout(r, 500));
    reply(wiz, device, { state: false });
    expect(first.length).toBe(1);
    // A new probe opens; the bulb's answer to the retransmitted copy lands
    // first, carrying state read before the previous probe closed.
    const second: any[] = [];
    getPilot(wiz, device, (_e, p) => second.push(p));
    reply(wiz, device, { state: false });
    // The duplicate must not resolve the new probe...
    expect(second.length).toBe(0);
    // ...but the genuine reply does.
    reply(wiz, device, { state: true });
    expect(second.length).toBe(1);
    expect(second[0].state).toBe(true);
  }, 5000);

  it("does not absorb anything when the probe resolved before retransmitting", () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice();
    const first: any[] = [];
    getPilot(wiz, device, (_e, p) => first.push(p));
    // One packet out, one reply back — no duplicate is possible.
    reply(wiz, device);
    expect(first.length).toBe(1);
    const second: any[] = [];
    getPilot(wiz, device, (_e, p) => second.push(p));
    reply(wiz, device, { state: true });
    expect(second.length).toBe(1);
    expect(second[0].state).toBe(true);
  });

  it("expires the absorption window so later probes are unaffected", async () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice();
    getPilot(wiz, device, () => {});
    await new Promise((r) => setTimeout(r, 500)); // retransmit fired
    reply(wiz, device);
    // Wait out the 600ms window with no duplicate arriving.
    await new Promise((r) => setTimeout(r, 700));
    const second: any[] = [];
    getPilot(wiz, device, (_e, p) => second.push(p));
    reply(wiz, device, { state: true });
    expect(second.length).toBe(1);
  }, 5000);
});

describe("network: malformed and error replies", () => {
  it("ignores error replies without result instead of crashing the handler", () => {
    const wiz = makeFakeWiz(baseConfig());
    const added: any[] = [];
    registerDiscoveryHandler(wiz, (d) => added.push(d));
    const device = uniqueDevice();
    const results: any[] = [];
    getPilot(wiz, device, (e, p) => results.push([e, p]));
    const emit = (payload: any) =>
      wiz.socket.emit("message", Buffer.from(JSON.stringify(payload)), {
        address: device.ip,
        port: 38899,
      });
    // WiZ firmware answers some requests with {error:{...}} and no result —
    // none of these may throw inside the dgram handler (an uncaught throw
    // there would crash Homebridge).
    emit({ method: "getPilot", error: { code: -32700, message: "Parse error" } });
    emit({ method: "registration", error: { code: -32600 } });
    emit({ method: "getSystemConfig", error: { code: -32600 } });
    expect(results.length).toBe(0);
    expect(added.length).toBe(0);
    // The probe is still open and a real reply still resolves it.
    emit({ method: "getPilot", result: { mac: device.mac, state: true } });
    expect(results.length).toBe(1);
    expect(results[0][0]).toBeNull();
    expect(results[0][1].state).toBe(true);
  });
});

describe("network: setPilot payload composition", () => {
  it("emits {method:setPilot, env:pro, params:{mac, src:udp, ...pilot}}", () => {
    const wiz = makeFakeWiz(baseConfig());
    const device = uniqueDevice({ ip: "10.6.6.6" });
    setPilot(
      wiz,
      device,
      { state: true, dimming: 75 } as any,
      () => {},
    );
    const sent = (wiz.socket as FakeSocket).sent[0];
    expect(sent.ip).toBe("10.6.6.6");
    expect(sent.port).toBe(38899);
    const parsed = JSON.parse(sent.msg);
    expect(parsed.method).toBe("setPilot");
    expect(parsed.env).toBe("pro");
    expect(parsed.params.mac).toBe(device.mac);
    expect(parsed.params.src).toBe("udp");
    expect(parsed.params.state).toBe(true);
    expect(parsed.params.dimming).toBe(75);
  });

  it("a second setPilot to the same device while one is in-flight is coalesced", () => {
    const wiz = makeFakeWiz(baseConfig());
    const device = uniqueDevice({ ip: "10.6.6.7" });
    setPilot(wiz, device, { state: true } as any, () => {});
    setPilot(wiz, device, { state: false } as any, () => {});
    setPilot(wiz, device, { dimming: 80 } as any, () => {});
    const sends = (wiz.socket as FakeSocket).sent.filter((s) =>
      s.msg.includes('"setPilot"'),
    );
    // First one fires; rest stay in setPilotPending until the first completes
    expect(sends.length).toBe(1);
  });
});

describe("network: setPilot ack timeout", () => {
  it("errors the callback and frees the queue when the ack never arrives", async () => {
    const wiz = makeFakeWiz(baseConfig());
    const device = uniqueDevice({ ip: "10.7.7.1" });
    let err: Error | null | undefined = undefined;
    setPilot(wiz, device, { state: true } as any, (e) => (err = e));
    await new Promise((r) => setTimeout(r, 2150));
    expect(err).toBeInstanceOf(Error);
    expect((err as unknown as Error).message).toMatch(/No setPilot response/);
    // The queue must be freed: a new command goes out immediately instead of
    // being parked behind the dead entry.
    setPilot(wiz, device, { state: false } as any, () => {});
    const sends = (wiz.socket as FakeSocket).sent.filter((s) =>
      s.msg.includes('"setPilot"'),
    );
    expect(sends.length).toBe(2);
  }, 10000);

  it("a command queued behind a lost ack is transmitted after the timeout instead of being parked forever", async () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice({ ip: "10.7.7.2" });
    let errA: Error | null | undefined = undefined;
    let errB: Error | null | undefined = undefined;
    setPilot(wiz, device, { state: true } as any, (e) => (errA = e));
    setPilot(wiz, device, { dimming: 42 } as any, (e) => (errB = e));
    // Only the first command is on the wire; the second is pending.
    expect(
      (wiz.socket as FakeSocket).sent.filter((s) => s.msg.includes('"setPilot"'))
        .length,
    ).toBe(1);

    await new Promise((r) => setTimeout(r, 2150));
    // First command timed out...
    expect(errA).toBeInstanceOf(Error);
    // ...and the pending command was flushed onto the wire.
    const sends = (wiz.socket as FakeSocket).sent.filter((s) =>
      s.msg.includes('"setPilot"'),
    );
    expect(sends.length).toBe(2);
    expect(JSON.parse(sends[1].msg).params.dimming).toBe(42);

    // Its ack resolves its callback normally.
    wiz.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ method: "setPilot", result: {} })),
      { address: device.ip, port: 38899 },
    );
    expect(errB).toBeNull();
  }, 10000);

  it("preserves a newer queued write when the preceding ack times out", async () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice({ ip: "10.7.7.10" });
    const accessory = makeAccessoryWithService("Lightbulb");
    cachedPilot[device.mac] = makeLightPilot({
      mac: device.mac,
      state: false,
      dimming: 20,
    });

    let firstError: Error | null | undefined;
    let secondError: Error | null | undefined;
    setLightPilot(
      wiz,
      accessory as any,
      device,
      { state: true },
      (error) => (firstError = error),
    );
    setLightPilot(
      wiz,
      accessory as any,
      device,
      { dimming: 80 },
      (error) => (secondError = error),
    );

    expect(cachedPilot[device.mac].state).toBe(true);
    expect(cachedPilot[device.mac].dimming).toBe(80);

    await new Promise((resolve) => setTimeout(resolve, 2150));
    expect(firstError).toBeInstanceOf(Error);

    const sends = (wiz.socket as FakeSocket).sent.filter((sent) =>
      sent.msg.includes('"setPilot"'),
    );
    expect(sends).toHaveLength(2);
    expect(JSON.parse(sends[1].msg).params).toMatchObject({
      state: true,
      dimming: 80,
    });

    wiz.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ method: "setPilot", result: {} })),
      { address: device.ip, port: 38899 },
    );
    expect(secondError).toBeNull();

    // B was sent and acknowledged, so A's timeout must not restore the cache
    // snapshot that predates both writes.
    expect(cachedPilot[device.mac].state).toBe(true);
    expect(cachedPilot[device.mac].dimming).toBe(80);
  }, 10000);

  it("an ack clears the deadline, so a later command is not errored by the earlier command's stale timer", async () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice({ ip: "10.7.7.3" });
    const ack = () =>
      wiz.socket.emit(
        "message",
        Buffer.from(JSON.stringify({ method: "setPilot", result: {} })),
        { address: device.ip, port: 38899 },
      );

    let errA: Error | null | undefined = undefined;
    let errB: Error | null | undefined = undefined;
    setPilot(wiz, device, { state: true } as any, (e) => (errA = e));
    ack();
    expect(errA).toBeNull();

    // Send B well after A so their deadlines don't overlap: A's stale timer
    // (had it leaked) would fire at t=2000ms, before B's own at t=2700ms.
    await new Promise((r) => setTimeout(r, 700));
    setPilot(wiz, device, { state: false } as any, (e) => (errB = e));
    await new Promise((r) => setTimeout(r, 1550)); // t≈2250ms
    expect(errB).toBeUndefined();
    ack();
    expect(errB).toBeNull();
  }, 10000);

  it("a send error clears the deadline, so a later command is not errored by the stale timer", async () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice({ ip: "10.7.7.4" });
    const sock = wiz.socket as FakeSocket;
    // Fail exactly one send at the socket level.
    let failNext = true;
    const realSend = sock.send;
    (sock as any).send = (
      msg: string | Buffer,
      port: number,
      ip: string,
      cb?: (err: Error | null) => void,
    ) => {
      if (failNext) {
        failNext = false;
        sock.sent.push({ msg: msg.toString(), port, ip });
        cb?.(new Error("EHOSTUNREACH"));
        return;
      }
      realSend(msg, port, ip, cb);
    };

    let errA: Error | null | undefined = undefined;
    let errB: Error | null | undefined = undefined;
    setPilot(wiz, device, { state: true } as any, (e) => (errA = e));
    expect(errA).toBeInstanceOf(Error);

    // A's stale timer (had it leaked) would fire at t=2000ms, before B's own
    // deadline at t=2700ms.
    await new Promise((r) => setTimeout(r, 700));
    setPilot(wiz, device, { state: false } as any, (e) => (errB = e));
    await new Promise((r) => setTimeout(r, 1550)); // t≈2250ms
    expect(errB).toBeUndefined();
    wiz.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ method: "setPilot", result: {} })),
      { address: device.ip, port: 38899 },
    );
    expect(errB).toBeNull();
  }, 10000);
});

describe("network: discovery message routing", () => {
  it("on registration response, sends getSystemConfig back to the device", () => {
    const wiz = makeFakeWiz(baseConfig());
    const added: any[] = [];
    registerDiscoveryHandler(wiz, (d) => added.push(d));

    wiz.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          method: "registration",
          result: { mac: "BULBMAC1" },
        }),
      ),
      { address: "10.0.0.50", port: 38899 },
    );

    const sysConfig = (wiz.socket as FakeSocket).sent.find((s) =>
      s.msg.includes("getSystemConfig"),
    );
    expect(sysConfig).toBeDefined();
    expect(sysConfig!.ip).toBe("10.0.0.50");
  });

  it("on getSystemConfig response, calls addDevice with model+mac+ip", () => {
    const wiz = makeFakeWiz(baseConfig());
    const added: any[] = [];
    registerDiscoveryHandler(wiz, (d) => added.push(d));

    wiz.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          method: "getSystemConfig",
          result: { mac: "BULBMAC2", moduleName: "ESP01_SHRGB_03" },
        }),
      ),
      { address: "10.0.0.51", port: 38899 },
    );

    expect(added.length).toBe(1);
    expect(added[0]).toEqual({
      ip: "10.0.0.51",
      mac: "BULBMAC2",
      model: "ESP01_SHRGB_03",
    });
  });

  it("on getPilot response, fires the queued getPilot callback for that mac", () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice({ mac: "GETBULB1", ip: "10.0.0.52" });

    let received: any = null;
    getPilot(wiz, device, (_err, p) => (received = p));

    wiz.socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          method: "getPilot",
          result: { mac: "GETBULB1", state: true, dimming: 80 },
        }),
      ),
      { address: "10.0.0.52", port: 38899 },
    );
    expect(received).not.toBeNull();
    expect(received.state).toBe(true);
    expect(received.dimming).toBe(80);
  });

  it("on setPilot response, fires the queued setPilot callback for that ip", () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    const device = uniqueDevice({ ip: "10.0.0.53" });

    let err: Error | null | undefined = undefined;
    setPilot(wiz, device, { state: true } as any, (e) => (err = e));

    wiz.socket.emit(
      "message",
      Buffer.from(JSON.stringify({ method: "setPilot", result: {} })),
      { address: "10.0.0.53", port: 38899 },
    );
    expect(err).toBeNull();
  });

  it("ignores malformed JSON without throwing", () => {
    const wiz = makeFakeWiz(baseConfig());
    registerDiscoveryHandler(wiz, () => {});
    expect(() => {
      wiz.socket.emit("message", Buffer.from("not json {"), {
        address: "10.0.0.99",
        port: 38899,
      });
    }).not.toThrow();
  });
});

describe("network: sendDiscoveryBroadcast", () => {
  it("broadcasts a registration UDP to the configured broadcast IP", () => {
    const wiz = makeFakeWiz(baseConfig());
    sendDiscoveryBroadcast(wiz);
    const sent = (wiz.socket as FakeSocket).sent[0];
    expect(sent.ip).toBe("10.0.0.255");
    expect(sent.port).toBe(38899);
    const parsed = JSON.parse(sent.msg);
    expect(parsed.method).toBe("registration");
    expect(parsed.params.phoneMac).toBe("PHONEMAC");
    expect(parsed.params.phoneIp).toBe("10.0.0.1");
    expect(parsed.params.register).toBe(false);
  });

  it("also sends per-device-host unicast registrations when configured", () => {
    const wiz = makeFakeWiz({
      ...baseConfig(),
      devices: [{ host: "10.0.0.77" }, { host: "10.0.0.78" }],
    });
    sendDiscoveryBroadcast(wiz);
    const targets = (wiz.socket as FakeSocket).sent.map((s) => s.ip).sort();
    expect(targets).toContain("10.0.0.77");
    expect(targets).toContain("10.0.0.78");
  });
});
