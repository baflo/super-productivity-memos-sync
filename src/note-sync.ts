// Note sync: task notes ↔ one memo per task. Tasks imported from Memos and
// checkbox subtasks are left out, so no memo is mirrored twice.
import type { PluginAPI as PluginAPIType, Task } from '@super-productivity/plugin-api';
import { t } from '../../issue-provider-kit';
import {
  appendLinkLine,
  composeMemoContent,
  hash,
  stripFooter,
  stripLinkLine,
  taskDeepLink,
} from './markdown';
import type { Memo, MemosClient } from './memos-client';
import { celString, getStatus, memoUid, memoUrl } from './memos-client';
import { getFetchClient, loadSettings, PROVIDER_KEY } from './settings';
import type { Settings } from './settings';
import { getNoteLink, getNoteLinks, getSubtaskLinks, setNoteLink } from './store';
import type { NoteLink } from './store';
import { decidePull } from './sync-logic';

declare const PluginAPI: PluginAPIType;

const PUSH_DEBOUNCE_MS = 3000;
const LAST_PULL_KEY = 'sp-plugin-memos:lastPull';
const FIRST_PULL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const PULL_OVERLAP_MS = 5 * 60 * 1000;

const pending = new Map<string, ReturnType<typeof setTimeout>>();
let pullRunning = false;

type SyncedTask = Pick<Task, 'id' | 'notes' | 'title' | 'projectId'>;

const composeFor = (task: SyncedTask, settings: Settings): string =>
  composeMemoContent(
    task.notes ?? '',
    task.title,
    settings.syncTag,
    taskDeepLink(settings.spBaseUrl, task),
  );

const localHashOf = (task: SyncedTask, settings: Settings): string =>
  hash(composeFor(task, settings));

const shouldSync = async (task: Task, settings: Settings): Promise<boolean> => {
  if (!settings.noteSyncEnabled || task.issueType === PROVIDER_KEY) {
    return false;
  }
  if (task.issueType && !settings.syncOtherProviderTasks) {
    return false;
  }
  return !(await getSubtaskLinks())[task.id];
};

const linkFrom = (memo: Memo, localHash: string, prev?: NoteLink): NoteLink => ({
  memo: memoUid(memo),
  syncedHash: hash(memo.content),
  localHash,
  memoUpdateTime: memo.updateTime,
  ...(prev?.linkInNotes ? { linkInNotes: true } : {}),
});

/** Shows the memo at the task: as link attachment, else as last line of the notes. */
const attachMemoLink = async (task: Task, url: string, link: NoteLink): Promise<void> => {
  const attachments = (task.attachments ?? []) as { path?: string }[];
  if (attachments.some((a) => a.path === url)) {
    return;
  }
  try {
    await PluginAPI.updateTask(task.id, {
      attachments: [
        ...attachments,
        {
          id: `memos-${link.memo}`,
          type: 'LINK',
          path: url,
          title: 'Memo',
          icon: 'link',
        },
      ],
    });
  } catch (e) {
    PluginAPI.log.warn('attachment not accepted, falling back to a link in the notes', e);
    // The hook fired by this update finds an unchanged composed hash and pushes nothing.
    await PluginAPI.updateTask(task.id, { notes: appendLinkLine(task.notes ?? '', url) });
    await setNoteLink(task.id, { ...link, linkInNotes: true });
  }
};

const notesFromMemo = (memo: Memo, link: NoteLink, url: string): string => {
  const notes = stripFooter(memo.content);
  return link.linkInNotes ? appendLinkLine(notes, url) : notes;
};

const keepAsComment = async (
  client: MemosClient,
  uid: string,
  text: string,
): Promise<void> => {
  if (stripLinkLine(text).trim()) {
    await client.createComment(
      uid,
      `${t('SYNC.CONFLICT_COMMENT')}\n\n${stripLinkLine(text).trim()}`,
    );
  }
};

const createMemo = async (
  client: MemosClient,
  task: Task,
  settings: Settings,
  content: string,
): Promise<void> => {
  const memo = await client.createMemo({
    content,
    visibility: settings.visibility,
    ...(settings.syncSpace ? { space: settings.syncSpace } : {}),
  });
  const link = linkFrom(memo, hash(content));
  await setNoteLink(task.id, link);
  await attachMemoLink(task, memoUrl(settings.baseUrl, link.memo), link);
};

const notifyConflict = (task: Task): void =>
  PluginAPI.showSnack({
    msg: t('SYNC.CONFLICT_SNACK', { title: task.title }),
    type: 'INFO',
  });

/** Takes the memo into the task notes; optionally keeps the local notes as memo comment. */
const applyRemote = async (
  client: MemosClient,
  settings: Settings,
  task: Task,
  memo: Memo,
  link: NoteLink,
  keepLocal: boolean,
): Promise<void> => {
  if (keepLocal) {
    await keepAsComment(client, link.memo, task.notes ?? '');
    notifyConflict(task);
  }
  const notes = notesFromMemo(memo, link, memoUrl(settings.baseUrl, link.memo));
  // Store the link first: the taskUpdate hook of this update must see the new hash.
  await setNoteLink(
    task.id,
    linkFrom(memo, localHashOf({ ...task, notes }, settings), link),
  );
  await PluginAPI.updateTask(task.id, { notes });
};

/** SP → Memos for one task. */
export const pushTask = async (taskId: string): Promise<void> => {
  const ctx = await getFetchClient();
  if (!ctx) {
    return;
  }
  const { client, settings } = ctx;
  const task = (await PluginAPI.getTasks()).find((x) => x.id === taskId);
  if (!task || !(await shouldSync(task, settings))) {
    return;
  }
  const notes = stripLinkLine(task.notes ?? '').trim();
  const link = await getNoteLink(task.id);
  // Empty notes never create a memo, and never wipe an existing one.
  if (!notes) {
    return;
  }
  const content = composeFor(task, settings);
  const localHash = hash(content);
  if (!link) {
    await createMemo(client, task, settings, content);
    return;
  }
  if (link.localHash === localHash) {
    return;
  }

  let remote: Memo;
  try {
    remote = await client.getMemo(link.memo);
  } catch (e) {
    if (getStatus(e) === 404) {
      await createMemo(client, task, settings, content);
      return;
    }
    throw e;
  }
  // Both sides changed (e.g. edited offline): the newer side wins.
  const decision = decidePull({
    remoteHash: hash(remote.content),
    syncedHash: link.syncedHash,
    localHash,
    syncedLocalHash: link.localHash,
    remoteUpdated: new Date(remote.updateTime).getTime(),
    localUpdated: link.localEditedAt ?? 0,
  });
  if (decision === 'pullKeepLocal') {
    await applyRemote(client, settings, task, remote, link, true);
    return;
  }
  if (decision === 'pushKeepRemote') {
    await keepAsComment(client, link.memo, stripFooter(remote.content));
    notifyConflict(task);
  }
  const updated = await client.updateMemo(link.memo, { content });
  await setNoteLink(task.id, linkFrom(updated, localHash, link));
};

/**
 * Remembers when a linked task was edited locally, for conflict decisions.
 * The plugin's own pulls leave the composed hash equal to the stored one and
 * are therefore not counted as edits.
 */
export const markLocalEdit = async (task: Task): Promise<void> => {
  const link = await getNoteLink(task.id);
  if (!link) {
    return;
  }
  const settings = await loadSettings();
  if (localHashOf(task, settings) !== link.localHash) {
    await setNoteLink(task.id, { ...link, localEditedAt: Date.now() });
  }
};

export const schedulePush = (taskId: string): void => {
  clearTimeout(pending.get(taskId));
  pending.set(
    taskId,
    setTimeout(() => {
      pending.delete(taskId);
      pushTask(taskId).catch((e) => reportError(e));
    }, PUSH_DEBOUNCE_MS),
  );
};

const readLastPull = (): number => {
  try {
    return Number(localStorage.getItem(LAST_PULL_KEY)) || 0;
  } catch {
    return 0;
  }
};

const writeLastPull = (ms: number): void => {
  try {
    localStorage.setItem(LAST_PULL_KEY, String(ms));
  } catch {
    // Per-device convenience only; without it the next pull looks back further.
  }
};

/** Memos → SP for all linked tasks whose memo changed since the last pull. */
export const pullAll = async (): Promise<void> => {
  if (pullRunning) {
    return;
  }
  pullRunning = true;
  try {
    const ctx = await getFetchClient();
    if (!ctx || !ctx.settings.noteSyncEnabled) {
      return;
    }
    const { client, settings } = ctx;
    const links = await getNoteLinks();
    const byMemo = new Map(Object.entries(links).map(([taskId, l]) => [l.memo, taskId]));
    if (!byMemo.size) {
      return;
    }
    const startedAt = Date.now();
    const since =
      (readLastPull() || startedAt - FIRST_PULL_LOOKBACK_MS) - PULL_OVERLAP_MS;
    const changed = await client.listMemos(
      `updated_ts > timestamp(${celString(new Date(since).toISOString())})`,
      500,
    );
    const tasks = await PluginAPI.getTasks();

    for (const memo of changed) {
      const taskId = byMemo.get(memoUid(memo));
      const link = taskId && links[taskId];
      const task = taskId && tasks.find((x) => x.id === taskId);
      if (!link || !task) {
        continue;
      }
      const decision = decidePull({
        remoteHash: hash(memo.content),
        syncedHash: link.syncedHash,
        localHash: localHashOf(task, settings),
        syncedLocalHash: link.localHash,
        remoteUpdated: new Date(memo.updateTime).getTime(),
        localUpdated: link.localEditedAt ?? 0,
      });
      if (decision === 'none') {
        continue;
      }
      if (decision === 'pushKeepRemote') {
        await pushTask(task.id);
        continue;
      }
      await applyRemote(client, settings, task, memo, link, decision === 'pullKeepLocal');
    }
    writeLastPull(startedAt);
  } catch (e) {
    reportError(e);
  } finally {
    pullRunning = false;
  }
};

/** Menu action: push every task with notes, then pull. */
export const syncAll = async (): Promise<void> => {
  const ctx = await getFetchClient();
  if (!ctx) {
    PluginAPI.showSnack({ msg: t('ERRORS.NO_BASE_URL'), type: 'ERROR' });
    return;
  }
  if (!ctx.settings.noteSyncEnabled) {
    PluginAPI.showSnack({ msg: t('SYNC.DISABLED'), type: 'WARNING' });
    return;
  }
  let count = 0;
  try {
    for (const task of await PluginAPI.getTasks()) {
      if (
        stripLinkLine(task.notes ?? '').trim() &&
        (await shouldSync(task, ctx.settings))
      ) {
        await pushTask(task.id);
        count++;
      }
    }
    await pullAll();
    PluginAPI.showSnack({ msg: t('SYNC.DONE', { count }), type: 'SUCCESS' });
  } catch (e) {
    reportError(e);
  }
};

/** A task was deleted: keep, archive or delete its memo, as configured. */
export const onTaskDeleted = async (taskId: string): Promise<void> => {
  clearTimeout(pending.get(taskId));
  pending.delete(taskId);
  const link = await getNoteLink(taskId);
  if (!link) {
    return;
  }
  await setNoteLink(taskId, undefined);
  const ctx = await getFetchClient();
  if (!ctx || ctx.settings.onTaskDelete === 'nothing') {
    return;
  }
  try {
    if (ctx.settings.onTaskDelete === 'archive') {
      await ctx.client.updateMemo(link.memo, { state: 'ARCHIVED' });
    } else {
      await ctx.client.deleteMemo(link.memo);
    }
  } catch (e) {
    if (getStatus(e) !== 404) {
      reportError(e);
    }
  }
};

export const reportError = (e: unknown): void => {
  const status = getStatus(e);
  // Offline or server unreachable: retried on the next change, focus or interval; no snack.
  if (status === undefined && e instanceof TypeError) {
    PluginAPI.log.warn('Memos unreachable', e.message);
    return;
  }
  PluginAPI.log.err('Memos sync failed', e);
  PluginAPI.showSnack({
    msg:
      status === 401 || status === 403
        ? t('ERRORS.AUTH')
        : t('ERRORS.SYNC_FAILED', { msg: e instanceof Error ? e.message : String(e) }),
    type: 'ERROR',
  });
};
