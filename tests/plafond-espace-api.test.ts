import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { makeRequireApiKey } from '../src/auth/api-key';
import { RateLimiter } from '../src/auth/rate-limit';
import {
  PlafondEspace, ReglagesPlafondEnCache, SANS_REGLAGE, PLAFOND_API_DEFAUT, type ReglagePlafondApi,
} from '../src/auth/plafond-espace';
import { DROIT_RELAIS } from '../src/mba/cle-relais';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { cleApiDeTest } from './aide/cle-api';
import { plafondsDeTest } from './aide/plafonds';
import { capturerJournal } from './journal';

/**
 * LE PLAFOND DE L'API PUBLIQUE PAR ESPACE (décision de Julien du 2026-09-25, migration 0181).
 *
 * 🔴 CE QUE CE FICHIER TIENT : le plafond est COMMUN aux clés d'un espace (dix clés ne donnent plus dix fois le
 * débit), il a DEUX fenêtres qui s'appliquent ensemble, un refus dit laquelle est pleine et quand réessayer, un
 * espace se règle sans toucher les autres, et la clé du relais du Meta Business Agent n'y entre JAMAIS.
 */

function fauxReply() {
  const state: { statusCode: number | null; body: unknown; headers: Record<string, string> } = { statusCode: null, body: undefined, headers: {} };
  const reply = {
    code(c: number) { state.statusCode = c; return reply; },
    header(k: string, v: string) { state.headers[k.toLowerCase()] = v; return reply; },
    async send(b: unknown) { state.body = b; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

/** Une horloge qu'on avance à la main : les fenêtres se vérifient à la seconde près, sans dormir. */
function horloge(depart = 1_800_000_000_000) {
  let t = depart;
  return { now: () => t, avancer: (ms: number) => { t += ms; } };
}

const sansReglage = { reglage: async () => SANS_REGLAGE };

/** Un appel compté pour `tenantId` : rend le statut (`null` = accepté), le corps et les en-têtes. */
async function appel(p: PlafondEspace, tenantId: string) {
  const { reply, state } = fauxReply();
  const ok = await p.consommer(tenantId, reply);
  return { ok, ...state };
}

describe('les deux fenêtres d’un espace', () => {
  it('🔴 la MINUTE pleine refuse, nomme la minute et son plafond, et `retry-after` va à la fin de la minute', async () => {
    const h = horloge();
    const p = new PlafondEspace({ minute: 2, heure: 100 }, sansReglage, h.now);
    expect((await appel(p, 't1')).ok).toBe(true);
    h.avancer(10_000);
    expect((await appel(p, 't1')).ok).toBe(true);
    h.avancer(15_000);
    const refus = await appel(p, 't1');
    expect(refus.ok).toBe(false);
    expect(refus.statusCode).toBe(429);
    expect(refus.body).toEqual({ error: 'trop de requêtes : plafond de l’espace atteint, 2 appels par minute', code: 'rate_limited' });
    // Fenêtre ouverte au premier appel : il reste 60 - 25 = 35 secondes.
    expect(refus.headers['retry-after']).toBe('35');
    expect(refus.headers['x-ratelimit-limit']).toBe('2');
    expect(refus.headers['x-ratelimit-remaining']).toBe('0');
    // `retry-after` arrondit AU-DESSUS : réessayer une demi-seconde trop tôt serait un second refus.
    h.avancer(500);
    expect((await appel(p, 't1')).headers['retry-after']).toBe('35');
    // Et la fenêtre rouvre bien à l'heure dite.
    h.avancer(34_500);
    expect((await appel(p, 't1')).ok).toBe(true);
  });

  it('🔴 puis l’HEURE pleine refuse, nomme l’heure, et `retry-after` va à la fin de l’heure, pas de la minute', async () => {
    const h = horloge();
    const p = new PlafondEspace({ minute: 2, heure: 3 }, sansReglage, h.now);
    expect((await appel(p, 't1')).ok).toBe(true);
    expect((await appel(p, 't1')).ok).toBe(true);
    h.avancer(61_000);
    expect((await appel(p, 't1')).ok).toBe(true);
    h.avancer(1_000);
    // La minute a encore une place : c'est l'heure qui refuse.
    const refus = await appel(p, 't1');
    expect(refus.statusCode).toBe(429);
    expect(refus.body).toEqual({ error: 'trop de requêtes : plafond de l’espace atteint, 3 appels par heure', code: 'rate_limited' });
    expect(refus.headers['retry-after']).toBe(String(3600 - 62));
    expect(refus.headers['x-ratelimit-limit']).toBe('3');
    // Une minute plus tard, la minute s'est vidée, l'heure non : toujours refusé.
    h.avancer(60_000);
    expect((await appel(p, 't1')).statusCode).toBe(429);
  });

  it('🔴 les deux pleines : `retry-after` vaut la plus LONGUE attente, sinon le réessai prend un second 429', async () => {
    const h = horloge();
    const p = new PlafondEspace({ minute: 1, heure: 1 }, sansReglage, h.now);
    expect((await appel(p, 't1')).ok).toBe(true);
    h.avancer(20_000);
    const refus = await appel(p, 't1');
    expect(refus.headers['retry-after']).toBe(String(3600 - 20));
    expect((refus.body as { error: string }).error).toContain('par heure');
  });

  it('🔴 un appel REFUSÉ ne consomme rien : ni la minute, ni l’heure', async () => {
    const h = horloge();
    const p = new PlafondEspace({ minute: 1, heure: 3 }, sansReglage, h.now);
    expect((await appel(p, 't1')).ok).toBe(true);
    // Dix refus de la minute. S'ils prenaient une place dans l'heure, elle serait pleine avant la fin du cas.
    for (let i = 0; i < 10; i += 1) expect((await appel(p, 't1')).ok).toBe(false);
    h.avancer(60_000);
    expect((await appel(p, 't1')).ok).toBe(true);
    h.avancer(60_000);
    expect((await appel(p, 't1')).ok, 'le troisième appel ACCEPTÉ de l’heure').toBe(true);
    h.avancer(60_000);
    expect((await appel(p, 't1')).statusCode, 'le quatrième : l’heure est pleine').toBe(429);
  });

  it('⚠️ les en-têtes décrivent la fenêtre la plus proche de son plafond', async () => {
    const h = horloge();
    const p = new PlafondEspace({ minute: 5, heure: 7 }, sansReglage, h.now);
    const premier = await appel(p, 't1');
    expect([premier.headers['x-ratelimit-limit'], premier.headers['x-ratelimit-remaining']]).toEqual(['5', '4']);
    for (let i = 0; i < 4; i += 1) await appel(p, 't1');
    h.avancer(61_000);
    // La minute est neuve (5 places), l'heure n'en a plus que 2 : c'est elle qui refusera la première.
    const sixieme = await appel(p, 't1');
    expect([sixieme.headers['x-ratelimit-limit'], sixieme.headers['x-ratelimit-remaining']]).toEqual(['7', '1']);
  });
});

describe('le réglage d’un espace', () => {
  it('🔴 relève SON plafond sans toucher celui des autres', async () => {
    const p = new PlafondEspace({ minute: 2, heure: 100 }, { reglage: async (t) => (t === 't1' ? { minute: 5, heure: null } : SANS_REGLAGE) });
    const codes = async (t: string, n: number) => {
      const r: Array<number | null> = [];
      for (let i = 0; i < n; i += 1) r.push((await appel(p, t)).statusCode);
      return r;
    };
    expect(await codes('t1', 6)).toEqual([null, null, null, null, null, 429]);
    expect(await codes('t2', 3), 'l’espace voisin reste au défaut').toEqual([null, null, 429]);
  });

  it('🔴 `null` = le défaut de la configuration, fenêtre par fenêtre', async () => {
    const h = horloge();
    const p = new PlafondEspace({ minute: 2, heure: 100 }, { reglage: async () => ({ minute: null, heure: 3 }) }, h.now);
    expect((await appel(p, 't1')).headers['x-ratelimit-limit'], 'la minute par défaut').toBe('2');
    await appel(p, 't1');
    expect((await appel(p, 't1')).body).toMatchObject({ error: expect.stringContaining('2 appels par minute') });
    h.avancer(60_000);
    await appel(p, 't1');
    expect((await appel(p, 't1')).body).toMatchObject({ error: expect.stringContaining('3 appels par heure') });
  });

  it('⚠️ un défaut à 0 éteint la fenêtre (le levier d’urgence), un réglage d’espace reste appliqué', async () => {
    const p = new PlafondEspace({ minute: 0, heure: 0 }, { reglage: async (t) => (t === 't1' ? { minute: 1, heure: null } : SANS_REGLAGE) });
    for (let i = 0; i < 20; i += 1) {
      const r = await appel(p, 't2');
      expect(r.ok).toBe(true);
      // Désactivé : aucun en-tête. Annoncer une limite de 0 sur un appel accepté serait faux.
      expect(Object.keys(r.headers)).toEqual([]);
    }
    expect((await appel(p, 't1')).ok).toBe(true);
    expect((await appel(p, 't1')).statusCode).toBe(429);
  });

  it('les défauts de la décision : 60 par minute et 1 000 par heure', () => {
    expect(PLAFOND_API_DEFAUT).toEqual({ minute: 60, heure: 1000 });
  });
});

describe('le cache du réglage', () => {
  function source(valeurs: Map<string, ReglagePlafondApi | null | Error>) {
    const lectures: string[] = [];
    const lire = async (t: string) => {
      lectures.push(t);
      const v = valeurs.get(t);
      if (v instanceof Error) throw v;
      return v ?? null;
    };
    return { lectures, lire };
  }

  it('🔴 une lecture par espace et par durée de cache, pas une par appel', async () => {
    const h = horloge();
    const s = source(new Map([['t1', { minute: 5, heure: null }]]));
    const cache = new ReglagesPlafondEnCache(s.lire, 30_000, h.now);
    for (let i = 0; i < 10; i += 1) expect(await cache.reglage('t1')).toEqual({ minute: 5, heure: null });
    expect(s.lectures).toEqual(['t1']);
    h.avancer(30_000);
    await cache.reglage('t1');
    expect(s.lectures).toEqual(['t1', 't1']);
  });

  it('🔴 une rafale simultanée partage UNE lecture', async () => {
    const s = source(new Map([['t1', { minute: 5, heure: null }]]));
    const cache = new ReglagesPlafondEnCache(s.lire);
    await Promise.all(Array.from({ length: 20 }, () => cache.reglage('t1')));
    expect(s.lectures).toEqual(['t1']);
  });

  it('🔴 `poser` applique le réglage écrit TOUT DE SUITE, à cet espace seul, sans relire la base', async () => {
    const valeurs = new Map<string, ReglagePlafondApi | null | Error>([['t1', { minute: 5, heure: null }], ['t2', SANS_REGLAGE]]);
    const s = source(valeurs);
    const cache = new ReglagesPlafondEnCache(s.lire);
    await cache.reglage('t1');
    await cache.reglage('t2');
    cache.poser('t1', { minute: 50, heure: 500 });
    expect(await cache.reglage('t1')).toEqual({ minute: 50, heure: 500 });
    expect(await cache.reglage('t2')).toEqual(SANS_REGLAGE);
    expect(s.lectures).toEqual(['t1', 't2']);
  });

  /**
   * 🔴 LE RÉGLAGE QU'UN OPÉRATEUR VIENT D'ÉCRIRE SURVIT À UNE LECTURE EN ÉCHEC (relecture du 2026-09-25). La route
   * VIDAIT l'entrée : la relecture suivante, si elle échouait sur un incident de base passager, n'avait plus de
   * « dernier réglage connu », et l'espace qu'on venait de relever à 600 retombait au défaut pendant 30 s.
   */
  it('🔴 après `poser`, une relecture qui échoue garde le réglage POSÉ, pas le défaut', async () => {
    const h = horloge();
    const valeurs = new Map<string, ReglagePlafondApi | null | Error>([['t1', SANS_REGLAGE]]);
    const s = source(valeurs);
    const cache = new ReglagesPlafondEnCache(s.lire, 30_000, h.now);
    expect(await cache.reglage('t1')).toEqual(SANS_REGLAGE);
    cache.poser('t1', { minute: 600, heure: null });
    valeurs.set('t1', new Error('connexion perdue'));
    h.avancer(30_000);
    const { resultat } = await capturerJournal(async () => cache.reglage('t1'));
    expect(resultat).toEqual({ minute: 600, heure: null });
  });

  it('🔴 une lecture qui échoue garde le dernier réglage connu, sinon le défaut, et le dit une fois par minute', async () => {
    const h = horloge();
    const valeurs = new Map<string, ReglagePlafondApi | null | Error>([['t1', { minute: 5, heure: null }], ['t2', new Error('column "api_plafond_minute" does not exist')]]);
    const s = source(valeurs);
    const cache = new ReglagesPlafondEnCache(s.lire, 30_000, h.now);
    await cache.reglage('t1');
    valeurs.set('t1', new Error('panne'));
    h.avancer(30_000);
    const { resultat, lignes } = await capturerJournal(async () => [
      await cache.reglage('t1'),
      await cache.reglage('t2'),
    ]);
    expect(resultat).toEqual([{ minute: 5, heure: null }, SANS_REGLAGE]);
    // Deux échecs dans la même minute : UNE ligne, jamais une par appel.
    expect(lignes.filter((l) => l.msg === 'plafond_api_reglage_illisible')).toHaveLength(1);
  });

  it('un espace inconnu du magasin (`null`) est au défaut', async () => {
    const cache = new ReglagesPlafondEnCache(async () => null);
    expect(await cache.reglage('t9')).toEqual(SANS_REGLAGE);
  });
});

describe('la garde de clé compte l’ESPACE, et le relais à part', () => {
  const A = cleApiDeTest('plafond_espace_cle_a');
  const B = cleApiDeTest('plafond_espace_cle_b');
  const AUTRE = cleApiDeTest('plafond_espace_autre_espace');
  const RELAIS = cleApiDeTest('plafond_espace_relais');

  class FaussesCles implements ApiKeyLookup {
    appels = 0;
    private readonly parEmpreinte = new Map<string, { id: string; tenantId: string; scopes: string[] }>([
      [sha256Hex(A), { id: 'ka', tenantId: 't1', scopes: ['contacts:write'] }],
      [sha256Hex(B), { id: 'kb', tenantId: 't1', scopes: ['sends:create', 'mcp:read'] }],
      [sha256Hex(AUTRE), { id: 'kc', tenantId: 't2', scopes: ['contacts:write'] }],
      [sha256Hex(RELAIS), { id: 'kr', tenantId: 't1', scopes: [DROIT_RELAIS] }],
    ]);
    async findActiveByHash(h: string) { this.appels += 1; return this.parEmpreinte.get(h) ?? null; }
    async touchLastUsed() {}
  }

  const requete = (cle: string): FastifyRequest => ({ headers: { authorization: `Bearer ${cle}` } }) as unknown as FastifyRequest;
  const large = (): RateLimiter => new RateLimiter(1000, 60_000);
  async function passer(garde: ReturnType<typeof makeRequireApiKey>, cle: string) {
    const { reply, state } = fauxReply();
    await garde(requete(cle), reply);
    return state;
  }

  it('🔴 deux clés du MÊME espace partagent un plafond : dix clés ne font plus dix fois le débit', async () => {
    const garde = makeRequireApiKey(new FaussesCles(), plafondsDeTest({ minute: 3 }), large());
    const codes: Array<number | null> = [];
    for (const cle of [A, B, A, B, A]) codes.push((await passer(garde, cle)).statusCode);
    expect(codes).toEqual([null, null, null, 429, 429]);
  });

  it('🔴 l’isolation : un espace au-delà de son plafond ne retire rien à un autre, ni ses en-têtes', async () => {
    const garde = makeRequireApiKey(new FaussesCles(), plafondsDeTest({ minute: 2 }), large());
    const codes: Array<number | null> = [];
    for (const cle of [A, B, A]) codes.push((await passer(garde, cle)).statusCode);
    // La preuve que l'espace t1 est bien à bout : sans elle, le cas passerait aussi sans aucun plafond.
    expect(codes).toEqual([null, null, 429]);
    const voisin = await passer(garde, AUTRE);
    expect(voisin.statusCode).toBeNull();
    expect([voisin.headers['x-ratelimit-limit'], voisin.headers['x-ratelimit-remaining']]).toEqual(['2', '1']);
  });

  it('🔴 LE RELAIS N’ENTRE PAS DANS LE PLAFOND DE L’ESPACE : un intégrateur qui l’épuise ne coupe pas l’agent de Meta', async () => {
    const garde = makeRequireApiKey(new FaussesCles(), plafondsDeTest({ minute: 2, relais: 50 }), large());
    expect((await passer(garde, A)).statusCode).toBeNull();
    expect((await passer(garde, B)).statusCode).toBeNull();
    expect((await passer(garde, A)).statusCode, 'l’espace est à bout').toBe(429);
    const relais = await passer(garde, RELAIS);
    expect(relais.statusCode, 'l’agent de Meta garde ses outils').toBeNull();
    // Ses en-têtes sont ceux de SA clé, pas ceux de l'espace.
    expect([relais.headers['x-ratelimit-limit'], relais.headers['x-ratelimit-remaining']]).toEqual(['50', '49']);
  });

  it('🔴 et ses appels ne coûtent rien à l’espace', async () => {
    const garde = makeRequireApiKey(new FaussesCles(), plafondsDeTest({ minute: 2, relais: 50 }), large());
    for (let i = 0; i < 10; i += 1) expect((await passer(garde, RELAIS)).statusCode).toBeNull();
    expect((await passer(garde, A)).statusCode).toBeNull();
    expect((await passer(garde, B)).statusCode).toBeNull();
  });

  it('🔴 le relais garde son PROPRE plafond par clé, refusé avant la base une fois connu', async () => {
    const cles = new FaussesCles();
    const garde = makeRequireApiKey(cles, plafondsDeTest({ minute: 100, relais: 2 }), large());
    const codes: Array<number | null> = [];
    for (let i = 0; i < 5; i += 1) codes.push((await passer(garde, RELAIS)).statusCode);
    expect(codes).toEqual([null, null, 429, 429, 429]);
    expect(cles.appels, 'deux lectures pour deux appels acceptés, aucune pour les refus').toBe(2);
    // Le relais à bout ne retire rien à l'espace.
    expect((await passer(garde, A)).statusCode).toBeNull();
  });

  it('🔴 une clé d’espace au-delà du plafond est refusée AVANT la base, et ne paie aucune lecture', async () => {
    const cles = new FaussesCles();
    const garde = makeRequireApiKey(cles, plafondsDeTest({ minute: 2 }), large());
    for (let i = 0; i < 12; i += 1) await passer(garde, A);
    expect(cles.appels).toBe(2);
  });
});
