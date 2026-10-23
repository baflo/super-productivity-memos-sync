// Helpers taken from Super Productivity's packages/plugin-dev/issue-provider-kit
// (MIT, Copyright (c) 2018 Johannes Millan, see types/plugin-api/LICENSE).
// Bundled into the plugin by esbuild; not part of the public PluginAPI.
import type {
  IssueProviderPluginDefinition,
  PluginAPI as PluginAPIType,
  PluginFieldMapping,
} from '@super-productivity/plugin-api';

declare const PluginAPI: PluginAPIType;

export const registerIssueProvider = (definition: IssueProviderPluginDefinition): void =>
  PluginAPI.registerIssueProvider(definition);

/** Translates a plugin i18n key, falling back to the key itself. */
export const t = (key: string, params?: Record<string, string | number>): string => {
  try {
    return PluginAPI.translate(key, params);
  } catch {
    return key;
  }
};

/** Types the untyped config record the host passes to every provider method. */
export const asConfig = <T>(config: Record<string, unknown>): T => config as unknown as T;

/** For `testConnection`: true when the request resolves (and passes `isOk`). */
export const canConnect = async (
  request: () => Promise<unknown>,
  isOk: (response: unknown) => boolean = () => true,
): Promise<boolean> => {
  try {
    return isOk(await request());
  } catch {
    return false;
  }
};

/** Maps a text task field 1:1 to an issue field (missing → ''). */
export const textMapping = (
  taskField: PluginFieldMapping['taskField'],
  issueField: string,
  defaultDirection: PluginFieldMapping['defaultDirection'] = 'pullOnly',
): PluginFieldMapping => ({
  taskField,
  issueField,
  defaultDirection,
  toIssueValue: (taskValue: unknown): string => (taskValue as string) ?? '',
  toTaskValue: (issueValue: unknown): string => (issueValue as string) ?? '',
});
