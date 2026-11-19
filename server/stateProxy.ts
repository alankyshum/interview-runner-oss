export const STATE_ROUTE_PREFIXES = [
  '/api/progress',
  '/api/attempts',
  '/api/outline-state',
  '/api/map-fold-state',
  '/api/map-highlights',
  '/api/recall-progress',
  '/api/cheatsheet-coverage',
  '/api/recall-whiteboards',
  '/api/book-chapter-rank',
  '/api/library',
  '/api/books',
] as const;

export function isStateRoute(pathname: string): boolean { return STATE_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)); }

export function stateProxyForOrigin(value: string | undefined): string | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('INTERVIEW_RUNNER_STATE_ORIGIN must be an absolute URL'); }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('INTERVIEW_RUNNER_STATE_ORIGIN must use HTTPS unless it is loopback');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('INTERVIEW_RUNNER_STATE_ORIGIN must contain only an origin');
  return url.origin;
}

const hopByHopHeaders = new Set(['connection', 'content-encoding', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function sameOriginBrowserRequest(request: import('node:http').IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const raw = request.headers.origin;
  if (!raw) return true;
  if (Array.isArray(raw) || !request.headers.host) return false;
  try {
    const origin = new URL(raw); if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    const hosts = new Set([request.headers.host]); const remote = request.socket.remoteAddress?.replace(/^::ffff:/, '').replace(/%.*$/, '');
    const forwardedHost = request.headers['x-forwarded-host']; const forwardedProto = request.headers['x-forwarded-proto'];
    if ((remote === '127.0.0.1' || remote === '::1') && typeof forwardedHost === 'string' && !forwardedHost.includes(',')) {
      hosts.add(forwardedHost.trim()); if (typeof forwardedProto === 'string' && !forwardedProto.includes(',') && `${forwardedProto.trim()}:` !== origin.protocol) return false;
    }
    return hosts.has(origin.host);
  }
  catch { return false; }
}

export async function proxyStateRequest(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, origin: string): Promise<void> {
  if (!sameOriginBrowserRequest(request)) { response.statusCode = 403; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: 'Origin not allowed' })); return; }
  const method = request.method ?? 'GET'; const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined || hopByHopHeaders.has(name.toLowerCase()) || name.toLowerCase() === 'origin' || name.toLowerCase() === 'sec-fetch-site' || name.toLowerCase().startsWith('x-forwarded-')) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) headers.append(name, value);
  }
  if (request.headers.origin) { headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin'); }
  const chunks: Buffer[] = [];
  if (method !== 'GET' && method !== 'HEAD') for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const upstream = await fetch(new URL(request.url ?? '/', origin), { method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => { if (!hopByHopHeaders.has(name.toLowerCase())) response.setHeader(name, value); });
  response.end(method === 'HEAD' ? undefined : Buffer.from(await upstream.arrayBuffer()));
}

export type AuthoritativeCourseTags = { known: boolean; tags: string[] | undefined };
export const effectiveCourseTags = (authoritative: AuthoritativeCourseTags | undefined, localTags: string[] | undefined): string[] | undefined => authoritative?.known ? authoritative.tags : localTags;
export const effectiveCourseTagsFromMap = (authoritative: ReadonlyMap<string, string[] | undefined> | undefined, courseId: string, localTags: string[] | undefined): string[] | undefined => authoritative?.has(courseId) ? authoritative.get(courseId) : localTags;

export async function fetchAuthoritativeCourse(origin: string, courseId: string, timeZone?: string | string[]): Promise<AuthoritativeCourseTags & { deadline?: string; tier?: 1 | 2 | 3 }> {
  const headers = typeof timeZone === 'string' && timeZone.length <= 128 && /^[\x20-\x7e]+$/.test(timeZone) ? { 'x-interview-time-zone': timeZone } : undefined;
  const response = await fetch(new URL(`/api/courses/${encodeURIComponent(courseId)}`, origin), headers ? { headers } : undefined);
  if (response.status === 404) return { known: false, tags: undefined };
  if (!response.ok) throw new Error('Authoritative state service is unavailable');
  const value = await response.json() as { tags?: unknown; deadline?: unknown; tier?: unknown };
  return { known: true, tags: Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string') ? value.tags : undefined, deadline: typeof value.deadline === 'string' ? value.deadline : undefined, tier: value.tier === 1 || value.tier === 2 || value.tier === 3 ? value.tier : undefined };
}
export async function fetchAuthoritativeCourseTags(origin: string, courseId: string, timeZone?: string | string[]): Promise<AuthoritativeCourseTags> { const { known, tags } = await fetchAuthoritativeCourse(origin, courseId, timeZone); return { known, tags }; }

export async function fetchAuthoritativeCourseMap(origin: string): Promise<Map<string, { tags?: string[]; deadline?: string; tier?: 1 | 2 | 3 }>> {
  const response = await fetch(new URL('/api/courses', origin));
  if (!response.ok) throw new Error('Authoritative state service is unavailable');
  const value = await response.json() as unknown;
  if (!Array.isArray(value)) throw new Error('Authoritative course response is invalid');
  const courses = new Map<string, { tags?: string[]; deadline?: string; tier?: 1 | 2 | 3 }>();
  for (const item of value) if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
    const raw = item as { id: string; tags?: unknown; deadline?: unknown; tier?: unknown };
    courses.set(raw.id, { tags: Array.isArray(raw.tags) && raw.tags.every((tag) => typeof tag === 'string') ? raw.tags : undefined, deadline: typeof raw.deadline === 'string' ? raw.deadline : undefined, tier: raw.tier === 1 || raw.tier === 2 || raw.tier === 3 ? raw.tier : undefined });
  }
  return courses;
}
export async function fetchAuthoritativeCourseTagMap(origin: string): Promise<Map<string, string[] | undefined>> { return new Map([...await fetchAuthoritativeCourseMap(origin)].map(([id, course]) => [id, course.tags])); }
