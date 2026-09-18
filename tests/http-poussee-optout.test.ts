import { describe, it, expect, beforeAll } from 'vitest';
import { GRILLE_DEFAUT } from '../src/stats/prix';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { SettingsRouteDeps } from '../src/http/settings';
import type { AgentRequetesRouteDeps } from '../src/http/agent-requetes';
import type { RequeteConnecteur } from '../src/agent/requetes';

/**
 * LE BRANCHEMENT « prévenir mon système à chaque désabonnement » (tâche 7, migration 0139).
 *
 * 🔴 CE QUE CES ROUTES ACCORDENT : décider qu'à chaque refus, des données de contact partent chez un tiers.
 * Trois gardes se vérifient ici et nulle part ailleurs : le geste est réservé aux ADMINISTRATEURS, la requête
 * désignée doit appartenir à CET espace (un uuid pris ailleurs pointerait sur le connecteur d'un autre
 * client, et la poussée partirait chez lui), et une requête branchée ne se supprime pas en silence.
 */

const SECRET = 'test-secret';
const RQ = '11111111-1111-4111-8111-111111111111';
const RQ_AILLEURS = '33333333-3333-4333-8333-333333333333';
const SRC = '22222222-2222-4222-8222-222222222222';
let adminTok = '';
let managerTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  managerTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'manager' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const REQUETE: RequeteConnecteur = {
  id: RQ, tenantId: 't1', sourceId: SRC, label: 'Desabonner dans le CRM',
  methode: 'POST', chemin: '/unsubscribe', parametres: [], entetes: [],
  corps: { mode: 'json', gabarit: '{"phone":"{{tel}}"}' },
  variables: [{ nom: 'tel', type: 'string', origine: { type: 'contact', cle: 'wa_id' } }],
  outputPaths: ['ok'], valeursTest: {}, outils: 0, updatedAt: '2026-09-13T00:00:00.000Z',
};

function app(branche: string | null = null) {
  const ecrits: Array<string | null> = [];
  let courant = branche;
  const settings: SettingsRouteDeps = {
    getSettings: async () => ({
      mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
      controlHandbackSeconds: null, mbaHandoffMode: null, optoutRequestId: courant, mentionIaFrequence: null, prix: GRILLE_DEFAUT,
      timezone: 'Europe/Paris', businessHours: {},
    }),
    setMbaEnabled: async () => {},
    setHubspotListsEnabled: async () => {},
    setAutoRetryEnabled: async () => {},
    setMbaHandoffMode: async () => {},
    setControlHandbackSeconds: async () => {},
    setTimezone: async () => {},
    setBusinessHours: async () => {},
    listerRequetesConnecteur: async () => [{ id: RQ, label: REQUETE.label }],
    setOptoutRequestId: async (_t, id) => { ecrits.push(id); courant = id; },
  };
  const agentRequetes: AgentRequetesRouteDeps = {
    lister: async () => [REQUETE],
    parId: async (tenant, id) => (tenant === 't1' && id === RQ ? REQUETE : null),
    creer: async () => REQUETE,
    patch: async () => REQUETE,
    supprimer: async () => true,
    sourcePourTest: async () => ({ baseUrl: 'https://api.client.fr', entetes: {}, status: 'active' }),
    clesDeChamps: async () => [],
    verifierResolution: async () => ({ ok: true }),
    brancheeSurConsentement: async (_t, id) => courant === id,
  };
  return { ecrits, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, settings, agentRequetes }) };
}

const URL_REGLAGE = '/tenants/t1/settings/poussee-optout';

describe('le connecteur prévenu à chaque désabonnement', () => {
  it('la lecture rend le branchement ET la liste des appels déclarés', async () => {
    const { srv } = app(RQ);
    const res = await srv.inject({ method: 'GET', url: URL_REGLAGE, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requestId: RQ, requetes: [{ id: RQ, label: 'Desabonner dans le CRM' }] });
    await srv.close();
  });

  it('un admin branche, puis débranche avec null', async () => {
    const { srv, ecrits } = app();
    const on = await srv.inject({ method: 'PATCH', url: URL_REGLAGE, payload: { requestId: RQ }, ...h(adminTok) });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ requestId: RQ });

    const off = await srv.inject({ method: 'PATCH', url: URL_REGLAGE, payload: { requestId: null }, ...h(adminTok) });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ requestId: null });
    expect(ecrits).toEqual([RQ, null]);
    await srv.close();
  });

  /**
   * 🔴 BRANCHER, C'EST DÉCIDER D'ENVOYER DES DONNÉES DE CONTACT À UN TIERS. Un manager consulte la liste des
   * désabonnés (c'est son écran) ; il ne décide pas où partent les données de l'espace.
   *
   * ⚠️ ET IL N'Y ACCÈDE PAS DU TOUT, en lecture comme en écriture : le module `settings` est monté avec
   * `requireAdmin`. C'est ce test qui l'a MESURÉ, contre un docblock qui annonçait l'inverse. L'écran du
   * Consentement n'affiche donc ce bloc que pour un administrateur, au lieu de lui rendre 403.
   */
  it('🔴 un manager ne touche à ce réglage ni en écriture, ni en lecture', async () => {
    const { srv, ecrits } = app();
    const ecriture = await srv.inject({ method: 'PATCH', url: URL_REGLAGE, payload: { requestId: RQ }, ...h(managerTok) });
    expect(ecriture.statusCode).toBe(403);
    const lecture = await srv.inject({ method: 'GET', url: URL_REGLAGE, ...h(managerTok) });
    expect(lecture.statusCode).toBe(403);
    expect(ecrits, 'rien n’a été écrit').toEqual([]);
    await srv.close();
  });

  /**
   * 🔴 LE CAS D'ISOLATION. La clé étrangère de la migration 0139 ne regarde pas le tenant : sans cette
   * vérification, un uuid pris ailleurs serait accepté et la poussée partirait vers le connecteur d'un autre
   * client, avec les contacts de celui-ci.
   */
  it('🔴 une requête qui n’est pas de cet espace est REFUSÉE, en 400 et pas en 500', async () => {
    const { srv, ecrits } = app();
    const res = await srv.inject({ method: 'PATCH', url: URL_REGLAGE, payload: { requestId: RQ_AILLEURS }, ...h(adminTok) });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('n’existe pas dans cet espace');
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('un corps sans requestId est refusé', async () => {
    const { srv, ecrits } = app();
    expect((await srv.inject({ method: 'PATCH', url: URL_REGLAGE, payload: {}, ...h(adminTok) })).statusCode).toBe(400);
    expect((await srv.inject({ method: 'PATCH', url: URL_REGLAGE, payload: { requestId: '  ' }, ...h(adminTok) })).statusCode).toBe(400);
    expect(ecrits).toEqual([]);
    await srv.close();
  });

  it('un autre espace ne voit rien de celui-ci', async () => {
    const { srv } = app(RQ);
    const res = await srv.inject({ method: 'GET', url: '/tenants/t9/settings/poussee-optout', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    await srv.close();
  });
});

/**
 * 🔴 LE SECOND USAGE D'UNE REQUÊTE, QUE LE COMPTEUR `outils` NE VOIT PAS. La contrainte de 0139 est en
 * `on delete set null` : sans ce refus, supprimer la requête débrancherait la conformité EN SILENCE, et le
 * client cesserait de prévenir son propre système à chaque refus sans que rien ne le dise.
 */
describe('supprimer une requête branchée sur le consentement', () => {
  it('🔴 est refusé, avec la raison et où débrancher', async () => {
    const { srv } = app(RQ);
    const res = await srv.inject({ method: 'DELETE', url: `/tenants/t1/agent-requetes/${RQ}`, ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('Consentement');
    await srv.close();
  });

  it('⚠️ ...et la MÊME requête NON branchée se supprime normalement', async () => {
    const { srv } = app(null);
    const res = await srv.inject({ method: 'DELETE', url: `/tenants/t1/agent-requetes/${RQ}`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: RQ, deleted: true });
    await srv.close();
  });
});
