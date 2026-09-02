import { describe, it, expect } from 'vitest';
import { MesureAttentePool, instrumenterPool, type PoolInstrumentable, type SeauAttente } from '../src/db/attente-pool';
import { viderVersLaBase } from '../src/ops/pool-attentes.pg';

/**
 * MESURER L'ATTENTE D'UNE CONNEXION (lot 7 du plan post-audit, 2026-09-02).
 *
 * 🔴 Le calcul avait tranché : le pool n'est PAS ce qui cassera à 25 clients. Le vrai défaut était
 * l'AVEUGLEMENT : `/ops` n'exposait rien du pool, donc une saturation s'apprendrait par un client qui appelle.
 *
 * ⚠️ Et « attendre » recouvre DEUX choses qu'il ne faut pas confondre : ouvrir une connexion neuve (TCP + TLS,
 * quelques millisecondes, parfaitement normal, surtout au démarrage) et attendre qu'une connexion se LIBÈRE
 * sur un pool déjà au maximum. Seule la seconde est le signal. D'où deux compteurs, testés ici.
 */

/** Une horloge que le test avance à la main : mesurer du temps réel rendrait ces tests instables. */
function horloge() {
  let t = 0;
  return { maintenant: () => t, avancer: (ms: number) => { t += ms; } };
}

/** Un faux pool. `libres`/`total`/`max` pilotent la saturation, `retard` la durée d'acquisition. */
function fauxPool(h: ReturnType<typeof horloge>, etat: { libres: number; total: number; max: number; retard: number; echoue?: boolean }) {
  const pool: PoolInstrumentable = {
    connect: ((cb?: (err: Error | undefined, client: unknown, release: unknown) => void): unknown => {
      h.avancer(etat.retard);
      if (typeof cb === 'function') {
        cb(etat.echoue ? new Error('timeout') : undefined, {}, () => {});
        return undefined;
      }
      return etat.echoue ? Promise.reject(new Error('timeout')) : Promise.resolve({});
    }) as PoolInstrumentable['connect'],
    get totalCount() { return etat.total; },
    get idleCount() { return etat.libres; },
    waitingCount: 0,
    options: { max: etat.max },
  };
  return pool;
}

describe('instrumenterPool', () => {
  it('🔴 mesure la forme À RAPPEL, celle qu’emprunte pool.query', () => {
    // C'est la forme qui compte le plus : `pg.Pool.query` appelle `this.connect(cb)`. La rater laisserait
    // toutes les requêtes des stores non mesurées, c'est-à-dire la quasi-totalité du trafic.
    const h = horloge();
    const m = new MesureAttentePool();
    const pool = fauxPool(h, { libres: 0, total: 8, max: 8, retard: 42 });
    instrumenterPool(pool, m, h.maintenant);
    (pool.connect as (cb: () => void) => void)(() => {});
    const seau = m.vider();
    expect(seau.echantillons).toBe(1);
    expect(seau.maxMs).toBe(42);
  });

  it('🔴 mesure aussi la forme PROMESSE, celle des transactions', async () => {
    const h = horloge();
    const m = new MesureAttentePool();
    const pool = fauxPool(h, { libres: 0, total: 8, max: 8, retard: 15 });
    instrumenterPool(pool, m, h.maintenant);
    await (pool.connect as () => Promise<unknown>)();
    expect(m.vider()).toMatchObject({ echantillons: 1, maxMs: 15 });
  });

  it('🔴 une acquisition qui ÉCHOUE est mesurée : c’est la plus longue attente possible', async () => {
    // Un délai dépassé sur pool saturé est exactement l'événement qu'on ne veut pas rater. L'avaler
    // reviendrait à ne rien voir précisément le jour où il se passe quelque chose.
    const h = horloge();
    const m = new MesureAttentePool();
    const pool = fauxPool(h, { libres: 0, total: 8, max: 8, retard: 8000, echoue: true });
    instrumenterPool(pool, m, h.maintenant);
    await expect((pool.connect as () => Promise<unknown>)()).rejects.toThrow('timeout');
    const seau = m.vider();
    expect(seau.maxMs).toBe(8000);
    expect(seau.attentes).toBe(1);
  });

  it('🔴 ouvrir une connexion NEUVE n’est pas une attente : le pool n’était pas saturé', () => {
    // Sans cette distinction, chaque démarrage afficherait une rafale d'« attentes » et l'indicateur
    // deviendrait illisible, donc inutile, donc ignoré.
    const h = horloge();
    const m = new MesureAttentePool();
    const pool = fauxPool(h, { libres: 0, total: 2, max: 8, retard: 11 });
    instrumenterPool(pool, m, h.maintenant);
    (pool.connect as (cb: () => void) => void)(() => {});
    const seau = m.vider();
    expect(seau.echantillons).toBe(1); // la durée est bien mesurée...
    expect(seau.attentes).toBe(0); // ...mais ce n'est pas une attente
    expect(seau.maxMs).toBe(11);
  });

  it('une connexion LIBRE disponible ne compte pas non plus comme une attente', () => {
    const h = horloge();
    const m = new MesureAttentePool();
    const pool = fauxPool(h, { libres: 3, total: 8, max: 8, retard: 0 });
    instrumenterPool(pool, m, h.maintenant);
    (pool.connect as (cb: () => void) => void)(() => {});
    expect(m.vider()).toMatchObject({ echantillons: 1, attentes: 0, maxMs: 0 });
  });
});

describe('MesureAttentePool', () => {
  it('vider REPART À ZÉRO, mais le pic depuis le démarrage reste', () => {
    // Le pic est la mémoire longue de l'écran : le remettre à zéro ferait disparaître l'incident dès la
    // minute suivante, c'est-à-dire avant que quiconque ouvre la page.
    const m = new MesureAttentePool();
    m.enregistrer(120, true);
    expect(m.vider()).toMatchObject({ echantillons: 1, attentes: 1, maxMs: 120 });
    expect(m.vider()).toMatchObject({ echantillons: 0, maxMs: 0 });
    expect(m.maxDepuisDemarrage).toBe(120);
  });

  it('🔴 réinjecter FUSIONNE un seau, il ne le compte pas comme une acquisition', () => {
    // Une mesure qu'on répare de travers vaut moins qu'une mesure manquante, parce qu'elle a l'air juste :
    // réinjecter un seau comme s'il était UNE acquisition perdrait le nombre d'échantillons et d'attentes.
    const m = new MesureAttentePool();
    m.enregistrer(5, false);
    const perdu: SeauAttente = { echantillons: 40, attentes: 7, maxMs: 900, sommeMs: 1200 };
    m.reinjecter(perdu);
    expect(m.vider()).toEqual({ echantillons: 41, attentes: 7, maxMs: 900, sommeMs: 1205 });
  });
});

describe('viderVersLaBase', () => {
  it('n’écrit RIEN quand rien ne s’est passé : pas de ligne par minute sur un process au repos', async () => {
    const ecrits: unknown[] = [];
    const ecrit = await viderVersLaBase({ enregistrer: async (...a) => { ecrits.push(a); } }, new MesureAttentePool(), 'api', new Date());
    expect(ecrit).toBe(false);
    expect(ecrits).toHaveLength(0);
  });

  it('écrit le seau sur la MINUTE tronquée', async () => {
    const m = new MesureAttentePool();
    m.enregistrer(30, true);
    const vus: Array<{ processus: string; minute: Date; seau: SeauAttente }> = [];
    const ecrit = await viderVersLaBase(
      { enregistrer: async (processus, minute, seau) => { vus.push({ processus, minute, seau }); } },
      m, 'worker', new Date('2026-09-02T21:47:33.512Z'),
    );
    expect(ecrit).toBe(true);
    expect(vus[0]!.processus).toBe('worker');
    expect(vus[0]!.minute.getSeconds()).toBe(0);
    expect(vus[0]!.minute.getMilliseconds()).toBe(0);
    expect(vus[0]!.seau).toMatchObject({ echantillons: 1, attentes: 1, maxMs: 30 });
  });

  it('🔴 une écriture EN ÉCHEC ne perd pas la minute : le seau est remis, entier', async () => {
    // La minute perdue serait justement celle où ça allait mal : une panne de base et un pic d'attente ont
    // toutes les chances d'être le même incident.
    const m = new MesureAttentePool();
    m.enregistrer(200, true);
    m.enregistrer(10, false);
    const erreurs: unknown[] = [];
    const ecrit = await viderVersLaBase(
      { enregistrer: async () => { throw new Error('table absente'); } },
      m, 'api', new Date(), (e) => { erreurs.push(e); },
    );
    expect(ecrit).toBe(false);
    expect(erreurs).toHaveLength(1);
    // Tout est encore là, échantillons et attentes compris.
    expect(m.vider()).toMatchObject({ echantillons: 2, attentes: 1, maxMs: 200 });
  });
});
