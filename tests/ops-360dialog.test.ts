import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { accesOps } from './acces-ops';
import { FakeQueue } from './fake-queue';
import { capturerJournal } from './journal';
import type { Ops360dialogDeps } from '../src/http/ops-360dialog';
import { SecondNumeroRefuseError } from '../src/account/es-store.pg';
import { Cle360dialogRefusee, Erreur360dialog, type Destination360 } from '../src/meta/config-360dialog';

/**
 * RATTACHER UN NUMÉRO 360DIALOG PAR L'EXPLOITATION (lot 2, livraison A), par le vrai câblage (`buildServer`) : derrière la
 * garde d'exploitation, le numéro lu chez 360dialog, la clé chiffrée avec le fournisseur `360dialog`, le webhook posé
 * APRÈS le rattachement, et la clé jamais renvoyée ni journalisée.
 */
const T1 = '4169c753-311a-43bb-a334-d8a2cb7caf6f';
const CLE = 'cle-secrete-360dialog-XYZ';
const NUMERO = { phoneNumberId: '1111', wabaId: '2222' };

function banc(over: Partial<{ lire: () => Promise<typeof NUMERO>; poser: () => Promise<'allume' | 'ajoute' | 'mis_a_jour'>; lier: () => Promise<void>; secret: boolean }> = {}) {
  const gestes: string[] = [];
  const liens: unknown[] = [];
  const credentials: unknown[][] = [];
  const poses: Destination360[] = [];
  const audits: string[] = [];
  const deps: Ops360dialogDeps = {
    config: (cle) => ({
      lireNumero: async () => { gestes.push(`lire:${cle}`); return (over.lire ?? (async () => NUMERO))(); },
      poserWebhook: async (d) => { gestes.push('poser'); poses.push(d); return (over.poser ?? (async () => 'ajoute' as const))(); },
    }),
    espaceExiste: async (t) => t === T1,
    lierNumero: async (input) => { gestes.push('lier'); liens.push(input); await (over.lier ?? (async () => {}))(); },
    saveCredentials: async (...args) => { gestes.push('credentials'); credentials.push(args); },
    chiffrer: (cle) => `enc(${cle})`,
    destination: (pn) => (over.secret === false ? null : { name: 'messagingme', url: `https://api.example/webhooks/360dialog/${pn}`, headers: { Authorization: 'Basic b' } }),
    audit: async (_t, _a, action) => { audits.push(action); },
  };
  const server = buildServer({ queue: new FakeQueue(), auth: acces.auth, ops360dialog: deps });
  return { server, gestes, liens, credentials, poses, audits };
}

const acces = accesOps();
const ops: Record<string, string> = { 'content-type': 'application/json' };
beforeAll(async () => {
  const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
  ops.authorization = `Bearer ${await acces.jeton(s)}`;
  await s.close();
});

const CORPS = { cle: CLE, numeroAffiche: '+33 4 23 50 07 16', note: 'premier numéro 360dialog' };
const poster = (server: ReturnType<typeof buildServer>, corps: unknown = CORPS, entetes = ops, tenant = T1) =>
  server.inject({ method: 'POST', url: `/ops/360dialog/${tenant}`, headers: entetes, payload: corps as object });

describe('POST /ops/360dialog/:tenantId', () => {
  it('🔴 sans la session d’exploitation : 401, rien n’est lu chez 360dialog', async () => {
    const b = banc();
    expect((await poster(b.server, CORPS, { 'content-type': 'application/json' })).statusCode).toBe(401);
    expect(b.gestes).toEqual([]);
    await b.server.close();
  });

  it('le chemin heureux : lu, lié, clé chiffrée en 360dialog, PUIS le webhook ; tracé ; la clé nulle part', async () => {
    const b = banc();
    const { resultat: res, lignes } = await capturerJournal(() => poster(b.server));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: T1, ...NUMERO, webhook: 'ajoute' });
    expect(b.gestes).toEqual([`lire:${CLE}`, 'lier', 'credentials', 'poser']);
    expect(b.liens).toEqual([{ tenantId: T1, ...NUMERO, displayPhoneNumber: '+33 4 23 50 07 16', verifiedName: null }]);
    expect(b.credentials).toEqual([['2222', T1, `enc(${CLE})`, null, '360dialog']]);
    expect(b.poses[0]?.url).toBe('https://api.example/webhooks/360dialog/1111');
    expect(b.audits).toEqual(['ops.numero_rattache']);
    expect(res.body).not.toContain(CLE);
    expect(JSON.stringify(lignes)).not.toContain(CLE);
    await b.server.close();
  });

  it('une clé refusée par 360dialog : 400, rien n’est rattaché', async () => {
    const b = banc({ lire: async () => { throw new Cle360dialogRefusee(); } });
    expect((await poster(b.server)).statusCode).toBe(400);
    expect(b.gestes).toEqual([`lire:${CLE}`]);
    await b.server.close();
  });

  it('un second numéro dans l’espace : 409, ni clé ni webhook', async () => {
    const b = banc({ lier: async () => { throw new SecondNumeroRefuseError('autre', '1111'); } });
    expect((await poster(b.server)).statusCode).toBe(409);
    expect(b.gestes).toEqual([`lire:${CLE}`, 'lier']);
    await b.server.close();
  });

  it('le webhook échoue après le rattachement : 502 qui le dit, et rejouer le termine', async () => {
    const b = banc({ poser: async () => { throw new Erreur360dialog('ajouter le webhook', 500); } });
    const res = await poster(b.server);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ rattache: true, ...NUMERO });
    expect(b.audits).toEqual([]);
    await b.server.close();
  });

  it('sans D360_WEBHOOK_SECRET : 503 avant tout rattachement', async () => {
    const b = banc({ secret: false });
    expect((await poster(b.server)).statusCode).toBe(503);
    expect(b.gestes).toEqual([`lire:${CLE}`]);
    await b.server.close();
  });

  it('espace inconnu, note absente, clé absente : refusés sans rien lire', async () => {
    const b = banc();
    expect((await poster(b.server, CORPS, ops, '11111111-2222-4333-8444-555555555555')).statusCode).toBe(404);
    expect((await poster(b.server, { cle: CLE, note: '' })).statusCode).toBe(400);
    expect((await poster(b.server, { note: 'pourquoi pas' })).statusCode).toBe(400);
    expect(b.gestes).toEqual([]);
    await b.server.close();
  });
});
