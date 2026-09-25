import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sansPortailHubspot, avecPortailHubspot } from './hubspot';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { SettingsRouteDeps } from '../src/http/settings';
import type { AccountRouteDeps } from '../src/http/account';

/**
 * L'INTERRUPTEUR HUBSPOT DE L'ESPACE (migration 0179, design validé par Julien le 2026-09-25).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : la règle « on n'éteint pas HubSpot tant qu'un portail est relié ». Éteint
 * par-dessus un portail relié, l'interrupteur mentirait : les analyses partiraient encore vers HubSpot depuis
 * un espace où il paraît éteint. Et la porte de sortie qui rend cette règle praticable pour un espace SANS
 * numéro : sans elle, l'interrupteur l'enfermait.
 *
 * ⚠️ La colonne et sa reprise ne se vérifient en base que dans le job `integration` de la CI
 * (`tests/integration/hubspot-actif.integration.test.ts`). Ici, le fichier SQL est lu, pas exécuté.
 */
const SECRET = 'test-secret';
const tok = { admin: '', manager: '', agent: '', autreAdmin: '' };
beforeAll(async () => {
  tok.admin = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  tok.manager = await signSession({ userId: 'u2', tenantId: 't1', role: 'manager' }, SECRET);
  tok.agent = await signSession({ userId: 'u3', tenantId: 't1', role: 'agent' }, SECRET);
  tok.autreAdmin = await signSession({ userId: 'u4', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
const URL_ACTIF = '/tenants/t1/settings/hubspot-actif';

function reglages(o: { portail?: SettingsRouteDeps['hubspotPortalConnecte']; initial?: boolean; cable?: boolean } = {}) {
  const ecrits: Array<{ tenant: string; actif: boolean }> = [];
  let courant = o.initial ?? false;
  const settings: SettingsRouteDeps = {
    hubspotPortalConnecte: o.portail ?? sansPortailHubspot,
    getSettings: async () => ({
      mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
      controlHandbackSeconds: null, mbaHandoffMode: null, agentTransfertMode: null, agentsPeuventPrendre: false,
      hubspotActif: courant, optoutRequestId: null, mentionIaFrequence: null, timezone: 'Europe/Paris', businessHours: {},
    }),
    setMbaEnabled: async () => {},
    setHubspotListsEnabled: async () => {},
    setMbaHandoffMode: async () => {},
    setControlHandbackSeconds: async () => {},
    setTimezone: async () => {},
    setBusinessHours: async () => {},
    ...(o.cable === false ? {} : { setHubspotActif: async (tenant: string, actif: boolean) => { ecrits.push({ tenant, actif }); courant = actif; } }),
  };
  return { ecrits, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, settings }) };
}

describe('l’interrupteur HubSpot : lecture et écriture', () => {
  it('la lecture des réglages rend `hubspotActif`, éteint comme allumé', async () => {
    for (const initial of [false, true]) {
      const { srv } = reglages({ initial });
      const res = await srv.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(tok.admin) });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ hubspotActif: boolean }>().hubspotActif).toBe(initial);
      await srv.close();
    }
  });

  it('un admin l’allume, et la lecture suivante le dit', async () => {
    const { srv, ecrits } = reglages();
    const res = await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.admin), payload: { actif: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hubspotActif: true });
    expect(ecrits).toEqual([{ tenant: 't1', actif: true }]);
    expect((await srv.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(tok.admin) })).json<{ hubspotActif: boolean }>().hubspotActif).toBe(true);
    await srv.close();
  });

  it('un admin l’éteint quand aucun portail n’est relié', async () => {
    const { srv, ecrits } = reglages({ initial: true, portail: sansPortailHubspot });
    const res = await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.admin), payload: { actif: false } });
    expect(res.statusCode).toBe(200);
    expect(ecrits).toEqual([{ tenant: 't1', actif: false }]);
    await srv.close();
  });

  it('🔴 ÉTEINDRE AVEC UN PORTAIL RELIÉ : 409, un message qui dit quoi faire, et RIEN n’est écrit', async () => {
    const { srv, ecrits } = reglages({ initial: true, portail: avecPortailHubspot });
    const res = await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.admin), payload: { actif: false } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/Déconnexion complète/);
    expect(ecrits, 'un refus qui écrirait quand même serait pire que pas de refus').toEqual([]);
    await srv.close();
  });

  /**
   * 🔴 UNE LECTURE DU PORTAIL EN ÉCHEC REFUSE L'EXTINCTION (relecture du lot 7). Lue comme « pas relié », une panne
   * de la base laissait éteindre HubSpot par-dessus un portail relié, c'est-à-dire ce que la règle interdit.
   */
  it('🔴 ÉTEINDRE QUAND LA LECTURE DU PORTAIL ÉCHOUE : 503, un message qui dit de réessayer, et RIEN n’est écrit', async () => {
    const { srv, ecrits } = reglages({ initial: true, portail: async () => { throw new Error('connexion perdue'); } });
    const res = await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.admin), payload: { actif: false } });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toMatch(/n’a pas été éteint.*Réessayez/);
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('allumer ne lit pas le portail : une panne de lecture ne l’empêche pas', async () => {
    const { srv, ecrits } = reglages({ portail: async () => { throw new Error('connexion perdue'); } });
    expect((await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.admin), payload: { actif: true } })).statusCode).toBe(200);
    expect(ecrits).toEqual([{ tenant: 't1', actif: true }]);
    await srv.close();
  });

  it('allumer n’est jamais refusé, portail relié ou pas', async () => {
    const { srv, ecrits } = reglages({ portail: avecPortailHubspot });
    expect((await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.admin), payload: { actif: true } })).statusCode).toBe(200);
    expect(ecrits).toEqual([{ tenant: 't1', actif: true }]);
    await srv.close();
  });

  it('🔴 réservé aux admins : ni un manager ni un agent ne le lisent ou ne l’écrivent', async () => {
    const { srv, ecrits } = reglages();
    for (const t of [tok.manager, tok.agent]) {
      expect((await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(t), payload: { actif: true } })).statusCode).toBe(403);
      expect((await srv.inject({ method: 'GET', url: '/tenants/t1/settings', ...h(t) })).statusCode).toBe(403);
    }
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('🔴 isolation : l’admin d’un autre espace ne touche pas à celui-ci', async () => {
    const { srv, ecrits } = reglages();
    expect((await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.autreAdmin), payload: { actif: true } })).statusCode).toBe(403);
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('une valeur qui n’est pas un booléen est refusée, jamais lue comme « allumé » ou « éteint »', async () => {
    const { srv, ecrits } = reglages();
    for (const actif of ['true', 1, 0, null, undefined]) {
      expect((await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.admin), payload: { actif } })).statusCode).toBe(400);
    }
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('écriture non câblée : 503, jamais un « enregistré » qui n’écrit rien', async () => {
    const { srv } = reglages({ cable: false });
    expect((await srv.inject({ method: 'PATCH', url: URL_ACTIF, ...h(tok.admin), payload: { actif: true } })).statusCode).toBe(503);
    await srv.close();
  });
});

function compte(over: Partial<AccountRouteDeps> = {}) {
  const appels: string[] = [];
  const deps: AccountRouteDeps = {
    getPhoneNumber: async () => null,
    pullStatus: async () => null,
    saveStatus: async () => {},
    setHubspotConnected: async () => ({ updated: false, resumedFrom: null }),
    enqueueHubspotCatchup: async () => {},
    getHubspotPortal: async () => ({ connected: true, hubId: '1', hubDomain: 'acme.hubspot.com' }),
    disconnectHubspot: async (tenant) => { appels.push(`connecteur:${tenant}`); return { disconnected: true, revoked: true }; },
    disconnectHubspotTenant: async (tenant) => { appels.push(`base:${tenant}`); return { updated: false }; },
    ...over,
  };
  return { appels, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, account: deps }) };
}
const URL_DECO = '/tenants/t1/hubspot/deconnexion';

describe('la déconnexion complète d’un espace SANS numéro', () => {
  it('🔴 elle délie le portail chez le connecteur PUIS coupe en base, sans aucun numéro', async () => {
    const { srv, appels } = compte();
    const res = await srv.inject({ method: 'POST', url: URL_DECO, ...h(tok.admin), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hubspotConnected: false, disconnected: true });
    expect(appels, 'l’ordre est l’anti-drift : jamais la base avant le connecteur').toEqual(['connecteur:t1', 'base:t1']);
    await srv.close();
  });

  it('🔴 le connecteur échoue : 502, et la base n’est PAS coupée', async () => {
    const { srv, appels } = compte({ disconnectHubspot: async () => { throw new Error('connecteur down'); } });
    expect((await srv.inject({ method: 'POST', url: URL_DECO, ...h(tok.admin), payload: {} })).statusCode).toBe(502);
    expect(appels).toEqual([]);
    await srv.close();
  });

  it('canal du connecteur non configuré : 503, rien en base', async () => {
    const { srv, appels } = compte({ disconnectHubspot: undefined });
    expect((await srv.inject({ method: 'POST', url: URL_DECO, ...h(tok.admin), payload: {} })).statusCode).toBe(503);
    expect(appels).toEqual([]);
    await srv.close();
  });

  it('🔴 réservé aux admins, et à SON espace', async () => {
    const { srv, appels } = compte();
    for (const t of [tok.manager, tok.agent, tok.autreAdmin]) {
      expect((await srv.inject({ method: 'POST', url: URL_DECO, ...h(t), payload: {} })).statusCode).toBe(403);
    }
    expect(appels).toEqual([]);
    await srv.close();
  });
});

const DOSSIER = resolve(__dirname, '..', 'db', 'migrations');
const fichiers = readdirSync(DOSSIER).filter((f) => /^\d{4}_hubspot_actif\.sql$/.test(f));
const sql = fichiers.length === 1 ? readFileSync(join(DOSSIER, fichiers[0]!), 'utf8') : '';
/** Le SQL sans ses commentaires de ligne (`\r?\n` : un poste Windows garde son `\r`). */
const corps = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');

describe('la migration de l’interrupteur', () => {
  it('existe, une seule fois, sous le numéro 0179', () => {
    expect(fichiers).toEqual(['0179_hubspot_actif.sql']);
  });

  it('ajoute la colonne, faux par défaut, jamais nulle, et rejouable', () => {
    expect(corps).toMatch(/alter table tenant_settings add column if not exists hubspot_actif boolean not null default false;/);
  });

  it('🔴 la reprise est GARDÉE : aucune lecture du schéma du connecteur hors du `if to_regclass`', () => {
    // Sur une base sans le schéma `mmhs` (la CI, une instance sans connecteur), une référence non gardée ferait
    // échouer la migration entière. Toute mention de `mmhs.` doit donc vivre ENTRE la garde et son `end if`.
    const garde = corps.search(/if to_regclass\('mmhs\.tenant_portals'\) is not null and to_regclass\('mmhs\.portals'\) is not null then/);
    const fin = corps.search(/end if;/);
    expect(garde, 'la garde est présente').toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(garde);
    const occurrences = [...corps.matchAll(/mmhs\./g)].map((m) => m.index ?? -1);
    expect(occurrences.length).toBeGreaterThan(0);
    for (const i of occurrences) expect(i >= garde && i < fin, `mmhs. hors de la garde, position ${i}`).toBe(true);
  });

  it('🔴 la reprise suit la lecture de l’écran : un portail relié = un lien ET son portail', () => {
    expect(corps).toMatch(/from mmhs\.tenant_portals tp\s+join mmhs\.portals p on p\.hub_id = tp\.hub_id/);
    expect(corps).toMatch(/on conflict \(tenant_id\) do update set hubspot_actif = true/);
  });

  it('🔴 le lien du connecteur est comparé en TEXTE, jamais converti en uuid', () => {
    // `tenant_id` est `text` dans mmhs : une ligne qui ne serait pas un uuid ferait échouer une conversion, donc
    // la migration entière. Comparée en texte, elle ne rejoint simplement aucun espace.
    expect(corps).toMatch(/join tenants t on t\.id::text = tp\.tenant_id/);
    expect(corps).not.toMatch(/tp\.tenant_id::uuid/);
  });

  it('elle est additive et transactionnelle, et se découpe en deux instructions', () => {
    expect(corps).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(veutHorsTransaction(sql)).toBe(false);
    const instructions = decouperInstructions(sql);
    expect(instructions).toHaveLength(2);
    expect(instructions[1]!.trimStart().startsWith('do $$')).toBe(true);
  });

  it('aucun accent grave dans le fichier (ils ferment le gabarit de chaîne des outils qui le relisent)', () => {
    expect(sql).not.toContain('`');
  });
});
