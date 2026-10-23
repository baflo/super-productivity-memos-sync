// "Checkbox → subtask": turns chosen checkboxes of an imported memo into
// subtasks and keeps their done state in sync with the checkbox, both ways.
import type { PluginAPI as PluginAPIType, Task } from '@super-productivity/plugin-api';
import { t } from '../../issue-provider-kit';
import { findCheckbox, parseCheckboxes, setCheckbox, toPlainText } from './markdown';
import type { Memo } from './memos-client';
import { memoUid } from './memos-client';
import { getFetchClient, PROVIDER_KEY } from './settings';
import { getSubtaskLinks, setSubtaskLink } from './store';

declare const PluginAPI: PluginAPIType;

const CHECKBOX_NAME = 'memos-checkbox';

const escapeHtml = (str: string): string =>
  str.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const isMemoTask = (task: Task | undefined): task is Task =>
  !!task && task.issueType === PROVIDER_KEY && !!task.issueId;

/** Context menu action on a task imported from Memos. */
export const openCheckboxDialog = async (taskId: string): Promise<void> => {
  const tasks = await PluginAPI.getTasks();
  const task = tasks.find((x) => x.id === taskId);
  if (!isMemoTask(task)) {
    PluginAPI.showSnack({ msg: t('SUBTASKS.ONLY_MEMO_TASKS'), type: 'WARNING' });
    return;
  }
  const ctx = await getFetchClient();
  if (!ctx) {
    PluginAPI.showSnack({ msg: t('ERRORS.NO_BASE_URL'), type: 'ERROR' });
    return;
  }
  const uid = task.issueId as string;
  const memo = await ctx.client.getMemo(uid);
  const links = await getSubtaskLinks();
  const taken = new Set(
    Object.values(links)
      .filter((l) => l.memo === uid)
      .map((l) => l.text),
  );
  const candidates = parseCheckboxes(memo.content).filter(
    (c) => !c.checked && !taken.has(c.text),
  );
  if (!candidates.length) {
    PluginAPI.showSnack({ msg: t('SUBTASKS.NONE_LEFT'), type: 'INFO' });
    return;
  }

  let chosen: number[] = [];
  const list = candidates
    .map(
      (c) =>
        `<label style="display:block;margin:6px 0"><input type="checkbox" name="${CHECKBOX_NAME}" value="${c.index}"> ${escapeHtml(toPlainText(c.text))}</label>`,
    )
    .join('');
  await PluginAPI.openDialog({
    title: t('SUBTASKS.DIALOG_TITLE'),
    htmlContent: `<p>${escapeHtml(t('SUBTASKS.DIALOG_TEXT'))}</p>${list}`,
    buttons: [
      { label: t('DIALOG.CANCEL') },
      {
        label: t('SUBTASKS.CREATE'),
        color: 'primary',
        raised: true,
        // Runs before the dialog closes, so the inputs are still in the DOM.
        onClick: () => {
          chosen = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              `input[name="${CHECKBOX_NAME}"]:checked`,
            ),
          ).map((el) => Number(el.value));
        },
      },
    ],
  });

  for (const index of chosen) {
    const checkbox = candidates.find((c) => c.index === index);
    if (!checkbox) {
      continue;
    }
    const subtaskId = await PluginAPI.addTask({
      title: toPlainText(checkbox.text) || checkbox.text,
      parentId: task.id,
      projectId: task.projectId,
    });
    await setSubtaskLink(subtaskId, {
      memo: uid,
      parentTaskId: task.id,
      text: checkbox.text,
      index: checkbox.index,
    });
  }
  if (chosen.length) {
    PluginAPI.showSnack({
      msg: t('SUBTASKS.CREATED', { count: chosen.length }),
      type: 'SUCCESS',
    });
  }
};

/** SP → Memos: a linked subtask was (un)done → (un)check its checkbox. */
export const onSubtaskDoneChange = async (task: Task): Promise<boolean> => {
  const link = (await getSubtaskLinks())[task.id];
  if (!link) {
    return false;
  }
  const ctx = await getFetchClient();
  if (!ctx) {
    return true;
  }
  const memo = await ctx.client.getMemo(link.memo);
  const checkbox = findCheckbox(memo.content, link.text, link.index);
  if (!checkbox) {
    PluginAPI.showSnack({ msg: t('SUBTASKS.CHECKBOX_GONE'), type: 'WARNING' });
    return true;
  }
  if (checkbox.checked !== task.isDone) {
    await ctx.client.updateMemo(link.memo, {
      content: setCheckbox(memo.content, checkbox.index, task.isDone),
    });
  }
  if (checkbox.index !== link.index) {
    await setSubtaskLink(task.id, { ...link, index: checkbox.index });
  }
  return true;
};

/** Memos → SP: called whenever the provider fetched a memo. */
export const syncSubtasksFromMemo = async (memo: Memo): Promise<void> => {
  const uid = memoUid(memo);
  const links = Object.entries(await getSubtaskLinks()).filter(([, l]) => l.memo === uid);
  if (!links.length) {
    return;
  }
  const tasks = await PluginAPI.getTasks();
  for (const [taskId, link] of links) {
    const task = tasks.find((x) => x.id === taskId);
    if (!task) {
      continue;
    }
    const checkbox = findCheckbox(memo.content, link.text, link.index);
    if (checkbox && checkbox.checked !== task.isDone) {
      // The resulting taskUpdate hook finds checkbox and task in agreement and writes nothing.
      await PluginAPI.updateTask(taskId, { isDone: checkbox.checked });
    }
  }
};

export const isCheckboxSubtask = async (taskId: string): Promise<boolean> =>
  !!(await getSubtaskLinks())[taskId];

/** Drops the links of a deleted subtask, or of all subtasks of a deleted parent. */
export const forgetSubtasks = async (deletedTaskId: string): Promise<void> => {
  const links = await getSubtaskLinks();
  for (const [taskId, link] of Object.entries(links)) {
    if (taskId === deletedTaskId || link.parentTaskId === deletedTaskId) {
      await setSubtaskLink(taskId, undefined);
    }
  }
};
