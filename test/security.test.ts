import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { hostGuard, isAllowedHost } from '../server/security.ts';

test('only this server is an allowed Host', () => {
  assert.equal(isAllowedHost('127.0.0.1:4777', 4777), true);
  assert.equal(isAllowedHost('localhost:4777', 4777), true);
  assert.equal(isAllowedHost('LOCALHOST:4777', 4777), true);
  assert.equal(isAllowedHost('attacker.example:4777', 4777), false);
  assert.equal(isAllowedHost('127.0.0.1:4778', 4777), false);
  assert.equal(isAllowedHost('127.0.0.1', 4777), false);
  assert.equal(isAllowedHost(undefined, 4777), false);
});

test('requests with a rebinding Host are rejected before any route', async () => {
  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  app.use(hostGuard(port));
  app.get('/', (_req, res) => res.send('secret-token'));
  const get = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
  try {
    const evil = await get(`attacker.example:${port}`);
    assert.equal(evil.status, 403);
    assert.doesNotMatch(evil.body, /secret-token/);
    const ok = await get(`127.0.0.1:${port}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'secret-token');
  } finally {
    server.close();
  }
});
