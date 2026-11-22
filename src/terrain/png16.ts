/**
 * Minimal decoder for 16-bit grayscale, non-interlaced PNG (the heightmap format).
 * Browsers' <canvas> reduces PNGs to 8 bits per channel, so we inflate the IDAT
 * stream ourselves with the native DecompressionStream and undo the row filters.
 */
export interface Png16 {
  width: number;
  height: number;
  data: Uint16Array;
}

export async function decodePng16(buf: ArrayBuffer): Promise<Png16> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('Not a PNG');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (pos < bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = pos + 8;
    if (type === 'IHDR') {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      bitDepth = bytes[body + 8];
      colorType = bytes[body + 9];
      interlace = bytes[body + 12];
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(body, body + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = body + len + 4;
  }
  if (bitDepth !== 16 || colorType !== 0 || interlace !== 0) {
    throw new Error(`Unsupported PNG: depth ${bitDepth}, color ${colorType}, interlace ${interlace}`);
  }

  const stream = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());

  const bpp = 2;
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let v: number;
      switch (ft) {
        case 0: v = r; break;
        case 1: v = r + a; break;
        case 2: v = r + b; break;
        case 3: v = r + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Bad PNG filter ${ft}`);
      }
      out[dst + x] = v & 255;
    }
  }
  const data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = (out[2 * i] << 8) | out[2 * i + 1];
  return { width, height, data };
}
