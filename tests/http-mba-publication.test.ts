import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { Geste, OutilAPublier, EtatMeta, RelaisAPublier } from '../src/mba/publication';
import { FakeQueue } from './fake-queue';
import { ErreurPublication } from '../src/mba/appliquer-publication';
import { MetaApiError } from '../src/meta/errors';
import { BAIL_PUBLICATION_MS, clePublication } from '../src/http/mba-publication';
import type { VerrousCourts } from '../src/db/verrous-courts';
import { verrousEnMemoire } from './verrous';

/**
 * Publier le catalogue d'outils chez Meta.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, c'est la promesse faite au client : « Messaging Me fait foi, la publication
 * écrase ». Écraser n'est acceptable que si l'on montre QUOI avant de le faire, et si un échec en cours de
 * route se DIT au lieu de laisser un état à moitié publié dont personne ne connaît la forme.
 *
 * ⚠️ DEPUIS LE RELAIS (2026-09-21), ce qui part est un connecteur `EngageMe` par espace. Les cas des outils
 * « écartés » (`nonPubliables`, `OutilNonPubliable`) ont disparu avec eux : plus aucun outil n'arrive creux.
 */
const TENANT = 't1';
const SECRET = 'test-secret';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

let adminTok = '';
let adminTok2 = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: TENANT, role: 'admin' }, SECRET);
  adminTok2 = await signSession({ userId: 'u2', tenantId: 't2', role: 'admin' }, SECRET);
});
/** ⚠️ Une FONCTION : un objet figé au chargement capturerait un jeton encore vide. */
const h = (): { headers: Record<string, string> } => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok}` },
});

const RELAIS: RelaisAPublier = { baseUrl: 'https://api.messagingme.app/mba/relais', cleAJour: true };
const ADD_TAG: OutilAPublier = {
  id: 'o1', name: 'add_tag', description: 'Le client demande à rajouter une étiquette.', nePasUtiliser: '',
  variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true }],
};
const META_VIDE: EtatMeta = { connecteurs: [], outilsParConnecteur: {} };

function monter(opts: {
  numero?: string | null; echoueSur?: Geste['type']; erreur?: Error; relais?: RelaisAPublier | null; retenir?: Promise<void>;
  verrous?: VerrousCourts;
  /** Joué au milieu de chaque geste : ce qu'un test fait « pendant » qu'un appel à Meta dure. */
  pendantGeste?: () => Promise<void>;
} = {}) {
  const appliques: Geste[] = [];
  const contextes: Array<Map<string, unknown>> = [];
  /** Les gestes COMMENCÉS : ce qu'un test attend pour savoir qu'une publication tient son verrou. */
  const entames: Geste[] = [];
  const app = buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    mbaPublication: {
      repo: { getTenantPhoneNumberId: async () => (opts.numero === undefined ? '1234840649713976' : opts.numero) },
      relais: async () => (opts.relais === undefined ? RELAIS : opts.relais),
      outilsExposes: async () => [ADD_TAG],
      etatMeta: async () => META_VIDE,
      appliquer: async (_t, _pn, g, ctx) => {
        entames.push(g);
        if (opts.retenir) await opts.retenir;
        if (opts.pendantGeste) await opts.pendantGeste();
        if (g.type === opts.echoueSur) throw opts.erreur ?? new Error('panne');
        appliques.push(g);
        contextes.push(ctx);
      },
      verrous: opts.verrous ?? verrousEnMemoire(),
    },
  });
  return { app, appliques, contextes, entames };
}

describe('l’aperçu de publication', () => {
  it('rend le plan SANS rien écrire', async () => {
    const { app, appliques } = monter();
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json().gestes.map((g: Geste) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
    expect(appliques).toEqual([]);
  });

  it('sans numéro connecté, l’aperçu est vide plutôt qu’en erreur', async () => {
    // Un espace sans WhatsApp n'a rien à publier : ce n'est pas une panne, et l'écran doit pouvoir
    // s'afficher sans message rouge.
    const { app } = monter({ numero: null });
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gestes: [], phoneNumberId: null });
  });
});

describe('la publication', () => {
  it('applique les gestes DANS L’ORDRE du plan', async () => {
    // L'ordre n'est pas indifférent : un outil ne peut pas être créé avant son connecteur.
    const { app, appliques } = monter();
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(200);
    expect(appliques.map((g) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
  });

  it('🔴 s’ARRÊTE au premier échec, et DIT ce qui a été fait', async () => {
    // Continuer laisserait un état à moitié publié dont personne ne connaît la forme. S'arrêter en le
    // disant permet de rejouer, et la publication étant idempotente, rejouer ne refait pas ce qui a réussi.
    const { app, appliques } = monter({ echoueSur: 'outil_creer' });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Relancez/);
    expect(res.json().faits).toHaveLength(1);
    // ⚠️ Et surtout : le geste SUIVANT n'a pas été tenté.
    expect(appliques.map((g) => g.type)).toEqual(['connecteur_creer']);
  });

  it('🔴 un refus qui vient de NOUS ne se présente pas comme un refus de Meta', async () => {
    const { app } = monter({ echoueSur: 'outil_creer', erreur: new ErreurPublication('le connecteur EngageMe est introuvable chez Meta') });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).not.toMatch(/Meta a refusé/);
    expect(res.json().error).toMatch(/introuvable chez Meta/);
  });

  it('🔴 un échec sort en 409, jamais en 500', async () => {
    // Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur : le message qui dit quoi faire
    // n'arriverait jamais à l'écran.
    const { app } = monter({ echoueSur: 'connecteur_creer' });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
  });

  it('sans numéro connecté, publier REFUSE en le disant', async () => {
    const { app } = monter({ numero: null });
    const res = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Aucun numéro/);
  });

  it('🔴 sans adresse publique réglée, l’aperçu comme la publication REFUSENT en le disant', async () => {
    // Publier poserait chez Meta un connecteur qui n'appelle rien.
    const { app, appliques } = monter({ relais: null });
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({ method, url: `/tenants/${TENANT}/mba-publication`, ...h() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/adresse publique/);
    }
    expect(appliques).toEqual([]);
  });

  it('🔴 sans jeton, les deux routes refusent', async () => {
    const { app } = monter();
    expect((await app.inject({ method: 'GET', url: `/tenants/${TENANT}/mba-publication` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication` })).statusCode).toBe(401);
  });

});

describe('une publication à la fois, et la vraie cause d’un échec', () => {
  it('🔴 deux publications SIMULTANÉES du même espace : la seconde est refusée, rien ne s’entrelace', async () => {
    // Entrelacées, chacune posait sa clé chez Meta puis révoquait « toutes les autres », donc celle de
    // l'autre : Meta présentait une clé révoquée, et les deux POST rendaient 200.
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((r) => { liberer = r; });
    const { app, appliques, entames } = monter({ retenir });
    const premiere = app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    // La première tient son verrou quand son premier geste a commencé ; un délai fixe ne le garantit pas sous charge.
    await vi.waitFor(() => { expect(entames.length).toBeGreaterThan(0); });
    const seconde = await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(seconde.statusCode).toBe(409);
    expect(seconde.json().error).toMatch(/déjà en cours/);
    liberer();
    expect((await premiere).statusCode).toBe(200);
    expect(appliques.map((g) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
    // Le verrou retombe : une publication suivante passe.
    expect((await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() })).statusCode).toBe(200);
  });

  it('🔴 le verrou est PAR ESPACE : un autre espace publie pendant que le premier est retenu', async () => {
    // Un verrou global bloquerait tous les clients derrière la publication d'un seul.
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((r) => { liberer = r; });
    const { app, entames } = monter({ retenir });
    const premiere = app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    await vi.waitFor(() => { expect(entames.length).toBeGreaterThan(0); });
    const autre = app.inject({
      method: 'POST', url: '/tenants/t2/mba-publication',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok2}` },
    });
    // Le second espace passe son verrou et commence son geste pendant que le premier est retenu.
    await vi.waitFor(() => { expect(entames.length).toBe(2); });
    liberer();
    expect((await premiere).statusCode).toBe(200);
    expect((await autre).statusCode).toBe(200);
  });

  it('« Meta a refusé » seulement quand c’est Meta ; une panne de chez nous le dit', async () => {
    const meta = monter({ echoueSur: 'connecteur_creer', erreur: new MetaApiError(400, { message: 'Invalid connector request' }) });
    expect((await meta.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() })).json().error)
      .toMatch(/Meta a refusé/);
    const nous = monter({ echoueSur: 'connecteur_creer', erreur: new Error('connexion à la base perdue') });
    const msg = (await nous.app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() })).json().error;
    expect(msg).not.toMatch(/Meta a refusé/);
    expect(msg).toMatch(/n’a pas abouti/);
  });

  it('🔴 la publication AMORCE les gestes avec les outils du plan et l’administrateur qui publie', async () => {
    const { app, contextes } = monter();
    await app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });
    expect(contextes[0]!.get('outils')).toEqual([ADD_TAG]);
    expect(contextes[0]!.get('acteur')).toBe('u1');
  });
});

/**
 * 🔴 L'API EN PLUSIEURS COPIES. Le verrou vivait dans un `Set` du processus : deux publications servies par deux
 * copies passaient toutes les deux, posaient chacune une clé chez Meta et révoquaient celle de l'autre. Deux
 * « copies » ici, ce sont deux serveurs distincts qui ne partagent que les verrous courts, comme deux copies de l'API
 * ne partagent que la base.
 */
describe('une publication à la fois, sur toutes les copies de l’API', () => {
  const post = (app: ReturnType<typeof monter>['app']) =>
    app.inject({ method: 'POST', url: `/tenants/${TENANT}/mba-publication`, ...h() });

  it('🔴 la seconde publication, servie par l’AUTRE copie, est refusée tant que la première tient', async () => {
    const verrous = verrousEnMemoire();
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((r) => { liberer = r; });
    const copieA = monter({ retenir, verrous });
    const copieB = monter({ verrous });
    const premiere = post(copieA.app);
    // Attendre que la première publie (donc tienne son verrou), pas un délai fixe : sous charge, 20 ms ne
    // suffisent pas.
    await vi.waitFor(() => { expect(copieA.entames.length).toBeGreaterThan(0); });
    const seconde = await post(copieB.app);
    expect(seconde.statusCode).toBe(409);
    expect(seconde.json().error).toMatch(/déjà en cours/);
    expect(copieB.appliques).toEqual([]);
    liberer();
    expect((await premiere).statusCode).toBe(200);
    // Relâché par la première (le relâchement suit la réponse, d'où l'attente) : l'autre copie publie ensuite.
    await vi.waitFor(() => { expect(verrous.tenues()).toEqual([]); });
    expect((await post(copieB.app)).statusCode).toBe(200);
  });

  it('🔴 un échec relâche aussi le verrou : la relance passe, sur n’importe quelle copie', async () => {
    const verrous = verrousEnMemoire();
    const enEchec = monter({ echoueSur: 'outil_creer', verrous });
    expect((await post(enEchec.app)).statusCode).toBe(409);
    await vi.waitFor(() => { expect(verrous.tenues()).toEqual([]); });
    expect((await post(monter({ verrous }).app)).statusCode).toBe(200);
  });

  it('🔴 une publication dont le bail a échu ne relâche PAS le verrou de celle qui l’a repris, et s’ARRÊTE', async () => {
    // Le jeton de garde : sans lui, la première effacerait en finissant le verrou de la seconde, et une troisième
    // publication pourrait partir pendant que la seconde tourne encore. Et depuis la prolongation avant chaque geste
    // (relecture du lot A), la première ne pose plus son geste suivant : elle ne tient plus rien.
    const horloge = { t: 0 };
    const partages = verrousEnMemoire(() => horloge.t);
    // Les relâchements sont comptés : l'assertion porte sur l'état APRÈS celui de la première publication.
    const relaches: string[] = [];
    const verrous: VerrousCourts & { tenues(): string[] } = {
      prendre: (c) => partages.prendre(c),
      relacher: async (p) => { await partages.relacher(p); relaches.push(p.jeton); },
      prolonger: (p, d) => partages.prolonger(p, d),
      tenues: () => partages.tenues(),
    };
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((r) => { liberer = r; });
    const lente = monter({ retenir, verrous });
    const premiere = post(lente.app);
    await vi.waitFor(() => { expect(lente.entames.length).toBeGreaterThan(0); });
    horloge.t = BAIL_PUBLICATION_MS;
    const reprise = await verrous.prendre([[clePublication(TENANT), BAIL_PUBLICATION_MS]]);
    expect(reprise, 'le bail échu se reprend').not.toBeNull();
    liberer();
    const reponse = await premiere;
    expect(reponse.statusCode).toBe(409);
    expect(reponse.json().error).toMatch(/perdu son verrou/);
    // Le geste en cours a fini ; le suivant (`outil_creer`) n'a pas été tenté.
    expect(lente.entames.map((g) => g.type)).toEqual(['connecteur_creer']);
    expect(reponse.json().faits.map((g: Geste) => g.type)).toEqual(['connecteur_creer']);
    await vi.waitFor(() => { expect(relaches).toHaveLength(1); });
    expect(verrous.tenues()).toEqual([clePublication(TENANT)]);
    expect((await post(monter({ verrous }).app)).statusCode).toBe(409);
  });

  it('🔴 le bail est PROLONGÉ avant chaque geste : une publication lente garde son verrou d’un geste à l’autre', async () => {
    // Relecture du lot A : un bail posé une fois échoyait en pleine publication dès que deux appels à Meta pendaient
    // (300 s chacun), et une seconde publication pouvait alors partir. Ici chaque geste dure 90 % d'un bail : sans
    // prolongation, le bail d'origine est échu pendant le second geste, et une autre copie le prendrait.
    const horloge = { t: 0 };
    const verrous = verrousEnMemoire(() => horloge.t);
    const prolongations: string[] = [];
    const espion: VerrousCourts = {
      prendre: (c) => verrous.prendre(c),
      relacher: (p) => verrous.relacher(p),
      prolonger: async (p, d) => { prolongations.push(p.jeton); return verrous.prolonger(p, d); },
    };
    /** Ce qu'obtient une autre copie qui tente de publier pendant chaque geste. */
    const tentativesAutreCopie: boolean[] = [];
    const lente = monter({
      verrous: espion,
      pendantGeste: async () => {
        horloge.t += BAIL_PUBLICATION_MS * 0.9;
        tentativesAutreCopie.push((await verrous.prendre([[clePublication(TENANT), BAIL_PUBLICATION_MS]])) !== null);
      },
    });
    const res = await post(lente.app);
    expect(res.statusCode).toBe(200);
    expect(tentativesAutreCopie, 'aucune autre copie ne prend le verrou pendant la publication').toEqual([false, false]);
    expect(prolongations.length, 'une prolongation par geste').toBe(2);
    expect(new Set(prolongations).size, 'toujours avec le jeton de SA prise').toBe(1);
  });

  it('🔴 un verrou illisible avant un geste arrête la publication (on ne peut plus prouver qu’on est seul)', async () => {
    const verrous = verrousEnMemoire();
    const panne: VerrousCourts = {
      prendre: (c) => verrous.prendre(c),
      relacher: (p) => verrous.relacher(p),
      prolonger: async () => { throw new Error('connexion perdue'); },
    };
    const { app, entames } = monter({ verrous: panne });
    const res = await post(app);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/perdu son verrou/);
    expect(entames).toEqual([]);
    await vi.waitFor(() => { expect(verrous.tenues()).toEqual([]); });
  });

  it('le bail couvre largement une publication ordinaire (moins d’une minute)', () => {
    expect(BAIL_PUBLICATION_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
