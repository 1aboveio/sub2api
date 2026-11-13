import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const hosts = new Set(['www.gafeteria.com', 'sub2api.gapsee.com']);
const encode = promisify(zlib.zstdCompress ?? zlib.gzip);
const encoding = zlib.zstdCompress ? 'zstd' : 'gzip';

export function compressionFetch(fetch, report = () => {}) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    // Pi's Responses SDK supplies serialized JSON in init.body. Other body
    // forms pass through without consuming a potentially non-replayable stream.
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) ||
        init?.method?.toUpperCase() !== 'POST' ||
        !headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
        headers.has('content-encoding') || typeof init.body !== 'string') {
      return fetch(input, init);
    }
    const original = Buffer.from(init.body);
    if (original.length < 16384) return fetch(input, init);
    const body = await encode(original);
    if (body.length >= original.length) return fetch(input, init);
    headers.set('content-encoding', encoding);
    headers.delete('content-length');
    report({ host: url.hostname, encoding, originalBytes: original.length, compressedBytes: body.length });
    return fetch(input, { ...init, headers, body });
  };
}