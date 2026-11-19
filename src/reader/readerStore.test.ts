// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverReaderStore } from './readerStore';

describe('serverReaderStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads empty state and round-trips a node update over HTTP', async () => {
    let state: Record<string, { checked?: boolean }> = {};
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/outline-state/example-book/first-chapter') return response.end(JSON.stringify(state));
      if (request.method === 'PUT' && request.url === '/api/outline-state/example-book/first-chapter/latency') {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        state = { latency: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; return response.end('{}');
      }
      response.writeHead(404); response.end('{}');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const realFetch = globalThis.fetch; vi.stubGlobal('fetch', (path: string, init?: RequestInit) => realFetch(`http://127.0.0.1:${address.port}${path}`, init));
    try {
      await expect(serverReaderStore.load('example-book', 'first-chapter')).resolves.toEqual({});
      await serverReaderStore.set('example-book', 'first-chapter', 'latency', { checked: true });
      await expect(serverReaderStore.load('example-book', 'first-chapter')).resolves.toEqual({ latency: { checked: true } });
    } finally { server.close(); await once(server, 'close'); }
  });
});
