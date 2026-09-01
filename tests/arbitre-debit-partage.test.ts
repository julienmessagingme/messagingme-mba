import { describe, it, expect } from 'vitest';
import { arbitreDeDebitPartage, ATTENTE_SIGNALEE_MS, type DepsPorteDebit } from '../src/meta/arbitre-debit-partage';
import { arbitreDeDebit } from '../src/meta/arbitre-debit';
import type { PorteDeDebit } from '../src/meta/http';

/**
 * L'arbitre de débit PARTAGÉ (migration 0102).
 *
 * Ce qui est vérifié ici tient en trois propriétés, et aucune n'est du SQL (le SQL, lui, se prouve contre une
 * vraie base : `tests/integration/porte-debit.integration.test.ts`) :
 *   1. l'attente rendue par la base est RÉELLEMENT observée avant l'envoi, sinon la réservation ne sert à rien ;
 *   2. une base indisponible fait retomber sur le frein LOCAL, jamais sur « laisser passer » : le pire cas de
 *      cette migration doit être le comportement d'avant, pas une absence de frein ;
 *   3. la porte d'un numéro est la MÊME instance d'un appel à l'autre, sinon rien n'est partagé.
 */
function fausseDeps(over: { attente?: () => Promise<number> } = {}) {
  const journal = { reservations: [] as Array<{ numero: string; intervalleMs: number }>, sommeils: [] as number[], pannes: 0 };
  const deps: DepsPorteDebit = {
    // La trace est posée AVANT la réponse simulée, pour qu'un scénario de panne laisse quand même la preuve
    // que la base a bien été interrogée.
    reserver: async (numero, intervalleMs) => {
      journal.reservations.push({ numero, intervalleMs });
      return over.attente ? over.attente() : 0;
    },
    dormir: async (ms) => { journal.sommeils.push(ms); },
    signaler: () => { journal.pannes += 1; },
  };
  return { deps, journal };
}

/** Un arbitre local dont on peut compter les passages (le repli). */
function localCompte() {
  const passages: string[] = [];
  const arbitre = { pour: (numero: string): PorteDeDebit => ({ acquire: async () => { passages.push(numero); } }) };
  return { arbitre, passages };
}

describe('arbitre de débit partagé', () => {
  it('réserve auprès de la base et ATTEND ce qu’elle répond', async () => {
    const { deps, journal } = fausseDeps({ attente: async () => 750 });
    const a = arbitreDeDebitPartage(localCompte().arbitre, 80, deps);
    await a.pour('pn-1').acquire();
    // 80/min -> un envoi toutes les 750 ms : c'est l'intervalle qui part à la base.
    expect(journal.reservations).toEqual([{ numero: 'pn-1', intervalleMs: 750 }]);
    expect(journal.sommeils).toEqual([750]);
  });

  it('une attente NULLE ne déclenche aucun sommeil', async () => {
    // Le cas courant (numéro inactif) ne doit pas payer un `setTimeout(0)` par envoi.
    const { deps, journal } = fausseDeps({ attente: async () => 0 });
    await arbitreDeDebitPartage(localCompte().arbitre, 80, deps).pour('pn-1').acquire();
    expect(journal.sommeils).toEqual([]);
  });

  it('🔴 base INDISPONIBLE : on retombe sur le frein LOCAL, on ne laisse pas passer', async () => {
    // C'est la propriété qui rend ce changement sûr. Le pire cas possible après la migration 0102 doit être
    // EXACTEMENT le comportement d'avant (un budget par process), pas une absence de frein : un envoi ne
    // doit pas non plus échouer parce que la table de débit est indisponible, le frein protège la qualité
    // du numéro, il n'autorise pas l'envoi.
    const { arbitre, passages } = localCompte();
    const { deps, journal } = fausseDeps({ attente: async () => { throw new Error('base injoignable'); } });
    const a = arbitreDeDebitPartage(arbitre, 80, deps);
    await expect(a.pour('pn-1').acquire()).resolves.toBeUndefined(); // l'envoi n'échoue pas
    expect(passages).toEqual(['pn-1']); // le frein local a bien joué
    expect(journal.pannes).toBe(1); // et la panne est signalée, pas avalée
    expect(journal.sommeils).toEqual([]); // aucune attente inventée à partir d'une valeur qu'on n'a pas
  });

  it('🔴 la porte d’un numéro est la MÊME d’un appel à l’autre', async () => {
    // Une porte recréée à chaque appel ne partagerait rien, y compris son repli local, dont l'état est
    // justement ce qui espace les envois pendant une panne.
    const { deps } = fausseDeps();
    const a = arbitreDeDebitPartage(localCompte().arbitre, 80, deps);
    expect(a.pour('pn-1')).toBe(a.pour('pn-1'));
    expect(a.pour('pn-1')).not.toBe(a.pour('pn-2'));
  });

  it('plafond à zéro : l’arbitre LOCAL est rendu tel quel, la base n’est jamais touchée', async () => {
    // `0` retire le frein (documenté dans config.ts). Aller quand même interroger la base à chaque envoi
    // serait un coût pur, sur le chemin d'envoi, pour un réglage qui dit « ne freine pas ».
    const { arbitre } = localCompte();
    const { deps, journal } = fausseDeps();
    const a = arbitreDeDebitPartage(arbitre, 0, deps);
    expect(a).toBe(arbitre);
    await a.pour('pn-1').acquire();
    expect(journal.reservations).toEqual([]);
  });

  it('une attente longue est SIGNALÉE : une file qui s’allonge doit se voir', () => {
    // Pas de comportement à tester ici, seulement le seuil : il existe et il est exporté, donc il peut être
    // relu et changé sciemment plutôt que d'être enfoui dans une condition.
    expect(ATTENTE_SIGNALEE_MS).toBeGreaterThan(0);
  });

  it('l’arbitre local NON enveloppé reste ce qu’il était (aucune régression sur le frein d’avant)', async () => {
    // Ceinture : le repli s'appuie sur lui, donc il doit continuer d'espacer.
    let temps = 0;
    const sommeils: number[] = [];
    const a = arbitreDeDebit(60, (ms) => ({
      acquire: async () => { sommeils.push(ms); temps += ms; },
    }));
    await a.pour('pn-1').acquire();
    await a.pour('pn-1').acquire();
    expect(sommeils).toEqual([1000, 1000]); // 60/min -> une seconde entre deux envois
    expect(temps).toBe(2000);
  });
});
