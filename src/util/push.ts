import dgram, { Socket } from "dgram";
import { PlatformAccessory } from "homebridge";

import { Device } from "../types";
import HomebridgeWizLan from "../wiz";
import { makeLogger } from "./logger";
import { BROADCAST_PORT, getNetworkConfig } from "./network";

// ---------------------------------------------------------------------------
// Push updates (syncPilot)
//
// A bulb only tells anyone about a state change it made on its own — a WiZ app
// automation such as SpaceSense, a WiZmote, the PIR accessory — if that host
// has subscribed with `registration` + `register:true`. Subscribed hosts then
// receive a `syncPilot` datagram on UDP 38900 (fixed: the request carries no
// port, and pywizlight/HA rely on this by registering from an ephemeral socket)
// for every change, plus periodic `src:"hb"` heartbeats.
//
// The subscription lapses on its own within ~20-30s (undocumented; reports
// vary), so it has to be renewed. WiZ's own local-control library renews
// every 15s; pywizlight every 20s.
// ---------------------------------------------------------------------------

/** Where bulbs deliver syncPilot, regardless of where registration came from. */
export const PUSH_PORT = 38900;
const REGISTRATION_INTERVAL = 15_000;
// Same idea as the refresh sweep's stagger in wiz.ts: never put one packet per
// bulb on the wire in a single tick.
const REGISTRATION_STAGGER_MAX_MS = 50;
// Discovery sends `register:false` with our identity. Whether that cancels a
// live subscription is unknown, so renew after every discovery — but not in
// the same tick: the discovery packet is a broadcast, which power-saving
// Wi-Fi clients only receive at the next DTIM beacon, so a unicast renewal
// sent alongside it can reach the bulb first and then be cancelled by it.
const RENEW_AFTER_DISCOVERY_DELAY = 2000;
// Long enough for several renewals and heartbeats; if nothing at all has
// arrived by then, pushes are not reaching us and the user should know why.
const NO_PUSH_WARNING_DELAY = 60_000;

export interface SyncPilotParams {
  mac: string;
  src?: string;
  state?: boolean;
  dimming?: number;
  [key: string]: unknown;
}

type SyncPilotHandler = (params: SyncPilotParams) => void;

// Keyed by normalized MAC. The accessory (not a Device snapshot) is kept so
// each renewal reads the current context — tryAddDevice replaces the context
// object when a bulb comes back on a new DHCP lease.
const targets: {
  [mac: string]: { accessory: PlatformAccessory; handler: SyncPilotHandler };
} = {};
const seenSources: Set<string> = new Set();
const rejectedRegistration: Set<string> = new Set();
let pushReceived = false;
let renewAfterDiscoveryTimer: NodeJS.Timeout | undefined;
let renewNow: (() => void) | undefined;

export function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, "");
}

export function isSpaceSenseEnabled(wiz: HomebridgeWizLan): boolean {
  return wiz.config.spaceSense?.enabled === true;
}

/**
 * Subscribes `accessory` to pushes: its bulb is included in every renewal and
 * `handler` receives each syncPilot it sends.
 */
export function registerPushTarget(
  accessory: PlatformAccessory,
  handler: SyncPilotHandler
) {
  const { mac } = accessory.context as Device;
  targets[normalizeMac(mac)] = { accessory, handler };
}

export function handleSyncPilot(wiz: HomebridgeWizLan, params: unknown, ip: string) {
  const log = makeLogger(wiz, "SpaceSense");
  if (typeof params !== "object" || params === null) {
    return;
  }
  const { mac, src } = params as Partial<SyncPilotParams>;
  if (typeof mac !== "string") {
    return;
  }
  if (!pushReceived) {
    pushReceived = true;
    log.info(`Receiving push updates (first from ${ip})`);
  }
  if (typeof src === "string" && !seenSources.has(src)) {
    // Only a handful of values exist, and which one a given firmware uses for
    // SpaceSense is still being mapped — surface each the first time it shows.
    seenSources.add(src);
    log.info(`First push with src "${src}" (from ${mac})`);
  }
  const target = targets[normalizeMac(mac)];
  if (typeof target === "undefined") {
    log.debug(`Ignoring push from untracked device ${mac}`);
    return;
  }
  target.handler(params as SyncPilotParams);
}

function listen(wiz: HomebridgeWizLan, socket: Socket) {
  socket.on("message", (msg, rinfo) => {
    const text = msg.toString("utf8");
    // Every datagram on the main socket passes through here too; skip the
    // parse for the ones that can't be a push.
    if (!text.includes("syncPilot")) {
      return;
    }
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    // Bulbs only ever push syncPilot as a request (params). A reply to one
    // (result) is something else entirely and must not be read as state.
    if (message?.method === "syncPilot" && message.params !== undefined) {
      handleSyncPilot(wiz, message.params, rinfo.address);
    }
  });
}

/**
 * Starts the subscription loop. Pushes are read off the main socket when it is
 * already bound to 38900 (the default); otherwise a dedicated listener is
 * bound there. Renewals always go out from their own ephemeral socket so
 * their replies never reach the discovery handler, which treats every
 * registration reply as a newly found bulb.
 */
export function startPushUpdates(wiz: HomebridgeWizLan) {
  const log = makeLogger(wiz, "SpaceSense");
  const { ADDRESS, PORT, MAC } = getNetworkConfig(wiz);

  let listener: Socket | undefined;
  if (Number(PORT) === PUSH_PORT) {
    listen(wiz, wiz.socket);
  } else {
    listener = dgram.createSocket("udp4");
    listener.on("error", (error: NodeJS.ErrnoException) => {
      log.warn(
        `Cannot listen for push updates on UDP ${PUSH_PORT} (${error.code ?? error.message}). ` +
          `Bulbs always deliver pushes to port ${PUSH_PORT}; free it (is Home Assistant's WiZ ` +
          `integration running on this host?) or set "port" to ${PUSH_PORT}.`
      );
      listener?.close();
      listener = undefined;
    });
    listen(wiz, listener);
    listener.bind(PUSH_PORT, ADDRESS);
  }

  const sender = dgram.createSocket("udp4");
  sender.on("error", (error) => {
    log.warn(`Push registration socket error: ${error}`);
  });
  sender.on("message", (msg, rinfo) => {
    let reply: any;
    try {
      reply = JSON.parse(msg.toString("utf8"));
    } catch {
      return;
    }
    if (reply?.method !== "registration") {
      return;
    }
    if (reply.error !== undefined) {
      if (!rejectedRegistration.has(rinfo.address)) {
        rejectedRegistration.add(rinfo.address);
        log.warn(
          `${rinfo.address} rejected the push registration: ${JSON.stringify(reply.error)}`
        );
      }
      return;
    }
    rejectedRegistration.delete(rinfo.address);
    log.debug(`${rinfo.address} accepted the push registration`);
  });
  sender.bind(0, ADDRESS);

  const message = JSON.stringify({
    method: "registration",
    params: {
      phoneIp: ADDRESS,
      register: true,
      // Every known client sends this as 12 lowercase hex digits.
      phoneMac: normalizeMac(String(MAC)),
    },
  });

  let staggered: NodeJS.Timeout[] = [];
  const renew = () => {
    staggered.forEach(clearTimeout);
    staggered = [];
    const ips = Object.values(targets).map(
      ({ accessory }) => (accessory.context as Device).ip
    );
    const spacing = Math.min(
      REGISTRATION_STAGGER_MAX_MS,
      REGISTRATION_INTERVAL / Math.max(ips.length, 1)
    );
    ips.forEach((ip, index) => {
      const send = () => sender.send(message, BROADCAST_PORT, ip);
      if (index === 0) {
        send();
        return;
      }
      const timer = setTimeout(send, Math.round(index * spacing));
      timer.unref?.();
      staggered.push(timer);
    });
  };
  renewNow = renew;

  log.info(
    `Subscribing to push updates from ${Object.keys(targets).length} bulb(s) every ${REGISTRATION_INTERVAL / 1000}s`
  );
  renew();
  const interval = setInterval(renew, REGISTRATION_INTERVAL);

  const warning = setTimeout(() => {
    if (!pushReceived && Object.keys(targets).length > 0) {
      log.warn(
        `No push updates received after ${NO_PUSH_WARNING_DELAY / 1000}s. Bulbs deliver them to ` +
          `${ADDRESS}:${PUSH_PORT} — check that this is the address the bulbs can reach (set ` +
          `"address" if not), that no firewall blocks inbound UDP ${PUSH_PORT}, and that the ` +
          `bulbs are on the same subnet.`
      );
    }
  }, NO_PUSH_WARNING_DELAY);
  warning.unref?.();

  wiz.api.on("shutdown", () => {
    clearInterval(interval);
    clearTimeout(warning);
    clearTimeout(renewAfterDiscoveryTimer);
    staggered.forEach(clearTimeout);
    renewNow = undefined;
    sender.close();
    listener?.close();
  });
}

/** Re-subscribe shortly after a discovery broadcast — see the delay's comment. */
export function renewPushAfterDiscovery() {
  if (typeof renewNow === "undefined") {
    return;
  }
  clearTimeout(renewAfterDiscoveryTimer);
  renewAfterDiscoveryTimer = setTimeout(
    () => renewNow?.(),
    RENEW_AFTER_DISCOVERY_DELAY
  );
  renewAfterDiscoveryTimer.unref?.();
}

/** Clears module-scope state between tests. */
export function resetPushForTesting() {
  for (const mac of Object.keys(targets)) {
    delete targets[mac];
  }
  seenSources.clear();
  rejectedRegistration.clear();
  pushReceived = false;
  clearTimeout(renewAfterDiscoveryTimer);
  renewAfterDiscoveryTimer = undefined;
  renewNow = undefined;
}
