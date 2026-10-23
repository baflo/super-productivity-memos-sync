// Pure Markdown helpers for memo content. No PluginAPI access here, so the
// node test runner can exercise them directly.

export interface Checkbox {
  /** Position among all checkboxes of the memo (0-based). */
  index: number;
  /** Line number in the memo content (0-based). */
  line: number;
  checked: boolean;
  /** Raw text after the checkbox marker. */
  text: string;
}

export type TitleMode = 'cascade' | 'firstOpen' | 'generic';

const CHECKBOX_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s?)(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
// Memos tags: `#` followed by a non-space run, not part of a heading marker.
const TAG_RE = /(^|\s)#[^\s#]+/g;
const MAX_TITLE_LENGTH = 120;

const splitLines = (content: string): string[] => content.split(/\r?\n/);

/** All task-list checkboxes outside of code fences. */
export const parseCheckboxes = (content: string): Checkbox[] => {
  const result: Checkbox[] = [];
  let inFence = false;
  splitLines(content).forEach((lineStr, line) => {
    if (FENCE_RE.test(lineStr)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      return;
    }
    const match = CHECKBOX_RE.exec(lineStr);
    if (match) {
      result.push({
        index: result.length,
        line,
        checked: match[2] !== ' ',
        text: match[4].trim(),
      });
    }
  });
  return result;
};

/** Returns the content with checkbox `index` set to `checked`; unchanged if missing. */
export const setCheckbox = (content: string, index: number, checked: boolean): string => {
  const checkbox = parseCheckboxes(content)[index];
  if (!checkbox) {
    return content;
  }
  const lines = content.split('\n');
  lines[checkbox.line] = lines[checkbox.line].replace(
    CHECKBOX_RE,
    (_m, pre: string, _state: string, post: string, text: string) =>
      `${pre}${checked ? 'x' : ' '}${post}${text}`,
  );
  return lines.join('\n');
};

/**
 * Finds a checkbox by its text (checkboxes may have moved); the former index
 * only breaks ties between identical texts. No match → undefined, so an edited
 * checkbox is never toggled by mistake.
 */
export const findCheckbox = (
  content: string,
  text: string,
  fallbackIndex: number,
): Checkbox | undefined => {
  const checkboxes = parseCheckboxes(content);
  const wanted = text.trim();
  const byText = checkboxes.filter((c) => c.text === wanted);
  if (byText.length === 1) {
    return byText[0];
  }
  if (byText.length > 1) {
    return byText.find((c) => c.index === fallbackIndex) ?? byText[0];
  }
  return undefined;
};

/** Strips inline Markdown, list/heading markers and tags from a single line. */
export const toPlainText = (line: string): string =>
  line
    .replace(CHECKBOX_RE, '$4')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(TAG_RE, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();

const truncate = (text: string): string =>
  text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : text;

/** Nearest non-empty line above the first checkbox that is not just tags. */
const textBeforeFirstCheckbox = (content: string, firstCheckboxLine: number): string => {
  const lines = splitLines(content);
  for (let i = firstCheckboxLine - 1; i >= 0; i--) {
    const plain = toPlainText(lines[i]);
    if (plain) {
      return plain;
    }
  }
  return '';
};

const withTagPrefix = (text: string, tags: string[]): string => {
  const tag = tags[0];
  if (!tag || text.toLowerCase().includes(tag.toLowerCase())) {
    return text;
  }
  return `${tag} – ${text}`;
};

/**
 * Task title for a memo with checkboxes.
 *
 * cascade:   exactly one open checkbox → its text; otherwise the text right
 *            before the first checkbox, prefixed with the first tag;
 *            otherwise the generic fallback.
 * firstOpen: first open checkbox (+N for more), else as cascade.
 * generic:   always the fallback.
 */
export const buildTitle = (
  content: string,
  tags: string[],
  mode: TitleMode,
  fallback: string,
): string => {
  if (mode === 'generic') {
    return fallback;
  }
  const checkboxes = parseCheckboxes(content);
  const open = checkboxes.filter((c) => !c.checked);

  if (mode === 'firstOpen' && open.length > 0) {
    const first = toPlainText(open[0].text);
    if (first) {
      return truncate(open.length > 1 ? `${first} (+${open.length - 1})` : first);
    }
  }

  if (open.length === 1) {
    const only = toPlainText(open[0].text);
    if (only) {
      return truncate(only);
    }
  }

  if (checkboxes.length > 0) {
    const before = textBeforeFirstCheckbox(content, checkboxes[0].line);
    if (before) {
      return truncate(withTagPrefix(before, tags));
    }
  }
  return fallback;
};

// ---------------------------------------------------------------------------
// Note sync: the memo carries a footer that names the task and holds the
// sync tag. It is added on push and removed again on pull.

const FOOTER_RE = /\n*---\n\*SP-Task: [^\n]*\*[^\n]*\s*$/;
const LINK_LINE_RE = /\n*\[↗ Memo\]\([^)]*\)\s*$/;

const escapeFooterTitle = (title: string): string =>
  title.replace(/[*\n]/g, ' ').replace(/\s+/g, ' ').trim();

export const composeMemoContent = (
  notes: string,
  taskTitle: string,
  tag?: string,
): string => {
  const body = stripLinkLine(notes).trimEnd();
  const tagStr = tag ? ` #${tag.replace(/^#/, '')}` : '';
  return `${body}\n\n---\n*SP-Task: ${escapeFooterTitle(taskTitle)}*${tagStr}`;
};

export const stripFooter = (content: string): string =>
  content.replace(FOOTER_RE, '').trimEnd();

/** Fallback link to the memo, appended to the notes when attachments are unavailable. */
export const appendLinkLine = (notes: string, url: string): string =>
  `${stripLinkLine(notes).trimEnd()}\n\n[↗ Memo](${url})`;

export const stripLinkLine = (notes: string): string => notes.replace(LINK_LINE_RE, '');

/** Small stable string hash (djb2), enough to detect content changes. */
export const hash = (str: string): string => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
};
