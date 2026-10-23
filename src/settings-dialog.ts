// The plugin's settings dialog, opened from the gear icon in SP's plugin list
// (registerConfigHandler). It replaces SP's schema form so the token can be
// edited next to the other settings while staying in device-local storage.
import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';
import { t } from '../../issue-provider-kit';
import { isBlockedByHost, normalizeBaseUrl } from './memos-client';
import {
  currentAppUrl,
  DEFAULT_SETTINGS,
  getToken,
  loadStoredSettings,
  saveSettings,
  TOKEN_SECRET_KEY,
} from './settings';
import type { Settings } from './settings';

declare const PluginAPI: PluginAPIType;

const ID = 'memos-cfg-';
const TOKEN_ID = `${ID}token`;
const TOKEN_REMOVE_ID = `${ID}token-remove`;

const esc = (str: string): string =>
  str.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const hint = (text: string): string =>
  `<small style="display:block;opacity:.7;margin-top:2px">${esc(text)}</small>`;

const fieldStyle = 'display:block;width:100%;box-sizing:border-box;margin-top:4px';

const textField = (
  key: keyof Settings,
  value: string,
  type = 'text',
  placeholder = '',
): string =>
  `<label style="display:block;margin:12px 0">${esc(t(`SETTINGS.${key}`))}` +
  `<input id="${ID}${key}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" style="${fieldStyle}">` +
  `</label>` +
  hint(t(`SETTINGS.${key}_HINT`));

const checkbox = (key: keyof Settings, checked: boolean, withHint = true): string =>
  `<label style="display:flex;gap:8px;align-items:center;margin:12px 0 0">` +
  `<input id="${ID}${key}" type="checkbox"${checked ? ' checked' : ''}> ${esc(t(`SETTINGS.${key}`))}</label>` +
  (withHint ? hint(t(`SETTINGS.${key}_HINT`)) : '');

const select = (key: keyof Settings, value: string, options: string[]): string =>
  `<label style="display:block;margin:12px 0">${esc(t(`SETTINGS.${key}`))}` +
  `<select id="${ID}${key}" style="${fieldStyle}">` +
  options
    .map(
      (o) =>
        `<option value="${o}"${o === value ? ' selected' : ''}>${esc(t(`SETTINGS.${key}_${o}`))}</option>`,
    )
    .join('') +
  `</select></label>`;

const section = (title: string): string =>
  `<h4 style="margin:20px 0 4px">${esc(title)}</h4>`;

const byId = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const readText = (key: keyof Settings): string =>
  byId<HTMLInputElement | HTMLSelectElement>(`${ID}${key}`)?.value.trim() ?? '';

const readChecked = (key: keyof Settings): boolean =>
  !!byId<HTMLInputElement>(`${ID}${key}`)?.checked;

const readForm = (): Partial<Settings> => ({
  baseUrl: normalizeBaseUrl(readText('baseUrl')),
  spBaseUrl: readText('spBaseUrl'),
  noteSyncEnabled: readChecked('noteSyncEnabled'),
  syncSpace: readText('syncSpace'),
  syncTag: readText('syncTag'),
  visibility: readText('visibility') as Settings['visibility'],
  pullIntervalMinutes: Number(readText('pullIntervalMinutes')) || undefined,
  onTaskDelete: readText('onTaskDelete') as Settings['onTaskDelete'],
  syncOtherProviderTasks: readChecked('syncOtherProviderTasks'),
});

/** Reads the form while the dialog's DOM still exists; stores settings and token. */
const save = async (): Promise<void> => {
  const settings = readForm();
  const token = byId<HTMLInputElement>(TOKEN_ID)?.value.trim() ?? '';
  await saveSettings(settings);
  if (token) {
    await PluginAPI.setSecret(TOKEN_SECRET_KEY, token);
  }
  PluginAPI.showSnack({
    msg:
      settings.baseUrl && isBlockedByHost(settings.baseUrl)
        ? t('ERRORS.BLOCKED_HOST')
        : t('SETTINGS.SAVED'),
    type: settings.baseUrl && isBlockedByHost(settings.baseUrl) ? 'WARNING' : 'SUCCESS',
  });
};

/**
 * Waits for an element of the just-opened dialog. SP's sanitizer strips
 * inline handlers from dialog HTML, so plugin.js attaches them itself.
 */
const whenRendered = (
  id: string,
  attach: (el: HTMLElement) => void,
  framesLeft = 60,
): void => {
  const el = byId(id);
  if (el) {
    attach(el);
  } else if (framesLeft > 0) {
    requestAnimationFrame(() => whenRendered(id, attach, framesLeft - 1));
  }
};

/** Deletes the token right away (an action, not a setting to be saved). */
const removeToken = async (): Promise<void> => {
  await PluginAPI.deleteSecret(TOKEN_SECRET_KEY);
  const input = byId<HTMLInputElement>(TOKEN_ID);
  if (input) {
    input.placeholder = t('SETTINGS.token_PLACEHOLDER_UNSET');
  }
  byId(TOKEN_REMOVE_ID)?.remove();
  PluginAPI.showSnack({ msg: t('SETTINGS.token_REMOVED'), type: 'SUCCESS' });
};

export const openSettingsDialog = async (onSyncNow: () => void): Promise<void> => {
  const stored = await loadStoredSettings();
  const s: Settings = { ...DEFAULT_SETTINGS, ...stored };
  const hasToken = !!(await getToken());
  let syncAfterClose = false;

  const htmlContent =
    section(t('SETTINGS.SECTION_CONNECTION')) +
    textField('baseUrl', s.baseUrl, 'url', 'https://memos.example.com') +
    `<label style="display:block;margin:12px 0" for="${TOKEN_ID}">${esc(t('SETTINGS.token'))}</label>` +
    `<div style="display:flex;gap:8px;align-items:stretch">` +
    `<input id="${TOKEN_ID}" type="password" autocomplete="off" placeholder="${esc(
      t(hasToken ? 'SETTINGS.token_PLACEHOLDER_SET' : 'SETTINGS.token_PLACEHOLDER_UNSET'),
    )}" style="flex:1;min-width:0;box-sizing:border-box">` +
    (hasToken
      ? `<button type="button" id="${TOKEN_REMOVE_ID}" style="padding:0 12px;cursor:pointer">${esc(t('SETTINGS.token_REMOVE'))}</button>`
      : '') +
    `</div>` +
    hint(t('SETTINGS.token_HINT')) +
    section(t('SETTINGS.SECTION_NOTES')) +
    checkbox('noteSyncEnabled', s.noteSyncEnabled) +
    textField('syncSpace', s.syncSpace, 'text', 'superprod') +
    textField('syncTag', s.syncTag, 'text', DEFAULT_SETTINGS.syncTag) +
    select('visibility', s.visibility, ['PRIVATE', 'PROTECTED', 'PUBLIC', 'SPACE']) +
    textField('pullIntervalMinutes', String(s.pullIntervalMinutes), 'number') +
    select('onTaskDelete', s.onTaskDelete, ['nothing', 'archive', 'delete']) +
    checkbox('syncOtherProviderTasks', s.syncOtherProviderTasks, false) +
    textField('spBaseUrl', s.spBaseUrl, 'url', currentAppUrl());

  const dialogClosed = PluginAPI.openDialog({
    title: t('SETTINGS.TITLE'),
    htmlContent,
    buttons: [
      { label: t('DIALOG.CANCEL') },
      {
        label: t('SETTINGS.SAVE_AND_SYNC'),
        icon: 'sync',
        onClick: async () => {
          await save();
          syncAfterClose = true;
        },
      },
      { label: t('SETTINGS.SAVE'), color: 'primary', raised: true, onClick: save },
    ],
  });
  if (hasToken) {
    whenRendered(TOKEN_REMOVE_ID, (btn) => btn.addEventListener('click', removeToken));
  }
  await dialogClosed;
  if (syncAfterClose) {
    onSyncNow();
  }
};
