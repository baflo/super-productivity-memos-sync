import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBlob,
  basePathFromFileUrl,
  blobToBase64,
  extensionFor,
  findLocalImages,
  isAttachmentId,
  toMemosForm,
  toSpForm,
} from '../src/images.ts';

const BASE = 'https://memos.localhost:5443';
const WEB_ID = 'clip-1793087000000-abcd1234';
const FILE_ID = 'clip-1793087000001-zzzz9999';
const WEB = `indexeddb://clipboard-images/${WEB_ID}`;
const FILE = `file:///home/flo/.config/superProductivity/clipboard-images/${FILE_ID}.png`;

test('findLocalImages finds web and Electron image URLs once each', () => {
  const notes = `a ![pasted image](${WEB}) b ![x](${FILE})\n![again](${WEB} =200x)`;
  assert.deepEqual(findLocalImages(notes), [
    { url: WEB, id: WEB_ID },
    { url: FILE, id: FILE_ID },
  ]);
});

test('toMemosForm replaces only images with a known attachment, copies by their own id', () => {
  const notes = `![a](${WEB} =200x) ![b](${FILE}) ![c](indexeddb://clipboard-images/clip-1-unknown)`;
  const files = new Map([
    [WEB_ID, { id: WEB_ID, filename: `${WEB_ID}.png` }],
    [FILE_ID, { id: 'copy-1', filename: `${FILE_ID}.png` }],
  ]);
  assert.equal(
    toMemosForm(notes, files),
    `![a](/file/attachments/${WEB_ID}/${WEB_ID}.png =200x) ` +
      `![b](/file/attachments/copy-1/${FILE_ID}.png) ` +
      '![c](indexeddb://clipboard-images/clip-1-unknown)',
  );
});

test('toSpForm turns relative and absolute memo images back into local URLs', () => {
  const memo =
    `x ![a](/file/attachments/${WEB_ID}/${WEB_ID}.png) ` +
    `![b](${BASE}/file/attachments/${FILE_ID}/${FILE_ID}.png =200x) ` +
    `![other](https://elsewhere.example/file/attachments/abc/abc.png) ` +
    'text /file/attachments/notalink/x.png';
  assert.deepEqual(toSpForm(memo, BASE), {
    text:
      `x ![a](${WEB}) ![b](indexeddb://clipboard-images/${FILE_ID} =200x) ` +
      `![other](https://elsewhere.example/file/attachments/abc/abc.png) ` +
      'text /file/attachments/notalink/x.png',
    ids: [WEB_ID, FILE_ID],
  });
});

test('toSpForm with `only` leaves attachments of other memos alone', () => {
  const url = `${BASE}/file/attachments/foreign1/pic.png`;
  assert.deepEqual(toSpForm(`![p](${url})`, BASE, new Set([WEB_ID])), {
    text: `![p](${url})`,
    ids: [],
  });
});

test('round trip SP → Memos → SP keeps web notes unchanged', () => {
  const notes = `Plan\n\n![pasted image](${WEB})\n\nmore`;
  const memo = toMemosForm(notes, new Map([[WEB_ID, { id: WEB_ID, filename: `${WEB_ID}.png` }]]));
  assert.equal(toSpForm(memo, BASE).text, notes);
});

test('isAttachmentId accepts SP image ids and rejects others', () => {
  assert.ok(isAttachmentId(WEB_ID));
  assert.ok(!isAttachmentId('-bad'));
  assert.ok(!isAttachmentId('a'.repeat(37)));
  assert.ok(!isAttachmentId('with space'));
});

test('extensionFor maps common image types', () => {
  assert.equal(extensionFor('image/png'), 'png');
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('image/svg+xml'), 'svg');
});

test('base64 round trip', async () => {
  const blob = base64ToBlob(btoa('hello'), 'text/plain');
  assert.equal(blob.type, 'text/plain');
  assert.equal(await blobToBase64(blob), btoa('hello'));
});

test('basePathFromFileUrl handles POSIX and Windows file URLs', () => {
  assert.equal(basePathFromFileUrl(FILE), '/home/flo/.config/superProductivity/clipboard-images');
  assert.equal(
    basePathFromFileUrl('file:///C:/Users/Flo/AppData/clipboard-images/clip-1.png'),
    'C:/Users/Flo/AppData/clipboard-images',
  );
  assert.equal(basePathFromFileUrl(WEB), undefined);
});
