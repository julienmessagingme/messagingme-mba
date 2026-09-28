import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ConnexionPubIncomplete, PasDeConnexionPub, registerPubs, type PubsRouteDeps } from '../src/http/pubs';
import { monterAvecEtapeEspace } from '../src/http/scope';
import { PublicationRefusee } from '../src/pubs/creation';
import type { ConnexionPub } from '../src/pubs/connexion.pg';
import type { ActifsAccordes } from '../src/meta/pubs';
import { aucunePubDeRoute } from './pubs-fixtures';

/**
 * LES ROUTES DE CRÉATION ET DE PUBLICATION D'UNE PUBLICITÉ (lot 3, commit 2).
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT, ET QUI NE SE VOIT NULLE PART AILLEURS : LES REFUS. Cette route engage
 * l'argent d'un client chez un tiers, sur un geste qu'aucun bouton ne rembourse. Chacun des contrôles
 * ci-dessous empêche une publicité absurde de partir, et aucun n'est exprimable par le seul schéma Zod : ce
 * sont des relations entre champs, ou des décisions produit.
 *
 * Le module est monté À LA MAIN sur un Fastify nu, avec une garde de test qui pose `req.auth` : elle DÉCLARE
 * l'hypothèse (« ce test ne vérifie pas l'authentification »), là où un `undefined` la cacherait.
 */

const TENANT = 't-1';

const etatChoisi: ConnexionPub = {
  comptePubId: '111', compteNom: 'GMC', pageId: 'p1', pageNom: 'Page', devise: 'EUR', fuseau: 'Europe/Paris',
  pageLiee: 'oui', connectePar: null, connecteLe: new Date('2026-09-23T08:00:00Z'), jetonRejeteLe: null,
};
const accordes: ActifsAccordes = { comptesPub: [], pages: [] };

interface Traces { audit: string[] }

function app(over: Partial<PubsRouteDeps> = {}, role = 'admin'): { srv: FastifyInstance; traces: Traces } {
  const traces: Traces = { audit: [] };
  const deps: PubsRouteDeps = {
    ...aucunePubDeRoute,
    configId: 'cfg-pub',
    appId: 'app-1',
    graphVersion: 'v23.0',
    connexions: {
      lire: async () => etatChoisi,
    },
    etatCompte: async () => ({ statut: 1, raisonDesactivation: 0, moyenPaiement: true }),
    connecter: async () => accordes,
    actifsAccordes: async () => accordes,
    choisir: async () => etatChoisi,
    deconnecter: async () => ({ revoqueChezMeta: true }),
    audit: async (_tenantId, _acteur, action) => { traces.audit.push(action); },
    ...over,
  };
  const srv = Fastify();
  const garde = async (req: { auth?: { tenantId: string; userId: string; role: string } }): Promise<void> => {
    req.auth = { tenantId: TENANT, userId: 'u-1', role };
  };
  monterAvecEtapeEspace(srv, () => registerPubs(srv, deps, garde as never, async () => {}));
  return { srv, traces };
}

const urlPubs = (suite = ''): string => `/tenants/${TENANT}/pubs${suite}`;

const corpsValide = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nom: 'Rentrée', texte: 'Une question ?', titre: 'Écrivez-nous', messagePreRempli: 'Bonjour',
  accueil: 'Bonjour !', budgetTotal: 150,
  debut: '2026-10-01 00:00:00+02:00', fin: '2026-10-31 23:59:59+01:00',
  // ⚠️ `ageMax: 65` : la forme qu'envoie l'écran d'avant Advantage+ explicite, que la route doit encore accepter.
  pays: ['FR'], villes: [], ageMin: 25, ageMax: 65,
  destination: 'scenario', workflowId: '11111111-1111-4111-8111-111111111111',
  tagQualification: 'devis', horsCategorieSpeciale: true,
  // ⚠️ UN VRAI EN-TÊTE JPEG : la route lit la SIGNATURE des octets, pas le champ `type`. Un corps de
  // test qui portait « un petit fichier » passait le schéma et serait refusé par la garde, donc tous ces
  // tests auraient viré au 400 en disant le contraire de ce qu'ils vérifient.
  image: { type: 'image/jpeg', base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64') },
  ...over,
});

const creee = { sorte: 'creee' as const, publiciteId: 'pub-1', campagneId: 'c-1' };

describe('POST /pubs : créer une publicité', () => {
  it('crée, et rend l’identifiant de la campagne', async () => {
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publiciteId: 'pub-1', campagneId: 'c-1' });
  });

  it('🔴 réservée aux ADMINS : elle engage l’argent du client', async () => {
    const { srv } = app({ creerPub: async () => creee }, 'member');
    expect((await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() })).statusCode).toBe(403);
  });

  it('🔴 un espace ne crée pas chez un autre', async () => {
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({ method: 'POST', url: '/tenants/t-voisin/pubs', payload: corpsValide() });
    expect(res.statusCode).toBe(403);
  });

  it('🔴 la case « hors catégorie spéciale » est OBLIGATOIRE, et cochée', async () => {
    // Logement, emploi, crédit, politique : ciblage restreint et obligations légales que cet écran ne sait
    // pas porter. On n'interdit rien au client, on l'envoie là où ces obligations sont portées.
    const { srv } = app({ creerPub: async () => creee });
    const sansCase = corpsValide();
    delete sansCase.horsCategorieSpeciale;
    for (const corps of [corpsValide({ horsCategorieSpeciale: false }), sansCase]) {
      expect((await srv.inject({ method: 'POST', url: urlPubs(), payload: corps })).statusCode).toBe(400);
    }
  });

  it('🔴 une destination « scénario » SANS scénario est refusée, avec la raison', async () => {
    // Sinon on créerait la publicité la plus chère du produit : une pub qui dépense et dont les prospects
    // n'arrivent nulle part. C'est le « proposé mais inerte » que le produit s'interdit.
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide({ workflowId: null }) });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toContain('scénario');
  });

  it('une destination « agent de Meta » n’a PAS besoin de scénario', async () => {
    const { srv } = app({ creerPub: async () => creee });
    const corps = corpsValide({ destination: 'agent_meta', workflowId: null });
    expect((await srv.inject({ method: 'POST', url: urlPubs(), payload: corps })).statusCode).toBe(200);
  });

  it('un âge minimum au-dessus du maximum est refusé', async () => {
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide({ ageMin: 60, ageMax: 30 }) });
    expect(res.statusCode).toBe(400);
  });

  it('🔴 Advantage+ : un âge minimum hors de 18-25 est refusé AVANT Meta, avec la raison', async () => {
    // Meta refuserait l'ensemble APRÈS avoir créé la campagne : un rattrapage pour une règle qu'on connaît.
    let appele = false;
    const { srv } = app({ creerPub: async () => { appele = true; return creee; } });
    for (const ageMin of [26, 40]) {
      const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide({ ageMin }) });
      expect(res.statusCode, `âge ${ageMin}`).toBe(400);
      expect(String(res.json().error)).toContain('entre 18 et 25');
    }
    expect(appele).toBe(false);
  });

  it('🔴 Advantage+ : un âge maximum autre que 65 est refusé, et son absence acceptée', async () => {
    const recus: number[] = [];
    const { srv } = app({ creerPub: async (_t, d) => { recus.push(d.formulaire.ageMin); return creee; } });
    const refuse = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide({ ageMax: 55 }) });
    expect(refuse.statusCode).toBe(400);
    expect(String(refuse.json().error)).toContain('65');
    const sansMax = corpsValide();
    delete sansMax.ageMax;
    expect((await srv.inject({ method: 'POST', url: urlPubs(), payload: sansMax })).statusCode).toBe(200);
    expect(recus).toEqual([25]);
  });

  it('une zone vide (ni pays ni ville) est refusée', async () => {
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide({ pays: [], villes: [] }) });
    expect(res.statusCode).toBe(400);
  });

  it('🔴 un budget nul ou négatif est refusé : c’est le garde-fou de dépense', async () => {
    const { srv } = app({ creerPub: async () => creee });
    for (const b of [0, -5]) {
      const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide({ budgetTotal: b }) });
      expect(res.statusCode, `budget ${b}`).toBe(400);
    }
  });

  it('un type d’image inconnu est refusé AVANT tout appel à Meta', async () => {
    let appele = false;
    const { srv } = app({ creerPub: async () => { appele = true; return creee; } });
    const corps = corpsValide({ image: { type: 'image/svg+xml', base64: 'AAAA' } });
    expect((await srv.inject({ method: 'POST', url: urlPubs(), payload: corps })).statusCode).toBe(400);
    expect(appele).toBe(false);
  });

  it('🔴 une clé EN TROP est refusée : le navigateur ne choisit pas ce qu’il envoie', async () => {
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide({ optimisation: 'LINK_CLICKS' }) });
    expect(res.statusCode).toBe(400);
  });

  it('🔴 « rien n’a été créé » rend 502 avec le message de META, tel quel', async () => {
    const { srv } = app({ creerPub: async () => ({ sorte: 'annulee', raison: 'Ad account is disabled' }) });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'Ad account is disabled', code: 'creation_refusee' });
  });

  it('🔴 « création incomplète » rend 502 MAIS donne l’identifiant de la ligne : elle est visible à l’écran', async () => {
    // C'est le seul cas où un objet peut subsister chez Meta. Le taire ferait découvrir la campagne au
    // client dans le Gestionnaire, sans qu'il sache d'où elle vient.
    const { srv } = app({
      creerPub: async () => ({ sorte: 'echec_creation', publiciteId: 'pub-1', campagneId: 'c-1', raison: 'creative refused' }),
    });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'creation_incomplete', publiciteId: 'pub-1' });
  });

  it('une connexion incomplète rend 409, pas 502 : c’est un état du parcours, pas une panne de Meta', async () => {
    const { srv } = app({ creerPub: async () => { throw new ConnexionPubIncomplete(); } });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('connexion_incomplete');
  });

  it('un espace non connecté rend 409 aussi', async () => {
    const { srv } = app({ creerPub: async () => { throw new PasDeConnexionPub(); } });
    expect((await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() })).statusCode).toBe(409);
  });

  it('la création est JOURNALISÉE, réussie comme incomplète', async () => {
    const { srv, traces } = app({ creerPub: async () => creee });
    await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() });
    expect(traces.audit).toEqual(['pubs.creee']);

    const incomplete = app({
      creerPub: async () => ({ sorte: 'echec_creation', publiciteId: 'pub-1', campagneId: 'c-1', raison: 'x' }),
    });
    await incomplete.srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() });
    expect(incomplete.traces.audit).toEqual(['pubs.creee']);
  });

  it('⚠️ une création ANNULÉE n’est PAS journalisée : rien n’a existé', async () => {
    const { srv, traces } = app({ creerPub: async () => ({ sorte: 'annulee', raison: 'refus' }) });
    await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() });
    expect(traces.audit).toEqual([]);
  });
});

describe('POST /pubs/:id/publier', () => {
  it('publie, et le journal en garde la trace', async () => {
    const { srv, traces } = app({ publierPub: async () => {} });
    const res = await srv.inject({ method: 'POST', url: urlPubs('/pub-1/publier') });
    expect(res.statusCode).toBe(200);
    // 🔴 DEUX LIGNES DISTINCTES au journal, et la publication est celle qui compte : créer ne dépense rien,
    // publier engage le budget. Les fondre rendrait impossible de dire QUI a décidé que ça dépenserait.
    expect(traces.audit).toEqual(['pubs.publiee']);
  });

  it('🔴 réservée aux ADMINS : c’est le geste qui fait dépenser', async () => {
    const { srv } = app({ publierPub: async () => {} }, 'member');
    expect((await srv.inject({ method: 'POST', url: urlPubs('/pub-1/publier') })).statusCode).toBe(403);
  });

  it('🔴 Meta refuse : 502, et RIEN n’est journalisé comme publié', async () => {
    const { srv, traces } = app({ publierPub: async () => { throw new Error('compte suspendu'); } });
    const res = await srv.inject({ method: 'POST', url: urlPubs('/pub-1/publier') });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('compte suspendu');
    expect(traces.audit).toEqual([]);
  });

  it('🔴 un espace ne publie pas chez un autre', async () => {
    const { srv } = app({ publierPub: async () => {} });
    expect((await srv.inject({ method: 'POST', url: '/tenants/t-voisin/pubs/pub-1/publier' })).statusCode).toBe(403);
  });
});

describe('GET /pubs/:id : la page d’une publicité', () => {
  const vue = {
    publicite: { id: 'pub-1', nom: 'Rentrée' } as never,
    entonnoir: {
      depense: 100,
      clics: { nombre: 200, cout: 0.5, passage: null },
      leads: { nombre: 50, cout: 2, passage: 0.25 },
      qualifies: { nombre: 10, cout: 10, passage: 0.2 },
      nonPrisEnCharge: 3,
    },
  };

  it('rend la publicité et son entonnoir', async () => {
    const { srv } = app({ lirePub: async () => vue });
    const res = await srv.inject({ method: 'GET', url: urlPubs('/pub-1') });
    expect(res.statusCode).toBe(200);
    expect(res.json().entonnoir.leads.cout).toBe(2);
  });

  it('une publicité inconnue rend 404', async () => {
    const { srv } = app({ lirePub: async () => null });
    expect((await srv.inject({ method: 'GET', url: urlPubs('/inconnue') })).statusCode).toBe(404);
  });

  it('🔴 un espace ne lit pas la publicité d’un autre', async () => {
    const { srv } = app({ lirePub: async () => vue });
    expect((await srv.inject({ method: 'GET', url: '/tenants/t-voisin/pubs/pub-1' })).statusCode).toBe(403);
  });
});

describe('la pause et la reprise', () => {
  it('mettent en pause, puis relancent, et chaque geste est journalisé à part', async () => {
    const gestes: boolean[] = [];
    const { srv, traces } = app({ basculerPub: async (_t, _id, actif) => { gestes.push(actif); } });
    expect((await srv.inject({ method: 'POST', url: urlPubs('/pub-1/pause') })).statusCode).toBe(200);
    expect((await srv.inject({ method: 'POST', url: urlPubs('/pub-1/reprendre') })).statusCode).toBe(200);
    expect(gestes).toEqual([false, true]);
    // 🔴 DEUX ACTIONS DISTINCTES au journal : « pourquoi ma campagne s'est arrêtée » se date sur la pause,
    // et une action unique « bascule » obligerait à lire un détail pour savoir dans quel sens.
    expect(traces.audit).toEqual(['pubs.pausee', 'pubs.reprise']);
  });

  it('🔴 réservées aux ADMINS', async () => {
    const { srv } = app({ basculerPub: async () => {} }, 'member');
    expect((await srv.inject({ method: 'POST', url: urlPubs('/pub-1/pause') })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'POST', url: urlPubs('/pub-1/reprendre') })).statusCode).toBe(403);
  });

  it('🔴 un espace ne met pas en pause la publicité d’un autre', async () => {
    const { srv } = app({ basculerPub: async () => {} });
    expect((await srv.inject({ method: 'POST', url: '/tenants/t-voisin/pubs/pub-1/pause' })).statusCode).toBe(403);
  });

  it('Meta refuse : 502 avec son message, et rien au journal', async () => {
    const { srv, traces } = app({ basculerPub: async () => { throw new Error('campagne supprimée'); } });
    const res = await srv.inject({ method: 'POST', url: urlPubs('/pub-1/pause') });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('campagne supprimée');
    expect(traces.audit).toEqual([]);
  });

  it('un espace déconnecté rend 409 : on ne peut plus piloter cette campagne depuis ici', async () => {
    const { srv } = app({ basculerPub: async () => { throw new PasDeConnexionPub(); } });
    const res = await srv.inject({ method: 'POST', url: urlPubs('/pub-1/pause') });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('pas_connecte');
  });
});

describe('GET /pubs : la liste', () => {
  it('rend les publicités de l’espace', async () => {
    const { srv } = app({ publicites: { lister: async () => [] } });
    const res = await srv.inject({ method: 'GET', url: urlPubs() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicites: [] });
  });

  it('🔴 un espace ne lit pas les publicités d’un autre', async () => {
    const { srv } = app({ publicites: { lister: async () => [] } });
    expect((await srv.inject({ method: 'GET', url: '/tenants/t-voisin/pubs' })).statusCode).toBe(403);
  });
});

describe('🔴 LE TYPE DU VISUEL SE LIT DANS LES OCTETS', () => {
  it('un fichier qui n’est ni JPEG ni PNG est refusé, quel que soit le `type` déclaré', async () => {
    // C'est tout l'intérêt : le champ `type` est choisi par le navigateur. Le valider contre une
    // énumération ne prouve rien sur ce qui part réellement chez Meta, sous l'identité du client.
    let appele = false;
    const { srv } = app({ creerPub: async () => { appele = true; return creee; } });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
    const res = await srv.inject({
      method: 'POST', url: urlPubs(),
      payload: corpsValide({ image: { type: 'image/png', base64: svg } }),
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toContain('JPEG');
    expect(appele).toBe(false);
  });

  it('un vrai PNG passe', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64');
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({
      method: 'POST', url: urlPubs(),
      payload: corpsValide({ image: { type: 'image/png', base64: png } }),
    });
    expect(res.statusCode).toBe(200);
  });
});

/**
 * LA VIDÉO ET LES AUDIENCES DANS LE CORPS DE LA CRÉATION (migration 0187).
 *
 * 🔴 Un visuel, et un seul : une image (ses octets) OU une vidéo (déjà déposée chez Meta). « Les deux » laisserait
 * la route choisir à la place du client ; « aucun » ferait une créa sans visuel.
 */
describe('POST /pubs : la vidéo et les audiences', () => {
  const sansImage = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const c = corpsValide(over);
    delete c.image;
    return c;
  };

  it('une vidéo passe, et la demande porte son identifiant, pas d’octets', async () => {
    let visuel: unknown = null;
    const { srv } = app({ creerPub: async (_t, d) => { visuel = d.visuel; return creee; } });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: sansImage({ video: { id: '1234567890' } }) });
    expect(res.statusCode).toBe(200);
    expect(visuel).toEqual({ sorte: 'video', videoId: '1234567890' });
  });

  it('🔴 une image ET une vidéo : refusé', async () => {
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide({ video: { id: '123' } }) });
    expect(res.statusCode).toBe(400);
  });

  it('🔴 ni image ni vidéo : refusé', async () => {
    const { srv } = app({ creerPub: async () => creee });
    expect((await srv.inject({ method: 'POST', url: urlPubs(), payload: sansImage() })).statusCode).toBe(400);
  });

  it('🔴 un identifiant de vidéo qui n’est pas un identifiant Meta est refusé', async () => {
    // Il part dans une adresse chez Meta : une forme libre y porterait un chemin de plus.
    const { srv } = app({ creerPub: async () => creee });
    for (const id of ['../me', '12a', '']) {
      const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: sansImage({ video: { id } }) });
      expect(res.statusCode, `id ${id}`).toBe(400);
    }
  });

  it('les audiences passent jusqu’à la demande, incluses et exclues', async () => {
    let f: { audiencesIncluses: string[]; audiencesExclues: string[] } | null = null;
    const { srv } = app({ creerPub: async (_t, d) => { f = d.formulaire; return creee; } });
    const res = await srv.inject({
      method: 'POST', url: urlPubs(), payload: corpsValide({ audiencesIncluses: ['111'], audiencesExclues: ['222'] }),
    });
    expect(res.statusCode).toBe(200);
    expect(f).toMatchObject({ audiencesIncluses: ['111'], audiencesExclues: ['222'] });
  });

  it('⚠️ sans audience (l’écran d’avant ne les envoie pas), deux listes vides', async () => {
    let f: { audiencesIncluses: string[]; audiencesExclues: string[] } | null = null;
    const { srv } = app({ creerPub: async (_t, d) => { f = d.formulaire; return creee; } });
    await srv.inject({ method: 'POST', url: urlPubs(), payload: corpsValide() });
    expect(f).toMatchObject({ audiencesIncluses: [], audiencesExclues: [] });
  });

  it('🔴 une audience à la fois incluse et exclue est refusée', async () => {
    const { srv } = app({ creerPub: async () => creee });
    const res = await srv.inject({
      method: 'POST', url: urlPubs(), payload: corpsValide({ audiencesIncluses: ['111'], audiencesExclues: ['111'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('🔴 une précondition refusée (vidéo pas prête) sort en 409 avec son code : Cloudflare avalerait un 5xx', async () => {
    const { srv, traces } = app({
      creerPub: async () => ({ sorte: 'refusee', code: 'video_pas_prete', raison: 'la vidéo est encore en traitement chez Meta' }),
    });
    const res = await srv.inject({ method: 'POST', url: urlPubs(), payload: sansImage({ video: { id: '123' } }) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'video_pas_prete' });
    // Rien n'a existé chez Meta : rien au journal, comme une création annulée.
    expect(traces.audit).toEqual([]);
  });
});

describe('publier : un REFUS n’est pas une panne de Meta', () => {
  it('🔴 rend 409, pas 502 : Meta n’a même pas été appelé', async () => {
    const { srv, traces } = app({
      publierPub: async () => { throw new PublicationRefusee('cette publicité n’est pas prête à être publiée'); },
    });
    const res = await srv.inject({ method: 'POST', url: urlPubs('/pub-1/publier') });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('publication_refusee');
    expect(traces.audit).toEqual([]);
  });
});
