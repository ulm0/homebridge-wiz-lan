import dgram from "dgram";
import getMac from "getmac";
import {internalIpV4Sync} from "internal-ip";

import { Pilot as BulbPilot } from "../accessories/WizLight/pilot";
import { Pilot as SocketPilot } from "../accessories/WizSocket/pilot";
import { Device } from "../types";
import HomebridgeWizLan from "../wiz";
import { makeLogger } from "./logger";
import { isOffline, recordSuccess } from "./offline";

function strMac() {
  return getMac().toUpperCase().replace(/:/g, "");
}

function strIp() {
  return internalIpV4Sync() ?? "0.0.0.0";
}

const BROADCAST_PORT = 38899;

function getNetworkConfig({ config }: HomebridgeWizLan) {
  return {
    ADDRESS: config.address ?? strIp(),
    PORT: config.port ?? 38900,
    BROADCAST: config.broadcast ?? "255.255.255.255",
    MAC: config.mac ?? strMac(),
  };
}

const GET_PILOT_TIMEOUT = 1000;
// getPilot is an idempotent read, so retransmit it once within the timeout
// window: a single dropped packet then costs ~400ms instead of the full
// timeout (UDP over Wi-Fi to power-saving bulbs drops packets routinely).
// Single retransmit only — every extra copy makes the bulb answer the same
// probe twice, and replies carry no request id, so a duplicate landing while
// a *later* probe is open would resolve it with stale state.
//
// Only armed for probes HomeKit is actually waiting on (see the `retransmit`
// option). With a warm cache the GET has already been answered, so a second
// copy buys nothing visible and just doubles the packets aimed at a device
// that is, by definition, not answering promptly.
const GET_PILOT_RETRANSMIT_DELAYS = [400];
// setPilot acks also carry no request id (matched by source IP only), so a
// timed-out command whose ack arrives late can be misattributed to the next
// command in flight. 2s keeps that window to genuinely lost acks — merely
// slow ones (1-2s) still resolve correctly — while a truly lost ack errors
// the HomeKit callback instead of hanging it and wedging the queue forever.
// Deliberately NOT closed by dropping the first ack after a timeout: a truly
// lost ack (the common Wi-Fi case) would make that drop eat the NEXT
// command's genuine ack, whose own timeout arms another drop — cascading
// through a whole write burst. The accessory layer re-probes after a failed
// write instead, so the cache converges on device truth either way.
const SET_PILOT_TIMEOUT = 2000;
// A retransmitted probe can be answered twice, and replies carry no request
// id — after such a probe resolves, the second answer may still arrive and
// would otherwise resolve a NEWER probe with state read before the earlier
// probe closed (and before any write since). Absorb one reply for a short
// window: long enough for the duplicate (the two copies go out 400ms apart),
// short enough that wrongly absorbing a genuine reply costs at most one
// probe cycle, which cache-first reads hide.
const DUPLICATE_REPLY_WINDOW = 600;
const duplicateReplyDeadlines: { [mac: string]: number[] } = {};

// ---------------------------------------------------------------------------
// Outbound rate limiting
//
// Every transmit path here is driven by an event source this plugin does not
// control — HomeKit characteristic reads, HomeKit writes, reply handlers — and
// until now none of them was rate limited. One UDP packet went out per
// characteristic GET, and 3.4.0's cache-first reads removed the last
// accidental brake: a GET used to block on the UDP round trip, which paced the
// controller at roughly one probe per RTT. Answering instantly from cache lets
// a controller start a fresh probe the moment the previous one closes, so the
// probe rate became bounded only by how fast HomeKit chose to read. With
// several accessories open — or a row of tiles showing "No Response", which
// controllers retry hard — that is enough to saturate a LAN, and the resulting
// congestion drops more replies, marks more devices offline and drives still
// more retries.
//
// These floors cap what any caller can put on the wire per device. Callers are
// never dropped: a throttled probe is deferred to the end of the window and
// every caller that arrives meanwhile coalesces onto it, so state still
// converges — just at a rate the network can carry.
const GET_PILOT_MIN_INTERVAL = 1000;
// An unreachable device answers nothing, so probing it on every read is pure
// noise; HomeKit is already being served "No Response" without waiting. Back
// off hard and let the refresh sweep (or this ceiling) find it again.
const OFFLINE_GET_PILOT_MIN_INTERVAL = 30_000;
// Discovery is the only true LAN-wide broadcast this plugin emits — every host
// on the subnet takes an interrupt for it, not just the bulbs. Floor it
// independently of whatever discoveryInterval is configured.
const DISCOVERY_MIN_INTERVAL = 5000;
/** Same floor, in the seconds unit `discoveryInterval` is configured in. */
export const MIN_DISCOVERY_INTERVAL_SECONDS = DISCOVERY_MIN_INTERVAL / 1000;

/**
 * When to stop absorbing duplicates for this device.
 *
 * Never past the moment the rate limiter would let a new probe transmit: that
 * probe's own genuine reply arrives just after it, and absorbing that is
 * strictly worse than letting a late duplicate through. Before the limiter
 * existed the next probe could open at any time, so the fixed window was as
 * good a guess as any; now the earliest it can open is known exactly.
 */
function duplicateAbsorbDeadline(wiz: HomebridgeWizLan, mac: string): number {
  const nextProbeEarliest =
    (lastProbeTransmit[mac] ?? -Infinity) + probeMinInterval(wiz, mac);
  return Math.min(Date.now() + DUPLICATE_REPLY_WINDOW, nextProbeEarliest);
}

type ProbeCallback = (error: Error | null, pilot: any) => void;

export interface GetPilotOptions {
  /**
   * Arm the retransmit for this probe. Pass true only when the caller has no
   * cached state to fall back on, i.e. when HomeKit is genuinely blocked on
   * the reply — otherwise the extra copy is invisible and only adds load.
   */
  retransmit?: boolean;
  /**
   * Invoked synchronously immediately before the probe is put on the wire.
   * Probes can be deferred by the rate limiter, so callers that need to
   * snapshot state "as of transmission" (see writeGeneration in the accessory
   * layer) must do it here rather than when they call getPilot.
   */
  onTransmit?: () => void;
}

const getPilotQueue: {
  [mac: string]: {
    callbacks: ProbeCallback[];
    timers: NodeJS.Timeout[];
    retransmitted?: boolean;
  };
} = {};

// Wall-clock of the last probe actually transmitted per device, and the probes
// currently waiting out the rate limiter.
const lastProbeTransmit: { [mac: string]: number } = {};
const deferredProbes: {
  [mac: string]: {
    callbacks: ProbeCallback[];
    retransmit: boolean;
    onTransmit?: () => void;
    timer: NodeJS.Timeout;
  };
} = {};

/** Minimum gap between transmitted probes for this device. */
function probeMinInterval(wiz: HomebridgeWizLan, mac: string): number {
  if (!isOffline(mac)) {
    return GET_PILOT_MIN_INTERVAL;
  }
  // Honour a refreshInterval shorter than the offline ceiling — the user asked
  // for that cadence, and it is bounded and self-paced, unlike per-read probing.
  const refresh = Number(wiz.config.refreshInterval ?? 0) * 1000;
  const backoff =
    refresh > 0
      ? Math.min(OFFLINE_GET_PILOT_MIN_INTERVAL, refresh)
      : OFFLINE_GET_PILOT_MIN_INTERVAL;
  return Math.max(GET_PILOT_MIN_INTERVAL, backoff);
}

export function getPilot<T>(
  wiz: HomebridgeWizLan,
  device: Device,
  callback: (error: Error | null, pilot: T) => void,
  options: GetPilotOptions = {}
) {
  if (device.mac in getPilotQueue) {
    // Piggyback on the already in-flight request — no extra UDP packet sent
    getPilotQueue[device.mac].callbacks.push(callback);
    return;
  }

  if (device.mac in deferredProbes) {
    // A probe is already waiting out the rate limiter — join it rather than
    // arming a second one. It transmits with the union of the joiners' needs.
    const deferred = deferredProbes[device.mac];
    deferred.callbacks.push(callback);
    deferred.retransmit = deferred.retransmit || options.retransmit === true;
    deferred.onTransmit = deferred.onTransmit ?? options.onTransmit;
    return;
  }

  const minInterval = probeMinInterval(wiz, device.mac);
  const sinceLast = Date.now() - (lastProbeTransmit[device.mac] ?? -Infinity);
  if (sinceLast < minInterval) {
    const wait = minInterval - sinceLast;
    wiz.log.debug(
      `[getPilot] Throttling probe to ${device.mac}, transmitting in ${wait}ms`
    );
    const timer = setTimeout(() => {
      const deferred = deferredProbes[device.mac];
      if (typeof deferred === "undefined") {
        return;
      }
      delete deferredProbes[device.mac];
      transmitGetPilot(
        wiz,
        device,
        deferred.callbacks,
        deferred.retransmit,
        deferred.onTransmit
      );
    }, wait);
    // A throttled probe must not keep the Node process alive on shutdown.
    timer.unref?.();
    deferredProbes[device.mac] = {
      callbacks: [callback],
      retransmit: options.retransmit === true,
      onTransmit: options.onTransmit,
      timer,
    };
    return;
  }

  transmitGetPilot(
    wiz,
    device,
    [callback],
    options.retransmit === true,
    options.onTransmit
  );
}

function transmitGetPilot(
  wiz: HomebridgeWizLan,
  device: Device,
  callbacks: ProbeCallback[],
  retransmit: boolean,
  onTransmit?: () => void
) {
  const msg = `{"method":"getPilot","params":{}}`;
  lastProbeTransmit[device.mac] = Date.now();
  const deadline = setTimeout(() => {
    if (device.mac in getPilotQueue) {
      const { callbacks, timers } = getPilotQueue[device.mac];
      timers.forEach(clearTimeout);
      delete getPilotQueue[device.mac];
      // One shared Error instance for the whole probe — recordFailureOnce
      // dedupes on it so one dropped packet counts as one failure, not one
      // per coalesced callback
      const error = new Error(`No response from ${device.mac} within 1s`);
      callbacks.forEach((f) => f(error, null as any));
    }
  }, GET_PILOT_TIMEOUT);
  const retransmits = (retransmit ? GET_PILOT_RETRANSMIT_DELAYS : []).map(
    (delay) =>
      setTimeout(() => {
        if (device.mac in getPilotQueue) {
          // Two copies are now on the wire — the reply handler uses this to
          // absorb a possible second answer after the probe resolves.
          getPilotQueue[device.mac].retransmitted = true;
          wiz.log.debug(`[getPilot] Retransmitting getPilot to ${device.mac}`);
          // Send errors here are ignored — the deadline timer reports failure
          wiz.socket.send(msg, BROADCAST_PORT, device.ip);
        }
      }, delay)
  );
  getPilotQueue[device.mac] = {
    callbacks,
    timers: [deadline, ...retransmits],
  };
  // Before the send, so callers snapshotting "state as of transmission" see a
  // consistent view even though the rate limiter may have deferred us here.
  onTransmit?.();
  wiz.log.debug(`[getPilot] Sending getPilot to ${device.mac}`);
  wiz.socket.send(
    msg,
    BROADCAST_PORT,
    device.ip,
    (error: Error | null) => {
      if (error !== null && device.mac in getPilotQueue) {
        const { callbacks, timers } = getPilotQueue[device.mac];
        timers.forEach(clearTimeout);
        wiz.log.debug(
          `[Socket] Failed to send getPilot to ${device.mac}: ${error.toString()}`
        );
        delete getPilotQueue[device.mac];
        callbacks.forEach((f) => f(error, null as any));
      }
    }
  );
}

/**
 * True when a probe for this device already exists — either on the wire or
 * deferred by the rate limiter — so a getPilot call would coalesce onto it
 * rather than transmit a new packet.
 */
export function hasInFlightGetPilot(mac: string): boolean {
  return mac in getPilotQueue || mac in deferredProbes;
}

const setPilotQueue: {
  [ip: string]: {
    callbacks: ((error: Error | null) => void)[];
    timeout: NodeJS.Timeout;
  };
} = {};
const setPilotPending: {
  [ip: string]: {
    wiz: HomebridgeWizLan;
    device: Device;
    pilot: Partial<BulbPilot> | Partial<SocketPilot>;
    callbacks: ((error: Error | null) => void)[];
  };
} = {};

export function setPilot(
  wiz: HomebridgeWizLan,
  device: Device,
  pilot: Partial<BulbPilot> | Partial<SocketPilot>,
  callback: (error: Error | null) => void
) {
  if (device.ip in setPilotQueue) {
    // In-flight: coalesce into pending, keeping all accumulated callbacks
    const existing = setPilotPending[device.ip];
    setPilotPending[device.ip] = {
      wiz,
      device,
      pilot,
      callbacks: [...(existing?.callbacks ?? []), callback],
    };
    return;
  }
  sendSetPilot(wiz, device, pilot, [callback]);
}

function sendSetPilot(
  wiz: HomebridgeWizLan,
  device: Device,
  pilot: Partial<BulbPilot> | Partial<SocketPilot>,
  callbacks: ((error: Error | null) => void)[]
) {
  const msg = JSON.stringify({
    method: "setPilot",
    env: "pro",
    params: Object.assign({ mac: device.mac, src: "udp" }, pilot),
  });
  // Without this deadline a lost ack leaves the queue entry in place forever:
  // the HomeKit callback never resolves and every later command for this
  // device parks in setPilotPending without ever being transmitted.
  const timeout = setTimeout(() => {
    if (device.ip in setPilotQueue) {
      const { callbacks: cbs } = setPilotQueue[device.ip];
      delete setPilotQueue[device.ip];
      cbs.forEach((f) =>
        f(new Error(`No setPilot response from ${device.ip} within 2s`))
      );
      flushPendingSetPilot(device.ip);
    }
  }, SET_PILOT_TIMEOUT);
  setPilotQueue[device.ip] = { callbacks, timeout };
  wiz.log.debug(`[SetPilot][${device.ip}:${BROADCAST_PORT}] ${msg}`);
  wiz.socket.send(msg, BROADCAST_PORT, device.ip, (error: Error | null) => {
    if (error !== null && device.ip in setPilotQueue) {
      wiz.log.debug(
        `[Socket] Failed to send setPilot to ${device.ip}: ${error.toString()}`
      );
      const { callbacks: cbs, timeout: pendingTimeout } =
        setPilotQueue[device.ip];
      clearTimeout(pendingTimeout);
      delete setPilotQueue[device.ip];
      cbs.forEach((f) => f(error));
      flushPendingSetPilot(device.ip);
    }
  });
}

function flushPendingSetPilot(ip: string) {
  if (ip in setPilotPending) {
    const { wiz, device, pilot, callbacks } = setPilotPending[ip];
    delete setPilotPending[ip];
    sendSetPilot(wiz, device, pilot, callbacks);
  }
}

export function createSocket(wiz: HomebridgeWizLan) {
  const log = makeLogger(wiz, "Socket");

  const socket = dgram.createSocket("udp4");

  socket.on("error", (err) => {
    log.error(`UDP Error: ${err}`);
  });

  socket.on("message", (msg, rinfo) => {
    const decryptedMsg = msg.toString("utf8");
    log.debug(
      `[${rinfo.address}:${rinfo.port}] Received message: ${decryptedMsg}`
    );
  });

  wiz.api.on("shutdown", () => {
    log.debug("Shutting down socket");
    // A throttled probe can sit for as long as the offline backoff before it
    // transmits. Drop those first: firing one after close() would try to send
    // on a dead socket.
    for (const mac of Object.keys(deferredProbes)) {
      clearTimeout(deferredProbes[mac].timer);
      delete deferredProbes[mac];
    }
    socket.close();
  });

  return socket;
}

export function bindSocket(wiz: HomebridgeWizLan, onReady: () => void) {
  const log = makeLogger(wiz, "Socket");
  const { PORT, ADDRESS } = getNetworkConfig(wiz);
  log.info(`Setting up socket on ${ADDRESS ?? "0.0.0.0"}:${PORT}`);
  wiz.socket.bind(PORT, ADDRESS, () => {
    const sockAddress = wiz.socket.address();
    log.debug(
      `Socket Bound: UDP ${sockAddress.family} listening on ${sockAddress.address}:${sockAddress.port}`
    );
    wiz.socket.setBroadcast(true);
    onReady();
  });
}

export function registerDiscoveryHandler(
  wiz: HomebridgeWizLan,
  addDevice: (device: Device) => void
) {
  const log = makeLogger(wiz, "Discovery");

  log.debug("Initiating discovery handlers");

  try {
    wiz.socket.on("message", (msg, rinfo) => {
      const decryptedMsg = msg.toString("utf8");
      let response: any;
      const ip = rinfo.address;
      try {
        response = JSON.parse(decryptedMsg);
      } catch (err) {
        log.debug(
          `Error parsing JSON: ${err}\nFrom: ${rinfo.address} ${rinfo.port} Original: [${msg}] Decrypted: [${decryptedMsg}]`
        );
        return;
      }
      if (response.method === "registration") {
        // WiZ firmware answers some requests with {error:{...}} and no
        // result; reading result.mac unguarded would throw inside the dgram
        // handler and crash Homebridge.
        const mac = response.result?.mac;
        if (typeof mac !== "string") {
          log.debug(`[${ip}] Ignoring registration reply without result.mac`);
          return;
        }
        // Any registration reply means the bulb just responded on the network,
        // so any prior failure streak is no longer valid.
        recordSuccess(mac);
        log.debug(`[${ip}@${mac}] Sending config request (getSystemConfig)`);
        // Send system config request
        wiz.socket.send(
          `{"method":"getSystemConfig","params":{}}`,
          BROADCAST_PORT,
          ip
        );
      } else if (response.method === "getSystemConfig") {
        const mac = response.result?.mac;
        if (typeof mac !== "string") {
          log.debug(`[${ip}] Ignoring getSystemConfig reply without result.mac`);
          return;
        }
        recordSuccess(mac);
        log.debug(`[${ip}@${mac}] Received config`);
        addDevice({
          ip,
          mac,
          model: response.result.moduleName,
        });
      } else if (response.method === "getPilot") {
        const mac = response.result?.mac;
        if (typeof mac !== "string") {
          // Error reply — the open probe (if any) falls through to its
          // deadline instead of crashing the handler.
          log.debug(`[${ip}] Ignoring getPilot reply without result.mac`);
          return;
        }
        const owed = (duplicateReplyDeadlines[mac] ?? []).filter(
          (deadline) => deadline > Date.now()
        );
        if (owed.length > 0) {
          // A retransmitted probe already got its answer; this is most likely
          // the bulb answering the second copy, carrying state older than the
          // probe currently open (and older than any write since).
          owed.shift();
          duplicateReplyDeadlines[mac] = owed;
          log.debug(`[getPilot] Absorbing probable duplicate reply from ${mac}`);
          return;
        }
        delete duplicateReplyDeadlines[mac];
        if (mac in getPilotQueue) {
          const { callbacks, timers, retransmitted } = getPilotQueue[mac];
          timers.forEach(clearTimeout);
          delete getPilotQueue[mac];
          if (retransmitted) {
            duplicateReplyDeadlines[mac] = [duplicateAbsorbDeadline(wiz, mac)];
          }
          callbacks.forEach((f) => f(null, response.result));
        }
        // A reply landing after the deadline is dropped deliberately: crediting
        // it (recordSuccess) would let a device with sustained >1s RTT reset
        // the failure streak on every probe while its stale reply is discarded
        // — never marked offline, yet cache-first would serve frozen state
        // forever. Better that such a device truthfully goes "No Response".
      } else if (response.method === "setPilot") {
        const ip = rinfo.address;
        if (ip in setPilotQueue) {
          const { callbacks, timeout } = setPilotQueue[ip];
          clearTimeout(timeout);
          delete setPilotQueue[ip];
          callbacks.map((f) =>
            f(response.error ? new Error(response.error.toString()) : null)
          );
          flushPendingSetPilot(ip);
        }
      }
    });
  } catch (err) {
    log.error(`Error: ${err}`);
  }
}

let lastDiscoveryBroadcast = -Infinity;

export function sendDiscoveryBroadcast(service: HomebridgeWizLan) {
  const { ADDRESS, MAC, BROADCAST } = getNetworkConfig(service);

  const log = makeLogger(service, "Discovery");

  const sinceLast = Date.now() - lastDiscoveryBroadcast;
  if (sinceLast < DISCOVERY_MIN_INTERVAL) {
    // Unlike a unicast probe there is nothing to defer onto — the next tick
    // will re-broadcast anyway, and skipping one costs only latency in
    // noticing a device that appeared in the last few seconds.
    log.debug(
      `Skipping discovery broadcast: last one was ${sinceLast}ms ago ` +
        `(minimum ${DISCOVERY_MIN_INTERVAL}ms)`
    );
    return;
  }
  lastDiscoveryBroadcast = Date.now();
  // Debug-level because this now fires every `refreshInterval` tick as well
  // as on startup; at info it flooded the log with one line per listed
  // device per tick. Same rationale as the refresh-ping log downgrade
  // in #141.
  log.debug(`Sending discovery UDP broadcast to ${BROADCAST}:${BROADCAST_PORT}`);

  // Send generic discovery message
  service.socket.send(
    `{"method":"registration","params":{"phoneMac":"${MAC}","register":false,"phoneIp":"${ADDRESS}"}}`,
    BROADCAST_PORT,
    BROADCAST
  );

  // Send discovery message to listed devices
  if (Array.isArray(service.config.devices)) {
    for (const device of service.config.devices) {
      if (device.host) {
        log.debug(`Sending discovery UDP broadcast to ${device.host}:${BROADCAST_PORT}`);
        service.socket.send(
          `{"method":"registration","params":{"phoneMac":"${MAC}","register":false,"phoneIp":"${ADDRESS}"}}`,
          BROADCAST_PORT,
          device.host
        );
      }
    }
  }
}

/**
 * Clears the rate limiter's memory of what was sent when. Exists for tests:
 * the throttles are keyed on wall-clock time in module scope, so without this
 * one test's transmissions would silence the next one's.
 */
export function resetRateLimitsForTesting() {
  lastDiscoveryBroadcast = -Infinity;
  for (const mac of Object.keys(lastProbeTransmit)) {
    delete lastProbeTransmit[mac];
  }
  for (const mac of Object.keys(deferredProbes)) {
    clearTimeout(deferredProbes[mac].timer);
    delete deferredProbes[mac];
  }
}
