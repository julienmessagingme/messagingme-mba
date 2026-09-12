import { describe, it, expect } from 'vitest';
import { mesureInconnue, ventilationAffichable } from './funnel-canal';
import type { FunnelCanal } from '@/lib/api';

const canal = (o: Partial<FunnelCanal>): FunnelCanal => ({
  canal: 'whatsapp', envois: 0, reussis: 0, delivres: 0, lus: 0, repondus: 0, sansAccuse: 0, ...o,
});

describe('« on ne sait pas » contre « zero », canal par canal', () => {
  it('aucun accuse sur tout ce qui est parti : la mesure est INCONNUE', () => {
    expect(mesureInconnue({ reussis: 3, sansAccuse: 3 })).toBe(true);
  });

  it('🔴 un accuse manquant sur trois : les deux autres restent MESURES', () => {
    // Effacer la colonne entiere ici perdrait une information vraie. Le seuil est « aucun », pas « certains ».
    expect(mesureInconnue({ reussis: 3, sansAccuse: 1 })).toBe(false);
  });

  it('🔴 un canal qui n a RIEN envoye ne dit pas « on ne sait pas » : on sait', () => {
    // Sans la garde `reussis > 0`, la comparaison 0 === 0 passerait et l ecran afficherait « — » sur un
    // canal dont on sait parfaitement qu il n a rien envoye ni rien fait livrer.
    expect(mesureInconnue({ reussis: 0, sansAccuse: 0 })).toBe(false);
  });

  it('des accuses sur tout : rien d inconnu', () => {
    expect(mesureInconnue({ reussis: 4, sansAccuse: 0 })).toBe(false);
  });
});

describe('quand la ventilation par canal apprend quelque chose', () => {
  it('🔴 un seul canal : on se tait, sinon on repete les barres du dessus', () => {
    expect(ventilationAffichable([canal({ canal: 'whatsapp', envois: 5 })])).toBe(false);
  });

  it('deux canaux : la ventilation est le seul endroit qui les distingue', () => {
    expect(ventilationAffichable([canal({ canal: 'whatsapp' }), canal({ canal: 'rcs' })])).toBe(true);
  });

  it('⚠️ aucune ligne (campagne anterieure au journal) : on se tait aussi, on n annonce pas zero', () => {
    expect(ventilationAffichable([])).toBe(false);
    expect(ventilationAffichable(undefined)).toBe(false);
  });
});
