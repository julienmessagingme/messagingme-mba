import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { adresse, serveurSonde, type RouteSondee, type ServeurSonde } from './serveur-sonde';

/**
 * 🔴 LA BARRIÈRE DE RÔLE DES ROUTES ADMIN EST LA GARDE DE MONTAGE, ET ELLE SE PROUVE SUR LE SERVEUR CONSTRUIT
 * (lot 3 de l'audit ponytail, 2026-09-26).
 *
 * Ces 49 routes reposaient `if (forbidNonAdmin(req, reply)) return;` dans leur handler, alors que leur module
 * est monté sur `g.admin` (`[requireAuth, makeRequireRole(['admin'])]`) : un agent ou un manager y était déjà
 * refusé AVANT le handler, mesuré route par route sur le serveur construit avant le retrait, et le second
 * refus ne pouvait jamais répondre. Les deux rendaient le même 403, au caractère près.
 *
 * ⚠️ CE QUE LE RETRAIT DÉPLACE, ET POURQUOI CE FICHIER EXISTE. La barrière de rôle de ces routes tient
 * désormais à UN MOT dans `src/server.ts` (`g.admin` dans l'entrée du registre). Le remplacer par `g.auth`
 * ouvrirait toutes les écritures du module aux agents, et rien ne le verrait : le typecheck passe, un test de
 * module monté avec une garde ouverte passe, `tests/scope-tenant.test.ts` regarde l'espace et pas le rôle.
 * Ce fichier le voit, parce qu'il monte le VRAI registre avec les VRAIES gardes (`serveurSonde`).
 *
 * ⚠️ LA LISTE EST FIGÉE, ET C'EST VOULU : elle dit exactement où le refus a quitté le handler. Elle a été
 * relevée par exécution (chaque module monté seul, garde de rôle ouverte, session d'agent : les routes qui
 * rendaient alors 403 depuis leur handler), puis comparée à la même mesure après le retrait : les routes qui
 * ont perdu leur refus sont exactement celles-ci, pas une de plus.
 *
 * ⚠️ HORS DE LA LISTE, DÉLIBÉRÉMENT : `mbaAssistant` (sa double garde est une décision écrite dans
 * `src/server.ts`) et `contacts` (tant que ses lectures de conformité restent composées sur `g.admin`, retirer
 * ses refus d'écriture ferait dépendre la purge et l'action en masse de cette composition).
 */
const ROUTES_ADMIN: readonly string[] = [
  // import
  'POST /tenants/:tenantId/contacts/import/preview',
  'POST /tenants/:tenantId/contacts/import',
  // campaigns (les trois routes sans :tenantId comprises : l'étape d'espace ne les voit pas, ce fichier si)
  'POST /tenants/:tenantId/campaigns',
  'POST /campaigns/:campaignId/run',
  'POST /campaigns/:campaignId/recipients/:recipientId/retry',
  'POST /tenants/:tenantId/campaigns/:campaignId/pause',
  'POST /campaigns/:campaignId/cancel-schedule',
  'POST /tenants/:tenantId/campaigns/:campaignId/stop',
  'POST /tenants/:tenantId/campaigns/:campaignId/archive',
  'POST /tenants/:tenantId/campaigns/:campaignId/unarchive',
  'DELETE /tenants/:tenantId/campaigns/:campaignId',
  // settings (les routes montées sur `g.encadrement` n'en portaient aucun, et ne sont pas ici)
  'PUT /tenants/:tenantId/settings',
  'PATCH /tenants/:tenantId/settings/hubspot-lists',
  'PATCH /tenants/:tenantId/settings/hubspot-actif',
  'PATCH /tenants/:tenantId/settings/poussee-optout',
  'PATCH /tenants/:tenantId/settings/mention-ia',
  'PATCH /tenants/:tenantId/settings/transfert-agent',
  'PATCH /tenants/:tenantId/settings/control-handback',
  'PATCH /tenants/:tenantId/settings/mba-handoff',
  'PATCH /tenants/:tenantId/settings/timezone',
  'PATCH /tenants/:tenantId/settings/business-hours',
  // historique
  'GET /tenants/:tenantId/historique',
  // workflows
  'POST /tenants/:tenantId/workflows',
  'POST /tenants/:tenantId/workflows/:id/duplicate',
  'PATCH /tenants/:tenantId/workflows/:id',
  'POST /tenants/:tenantId/workflows/:id/publish',
  'DELETE /tenants/:tenantId/workflows/:id',
  'POST /tenants/:tenantId/workflows/:id/test-link',
  // workflowReports
  'POST /tenants/:tenantId/workflow-reports',
  'DELETE /tenants/:tenantId/workflow-reports/:id',
  // email
  'POST /tenants/:tenantId/email/accounts',
  'PATCH /tenants/:tenantId/email/accounts/:id',
  'DELETE /tenants/:tenantId/email/accounts/:id',
  'POST /tenants/:tenantId/email/accounts/:id/test',
  'POST /tenants/:tenantId/email/templates',
  'PATCH /tenants/:tenantId/email/templates/:id',
  'DELETE /tenants/:tenantId/email/templates/:id',
  // apiKeys
  'POST /tenants/:tenantId/api-keys',
  'DELETE /tenants/:tenantId/api-keys/:id',
  // webhooksAdmin
  'GET /tenants/:tenantId/webhooks',
  'GET /tenants/:tenantId/webhooks/:id',
  'POST /tenants/:tenantId/webhooks',
  'PATCH /tenants/:tenantId/webhooks/:id',
  'DELETE /tenants/:tenantId/webhooks/:id',
  'POST /tenants/:tenantId/webhooks/:id/secret',
  'DELETE /tenants/:tenantId/webhooks/:id/secret',
  'DELETE /tenants/:tenantId/webhooks/:id/payload',
  // account
  'POST /tenants/:tenantId/hubspot/deconnexion',
  'PATCH /tenants/:tenantId/phone-numbers/:phoneNumberId/hubspot',
];

/**
 * Les modules montés sur `g.auth` dont la LECTURE est ouverte à un agent et dont les écritures sont fermées
 * dans le handler par `forbidNonAdmin` (voir leurs entrées dans `src/server.ts`). Là, ce refus est la SEULE
 * barrière de rôle, et le second sens de ce fichier empêche qu'il soit retiré à son tour par symétrie.
 */
const MODULES_ECRITURE_ADMIN_DANS_LE_HANDLER: ReadonlySet<string> = new Set([
  'channelsMe', 'automations', 'templates', 'rcsMessages', 'rcsMedia', 'rcsChannel', 'pubs',
]);

const REFUS = '{"error":"action réservée aux administrateurs"}';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('🔴 le rôle admin, sur le serveur construit', () => {
  let s: ServeurSonde;
  beforeAll(async () => { s = await serveurSonde(); }, 60_000);
  afterAll(async () => { await s.app.close(); });

  const route = (cle: string): RouteSondee | undefined => s.routes.find((r) => `${r.methode} ${r.chemin}` === cle);
  const appeler = (r: RouteSondee, jeton: string) => s.app.inject({
    method: r.methode as 'GET',
    url: adresse(r.chemin, A),
    headers: { authorization: `Bearer ${jeton}` },
    ...(r.methode === 'GET' || r.methode === 'DELETE' ? {} : { payload: {} }),
  });

  it('garde de la garde : chaque route de la liste existe sur le serveur construit', () => {
    // Une route renommée disparaîtrait sinon de la preuve en silence : la boucle suivante la sauterait.
    expect(ROUTES_ADMIN.length).toBe(49);
    expect(ROUTES_ADMIN.filter((c) => route(c) === undefined)).toEqual([]);
  });

  it('🔴 un agent et un manager du MÊME espace : 403, le même corps, AVANT le handler', async () => {
    // « Avant le handler » est ce qui prouve que la barrière est la garde de montage : le 403 seul ne le dirait
    // pas, puisque l'ancien refus du handler rendait exactement le même.
    const fautes: string[] = [];
    for (const role of ['agent', 'manager'] as const) {
      const jeton = await s.jeton(A, role);
      for (const cle of ROUTES_ADMIN) {
        const r = route(cle)!;
        s.remettreAZero();
        const res = await appeler(r, jeton);
        if (res.statusCode !== 403 || res.body !== REFUS || s.atteint(r)) {
          fautes.push(`${role} ${cle} -> ${res.statusCode} ${res.body.slice(0, 60)} handler=${s.atteint(r)}`);
        }
      }
    }
    expect(fautes, `routes admin ouvertes à un non-admin : ${fautes.join(' ; ')}`).toEqual([]);
  }, 60_000);

  it('un admin atteint le handler : la route existe, et l’assertion précédente n’est pas vide', async () => {
    // Une garde qui refuserait TOUT le monde passerait le cas précédent sans rien prouver. Les dépendances
    // étant des bouchons, plusieurs handlers finissent en 500 journalisé : le journal est tu, pas le verdict.
    const jeton = await s.jeton(A, 'admin');
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fautes: string[] = [];
    try {
      for (const cle of ROUTES_ADMIN) {
        const r = route(cle)!;
        s.remettreAZero();
        await appeler(r, jeton);
        if (!s.atteint(r)) fautes.push(cle);
      }
    } finally {
      journal.mockRestore();
    }
    expect(fautes).toEqual([]);
  }, 60_000);

  it('🔴 l’autre sens : les écritures des modules sur `g.auth` gardent leur refus DANS le handler', async () => {
    // Ici l'agent passe la garde de montage (il doit pouvoir LIRE) : c'est `forbidNonAdmin` qui ferme
    // l'écriture. Le handler est donc atteint, et il doit refuser avec le même corps.
    const jeton = await s.jeton(A, 'agent');
    const ecritures = s.routes.filter((r) => MODULES_ECRITURE_ADMIN_DANS_LE_HANDLER.has(r.module) && r.methode !== 'GET' && r.methode !== 'HEAD');
    // Garde de la garde : les sept modules sont montés et ont des écritures.
    expect(new Set(ecritures.map((r) => r.module))).toEqual(MODULES_ECRITURE_ADMIN_DANS_LE_HANDLER);
    expect(ecritures.length).toBeGreaterThan(25);
    const fautes: string[] = [];
    for (const r of ecritures) {
      s.remettreAZero();
      const res = await appeler(r, jeton);
      if (res.statusCode !== 403 || res.body !== REFUS || !s.atteint(r)) {
        fautes.push(`${r.methode} ${r.chemin} -> ${res.statusCode} ${res.body.slice(0, 60)} handler=${s.atteint(r)}`);
      }
    }
    expect(fautes, `écritures ouvertes à un agent : ${fautes.join(' ; ')}`).toEqual([]);
  }, 60_000);
});
