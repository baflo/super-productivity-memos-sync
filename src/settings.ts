// Plugin-wide settings (config-schema.json form) and the token, which lives in
// device-local secret storage. A cached copy serves synchronous callers such
// as getIssueLink.
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

export type DeleteBehavior = 'nothing' | 'archive' | 'delete';

export interface Settings {
  baseUrl: string;
  /** Super Productivity address for the task link in note memos. */
  spBaseUrl: string;
  /** Fallback only; synced with the config. Prefer the secret. */
  token: string;
  noteSyncEnabled: boolean;
  syncSpace: string;
  syncTag: string;
  visibility: Visibility;
  pullIntervalMinutes: number;
  onTaskDelete: DeleteBehavior;
  syncOtherProviderTasks: boolean;
}

const DEFAULTS: Settings = {
  baseUrl: '',
  spBaseUrl: '',
  token: '',
  noteSyncEnabled: true,
  syncSpace: '',
  syncTag: 'superprod',
  visibility: 'PRIVATE',
  pullIntervalMinutes: 10,
  onTaskDelete: 'nothing',
  syncOtherProviderTasks: true,
};

let cached: Settings = { ...DEFAULTS };

/** The web app's own address; '' in the desktop app (file://), which has no shareable URL. */
const currentAppUrl = (): string => {
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

export const loadSettings = async (): Promise<Settings> => {
  const raw = ((await PluginAPI.getConfig<Partial<Settings>>()) ??
    {}) as Partial<Settings>;
  const merged: Settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
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
    Number(merged.pullIntervalMinutes) || DEFAULTS.pullIntervalMinutes,
  );
  cached = merged;
  return merged;
};

export const getToken = async (settings: Settings): Promise<string | null> =>
  (await PluginAPI.getSecret(TOKEN_SECRET_KEY)) || settings.token || null;

/** Client for hook-driven code; null (with a hint) when not configured. */
export const getFetchClient = async (): Promise<{
  client: MemosClient;
  settings: Settings;
} | null> => {
  const settings = await loadSettings();
  if (!settings.baseUrl) {
    return null;
  }
  const token = await getToken(settings);
  return { client: new MemosClient(settings.baseUrl, fetchTransport(token)), settings };
};
