import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendTelegram } from '../src/ops/telegram';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendTelegram', () => {
  it('non configuré (env vide, pas d\'opts) -> no-op, ne touche pas fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    // En test, config.TELEGRAM_BOT_TOKEN/CHAT_ID valent '' -> chemin no-op.
    expect(await sendTelegram('coucou')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('configuré -> POST vers l\'URL bot correcte avec chat_id + text', async () => {
    const spy = vi.fn(async (..._args: unknown[]) => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', spy);
    expect(await sendTelegram('alerte', { token: 'TKN', chatId: 'CHAT', timeoutMs: 100 })).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe('https://api.telegram.org/botTKN/sendMessage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: 'CHAT', text: 'alerte' });
  });

  it('HTTP KO (500) -> false, ne throw jamais', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'err' })));
    await expect(sendTelegram('x', { token: 'T', chatId: 'C', timeoutMs: 100 })).resolves.toBe(false);
  });

  it('réseau KO (fetch rejette) -> false, ne throw jamais', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await expect(sendTelegram('x', { token: 'T', chatId: 'C', timeoutMs: 100 })).resolves.toBe(false);
  });
});
