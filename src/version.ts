declare const __DATA_VERSION__: string;
declare const __DATA_HASHES__: Record<string, string>;

/**
 * Game data (terrain, photos, models) keep their file names between releases, so every
 * URL carries the hash of that file's content: a release re-downloads exactly the files
 * that changed, and can never mix stale data from the HTTP cache or the service worker's
 * cache (which keeps one version per file).
 */
export const DATA_VERSION: string = __DATA_VERSION__;
const HASHES: Record<string, string> = __DATA_HASHES__;
const BASE = import.meta.env.BASE_URL;

export function dataUrl(url: string): string {
  const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${HASHES[path] ?? DATA_VERSION}`;
}
