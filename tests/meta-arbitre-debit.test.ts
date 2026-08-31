import { describe, it, expect } from 'vitest';
import { arbitreDeDebit } from '../src/meta/arbitre-debit';
import type { PorteDeDebit } from '../src/meta/http';

/** Porte instrumentée : compte ses acquisitions, ne dort jamais (les tests ne mesurent pas le temps). */
function porteEspionne() {
  const etat = { acquisitions: 0, intervalles: [] as number[] };
  const fabrique = (ms: number): PorteDeDebit => {
    etat.intervalles.push(ms);
    return { acquire: async () => { etat.acquisitions += 1; } };
  };
  return { etat, fabrique };
}

/**
 * ARBITRE DE DÉBIT PAR NUMÉRO (lot 4 du programme, 2026-08-31).
 *
 * Le seul frein d'envoi du dépôt était instancié PAR RUN DE CAMPAGNE : deux campagnes du même numéro avaient
 * deux budgets, et 30/min configurés en faisaient 60. Les trois autres chemins d'envoi (inbox, scénario,
 * automation) n'avaient AUCUN frein.
 */
describe('arbitre de débit par numéro', () => {
  it('🔴 le MÊME numéro rend TOUJOURS la même porte : c’est ce qui rend le budget partagé', () => {
    const { etat, fabrique } = porteEspionne();
    const arbitre = arbitreDeDebit(60, fabrique);
    const a = arbitre.pour('pn-1');
    const b = arbitre.pour('pn-1');
    expect(b).toBe(a);
    expect(etat.intervalles).toHaveLength(1); // une seule porte construite pour ce numéro
  });

  it('🔴 deux numéros DIFFÉRENTS ont des portes distinctes : l’un n’attend jamais l’autre', () => {
    const { etat, fabrique } = porteEspionne();
    const arbitre = arbitreDeDebit(60, fabrique);
    expect(arbitre.pour('pn-1')).not.toBe(arbitre.pour('pn-2'));
    expect(etat.intervalles).toHaveLength(2);
  });

  it('l’intervalle dérive du débit par minute (60/min -> une seconde)', () => {
    const { etat, fabrique } = porteEspionne();
    arbitreDeDebit(60, fabrique).pour('pn-1');
    expect(etat.intervalles[0]).toBe(1000);
    const b = porteEspionne();
    arbitreDeDebit(80, b.fabrique).pour('pn-1');
    expect(b.etat.intervalles[0]).toBe(750);
  });

  it('débit <= 0 -> porte OUVERTE (opt-out assumé), et aucune porte n’est construite', async () => {
    const { etat, fabrique } = porteEspionne();
    const arbitre = arbitreDeDebit(0, fabrique);
    await arbitre.pour('pn-1').acquire();
    expect(etat.intervalles).toHaveLength(0);
    expect(etat.acquisitions).toBe(0);
  });

  it('la porte d’un numéro est bien celle qu’on acquiert', async () => {
    const { etat, fabrique } = porteEspionne();
    const arbitre = arbitreDeDebit(60, fabrique);
    await arbitre.pour('pn-1').acquire();
    await arbitre.pour('pn-1').acquire();
    expect(etat.acquisitions).toBe(2);
  });
});

/**
 * Le VRAI freinage, avec l'implémentation réelle : deux appelants du même numéro se partagent le budget.
 * C'est la propriété que le lot existe pour obtenir, et un test à porte factice ne la prouverait pas.
 */
describe('arbitre de débit : le partage réel du budget', () => {
  it('🔴 deux envois du même numéro s’espacent ; deux numéros différents ne s’attendent pas', async () => {
    let horloge = 0;
    const sommeils: number[] = [];
    // On réutilise le VRAI RateLimiter, avec son horloge et son sommeil injectés.
    const { RateLimiter } = await import('../src/meta/http');
    const arbitre = arbitreDeDebit(60, (ms) => new RateLimiter(ms, {
      now: () => horloge,
      sleep: async (d) => { sommeils.push(d); horloge += d; },
    }));

    await arbitre.pour('pn-1').acquire(); // 1er envoi : immédiat
    expect(sommeils).toEqual([]);
    await arbitre.pour('pn-1').acquire(); // 2e envoi sur le MÊME numéro : il attend une seconde
    expect(sommeils).toEqual([1000]);
    await arbitre.pour('pn-2').acquire(); // autre numéro : aucune attente
    expect(sommeils).toEqual([1000]);
  });
});
