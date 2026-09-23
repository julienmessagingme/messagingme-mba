import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * L'EN-TÊTE NE DOIT JAMAIS AFFICHER UN ZÉRO QU'IL N'A PAS MESURÉ.
 *
 * C'est la seule propriété de ce composant qui, si elle se perd, produit un mensonge à l'écran plutôt qu'un
 * défaut visible. Elle tient dans une garde `messages30j !== null` : ce test vérifie qu'elle est là, et que
 * personne ne l'a remplacée par un `?? 0` au premier avertissement de typage.
 */
const SRC = readFileSync(join(resolve(__dirname, '..'), 'web', 'components', 'EnteteAgent.tsx'), 'utf8');

describe('EnteteAgent', () => {
  it('🔴 n affiche le chiffre QUE s il est connu', () => {
    expect(SRC).toContain('messages30j !== null');
    expect(SRC, 'un `?? 0` transformerait « on ne sait pas » en « personne n a parlé »')
      .not.toMatch(/messages30j\s*\?\?\s*0/);
  });

  it('🔴 le ratio n est rendu que s il existe vraiment', () => {
    // Le dénominateur n'existe pas côté agent IA : le rendre systématiquement obligerait à en inventer un.
    expect(SRC).toContain('ratio !== undefined');
  });

  it('⚠️ une étape sans onglet reste affichée', () => {
    expect(SRC).toContain('e.onglet === undefined');
  });
});
