import { createRemoteJWKSet } from 'jose';
import { createProductionServer, type BasicAuthConfig } from './production';

function basicAuthFromEnvironment(): BasicAuthConfig | undefined {
  const username = process.env.COURSES_BASIC_AUTH_USERNAME;
  const saltValue = process.env.COURSES_BASIC_AUTH_SALT;
  const hashValue = process.env.COURSES_BASIC_AUTH_HASH;
  if (!username || !saltValue || !hashValue || username.includes(':') || /[\u0000-\u001f\u007f]/.test(username)) return undefined;
  const salt = Buffer.from(saltValue, 'base64url'); const hash = Buffer.from(hashValue, 'base64url');
  return salt.length >= 16 && salt.length <= 64 && hash.length === 32 ? { username, salt, hash } : undefined;
}

function createApp() {
  const mode = process.env.RUNNER_ACCESS_MODE ?? 'access';
  if (mode === 'public') {
    return createProductionServer({ public: true, basicAuth: basicAuthFromEnvironment() });
  }
  if (mode === 'local') return createProductionServer({ local: true });
  if (mode === 'tailnet') {
    const hostname = process.env.RUNNER_TAILNET_HOSTNAME;
    const proxyAddress = process.env.RUNNER_TRUSTED_PROXY_IP;
    if (!hostname || hostname.includes(':') || hostname !== hostname.toLowerCase()) throw new Error('RUNNER_TAILNET_HOSTNAME must be a lowercase hostname');
    if (!proxyAddress) throw new Error('RUNNER_TRUSTED_PROXY_IP is required in tailnet mode');
    return createProductionServer({ tailnet: true, hostname, proxyAddress });
  }
  if (mode !== 'access') throw new Error('RUNNER_ACCESS_MODE must be access, local, public, or tailnet');
  const issuer = process.env.CF_ACCESS_ISSUER;
  const audience = process.env.CF_ACCESS_AUD;
  const emails = process.env.CF_ACCESS_EMAILS?.split(',');
  const serviceTokenIds = process.env.CF_ACCESS_SERVICE_TOKEN_IDS?.split(',').map((id) => id.trim()).filter(Boolean);
  if (!issuer || !audience || !emails?.length || emails.some((email) => !email.includes('@'))) throw new Error('Access issuer, audience and email allowlist are required');
  const url = new URL(issuer);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com') || url.pathname !== '/') throw new Error('Invalid Access issuer');
  return createProductionServer({ issuer, audience, emails, serviceTokenIds, key: createRemoteJWKSet(new URL('/cdn-cgi/access/certs', url), { timeoutDuration: 5000 }) });
}

process.env.RUNNER_ACCESS_MODE ??= 'access';
const app = createApp();
app.server.listen(3000, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
