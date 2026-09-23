import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { JetonNonEnregistre, PasDeConnexionPub, registerPubs, type PubsRouteDeps } from '../src/http/pubs';
import type { ConnexionPub } from '../src/pubs/connexion.pg';
import type { ActifsAccordes } from '../src/meta/pubs';

/**
 * LES ROUTES DE LA CONNEXION PUBLICITAIRE (lot 2 « Connecter »).
 *
 * Le module est monté À LA MAIN sur un Fastify nu, avec une garde de test qui pose `req.auth` : elle
 * DÉCLARE l'hypothèse (« ce test ne vérifie pas l'authentification »), là où un `undefined` la cacherait.
 * C'est la même raison qui a fait naître `tests/gardes.ts`.
 */

const TENANT = 't-1';

const etatVide: ConnexionPub = {
  comptePubId: null, pageId: null, devise: null, fuseau: null, pageLiee: null,
  connectePar: null, connecteLe: new Date('2026-09-23T08:00:00Z'), jetonRejeteLe: null,
};
const etatChoisi: ConnexionPub = { ...etatVide, comptePubId: '111', pageId: 'p1', devise: 'EUR', fuseau: 'Europe/Paris', pageLiee: 'oui' };
const accordes: ActifsAccordes = { comptesPub: ['111', '222'], pages: ['p1'] };

interface Traces { connecte: string[]; choisi: unknown[]; deconnecte: string[]; audit: string[] }

function app(over: Partial<PubsRouteDeps> = {}, role = 'admin'): { srv: FastifyInstance; traces: Traces } {
  const traces: Traces = { connecte: [], choisi: [], deconnecte: [], audit: [] };
  const deps: PubsRouteDeps = {
    configId: 'cfg-pub',
    appId: 'app-1',
    graphVersion: 'v23.0',
    lire: async () => etatVide,
    connecter: async (_t, code) => { traces.connecte.push(code); return accordes; },
    actifsAccordes: async () => accordes,
    choisir: async (_t, choix) => { traces.choisi.push(choix); return etatChoisi; },
    deconnecter: async (t) => { traces.deconnecte.push(t); return { revoqueChezMeta: true }; },
    audit: async (_tenantId, _acteur, action) => { traces.audit.push(action); },
    ...over,
  };
  const srv = Fastify();
  const garde = async (req: { auth?: { tenantId: string; userId: string; role: string } }): Promise<void> => {
    req.auth = { tenantId: TENANT, userId: 'u-1', role };
  };
  registerPubs(srv, deps, garde as never, async () => {});
  return { srv, traces };
}

const url = (suite = '') => `/tenants/${TENANT}/pubs/connexion${suite}`;

describe('GET : l état de la connexion', () => {
  it('rend de quoi ouvrir la fenêtre Meta, et l état courant', async () => {
    const { srv } = app();
    const res = await srv.inject({ method: 'GET', url: url() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configure: true, configId: 'cfg-pub', appId: 'app-1', graphVersion: 'v23.0' });
  });

  it('⚠️ sans META_ADS_CONFIG_ID, `configure` est false : l écran le DIT au lieu d ouvrir une fenêtre vouée à échouer', async () => {
    const { srv } = app({ configId: '' });
    expect((await srv.inject({ method: 'GET', url: url() })).json().configure).toBe(false);
  });

  it('🔴 un espace ne lit pas la connexion d un autre : 403 sur un tenantId qui n est pas celui de la session', async () => {
    const { srv } = app();
    const res = await srv.inject({ method: 'GET', url: '/tenants/t-voisin/pubs/connexion' });
    expect(res.statusCode).toBe(403);
  });

  it('la lecture reste ouverte à un agent : elle ne change rien', async () => {
    const { srv } = app({}, 'agent');
    expect((await srv.inject({ method: 'GET', url: url() })).statusCode).toBe(200);
  });
});

describe('POST /echange : le code rendu par la fenêtre Meta', () => {
  it('échange le code et rend ce que le jeton accorde', async () => {
    const { srv, traces } = app();
    const res = await srv.inject({ method: 'POST', url: url('/echange'), payload: { code: 'CODE_META' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(accordes);
    expect(traces.connecte).toEqual(['CODE_META']);
    expect(traces.audit).toEqual(['pubs.connectee']);
  });

  it('🔴 réservé aux admins : un agent ne connecte pas un compte publicitaire', async () => {
    const { srv, traces } = app({}, 'agent');
    expect((await srv.inject({ method: 'POST', url: url('/echange'), payload: { code: 'CODE' } })).statusCode).toBe(403);
    expect(traces.connecte).toEqual([]);
  });

  it('503 quand la fonctionnalité est éteinte, et AVANT tout appel à Meta', async () => {
    const { srv, traces } = app({ configId: '' });
    expect((await srv.inject({ method: 'POST', url: url('/echange'), payload: { code: 'CODE' } })).statusCode).toBe(503);
    expect(traces.connecte).toEqual([]);
  });

  it('⚠️ une clé en trop dans le corps est REFUSÉE : le navigateur ne choisit pas ce qu il envoie', async () => {
    const { srv } = app();
    const res = await srv.inject({ method: 'POST', url: url('/echange'), payload: { code: 'CODE', tenantId: 't-voisin' } });
    expect(res.statusCode).toBe(400);
  });

  it('un refus de Meta rend 502 avec SON message, parce que le client seul peut agir sur son compte', async () => {
    const { srv } = app({ connecter: async () => { throw new Error('Graph 400 (#100) : code expiré'); } });
    const res = await srv.inject({ method: 'POST', url: url('/echange'), payload: { code: 'VIEUX' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('code expiré');
  });

  it('🔴 NOTRE panne apres l echange ne s impute pas a Meta, et DIT que le jeton est perdu', async () => {
    // Meta a deja emis un jeton SANS EXPIRATION : le rendre sous « echange refuse par Meta » enverrait
    // l admin reessayer chez Meta, quand sa seule porte est de retirer l application chez lui.
    const { srv } = app({ connecter: async () => { throw new JetonNonEnregistre(new Error('42P01 relation absente')); } });
    const res = await srv.inject({ method: 'POST', url: url('/echange'), payload: { code: 'CODE' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('jeton_non_enregistre');
    expect(res.json().error).toMatch(/paramètres de votre entreprise/);
    // et surtout : le texte de NOTRE erreur ne part pas au client
    expect(res.json().error).not.toContain('42P01');
  });
});

describe('POST /choix : le compte et la Page', () => {
  it('enregistre le choix et rend le nouvel état', async () => {
    const { srv, traces } = app();
    const res = await srv.inject({ method: 'POST', url: url('/choix'), payload: { comptePubId: '111', pageId: 'p1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().connexion).toMatchObject({ comptePubId: '111', devise: 'EUR', pageLiee: 'oui' });
    expect(traces.choisi).toEqual([{ comptePubId: '111', pageId: 'p1' }]);
    expect(traces.audit).toEqual(['pubs.actifs_choisis']);
  });

  it('⚠️ `act_111` et `111` désignent le MÊME compte : la forme préfixée est acceptée et rangée nue', async () => {
    // C'est la forme que le Gestionnaire de publicités affiche. La refuser dirait à un admin que son
    // propre compte n'est pas accordé, ce qui est faux et indébrouillable.
    const { srv, traces } = app();
    const res = await srv.inject({ method: 'POST', url: url('/choix'), payload: { comptePubId: 'act_111', pageId: 'p1' } });
    expect(res.statusCode).toBe(200);
    expect(traces.choisi).toEqual([{ comptePubId: '111', pageId: 'p1' }]);
  });

  it('🔴 un compte publicitaire que le jeton n ACCORDE PAS est refusé, et rien n est enregistré', async () => {
    // Les identifiants viennent du navigateur : sans ce contrôle, un admin enregistrerait le compte d une
    // autre entreprise, que nos appels utiliseraient ensuite en son nom.
    const { srv, traces } = app();
    const res = await srv.inject({ method: 'POST', url: url('/choix'), payload: { comptePubId: '999', pageId: 'p1' } });
    expect(res.statusCode).toBe(400);
    expect(traces.choisi).toEqual([]);
    expect(traces.audit).toEqual([]);
  });

  it('🔴 une Page que le jeton n ACCORDE PAS est refusée de la même façon', async () => {
    const { srv, traces } = app();
    const res = await srv.inject({ method: 'POST', url: url('/choix'), payload: { comptePubId: '111', pageId: 'p-voisine' } });
    expect(res.statusCode).toBe(400);
    expect(traces.choisi).toEqual([]);
  });

  it('🔴 un espace NON CONNECTE rend 409, pas un 502 qui accuserait Meta', async () => {
    const { srv, traces } = app({ actifsAccordes: async () => { throw new PasDeConnexionPub(); } });
    const res = await srv.inject({ method: 'POST', url: url('/choix'), payload: { comptePubId: '111', pageId: 'p1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('pas_connecte');
    expect(traces.choisi).toEqual([]);
  });

  it('⚠️ la liste des actifs est relue CHEZ META, pas en base : un droit retiré côté client referme le choix', async () => {
    const { srv, traces } = app({ actifsAccordes: async () => ({ comptesPub: [], pages: [] }) });
    const res = await srv.inject({ method: 'POST', url: url('/choix'), payload: { comptePubId: '111', pageId: 'p1' } });
    expect(res.statusCode).toBe(400);
    expect(traces.choisi).toEqual([]);
  });

  it('réservé aux admins', async () => {
    const { srv } = app({}, 'manager');
    expect((await srv.inject({ method: 'POST', url: url('/choix'), payload: { comptePubId: '111', pageId: 'p1' } })).statusCode).toBe(403);
  });
});

describe('DELETE : la déconnexion', () => {
  it('déconnecte et journalise', async () => {
    const { srv, traces } = app();
    expect((await srv.inject({ method: 'DELETE', url: url() })).statusCode).toBe(200);
    expect(traces.deconnecte).toEqual([TENANT]);
    expect(traces.audit).toEqual(['pubs.deconnectee']);
  });

  it('🔴 quand Meta n a PAS confirmé le retrait, la réponse le DIT, et le journal le garde', async () => {
    // Le jeton n expire jamais et nous venons d en perdre le seul exemplaire : taire ce cas laisserait
    // le client croire que son compte est detache alors qu un acces vit toujours chez Meta.
    const { srv, traces } = app({ deconnecter: async () => ({ revoqueChezMeta: false }) });
    const res = await srv.inject({ method: 'DELETE', url: url() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, revoqueChezMeta: false });
    expect(traces.audit).toEqual(['pubs.deconnectee']);
  });

  it('🔴 réservé aux admins, et rien n est effacé pour les autres', async () => {
    const { srv, traces } = app({}, 'agent');
    expect((await srv.inject({ method: 'DELETE', url: url() })).statusCode).toBe(403);
    expect(traces.deconnecte).toEqual([]);
  });
});
