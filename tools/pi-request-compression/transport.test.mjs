import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { compressionFetch } from './transport.mjs';

const payload = JSON.stringify({ input: 'sample message '.repeat(3000) });
const defaults = { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }, body: payload };

for (const host of ['www.gafeteria.com', 'sub2api.gapsee.com']) {
  test(`compresses ${host} without changing content or response`, async () => {
    const response = new Response('data: test\n\n');
    const signal = new AbortController().signal;
    let metadata;
    const fetch = compressionFetch(async (url, init) => {
      const encoding = init.headers.get('content-encoding');
      const decoded = encoding === 'zstd' ? zlib.zstdDecompressSync(init.body) : zlib.gunzipSync(init.body);
      assert.equal(decoded.toString(), payload);
      assert.ok(init.body.length < Buffer.byteLength(payload));
      assert.equal(init.headers.has('content-length'), false);
      assert.equal(init.headers.get('authorization'), 'Bearer test-secret');
      assert.equal(init.signal, signal);
      return response;
    }, value => { metadata = value; });
    assert.equal(await fetch(`https://${host}/v1/responses`, { ...defaults, signal, headers: { ...defaults.headers, authorization: 'Bearer test-secret' } }), response);
    assert.equal(metadata.host, host);
    assert.equal(JSON.stringify(metadata).includes('test-secret'), false);
  });
}

for (const [name, url, init] of [
  ['other host', 'https://api.openai.com/v1/responses', defaults],
  ['host suffix attack', 'https://www.gafeteria.com.example.org/v1/responses', defaults],
  ['plain HTTP', 'http://www.gafeteria.com/v1/responses', defaults],
  ['small body', 'https://www.gafeteria.com/v1/responses', { ...defaults, body: '{}' }],
  ['already encoded', 'https://www.gafeteria.com/v1/responses', { ...defaults, headers: { ...defaults.headers, 'content-encoding': 'gzip' } }],
  ['binary body', 'https://www.gafeteria.com/v1/responses', { ...defaults, body: Buffer.from(payload) }],
]) {
  test(`passes through ${name}`, async () => {
    const fetch = compressionFetch(async (actualUrl, actualInit) => {
      assert.equal(actualUrl, url);
      assert.equal(actualInit, init);
      return new Response();
    }, () => assert.fail('unexpected compression'));
    await fetch(url, init);
  });
}

test('propagates fetch errors without an uncompressed retry', async () => {
  let calls = 0;
  const fetch = compressionFetch(async () => { calls++; throw new Error('network failure'); });
  await assert.rejects(fetch('https://www.gafeteria.com/v1/responses', defaults), /network failure/);
  assert.equal(calls, 1);
});