// Synced plugin data: which task belongs to which memo. Stored with
// persistDataSynced so all devices agree on the mapping.
import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';

declare const PluginAPI: PluginAPIType;

export interface NoteLink {
  memo: string;
  /** Hash of the memo content as last written or read by the plugin. */
  syncedHash: string;
  /** Hash of the composed task content (notes + footer) at that moment. */
  localHash: string;
  /** Memo updateTime at that moment. */
  memoUpdateTime: string;
  /** When the notes/title were last edited locally after that sync (SP tasks carry no timestamp). */
  localEditedAt?: number;
  /** Set when the link is kept in the notes instead of an attachment. */
  linkInNotes?: boolean;
}

export interface SubtaskLink {
  memo: string;
  parentTaskId: string;
  text: string;
  index: number;
}

interface StoreData {
  notes: Record<string, NoteLink>;
  subtasks: Record<string, SubtaskLink>;
}

const KEY = 'links';

let data: StoreData | null = null;

const load = async (): Promise<StoreData> => {
  if (data) {
    return data;
  }
  let parsed: Partial<StoreData> = {};
  try {
    parsed = JSON.parse(
      (await PluginAPI.loadSyncedData(KEY)) || '{}',
    ) as Partial<StoreData>;
  } catch {
    parsed = {};
  }
  data = { notes: parsed.notes ?? {}, subtasks: parsed.subtasks ?? {} };
  return data;
};

const save = async (): Promise<void> => {
  if (data) {
    await PluginAPI.persistDataSynced(JSON.stringify(data), KEY);
  }
};

/** Drops the in-memory copy, e.g. after another device changed the data. */
export const invalidate = (): void => {
  data = null;
};

export const getNoteLinks = async (): Promise<Record<string, NoteLink>> =>
  (await load()).notes;

export const getNoteLink = async (taskId: string): Promise<NoteLink | undefined> =>
  (await load()).notes[taskId];

export const setNoteLink = async (
  taskId: string,
  link: NoteLink | undefined,
): Promise<void> => {
  const d = await load();
  if (link) {
    d.notes[taskId] = link;
  } else {
    delete d.notes[taskId];
  }
  await save();
};

export const getSubtaskLinks = async (): Promise<Record<string, SubtaskLink>> =>
  (await load()).subtasks;

export const setSubtaskLink = async (
  taskId: string,
  link: SubtaskLink | undefined,
): Promise<void> => {
  const d = await load();
  if (link) {
    d.subtasks[taskId] = link;
  } else {
    delete d.subtasks[taskId];
  }
  await save();
};

/** Memo uids that belong to the note sync (excluded from the issue provider). */
export const getNoteSyncMemoUids = async (): Promise<Set<string>> =>
  new Set(Object.values((await load()).notes).map((l) => l.memo));
