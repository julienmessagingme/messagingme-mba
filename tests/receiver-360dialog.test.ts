import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { enteteDuNumero } from '../src/webhooks/receiver-360dialog';
import { FakeQueue } from './fake-queue';

const SECRET = 'cle-360dialog-de-test';
const NUMERO = '1111567578708598';
const AUTRE = '2222222222222222';

function makeApp(monte = true) {
  const queue = new FakeQueue();
  const app = buildServer({
    queue, verifyToken: 'tok', appSecret: 'meta',
    ...(monte ? { receiver360: { queue, secret: SECRET } } : {}),
  });
  return { queue, app };
}

const message = (numero: string) => ({
  field: 'messages',
  value: {
    messaging_product: 'whatsapp',
    metadata: { phone_number_id: numero, display_phone_number: '33423500716' },
    contacts: [{ wa_id: '33600000000' }],
    messages: [{ id: 'wamid.1', from: '33600000000', type: 'text', text: { body: 'Bonjour' } }],
  },
});
const accuse = (numero: string) => ({
  field: 'messages',
  value: { metadata: { phone_number_id: numero }, statuses: [{ id: 'wamid.2', status: 'delivered', recipient_id: '33600000000' }] },
});
const statutDeModele = { field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 1 } };
const corps = (...changes: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes }] });

async function poster(app: ReturnType<typeof buildServer>, body: unknown, auth?: string, numero = NUMERO) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/360dialog/${numero}`,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    payload: JSON.stringify(body),
  });
}

describe('POST /webhooks/360dialog/:phoneNumberId', () => {
  it('Basic du numéro : 200, versé dans la file des entrants, groupé par contact', async () => {
    const { queue, app } = makeApp();
    const res = await poster(app, corps(message(NUMERO)), enteteDuNumero(SECRET, NUMERO));
    expect(res.statusCode).toBe(200);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.name).toBe('webhook');
    expect(queue.enqueued[0]?.data).toEqual(corps(message(NUMERO)));
    expect(queue.enqueued[0]?.opts?.groupId).toBeDefined();
    await app.close();
  });

  it('accusés seuls : versés dans la file des accusés', async () => {
    const { queue, app } = makeApp();
    const res = await poster(app, corps(accuse(NUMERO)), enteteDuNumero(SECRET, NUMERO));
    expect(res.statusCode).toBe(200);
    expect(queue.enqueued[0]?.name).toBe('webhook-status');
    await app.close();
  });

  it('Basic absent, faux, ou celui d’un autre numéro : 401, rien de versé', async () => {
    const { queue, app } = makeApp();
    for (const auth of [undefined, 'Basic AAAA', enteteDuNumero(SECRET, AUTRE), enteteDuNumero('autre-cle', NUMERO)]) {
      const res = await poster(app, corps(message(NUMERO)), auth);
      expect(res.statusCode).toBe(401);
    }
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });

  it('🔴 un changement d’un autre numéro : 403, et RIEN n’est versé, même le changement légitime', async () => {
    const { queue, app } = makeApp();
    const res = await poster(app, corps(message(NUMERO), message(AUTRE)), enteteDuNumero(SECRET, NUMERO));
    expect(res.statusCode).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });

  it('🔴 un autre numéro caché sous `standby` : 403 (lu comme le lit le worker)', async () => {
    const { queue, app } = makeApp();
    const cache = { field: 'standby', value: { metadata: { phone_number_id: NUMERO }, standby: { metadata: { phone_number_id: AUTRE }, messages: [{ id: 'wamid.3' }] } } };
    const res = await poster(app, corps(cache), enteteDuNumero(SECRET, NUMERO));
    expect(res.statusCode).toBe(403);
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });

  it('un changement sans numéro (niveau WABA) n’est pas versé ; le reste du corps l’est', async () => {
    const { queue, app } = makeApp();
    const seul = await poster(app, corps(statutDeModele), enteteDuNumero(SECRET, NUMERO));
    expect(seul.statusCode).toBe(200);
    expect(queue.enqueued).toHaveLength(0);

    const mixte = await poster(app, corps(statutDeModele, message(NUMERO)), enteteDuNumero(SECRET, NUMERO));
    expect(mixte.statusCode).toBe(200);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.data).toEqual(corps(message(NUMERO)));
    await app.close();
  });

  it('corps illisible avec le bon Basic : 400', async () => {
    const { queue, app } = makeApp();
    const res = await poster(app, { entry: 'pas un tableau' }, enteteDuNumero(SECRET, NUMERO));
    expect(res.statusCode).toBe(400);
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });

  it('sans D360_WEBHOOK_SECRET, la route n’existe pas', async () => {
    const { app } = makeApp(false);
    const res = await poster(app, corps(message(NUMERO)), enteteDuNumero(SECRET, NUMERO));
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
