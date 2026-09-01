import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';

const SECRET = 'test-secret';
const TOKEN = 'verify-tok';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
}
function makeApp() {
  const queue = new FakeQueue();
  const app = buildServer({ queue, verifyToken: TOKEN, appSecret: SECRET });
  return { queue, app };
}
const jsonHeaders = (sig?: string) => ({
  'content-type': 'application/json',
  ...(sig ? { 'x-hub-signature-256': sig } : {}),
});

describe('receiver POST /webhooks/meta', () => {
  it('signature valide -> 200 + enqueue le payload brut', async () => {
    const { queue, app } = makeApp();
    const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.1' }] } }] }] });
    const res = await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(body)), payload: body });
    expect(res.statusCode).toBe(200);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.name).toBe('webhook');
    await app.close();
  });

  it('signature invalide -> 403 + pas d enqueue', async () => {
    const { queue, app } = makeApp();
    const body = JSON.stringify({ hello: 'x' });
    const res = await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders('sha256=' + '0'.repeat(64)), payload: body });
    expect(res.statusCode).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });

  it('signature absente -> 403', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(), payload: '{}' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('transmet le payload verbatim à la file (aucune transformation métier dans la route)', async () => {
    const { queue, app } = makeApp();
    const payload = { entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.Z' }] } }] }] };
    const body = JSON.stringify(payload);
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(body)), payload: body });
    expect(queue.enqueued).toHaveLength(1);
    // le payload est enfilé tel quel : la route ne parse/normalise rien.
    expect(queue.enqueued[0]?.data).toEqual(payload);
    await app.close();
  });

  it('JSON invalide mais signé -> 200 (pas de 500), body {} enfilé', async () => {
    const { queue, app } = makeApp();
    const bad = 'not json{';
    const res = await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(bad)), payload: bad });
    expect(res.statusCode).toBe(200);
    expect(queue.enqueued[0]?.data).toEqual({});
    await app.close();
  });

  it('JSON invalide non signé -> 403', async () => {
    const { queue, app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders('sha256=' + '0'.repeat(64)), payload: 'not json{' });
    expect(res.statusCode).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });
});

describe('receiver GET /webhooks/meta (handshake)', () => {
  it('token match -> challenge', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=42`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('42');
    await app.close();
  });

  it('token faux -> 403', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

/**
 * AIGUILLAGE DES ACCUSÉS (lot 6 du programme, 2026-08-31).
 *
 * 🔴 C'est ICI que le lot se joue. Le classement pur est testé à part ; ce qui compte en production, c'est
 * que le receveur ENVOIE réellement sur deux files distinctes. Sinon une rafale d'accusés de campagne
 * (trois par destinataire, quinze mille pour 5 000 messages) continue de passer devant la réponse d'un
 * vrai client, et rien ne le signale.
 */
describe('receiver : les accusés de livraison ne passent plus devant les messages', () => {
  const envoyer = async (payload: unknown) => {
    const { queue, app } = makeApp();
    const body = JSON.stringify(payload);
    const res = await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(body)), payload: body });
    await app.close();
    return { res, queue };
  };

  it('🔴 un payload d’accusés SEULS part sur `webhook-status`', async () => {
    const { res, queue } = await envoyer({
      entry: [{ changes: [{ field: 'statuses', value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }],
    });
    expect(res.statusCode).toBe(200);
    expect(queue.enqueued.map((j) => j.name)).toEqual(['webhook-status']);
  });

  it('🔴 un message entrant reste sur `webhook`, la file conversationnelle', async () => {
    const { queue } = await envoyer({
      entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.2', text: { body: 'bonjour' } }] } }] }],
    });
    expect(queue.enqueued.map((j) => j.name)).toEqual(['webhook']);
  });

  it('un payload MIXTE reste sur `webhook` : on ne perd jamais un événement', async () => {
    const { queue } = await envoyer({
      entry: [{ changes: [
        { field: 'statuses', value: { statuses: [{ id: 'wamid.3', status: 'sent' }] } },
        { field: 'messages', value: { messages: [{ id: 'wamid.4' }] } },
      ] }],
    });
    expect(queue.enqueued.map((j) => j.name)).toEqual(['webhook']);
  });

  it('le corps enfilé est le payload BRUT, quelle que soit la file', async () => {
    const payload = { entry: [{ changes: [{ field: 'statuses', value: { statuses: [{ id: 'wamid.5', status: 'read' }] } }] }] };
    const { queue } = await envoyer(payload);
    expect(queue.enqueued[0]?.data).toEqual(payload);
  });
});

/**
 * Le rejet qui PARLE (lot 2 du programme II).
 *
 * Avant, un POST refusé renvoyait 403 sans écrire une ligne. Une panne 100 % entrants (secret Meta qui ne
 * correspond plus) y restait indiagnosticable, exactement le scénario qui a coûté 1 h 30 le 2026-08-17.
 */
describe('receiver : journal des rejets', () => {
  afterEach(() => vi.restoreAllMocks());

  it('🔴 distingue la signature INVALIDE de la signature ABSENTE', async () => {
    // La nuance est tout le sujet : « absente » c'est un scanner, « invalide » c'est Meta qui nous parle et
    // dont on jette TOUT. Les deux ne demandent pas la même réaction.
    const lignes: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lignes.push(String(a[0])); });
    const { app } = makeApp();
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders('sha256=' + '0'.repeat(64)), payload: '{"a":1}' });
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(), payload: '{"a":1}' });
    expect(lignes.some((l) => l.includes('signature_invalide'))).toBe(true);
    expect(lignes.some((l) => l.includes('signature_absente'))).toBe(true);
    await app.close();
    spy.mockRestore();
  });

  it('🔴 n’écrit NI le corps NI la signature reçue', async () => {
    const lignes: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lignes.push(a.map(String).join(' ')); });
    const { app } = makeApp();
    const secretDuClient = 'le-message-prive-du-client';
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders('sha256=' + 'a'.repeat(64)), payload: JSON.stringify({ texte: secretDuClient }) });
    expect(lignes.join(' ')).not.toContain(secretDuClient);
    expect(lignes.join(' ')).not.toContain('a'.repeat(64));
    await app.close();
    spy.mockRestore();
  });

  it('🔴 une rafale ne noie pas le journal, et le COMPTE est dit', async () => {
    // Horloge pilotée par un espion sur `Date.now`, PAS par `vi.useFakeTimers()` : les fausses minuteries
    // gèlent aussi celles de Fastify, et `app.inject` ne rend jamais la main (test en timeout à 5 s).
    let horloge = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => horloge);
    const lignes: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lignes.push(String(a[0])); });
    const { app } = makeApp();
    const mauvais = { method: 'POST' as const, url: '/webhooks/meta', headers: jsonHeaders('sha256=' + '0'.repeat(64)), payload: '{"a":1}' };
    for (let i = 0; i < 50; i += 1) await app.inject(mauvais);
    expect(lignes).toHaveLength(1); // 50 rejets, UNE ligne
    expect(lignes[0]).toContain('1 rejet');

    // Une minute plus tard, la ligne suivante dit COMBIEN sont passés entre-temps : sans ce compte, le
    // throttle cacherait l'ampleur qu'il est censé rendre lisible.
    horloge += 61_000;
    await app.inject(mauvais);
    expect(lignes).toHaveLength(2);
    expect(lignes[1]).toContain('50 rejets');
    await app.close();
    spy.mockRestore();
    now.mockRestore();
  });
});

/**
 * ORDRE PAR CONTACT (lot 3 du programme II). La file des entrants traite désormais plusieurs jobs à la fois :
 * sans clé de groupe, deux messages du même contact pourraient s'appliquer dans le désordre. La clé est posée
 * à l'ENFILEMENT, par le receveur, sans toucher à la base (il doit accuser réception à Meta immédiatement).
 */
describe('receiver : clé de groupe par contact', () => {
  it('un message pose la clé « numéro:contact »', async () => {
    const { queue, app } = makeApp();
    const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' },
      messages: [{ id: 'wamid.1', from: '33611', type: 'text', text: { body: 'salut' } }],
    } }] }] });
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(body)), payload: body });
    expect(queue.enqueued[0]?.opts?.groupId).toBe('pn1:33611');
    await app.close();
  });

  it('un wa_id masqué (BSUID) : le bloc `contacts` sert de secours', async () => {
    const { queue, app } = makeApp();
    const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' },
      contacts: [{ wa_id: '33622' }],
      messages: [{ id: 'wamid.2', type: 'text', text: { body: 'sans from' } }],
    } }] }] });
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(body)), payload: body });
    expect(queue.enqueued[0]?.opts?.groupId).toBe('pn1:33622');
    await app.close();
  });

  it('🔴 DEUX contacts dans un payload -> AUCUNE clé, plutôt qu’un ordre inventé', async () => {
    const { queue, app } = makeApp();
    const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' },
      messages: [
        { id: 'wamid.3', from: '33611', type: 'text', text: { body: 'a' } },
        { id: 'wamid.4', from: '33622', type: 'text', text: { body: 'b' } },
      ],
    } }] }] });
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(body)), payload: body });
    expect(queue.enqueued[0]?.opts?.groupId).toBeUndefined();
    await app.close();
  });

  it('🔴 une bascule de contrôle -> aucune clé (sa forme n’est pas documentée)', async () => {
    const { queue, app } = makeApp();
    const body = JSON.stringify({ entry: [{ changes: [{ field: 'messaging_handovers', value: {
      metadata: { phone_number_id: 'pn1' }, control_passed: { metadata: 'x' },
    } }] }] });
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(body)), payload: body });
    expect(queue.enqueued[0]?.opts?.groupId).toBeUndefined();
    await app.close();
  });

  it('un accusé de livraison est groupé par son destinataire', async () => {
    const { queue, app } = makeApp();
    const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' },
      statuses: [{ id: 'wamid.5', status: 'delivered', recipient_id: '33633' }],
    } }] }] });
    await app.inject({ method: 'POST', url: '/webhooks/meta', headers: jsonHeaders(sign(body)), payload: body });
    expect(queue.enqueued[0]?.name).toBe('webhook-status');
    expect(queue.enqueued[0]?.opts?.groupId).toBe('pn1:33633');
    await app.close();
  });
});
