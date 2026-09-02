import { describe, it, expect } from 'vitest';
import { refusDePlafond, PLAFOND_DESTINATAIRES_DEFAUT } from '../src/campaign/plafond';

/**
 * LA RÈGLE DU PLAFOND (lot 3 du plan post-audit, 2026-09-02). Le câblage sur les trois chemins de ciblage est
 * testé dans `http-campaigns.test.ts` ; ici, la borne et le message.
 */
describe('refusDePlafond', () => {
  it('la borne est INCLUSIVE : pile le plafond passe, un de plus non', () => {
    expect(refusDePlafond(10, 10)).toBeNull();
    expect(refusDePlafond(11, 10)).not.toBeNull();
  });

  it('le refus porte les DEUX nombres', () => {
    // Un refus qui dirait seulement « trop de destinataires » obligerait l'opérateur à deviner de combien il
    // dépasse et où est la limite, donc à réessayer à l'aveugle.
    const message = refusDePlafond(25_000, 20_000)!;
    expect(message.replace(/[^0-9]/g, '')).toContain('25000');
    expect(message.replace(/[^0-9]/g, '')).toContain('20000');
  });

  it('le défaut est le chiffre de Julien', () => {
    expect(PLAFOND_DESTINATAIRES_DEFAUT).toBe(20_000);
  });

  it('zéro destinataire n’est pas un dépassement (ce refus-là est ailleurs)', () => {
    // Une sélection vide est refusée plus haut dans la route, avec son propre message : ce n'est pas un
    // problème de taille, et le dire ici brouillerait les deux causes.
    expect(refusDePlafond(0, 20_000)).toBeNull();
  });
});
