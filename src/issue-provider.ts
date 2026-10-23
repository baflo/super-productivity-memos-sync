// Issue provider: memos with task-list checkboxes become SP tasks. The whole
// memo becomes the task notes, the task links back to the memo.
import type {
  IssueProviderPluginDefinition,
  PluginAPI as PluginAPIType,
  PluginHttp,
  PluginIssue,
  PluginSearchResult,
} from '@super-productivity/plugin-api';
import { asConfig, canConnect, t, textMapping } from '../../issue-provider-kit';
import { buildTitle, parseCheckboxes } from './markdown';
import type { TitleMode } from './markdown';
import {
  celAnd,
  celString,
  fromPluginHttp,
  isBlockedByHost,
  MemosClient,
  memoUid,
  memoUrl,
  normalizeSpace,
  normalizeTag,
} from './memos-client';
import type { Memo } from './memos-client';
import { getCachedSettings, getToken, loadSettings } from './settings';
import type { Settings } from './settings';
import { getNoteSyncMemoUids } from './store';
import { syncSubtasksFromMemo } from './checkbox-subtasks';

declare const PluginAPI: PluginAPIType;

interface ProviderConfig {
  filterTag?: string;
  filterSpace?: string;
  includeCompleted?: boolean;
  titleMode?: TitleMode;
}

const clientFor = async (
  http: PluginHttp,
): Promise<{ client: MemosClient; settings: Settings }> => {
  const settings = await loadSettings();
  if (!settings.baseUrl) {
    throw new Error(t('ERRORS.NO_BASE_URL'));
  }
  if (isBlockedByHost(settings.baseUrl)) {
    PluginAPI.showSnack({ msg: t('ERRORS.BLOCKED_HOST'), type: 'ERROR' });
    throw new Error(t('ERRORS.BLOCKED_HOST'));
  }
  return { client: new MemosClient(settings.baseUrl, fromPluginHttp(http)), settings };
};

export const genericTitle = (memo: Pick<Memo, 'createTime'>): string =>
  t('TITLE.GENERIC', { date: PluginAPI.formatDate(memo.createTime, 'datetime') });

export const titleForMemo = (memo: Memo, mode: TitleMode = 'cascade'): string =>
  buildTitle(memo.content, memo.tags ?? [], mode, genericTitle(memo));

const progressOf = (memo: Memo): { open: number; total: number } => {
  const checkboxes = parseCheckboxes(memo.content);
  return { open: checkboxes.filter((c) => !c.checked).length, total: checkboxes.length };
};

const buildFilter = (
  cfg: ProviderConfig,
  searchTerm: string,
  onlyOpen: boolean,
): string => {
  const tag = normalizeTag(cfg.filterTag);
  const space = normalizeSpace(cfg.filterSpace);
  const term = searchTerm.trim();
  return celAnd(
    'has_task_list == true',
    onlyOpen && 'has_incomplete_tasks == true',
    tag && `${celString(tag)} in tags`,
    space && `space == ${celString(space)}`,
    term && `content.contains(${celString(term)})`,
  );
};

/** Memos written by the note sync never show up as importable tasks. */
const isNoteSyncMemo = (
  memo: Memo,
  settings: Settings,
  noteSyncUids: Set<string>,
  cfg: ProviderConfig,
): boolean =>
  noteSyncUids.has(memoUid(memo)) ||
  (!!settings.syncTag && (memo.tags ?? []).includes(settings.syncTag)) ||
  (!!settings.syncSpace &&
    memo.space === settings.syncSpace &&
    normalizeSpace(cfg.filterSpace) !== settings.syncSpace);

const search = async (
  searchTerm: string,
  config: Record<string, unknown>,
  http: PluginHttp,
  onlyOpen: boolean,
): Promise<PluginSearchResult[]> => {
  const cfg = asConfig<ProviderConfig>(config);
  const { client, settings } = await clientFor(http);
  const [memos, noteSyncUids] = await Promise.all([
    client.listMemos(buildFilter(cfg, searchTerm, onlyOpen), 100),
    getNoteSyncMemoUids(),
  ]);
  return memos
    .filter((memo) => !isNoteSyncMemo(memo, settings, noteSyncUids, cfg))
    .map((memo) => {
      const { open, total } = progressOf(memo);
      return {
        id: memoUid(memo),
        title: titleForMemo(memo, cfg.titleMode),
        url: memoUrl(settings.baseUrl, memoUid(memo)),
        status: `${total - open}/${total}`,
        description: memo.snippet,
      };
    });
};

export const issueProviderDefinition: IssueProviderPluginDefinition = {
  configFields: [
    {
      key: 'filterTag',
      type: 'input',
      label: t('CFG.FILTER_TAG'),
      description: t('CFG.FILTER_TAG_HELP'),
    },
    {
      key: 'filterSpace',
      type: 'input',
      label: t('CFG.FILTER_SPACE'),
      description: t('CFG.FILTER_SPACE_HELP'),
    },
    {
      key: 'includeCompleted',
      type: 'checkbox',
      label: t('CFG.INCLUDE_COMPLETED'),
    },
    {
      key: 'titleMode',
      type: 'select',
      label: t('CFG.TITLE_MODE'),
      description: t('CFG.TITLE_MODE_HELP'),
      options: [
        { value: 'cascade', label: t('CFG.TITLE_MODE_CASCADE') },
        { value: 'firstOpen', label: t('CFG.TITLE_MODE_FIRST_OPEN') },
        { value: 'generic', label: t('CFG.TITLE_MODE_GENERIC') },
      ],
    },
  ],

  async getHeaders(): Promise<Record<string, string>> {
    const token = await getToken(await loadSettings());
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  searchIssues: (searchTerm, config, http) =>
    search(searchTerm, config, http, !asConfig<ProviderConfig>(config).includeCompleted),

  getNewIssuesForBacklog: (config, http) => search('', config, http, true),

  async getById(
    issueId: string,
    config: Record<string, unknown>,
    http: PluginHttp,
  ): Promise<PluginIssue> {
    const cfg = asConfig<ProviderConfig>(config);
    const { client, settings } = await clientFor(http);
    const memo = await client.getMemo(issueId);
    const { open, total } = progressOf(memo);
    const title = titleForMemo(memo, cfg.titleMode);
    const url = memoUrl(settings.baseUrl, issueId);

    // Checkbox subtasks follow their checkbox; runs on every poll.
    syncSubtasksFromMemo(memo).catch((e) => PluginAPI.log.err('subtask sync failed', e));

    return {
      id: issueId,
      title,
      body: memo.content,
      url,
      // No state: done-ness is never derived from the memo (doneStates: []).
      lastUpdated: new Date(memo.updateTime).getTime(),
      labels: memo.tags ?? [],
      summary: title,
      progress: t('DISPLAY.PROGRESS_VALUE', { done: total - open, total }),
      // SP renders plugin 'date' fields as plain text, so pass formatted strings.
      created: PluginAPI.formatDate(memo.createTime, 'datetime'),
      updated: PluginAPI.formatDate(memo.updateTime, 'datetime'),
      tagList: memo.tags?.length ? memo.tags : undefined,
    };
  },

  getIssueLink(issueId: string): string {
    return memoUrl(getCachedSettings().baseUrl, issueId);
  },

  async testConnection(
    _config: Record<string, unknown>,
    http: PluginHttp,
  ): Promise<boolean> {
    const { client } = await clientFor(http);
    return canConnect(() => client.listMemos('has_task_list == true', 1));
  },

  issueDisplay: [
    { field: 'summary', label: t('DISPLAY.MEMO'), type: 'link', linkField: 'url' },
    { field: 'progress', label: t('DISPLAY.PROGRESS'), type: 'text' },
    { field: 'tagList', label: t('DISPLAY.TAGS'), type: 'list', hideEmpty: true },
    { field: 'created', label: t('DISPLAY.CREATED'), type: 'text' },
    { field: 'updated', label: t('DISPLAY.UPDATED'), type: 'text' },
    { field: 'body', label: t('DISPLAY.CONTENT'), type: 'markdown' },
  ],

  fieldMappings: [
    // Title is set on import only; switch on in the provider's sync settings to follow the memo.
    textMapping('title', 'title', 'off'),
    textMapping('notes', 'body', 'pullOnly'),
  ],

  extractSyncValues: (issue: PluginIssue): Record<string, unknown> => ({
    title: issue.title,
    body: issue.body,
  }),

  async updateIssue(
    id: string,
    changes: Record<string, unknown>,
    _config: Record<string, unknown>,
    http: PluginHttp,
  ): Promise<void> {
    if (typeof changes['body'] !== 'string') {
      return;
    }
    const { client } = await clientFor(http);
    await client.updateMemo(id, { content: changes['body'] as string });
  },

  doneStates: [],
};
