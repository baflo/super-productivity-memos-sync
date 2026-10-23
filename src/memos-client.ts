// Minimal client for the Memos REST API v1. The transport is pluggable:
// provider callbacks pass SP's http helper (headers come from getHeaders),
// hook-driven code (note sync, checkbox subtasks) uses fetch, because
// PluginAPI.request only reaches hosts fixed in the manifest.
import type { PluginHttp } from '@super-productivity/plugin-api';

export type Visibility = 'PRIVATE' | 'PROTECTED' | 'PUBLIC' | 'SPACE';

export interface Memo {
  /** `memos/{uid}` */
  name: string;
  content: string;
  createTime: string;
  updateTime: string;
  state?: 'NORMAL' | 'ARCHIVED';
  visibility?: Visibility;
  tags?: string[];
  snippet?: string;
  space?: string;
  property?: {
    hasTaskList?: boolean;
    hasIncompleteTasks?: boolean;
  };
}

interface ListMemosResponse {
  memos?: Memo[];
  nextPageToken?: string;
}

export interface Transport {
  request<T>(method: string, url: string, body?: unknown): Promise<T>;
}

export class MemosHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const fromPluginHttp = (http: PluginHttp): Transport => ({
  request: <T>(method: string, url: string, body?: unknown): Promise<T> =>
    http.request<T>(method, url, body),
});

export const fetchTransport = (token: string | null): Transport => ({
  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new MemosHttpError(
        res.status,
        `Memos ${method} ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  },
});

export const getStatus = (err: unknown): number | undefined =>
  typeof err === 'object' && err !== null && 'status' in err
    ? Number((err as { status: unknown }).status)
    : undefined;

/** `https://host/`, `https://host/api/v1` → `https://host` */
export const normalizeBaseUrl = (url: string | undefined): string =>
  (url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/, '');

/** `team`, `spaces/team` → `spaces/team`; empty → '' */
export const normalizeSpace = (space: string | undefined): string => {
  const s = (space || '').trim().replace(/^\/+|\/+$/g, '');
  return !s ? '' : s.startsWith('spaces/') ? s : `spaces/${s}`;
};

export const normalizeTag = (tag: string | undefined): string =>
  (tag || '').trim().replace(/^#/, '');

export const memoUid = (memo: Pick<Memo, 'name'>): string =>
  memo.name.replace(/^memos\//, '');

export const memoUrl = (baseUrl: string, uid: string): string =>
  `${normalizeBaseUrl(baseUrl)}/memos/${uid}`;

/**
 * Mirrors the hostname check of SP's plugin http helper, which refuses
 * localhost and private IP literals (it does not resolve DNS). Returns true
 * when the provider requests would be blocked.
 */
export const isBlockedByHost = (baseUrl: string): boolean => {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return (
    ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname) ||
    /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) ||
    /^(fc|fd|fe80|::ffff:)/.test(hostname)
  );
};

/** CEL string literal; JSON escaping is valid CEL for strings. */
export const celString = (value: string): string => JSON.stringify(value);

export const celAnd = (...terms: (string | false | undefined | null)[]): string =>
  terms.filter((t): t is string => !!t).join(' && ');

export class MemosClient {
  private readonly api: string;
  private readonly transport: Transport;

  constructor(baseUrl: string, transport: Transport) {
    this.api = `${normalizeBaseUrl(baseUrl)}/api/v1`;
    this.transport = transport;
  }

  async listMemos(filter: string, maxResults = 100): Promise<Memo[]> {
    const result: Memo[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ pageSize: String(Math.min(maxResults, 100)) });
      if (filter) {
        params.set('filter', filter);
      }
      if (pageToken) {
        params.set('pageToken', pageToken);
      }
      const res = await this.transport.request<ListMemosResponse>(
        'GET',
        `${this.api}/memos?${params.toString()}`,
      );
      result.push(...(res.memos ?? []));
      pageToken = res.nextPageToken ?? '';
    } while (pageToken && result.length < maxResults);
    return result.slice(0, maxResults);
  }

  getMemo(uid: string): Promise<Memo> {
    return this.transport.request<Memo>(
      'GET',
      `${this.api}/memos/${encodeURIComponent(uid)}`,
    );
  }

  createMemo(memo: {
    content: string;
    visibility?: Visibility;
    space?: string;
  }): Promise<Memo> {
    return this.transport.request<Memo>('POST', `${this.api}/memos`, memo);
  }

  updateMemo(
    uid: string,
    patch: Partial<Pick<Memo, 'content' | 'state'>>,
  ): Promise<Memo> {
    // `update_time` without a value makes the server stamp the current time, as
    // the Memos web UI does; a bare `content` mask leaves updateTime untouched.
    const fields = Object.keys(patch);
    const mask = (fields.includes('content') ? [...fields, 'update_time'] : fields).join(
      ',',
    );
    return this.transport.request<Memo>(
      'PATCH',
      `${this.api}/memos/${encodeURIComponent(uid)}?updateMask=${encodeURIComponent(mask)}`,
      { ...patch, name: `memos/${uid}` },
    );
  }

  async deleteMemo(uid: string): Promise<void> {
    await this.transport.request(
      'DELETE',
      `${this.api}/memos/${encodeURIComponent(uid)}`,
    );
  }

  createComment(uid: string, content: string): Promise<Memo> {
    return this.transport.request<Memo>(
      'POST',
      `${this.api}/memos/${encodeURIComponent(uid)}/comments`,
      { content },
    );
  }
}
