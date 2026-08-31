import { describe, it, expect } from 'vitest';
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
