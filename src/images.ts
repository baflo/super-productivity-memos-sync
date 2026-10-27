// Images in notes. SP keeps pasted images on the device only and refers to
// them by id: `indexeddb://clipboard-images/<id>` (web, and resolvable in
// Electron too) or `file:///…/clipboard-images/<id>.<ext>` (Electron). In Memos
// the same image is an attachment with that id, shown inline via its relative
// file URL `/file/attachments/<id>/<filename>` (a "managed image": Memos wants
// the attachment bound to the memo in the same request). Converting between
// the two forms is a plain URL replacement.

/** Memos attachment ids: `^[a-zA-Z0-9]([a-zA-Z0-9-]{0,34}[a-zA-Z0-9])?$` */
const ATTACHMENT_ID = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,34}[a-zA-Z0-9])?$/;

// Same URL shapes as SP's ClipboardImageService resolves.
const LOCAL_IMAGE =
  /indexeddb:\/\/clipboard-images\/([^)\s=]+)|file:\/\/\/[^)\s"]*\/clipboard-images\/([^)\s"/]+)\.[a-z]{2,5}/g;

export interface LocalImageRef {
  url: string;
  id: string;
}

export const isAttachmentId = (id: string): boolean => ATTACHMENT_ID.test(id);

export const localImageUrl = (id: string): string => `indexeddb://clipboard-images/${id}`;

/** Relative, so the memo does not depend on Memos' host name or instance URL. */
export const attachmentPath = (id: string, filename: string): string =>
  `/file/attachments/${id}/${encodeURIComponent(filename)}`;

/** `attachments/<id>` → `<id>` */
export const attachmentId = (name: string): string => name.replace(/^attachments\//, '');

/** Local image URLs in SP notes, each URL once. */
export const findLocalImages = (text: string): LocalImageRef[] => {
  const refs = new Map<string, LocalImageRef>();
  for (const m of text.matchAll(LOCAL_IMAGE)) {
    refs.set(m[0], { url: m[0], id: m[1] ?? m[2] });
  }
  return [...refs.values()];
};

/** SP form → Memos form for the images in `files` (SP id → attachment). */
export const toMemosForm = (
  text: string,
  files: Map<string, { id: string; filename: string }>,
): string =>
  text.replace(LOCAL_IMAGE, (url, webId?: string, fileId?: string) => {
    const file = files.get(webId ?? fileId ?? '');
    return file ? attachmentPath(file.id, file.filename) : url;
  });

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Link targets `/file/attachments/<id>/…`, relative or on this Memos' base URL. */
const memosImagePattern = (baseUrl: string): RegExp =>
  new RegExp(
    `(?<=\\()(?:${escapeRegExp(baseUrl)})?/file/attachments/([A-Za-z0-9-]+)/[^)\\s]+`,
    'g',
  );

/**
 * Memos form → SP form; returns the converted text and the image ids in it.
 * With `only`, other attachment URLs (e.g. of another memo) stay as they are.
 */
export const toSpForm = (
  text: string,
  baseUrl: string,
  only?: Set<string>,
): { text: string; ids: string[] } => {
  const ids = new Set<string>();
  const converted = text.replace(memosImagePattern(baseUrl), (url, id: string) => {
    if (only && !only.has(id)) {
      return url;
    }
    ids.add(id);
    return localImageUrl(id);
  });
  return { text: converted, ids: [...ids] };
};

export const extensionFor = (mimeType: string): string => {
  const sub = (mimeType.split('/')[1] || 'png').toLowerCase();
  return sub === 'jpeg' ? 'jpg' : sub === 'svg+xml' ? 'svg' : sub.replace(/[^a-z0-9]/g, '');
};

export const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

/** `file:///home/u/x/clipboard-images/a.png` → `/home/u/x/clipboard-images` */
export const basePathFromFileUrl = (url: string): string | undefined => {
  if (!url.startsWith('file://')) {
    return undefined;
  }
  const path = decodeURI(url.slice('file://'.length));
  const native = /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  return native.slice(0, native.lastIndexOf('/')) || undefined;
};
