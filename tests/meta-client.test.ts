import { describe, it, expect } from 'vitest';
import { MetaClient } from '../src/meta/client';
import { RateLimiter } from '../src/meta/http';
import type { HttpTransport, HttpResponse } from '../src/meta/http';

class FakeTransport implements HttpTransport {
  readonly requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  private readonly responses: HttpResponse[];
  constructor(responses: HttpResponse[] = []) {
    this.responses = responses;
  }
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.requests.push({ url, body, headers });
    return this.responses.shift() ?? { status: 200, json: { messages: [{ id: 'wamid.default' }] } };
  }
}

function client(transport: HttpTransport) {
  return new MetaClient({ transport, token: 'TOK', phoneNumberId: '123', version: 'v25.0' });
}
const okBody = (id: string): HttpResponse => ({ status: 200, json: { messages: [{ id }] } });

describe('MetaClient.sendText', () => {
  it('POST /{id}/messages avec le bon body + header Bearer, parse le message id', async () => {
    const t = new FakeTransport([okBody('wamid.1')]);
    const res = await client(t).sendText('33600000000', 'Bonjour');
    expect(res.messageId).toBe('wamid.1');
    const req = t.requests[0]!;
    expect(req.url).toBe('https://graph.facebook.com/v25.0/123/messages');
    expect(req.headers['Authorization']).toBe('Bearer TOK');
    expect(req.body).toMatchObject({ messaging_product: 'whatsapp', to: '33600000000', type: 'text', text: { body: 'Bonjour' } });
  });
});

describe('MetaClient.sendTemplate', () => {
  it('body type=template avec name + language.code', async () => {
    const t = new FakeTransport([okBody('wamid.2')]);
    await client(t).sendTemplate('33600000000', { name: 'welcome', language: 'fr' });
    expect(t.requests[0]!.body).toMatchObject({
      type: 'template',
      template: { name: 'welcome', language: { code: 'fr' } },
    });
  });

  it('numéro E.164 -> champ `to`', async () => {
    const t = new FakeTransport([okBody('wamid.2a')]);
    await client(t).sendTemplate('+33600000000', { name: 'welcome', language: 'fr' });
    const body = t.requests[0]!.body as Record<string, unknown>;
    expect(body['to']).toBe('+33600000000');
    expect(body).not.toHaveProperty('recipient');
  });

  it('BSUID (non numéro) -> champ `recipient`, jamais `to`', async () => {
    const t = new FakeTransport([okBody('wamid.2b')]);
    await client(t).sendTemplate('BSUID_abc123', { name: 'welcome', language: 'fr' });
    const body = t.requests[0]!.body as Record<string, unknown>;
    expect(body['recipient']).toBe('BSUID_abc123');
    expect(body).not.toHaveProperty('to');
  });
});

const liteClient = (transport: HttpTransport) =>
  new MetaClient({ transport, token: 'TOK', phoneNumberId: '123', version: 'v25.0', marketingViaLite: true });

describe('MetaClient.sendMarketing', () => {
  it('par défaut -> endpoint standard /messages (MM Lite désactivé)', async () => {
    const t = new FakeTransport([okBody('wamid.3a')]);
    await client(t).sendMarketing({ to: '33600000000', template: { name: 'promo', language: 'fr' } });
    expect(t.requests[0]!.url).toBe('https://graph.facebook.com/v25.0/123/messages');
    expect(t.requests[0]!.body).toMatchObject({ to: '33600000000', type: 'template' });
  });

  it('marketingViaLite=true -> /marketing_messages avec recipient (BSUID)', async () => {
    const t = new FakeTransport([okBody('wamid.3')]);
    await liteClient(t).sendMarketing({ recipient: 'US.123', template: { name: 'promo', language: 'fr' } });
    const req = t.requests[0]!;
    expect(req.url).toBe('https://graph.facebook.com/v25.0/123/marketing_messages');
    expect(req.body).toMatchObject({ recipient: 'US.123', type: 'template' });
    expect(req.body).not.toHaveProperty('to');
  });

  it('vers un to (E.164) -> body avec to', async () => {
    const t = new FakeTransport([okBody('wamid.4')]);
    await liteClient(t).sendMarketing({ to: '33600000000', template: { name: 'promo', language: 'fr' } });
    expect(t.requests[0]!.body).toMatchObject({ to: '33600000000' });
  });

  it('si to ET recipient fournis, `to` prime', async () => {
    const t = new FakeTransport([okBody('wamid.5')]);
    await client(t).sendMarketing({ to: '33600000000', recipient: 'US.123', template: { name: 'promo', language: 'fr' } });
    const body = t.requests[0]!.body as Record<string, unknown>;
    expect(body['to']).toBe('33600000000');
    expect(body).not.toHaveProperty('recipient');
  });

  it('ni to ni recipient -> throw', async () => {
    const t = new FakeTransport();
    await expect(client(t).sendMarketing({ template: { name: 'promo', language: 'fr' } })).rejects.toThrow();
    expect(t.requests).toHaveLength(0);
  });
});

describe('MetaClient erreurs', () => {
  it('réponse non-2xx -> MetaApiError avec le code Meta', async () => {
    const t = new FakeTransport([{ status: 400, json: { error: { code: 100, message: 'Invalid parameter' } } }]);
    await expect(client(t).sendText('33600000000', 'x')).rejects.toMatchObject({ name: 'MetaApiError', code: 100, retryable: false });
  });

  it('réponse 200 sans message id -> throw', async () => {
    const t = new FakeTransport([{ status: 200, json: { messages: [] } }]);
    await expect(client(t).sendText('33600000000', 'x')).rejects.toThrow(/message id/);
  });
});

describe('MetaClient throttling', () => {
  it('acquire() du rateLimiter est appelé à CHAQUE tentative (retries compris)', async () => {
    class CountingLimiter extends RateLimiter {
      count = 0;
      override async acquire(): Promise<void> {
        this.count += 1;
        return super.acquire();
      }
    }
    const limiter = new CountingLimiter(0);
    // 503 (retryable) deux fois puis succès -> 3 tentatives -> 3 acquire().
    const t = new FakeTransport([
      { status: 503, json: { error: { code: 1, message: 'busy' } } },
      { status: 503, json: { error: { code: 1, message: 'busy' } } },
      okBody('wamid.ok'),
    ]);
    const c = new MetaClient({
      transport: t, token: 'TOK', phoneNumberId: '123', version: 'v25.0',
      rateLimiter: limiter, retry: { baseDelayMs: 0, sleep: async () => {} },
    });
    const res = await c.sendText('33600000000', 'x');
    expect(res.messageId).toBe('wamid.ok');
    expect(limiter.count).toBe(3);
    expect(t.requests).toHaveLength(3);
  });
});
