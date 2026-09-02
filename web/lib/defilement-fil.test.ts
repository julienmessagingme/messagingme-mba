import { describe, it, expect } from 'vitest';
import { doitDescendre, estEnBas, TOLERANCE_BAS_PX } from './defilement-fil';

/**
 * LA RÈGLE DE DÉFILEMENT DU FIL D'INBOX (lot 2 du plan post-audit, 2026-09-02).
 *
 * Ces tests portent la démonstration ARITHMÉTIQUE du défaut : la même géométrie donne deux réponses opposées
 * selon qu'on la mesure avant ou après l'ajout d'un message. C'est tout le bug, et il tient en deux calculs.
 * Le comportement à l'écran, lui, est prouvé par `web/e2e/inbox-defilement.spec.ts`.
 */
describe('estEnBas', () => {
  it('un fil qui tient dans son cadre est en bas', () => {
    expect(estEnBas({ scrollHeight: 300, scrollTop: 0, clientHeight: 300 })).toBe(true);
  });

  it('un conteneur pas encore monté vaut « en bas » : à l’ouverture, on va au message le plus récent', () => {
    expect(estEnBas(null)).toBe(true);
  });

  it('posé au fond, oui ; remonté dans l’historique, non', () => {
    expect(estEnBas({ scrollHeight: 5000, scrollTop: 4700, clientHeight: 300 })).toBe(true);
    expect(estEnBas({ scrollHeight: 5000, scrollTop: 1000, clientHeight: 300 })).toBe(false);
  });

  it('la tolérance est bornée des deux côtés', () => {
    const juste = { scrollHeight: 5000, clientHeight: 300 };
    expect(estEnBas({ ...juste, scrollTop: 5000 - 300 - (TOLERANCE_BAS_PX - 1) })).toBe(true);
    expect(estEnBas({ ...juste, scrollTop: 5000 - 300 - TOLERANCE_BAS_PX })).toBe(false);
  });
});

describe('doitDescendre', () => {
  it('🔴 OUVERTURE d’un fil LONG : on descend, quoi qu’en dise la géométrie', () => {
    // Le défaut n° 1, en une ligne. À l'ouverture, `scrollTop` vaut 0 sur un historique de 5000 px : mesurer
    // répond « pas en bas », et l'opérateur atterrissait sur le plus vieux message.
    const aLOuverture = { scrollHeight: 5000, scrollTop: 0, clientHeight: 300 };
    expect(estEnBas(aLOuverture)).toBe(false); // ce que l'ancien code déduisait...
    expect(doitDescendre({ premierChargement: true, etaitEnBas: estEnBas(aLOuverture) })).toBe(true); // ...et ce qu'il faut faire
  });

  it('🔴 message plus HAUT que la tolérance : mesuré avant on suit, mesuré après on ne suivait plus', () => {
    // Le défaut n° 2. Le fil était collé au fond (5000/4700/300), un message de 200 px arrive : la hauteur
    // passe à 5200 sans que `scrollTop` bouge, donc l'écart devient 200, au-dessus de la tolérance.
    const avant = { scrollHeight: 5000, scrollTop: 4700, clientHeight: 300 };
    const apres = { scrollHeight: 5200, scrollTop: 4700, clientHeight: 300 };
    expect(estEnBas(avant)).toBe(true);
    expect(estEnBas(apres)).toBe(false); // la mesure d'APRÈS, celle qui faisait le bug
    expect(doitDescendre({ premierChargement: false, etaitEnBas: estEnBas(avant) })).toBe(true);
    expect(doitDescendre({ premierChargement: false, etaitEnBas: estEnBas(apres) })).toBe(false);
  });

  it('l’opérateur REMONTÉ n’est jamais arraché à sa lecture', () => {
    // La garde qui existait déjà et qu'il ne faut surtout pas perdre en corrigeant le reste.
    const remonte = { scrollHeight: 5000, scrollTop: 1000, clientHeight: 300 };
    expect(doitDescendre({ premierChargement: false, etaitEnBas: estEnBas(remonte) })).toBe(false);
  });
});
