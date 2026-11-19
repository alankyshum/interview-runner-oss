import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { SandboxManager } from './sandboxClient';
import { appendFrameAncestor, attachSandboxProxy, parseSandboxPath } from './sandboxProxy';

describe('sandbox proxy', () => {
  it('strips only the sandbox prefix', () => {
    expect(parseSandboxPath('/sandbox/12345678-abcd/healthz?x=1')).toEqual({ id: '12345678-abcd', forwarded: '/healthz?x=1', devServer: false });
    expect(parseSandboxPath('/sandbox/12345678-abcd/proxy/3000/')).toMatchObject({ forwarded: '/proxy/3000/', devServer: true });
    expect(parseSandboxPath('/other')).toBeUndefined();
  });

  it('preserves CSP while appending frame-ancestors', () => {
    expect(appendFrameAncestor("default-src 'none'; script-src 'self'")).toBe("default-src 'none'; script-src 'self'; frame-ancestors 'self'");
    expect(appendFrameAncestor("default-src 'none'; frame-ancestors https://example.test")).toContain("frame-ancestors https://example.test 'self'");
  });

  it('proxies HTTP with CSP rewrites and rejects unauthorized upgrades', async () => {
    const backend = createServer((request, response) => { response.setHeader('Content-Security-Policy', "default-src 'none'"); response.setHeader('X-Frame-Options', 'DENY'); response.end(request.url); }); backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    const backendAddress = backend.address(); const target = `http://127.0.0.1:${typeof backendAddress === 'object' && backendAddress ? backendAddress.port : 0}`;
    const manager = { get: (id: string) => id === '12345678-abcd' ? { id, status: 'running', target } : undefined, touch: () => {} } as any;
    const runner = createServer(); const attached = attachSandboxProxy(runner, manager, { allowHttpRequest: () => true, allowUpgradeRequest: () => false }); runner.on('request', attached.middleware); runner.listen(0, '127.0.0.1'); await once(runner, 'listening');
    const runnerAddress = runner.address(); const port = typeof runnerAddress === 'object' && runnerAddress ? runnerAddress.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sandbox/12345678-abcd/healthz`);
      expect(await response.text()).toBe('/healthz'); expect(response.headers.get('x-frame-options')).toBeNull(); expect(response.headers.get('content-security-policy')).toContain("default-src 'none'"); expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
      const raw = await new Promise<string>((resolveRaw, reject) => { const socket = connect(port, '127.0.0.1', () => socket.write('GET /sandbox/12345678-abcd/ HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')); let text = ''; socket.on('data', (chunk) => { text += chunk; }); socket.on('close', () => resolveRaw(text)); socket.on('error', reject); });
      expect(raw).toContain('403 Forbidden');
    } finally { attached.close(); runner.close(); backend.close(); }
  });

  it('checks authorization before initialization and reports unavailable HTTP and WebSocket requests', async () => {
    let allowed = false; const ensureStarted = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const runner = createServer();
    const attached = attachSandboxProxy(runner, { get: vi.fn() } as any, { allowHttpRequest: () => allowed, allowUpgradeRequest: () => allowed, ensureStarted });
    runner.on('request', attached.middleware); runner.listen(0, '127.0.0.1'); await once(runner, 'listening');
    const address = runner.address(); if (!address || typeof address === 'string') throw new Error('runner did not bind');
    const upgrade = () => new Promise<string>((resolveRaw, reject) => { const socket = connect(address.port, '127.0.0.1', () => socket.write('GET /sandbox/12345678-abcd/ HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')); let text = ''; socket.on('data', (chunk) => { text += chunk; }); socket.on('close', () => resolveRaw(text)); socket.on('error', reject); });
    try {
      expect((await fetch(`http://127.0.0.1:${address.port}/sandbox/12345678-abcd/`)).status).toBe(403);
      expect(await upgrade()).toContain('403 Forbidden'); expect(ensureStarted).not.toHaveBeenCalled();
      allowed = true;
      expect((await fetch(`http://127.0.0.1:${address.port}/sandbox/12345678-abcd/`)).status).toBe(503);
      expect(await upgrade()).toContain('503 Service Unavailable'); expect(ensureStarted).toHaveBeenCalledTimes(2);
    } finally { attached.close(); runner.closeAllConnections(); runner.close(); }
  });

  it('keeps a sandbox alive until the last proxied WebSocket has been idle for the timeout', async () => {
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const backend = createServer(); const wss = new WebSocketServer({ server: backend }); backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    const backendAddress = backend.address(); if (!backendAddress || typeof backendAddress === 'string') throw new Error('test backend did not bind');
    const id = '12345678-abcd'; const record = { id, courseId: 'course', drillId: 'drill', kind: 'coding' as const, status: 'running' as const, target: `http://127.0.0.1:${backendAddress.port}`, workspace: '/test', lastSeen: now };
    const remove = vi.fn(async () => {}); const manager = new SandboxManager({ list: async () => [record], create: vi.fn(), remove, removeWorkspace: vi.fn(), exec: vi.fn() } as any); await manager.start();
    const runner = createServer(); const attached = attachSandboxProxy(runner, manager, { allowHttpRequest: () => true, allowUpgradeRequest: () => true }); runner.listen(0, '127.0.0.1'); await once(runner, 'listening');
    const address = runner.address(); if (!address || typeof address === 'string') throw new Error('test runner did not bind');
    const sockets: WebSocket[] = [];
    try {
      for (let index = 0; index < 2; index++) { const socket = new WebSocket(`ws://127.0.0.1:${address.port}/sandbox/${id}/websocket`); sockets.push(socket); await once(socket, 'open'); }
      now += 16 * 60_000; await manager.reap(now); expect(remove).not.toHaveBeenCalled();
      sockets[0].close(); await once(sockets[0], 'close'); await vi.waitFor(() => expect(manager.get(id)?.lastSeen).toBe(now));
      now += 16 * 60_000; await manager.reap(now); expect(remove).not.toHaveBeenCalled();
      sockets[1].close(); await once(sockets[1], 'close'); await vi.waitFor(() => expect(manager.get(id)?.lastSeen).toBe(now));
      now += 15 * 60_000; await manager.reap(now); expect(remove).not.toHaveBeenCalled();
      now += 1; await manager.reap(now); expect(remove).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith(id, false); expect(manager.get(id)).toBeUndefined();
    } finally { for (const socket of sockets) socket.terminate(); attached.close(); manager.close(); wss.close(); runner.close(); backend.close(); clock.mockRestore(); }
  });

  it('releases a failed WebSocket upgrade so the sandbox can be reaped', async () => {
    const backend = createServer(); backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); const address = backend.address(); if (!address || typeof address === 'string') throw new Error('test backend did not bind'); await new Promise<void>((resolve) => backend.close(() => resolve()));
    const id = '12345678-abcd'; const record = { id, courseId: 'course', drillId: 'drill', kind: 'coding' as const, status: 'running' as const, target: `http://127.0.0.1:${address.port}`, workspace: '/test', lastSeen: Date.now() };
    const remove = vi.fn(async () => {}); const manager = new SandboxManager({ list: async () => [record], create: vi.fn(), remove, removeWorkspace: vi.fn(), exec: vi.fn() } as any); await manager.start();
    const runner = createServer(); const attached = attachSandboxProxy(runner, manager, { allowHttpRequest: () => true, allowUpgradeRequest: () => true }); runner.listen(0, '127.0.0.1'); await once(runner, 'listening'); const runnerAddress = runner.address(); if (!runnerAddress || typeof runnerAddress === 'string') throw new Error('test runner did not bind');
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${runnerAddress.port}/sandbox/${id}/websocket`); socket.on('error', () => {}); await new Promise<void>((resolve) => socket.once('close', () => resolve()));
      await vi.waitFor(async () => { await manager.reap(Date.now() + 16 * 60_000); expect(manager.get(id)).toBeUndefined(); }); expect(remove).toHaveBeenCalledOnce();
    } finally { attached.close(); manager.close(); runner.close(); }
  });
});
