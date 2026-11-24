/**
 * Decoder of heightmap.bin (written by tools/heightmap_io.py, format described there):
 * "HM16", uint32 LE width and height, then a zlib stream of the low and the high byte
 * planes of the zigzag-coded residuals of the planar predictor W + N - NW.
 * Inflated by the browser's native DecompressionStream.
 */
export interface Heightmap {
  width: number;
  height: number;
  data: Uint16Array;
}

export async function decodeHeightmap(buf: ArrayBuffer): Promise<Heightmap> {
  const head = new DataView(buf, 0, 12);
  if (head.getUint32(0) !== 0x484d3136) throw new Error('Not a heightmap.bin file'); // "HM16"
  const width = head.getUint32(4, true), height = head.getUint32(8, true);
  const stream = new Blob([new Uint8Array(buf, 12)]).stream().pipeThrough(new DecompressionStream('deflate'));
  const planes = new Uint8Array(await new Response(stream).arrayBuffer());
  const n = width * height;
  if (planes.length !== 2 * n) throw new Error('Truncated heightmap.bin');
  const data = new Uint16Array(n);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const z = planes[i] | (planes[n + i] << 8);
      const r = (z >>> 1) ^ -(z & 1);
      const p = y === 0 ? (x === 0 ? 0 : data[i - 1]) : x === 0 ? data[i - width] : data[i - 1] + data[i - width] - data[i - width - 1];
      data[i] = (p + r) & 0xffff;
    }
  }
  return { width, height, data };
}
