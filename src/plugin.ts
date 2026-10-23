import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';
import { registerIssueProvider, t } from '../../issue-provider-kit';
import {
  forgetSubtasks,
  onSubtaskDoneChange,
  openCheckboxDialog,
} from './checkbox-subtasks';
import { issueProviderDefinition } from './issue-provider';
import { isBlockedByHost } from './memos-client';
import {
  markLocalEdit,
  onTaskDeleted,
  pullAll,
  reportError,
  schedulePush,
  syncAll,
} from './note-sync';
import { loadSettings, TOKEN_SECRET_KEY } from './settings';
import { invalidate } from './store';

declare const PluginAPI: PluginAPIType;

const TOKEN_INPUT_ID = 'memos-token-input';
const PULL_TICK_MS = 60 * 1000;
const STARTUP_PULL_DELAY_MS = 10 * 1000;
const FOCUS_PULL_MIN_AGE_MS = 60 * 1000;

registerIssueProvider(issueProviderDefinition);

const safe =
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
  (...args: A): void => {
    fn(...args).catch(reportError);
  };

// --- Hooks -----------------------------------------------------------------

PluginAPI.registerHook(PluginAPI.Hooks.TASK_CREATED, ({ taskId, task }) => {
  if (task.notes) {
    schedulePush(taskId);
  }
});

PluginAPI.registerHook(PluginAPI.Hooks.TASK_UPDATE, ({ taskId, task, changes }) => {
  if ('isDone' in changes) {
    safe(onSubtaskDoneChange)(task);
  }
  if ('notes' in changes || 'title' in changes) {
    safe(markLocalEdit)(task);
    schedulePush(taskId);
  }
});

PluginAPI.registerHook(PluginAPI.Hooks.TASK_DELETE, ({ taskId }) => {
  safe(onTaskDeleted)(taskId);
  safe(forgetSubtasks)(taskId);
});

// Another device changed the synced links.
PluginAPI.registerHook(PluginAPI.Hooks.PERSISTED_DATA_CHANGED, () => invalidate());

// --- Menu & context menu ---------------------------------------------------

const openTokenDialog = async (): Promise<void> => {
  const hasToken = !!(await PluginAPI.getSecret(TOKEN_SECRET_KEY));
  const readInput = (): string =>
    (document.getElementById(TOKEN_INPUT_ID) as HTMLInputElement | null)?.value.trim() ??
    '';
  await PluginAPI.openDialog({
    title: t('TOKEN.DIALOG_TITLE'),
    htmlContent:
      `<p>${t(hasToken ? 'TOKEN.DIALOG_TEXT_SET' : 'TOKEN.DIALOG_TEXT_UNSET')}</p>` +
      `<input type="password" id="${TOKEN_INPUT_ID}" autocomplete="off" style="width:100%;box-sizing:border-box">`,
    buttons: [
      { label: t('DIALOG.CANCEL') },
      ...(hasToken
        ? [
            {
              label: t('TOKEN.REMOVE'),
              color: 'warn' as const,
              onClick: async () => {
                await PluginAPI.deleteSecret(TOKEN_SECRET_KEY);
                PluginAPI.showSnack({ msg: t('TOKEN.REMOVED'), type: 'SUCCESS' });
              },
            },
          ]
        : []),
      {
        label: t('TOKEN.SAVE'),
        color: 'primary' as const,
        raised: true,
        onClick: async () => {
          const token = readInput();
          if (token) {
            await PluginAPI.setSecret(TOKEN_SECRET_KEY, token);
            PluginAPI.showSnack({ msg: t('TOKEN.SAVED'), type: 'SUCCESS' });
          }
        },
      },
    ],
  });
};

PluginAPI.registerMenuEntry({
  label: t('MENU.SET_TOKEN'),
  icon: 'key',
  onClick: safe(openTokenDialog),
});

PluginAPI.registerMenuEntry({
  label: t('MENU.SYNC_NOW'),
  icon: 'sync',
  onClick: safe(syncAll),
});

PluginAPI.registerTaskContextMenuEntry({
  id: 'checkbox-subtasks',
  label: t('SUBTASKS.MENU'),
  icon: 'checklist',
  showFor: ['TASK'],
  onClick: ({ taskId }) => openCheckboxDialog(taskId).catch(reportError),
});

// --- Pull schedule -----------------------------------------------------------

let lastPullAt = 0;
/** Pulls when the last pull is older than `minAgeMs` (default: the configured interval). */
const pullIfDue = async (minAgeMs?: number): Promise<void> => {
  const settings = await loadSettings();
  const maxAge = minAgeMs ?? settings.pullIntervalMinutes * 60 * 1000;
  if (Date.now() - lastPullAt < maxAge) {
    return;
  }
  lastPullAt = Date.now();
  await pullAll();
};

const pullTimer = setInterval(safe(pullIfDue), PULL_TICK_MS);
PluginAPI.onUnload?.(() => clearInterval(pullTimer));
PluginAPI.onWindowFocusChange?.((isFocused) => {
  if (isFocused) {
    safe(pullIfDue)(FOCUS_PULL_MIN_AGE_MS);
  }
});

setTimeout(
  safe(async () => {
    const settings = await loadSettings();
    if (settings.baseUrl && isBlockedByHost(settings.baseUrl)) {
      PluginAPI.showSnack({ msg: t('ERRORS.BLOCKED_HOST'), type: 'WARNING' });
    }
    await pullIfDue(0);
  }),
  STARTUP_PULL_DELAY_MS,
);

// Warm the settings cache for synchronous callers (getIssueLink).
loadSettings().catch(() => undefined);
