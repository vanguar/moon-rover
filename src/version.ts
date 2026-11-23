declare const __DATA_VERSION__: string;

/**
 * Game data (terrain, photos, models) keep their file names between releases, so
 * every URL carries a hash of the data files: a new release can never be mixed with
 * stale data from the HTTP cache or the service worker's cache.
 */
export const DATA_VERSION: string = __DATA_VERSION__;

export function dataUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}v=${DATA_VERSION}`;
}
