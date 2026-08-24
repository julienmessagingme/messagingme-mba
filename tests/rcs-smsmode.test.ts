import { describe, it, expect } from 'vitest';
import { SmsmodeRcsProvider, SmsmodeApiError, toSmsmodeBody } from '../src/rcs/smsmode';
import type { HttpTransport } from '../src/meta/http';

class FakeTransport implements HttpTransport {
  readonly calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  constructor(private readonly reponse: { status: number; json: Record<string, unknown> }) {}
  async post(url: string, body: unknown, headers: Record<string, string>) {
    this.calls.push({ url, body, headers });
    return { status: this.reponse.status, json: this.reponse.json, headers: {} };
  }
}

const OK = { status: 201, json: { messageId: 'srv-123', status: { value: 'ENROUTE' } } };

function monter(reponse: { status: number; json: Record<string, unknown> } = OK, opts: Partial<{ callbackUrlStatus: string; callbackUrlMo: string }> = {}) {
  const transport = new FakeTransport(reponse);
  const provider = new SmsmodeRcsProvider({ transport, apiKey: 'cle-canal-rcs', ...opts });
  return { transport, provider };
}

describe('SmsmodeRcsProvider', () => {
  it('envoie le destinataire en CHIFFRES NUS, sans le +', async () => {
    const { transport, provider } = monter();
    await provider.send('agent-1', '+33633921577', { kind: 'text', text: 'Bonjour' }, 'r1');
    expect((transport.calls[0]!.body as { recipient: { to: string } }).recipient.to).toBe('33633921577');
  });

  it('authentifie par X-Api-Key et rend l identifiant du SERVEUR, pas le notre', async () => {
    const { transport, provider } = monter();
    const r = await provider.send('agent-1', '33633921577', { kind: 'text', text: 'Bonjour' }, 'r1');
    expect(transport.calls[0]!.headers['X-Api-Key']).toBe('cle-canal-rcs');
    // C'est l'identifiant smsmode qui sert ensuite au suivi de livraison, pas notre référence.
    expect(r).toEqual({ messageId: 'srv-123' });
  });

  it('passe NOTRE reference en refClient pour recoller le rapport de livraison', async () => {
    const { transport, provider } = monter();
    await provider.send('agent-1', '33633921577', { kind: 'text', text: 'Bonjour' }, 'destinataire-42');
    expect((transport.calls[0]!.body as { refClient: string }).refClient).toBe('destinataire-42');
  });

  it('joint les URL de callback quand elles sont configurees, et rien sinon', async () => {
    const avec = monter(OK, { callbackUrlStatus: 'https://mba.example/s', callbackUrlMo: 'https://mba.example/mo' });
    await avec.provider.send('a', '33600000000', { kind: 'text', text: 'x' }, 'r1');
    expect(avec.transport.calls[0]!.body).toMatchObject({ callbackUrlStatus: 'https://mba.example/s', callbackUrlMo: 'https://mba.example/mo' });

    const sans = monter();
    await sans.provider.send('a', '33600000000', { kind: 'text', text: 'x' }, 'r1');
    expect(sans.transport.calls[0]!.body).not.toHaveProperty('callbackUrlStatus');
  });

  it('leve une erreur PORTANT le code metier sur un refus (403 canal)', async () => {
    const { provider } = monter({
      status: 403,
      json: { errorCode: '403.005', message: 'Channel type mismatch', detail: 'The type of the channel is not supported by this API' },
    });
    await expect(provider.send('a', '33600000000', { kind: 'text', text: 'x' }, 'r1')).rejects.toMatchObject({
      status: 403,
      errorCode: '403.005',
    });
  });

  it('refuse une reponse 2xx SANS messageId au lieu de rendre un envoi fantome', async () => {
    const { provider } = monter({ status: 201, json: { status: { value: 'ENROUTE' } } });
    await expect(provider.send('a', '33600000000', { kind: 'text', text: 'x' }, 'r1')).rejects.toBeInstanceOf(SmsmodeApiError);
  });

  it('declare NE PAS savoir verifier la joignabilite, et ne rend jamais null par defaut', async () => {
    const { provider } = monter();
    // Rendre `null` signifierait « non joignable » et ecarterait le destinataire a tort : smsmode n'a
    // simplement aucun endpoint de capacite.
    expect(provider.canCheckReachability).toBe(false);
    expect(await provider.capabilities('a', '33600000000')).not.toBeNull();
  });
});

describe('toSmsmodeBody', () => {
  it('mappe un texte avec ses trois types de suggestion', () => {
    const b = toSmsmodeBody({
      kind: 'text',
      text: 'Bonjour',
      suggestions: [
        { kind: 'reply', text: 'Oui', postbackData: 'oui' },
        { kind: 'openUrl', text: 'Site', url: 'https://messagingme.app', postbackData: 'url' },
        { kind: 'dial', text: 'Appeler', phoneNumber: '+33100000000', postbackData: 'tel' },
      ],
    });
    expect(b).toEqual({
      type: 'TEXT',
      text: 'Bonjour',
      suggestions: [
        { type: 'REPLY', text: 'Oui', postbackData: 'oui' },
        { type: 'OPEN_URL', text: 'Site', url: 'https://messagingme.app', postbackData: 'url' },
        { type: 'DIAL_PHONE', text: 'Appeler', phoneNumber: '+33100000000', postbackData: 'tel' },
      ],
    });
  });

  it('n emet PAS de cle suggestions quand il n y en a aucune', () => {
    expect(toSmsmodeBody({ kind: 'text', text: 'Bonjour' })).toEqual({ type: 'TEXT', text: 'Bonjour' });
  });

  it('mappe une carte et un carrousel', () => {
    expect(toSmsmodeBody({ kind: 'card', card: { title: 'T', description: 'D', mediaUrl: 'https://x/i.png' } }))
      .toEqual({ type: 'CARD', card: { title: 'T', description: 'D', media: { url: 'https://x/i.png' } } });
    expect(toSmsmodeBody({ kind: 'carousel', cards: [{ title: 'A' }, { title: 'B' }] }))
      .toEqual({ type: 'CAROUSEL', cards: [{ title: 'A' }, { title: 'B' }] });
  });
});
