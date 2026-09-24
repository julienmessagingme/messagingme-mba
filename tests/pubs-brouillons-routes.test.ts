import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerPubs, type PubsRouteDeps } from '../src/http/pubs';
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

function app(over: Partial<PubsRouteDeps> = {}, role = 'admin'): FastifyInstance {
  const deps: PubsRouteDeps = {
    ...aucunePubDeRoute,
    configId: 'cfg-pub', appId: 'app-1', graphVersion: 'v23.0',
    lire: async () => etatChoisi,
    etatCompte: async () => ({ statut: 1, raisonDesactivation: 0, moyenPaiement: true }),
    connecter: async () => accordes,
    actifsAccordes: async () => accordes,
    choisir: async () => etatChoisi,
    deconnecter: async () => ({ revoqueChezMeta: true }),
    audit: async () => {},
    ...over,
  };
  const srv = Fastify();
  const garde = async (req: { auth?: { tenantId: string; userId: string; role: string } }): Promise<void> => {
    req.auth = { tenantId: TENANT, userId: 'u-1', role };
  };
  registerPubs(srv, deps, garde as never, async () => {});
  return srv;
}

const url = (suite = ''): string => `/tenants/${TENANT}/pubs/brouillons${suite}`;

/** Un PNG 1x1 VALIDE. La garde lit la signature des octets, donc un faux base64 ne passe plus. */
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('un brouillon s’enregistre INCOMPLET, c’est sa raison d’être', () => {
  it('un corps entièrement vide est accepté', async () => {
    let recu: ChampsBrouillon | null = null;
    const srv = app({ creerBrouillon: async (_t, c) => { recu = c; return 'b-1'; } });
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
    const srv = app({ creerBrouillon: async (_t, c) => { recu = c; return 'b-1'; } });
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
  const capture = (): { recu: () => ChampsBrouillon | null; deps: Partial<PubsRouteDeps> } => {
    let vu: ChampsBrouillon | null = null;
    return {
      recu: () => vu,
      deps: { majBrouillon: async (_t, _id, c) => { vu = c; return true; } },
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
    const srv = app({ majBrouillon: async () => true });
    const r = await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { image: { type: 'image/jpeg', base64: 'QUJD' } } });
    expect(r.statusCode).toBe(400);
  });

  it('un vrai PNG passe, sur les deux écritures', async () => {
    // L'ancre positive : sans elle, les trois cas ci-dessus resteraient verts si TOUT était refusé.
    const srv = app({ creerBrouillon: async () => 'b-1', majBrouillon: async () => true });
    const cree = await srv.inject({ method: 'POST', url: url(), payload: { image: { type: 'image/png', base64: PNG_1x1 } } });
    expect(cree.statusCode).toBe(201);
    const maj = await srv.inject({ method: 'PUT', url: url('/b-1'), payload: { image: { type: 'image/png', base64: PNG_1x1 } } });
    expect(maj.statusCode).toBe(204);
  });
});

describe('les brouillons d’un autre espace, et ceux qui n’existent pas', () => {
  it('lire, modifier ou supprimer un brouillon inconnu rend 404', async () => {
    const srv = app({
      lireBrouillon: async () => null,
      majBrouillon: async () => false,
      supprimerBrouillon: async () => false,
    });
    expect((await srv.inject({ method: 'GET', url: url('/b-inconnu') })).statusCode).toBe(404);
    expect((await srv.inject({ method: 'PUT', url: url('/b-inconnu'), payload: {} })).statusCode).toBe(404);
    expect((await srv.inject({ method: 'DELETE', url: url('/b-inconnu') })).statusCode).toBe(404);
  });

  it('⚠️ le 404 vient du STORE, qui filtre sur l’espace : c’est lui le contrôle d’isolation', async () => {
    // La route ne compare aucun identifiant elle-même, et c'est voulu : `tenant_id = $1` est dans chaque
    // requête du store. Ce test fige l'endroit où le contrôle vit, pour qu'on ne le déplace pas ici.
    const vus: Array<[string, string]> = [];
    const srv = app({ lireBrouillon: async (t, id) => { vus.push([t, id]); return null; } });
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
    const srv = app({ listerBrouillons: async () => [] }, 'agent');
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
      listerBrouillons: async () => [],
      lirePub: async () => { throw new Error('lirePub ne doit PAS être appelée pour /pubs/brouillons'); },
    });
    const r = await srv.inject({ method: 'GET', url: url() });
    expect(r.statusCode).toBe(200);
  });
});
