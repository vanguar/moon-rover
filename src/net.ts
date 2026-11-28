/**
 * Downloads a file as a Blob, reporting the received fraction (by Content-Length) as it streams.
 * The body is always read through its stream reader: Response.blob() on a response that
 * was taken over from an HTML <link rel=preload as=fetch> now and then never settled in
 * Chrome (about one load in ten stuck on the loading screen).
 */
export async function fetchBlob(url: string, onProgress?: (f: number) => void, expected = 4e6): Promise<Blob> {
  // A dropped connection mid-file ("network error": Wi-Fi hiccup, mobile handover, the
  // site being redeployed) is retried from the start instead of failing the whole load.
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchBlobOnce(url, onProgress, expected);
    } catch (e) {
      const http = e instanceof Error && / HTTP 4\d\d$/.test(e.message);
      if (http || attempt >= 4) throw e;
      onProgress?.(0);
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }
}

async function fetchBlobOnce(url: string, onProgress: ((f: number) => void) | undefined, expected: number): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!res.body) return res.blob();
  const total = Number(res.headers.get('content-length')) || expected;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  return new Blob(parts as BlobPart[], { type: res.headers.get('content-type') ?? '' });
}
