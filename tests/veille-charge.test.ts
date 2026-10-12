import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TACHES_PAR_ROLE } from '../src/worker/roles';
import { creerVeilleCharge, RELANCE_ALERTE_MS, type LecturesCharge } from '../src/ops/veille-charge';
import { BORNES_LATENCE_MS } from '../src/ops/latence-http';
import { CLE_REFUS_GLOBAL } from '../src/auth/plafond-global';
import type { PointAttente } from '../src/ops/pool-attentes.pg';
import { capturerJournal } from './journal';

/**
 * 🔴 LA VEILLE DE CHARGE (lot 14, A) : prévenir AVANT que ça casse. Quatre alertes, chacune sur une mesure qui existait
 * déjà en base et que personne ne lisait : une file en retard, la réception de Meta lente, la base saturée (l'attente
 * d'une connexion), le plafond global atteint. Une alerte par clé au plus toutes les 30 minutes.
 */

/** `n` requêtes dans la tranche de `ms` (la première borne qui le contient). */
function seaux(parTranche: Array<[number, number]>): number[] {
  const s = new Array<number>(BORNES_LATENCE_MS.length + 1).fill(0);
  for (const [ms, n] of parTranche) {
    const i = BORNES_LATENCE_MS.findIndex((b) => ms <= b);
    const k = i === -1 ? BORNES_LATENCE_MS.length : i;
    s[k] = (s[k] ?? 0) + n;
  }
  return s;
}

const calme: LecturesCharge = {
  agesDAttente: async () => [{ file: 'webhook', ageSecondes: 3 }, { file: 'analyze-conversation', ageSecondes: 40 }],
  latencesReceptionMeta: async () => ({ seaux: seaux([[50, 300]]), maxMs: 60 }),
  attentesPool: async () => [],
  refusPlafondGlobal: async () => [],
};

function monter(lire: Partial<LecturesCharge>, t0 = 1_800_000_000_000) {
  let t = t0;
  const alertes: Array<{ cle: string; texte: string }> = [];
  const passe = creerVeilleCharge({ lire: { ...calme, ...lire }, alerter: (cle, texte) => alertes.push({ cle, texte }), maintenant: () => t });
  return { passe, alertes, avancer: (ms: number) => { t += ms; } };
}

const point = (process: string, o: Partial<PointAttente>): PointAttente => ({
  process, minute: '2027-01-15T08:00:00.000Z', echantillons: 100, attentes: 0, maxMs: 5, maxAttenteMs: 0, moyenneMs: 1, ...o,
});

describe('🔴 la veille de charge', () => {
  it('au calme, rien', async () => {
    const { passe, alertes } = monter({});
    await passe();
    expect(alertes).toEqual([]);
  });

  it('🔴 une file de réception en retard au-delà de 60 s, une autre au-delà de 5 min ; une DLQ jamais', async () => {
    const { passe, alertes } = monter({
      agesDAttente: async () => [
        { file: 'webhook', ageSecondes: 61 },
        { file: 'webhook-status', ageSecondes: 59 },
        { file: 'analyze-conversation', ageSecondes: 299 },
        { file: 'campaign-run', ageSecondes: 301 },
        { file: 'webhook-dlq', ageSecondes: 86_400 },
      ],
    });
    await passe();
    expect(alertes.map((a) => a.cle).sort()).toEqual(['veille:file:campaign-run', 'veille:file:webhook']);
    expect(alertes.find((a) => a.cle === 'veille:file:webhook')!.texte).toMatch(/webhook.*61 s/);
  });

  it('🔴 la réception de Meta lente : p95 au-delà de 2 s sur au moins 20 requêtes', async () => {
    const lente = monter({ latencesReceptionMeta: async () => ({ seaux: seaux([[50, 90], [5000, 10]]), maxMs: 4100 }) });
    await lente.passe();
    expect(lente.alertes.map((a) => a.cle)).toEqual(['veille:reception-meta']);
    expect(lente.alertes[0]!.texte).toMatch(/100 requêtes/);
    const rare = monter({ latencesReceptionMeta: async () => ({ seaux: seaux([[5000, 19]]), maxMs: 4100 }) });
    await rare.passe();
    expect(rare.alertes, 'moins de 20 requêtes : on ne conclut rien').toEqual([]);
    const juste = monter({ latencesReceptionMeta: async () => ({ seaux: seaux([[50, 95], [5000, 5]]), maxMs: 4100 }) });
    await juste.passe();
    expect(juste.alertes, 'le p95 tombe encore dans les rapides').toEqual([]);
  });

  it('🔴 la base saturée : au moins 5 % des prises de connexion ont attendu, et la plus longue au-delà de 200 ms', async () => {
    const { passe, alertes } = monter({
      attentesPool: async () => [
        point('api', { attentes: 6, maxAttenteMs: 450 }),
        point('worker', { attentes: 6, maxAttenteMs: 150 }),
        point('worker-analyse', { attentes: 2, maxAttenteMs: 900 }),
        point('api-b', { echantillons: 10, attentes: 10, maxAttenteMs: 900 }),
      ],
    });
    await passe();
    expect(alertes.map((a) => a.cle)).toEqual(['veille:pool:api']);
    expect(alertes[0]!.texte).toMatch(/api.*6 %.*450 ms/);
  });

  it('🔴 le plafond global atteint : le nombre de refus Free et payants', async () => {
    const { passe, alertes } = monter({
      refusPlafondGlobal: async () => [
        { cle: `${CLE_REFUS_GLOBAL}free`, debutMs: 1, n: 40 },
        { cle: `${CLE_REFUS_GLOBAL}free`, debutMs: 2, n: 2 },
        { cle: `${CLE_REFUS_GLOBAL}payant`, debutMs: 2, n: 3 },
      ],
    });
    await passe();
    expect(alertes.map((a) => a.cle)).toEqual(['veille:plafond-global']);
    expect(alertes[0]!.texte).toMatch(/45 refus.*42 Free.*3 payants/);
  });

  it('🔴 une alerte par clé au plus toutes les 30 minutes, puis elle revient si le problème dure', async () => {
    const { passe, alertes, avancer } = monter({ agesDAttente: async () => [{ file: 'webhook', ageSecondes: 120 }] });
    await passe();
    avancer(RELANCE_ALERTE_MS - 1);
    await passe();
    expect(alertes).toHaveLength(1);
    avancer(1);
    await passe();
    expect(alertes).toHaveLength(2);
  });

  it('une lecture en échec n’empêche pas les trois autres, et se journalise', async () => {
    const { resultat, lignes } = await capturerJournal(async () => {
      const { passe, alertes } = monter({
        agesDAttente: async () => { throw new Error('pgboss injoignable'); },
        refusPlafondGlobal: async () => [{ cle: `${CLE_REFUS_GLOBAL}payant`, debutMs: 1, n: 1 }],
      });
      await passe();
      return alertes;
    });
    expect(resultat.map((a) => a.cle)).toEqual(['veille:plafond-global']);
    expect(lignes.some((l) => l.msg === 'veille_charge_lecture_impossible')).toBe(true);
  });
});

/** Le câblage, lu dans le worker : la veille vit dans son `main()`, qu'aucun test de comportement n'atteint. */
describe('la veille de charge est câblée dans le worker principal', () => {
  const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('🔴 chaque minute, sur les vraies mesures, et ses alertes partent par Telegram', () => {
    expect(worker).toMatch(/taches\.programmer\('veille-charge', 60_000, veilleCharge,/);
    expect(worker).toMatch(/agesDAttente: \(\) => opsStore\.agesDAttente\(\),/);
    expect(worker).toMatch(/latencesReceptionMeta: \(fenetre\) => httpLatencesStore\.lireFenetre\('POST', '\/webhooks\/meta', fenetre\),/);
    expect(worker).toMatch(/attentesPool: \(\) => poolAttentesStore\.lireDernieresMinutes\(3\),/);
    expect(worker).toMatch(/refusPlafondGlobal: \(\) => compteurDebit\.lister\(CLE_REFUS_GLOBAL, 2 \* 60_000\),/);
    expect(worker).toMatch(/alerter: \(cle, texte\) => alert\(cle, texte\),/);
  });

  it('elle appartient au rôle principal', () => {
    expect(TACHES_PAR_ROLE['veille-charge']).toBe('principal');
  });
});
