# Pi Request Compression

An opt-in pi extension that compresses large JSON uploads to these HTTPS hosts:

- `www.gafeteria.com`
- `sub2api.gapsee.com`

It uses zstd when the Node.js runtime supports it, otherwise gzip. The gateway
must already support decoding the chosen encoding. No pi source changes or
gateway deployment are required.

## Install

```sh
pi install npm:@1aboveio/pi-request-compression@0.1.0
```

Start a new pi session after installation. To try it without installing:

```sh
pi -e npm:@1aboveio/pi-request-compression@0.1.0
```

For this project only, use `pi install -l npm:@1aboveio/pi-request-compression@0.1.0`.

## Behavior

The extension wraps the configured provider's fetch transport while preserving
authentication, model settings, cancellation signals, and streamed responses.
Only POST requests with JSON string bodies of at least 16 KiB are eligible.
Already encoded bodies, binary bodies, other hosts, and plain HTTP pass through.
If compression does not reduce size, the original request is sent unchanged.

This targets pi's HTTP OpenAI Responses transport. WebSocket frames are not
compressed. Providers registered after session startup are not wrapped until
the extension loads in a new session. Unloading the package does not unwrap
providers in an existing session; restart pi to disable it completely.

Compression preserves message content, token counts, and prompt-cache keys.
It reduces upload bytes, not model generation time. No automatic uncompressed
fallback is attempted after a failed request, to avoid duplicate execution.

## Verify

```sh
PI_COMPRESSION_DEBUG=1 pi -e npm:@1aboveio/pi-request-compression@0.1.0
```

Debug output on stderr reports only host, encoding, original bytes, and
compressed bytes. It does not log prompts, API keys, or response content.
Check the gateway's access logs for `User-Agent: pi/...`,
`Content-Encoding: zstd` or `gzip`, uploaded bytes, and successful responses.

A live smoke against `sub2api.gapsee.com` completed a streamed response with
HTTP 200 and server-confirmed zstd upload. The synthetic repetitive payload
shrunk from 42,496 to 1,082 bytes; that ratio is not representative of normal
conversations, and the smoke does not establish a latency improvement.

## Remove

```sh
pi remove npm:@1aboveio/pi-request-compression@0.1.0
```

Restart pi afterwards. Use `-l` when removing a project-local installation.

## Development

From this directory:

```sh
npm test
npm pack
npm publish --access public --registry=https://registry.npmjs.org
```

Pi loads the TypeScript entry point directly. No compilation or bundled pi
dependencies are needed. The package includes only its declared source, tests,
documentation, license, and npm manifest.