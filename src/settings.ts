// Plugin-wide settings, edited in the plugin's own settings dialog and stored
// as synced plugin data, and the token, which lives in device-local secret
// storage. A cached copy serves synchronous callers such as getIssueLink.
import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';
import {
  fetchTransport,
  MemosClient,
  normalizeBaseUrl,
  normalizeSpace,
  normalizeTag,
} from './memos-client';
import type { Visibility } from './memos-client';

declare const PluginAPI: PluginAPIType;

export const PLUGIN_ID = 'memos';
export const PROVIDER_KEY = `plugin:${PLUGIN_ID}`;
export const TOKEN_SECRET_KEY = 'token';
const SETTINGS_KEY = 'settings';

export type DeleteBehavior = 'nothing' | 'archive' | 'delete';

export interface Settings {
  baseUrl: string;
  /** Super Productivity address for the task link in note memos. */
  spBaseUrl: string;
  noteSyncEnabled: boolean;
  syncSpace: string;
  syncTag: string;
  visibility: Visibility;
  pullIntervalMinutes: number;
  onTaskDelete: DeleteBehavior;
  syncOtherProviderTasks: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: '',
  spBaseUrl: '',
  noteSyncEnabled: true,
  syncSpace: '',
  syncTag: 'superprod',
  visibility: 'PRIVATE',
  pullIntervalMinutes: 10,
  onTaskDelete: 'nothing',
  syncOtherProviderTasks: true,
};

let cached: Settings = { ...DEFAULT_SETTINGS };

/** The web app's own address; '' in the desktop app (file://), which has no shareable URL. */
export const currentAppUrl = (): string => {
  try {
    const { protocol, origin, pathname } = window.location;
    return protocol === 'http:' || protocol === 'https:'
      ? `${origin}${pathname.replace(/index\.html$/, '')}`
      : '';
  } catch {
    return '';
  }
};

export const getCachedSettings = (): Settings => cached;

const parse = (raw: string | null): Partial<Settings> | null => {
  try {
    return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
  } catch {
    return null;
  }
};

/**
 * Plugin 1.0 kept its settings in SP's schema config form. Takes them over
 * once, and moves a token entered there into secret storage.
 */
const migrateFromSchemaConfig = async (): Promise<Partial<Settings>> => {
  const old = ((await PluginAPI.getConfig<Partial<Settings> & { token?: string }>()) ??
    {}) as Partial<Settings> & { token?: string };
  const { token, ...rest } = old;
  if (token && !(await PluginAPI.getSecret(TOKEN_SECRET_KEY))) {
    await PluginAPI.setSecret(TOKEN_SECRET_KEY, token);
  }
  if (Object.keys(rest).length) {
    await PluginAPI.persistDataSynced(JSON.stringify(rest), SETTINGS_KEY);
  }
  return rest;
};

/** Stored values only, without defaults (what the dialog edits). */
export const loadStoredSettings = async (): Promise<Partial<Settings>> =>
  parse(await PluginAPI.loadSyncedData(SETTINGS_KEY)) ??
  (await migrateFromSchemaConfig());

export const saveSettings = async (settings: Partial<Settings>): Promise<void> => {
  await PluginAPI.persistDataSynced(JSON.stringify(settings), SETTINGS_KEY);
  await loadSettings();
};

export const loadSettings = async (): Promise<Settings> => {
  const raw = await loadStoredSettings();
  const merged: Settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
  merged.spBaseUrl = merged.spBaseUrl || currentAppUrl();
  merged.syncSpace = normalizeSpace(merged.syncSpace);
  merged.syncTag = normalizeTag(merged.syncTag);
  merged.pullIntervalMinutes = Math.max(
    1,
    Number(merged.pullIntervalMinutes) || DEFAULT_SETTINGS.pullIntervalMinutes,
  );
  cached = merged;
  return merged;
};

export const getToken = (): Promise<string | null> =>
  PluginAPI.getSecret(TOKEN_SECRET_KEY);

/** Client for hook-driven code; null when no Memos URL is set. */
export const getFetchClient = async (): Promise<{
  client: MemosClient;
  settings: Settings;
} | null> => {
  const settings = await loadSettings();
  if (!settings.baseUrl) {
    return null;
  }
  return {
    client: new MemosClient(settings.baseUrl, fetchTransport(await getToken())),
    settings,
  };
};
