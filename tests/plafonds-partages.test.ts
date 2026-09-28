import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import { hashPasswordSync } from '../src/auth/password';
import { signSession } from '../src/auth/token';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import type { CompteurDebit } from '../src/db/debit';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import type { AuthUser, EmailIdentity, UserAuthStore } from '../src/auth/store';
import type { ImportRouteDeps } from '../src/http/import';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import { MfaEnMemoire, UtilisateursFaux, comptesDe } from './mfa';
import { exploitationInerte, opsInerte } from './routes-inertes';
import { accesOps } from './acces-ops';

/**
 * LES PLAFONDS DE DÉBIT EN PLUSIEURS COPIES DE L'API (lot B de `docs/superpowers/plans/2026-09-28-api-multi-instances.md`).
 *
 * 🔴 CE QUE CE FICHIER TIENT : N copies ne servent plus N fois chaque plafond. Deux « copies » ici, ce sont deux
 * serveurs construits par le VRAI `buildServer`, qui ne partagent que le compteur de débit (`debit`), comme deux
 * copies de l'API ne partagent que la base. Le compteur est le double en mémoire ; Postgres, lui, est éprouvé par
 * `tests/integration/compteurs-debit.integration.test.ts` (dont la course, que seul Postgres tranche).
 *
 * ⚠️ Sans le `debit` commun, chaque serveur a son propre compteur : c'est exactement l'ancien comportement, et le
 * premier cas de chaque bloc l'éprouve dans ce sens aussi.
 */

class FauxCles implements ApiKeyLookup {
  private readonly parHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  ajouter(brut: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.parHash.set(sha256Hex(brut), rec); return this; }
  async findActiveByHash(hash: string) { return this.parHash.get(hash) ?? null; }
  async touchLastUsed() { /* sans objet ici */ }
}

const CLE = cleApiDeTest('plafonds_partages');
const entetesCle = { 'content-type': 'application/json', authorization: `Bearer ${CLE}` };

/** Une copie de l'API publique, plafonnée à `parMinute` par espace, sur le compteur `debit` s'il est donné. */
function copieApi(o: { debit?: CompteurDebit; parMinute: number; ops?: ReturnType<typeof accesOps> }) {
  const cles = new FauxCles().ajouter(CLE, { id: 'k1', tenantId: 't1', scopes: ['contacts:write'] });
  return buildServer({
    queue: new FakeQueue(),
    ...(o.debit ? { debit: o.debit } : {}),
    plafonds: { apiParMinute: o.parMinute, apiParHeure: 100_000 },
    v1: { apiKeys: cles, contacts: contactsV1Muets() },
    ...(o.ops ? {
      auth: o.ops.auth,
      ops: { ...opsInerte, exploitation: { ...exploitationInerte, getTenantOverview: async () => [], getGlobalDaily: async () => [], getQueueLoad: async () => [] } },
    } : {}),
  });
}

const upsert = (app: ReturnType<typeof buildServer>) =>
  app.inject({ method: 'POST', url: '/v1/contacts', headers: entetesCle, payload: { phone: '+33612345678' } });

describe('le plafond de l’API publique par espace, sur deux copies', () => {
  it('⚠️ SANS compteur commun (l’ancien comportement) : chaque copie sert le plafond entier', async () => {
    const a = copieApi({ parMinute: 2 });
    const b = copieApi({ parMinute: 2 });
    const codes = [await upsert(a), await upsert(a), await upsert(b), await upsert(b)].map((r) => r.statusCode);
    expect(codes).toEqual([200, 200, 200, 200]);
    await a.close();
    await b.close();
  });

  it('🔴 AVEC le compteur commun : le plafond de l’espace tient au TOTAL, quelle que soit la copie', async () => {
    const debit = new CompteurDebitMemoire();
    const a = copieApi({ debit, parMinute: 3 });
    const b = copieApi({ debit, parMinute: 3 });
    const codes: number[] = [];
    for (const app of [a, b, a, b, a]) codes.push((await upsert(app)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    await a.close();
    await b.close();
  });

  it('🔴 les en-têtes `x-ratelimit-*` disent le compte PARTAGÉ, pas celui de la copie', async () => {
    const debit = new CompteurDebitMemoire();
    const a = copieApi({ debit, parMinute: 5 });
    const b = copieApi({ debit, parMinute: 5 });
    await upsert(a);
    await upsert(a);
    const surB = await upsert(b);
    expect([surB.headers['x-ratelimit-limit'], surB.headers['x-ratelimit-remaining']]).toEqual(['5', '2']);
    await a.close();
    await b.close();
  });

  it('🔴 un refus ne repasse PAS par la base : la copie se souvient de la fenêtre pleine jusqu’à sa fin', async () => {
    // Sans cette mémoire, une boucle d'intégrateur qui réessaie mille fois par seconde contre un plafond atteint
    // ferait mille écritures par seconde sur le pool de la copie, et la console tomberait avec elle.
    const base = new CompteurDebitMemoire();
    let appels = 0;
    const espion: CompteurDebit = { compter: (c) => { appels += 1; return base.compter(c); }, lister: (p, d) => base.lister(p, d) };
    const a = copieApi({ debit: espion, parMinute: 1 });
    expect((await upsert(a)).statusCode).toBe(200);
    expect((await upsert(a)).statusCode).toBe(429);
    const apresPremierRefus = appels;
    for (let i = 0; i < 20; i += 1) expect((await upsert(a)).statusCode).toBe(429);
    expect(appels, 'vingt refus, aucune écriture de plus').toBe(apresPremierRefus);
    await a.close();
  });

  it('🔴 base muette : l’appel PASSE, sans en-têtes (un client n’est pas coupé par une panne passagère)', async () => {
    const muette: CompteurDebit = { compter: async () => { throw new Error('connexion perdue'); }, lister: async () => [] };
    const a = copieApi({ debit: muette, parMinute: 1 });
    for (let i = 0; i < 3; i += 1) {
      const r = await upsert(a);
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-ratelimit-limit']).toBeUndefined();
    }
    await a.close();
  });

  it('🔴 `/ops/usage` montre le TOTAL des copies, pas la moitié que voit la copie interrogée', async () => {
    const debit = new CompteurDebitMemoire();
    const acces = accesOps();
    const a = copieApi({ debit, parMinute: 100, ops: acces });
    const b = copieApi({ debit, parMinute: 100, ops: acces });
    for (const app of [a, b, b]) expect((await upsert(app)).statusCode).toBe(200);
    const res = await a.inject({ method: 'GET', url: '/ops/usage', headers: await acces.entetes(a) });
    expect(res.statusCode).toBe(200);
    const lignes = res.json<{ compteurs: Array<{ operation: string; appels: number; unites: number }> }>().compteurs
      .filter((c) => c.operation === 'contacts.upsert');
    expect(lignes.reduce((s, c) => s + c.appels, 0)).toBe(3);
    await a.close();
    await b.close();
  });
});

describe('les plafonds de connexion, sur deux copies', () => {
  const admin: AuthUser = { id: 'u1', tenantId: 't1', email: 'a@b.co', role: 'admin', passwordHash: hashPasswordSync('pw') };
  function copieAuth(debit?: CompteurDebit, users?: UserAuthStore) {
    const mfa = new MfaEnMemoire(comptesDe([admin]));
    return buildServer({
      queue: new FakeQueue(),
      ...(debit ? { debit } : {}),
      auth: { users: users ?? new UtilisateursFaux([admin], mfa), secret: 'secret-plafonds-partages', mfa, loginRateLimit: { max: 3, windowMs: 60_000 } },
    });
  }
  const essai = (app: ReturnType<typeof buildServer>) =>
    app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.co', password: 'nope' } });

  it('🔴 dix essais par minute pour une identité, au TOTAL : l’autre copie ne rouvre pas les essais', async () => {
    const debit = new CompteurDebitMemoire();
    const a = copieAuth(debit);
    const b = copieAuth(debit);
    const codes: number[] = [];
    for (const app of [a, b, a, b]) codes.push((await essai(app)).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    await a.close();
    await b.close();
  });

  it('🔴 le compteur ne porte ni l’adresse tentée ni le jeton : seulement leur empreinte', async () => {
    // La clé vit en base, donc dans son journal et ses sauvegardes : en clair, elle y écrirait l'adresse de chaque
    // tentative (celles d'inconnus comprises) et le jeton de réinitialisation, qui ouvre un compte pendant une heure.
    const debit = new CompteurDebitMemoire();
    const mfa = new MfaEnMemoire(comptesDe([admin]));
    const a = buildServer({
      queue: new FakeQueue(),
      debit,
      auth: {
        users: new UtilisateursFaux([admin], mfa), secret: 'secret-plafonds-partages', mfa,
        // De quoi atteindre le plafond de la réinitialisation : sans jetons ni comptes, la route rend 503 avant lui.
        tokens: { create: async () => 'inutile', consume: async () => null },
        comptes: { setPassword: async () => true },
      },
    });
    await essai(a);
    const JETON = 'jeton-de-reinitialisation-en-clair-0123456789';
    const reset = await a.inject({ method: 'POST', url: '/auth/reset-password', headers: { 'content-type': 'application/json' }, payload: { token: JETON, password: 'un-mot-de-passe-assez-long' } });
    expect(reset.statusCode, 'la route a passé le plafond et lu le jeton').toBe(400);
    const lignes = await debit.lister('connexion.', 3_600_000);
    expect(lignes.map((l) => l.cle.split('|')[0]).sort()).toEqual(['connexion.login', 'connexion.reset']);
    for (const l of lignes) expect(l.cle).toMatch(/^connexion\.[a-z]+\|[0-9a-f]{64}$/);
    expect(JSON.stringify(lignes)).not.toMatch(/a@b\.co|jeton-de-reinitialisation/);
    await a.close();
  });

  it('🔴 FERMÉ sur panne : base muette, la tentative est refusée AVANT le mot de passe, et le dit', async () => {
    let lectures = 0;
    const users: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => { lectures += 1; return null; } };
    const muette: CompteurDebit = { compter: async () => { throw new Error('connexion perdue'); }, lister: async () => [] };
    const a = copieAuth(muette, users);
    const r = await essai(a);
    expect(r.statusCode).toBe(429);
    expect(r.json<{ error: string }>().error).toMatch(/momentanément impossible/);
    expect(lectures, 'aucune identité lue, aucun mot de passe essayé').toBe(0);
    await a.close();
  });
});

describe('le plafond des opérations coûteuses, sur deux copies', () => {
  const SECRET = 'secret-couteux-partage';
  // Les dépendances LÈVENT si on les touche : un 429 prouve que le refus est venu du plafond, avant le handler.
  const depsQuiLevent = new Proxy({}, {
    get: () => () => { throw new Error('le handler ne doit pas être atteint'); },
  }) as unknown as ImportRouteDeps;
  const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
  const copie = (debit: CompteurDebit) => buildServer({
    queue: new FakeQueue(),
    debit,
    auth: { users: noUsers, secret: SECRET },
    import: depsQuiLevent,
    plafonds: { utilisateurParMinute: 1000, couteuxParMinute: 1 },
  });

  it('🔴 l’espace a SA place par minute au total : la seconde copie la trouve prise', async () => {
    const debit = new CompteurDebitMemoire();
    const a = copie(debit);
    const b = copie(debit);
    const jeton = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
    const requete = (app: ReturnType<typeof buildServer>) => app.inject({
      method: 'POST', url: '/tenants/t1/contacts/import',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` },
      payload: { csv: 'phone\n+33611111111', mapping: { columns: {} } },
    });
    expect((await requete(a)).statusCode).not.toBe(429);
    const surB = await requete(b);
    expect(surB.statusCode).toBe(429);
    expect(surB.headers['x-ratelimit-remaining']).toBe('0');
    await a.close();
    await b.close();
  });

  it('🔴 base muette : l’opération PASSE (le handler est atteint), tel que `buildServer` câble ce plafond', async () => {
    // La politique vit dans le câblage (`src/server.ts`), pas dans le plafond : c'est ici qu'elle se tient.
    const muette: CompteurDebit = { compter: async () => { throw new Error('connexion perdue'); }, lister: async () => [] };
    const a = copie(muette);
    const jeton = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
    for (let i = 0; i < 3; i += 1) {
      const r = await a.inject({
        method: 'POST', url: '/tenants/t1/contacts/import',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` },
        payload: { csv: 'phone\n+33611111111', mapping: { columns: {} } },
      });
      // 500 : le handler a été atteint (ses dépendances lèvent), donc le plafond a laissé passer.
      expect(r.statusCode).toBe(500);
    }
    await a.close();
  });
});
