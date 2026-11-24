// Bakes the fractured-pavement height pattern (src/terrain/Pavement.ts) into
// public/data/mars/pavement.png, so the game loads it instead of computing it (~3 s).
// Usage: npx tsx tools/make_pavement.ts
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
(globalThis as unknown as { __DATA_VERSION__: string }).__DATA_VERSION__ = 'build';
const { buildPavement, PAVE_N } = await import('../src/terrain/Pavement');
const p = buildPavement();
const N = PAVE_N;
const raw = Buffer.alloc((N + 1) * N);
for (let j = 0; j < N; j++) {
  raw[j * (N + 1)] = 0;
  Buffer.from(p.buffer, j * N, N).copy(raw, j * (N + 1) + 1);
}
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
writeFileSync('public/data/mars/pavement.png', png);
console.log('pavement.png', (png.length / 1e6).toFixed(2), 'MB');
