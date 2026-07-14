import { describe, it, expect } from 'vitest';
import { buildEvent, postAnalysis, makeOnAnalyzed, PushApiError } from '../src/analysis/connector-push';
import { verifyMetaSignature } from '../src/lib/signature';
import type { HttpTransport, HttpResponse } from '../src/meta/http';
import type { StoredConversationAnalysis } from '../src/analysis/events';
import type { Enrichment } from '../src/analysis/enrichment';

class FakeTransport implements HttpTransport {
  readonly calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  private n = 0;
  constructor(private readonly responder: (n: number) => HttpResponse) {}
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.calls.push({ url, body, headers });
    return this.responder(this.n++);
  }
}

const stored: StoredConversationAnalysis = {
  conversationId: 'c1', tenantId: 't1', sentiment: 'neutre', intent: 'information', topic: 'x', resolved: true,
  entities: {}, action_suggestion: 'aucune', confidence: 0.5, justification: 'x', handled_by: 'humain', exchanges_count: 2,
};
const enr: Enrichment = {
  contactE164: '+33600000001', profileName: 'Jean', whatsappLine: '+33525680250',
  lastInboundAt: '2026-07-14 10:00:00.111+00', analyzedAt: '2026-07-14 10:05:00.222+00',
};
const ok = (): HttpResponse => ({ status: 200, json: { received: true } });

describe('buildEvent', () => {
  it('assemble eventId=convId:analyzedAt + identité + bloc analysis (sans conversationId/tenantId dedans)', () => {
    const ev = buildEvent(stored, enr);
    expect(ev.eventId).toBe('c1:2026-07-14 10:05:00.222+00');
    expect(ev).toMatchObject({ conversationId: 'c1', tenantId: 't1', contactE164: '+33600000001', whatsappLine: '+33525680250', lastInboundAt: enr.lastInboundAt });
    expect(ev.analysis).toMatchObject({ intent: 'information', handled_by: 'humain', exchanges_count: 2 });
    expect(ev.analysis).not.toHaveProperty('conversationId');
  });
});

describe('postAnalysis', () => {
  it('poste avec X-MMA-Signature valide (2xx -> ok)', async () => {
    const t = new FakeTransport(() => ok());
    await postAnalysis(buildEvent(stored, enr), { url: 'http://x/ingest', secret: 'S', transport: t });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe('http://x/ingest');
    const raw = JSON.stringify(t.calls[0]!.body);
    expect(verifyMetaSignature(Buffer.from(raw), t.calls[0]!.headers['x-mma-signature'], 'S')).toBe(true);
  });
  it('429 -> rejoué puis succès', async () => {
    const t = new FakeTransport((n) => (n === 0 ? { status: 429, json: {} } : ok()));
    await postAnalysis(buildEvent(stored, enr), { url: 'http://x', secret: 'S', transport: t });
    expect(t.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('400 -> terminal (PushApiError, pas rejoué)', async () => {
    const t = new FakeTransport(() => ({ status: 400, json: {} }));
    await expect(postAnalysis(buildEvent(stored, enr), { url: 'http://x', secret: 'S', transport: t })).rejects.toBeInstanceOf(PushApiError);
    expect(t.calls).toHaveLength(1);
  });
});

describe('makeOnAnalyzed', () => {
  it('désactivé -> no-op (rien enfilé) : INERTIE', async () => {
    let called = 0;
    const on = makeOnAnalyzed({ enabled: false, enqueue: async () => { called += 1; } });
    await on(stored);
    expect(called).toBe(0);
  });
  it('activé -> enfile le job push', async () => {
    const seen: StoredConversationAnalysis[] = [];
    const on = makeOnAnalyzed({ enabled: true, enqueue: async (s) => { seen.push(s); } });
    await on(stored);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.conversationId).toBe('c1');
  });
  it('enqueue échoue -> avalé (best-effort), ne remonte PAS (protège le job d\'analyse)', async () => {
    let errCaught = false;
    const on = makeOnAnalyzed({ enabled: true, enqueue: async () => { throw new Error('boom'); }, onError: () => { errCaught = true; } });
    await expect(on(stored)).resolves.toBeUndefined();
    expect(errCaught).toBe(true);
  });
});
