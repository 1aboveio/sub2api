#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [caddy, config = 'deploy/vm/Caddyfile'] = process.argv.slice(2);
assert.ok(caddy, 'Usage: node deploy/tests/caddy-stream-cancellation-test.mjs /path/to/caddy [Caddyfile]');

function findProxy(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.handler === 'reverse_proxy') return value;
  for (const child of Object.values(value)) {
    const proxy = findProxy(child);
    if (proxy) return proxy;
  }
}

function deadline(promise, label, milliseconds = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

const directory = await mkdtemp(join(tmpdir(), 'sub2api-caddy-cancellation-'));
const upstream = http.createServer();
const portReservation = http.createServer();
const controller = new AbortController();
let processHandle;
let caddyLog = '';
try {
  const adapted = JSON.parse(execFileSync(caddy, [
    'adapt', '--config', resolve(config), '--adapter', 'caddyfile',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const proxy = findProxy(adapted);
  assert.ok(proxy, 'The Caddy configuration must contain a reverse proxy');

  let closeUpstream;
  const upstreamClosed = new Promise(resolve => { closeUpstream = resolve; });
  upstream.on('request', (_request, response) => {
    response.on('close', closeUpstream);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write('data: cancellation-check\n\n');
    // Keep the upstream open: the client must receive the event before EOF,
    // and its disconnect must close this otherwise-idle upstream response.
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await listen(portReservation);
  await new Promise(resolve => portReservation.close(resolve));
  proxy.upstreams = [{ dial: `127.0.0.1:${upstreamPort}` }];
  delete proxy.health_checks;

  const runtimeConfig = join(directory, 'caddy.json');
  await writeFile(runtimeConfig, JSON.stringify({
    admin: { disabled: true },
    apps: { http: { servers: { test: {
      listen: [`127.0.0.1:${proxyPort}`],
      automatic_https: { disable: true },
      routes: [{ handle: [proxy] }],
    } } } },
  }));

  let ready;
  let failed;
  const started = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  processHandle = spawn(caddy, ['run', '--config', runtimeConfig], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory },
  });
  processHandle.on('error', failed);
  processHandle.on('exit', code => failed(new Error(`Caddy exited before readiness: ${code}`)));
  processHandle.stderr.on('data', chunk => {
    caddyLog += chunk.toString();
    if (caddyLog.includes('"msg":"server running"')) ready();
  });
  await deadline(started, 'Caddy did not start');

  const response = await deadline(fetch(`http://127.0.0.1:${proxyPort}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: controller.signal,
  }), 'SSE headers were not flushed');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const event = await deadline((async () => {
    let text = '';
    while (!text.includes('\n\n')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'The upstream ended before delivering an SSE event');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  })(), 'SSE event was buffered until EOF');
  assert.match(event, /data: cancellation-check\n\n/);
  console.log('PASS: SSE event arrives while the upstream stream remains open');

  controller.abort();
  await deadline(upstreamClosed, 'Client disconnect did not cancel the upstream request');
  console.log('PASS: Client disconnect closes the idle upstream stream');
} catch (error) {
  console.error(caddyLog);
  throw error;
} finally {
  controller.abort();
  upstream.closeAllConnections();
  upstream.close();
  portReservation.close();
  if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
    const exited = once(processHandle, 'exit');
    processHandle.kill('SIGTERM');
    await deadline(exited, 'Caddy did not stop').catch(() => processHandle.kill('SIGKILL'));
  }
  await rm(directory, { recursive: true, force: true });
}