import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyRequest } from 'fastify';
import { gardesOuvertes } from './gardes';
import { MODULES_OUVERTS_AU_FREE, modulesDeRoutes, type Gardes, type ModuleMonte } from '../src/server';
import { GardeUsageMemoire } from './aide/usage';
import { DROITS, type Fonction, type Offre } from '../src/offres/offres';
import type { SourceOffres } from '../src/offres/offre.pg';
import { fonctionDesStatistiques } from '../src/offres/etape';

/**
 * LES FONCTIONS GARDÉES PAR L'OFFRE (lot 6, tâche 3, spec § 4). Comme l'isolation entre espaces
 * (`tests/scope-tenant.test.ts`), la preuve est DYNAMIQUE : chaque route de chaque module gardé est appelée par un
 * espace Base, et elle doit répondre 402 avant que le module ne fasse quoi que ce soit ; puis par un espace Pro.
 */
const usage = new GardeUsageMemoire(120, 0, () => Date.now(), 0);
const bouchon = (): unknown => new Proxy(function () {} as never, {
  get: (_c, p) => (typeof p === 'symbol' || p === 'then' ? undefined : bouchon()),
  apply: () => bouchon(),
});
const toutBouchonne = new Proxy({}, { get: (_c, p) => (typeof p === 'symbol' ? undefined : bouchon()) }) as never;
const gardes = (): ModuleMonte[] => modulesDeRoutes(toutBouchonne, usage).filter((m) => m.garde !== null);

/** La correspondance validée (plan, tâche 3 ; statistiques : décision de Julien du 2026-10-07). */
const ATTENDU: Record<string, string> = {
  rcsMessages: 'rcs', rcsChannel: 'rcs',
  // La médiathèque sert le bloc « message rapide » des scénarios autant que le RCS : le Pro y dépose (spec médias, § 2.3).
  rcsMedia: 'scenarios',
  integrationBatch: 'crm', salesforce: 'crm', hubspotImport: 'crm', hubspotInstall: 'crm', hubspotPipelines: 'crm',
  inbox: 'inbox', stats: 'partagé', flows: 'scenarios (écritures)', workflows: 'scenarios (écritures)',
  mbaPublication: 'agent_meta', mbaOutils: 'agent_meta', mba: 'agent_meta',
  mbaAssistant: 'assistants', agentSetup: 'assistants', aide: 'aide',
  pubs: 'publicites', workflowReports: 'performance_lab', channelsMe: 'chaines', email: 'email',
};

function source(offre: Offre): SourceOffres & { lectures: number } {
  const s = { lectures: 0, offreDe: async () => { s.lectures += 1; return { offre, droits: DROITS[offre], retourEnBaseLe: null }; } };
  return s;
}

/** Une session de l'espace t1, posée par la garde d'authentification. */
const authT1 = async (req: FastifyRequest): Promise<void> => { (req as { auth?: unknown }).auth = { tenantId: 't1', userId: 'u1', role: 'admin' }; };

async function appeler(m: ModuleMonte, offres: SourceOffres, espace = 't1') {
  const app = Fastify({ logger: false });
  const routes: Array<{ methode: string; chemin: string }> = [];
  app.addHook('onRoute', (r) => {
    const methodes = Array.isArray(r.method) ? r.method : [r.method];
    for (const methode of methodes) if (methode !== 'HEAD' && r.path.includes(':tenantId')) routes.push({ methode, chemin: r.path });
  });
  const g: Gardes = { ...gardesOuvertes, auth: authT1, admin: authT1, encadrement: authT1, adminOuLien: authT1, offres };
  m.monte(app, g);
  await app.ready();
  const resultats: Array<{ methode: string; chemin: string; statut: number }> = [];
  for (const r of routes) {
    const url = r.chemin.replace(':tenantId', espace).replace(/:[A-Za-z_]+/g, 'x').replace('*', 'x');
    const avecCorps = r.methode !== 'GET' && r.methode !== 'DELETE';
    const res = await app.inject({ method: r.methode as never, url, ...(avecCorps ? { payload: {}, headers: { 'content-type': 'application/json' } } : {}) });
    resultats.push({ ...r, statut: res.statusCode });
  }
  await app.close();
  return resultats;
}

describe('les fonctions gardées par l’offre', () => {
  it('🔴 le registre garde exactement les modules validés, ni plus ni moins', () => {
    expect(gardes().map((m) => m.nom).sort()).toEqual(Object.keys(ATTENDU).sort());
  });

  for (const nom of Object.keys(ATTENDU)) {
    it(`🔴 ${nom} : chaque route gardée refuse un espace Base en 402, les autres passent la fonction (la console en Pro)`, async () => {
      const m = gardes().find((x) => x.nom === nom)!;
      const resultats = await appeler(m, source('base'));
      expect(resultats.length).toBeGreaterThan(0);
      // En Base, une route « ouverte » exige encore la console (spec offres v2) : toutes refusent.
      for (const r of resultats) {
        const garde = m.garde!({ methodes: [r.methode], chemin: r.chemin }) ?? 'console';
        expect(r.statut, `${r.methode} ${r.chemin} exige ${garde} et répond ${r.statut}`).toBe(402);
      }
      // En Pro, la console est ouverte : une route sans fonction propre passe.
      for (const r of await appeler(m, source('pro'))) {
        if (m.garde!({ methodes: [r.methode], chemin: r.chemin }) === null) {
          expect(r.statut, `${r.methode} ${r.chemin} est ouverte et répond ${r.statut}`).not.toBe(402);
        }
      }
    });
  }

  it('🔴 un espace Pro passe les fonctions du Pro et bute sur celles de l’Entreprise', async () => {
    const inbox = await appeler(gardes().find((m) => m.nom === 'inbox')!, source('pro'));
    for (const r of inbox) expect(r.statut).not.toBe(402);
    const crm = await appeler(gardes().find((m) => m.nom === 'hubspotImport')!, source('pro'));
    for (const r of crm) expect(r.statut).toBe(402);
  });

  it('🔴 un espace Pro dépose dans la médiathèque : le bloc « message rapide » de ses scénarios en a besoin (spec médias, § 2.3)', async () => {
    const medias = await appeler(gardes().find((m) => m.nom === 'rcsMedia')!, source('pro'));
    expect(medias.length).toBeGreaterThan(0);
    for (const r of medias) expect(r.statut, `${r.methode} ${r.chemin}`).not.toBe(402);
  });

  it('🔴 un espace Entreprise passe tout', async () => {
    for (const m of gardes()) for (const r of await appeler(m, source('entreprise'))) expect(r.statut, `${m.nom} ${r.chemin}`).not.toBe(402);
  });

  it('🔴 l’isolation passe avant l’offre : un autre espace reçoit 403, et l’offre n’est même pas lue', async () => {
    const s = source('base');
    const resultats = await appeler(gardes().find((m) => m.nom === 'inbox')!, s, 't2');
    for (const r of resultats) expect(r.statut).toBe(403);
    expect(s.lectures).toBe(0);
  });

  it('le refus dit quoi faire : code stable, fonction, lien vers l’offre', async () => {
    const app = Fastify({ logger: false });
    const m = gardes().find((x) => x.nom === 'inbox')!;
    m.monte(app, { ...gardesOuvertes, auth: authT1, admin: authT1, encadrement: authT1, adminOuLien: authT1, offres: source('base') });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/conversations' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'plan_feature_unavailable', fonction: 'inbox', upgradeUrl: expect.stringMatching(/\/offre$/) });
    await app.close();
  });
});

/**
 * LA CONSOLE FERMÉE EN FREE (spec offres v2, livraison 3), PAR LE SERVEUR : chaque route d'espace exige la fonction
 * `console`, sauf la liste blanche du registre (le numéro, les clés, l'offre et ses paiements, le compte, le support), qui
 * descend à la route quand un module mêle les deux. Une campagne lancée depuis la console échapperait sinon au quota de
 * l'API : fermer l'écran seul ne suffit pas. La preuve est dynamique : chaque route de chaque module est appelée par un
 * espace Free.
 */
const OUVERTS_AU_FREE = [
  'offre', 'offrePaiement', 'creditPaiement', 'embeddedSignup', 'connexion360dialog', 'numeroFourni', 'abonnementNumero',
  'apiKeys', 'oauthConsentement', 'account', 'admin', 'me', 'emailsMoi', 'support',
];
const modulesDEspace = (): ModuleMonte[] => modulesDeRoutes(toutBouchonne, usage).filter((m) => m.acces === 'tenant');
const route = (r: { methode: string; chemin: string }) => ({ methodes: [r.methode], chemin: r.chemin });

describe('🔴 la console fermée en Free, par le serveur', () => {
  it('la liste blanche nomme exactement ces modules, et chacun est un module d’espace du registre', () => {
    expect(Object.keys(MODULES_OUVERTS_AU_FREE).sort()).toEqual([...OUVERTS_AU_FREE].sort());
    const noms = modulesDEspace().map((m) => m.nom);
    for (const nom of OUVERTS_AU_FREE) expect(noms, nom).toContain(nom);
  });

  it('🔴 chaque route d’espace refuse une Free, sauf celles que la liste lui garde, avec la fonction qui l’ouvre', async () => {
    let ouvertes = 0;
    for (const m of modulesDEspace()) {
      for (const r of await appeler(m, source('base'))) {
        const attendue = m.garde?.(route(r)) ?? (m.ouvertAuFree(route(r)) ? null : 'console');
        if (attendue === null) {
          ouvertes += 1;
          expect(r.statut, `${m.nom} ${r.methode} ${r.chemin} est gardée à la Free`).not.toBe(402);
        } else expect(r.statut, `${m.nom} ${r.methode} ${r.chemin} exige ${attendue}`).toBe(402);
      }
    }
    expect(ouvertes).toBeGreaterThan(0);
  });

  it('🔴 la liste descend à la route : de `account`, le statut du numéro et pas HubSpot ; d’`admin`, la lecture du nom et rien d’autre', async () => {
    const statut = async (nom: string) => new Map((await appeler(modulesDEspace().find((m) => m.nom === nom)!, source('base')))
      .map((r) => [`${r.methode} ${r.chemin}`, r.statut]));
    const account = await statut('account');
    expect(account.get('GET /tenants/:tenantId/account-status')).not.toBe(402);
    expect(account.get('POST /tenants/:tenantId/hubspot/deconnexion')).toBe(402);
    expect(account.get('PATCH /tenants/:tenantId/phone-numbers/:phoneNumberId/hubspot')).toBe(402);
    const admin = await statut('admin');
    expect(admin.get('GET /tenants/:tenantId/nom')).not.toBe(402);
    expect(admin.get('PATCH /tenants/:tenantId/nom')).toBe(402);
    expect([...admin.values()].filter((s) => s !== 402)).toHaveLength(1);
  });

  it('🔴 un Pro passe la console : un module sans fonction propre ne le refuse jamais', async () => {
    for (const m of modulesDEspace().filter((x) => x.garde === null)) {
      for (const r of await appeler(m, source('pro'))) expect(r.statut, `${m.nom} ${r.methode} ${r.chemin}`).not.toBe(402);
    }
  });

  it('le refus d’une Free nomme la console et renvoie à l’offre', async () => {
    const app = Fastify({ logger: false });
    const m = modulesDEspace().find((x) => x.nom === 'contacts')!;
    m.monte(app, { ...gardesOuvertes, auth: authT1, admin: authT1, encadrement: authT1, adminOuLien: authT1, offres: source('base') });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/contacts/blocked' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'plan_feature_unavailable', fonction: 'console', upgradeUrl: expect.stringMatching(/\/offre$/) });
    expect(res.json<{ error: string }>().error).toMatch(/la console complète\. Passez en Pro/);
    await app.close();
  });
});

/**
 * 🔴 CHAQUE ROUTE DU MODULE, ET L'ÉCRAN QUI LA LIT. Une route sert parfois un écran de tous les jours ET un écran du
 * Performance Lab (`/stats` nourrit l'accueil et « Messages & contacts ») : elle reste alors ouverte, et c'est la console
 * qui grise l'écran payant. La fermer casserait l'accueil ou la page Campagnes d'une Base, ce que le premier découpage
 * faisait. Une route ajoutée au module sans ligne ici fait échouer le test : son offre se décide, elle ne s'hérite pas.
 */
const PARTAGE_DES_STATISTIQUES: Record<string, Fonction | null> = {
  // L'accueil (`web/app/accueil`) : les volumes des canaux, la vue d'ensemble, les modèles, la courbe des coûts.
  '/accueil/volumes': null,
  '/stats': null,
  '/stats/templates': null,
  '/stats/cost': null,
  // La page Campagnes (`web/app/campaigns`) : le coût de chaque campagne (et les tarifs, par `/stats/templates`).
  '/stats/cost/campaigns': null,
  // Le journal des erreurs du centre de Sécurité : une Base en a besoin pour ses envois.
  '/stats/errors': null,
  '/stats/errors/:code/contacts': null,
  // Le Pro, le quantitatif : l'entonnoir, la page Performance (temps de réponse de l'équipe), les coûts détaillés.
  '/stats/campaign-funnel': 'statistiques',
  '/stats/performance': 'statistiques',
  '/stats/cost/pubs': 'statistiques',
  '/stats/cost/messages': 'statistiques',
  '/stats/cost/ia': 'statistiques',
  '/stats/cost/campaigns/:campaignId': 'statistiques',
  // L'Entreprise : l'analyse des conversations (et le nuage de la Synthèse), « Mes tableaux ».
  '/stats/conversations': 'performance_lab',
  '/stats/conversations/jours': 'performance_lab',
  '/stats/conversations/nuage': 'performance_lab',
  '/stats/conversations/list': 'performance_lab',
  '/stats/workflow/:workflowId': 'performance_lab',
};

describe('le partage des statistiques (décision de Julien du 2026-10-07 : Pro le quantitatif, Entreprise le reste)', () => {
  const f = (chemin: string) => fonctionDesStatistiques({ methodes: ['GET'], chemin: `/tenants/:tenantId${chemin}` });

  it('🔴 chaque route du module a sa ligne, et la garde la classe comme elle', () => {
    const source = readFileSync(new URL('../src/http/stats.ts', import.meta.url), 'utf8');
    const routes = [...source.matchAll(/app\.get\('\/tenants\/:tenantId([^']*)'/g)].map((m) => m[1]!).sort();
    expect(routes).toEqual(Object.keys(PARTAGE_DES_STATISTIQUES).sort());
    for (const [chemin, attendu] of Object.entries(PARTAGE_DES_STATISTIQUES)) expect(f(chemin), chemin).toBe(attendu);
  });

  it('🔴 l’accueil, la page Campagnes et le journal des erreurs d’une Base ne lisent que des routes ouvertes', () => {
    for (const c of ['/accueil/volumes', '/stats', '/stats/templates', '/stats/cost', '/stats/cost/campaigns', '/stats/errors']) {
      expect(f(c), c).toBeNull();
    }
  });
});
