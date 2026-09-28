import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerPubs, type PubsRouteDeps } from '../src/http/pubs';
import { monterAvecEtapeEspace } from '../src/http/scope';
import type { ConnexionPub } from '../src/pubs/connexion.pg';
import type { ActifsAccordes } from '../src/meta/pubs';
import type { ChampsBrouillon } from '../src/pubs/brouillons.pg';
import { aucunePubDeRoute } from './pubs-fixtures';

/**
 * LES ROUTES DE BROUILLON DE PUBLICITÉ (migration 0171).
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT EST L'INVERSE DE CE QUE DÉFENDENT CEUX DE LA CRÉATION. Là-bas, la route
 * engage l'argent du client chez Meta et chaque refus protège ; ici, la route ne touche à rien, et ce qui
 * protège est qu'elle ACCEPTE un formulaire incomplet. Un brouillon qu'on ne peut pas enregistrer tant
 * qu'il n'est pas valide ne sert à rien : c'est exactement le travail en cours qu'on veut garder.
 *
 * 🔴 ET LE CAS QUI COMPTE LE PLUS EST CELUI DU VISUEL ABSENT DU CORPS. L'écran renvoie le formulaire entier
 * à chaque enregistrement mais ne relit pas les octets déjà en base : si une clé `image` absente était
 * traitée comme « efface », chaque correction de texte effacerait l'image, c'est-à-dire précisément ce que
 * la décision de garder le visuel voulait éviter.
 */

const TENANT = 't-1';

const etatChoisi: ConnexionPub = {
  comptePubId: '111', compteNom: 'GMC', pageId: 'p1', pageNom: 'Page', devise: 'EUR', fuseau: 'Europe/Paris',
  pageLiee: 'oui', connectePar: null, connecteLe: new Date('2026-09-23T08:00:00Z'), jetonRejeteLe: null,
};
const accordes: ActifsAccordes = { comptesPub: [], pages: [] };

/** Les brouillons se surchargent membre par membre. */
type Surcharges = Partial<Omit<PubsRouteDeps, 'brouillons'>> & { brouillons?: Partial<PubsRouteDeps['brouillons']> };

function app(over: Surcharges = {}, role = 'admin'): FastifyInstance {
  const { brouillons: surBrouillons, ...reste } = over;
  const deps: PubsRouteDeps = {
    ...aucunePubDeRoute,
    configId: 'cfg-pub', appId: 'app-1', graphVersion: 'v23.0',
    connexions: {
      lire: async () => etatChoisi,
    },
    etatCompte: async () => ({ statut: 1, raisonDesactivation: 0, moyenPaiement: true }),
    connecter: async () => accordes,
    actifsAccordes: async () => accordes,
    choisir: async () => etatChoisi,
    deconnecter: async () => ({ revoqueChezMeta: true }),
    audit: async () => {},
    ...reste,
    brouillons: { ...aucunePubDeRoute.brouillons, ...surBrouillons },
  };
  const srv = Fastify();
  const garde = async (req: { auth?: { tenantId: string; userId: string; role: string } }): Promise<void> => {
    req.auth = { tenantId: TENANT, userId: 'u-1', role };
  };
  monterAvecEtapeEspace(srv, () => registerPubs(srv, deps, garde as never, async () => {}));
  return srv;
}

const url = (suite = ''): string => `/tenants/${TENANT}/pubs/brouillons${suite}`;

/** Un PNG 1x1 VALIDE. La garde lit la signature des octets, donc un faux base64 ne passe plus. */
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('un brouillon s’enregistre INCOMPLET, c’est sa raison d’être', () => {
  it('un corps entièrement vide est accepté', async () => {
    let recu: ChampsBrouillon | null = null;
    const srv = app({ brouillons: { creer: async (_t, c) => { recu = c; return 'b-1'; } } });
    const r = await srv.inject({ method: 'POST', url: url(), payload: {} });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: 'b-1' });
    // Les défauts sont POSÉS, pas laissés indéfinis : le store écrit des colonnes `not null`.
    expect(recu).toMatchObject({ nom: '', titre: '', budgetTotal: '', destination: 'scenario', workflowId: null });
  });

  it('un budget et des dates NON valides passent : ce sont des chaînes, pas des nombres', async () => {
    // 🔴 C'est le cœur du choix. `corpsCreation` exige `z.number().positive()` et une date ; l'exiger ici
    // refuserait « je reviendrai mettre le budget », qui est le brouillon le plus courant.
    let recu: ChampsBrouillon | null = null;
    const srv = app({ brouillons: { creer: async (_t, c) => { recu = c; return 'b-1'; } } });
    const r = await srv.inject({ method: 'POST', url: url(), payload: { budgetTotal: '12,', debut: 'pas une date' } });
    expect(r.statusCode).toBe(201);
    expect(recu).toMatchObject({ budgetTotal: '12,', debut: 'pas une date' });
  });
});

describe('ce qui reste borné, parce que ce sont des frontières et pas de l’hygiène', () => {
  it('une destination inconnue est refusée', async () => {
    const srv = app();
    const r = await srv.inject({ method: 'POST', url: url(), payload: { destination: 'courrier' } });
    expect(r.statusCode).toBe(400);
  });

  it('une clé inconnue est refusée (le schéma est strict)', async () => {
    const srv = app();
    const r = await srv.inject({ method: 'POST', url: url(), payload: { surprise: 'oui' } });
    expect(r.statusCode).toBe(400);
  });

  it('un identifiant de scénario qui n’est pas un uuid est refusé', async () => {
    const srv = app();
    const r = await srv.inject({ method: 'POST', url: url(), payload: { workflowId: 'wf-1' } });
    expect(r.statusCode).toBe(400);
  });

  it('un type de visuel hors JPEG/PNG est refusé', async () => {
    const srv = app();
    const r = await srv.inject({ method: 'POST', url: url(), payload: { image: { type: 'image/gif', base64: 'AAA' } } });
    expect(r.statusCode).toBe(400);
  });
});

describe('🔴 le visuel a TROIS états, et il en faut trois', () => {
  const capture = (): { recu: () => ChampsBrouillon | null; deps: Surcharges } => {
    let vu: ChampsBrouillon | null = null;
    return {
      recu: () => vu,
      deps: { brouillons: { mettreAJour: async (_t, _id, c) => { vu = c; return true; } } },
    };
  };

  it('clé ABSENTE = ne touche pas au visuel enregistré', async () => {
    // 🔴 LE CAS QUI PROTÈGE L'IMAGE. Sans lui, corriger une faute de frappe effacerait le visuel.
    const c = capture();
    const srv = app(c.deps);
    const r = await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { nom: 'Rentrée' } });
    expect(r.statusCode).toBe(204);
    expect(c.recu()).not.toHaveProperty('visuel');
  });

  it('clé à null = efface le visuel', async () => {
    const c = capture();
    const srv = app(c.deps);
    const r = await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { image: null } });
    expect(r.statusCode).toBe(204);
    expect(c.recu()).toMatchObject({ visuel: null });
  });

  it('clé avec un objet = remplace le visuel', async () => {
    const c = capture();
    const srv = app(c.deps);
    const r = await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { image: { type: 'image/png', base64: PNG_1x1 } } });
    expect(r.statusCode).toBe(204);
    expect(c.recu()).toMatchObject({ visuel: { type: 'image/png', base64: PNG_1x1 } });
  });
});

/**
 * LA VIDÉO ET LES AUDIENCES D'UN BROUILLON (migration 0187).
 *
 * 🔴 La vidéo n'entre JAMAIS en base : seul son identifiant chez Meta voyage. Et un écran d'avant 0187, qui
 * n'envoie ni vidéo ni audiences, ne doit rien effacer en enregistrant : les clés absentes veulent dire « ne pas
 * toucher », comme pour l'image.
 */
describe('la vidéo et les audiences d’un brouillon', () => {
  const capture = (): { recu: () => ChampsBrouillon | null; deps: Surcharges } => {
    let vu: ChampsBrouillon | null = null;
    return {
      recu: () => vu,
      deps: { brouillons: {
        mettreAJour: async (_t, _id, c) => { vu = c; return true; },
        creer: async (_t, c) => { vu = c; return 'b-1'; },
      } },
    };
  };

  it('aller : l’identifiant de la vidéo et les deux listes arrivent au store, tels quels', async () => {
    const c = capture();
    const srv = app(c.deps);
    const r = await srv.inject({
      method: 'POST', url: url(),
      payload: { video: { id: '1234567890' }, audiencesIncluses: ['111', '222'], audiencesExclues: ['333'] },
    });
    expect(r.statusCode).toBe(201);
    expect(c.recu()).toMatchObject({
      video: { id: '1234567890' }, audiencesIncluses: ['111', '222'], audiencesExclues: ['333'],
    });
  });

  it('retour : la lecture rend ce que le store a gardé', async () => {
    const lu = {
      id: 'b-1', nom: '', titre: '', texte: '', accueil: '', messagePreRempli: '', budgetTotal: '', debut: '', fin: '',
      pays: '', ageMin: '', ageMax: '', tagQualification: '', destination: 'scenario' as const, workflowId: null,
      aUnVisuel: false, videoId: '1234567890', audiencesIncluses: ['111'], audiencesExclues: ['333'],
      bouton: 'GET_QUOTE' as const,
      creeLe: '2026-09-28T08:00:00.000Z', modifieLe: '2026-09-28T08:00:00.000Z', visuel: null,
    };
    const srv = app({ brouillons: { lire: async () => lu } });
    const r = await srv.inject({ method: 'GET', url: url('/b-1') });
    expect(r.statusCode).toBe(200);
    expect(r.json().brouillon).toMatchObject({
      videoId: '1234567890', audiencesIncluses: ['111'], audiencesExclues: ['333'], bouton: 'GET_QUOTE',
    });
  });

  it('🔴 un écran d’avant 0187 (ni vidéo ni audiences dans le corps) ne touche à rien', async () => {
    const c = capture();
    const srv = app(c.deps);
    await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { nom: 'Rentrée' } });
    expect(c.recu()).not.toHaveProperty('video');
    expect(c.recu()).not.toHaveProperty('audiencesIncluses');
    expect(c.recu()).not.toHaveProperty('audiencesExclues');
  });

  it('`video: null` efface la vidéo', async () => {
    const c = capture();
    const srv = app(c.deps);
    expect((await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { video: null } })).statusCode).toBe(204);
    expect(c.recu()).toMatchObject({ video: null });
  });

  it('🔴 une image ET une vidéo dans le même corps : refusé, un brouillon porte un seul visuel', async () => {
    const srv = app({ brouillons: { creer: async () => 'b-1', mettreAJour: async () => true } });
    const payload = { image: { type: 'image/png', base64: PNG_1x1 }, video: { id: '123' } };
    expect((await srv.inject({ method: 'POST', url: url(), payload })).statusCode).toBe(400);
    expect((await srv.inject({ method: 'PUT', url: url('/b-1'), payload })).statusCode).toBe(400);
  });

  it('🔴 une audience incluse et exclue, ou un identifiant qui n’en est pas un : refusé', async () => {
    const srv = app({ brouillons: { creer: async () => 'b-1' } });
    for (const payload of [
      { audiencesIncluses: ['111'], audiencesExclues: ['111'] },
      { audiencesIncluses: ['abc'] },
      { video: { id: '../me' } },
    ]) {
      expect((await srv.inject({ method: 'POST', url: url(), payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

/**
 * LE BOUTON D'UN BROUILLON (migration 0188) : la même liste fermée qu'à la création, et deux sens seulement.
 * Absent = ne pas toucher (l'écran ne l'envoie que s'il a changé) ; une valeur = la remplacer. Pas d'effacement :
 * un bouton se remplace, il ne se retire pas.
 */
describe('le bouton d’un brouillon', () => {
  const capture = (): { recu: () => ChampsBrouillon | null; deps: Surcharges } => {
    let vu: ChampsBrouillon | null = null;
    return {
      recu: () => vu,
      deps: { brouillons: {
        mettreAJour: async (_t, _id, c) => { vu = c; return true; },
        creer: async (_t, c) => { vu = c; return 'b-1'; },
      } },
    };
  };

  it('un bouton de la liste arrive au store, sur les deux écritures', async () => {
    for (const [method, adresse, attendu] of [['POST', url(), 201], ['PUT', url('/b-1'), 204]] as const) {
      const c = capture();
      const r = await app(c.deps).inject({ method, url: adresse, payload: { bouton: 'BOOK_NOW' } });
      expect(r.statusCode, method).toBe(attendu);
      expect(c.recu(), method).toMatchObject({ bouton: 'BOOK_NOW' });
    }
  });

  it('🔴 absent : le store n’en reçoit rien, donc ne touche pas à celui qu’il garde', async () => {
    const c = capture();
    await app(c.deps).inject({ method: 'PUT', url: url('/b-1'), payload: { nom: 'Rentrée' } });
    expect(c.recu()).not.toHaveProperty('bouton');
  });

  it('🔴 un type hors de la liste, ou `null`, est refusé sur les deux écritures', async () => {
    const srv = app({ brouillons: { creer: async () => 'b-1', mettreAJour: async () => true } });
    for (const bouton of ['CALL_NOW', null, 'book_now']) {
      expect((await srv.inject({ method: 'POST', url: url(), payload: { bouton } })).statusCode, String(bouton)).toBe(400);
      expect((await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { bouton } })).statusCode, String(bouton)).toBe(400);
    }
  });
});

/**
 * 🔴 LE VISUEL D'UN BROUILLON SE LIT DANS SES OCTETS, comme à la création.
 *
 * Ces cas existent parce que la première version ne les tenait pas : elle bornait la LONGUEUR de la
 * chaîne base64, c'est-à-dire une taille ENCODÉE, sur un type seulement DÉCLARÉ par le navigateur. La
 * relecture à froid l'a relevé, et le plan le posait pourtant comme l'une des deux gardes du stockage.
 *
 * ⚠️ ET LE PREMIER À TOMBER A ÉTÉ UN TEST À MOI : son fixture envoyait `QUJD`, c'est-à-dire « ABC ».
 * Une garde qui mord sur un faux visuel dès sa pose est une garde qui sert.
 */
describe('🔴 les octets du visuel se lisent, ils ne se croient pas sur parole', () => {
  it('des octets qui ne sont ni JPEG ni PNG sont refusés, quel que soit le type annoncé', async () => {
    const srv = app();
    const r = await srv.inject({ method: 'POST', url: url(), payload: { image: { type: 'image/png', base64: 'QUJD' } } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/JPEG ou PNG/);
  });

  it('un visuel vide est refusé', async () => {
    const srv = app();
    const r = await srv.inject({ method: 'POST', url: url(), payload: { image: { type: 'image/png', base64: '====' } } });
    expect(r.statusCode).toBe(400);
  });

  it('⚠️ la MISE À JOUR les lit aussi : la garde ne vaut que si elle est sur les DEUX écritures', async () => {
    // C'est exactement l'asymétrie qui vient d'être corrigée, déplacée d'un cran : une garde posée sur la
    // création et pas sur la modification laisserait le même trou, atteignable en deux appels.
    const srv = app({ brouillons: { mettreAJour: async () => true } });
    const r = await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { image: { type: 'image/jpeg', base64: 'QUJD' } } });
    expect(r.statusCode).toBe(400);
  });

  it('un vrai PNG passe, sur les deux écritures', async () => {
    // L'ancre positive : sans elle, les trois cas ci-dessus resteraient verts si TOUT était refusé.
    const srv = app({ brouillons: { creer: async () => 'b-1', mettreAJour: async () => true } });
    const cree = await srv.inject({ method: 'POST', url: url(), payload: { image: { type: 'image/png', base64: PNG_1x1 } } });
    expect(cree.statusCode).toBe(201);
    const maj = await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { image: { type: 'image/png', base64: PNG_1x1 } } });
    expect(maj.statusCode).toBe(204);
  });
});

describe('les brouillons d’un autre espace, et ceux qui n’existent pas', () => {
  it('lire, modifier ou supprimer un brouillon inconnu rend 404', async () => {
    const srv = app({
      brouillons: {
        lire: async () => null,
        mettreAJour: async () => false,
        supprimer: async () => false,
      },
    });
    expect((await srv.inject({ method: 'GET', url: url('/b-inconnu') })).statusCode).toBe(404);
    expect((await srv.inject({ method: 'PUT', url: url('/b-inconnu'), payload: {} })).statusCode).toBe(404);
    expect((await srv.inject({ method: 'DELETE', url: url('/b-inconnu') })).statusCode).toBe(404);
  });

  it('⚠️ le 404 vient du STORE, qui filtre sur l’espace : c’est lui le contrôle d’isolation', async () => {
    // La route ne compare aucun identifiant elle-même, et c'est voulu : `tenant_id = $1` est dans chaque
    // requête du store. Ce test fige l'endroit où le contrôle vit, pour qu'on ne le déplace pas ici.
    const vus: Array<[string, string]> = [];
    const srv = app({ brouillons: { lire: async (t, id) => { vus.push([t, id]); return null; } } });
    await srv.inject({ method: 'GET', url: url('/b-9') });
    expect(vus).toEqual([[TENANT, 'b-9']]);
  });
});

describe('les écritures sont réservées aux admins', () => {
  it('un agent ne peut ni créer, ni modifier, ni supprimer', async () => {
    const srv = app({}, 'agent');
    expect((await srv.inject({ method: 'POST', url: url(), payload: {} })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'PUT', url: url('/b-1'), payload: {} })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'DELETE', url: url('/b-1') })).statusCode).toBe(403);
  });

  it('mais il peut LIRE la liste : elle ne l’expose à rien', async () => {
    const srv = app({ brouillons: { lister: async () => [] } }, 'agent');
    const r = await srv.inject({ method: 'GET', url: url() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ brouillons: [] });
  });
});

describe('🔴 la route des brouillons ne se confond pas avec celle d’UNE publicité', () => {
  it('« brouillons » est un segment statique, il l’emporte sur /pubs/:id', async () => {
    // Sans cette propriété, `GET /pubs/brouillons` tomberait sur la lecture d'une publicité dont
    // l'identifiant serait la chaîne « brouillons », et rendrait 404 sur une liste parfaitement valide.
    const srv = app({
      brouillons: {
        lister: async () => [],
      },
      lirePub: async () => { throw new Error('lirePub ne doit PAS être appelée pour /pubs/brouillons'); },
    });
    const r = await srv.inject({ method: 'GET', url: url() });
    expect(r.statusCode).toBe(200);
  });
});
