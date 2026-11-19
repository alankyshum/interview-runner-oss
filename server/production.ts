import { createServer } from 'node:http';
import { createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import connect from 'connect';
import sirv from 'sirv';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import apiPlugin, { isTrustedLocalAddress } from './apiPlugin';
import { packageRoot } from './packageRoot';

type AccessConfig = {
  readonly public?: false;
  readonly issuer: string;
  readonly audience: string;
  readonly emails: readonly string[];
  readonly serviceTokenIds?: readonly string[];
  readonly key: CryptoKey | JWTVerifyGetKey;
  readonly watchers?: boolean;
};

type PublicConfig = {
  readonly public: true;
  readonly basicAuth?: BasicAuthConfig;
  readonly watchers?: boolean;
};

type TailnetConfig = {
  readonly tailnet: true;
  readonly hostname: string;
  readonly proxyAddress: string;
  readonly watchers?: boolean;
};

// Self-hosted package: the runner is published on loopback only, so whoever
// reaches the port is the user. Exposure beyond loopback is the host's business.
type LocalConfig = {
  readonly local: true;
  readonly watchers?: boolean;
};
type ServerConfig = AccessConfig | PublicConfig | TailnetConfig | LocalConfig;
const sameOrigin = (request: Pick<import('node:http').IncomingMessage, 'headers'>): boolean => typeof request.headers.host === 'string' && (request.headers.origin === `http://${request.headers.host}` || request.headers.origin === `https://${request.headers.host}`);

export type BasicAuthConfig = { readonly username: string; readonly salt: Uint8Array; readonly hash: Uint8Array };
export const productionWatchersEnabled = (config: { readonly watchers?: boolean }): boolean => config.watchers ?? false;
const deriveKey = promisify(scrypt);
const hashedAsset = /^assets\/.+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
const hashedFont = /^\/excalidraw-assets\/fonts\/(?:[^/]+\/)+[^/]+-[a-f0-9]{32}\.woff2$/;

function staticAssets(): Set<string> {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'dist/.vite/manifest.json'), 'utf8')) as Record<string, { file?: string; css?: string[]; assets?: string[] }>;
  return new Set(Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]).filter((file): file is string => typeof file === 'string' && hashedAsset.test(file)).map((file) => `/${file}`));
}

function acceptedCompression(header: string | undefined): string {
  return (header ?? '').split(',').map((part) => part.trim()).filter((part) => {
    const [name, ...parameters] = part.split(';').map((value) => value.trim());
    if (!/^(?:br|gzip)$/i.test(name)) return false;
    const quality = parameters.find((value) => /^q=/i.test(value));
    if (!quality) return true;
    const value = quality.slice(2);
    return /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) && Number(value) > 0;
  }).map((part) => part.toLowerCase()).join(', ');
}
function denyBasic(response: import('node:http').ServerResponse): void {
  response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="courses"', 'Cache-Control': 'no-store' });
  response.end('Authentication required');
}
async function basicAllowed(header: string | string[] | undefined, config: BasicAuthConfig | undefined): Promise<boolean> {
  if (!config || typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const encoded = header.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 1024) return false;
  let decoded: string;
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch { return false; }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const username = decoded.slice(0, separator); const password = decoded.slice(separator + 1);
  const expectedUser = createHash('sha256').update(config.username).digest();
  const suppliedUser = createHash('sha256').update(username).digest();
  const suppliedHash = await deriveKey(password, config.salt, config.hash.byteLength) as Buffer;
  return timingSafeEqual(expectedUser, suppliedUser) && timingSafeEqual(Buffer.from(config.hash), suppliedHash);
}

function normalizedAddress(address: string | undefined): string {
  return (address ?? '').toLowerCase().replace(/^::ffff:/, '').replace(/%.*$/, '');
}

export function isTrustedTailnetProxyRequest(
  request: Pick<import('node:http').IncomingMessage, 'headers' | 'socket'>,
  config: Pick<TailnetConfig, 'hostname' | 'proxyAddress'>,
): boolean {
  let hostname: string;
  try { hostname = new URL(`http://${request.headers.host ?? ''}`).hostname; }
  catch { return false; }
  const forwarded = request.headers['x-forwarded-for'];
  const clientAddress = typeof forwarded === 'string' ? forwarded.split(',', 1)[0]?.trim() : undefined;
  return normalizedAddress(request.socket.remoteAddress) === normalizedAddress(config.proxyAddress)
    && hostname === config.hostname
    && isTrustedLocalAddress(clientAddress);
}

export async function upgradeAllowed(request: import('node:http').IncomingMessage, config: ServerConfig): Promise<boolean> {
  if ('local' in config) return sameOrigin(request);
  const exactOrigin = typeof request.headers.host === 'string' && request.headers.origin === `https://${request.headers.host}`;
  if ('tailnet' in config) return isTrustedTailnetProxyRequest(request, config) && exactOrigin;
  if (config.public) return await basicAllowed(request.headers.authorization, config.basicAuth) && exactOrigin;
  const token = request.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string') return false;
  try {
    const options = { issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], requiredClaims: ['exp'] };
    const { payload } = typeof config.key === 'function' ? await jwtVerify(token, config.key, options) : await jwtVerify(token, config.key, options);
    const humanAllowed = typeof payload.email === 'string' && config.emails.includes(payload.email);
    const serviceAllowed = typeof payload.common_name === 'string' && config.serviceTokenIds?.includes(payload.common_name) === true && payload.sub === '';
    return (humanAllowed || serviceAllowed) && exactOrigin;
  } catch { return false; }
}

export function createProductionServer(config: ServerConfig) {
  const middleware = connect();
  const server = createServer(middleware);
  middleware.use(async (request, response, next) => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Invalid request URL'); return; }
    if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/healthz') {
      response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return;
    }
    if ('local' in config) {
      // No identity check, but still refuse cross-site browser requests.
      if ((request.headers.origin && !sameOrigin(request))
        || (!['GET', 'HEAD'].includes(request.method ?? '') && request.headers['sec-fetch-site'] === 'cross-site')) {
        response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        response.end('Origin not allowed');
        return;
      }
      next();
      return;
    }
    if ('tailnet' in config) {
      if (!isTrustedTailnetProxyRequest(request, config)
        || (request.headers.origin && request.headers.origin !== `https://${request.headers.host}`)
        || (!['GET', 'HEAD'].includes(request.method ?? '') && request.headers['sec-fetch-site'] === 'cross-site')) {
        response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        response.end('Tailnet access required');
        return;
      }
      next();
      return;
    }
    if (config.public) {
      if (!await basicAllowed(request.headers.authorization, config.basicAuth)) { denyBasic(response); return; }
      // Basic-authenticated visitors must never be able to launch paid AI evaluation.
      const parts = pathname.split('/').filter(Boolean);
      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'evaluations') {
        response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'AI evaluation is disabled in public mode' }));
        return;
      }
      if ((request.headers.origin && request.headers.origin !== `https://${request.headers.host}`)
        || (!['GET', 'HEAD'].includes(request.method ?? '') && request.headers['sec-fetch-site'] === 'cross-site')) {
        response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        response.end('Origin not allowed');
        return;
      }
      next();
      return;
    }
    const token = request.headers['cf-access-jwt-assertion'];
    try {
      if (typeof token !== 'string') throw new Error('Access token required');
      const options = { issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], requiredClaims: ['exp'] };
      const { payload } = typeof config.key === 'function'
        ? await jwtVerify(token, config.key, options)
        : await jwtVerify(token, config.key, options);
      const humanAllowed = typeof payload.email === 'string' && config.emails.includes(payload.email);
      const serviceTokenAllowed = typeof payload.common_name === 'string'
        && config.serviceTokenIds?.includes(payload.common_name) === true
        && payload.sub === '';
      if (!humanAllowed && !serviceTokenAllowed) throw new Error('Identity not allowed');
      if (request.headers.origin && request.headers.origin !== `https://${request.headers.host}`) throw new Error('Origin not allowed');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Cloudflare Access authentication required');
      return;
    }
    next();
  });
  // Evaluation is gated above: verified Access identity, or disabled in public mode.
  // The public SSE stream is read-only; forwarded IP headers confer no trust.
  const api = apiPlugin({
    allowStreamRequest: () => true,
    ...('tailnet' in config || 'local' in config ? { allowCodingRequest: () => true } : {}),
    allowUpgradeRequest: (request) => upgradeAllowed(request, config),
    enableDeterministicWatchers: productionWatchersEnabled(config),
  });
  api.configureServer({ httpServer: server, middlewares: middleware });
  const assets = staticAssets();
  const cacheHeaders = (response: import('node:http').ServerResponse, pathname: string) => {
    const path = pathname.replace(/\.(?:br|gz)$/, '');
    response.setHeader('Cache-Control', assets.has(path) || hashedFont.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    response.setHeader('Vary', 'Accept-Encoding');
  };
  const staticServer = sirv(join(packageRoot, 'dist'), { single: true, etag: true, brotli: true, gzip: true, setHeaders: cacheHeaders });
  middleware.use((request, response, next) => {
    // Sirv returns 304 before invoking setHeaders, so set these for revalidation too.
    cacheHeaders(response, new URL(request.url ?? '/', 'http://localhost').pathname);
    request.headers['accept-encoding'] = acceptedCompression(request.headers['accept-encoding']);
    staticServer(request, response, next);
  });
  return {
    server,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
