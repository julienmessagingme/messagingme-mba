import { describe, it, expect } from 'vitest';
import { AnthropicClient, createLlmClient, LlmApiError } from '../src/analysis/llm-client';
import type { HttpTransport, HttpResponse } from '../src/meta/http';

class FakeTransport implements HttpTransport {
  readonly calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  private n = 0;
  constructor(private readonly responder: (n: number) => HttpResponse) {}
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.calls.push({ url, body: body as Record<string, unknown>, headers });
    return this.responder(this.n++);
  }
}

const ok = (text: string): HttpResponse => ({ status: 200, json: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
// withRetry a un vrai sleep : pour tester le retry sans attendre 300ms, on ne teste que le CAS non rejoué + un 429->OK borné.

describe('AnthropicClient', () => {
  it('poste au bon endpoint avec x-api-key + version, renvoie le texte', async () => {
    const t = new FakeTransport(() => ok('RÉPONSE'));
    const out = await new AnthropicClient('sk-test', 'claude-haiku-4-5', 1024, t).complete({ system: 'S', user: 'U' });
    expect(out).toBe('RÉPONSE');
    expect(t.calls[0]!.url).toContain('/v1/messages');
    expect(t.calls[0]!.headers['x-api-key']).toBe('sk-test');
    expect(t.calls[0]!.headers['anthropic-version']).toBeTruthy();
    expect(t.calls[0]!.body).toMatchObject({ model: 'claude-haiku-4-5', system: 'S', messages: [{ role: 'user', content: 'U' }] });
  });

  it('429 -> rejoué par withRetry puis succès', async () => {
    const t = new FakeTransport((n) => (n === 0 ? { status: 429, json: { error: { message: 'rate' } } } : ok('OK')));
    const out = await new AnthropicClient('k', 'm', 10, t).complete({ system: 's', user: 'u' });
    expect(out).toBe('OK');
    expect(t.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('400 -> LlmApiError terminal, PAS rejoué', async () => {
    const t = new FakeTransport(() => ({ status: 400, json: { error: { message: 'bad' } } }));
    await expect(new AnthropicClient('k', 'm', 10, t).complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmApiError);
    expect(t.calls).toHaveLength(1);
  });

  it('refusal (HTTP 200) -> erreur terminale, pas de retry', async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { content: [], stop_reason: 'refusal' } }));
    await expect(new AnthropicClient('k', 'm', 10, t).complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmApiError);
    expect(t.calls).toHaveLength(1);
  });
});

describe('createLlmClient', () => {
  it('anthropic -> AnthropicClient', () => {
    expect(createLlmClient({ provider: 'anthropic', apiKey: 'k', model: 'm', maxTokens: 10 })).toBeInstanceOf(AnthropicClient);
  });
  it('provider inconnu -> throw', () => {
    expect(() => createLlmClient({ provider: 'zzz', apiKey: 'k', model: 'm', maxTokens: 10 })).toThrow(/provider inconnu/);
  });
});
