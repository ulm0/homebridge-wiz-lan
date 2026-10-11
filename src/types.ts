import { PlatformConfig } from "homebridge";

export interface SpaceSenseConfig {
  enabled?: boolean;
  sensorType?: "occupancy" | "motion";
  /** Seconds after which a detection clears on its own; 0 = never. */
  timeout?: number;
  occupancySources?: string[];
  vacancySources?: string[];
}

export interface Config extends PlatformConfig {
  port?: number;
  mac?: string;
  spaceSense?: SpaceSenseConfig;
  enableScenes?: boolean;
  lastStatus?: boolean;
  broadcast?: string;
  address?: string;
  devices?: { host?: string; mac?: string; name?: string }[];
  ignoredDevices?: { host?: string; mac?: string }[];
  refreshInterval?: number;
  discoveryInterval?: number;
  pingFailuresBeforeOffline?: number;
}
export interface Device {
  model: string;
  ip: string;
  mac: string;

  lastSelectedSceneId?: number;
}
