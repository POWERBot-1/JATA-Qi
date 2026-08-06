// TANYA Mobile — controller wiring.
//
// Builds the MobileAppController once per configuration change and persists the
// app configuration (base URL, push token, IdP credentials) in AsyncStorage via
// the MobileAppStorage adapter. All screens talk to `getController()`.

import { MobileAppController, type MobileAppStorage } from '@jataqi/mobile-app';
import { AsyncStorage } from '@react-native-async-storage/async-storage';

const KEYS = {
  baseUrl: 'tanya.baseUrl',
  pushToken: 'tanya.pushToken',
  deviceName: 'tanya.deviceName',
  idp: 'tanya.idp',
};

export interface IdpCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface AppConfig {
  baseUrl: string;
  pushToken?: string;
  deviceName?: string;
  idp?: IdpCredentials;
}

/** AsyncStorage-backed MobileAppStorage (platform adapter for the controller). */
export class AsyncStorageAdapter implements MobileAppStorage {
  async get(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  }
  async set(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  }
  async remove(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  }
}

const storage = new AsyncStorageAdapter();

export async function loadConfig(): Promise<AppConfig> {
  const [baseUrl, pushToken, deviceName, idpRaw] = await Promise.all([
    AsyncStorage.getItem(KEYS.baseUrl),
    AsyncStorage.getItem(KEYS.pushToken),
    AsyncStorage.getItem(KEYS.deviceName),
    AsyncStorage.getItem(KEYS.idp),
  ]);
  return {
    baseUrl: baseUrl ?? 'http://localhost:7400',
    ...(pushToken ? { pushToken } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(idpRaw ? { idp: JSON.parse(idpRaw) as IdpCredentials } : {}),
  };
}

export async function saveConfig(cfg: Partial<AppConfig>): Promise<void> {
  if (cfg.baseUrl !== undefined) await AsyncStorage.setItem(KEYS.baseUrl, cfg.baseUrl);
  if (cfg.pushToken !== undefined) {
    if (cfg.pushToken) await AsyncStorage.setItem(KEYS.pushToken, cfg.pushToken);
    else await AsyncStorage.removeItem(KEYS.pushToken);
  }
  if (cfg.deviceName !== undefined) await AsyncStorage.setItem(KEYS.deviceName, cfg.deviceName);
  if (cfg.idp !== undefined) {
    await AsyncStorage.setItem(KEYS.idp, JSON.stringify(cfg.idp));
  }
}

let controller: MobileAppController | null = null;

/**
 * Build (or rebuild) the controller from persisted config, optionally merging
 * overrides. Returns the active instance.
 */
export async function buildController(overrides: Partial<AppConfig> = {}): Promise<MobileAppController> {
  const cfg = { ...(await loadConfig()), ...overrides };
  await saveConfig(overrides);
  controller?.close();
  controller = new MobileAppController({
    baseUrl: cfg.baseUrl,
    storage,
    platform: 'ios',
    pushToken: cfg.pushToken,
    deviceName: cfg.deviceName ?? 'TANYA Reference App',
    locale: 'en',
    idp: cfg.idp,
  });
  return controller;
}

export function getController(): MobileAppController {
  if (!controller) throw new Error('controller not built — call buildController() first');
  return controller;
}
