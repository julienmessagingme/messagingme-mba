import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { creerClientApplication } from '../src/application/client';
import { enregistrerRoutesApplication } from '../src/application/routes-internes';
import { ErreurApplication, type GestionnaireSessions } from '../src/application/sessions';

/**
 * LES ROUTES INTERNES DU SERVICE DE CONNEXIONS ET LEUR CLIENT (plan 2026-10-22, tâche 3). L'API et le worker appellent
 * le service par HTTP sur le réseau privé ; chaque appel est signé comme nos services (`x-mm-service-signature`).
 */
const SECRET = 's'.repeat(40);
const COMPTE = 'aaaaaaaa-0000-4000-8000-000000000001';

const appels: string[] = [];
const sessions: GestionnaireSessions = {
  async reprendre() {},
  async relier(id) { appels.push(`relier:${id}`); },
  async qr() { return { qr: 'QR-1', ouverte: false, statut: 'en_attente' }; },
  async envoyer(id, dest, texte) {
    if (texte === 'refuse') throw new ErreurApplication('non_relie', 'non relié');
    if (texte === 'refus-463') throw new ErreurApplication('refuse_whatsapp', 'WhatsApp a refusé le message (463)');
    if (texte === 'panne') throw new Error('Connection Closed');
    appels.push(`envoyer:${id}:${dest}:${texte}`);
    return 'WA-42';
  },
  async verifier(id, numero) {
    if (numero === '33600000000') throw new ErreurApplication('non_relie', 'non relié');
    appels.push(`verifier:${id}:${numero}`);
    return numero === '33699999999' ? { present: false, adresse: null } : { present: true, adresse: 'lid' };
  },
  async sommeil(id) { appels.push(`sommeil:${id}`); },
  async retirer(id) { appels.push(`retirer:${id}`); },
  arreter() {},
};

let app: FastifyInstance;
/** Le `fetch` du client, branché sur `inject` : la requête signée traverse la vraie route. */
const fetchInjecte = (async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url));
  const r = await app.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST',
    url: u.pathname,
    headers: init?.headers as Record<string, string>,
    payload: typeof init?.body === 'string' ? init.body : undefined,
  });
  return new Response(r.body, { status: r.statusCode, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

beforeAll(async () => {
  app = Fastify();
  enregistrerRoutesApplication(app, { sessions, secret: SECRET });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('le client et les routes du service de connexions', () => {
  const client = () => creerClientApplication({ url: 'http://mba-application:8090', secret: SECRET, fetch: fetchInjecte });

  it('envoie, et rend l’identifiant du message', async () => {
    const r = await client().envoyer(COMPTE, '33612345678@s.whatsapp.net', 'Bonjour');
    expect(r).toEqual({ ok: true, messageId: 'WA-42' });
    expect(appels).toContain(`envoyer:${COMPTE}:33612345678@s.whatsapp.net:Bonjour`);
  });

  it('un compte non relié rend un refus lisible, pas une exception', async () => {
    expect(await client().envoyer(COMPTE, 'x@s.whatsapp.net', 'refuse')).toEqual({ ok: false, raison: 'non_relie' });
  });

  it('🔴 un refus de WhatsApp traverse la route avec sa raison ; une panne de la session reste une panne', async () => {
    expect(await client().envoyer(COMPTE, 'x@s.whatsapp.net', 'refus-463')).toEqual({ ok: false, raison: 'refuse_whatsapp' });
    expect(await client().envoyer(COMPTE, 'x@s.whatsapp.net', 'panne')).toEqual({ ok: false, raison: 'service_injoignable' });
  });

  it('🔴 vérifie un numéro avant un premier message : présent, absent, mal formé, compte non relié', async () => {
    expect(await client().verifier(COMPTE, '33612345678')).toEqual({ ok: true, present: true, adresse: 'lid' });
    expect(appels).toContain(`verifier:${COMPTE}:33612345678`);
    expect(await client().verifier(COMPTE, '33699999999')).toEqual({ ok: true, present: false, adresse: null });
    // Un numéro mal formé est refusé par la route (400) avant d'atteindre la session.
    expect(await client().verifier(COMPTE, '+33 6 12')).toEqual({ ok: false, raison: 'refuse' });
    expect(appels.some((a) => a.includes('+33'))).toBe(false);
    expect(await client().verifier(COMPTE, '33600000000')).toEqual({ ok: false, raison: 'non_relie' });
  });

  it('relier, sommeil, retirer, et le QR code', async () => {
    expect(await client().relier(COMPTE)).toEqual({ ok: true });
    expect(await client().sommeil(COMPTE)).toEqual({ ok: true });
    expect(await client().retirer(COMPTE)).toEqual({ ok: true });
    expect(await client().qr(COMPTE)).toEqual({ ok: true, qr: 'QR-1', ouverte: false, statut: 'en_attente' });
  });

  it('🔴 une requête sans signature, ou signée d’un autre secret, rend 401', async () => {
    const sans = await app.inject({ method: 'POST', url: `/interne/application/comptes/${COMPTE}/relier`, payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(sans.statusCode).toBe(401);
    const autre = creerClientApplication({ url: 'http://mba-application:8090', secret: 'x'.repeat(40), fetch: fetchInjecte });
    expect(await autre.relier(COMPTE)).toEqual({ ok: false, raison: 'refuse' });
  });

  it('un identifiant de compte mal formé ou un corps invalide rend 400', async () => {
    expect(await client().relier('pas-un-uuid')).toEqual({ ok: false, raison: 'refuse' });
    expect(await client().envoyer(COMPTE, '', 'Bonjour')).toEqual({ ok: false, raison: 'refuse' });
  });

  it('un service injoignable se dit comme tel', async () => {
    const enPanne = creerClientApplication({ url: 'http://mba-application:8090', secret: SECRET, fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
    expect(await enPanne.envoyer(COMPTE, 'x@s.whatsapp.net', 'Bonjour')).toEqual({ ok: false, raison: 'service_injoignable' });
  });
});
