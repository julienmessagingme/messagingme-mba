import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ATTENTES_ECOUTE_MS, PgBossQueue, estEchecEcoute } from '../src/queue/pgboss';

/**
 * L'ÉCOUTEUR SE RETENTE AU DÉMARRAGE (lot 2 du bilan des audits). pg-boss rouvre seul un écouteur établi qui tombe,
 * pas un écouteur dont la première ouverture échoue : l'instance sondait alors seule jusqu'au redémarrage du worker.
 * Le faux `PgBoss` avertit comme `Notifier.start` (`pg-boss/dist/notifier.js`) tant que `echecs` n'est pas épuisé.
 */
const etat = vi.hoisted(() => ({
  echecs: 0, demarrages: 0, arrets: 0, leverAuDemarrage: 0,
  /** Émet un avertissement hors de `start`, sur la dernière instance construite. */
  emettre: (_a: unknown): void => {},
}));

vi.mock('pg-boss', () => ({
  PgBoss: class {
    private readonly observateurs: ((a: unknown) => void)[] = [];
    constructor() { etat.emettre = (a) => { for (const cb of this.observateurs) cb(a); }; }
    on(evt: string, cb: (a: unknown) => void): void { if (evt === 'warning') this.observateurs.push(cb); }
    async start(): Promise<void> {
      etat.demarrages += 1;
      if (etat.leverAuDemarrage === etat.demarrages) throw new Error('base injoignable');
      if (etat.echecs > 0) {
        etat.echecs -= 1;
        const avertissement = {
          message: 'Failed to start LISTEN/NOTIFY listener. Continuing with polling only.',
          data: { type: 'listen_notify_unavailable', error: 'too many clients' },
        };
        for (const cb of this.observateurs) cb(avertissement);
      }
    }
    async stop(): Promise<void> { etat.arrets += 1; }
  },
}));

beforeEach(() => { etat.echecs = 0; etat.demarrages = 0; etat.arrets = 0; etat.leverAuDemarrage = 0; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function demarrer(q: PgBossQueue): Promise<void> {
  const fini = q.start();
  await vi.runAllTimersAsync();
  await fini;
}

describe('écouteur : la première ouverture se retente au démarrage', () => {
  it('🔴 un échec puis un succès : pg-boss est relancé une fois, et aucune alerte ne part', async () => {
    const q = new PgBossQueue('postgres://faux', 'pgboss', { ecouteNotifications: true });
    const vus: unknown[] = [];
    q.onWarning((a) => vus.push(a));
    etat.echecs = 1;
    await demarrer(q);
    expect(etat.demarrages).toBe(2);
    expect(etat.arrets).toBe(1);
    expect(vus).toEqual([]);
  });

  it('🔴 des échecs à chaque tentative : trois relances, puis le sondage seul et UNE alerte', async () => {
    const q = new PgBossQueue('postgres://faux', 'pgboss', { ecouteNotifications: true });
    const vus: unknown[] = [];
    q.onWarning((a) => vus.push(a));
    etat.echecs = 99;
    const avant = Date.now();
    await demarrer(q);
    // Les attentes ont bien eu lieu, toutes : des attentes à zéro marteleraient un pooler déjà saturé.
    expect(Date.now() - avant).toBe(ATTENTES_ECOUTE_MS.reduce((a, b) => a + b, 0));
    expect(etat.demarrages).toBe(1 + ATTENTES_ECOUTE_MS.length);
    expect(etat.arrets).toBe(ATTENTES_ECOUTE_MS.length);
    expect(vus).toHaveLength(1);
  });

  it('sans écoute demandée, un avertissement ne relance rien et atteint l’observateur', async () => {
    const q = new PgBossQueue('postgres://faux', 'pgboss');
    const vus: unknown[] = [];
    q.onWarning((a) => vus.push(a));
    etat.echecs = 1;
    await demarrer(q);
    expect(etat.demarrages).toBe(1);
    expect(etat.arrets).toBe(0);
    expect(vus).toHaveLength(1);
  });

  it('seul l’échec d’OUVERTURE se retente : une base sans LISTEN (pas de `error`) ne relance rien', () => {
    expect(estEchecEcoute({ data: { type: 'listen_notify_unavailable', error: 'x' } })).toBe(true);
    expect(estEchecEcoute({ data: { type: 'listen_notify_unavailable', backend: 'cockroachdb' } })).toBe(false);
    expect(estEchecEcoute({ data: { type: 'autre', error: 'x' } })).toBe(false);
    expect(estEchecEcoute(null)).toBe(false);
    expect(estEchecEcoute('listen_notify_unavailable')).toBe(false);
  });

  it('une relance qui lève remonte l’erreur, laisse la file non démarrée et rend la parole aux observateurs', async () => {
    const q = new PgBossQueue('postgres://faux', 'pgboss', { ecouteNotifications: true });
    const vus: unknown[] = [];
    q.onWarning((a) => vus.push(a));
    etat.echecs = 1;
    etat.leverAuDemarrage = 2;
    const fini = q.start();
    const attendu = expect(fini).rejects.toThrow('base injoignable');
    await vi.runAllTimersAsync();
    await attendu;
    // Le drapeau du silence est retombé (`finally`) : un échec d'écoute émis ensuite atteint l'observateur.
    etat.emettre({ data: { type: 'listen_notify_unavailable', error: 'x' } });
    expect(vus).toHaveLength(1);
    // Et la file n'est pas tenue pour démarrée : un nouvel appel relance pg-boss.
    etat.leverAuDemarrage = 0;
    await demarrer(q);
    expect(etat.demarrages).toBe(3);
  });

  it('🔴 le worker branche son observateur AVANT de démarrer la file, et la démarre AVANT tout traitement', () => {
    // L'alerte de la dernière tentative part PENDANT `start`, et la relance arrête pg-boss : un `work` déjà
    // enregistré serait coupé.
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const observateur = worker.indexOf('queue.onWarning(');
    const demarrage = worker.indexOf('await queue.start()');
    const premierWork = worker.search(/queue\.(work|consume)\(/);
    expect(observateur).toBeGreaterThan(-1);
    expect(observateur).toBeLessThan(demarrage);
    expect(premierWork).toBeGreaterThan(demarrage);
  });
});
