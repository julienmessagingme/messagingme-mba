import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ConnexionPubIncomplete, PasDeConnexionPub, registerPubs, type PubsRouteDeps } from '../src/http/pubs';
import { monterAvecEtapeEspace } from '../src/http/scope';
import { ErreurGraph } from '../src/meta/graph';
import type { ConnexionPub } from '../src/pubs/connexion.pg';
import type { ActifsAccordes } from '../src/meta/pubs';
import { aucunePubDeRoute } from './pubs-fixtures';

/**
 * LES ROUTES DE LA VIDÉO ET DES AUDIENCES D'UNE PUBLICITÉ (migration 0187).
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT : ce qui part chez Meta sous l'identité du client est une vidéo (signature lue dans
 * les octets), de 100 Mo au plus, de 60 secondes au plus quand le fichier le dit, et ses octets TRAVERSENT l'API
 * sans y être tamponnés ni gardés. Les refus se posent AVANT d'appeler Meta : c'est ce qui est asserté, par la liste
 * des appels faits au dépôt.
 *
 * Le module est monté à la main sur un Fastify nu, avec une garde de test qui pose `req.auth`.
 */

const TENANT = 't-1';
const etatChoisi: ConnexionPub = {
  comptePubId: '111', compteNom: 'GMC', pageId: 'p1', pageNom: 'Page', devise: 'EUR', fuseau: 'Europe/Paris',
  pageLiee: 'oui', connectePar: null, connecteLe: new Date('2026-09-23T08:00:00Z'), jetonRejeteLe: null,
};
const accordes: ActifsAccordes = { comptesPub: [], pages: [] };

type Videos = PubsRouteDeps['videos'];
type Surcharges = Partial<Omit<PubsRouteDeps, 'videos'>> & { videos?: Partial<Videos> };

function app(over: Surcharges = {}, role = 'admin'): FastifyInstance {
  const { videos, ...reste } = over;
  const deps: PubsRouteDeps = {
    ...aucunePubDeRoute,
    configId: 'cfg-pub', appId: 'app-1', graphVersion: 'v25.0',
    connexions: { lire: async () => etatChoisi },
    etatCompte: async () => ({ statut: 1, raisonDesactivation: 0, moyenPaiement: true }),
    connecter: async () => accordes,
    actifsAccordes: async () => accordes,
    choisir: async () => etatChoisi,
    deconnecter: async () => ({ revoqueChezMeta: true }),
    audit: async () => {},
    ...reste,
    videos: { ...aucunePubDeRoute.videos, ...videos },
  };
  const srv = Fastify();
  const garde = async (req: { auth?: { tenantId: string; userId: string; role: string } }): Promise<void> => {
    req.auth = { tenantId: TENANT, userId: 'u-1', role };
  };
  monterAvecEtapeEspace(srv, () => registerPubs(srv, deps, garde as never, async () => {}));
  return srv;
}

const url = (suite: string, tenant = TENANT): string => `/tenants/${tenant}/pubs/videos${suite}`;
const MO = 1024 * 1024;

/** Les premiers octets d'un vrai MP4 : une boîte `ftyp`, puis de quoi remplir. */
function mp4(taille: number): Buffer {
  const b = Buffer.alloc(taille, 0x11);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}

/** Un MP4 « fast start » dont `mvhd` dit `secondes` : la durée est lisible dans la tête. */
function mp4AvecDuree(secondes: number): Buffer {
  const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftypisom', 4, 'latin1');
  const mvhd = Buffer.alloc(108); mvhd.writeUInt32BE(108, 0); mvhd.write('mvhd', 4, 'latin1');
  mvhd.writeUInt32BE(1000, 20); mvhd.writeUInt32BE(secondes * 1000, 24);
  const moov = Buffer.alloc(8); moov.writeUInt32BE(8 + 108, 0); moov.write('moov', 4, 'latin1');
  return Buffer.concat([ftyp, moov, mvhd, Buffer.alloc(200, 0x22)]);
}

/** Un faux `transferer` qui VIDE le flux reçu, comme le ferait l'envoi à Meta, et retient ce qu'il a vu. */
function capteur() {
  const recus: Array<{ tenant: string; sessionId: string; debut: number; taille: number; octets: Buffer; pieces: number }> = [];
  const transferer: Videos['transferer'] = async (tenant, m) => {
    const parts: Uint8Array[] = [];
    for await (const p of m.octets) parts.push(p);
    recus.push({ tenant, sessionId: m.sessionId, debut: m.debut, taille: m.taille, octets: Buffer.concat(parts), pieces: parts.length });
    return { debut: m.debut + m.taille, fin: m.debut + m.taille };
  };
  return { recus, transferer };
}

const envoyer = (srv: FastifyInstance, corps: Buffer, debut: number, fin: number, entetes: Record<string, string> = {}) =>
  srv.inject({
    method: 'POST', url: url(`/777/morceaux?debut=${debut}&fin=${fin}`), payload: corps,
    headers: { 'content-type': 'application/octet-stream', ...entetes },
  });

describe('ouvrir le dépôt d’une vidéo', () => {
  it('rend la session et le premier morceau que Meta attend', async () => {
    const tailles: number[] = [];
    const srv = app({ videos: { demarrer: async (_t, taille) => { tailles.push(taille); return { videoId: '888', sessionId: '777', debut: 0, fin: MO }; } } });
    const r = await srv.inject({ method: 'POST', url: url(''), payload: { taille: 5 * MO } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ videoId: '888', sessionId: '777', debut: 0, fin: MO });
    expect(tailles).toEqual([5 * MO]);
  });

  it('🔴 au-delà de 100 Mo : refusé AVANT Meta, avec un code', async () => {
    let appele = false;
    const srv = app({ videos: { demarrer: async () => { appele = true; return { videoId: '1', sessionId: '1', debut: 0, fin: 1 }; } } });
    const r = await srv.inject({ method: 'POST', url: url(''), payload: { taille: 100 * MO + 1 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('video_trop_lourde');
    expect(appele).toBe(false);
    // L'ancre : exactement 100 Mo passe.
    expect((await srv.inject({ method: 'POST', url: url(''), payload: { taille: 100 * MO } })).statusCode).toBe(200);
  });

  it('une taille absente, nulle ou décimale est refusée', async () => {
    const srv = app();
    for (const payload of [{}, { taille: 0 }, { taille: 1.5 }, { taille: '10' }]) {
      expect((await srv.inject({ method: 'POST', url: url(''), payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('🔴 réservé aux admins, et à SON espace', async () => {
    expect((await app({}, 'agent').inject({ method: 'POST', url: url(''), payload: { taille: 10 } })).statusCode).toBe(403);
    expect((await app().inject({ method: 'POST', url: url('', 't-voisin'), payload: { taille: 10 } })).statusCode).toBe(403);
  });

  it('pas connecté ou connexion incomplète : 409, pas une panne', async () => {
    for (const err of [new PasDeConnexionPub(), new ConnexionPubIncomplete()]) {
      const srv = app({ videos: { demarrer: async () => { throw err; } } });
      expect((await srv.inject({ method: 'POST', url: url(''), payload: { taille: 10 } })).statusCode).toBe(409);
    }
  });

  it('🔴 un REFUS de Meta sort en 422 avec son message : un 5xx serait remplacé par Cloudflare', async () => {
    const srv = app({ videos: { demarrer: async () => { throw new ErreurGraph(400, 352, 'Graph 400 (#352) : format'); } } });
    const r = await srv.inject({ method: 'POST', url: url(''), payload: { taille: 10 } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: 'Graph 400 (#352) : format', code: 'refus_meta' });
  });
});

describe('envoyer un morceau : les octets TRAVERSENT, sans être tamponnés', () => {
  it('le premier morceau d’un MP4 passe, et Meta reçoit exactement ses octets', async () => {
    const c = capteur();
    const srv = app({ videos: { transferer: c.transferer } });
    const corps = mp4(4096);
    const r = await envoyer(srv, corps, 0, 4096);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ debut: 4096, fin: 4096 });
    expect(c.recus).toHaveLength(1);
    expect(c.recus[0]).toMatchObject({ tenant: TENANT, sessionId: '777', debut: 0, taille: 4096 });
    expect(c.recus[0]?.octets.equals(corps)).toBe(true);
  });

  it('🔴 un morceau de 3 Mo passe : Fastify ne le lit pas (sa limite de corps est de 1 Mo), la route le relaie', async () => {
    // Si le parseur lisait le corps, il le ferait AVANT la garde, avec la limite du serveur : ce morceau serait
    // refusé en 413, ou tamponné entier pour un appelant sans session.
    const c = capteur();
    const srv = app({ videos: { transferer: c.transferer } });
    const corps = mp4(3 * MO);
    const r = await envoyer(srv, corps, 0, 3 * MO);
    expect(r.statusCode).toBe(200);
    expect(c.recus[0]?.octets.equals(corps)).toBe(true);
  });

  it('🔴 un fichier qui n’est pas un MP4 ou un MOV est refusé AVANT Meta, quel que soit ce qu’annonce le navigateur', async () => {
    const c = capteur();
    const srv = app({ videos: { transferer: c.transferer } });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500)]);
    const r = await envoyer(srv, jpeg, 0, jpeg.length);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('video_format');
    expect(c.recus).toEqual([]);
  });

  it('⚠️ un morceau du MILIEU n’a pas de signature, et passe', async () => {
    const c = capteur();
    const srv = app({ videos: { transferer: c.transferer } });
    const r = await envoyer(srv, Buffer.alloc(1000, 0x33), MO, MO + 1000);
    expect(r.statusCode).toBe(200);
    expect(c.recus[0]?.debut).toBe(MO);
  });

  it('🔴 un morceau qui finirait au-delà de 100 Mo est refusé, sans lire le corps', async () => {
    const c = capteur();
    const srv = app({ videos: { transferer: c.transferer } });
    const r = await envoyer(srv, Buffer.alloc(10), 100 * MO - 5, 100 * MO + 5);
    expect(r.statusCode).toBe(413);
    expect(c.recus).toEqual([]);
  });

  it('🔴 une vidéo de 90 secondes, quand la tête le dit : refusée AVANT Meta', async () => {
    const c = capteur();
    const srv = app({ videos: { transferer: c.transferer } });
    const longue = mp4AvecDuree(90);
    const r = await envoyer(srv, longue, 0, longue.length);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('video_trop_longue');
    expect(c.recus).toEqual([]);
    // L'ancre : la même vidéo à 45 secondes passe.
    const courte = mp4AvecDuree(45);
    expect((await envoyer(srv, courte, 0, courte.length)).statusCode).toBe(200);
  });

  it('un corps qui ne fait pas la taille du morceau est refusé avant Meta', async () => {
    const c = capteur();
    const srv = app({ videos: { transferer: c.transferer } });
    const r = await envoyer(srv, mp4(100), 0, 200);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('morceau_incoherent');
    expect(c.recus).toEqual([]);
  });

  it('🔴 un corps JSON sur la route du morceau : 415, rien n’est relayé', async () => {
    const c = capteur();
    const srv = app({ videos: { transferer: c.transferer } });
    const r = await srv.inject({ method: 'POST', url: url('/777/morceaux?debut=0&fin=10'), payload: { octets: 'AAAA' } });
    expect(r.statusCode).toBe(415);
    expect(c.recus).toEqual([]);
  });

  it('🔴 des octets bruts sur une AUTRE route sont refusés en 415, comme avant ce parseur', async () => {
    const srv = app({ brouillons: { ...aucunePubDeRoute.brouillons, creer: async () => 'b-1' } });
    const r = await srv.inject({
      method: 'POST', url: `/tenants/${TENANT}/pubs/brouillons`, payload: Buffer.from('{}'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(r.statusCode).toBe(415);
  });

  it('des décalages absents, inversés, ou une session qui n’est pas un identifiant Meta : 400', async () => {
    const srv = app();
    for (const chemin of ['/777/morceaux', '/777/morceaux?debut=10&fin=5', '/777/morceaux?debut=a&fin=5', '/abc/morceaux?debut=0&fin=5']) {
      const r = await srv.inject({ method: 'POST', url: url(chemin), payload: Buffer.alloc(5), headers: { 'content-type': 'application/octet-stream' } });
      expect(r.statusCode, chemin).toBe(400);
    }
  });

  it('🔴 réservé aux admins, et à SON espace', async () => {
    const c = capteur();
    expect((await envoyer(app({ videos: { transferer: c.transferer } }, 'agent'), mp4(100), 0, 100)).statusCode).toBe(403);
    const voisin = await app({ videos: { transferer: c.transferer } }).inject({
      method: 'POST', url: url('/777/morceaux?debut=0&fin=100', 't-voisin'), payload: mp4(100),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(voisin.statusCode).toBe(403);
    expect(c.recus).toEqual([]);
  });

  it('un refus de Meta pendant le relais : 422 avec son message', async () => {
    const srv = app({ videos: { transferer: async (_t, m) => {
      for await (const _p of m.octets) { /* vidé */ }
      throw new ErreurGraph(400, 351, 'Graph 400 (#351) : fichier corrompu');
    } } });
    const r = await envoyer(srv, mp4(100), 0, 100);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain('#351');
  });
});

describe('clore, lire l’état', () => {
  it('clore appelle Meta avec la session', async () => {
    const vus: string[] = [];
    const srv = app({ videos: { terminer: async (_t, s) => { vus.push(s); } } });
    const r = await srv.inject({ method: 'POST', url: url('/777/fin') });
    expect(r.statusCode).toBe(200);
    expect(vus).toEqual(['777']);
    expect((await app({}, 'agent').inject({ method: 'POST', url: url('/777/fin') })).statusCode).toBe(403);
  });

  it('l’état d’une vidéo, pour l’attente à l’écran', async () => {
    const srv = app({ videos: { etat: async () => ({ etat: 'traitement', progression: 30 }) } });
    const r = await srv.inject({ method: 'GET', url: url('/888') });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ etat: 'traitement', progression: 30 });
    expect((await srv.inject({ method: 'GET', url: url('/abc') })).statusCode).toBe(400);
    expect((await srv.inject({ method: 'GET', url: url('/888', 't-voisin') })).statusCode).toBe(403);
  });
});

describe('les audiences du compte', () => {
  const LISTE = {
    audiences: [{ id: '1', nom: 'Clients', sousType: 'CUSTOM', tailleMin: 1000, tailleMax: 1200, utilisable: true, raison: null }],
    tronquee: false,
  };

  it('rend la liste lue chez Meta', async () => {
    const srv = app({ audiences: async () => LISTE });
    const r = await srv.inject({ method: 'GET', url: `/tenants/${TENANT}/pubs/audiences` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(LISTE);
  });

  it('🔴 un espace ne lit pas les audiences d’un autre', async () => {
    const srv = app({ audiences: async () => LISTE });
    expect((await srv.inject({ method: 'GET', url: '/tenants/t-voisin/pubs/audiences' })).statusCode).toBe(403);
  });

  it('un refus de Meta : 422 et son message ; pas connecté : 409', async () => {
    const refus = app({ audiences: async () => { throw new ErreurGraph(403, 200, 'Graph 403 (#200) : permission'); } });
    const r = await refus.inject({ method: 'GET', url: `/tenants/${TENANT}/pubs/audiences` });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain('permission');
    const hors = app({ audiences: async () => { throw new PasDeConnexionPub(); } });
    expect((await hors.inject({ method: 'GET', url: `/tenants/${TENANT}/pubs/audiences` })).statusCode).toBe(409);
  });

  it('⚠️ une panne (pas un refus) sort en 502', async () => {
    const srv = app({ audiences: async () => { throw new Error('fetch failed'); } });
    const original = console.error;
    console.error = () => {};
    try {
      expect((await srv.inject({ method: 'GET', url: `/tenants/${TENANT}/pubs/audiences` })).statusCode).toBe(502);
    } finally {
      console.error = original;
    }
  });
});
