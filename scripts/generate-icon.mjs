// Generate the Windows app/installer icon (public/icon.ico) from public/logo.svg.
//
// The previous icon.ico was actually a PNG renamed to .ico, which made
// electron-winstaller/rcedit fail with "Unable to set icon" when stamping the
// Squirrel Setup.exe. A real .ico is a multi-resolution container; we render
// the logo at the standard sizes and assemble a valid (PNG-compressed) ICO,
// which Windows (Vista+) and rcedit accept. Also refreshes icon.png at 256px.
//
//   node scripts/generate-icon.mjs
//
// Requires: rsvg-convert (brew install librsvg).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const PUBLIC = path.resolve('public');
const SVG = path.join(PUBLIC, 'logo.svg');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function renderPng(size) {
    const out = path.join(os.tmpdir(), `mmop-icon-${size}.png`);
    const res = spawnSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, SVG], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`rsvg-convert failed for ${size}px`);
    const data = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return data;
}

/** Assemble a valid ICO file from PNG-encoded images (one per size). */
function buildIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: 1 = icon
    header.writeUInt16LE(images.length, 4);

    const directory = Buffer.alloc(16 * images.length);
    let offset = 6 + directory.length;
    const payloads = [];

    images.forEach((img, i) => {
        const e = directory.subarray(i * 16, i * 16 + 16);
        e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width (0 means 256)
        e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
        e.writeUInt8(0, 2);  // palette color count
        e.writeUInt8(0, 3);  // reserved
        e.writeUInt16LE(1, 4);   // color planes
        e.writeUInt16LE(32, 6);  // bits per pixel
        e.writeUInt32LE(img.data.length, 8); // image data size
        e.writeUInt32LE(offset, 12);         // image data offset
        offset += img.data.length;
        payloads.push(img.data);
    });

    return Buffer.concat([header, directory, ...payloads]);
}

const images = SIZES.map((size) => ({ size, data: renderPng(size) }));
fs.writeFileSync(path.join(PUBLIC, 'icon.ico'), buildIco(images));
// Keep icon.png a crisp square for Linux / the in-app window icon.
fs.writeFileSync(path.join(PUBLIC, 'icon.png'), images[images.length - 1].data);

console.log(`Wrote public/icon.ico (${SIZES.join(', ')} px) and public/icon.png (256 px).`);
