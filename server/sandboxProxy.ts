import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import * as httpProxy from 'http-proxy-3';
import type { SandboxManager } from './sandboxClient';

const sandboxPath = /^\/sandbox\/([a-z0-9][a-z0-9-]{7,63})(?=\/|$)/;
export function parseSandboxPath(url: string | undefined): { id: string; forwarded: string; devServer: boolean } | undefined {
  if (!url) return undefined; const match = sandboxPath.exec(url); if (!match) return undefined;
  const forwarded = url.slice(match[0].length) || '/';
  return { id: match[1], forwarded: forwarded.startsWith('/') ? forwarded : `/${forwarded}`, devServer: /^\/(?:absproxy|proxy)\//.test(forwarded) };
}
export function appendFrameAncestor(value: string | string[] | undefined): string {
  const source = Array.isArray(value) ? value.join('; ') : value ?? '';
  const directives = source.split(';').map((item) => item.trim()).filter(Boolean);
  const at = directives.findIndex((item) => /^frame-ancestors\b/i.test(item));
  if (at < 0) directives.push("frame-ancestors 'self'");
  else if (!/(?:^|\s)'self'(?:\s|$)/.test(directives[at])) directives[at] += " 'self'";
  return directives.join('; ');
}

export function attachSandboxProxy(server: Server, manager: SandboxManager, options: { allowHttpRequest: (request: IncomingMessage) => boolean | Promise<boolean>; allowUpgradeRequest: (request: IncomingMessage) => boolean | Promise<boolean>; ensureStarted?: () => Promise<void> }) {
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false });
  const devServerRequests = new WeakSet<IncomingMessage>();
  proxy.on('proxyRes', (proxyResponse, request) => {
    delete proxyResponse.headers['x-frame-options'];
    proxyResponse.headers['content-security-policy'] = devServerRequests.has(request)
      ? 'sandbox allow-scripts allow-forms allow-popups allow-modals'
      : appendFrameAncestor(proxyResponse.headers['content-security-policy']);
  });
  proxy.on('error', (_error, request, response) => {
    if ('writeHead' in response) { const httpResponse = response as ServerResponse; if (!httpResponse.headersSent) httpResponse.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); httpResponse.end('Sandbox proxy unavailable'); }
    else (response as Duplex).destroy();
  });
  const middleware = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const parsed = parseSandboxPath(request.url); if (!parsed) return next();
    if (!await options.allowHttpRequest(request)) { response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Sandbox access denied'); return; }
    try { await options.ensureStarted?.(); } catch { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Sandbox service unavailable'); return; }
    const record = manager.get(parsed.id); if (!record) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Unknown sandbox'); return; }
    if (record.status !== 'running') { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Sandbox is stopped'); return; }
    manager.touch(parsed.id); request.url = parsed.forwarded; if (parsed.devServer) devServerRequests.add(request);
    proxy.web(request, response, { target: record.target });
  };
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const parsed = parseSandboxPath(request.url); if (!parsed) return;
    void Promise.resolve(options.allowUpgradeRequest(request)).then(async (allowed) => {
      if (socket.destroyed) return;
      if (!allowed) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      try { await options.ensureStarted?.(); } catch { if (!socket.destroyed) socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      if (socket.destroyed) return;
      const record = manager.get(parsed.id); if (!record) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      if (record.status !== 'running') { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const release = manager.trackSocket(parsed.id);
      const onClose = () => { socket.off('close', onClose); socket.off('error', onClose); release(); };
      socket.once('close', onClose); socket.once('error', onClose);
      request.url = parsed.forwarded; proxy.ws(request, socket, head, { target: record.target });
    }).catch(() => socket.destroy());
  };
  server.on('upgrade', upgrade);
  return { middleware, close: () => { server.off('upgrade', upgrade); proxy.close(); } };
}
