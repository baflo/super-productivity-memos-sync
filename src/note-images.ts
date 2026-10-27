// Images of synced notes: uploads local images as memo attachments on push,
// and fetches memo images into SP's local store on pull.
import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';
import {
  attachmentId,
  blobToBase64,
  extensionFor,
  findLocalImages,
  isAttachmentId,
  localImageUrl,
  toMemosForm,
  toSpForm,
} from './images';
import { noteImageUrl, readLocalImage, saveLocalImage } from './local-images';
import type { AttachmentRef, Memo, MemoAttachment, MemosClient } from './memos-client';
import type { NoteLink } from './store';

declare const PluginAPI: PluginAPIType;

const isImage = (a: MemoAttachment): boolean => a.type.startsWith('image/');

const attachmentIds = (memo: Memo): Set<string> =>
  new Set((memo.attachments ?? []).map((a) => attachmentId(a.name)));

/** Downloads a memo image into SP's local store unless it is there already. */
const ensureLocal = async (
  client: MemosClient,
  localId: string,
  attachment: MemoAttachment,
): Promise<void> => {
  try {
    if (await readLocalImage(localId)) {
      return;
    }
    const blob = await client.downloadAttachment(
      attachmentId(attachment.name),
      attachment.filename,
    );
    await saveLocalImage(localId, blob, blob.type || attachment.type);
  } catch (e) {
    PluginAPI.log.warn('memo image not stored locally', { id: localId }, e);
  }
};

const newAttachmentId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Uploads a local image as unlinked attachment, under its SP id. If that id
 * already belongs to another memo (notes copied to another task), a copy with
 * a new id is uploaded: Memos binds an attachment to one memo only.
 */
const upload = async (
  client: MemosClient,
  id: string,
  memoName?: string,
): Promise<{ id: string; filename: string } | null> => {
  const image = await readLocalImage(id);
  if (!image) {
    PluginAPI.log.warn('note image missing on this device', { id });
    return null;
  }
  const filename = `${id}.${extensionFor(image.mimeType)}`;
  const create = async (attId: string): Promise<void> => {
    await client.createAttachment({
      id: attId,
      filename,
      type: image.mimeType,
      content: await blobToBase64(image.blob),
    });
  };
  try {
    await create(id);
    return { id, filename };
  } catch (e) {
    // Already uploaded (e.g. a push that failed half way): Memos answers 500.
    const existing = await client.getAttachment(id).catch(() => null);
    if (!existing) {
      throw e;
    }
    if (!existing.memo || existing.memo === memoName) {
      return { id, filename: existing.filename };
    }
    const copyId = newAttachmentId();
    await create(copyId);
    return { id: copyId, filename };
  }
};

/**
 * SP form → memo content and attachment set. Uploads images Memos does not
 * have yet; images synced before and gone from the notes are left out of the
 * set, so Memos deletes them. Other attachments of the memo stay.
 */
export const imagesToMemo = async (
  client: MemosClient,
  text: string,
  link?: NoteLink,
  remote?: Memo,
): Promise<{
  content: string;
  attachments: AttachmentRef[];
  images: string[];
  imageCopies: Record<string, string>;
}> => {
  const remoteAttachments = remote?.attachments ?? [];
  const onRemote = new Map(remoteAttachments.map((a) => [attachmentId(a.name), a]));
  const copies = link?.imageCopies ?? {};
  // SP image id → attachment id and filename in Memos
  const files = new Map<string, { id: string; filename: string }>();
  for (const { url, id } of findLocalImages(text)) {
    noteImageUrl(url);
    if (files.has(id) || !isAttachmentId(id)) {
      continue;
    }
    const existing = onRemote.get(copies[id] ?? id);
    if (existing) {
      files.set(id, { id: attachmentId(existing.name), filename: existing.filename });
      // Another device's image (SP sync carries notes, not images): fetch it.
      await ensureLocal(client, id, existing);
      continue;
    }
    const uploaded = await upload(client, id, remote?.name);
    if (uploaded) {
      files.set(id, uploaded);
    }
  }
  const synced = new Set([...files.values()].map((f) => f.id));
  const removed = new Set((link?.images ?? []).filter((id) => !synced.has(id)));
  const kept = remoteAttachments
    .map((a) => attachmentId(a.name))
    .filter((id) => !removed.has(id) && !synced.has(id));
  return {
    content: toMemosForm(text, files),
    attachments: [...kept, ...synced].map((id) => ({ name: `attachments/${id}` })),
    images: [...synced],
    imageCopies: Object.fromEntries(
      [...files].filter(([spId, f]) => f.id !== spId).map(([spId, f]) => [spId, f.id]),
    ),
  };
};

/** Fetches the note's images that this device lacks but the memo has. */
export const fetchMissingImages = async (
  client: MemosClient,
  text: string,
  memo: Memo,
  link: NoteLink,
): Promise<void> => {
  const byId = new Map((memo.attachments ?? []).map((a) => [attachmentId(a.name), a]));
  for (const { id } of findLocalImages(text)) {
    const a = byId.get(link.imageCopies?.[id] ?? id);
    if (a) {
      await ensureLocal(client, id, a);
    }
  }
};

/** Image attachments of the memo that SP has not seen yet (added in Memos). */
const newImages = (memo: Memo, link: NoteLink, inline: string[]): MemoAttachment[] => {
  const known = new Set([...inline, ...(link.images ?? [])]);
  return (memo.attachments ?? []).filter(
    (a) => isImage(a) && !known.has(attachmentId(a.name)),
  );
};

/** True when the memo got images in Memos that SP has not taken over yet. */
export const hasNewImages = (memo: Memo, link: NoteLink, baseUrl: string): boolean =>
  newImages(memo, link, toSpForm(memo.content, baseUrl, attachmentIds(memo)).ids)
    .length > 0;

/**
 * Memo text (footer already stripped) → SP form. Images attached in Memos
 * but not shown in the text are appended, and all images are stored locally.
 */
export const imagesFromMemo = async (
  client: MemosClient,
  text: string,
  memo: Memo,
  link: NoteLink,
): Promise<{ notes: string; images: string[] }> => {
  const { text: converted, ids } = toSpForm(text, client.baseUrl, attachmentIds(memo));
  const added = newImages(memo, link, ids);
  const byId = new Map((memo.attachments ?? []).map((a) => [attachmentId(a.name), a]));
  const images = [...ids, ...added.map((a) => attachmentId(a.name))];
  for (const id of images) {
    const a = byId.get(id);
    if (a) {
      await ensureLocal(client, id, a);
    }
  }
  const appended = added
    .map((a) => `![${a.filename}](${localImageUrl(attachmentId(a.name))})`)
    .join('\n\n');
  return {
    notes: [converted.trimEnd(), appended].filter(Boolean).join('\n\n'),
    images,
  };
};
