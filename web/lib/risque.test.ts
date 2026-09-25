import { describe, it, expect } from 'vitest';
import {
  BADGE_NIVEAU_RISQUE, LIBELLES_RAISON_RISQUE, NIVEAUX_DU_FILTRE, NIVEAUX_RISQUE, libelleRaisonRisque, risqueLu,
} from './risque';

/**
 * Le risque de désengagement À L'ÉCRAN (lot 7). La parité avec le serveur (niveaux et codes, dans les deux sens)
 * est dans `tests/web-risque-parite.test.ts`, qui voit les deux côtés ; ce fichier-ci garde ce que l'écran fait
 * de ce qu'il reçoit.
 */
describe('les libellés', () => {
  it('chaque raison a son libellé, dans les deux langues, et ce n’est pas le code recopié', () => {
    for (const [code, [fr, en]] of Object.entries(LIBELLES_RAISON_RISQUE)) {
      expect(fr.trim(), code).not.toBe('');
      expect(en.trim(), code).not.toBe('');
      expect(fr, code).not.toBe(code);
      expect(libelleRaisonRisque(code)).toEqual([fr, en]);
    }
  });

  it('chaque niveau a son badge, dans les deux langues', () => {
    for (const n of NIVEAUX_RISQUE) {
      const [fr, en] = BADGE_NIVEAU_RISQUE[n].text;
      expect(fr.trim(), n).not.toBe('');
      expect(en.trim(), n).not.toBe('');
      expect(BADGE_NIVEAU_RISQUE[n].cls, n).not.toBe('');
    }
  });

  it('⚠️ un code inconnu de cette console s’affiche TEL QUEL, il ne disparaît pas', () => {
    expect(libelleRaisonRisque('nouvelle_raison')).toEqual(['nouvelle_raison', 'nouvelle_raison']);
    // `in` dirait vrai pour ce qui vient du prototype : le libellé serait une fonction, et l'écran tomberait.
    expect(libelleRaisonRisque('toString')).toEqual(['toString', 'toString']);
  });

  it('le filtre propose les quatre niveaux, chacun une fois', () => {
    expect([...NIVEAUX_DU_FILTRE].sort()).toEqual([...NIVEAUX_RISQUE].sort());
  });
});

describe('risqueLu : le risque d’une fiche venue du réseau', () => {
  const CALCULE = '2026-09-25T03:05:00.000Z';

  it('🔴 champ ABSENT (API d’avant le lot 7), null ou illisible : pas encore calculé, jamais un niveau inventé', () => {
    for (const v of [undefined, null, 'eleve', 42, [], {}, { niveau: 'eleve' }, { niveau: 'critique', calculeLe: CALCULE }, { niveau: 'eleve', calculeLe: '' }]) {
      expect(risqueLu(v), JSON.stringify(v)).toBeNull();
    }
  });

  it('un niveau mesuré garde son score, ses raisons dans leur ordre et sa date', () => {
    expect(risqueLu({ niveau: 'eleve', score: 72, raisons: ['silence_60j', 'reclamation'], calculeLe: CALCULE }))
      .toEqual({ niveau: 'eleve', score: 72, raisons: ['silence_60j', 'reclamation'], calculeLe: CALCULE });
  });

  it('🔴 « inconnu » n’a JAMAIS de score, même si on lui en envoie un', () => {
    expect(risqueLu({ niveau: 'inconnu', score: 12, raisons: [], calculeLe: CALCULE })?.score).toBeNull();
  });

  it('un score à zéro est une mesure : il reste 0, il ne devient pas « absent »', () => {
    expect(risqueLu({ niveau: 'faible', score: 0, raisons: [], calculeLe: CALCULE })?.score).toBe(0);
  });

  it('des raisons mal formées sont écartées une à une, sans faire tomber le reste', () => {
    expect(risqueLu({ niveau: 'moyen', score: 40, raisons: ['silence_30j', 3, null, ''], calculeLe: CALCULE })?.raisons).toEqual(['silence_30j']);
    expect(risqueLu({ niveau: 'moyen', score: 40, raisons: 'silence_30j', calculeLe: CALCULE })?.raisons).toEqual([]);
  });
});
