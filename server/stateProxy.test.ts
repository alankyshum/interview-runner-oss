// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { effectiveCourseTags, effectiveCourseTagsFromMap, fetchAuthoritativeCourseTagMap, fetchAuthoritativeCourseTags, isStateRoute, proxyStateRequest, stateProxyForOrigin } from './stateProxy';

describe('development state proxy configuration', () => {
  it('keeps the local in-process database when no state origin is configured', () => {
    expect(stateProxyForOrigin(undefined)).toBeUndefined();
  });

  it('routes only persistent state APIs to one authoritative HTTPS origin', () => {
    expect(stateProxyForOrigin('https://courses.example.test:8080')).toBe('https://courses.example.test:8080');
    for (const path of ['/api/progress/course', '/api/progress/course/drill/submissions', '/api/attempts/course', '/api/attempts/course/drill', '/api/outline-state/course/drill', '/api/map-fold-state/course/drill', '/api/map-highlights/course/drill', '/api/recall-progress/course', '/api/cheatsheet-coverage/course', '/api/library', '/api/books']) expect(isStateRoute(path)).toBe(true);
    expect(isStateRoute('/api/evaluations/course/drill')).toBe(false);
    for (const path of ['/api/drills/course/drill/source', '/api/test-results', '/api/courses', '/api/map-recall/course/drill']) expect(isStateRoute(path)).toBe(false);
  });

  it.each(['not-a-url', 'http://remote.example.test', 'https://user:pass@example.test', 'https://example.test/path'])('rejects unsafe or ambiguous origin %s', (origin) => {
    expect(() => stateProxyForOrigin(origin)).toThrow(/INTERVIEW_RUNNER_STATE_ORIGIN/);
  });

  it('allows an HTTP loopback fixture for isolated tests', () => {
    expect(stateProxyForOrigin('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
  });

  it('forwards method, query, JSON body and response through an isolated state fixture', async () => {
    const observed: { method?: string; url?: string; body?: string; origin?: string; fetchSite?: string; calls: number } = { calls: 0 };
    const upstream = createServer(async (request, response) => { observed.calls += 1; observed.method = request.method; observed.url = request.url; observed.origin = request.headers.origin; observed.fetchSite = request.headers['sec-fetch-site'] as string | undefined; let body = ''; for await (const chunk of request) body += chunk; observed.body = body; response.statusCode = 201; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ authoritative: true })); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const upstreamAddress = upstream.address(); if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('fixture did not bind');
    const proxy = createServer((request, response) => { void proxyStateRequest(request, response, `http://127.0.0.1:${upstreamAddress.port}`); });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); const proxyAddress = proxy.address(); if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('proxy fixture did not bind');
    try {
      const localOrigin = `http://127.0.0.1:${proxyAddress.port}`; const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
      const result = await fetch(`${localOrigin}/api/progress/course/drill?source=dev`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: localOrigin, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ status: 'done' }) });
      expect(result.status).toBe(201); expect(await result.json()).toEqual({ authoritative: true }); expect(observed).toEqual({ calls: 1, method: 'PUT', url: '/api/progress/course/drill?source=dev', body: '{"status":"done"}', origin: upstreamOrigin, fetchSite: 'same-origin' });
      const forwardedOrigin = 'http://127.0.0.1:50891'; const forwarded = await fetch(`${localOrigin}/api/progress/course/drill`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: forwardedOrigin, 'sec-fetch-site': 'same-origin', 'x-forwarded-host': '127.0.0.1:50891', 'x-forwarded-proto': 'http' }, body: JSON.stringify({ status: 'in-progress' }) });
      expect(forwarded.status).toBe(201); expect(observed.calls).toBe(2); expect(observed.origin).toBe(upstreamOrigin);
      const rejected = await fetch(`${localOrigin}/api/progress/course/drill`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ status: 'blocked' }) });
      expect(rejected.status).toBe(403); expect(await rejected.json()).toEqual({ error: 'Origin not allowed' }); expect(observed.calls).toBe(2);
    } finally { proxy.close(); upstream.close(); await Promise.all([once(proxy, 'close'), once(upstream, 'close')]); }
  });

  it('reads effective course tags and preserves an explicit unknown-course result', async () => {
    let observedZone: string | string[] | undefined;
    const upstream = createServer((request, response) => { observedZone = request.headers['x-interview-time-zone']; response.setHeader('content-type', 'application/json'); if (request.url === '/api/courses') return response.end(JSON.stringify([{ id: 'shared', tags: ['Authoritative'] }, { id: 'untagged' }])); if (request.url === '/api/courses/shared') return response.end(JSON.stringify({ id: 'shared', tags: ['Authoritative'] })); response.statusCode = 404; response.end(JSON.stringify({ error: 'Unknown course' })); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('fixture did not bind'); const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect(await fetchAuthoritativeCourseTags(origin, 'shared', 'Asia/Kolkata')).toEqual({ known: true, tags: ['Authoritative'] }); expect(observedZone).toBe('Asia/Kolkata');
      await fetchAuthoritativeCourseTags(origin, 'shared', 'x'.repeat(129)); expect(observedZone).toBeUndefined();
      expect(await fetchAuthoritativeCourseTags(origin, 'local-only')).toEqual({ known: false, tags: undefined });
      const tags = await fetchAuthoritativeCourseTagMap(origin); expect(tags.has('shared')).toBe(true); expect(tags.get('shared')).toEqual(['Authoritative']); expect(tags.has('untagged')).toBe(true); expect(tags.get('untagged')).toBeUndefined();
      expect(effectiveCourseTags({ known: true, tags: ['Authoritative'] }, ['Local'])).toEqual(['Authoritative']); expect(effectiveCourseTags({ known: false, tags: undefined }, ['Local only'])).toEqual(['Local only']);
      expect(effectiveCourseTagsFromMap(tags, 'shared', ['Local'])).toEqual(['Authoritative']); expect(effectiveCourseTagsFromMap(tags, 'local-only', ['Local only'])).toEqual(['Local only']);
    } finally { upstream.close(); await once(upstream, 'close'); }
  });
});
