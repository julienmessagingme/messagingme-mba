import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { HubspotChoixRouteDeps } from '../src/http/hubspot-choix';
import type { ChoixHubspotEcrit } from '../src/settings/store.pg';
import type { Fonction } from '../src/offres/offres';
import type { ModeTaches } from '../src/account/types';
import { ConnecteurEnReveil } from '../src/crm/hubspot-service';

/**
 * `PUT /tenants/:t/hubspot/choix` (lot 1bis) : le client choisit ce qu'il branche entre Messaging Me et HubSpot.
 */
const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
let autreAdminTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
  autreAdminTok = await signSession({ userId: 'u3', tenantId: 't2', role: 'admin' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const put = (tok: string, body: unknown) => ({
  method: 'PUT' as const, url: '/tenants/t1/hubspot/choix', payload: JSON.stringify(body),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
});
const TOUT = { analyse: true, passage: true, injoignable: true, reponse: false, listes: false, taches: true };
const ENTREPRISE: ReadonlySet<Fonction> = new Set<Fonction>(['analyse', 'crm', 'inbox']);

interface Banc {
  ecrits: Array<{ t: string; c: ChoixHubspotEcrit }>;
  synchros: Array<{ numero: string; t: string }>;
  modes: Array<{ t: string; mode: ModeTaches }>;
}

function app(o: {
  fonctions?: ReadonlySet<Fonction>;
  relie?: boolean;
  reveil?: boolean;
  premiere?: boolean;
  numero?: { id: string; hubspotConnected: boolean; hubspotPausedAt: string | null } | null;
  modeEchoue?: boolean;
  avant?: { analyse: boolean; reponse: boolean; listes: boolean; modeles?: boolean };
  synchroEchoue?: boolean;
} = {}): { server: ReturnType<typeof buildServer>; b: Banc } {
  const b: Banc = { ecrits: [], synchros: [], modes: [] };
  const deps: HubspotChoixRouteDeps = {
    poserChoix: async (t, c) => {
      b.ecrits.push({ t, c });
      return {
        choix: { analyse: c.analyse, passage: c.passage, injoignable: c.injoignable, reponse: c.reponse, modeles: c.modeles, valideLe: new Date('2026-10-23T18:00:00.000Z') },
        listes: c.listes,
        premiereValidation: o.premiere ?? true,
      };
    },
    fonctions: async () => o.fonctions ?? ENTREPRISE,
    choixEnVigueur: async () => ({ modeles: false, ...(o.avant ?? { analyse: false, reponse: false, listes: false }), valideLe: (o.premiere ?? true) ? null : new Date('2026-10-20T10:00:00.000Z') }),
    portail: async () => { if (o.reveil) throw new ConnecteurEnReveil(); return { connected: o.relie ?? true }; },
    numeroPrincipal: async () => (o.numero === undefined ? { id: 'pn1', hubspotConnected: false, hubspotPausedAt: null } : o.numero),
    allumerSynchro: async (numero, t) => { if (o.synchroEchoue) throw new Error('base'); b.synchros.push({ numero, t }); },
    poserModeTaches: async (t, mode) => {
      if (o.modeEchoue) throw new Error('connecteur injoignable');
      b.modes.push({ t, mode });
      return mode;
    },
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, hubspotChoix: deps }), b };
}

describe('PUT /tenants/:t/hubspot/choix (lot 1bis)', () => {
  it('🔴 agent, ou admin d’un AUTRE espace : 403, rien n’est écrit', async () => {
    const { server, b } = app();
    expect((await server.inject(put(agentTok, TOUT))).statusCode).toBe(403);
    expect((await server.inject(put(autreAdminTok, TOUT))).statusCode).toBe(403);
    expect(b.ecrits).toHaveLength(0);
    await server.close();
  });

  it('corps invalide (champ manquant, type faux, champ de trop) : 400, rien n’est écrit', async () => {
    const { server, b } = app();
    const { passage: _p, ...sansPassage } = TOUT;
    for (const corps of [sansPassage, { ...TOUT, analyse: 'oui' }, { ...TOUT, taches: 'oui' }, { ...TOUT, autre: true }]) {
      expect((await server.inject(put(adminTok, corps))).statusCode).toBe(400);
    }
    expect(b.ecrits).toHaveLength(0);
    await server.close();
  });

  it('🔴 ALLUMER (d’éteint à allumé) une fonction que l’offre n’ouvre pas : 402 ; l’ÉTEINDRE est toujours permis', async () => {
    const pro = new Set<Fonction>(['inbox']);
    const { server, b } = app({ fonctions: pro });
    const refus = await server.inject(put(adminTok, { ...TOUT, analyse: true }));
    expect(refus.statusCode).toBe(402);
    expect(refus.json()).toMatchObject({ code: 'plan_feature_unavailable', fonction: 'analyse' });
    expect((await server.inject(put(adminTok, { ...TOUT, analyse: false, listes: true }))).json()).toMatchObject({ fonction: 'crm' });
    expect(b.ecrits).toHaveLength(0);
    const eteint = await server.inject(put(adminTok, { ...TOUT, analyse: false, listes: false }));
    expect(eteint.statusCode).toBe(200);
    expect(b.ecrits).toHaveLength(1);
    await server.close();
  });

  it('🔴 connecteur qui se réveille : 503 qui le dit, rien n’est écrit (jamais un 500 muet)', async () => {
    const { server, b } = app({ reveil: true });
    const res = await server.inject(put(adminTok, TOUT));
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toMatch(/réveille/);
    expect(b.ecrits).toHaveLength(0);
    await server.close();
  });

  it('sans portail relié : 409 hubspot_non_relie, rien n’est écrit', async () => {
    const { server, b } = app({ relie: false });
    const res = await server.inject(put(adminTok, TOUT));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'hubspot_non_relie' });
    expect(b.ecrits).toHaveLength(0);
    await server.close();
  });

  it('🔴 écrit le choix, pose le mode des tâches, et allume la synchro du numéro principal à la PREMIÈRE validation', async () => {
    const { server, b } = app({ premiere: true });
    const res = await server.inject(put(adminTok, { ...TOUT, passage: false, taches: false }));
    expect(res.statusCode).toBe(200);
    expect(b.ecrits).toEqual([{ t: 't1', c: { analyse: true, passage: false, injoignable: true, reponse: false, modeles: false, listes: false } }]);
    expect(b.modes).toEqual([{ t: 't1', mode: 'hubspot_native' }]);
    expect(b.synchros).toEqual([{ numero: 'pn1', t: 't1' }]);
    expect(res.json()).toEqual({
      hubspotAnalyse: true, hubspotPassage: false, hubspotInjoignable: true, hubspotReponse: false, hubspotModeles: false, hubspotListsEnabled: false,
      hubspotChoixValideLe: '2026-10-23T18:00:00.000Z', routingMode: 'hubspot_native', tachesAppliquees: true, premiereValidation: true,
    });
    await server.close();
  });

  it('🟡 une validation SUIVANTE ne touche pas la synchro ; un numéro en pause ou déjà synchronisé non plus', async () => {
    const suivante = app({ premiere: false });
    await suivante.server.inject(put(adminTok, TOUT));
    expect(suivante.b.synchros).toHaveLength(0);
    await suivante.server.close();
    const enPause = app({ numero: { id: 'pn1', hubspotConnected: false, hubspotPausedAt: '2026-10-20T10:00:00Z' } });
    await enPause.server.inject(put(adminTok, TOUT));
    expect(enPause.b.synchros).toHaveLength(0);
    await enPause.server.close();
    const sansNumero = app({ numero: null });
    expect((await sansNumero.server.inject(put(adminTok, TOUT))).statusCode).toBe(200);
    await sansNumero.server.close();
  });

  it('🔴 le connecteur échoue sur le mode : le reste est enregistré, et la réponse le DIT (jamais un succès muet)', async () => {
    const { server, b } = app({ modeEchoue: true });
    const res = await server.inject(put(adminTok, TOUT));
    expect(res.statusCode).toBe(200);
    expect(b.ecrits).toHaveLength(1);
    expect(res.json()).toMatchObject({ tachesAppliquees: false, routingMode: null });
    await server.close();
  });
});

describe('PUT .../hubspot/choix : les correctifs de la relecture du lot 1bis', () => {
  it('🔴 « Créer des tâches » ABSENT du corps : le mode du portail n’est PAS touché (jamais réécrit depuis une valeur devinée)', async () => {
    const { taches: _t, ...sansTaches } = TOUT;
    const { server, b } = app();
    const res = await server.inject(put(adminTok, sansTaches));
    expect(res.statusCode).toBe(200);
    expect(b.modes).toHaveLength(0);
    expect(res.json()).toMatchObject({ routingMode: null, tachesAppliquees: true });
    await server.close();
  });

  it('🟡 un espace descendu d’offre garde allumé ce qui l’était et peut éteindre le reste (pas de 402 sans transition)', async () => {
    const pro = new Set<Fonction>(['inbox']);
    const { server, b } = app({ fonctions: pro, avant: { analyse: true, reponse: false, listes: true } });
    const res = await server.inject(put(adminTok, { ...TOUT, passage: false, analyse: true, listes: true }));
    expect(res.statusCode).toBe(200);
    expect(b.ecrits).toHaveLength(1);
    await server.close();
  });

  it('🟡 la synchro échoue à la première validation : la route échoue AVANT d’écrire la date, la suivante réessaiera', async () => {
    const { server, b } = app({ premiere: true, synchroEchoue: true });
    const res = await server.inject(put(adminTok, TOUT));
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(b.ecrits).toHaveLength(0);
    await server.close();
  });
});

describe('PUT .../hubspot/choix : « Envoyer des modèles depuis HubSpot » (sous-lot relancer, décision E)', () => {
  it('🔴 ABSENT du corps : il garde sa valeur (une console d’avant le sous-lot ne l’efface pas en basculant une autre ligne)', async () => {
    const { server, b } = app({ avant: { analyse: true, reponse: true, listes: false, modeles: true } });
    const res = await server.inject(put(adminTok, { ...TOUT, reponse: true }));
    expect(res.statusCode).toBe(200);
    expect(b.ecrits[0]?.c.modeles).toBe(true);
    expect(res.json()).toMatchObject({ hubspotReponse: true, hubspotModeles: true });
    await server.close();
  });

  it('🔴 éteindre la réponse éteint les modèles, même demandés ; une réponse rallumée ne les rouvre pas en silence', async () => {
    const { server, b } = app({ avant: { analyse: true, reponse: true, listes: false, modeles: true } });
    await server.inject(put(adminTok, { ...TOUT, reponse: false, modeles: true }));
    expect(b.ecrits[0]?.c.modeles).toBe(false);
    await server.close();
    // L'état qu'a laissé cette écriture (réponse et modèles éteints) : rallumer la réponse sans nommer les modèles les laisse éteints.
    const { server: s2, b: b2 } = app({ avant: { analyse: true, reponse: false, listes: false, modeles: false } });
    await s2.inject(put(adminTok, { ...TOUT, reponse: true }));
    expect(b2.ecrits[0]?.c.modeles).toBe(false);
    await s2.close();
  });

  it('🔴 ALLUMER les modèles sans l’Inbox dans l’offre : 402 ; un booléen attendu', async () => {
    const { server, b } = app({ fonctions: new Set<Fonction>(['analyse', 'crm']), avant: { analyse: true, reponse: true, listes: false, modeles: false } });
    const refus = await server.inject(put(adminTok, { ...TOUT, reponse: true, modeles: true }));
    expect(refus.statusCode).toBe(402);
    expect(refus.json()).toMatchObject({ code: 'plan_feature_unavailable', fonction: 'inbox' });
    expect((await server.inject(put(adminTok, { ...TOUT, modeles: 'oui' }))).statusCode).toBe(400);
    expect(b.ecrits).toHaveLength(0);
    await server.close();
  });
});
