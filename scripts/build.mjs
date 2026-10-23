#!/usr/bin/env node
/**
 * Builds the plugin into dist/ (npm run build):
 * - bundles src/plugin.ts into dist/plugin.js as a minified IIFE,
 * - copies manifest.json, icon.svg and i18n/*.json (src/ first, then the root).
 *
 * With --zip (npm run package) it also writes plugin.zip with the content of
 * dist/, ready to upload under Settings → Plugins.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const ZIP = path.join(ROOT, 'plugin.zip');

const findAsset = (name) =>
  [path.join(SRC, name), path.join(ROOT, name)].find((p) => fs.existsSync(p));

const copyAssets = () => {
  for (const name of ['manifest.json', 'icon.svg']) {
    const file = findAsset(name);
    if (!file) {
      throw new Error(`${name} not found`);
    }
    fs.copyFileSync(file, path.join(DIST, name));
  }
  const i18n = findAsset('i18n');
  if (i18n) {
    fs.mkdirSync(path.join(DIST, 'i18n'));
    for (const file of fs.readdirSync(i18n).filter((f) => f.endsWith('.json'))) {
      fs.copyFileSync(path.join(i18n, file), path.join(DIST, 'i18n', file));
    }
  }
};

const listFiles = (dir, prefix = '') =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

const crc32 = (buf) => {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Minimal zip writer (deflate, no zip64): enough for a handful of small files. */
const writeZip = (dir, out) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of listFiles(dir).sort()) {
    const data = fs.readFileSync(path.join(dir, name));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    // Fixed timestamp (1980-01-01), so the same input gives the same zip.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, deflated);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
};

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);
await build({
  entryPoints: [path.join(SRC, 'plugin.ts')],
  outfile: path.join(DIST, 'plugin.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
  minify: true,
  sourcemap: false,
});
copyAssets();

if (process.argv.includes('--zip')) {
  writeZip(DIST, ZIP);
  console.log(`Wrote ${path.relative(ROOT, ZIP)}`);
}
