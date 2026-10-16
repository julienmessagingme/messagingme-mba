import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { capturerJournal } from './journal';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { Connexion360dialogDeps } from '../src/http/connexion-360dialog';
import { SecondNumeroRefuseError, TenantConflictError } from '../src/account/es-store.pg';
import { Cle360dialogRefusee, Erreur360dialog } from '../src/meta/config-360dialog';
import { CompteChez360dialog } from '../src/meta/credentials';

/**
 * LE BOUTON « ONBOARD WITH 360DIALOG » (lot 3), par le vrai câblage (`buildServer`) : réservé à l'admin de l'espace, la
 * clé collée lit le numéro chez 360dialog, le relie à CET espace, puis pose le webhook ; la clé n'est jamais renvoyée
 * ni journalisée. La logique est celle de `/ops/360dialog` (`tests/ops-360dialog.test.ts`).
 */
const SECRET = 'test-secret';
const CLE = 'cle-du-numero-360dialog-XYZ';
const NUMERO = { phoneNumberId: '1111', wabaId: '2222' };
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

function banc(over: Partial<{ lire: () => Promise<typeof NUMERO>; poser: () => Promise<'ajoute'>; lier: () => Promise<void> }> = {}) {
  const gestes: string[] = [];
  const liens: unknown[] = [];
  const credentials: unknown[][] = [];
  const audits: Array<{ tenant: string; action: string }> = [];
  const deps: Connexion360dialogDeps = {
    config: () => ({
      lireNumero: async () => { gestes.push('lire'); return (over.lire ?? (async () => NUMERO))(); },
      poserWebhook: async () => { gestes.push('poser'); return (over.poser ?? (async () => 'ajoute' as const))(); },
    }),
    lierNumero: async (input) => { gestes.push('lier'); liens.push(input); await (over.lier ?? (async () => {}))(); },
    saveCredentials: async (...args) => { gestes.push('credentials'); credentials.push(args); },
    chiffrer: (cle) => `enc(${cle})`,
    destination: (pn) => ({ name: 'messagingme', url: `https://api.example/webhooks/360dialog/${pn}`, headers: { Authorization: 'Basic b' } }),
    audit: async (tenant, _acteur, action) => { audits.push({ tenant, action }); },
  };
  const server = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, connexion360dialog: deps });
  return { server, gestes, liens, credentials, audits };
}

const poster = (b: ReturnType<typeof banc>, corps: unknown, tok = adminTok, tenant = 't1') =>
  b.server.inject({ method: 'POST', url: `/tenants/${tenant}/360dialog/connecter`, ...h(tok), payload: corps as object });

describe('une fonction qui ne parle qu’à Meta, sur un espace 360dialog', () => {
  it('🔴 CompteChez360dialog devient un 409 lisible, jamais un 500 opaque', async () => {
    const server = buildServer({
      queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
      media: { uploadImage: async () => { throw new CompteChez360dialog('W1'); } },
    });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/media', ...h(adminTok),
      payload: { dataUrl: `data:image/png;base64,${Buffer.from('png').toString('base64')}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/360dialog/);
    await server.close();
  });
});

describe('POST /tenants/:tenantId/360dialog/connecter', () => {
  it('l’admin colle la clé : lu, relié À CET ESPACE, clé chiffrée en 360dialog, puis webhook ; tracé, la clé nulle part', async () => {
    const b = banc();
    const { resultat: res, lignes } = await capturerJournal(() => poster(b, { cle: CLE, numeroAffiche: '+33 4 23 50 07 16' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: true, ...NUMERO, displayPhoneNumber: '+33 4 23 50 07 16' });
    expect(b.gestes).toEqual(['lire', 'lier', 'credentials', 'poser']);
    expect(b.liens).toEqual([{ tenantId: 't1', ...NUMERO, displayPhoneNumber: '+33 4 23 50 07 16', verifiedName: null }]);
    expect(b.credentials).toEqual([['2222', 't1', `enc(${CLE})`, null, '360dialog']]);
    expect(b.audits).toEqual([{ tenant: 't1', action: 'numero.connecte' }]);
    expect(res.body).not.toContain(CLE);
    expect(JSON.stringify(lignes)).not.toContain(CLE);
    await b.server.close();
  });

  it('🔴 un agent (pas admin), ou une session d’un autre espace : refusé, rien n’est lu chez 360dialog', async () => {
    const b = banc();
    expect((await poster(b, { cle: CLE }, agentTok)).statusCode).toBe(403);
    expect((await poster(b, { cle: CLE }, adminTok, 't2')).statusCode).toBe(403);
    expect(b.gestes).toEqual([]);
    await b.server.close();
  });

  it('clé absente, avec un retour à la ligne, ou champ inconnu : 400 sans rien lire', async () => {
    const b = banc();
    for (const corps of [{}, { cle: `${CLE}\nautre` }, { cle: CLE, tenantId: 't2' }]) {
      expect((await poster(b, corps)).statusCode).toBe(400);
    }
    expect(b.gestes).toEqual([]);
    await b.server.close();
  });

  it('clé refusée par 360dialog : 400 ; numéro d’un autre espace ou second numéro : 409, ni clé ni webhook', async () => {
    const refusee = banc({ lire: async () => { throw new Cle360dialogRefusee(); } });
    expect((await poster(refusee, { cle: CLE })).statusCode).toBe(400);
    await refusee.server.close();
    for (const erreur of [new TenantConflictError('waba', '2222'), new SecondNumeroRefuseError('autre', '1111')]) {
      const b = banc({ lier: async () => { throw erreur; } });
      expect((await poster(b, { cle: CLE })).statusCode).toBe(409);
      expect(b.gestes).toEqual(['lire', 'lier']);
      await b.server.close();
    }
  });

  it('le webhook échoue après le rattachement : 422 (jamais un 5xx, que Cloudflare masquerait) qui dit de refaire le geste', async () => {
    const b = banc({ poser: async () => { throw new Erreur360dialog('ajouter le webhook', 500); } });
    const res = await poster(b, { cle: CLE });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ rattache: true });
    expect(res.json<{ error: string }>().error).toMatch(/refaites le même geste/);
    expect(b.audits).toEqual([]);
    await b.server.close();
  });

  it('une panne réseau chez 360dialog (lecture ou webhook) : un refus lisible, jamais un 500', async () => {
    const lecture = banc({ lire: async () => { throw new TypeError('fetch failed'); } });
    const r1 = await poster(lecture, { cle: CLE });
    expect(r1.statusCode).toBe(422);
    expect(lecture.gestes).toEqual(['lire']);
    await lecture.server.close();
    const webhook = banc({ poser: async () => { throw new DOMException('délai', 'TimeoutError'); } });
    const r2 = await poster(webhook, { cle: CLE });
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toMatchObject({ rattache: true });
    await webhook.server.close();
  });

  it('les conflits se disent en clair', async () => {
    const autre = banc({ lier: async () => { throw new TenantConflictError('waba', '2222'); } });
    expect((await poster(autre, { cle: CLE })).json<{ error: string }>().error).toBe('ce numéro est déjà relié à un autre espace');
    await autre.server.close();
  });
});
