import { describe, it, expect, beforeAll } from 'vitest';
import { MetaMediaClient, MediaUploadError } from '../src/meta/media';
import { MetaApiError } from '../src/meta/errors';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { FetchLike } from '../src/meta/templates';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { MediaRouteDeps } from '../src/http/media';

function makeFetch(responses: Array<{ ok: boolean; status: number; json: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return { ok: r.ok, status: r.status, json: async () => r.json } as Response;
  };
  return { fn, calls };
}

describe('MetaMediaClient.uploadImage', () => {
  it('2 appels (start /{appId}/uploads puis POST session) -> handle', async () => {
    const { fn, calls } = makeFetch([
      { ok: true, status: 200, json: { id: 'upload:SESSION' } },
      { ok: true, status: 200, json: { h: 'HANDLE_ABC' } },
    ]);
    const client = new MetaMediaClient('tok', '988', 'v25.0', fn);
    const handle = await client.uploadImage(Buffer.from([1, 2, 3, 4]), 'image/png');
    expect(handle).toBe('HANDLE_ABC');
    expect(calls[0]!.url).toContain('/988/uploads');
    expect(calls[0]!.url).toContain('file_length=4');
    expect(calls[0]!.url).toContain('file_type=image%2Fpng');
    expect(calls[1]!.url).toContain('/upload:SESSION');
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('OAuth tok');
  });

  it('start HTTP non-ok -> MetaApiError', async () => {
    const { fn } = makeFetch([{ ok: false, status: 400, json: { error: { message: 'x', code: 100 } } }]);
    const client = new MetaMediaClient('tok', '988', 'v25.0', fn);
    await expect(client.uploadImage(Buffer.from([1]), 'image/png')).rejects.toBeInstanceOf(MetaApiError);
  });

  it('upload sans handle -> MediaUploadError', async () => {
    const { fn } = makeFetch([
      { ok: true, status: 200, json: { id: 'upload:S' } },
      { ok: true, status: 200, json: {} },
    ]);
    const client = new MetaMediaClient('tok', '988', 'v25.0', fn);
    await expect(client.uploadImage(Buffer.from([1]), 'image/png')).rejects.toBeInstanceOf(MediaUploadError);
  });
});

// --- Route media ---
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
const PNG_DATAURL = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71]).toString('base64');

function app(over: Partial<MediaRouteDeps> = {}) {
  const cap: { bytes?: Buffer; mime?: string } = {};
  const deps: MediaRouteDeps = {
    uploadImage: async (bytes, mime) => { cap.bytes = bytes; cap.mime = mime; return 'HANDLE'; },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, media: deps }), cap };
}

describe('route media', () => {
  it('POST admin -> 200 {handle}, décode le data URL', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/media', ...h(adminTok), payload: { dataUrl: PNG_DATAURL } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ handle: string }>().handle).toBe('HANDLE');
    expect(cap.mime).toBe('image/png');
    expect(cap.bytes?.length).toBe(4);
    await server.close();
  });

  it('POST agent -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/media', ...h(agentTok), payload: { dataUrl: PNG_DATAURL } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('POST vidéo mp4 -> 200 {handle}, mime video/mp4', async () => {
    const { server, cap } = app();
    const mp4 = 'data:video/mp4;base64,' + Buffer.from([0, 0, 0, 24]).toString('base64');
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/media', ...h(adminTok), payload: { dataUrl: mp4 } });
    expect(res.statusCode).toBe(200);
    expect(cap.mime).toBe('video/mp4');
    await server.close();
  });

  it('POST dataUrl invalide (pas image/vidéo) -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/media', ...h(adminTok), payload: { dataUrl: 'data:text/plain;base64,QQ==' } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('POST sans dataUrl -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/media', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});
