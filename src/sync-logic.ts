// Pure decision logic of the note sync (no PluginAPI), unit-tested.

export type PullDecision =
  /** Nothing changed remotely. */
  | 'none'
  /** Only the memo changed: take it into the task notes. */
  | 'pull'
  /** Both changed, the memo is newer: take it, keep the local notes as memo comment. */
  | 'pullKeepLocal'
  /** Both changed, the task is newer: push it, keep the old memo as comment. */
  | 'pushKeepRemote';

export const decidePull = (p: {
  remoteHash: string;
  syncedHash: string;
  localHash: string;
  syncedLocalHash: string;
  remoteUpdated: number;
  localUpdated: number;
}): PullDecision => {
  if (p.remoteHash === p.syncedHash) {
    return 'none';
  }
  if (p.localHash === p.syncedLocalHash) {
    return 'pull';
  }
  return p.remoteUpdated >= p.localUpdated ? 'pullKeepLocal' : 'pushKeepRemote';
};
