import { describe, it, expect } from 'vitest';
import { plafondDuPalier, avertissementPalier } from '../src/meta/palier';

/**
 * Le palier d'envoi Meta (lot 7 du programme II). Il était relevé, stocké, affiché, et jamais utilisé.
 *
 * 🔴 Ce que ces tests protègent avant tout : le fait qu'on AVERTIT sans jamais REFUSER, et qu'une valeur
 * qu'on ne comprend pas ne produit AUCUN chiffre plutôt qu'un chiffre inventé.
 */
describe('palier d’envoi Meta', () => {
  it('lit les formes que Meta envoie', () => {
    expect(plafondDuPalier('TIER_250')).toBe(250);
    expect(plafondDuPalier('TIER_1K')).toBe(1000);
    expect(plafondDuPalier('TIER_100K')).toBe(100_000);
    expect(plafondDuPalier('tier_10k')).toBe(10_000); // casse indifférente
    expect(plafondDuPalier(' TIER_1K ')).toBe(1000);
  });

  it('🔴 ne conclut RIEN sur ce qu’il ne comprend pas', () => {
    // Un chiffre inventé serait pire que pas de chiffre : l'opérateur prendrait une décision dessus.
    expect(plafondDuPalier('TIER_UNLIMITED')).toBeUndefined();
    expect(plafondDuPalier('TIER_NOUVEAU_FORMAT_META')).toBeUndefined();
    expect(plafondDuPalier(null)).toBeUndefined();
    expect(plafondDuPalier(undefined)).toBeUndefined();
    expect(plafondDuPalier('')).toBeUndefined();
    expect(plafondDuPalier('TIER_0')).toBeUndefined();
  });

  it('avertit quand l’audience dépasse le palier, et se tait sinon', () => {
    // ⚠️ Les nombres sont mis en forme par `toLocaleString('fr-FR')`, qui sépare les milliers par une espace
    // fine INSÉCABLE (U+202F), pas par une espace ordinaire. Comparer à « 5 000 » tapé au clavier échouait.
    // On reconstruit donc l'attendu avec la MÊME mise en forme, sinon le test dépend du build d'ICU.
    expect(avertissementPalier('TIER_1K', 5000)).toContain((5000).toLocaleString('fr-FR'));
    expect(avertissementPalier('TIER_1K', 5000)).toContain((1000).toLocaleString('fr-FR'));
    expect(avertissementPalier('TIER_1K', 1000)).toBeUndefined(); // pile au plafond : rien à dire
    expect(avertissementPalier('TIER_1K', 40)).toBeUndefined();
    expect(avertissementPalier('TIER_UNLIMITED', 500_000)).toBeUndefined();
    expect(avertissementPalier(null, 500_000)).toBeUndefined();
  });

  it('🔴 le message DIT ses trois limites, sinon il serait pris pour une règle', () => {
    // Le palier est un relevé périodique donc périmable ; Meta compte des conversations et non des
    // destinataires ; l'inbox et les scénarios mangent le même budget. Un message qui tairait ça ferait
    // croire à un calcul exact, et quelqu'un finirait par dimensionner ses campagnes dessus.
    const m = avertissementPalier('TIER_1K', 5000)!;
    expect(m).toContain('relevé périodiquement');
    expect(m).toContain('conversations et non des destinataires');
    expect(m).toContain('même budget');
    // Et il dit ce qui va RÉELLEMENT se passer : pause puis reprise, personne n'est perdu.
    expect(m).toContain('pause');
    expect(m).toContain('sans perdre personne');
  });
});
