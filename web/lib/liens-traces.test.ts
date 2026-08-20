import { describe, it, expect } from 'vitest';
import { libelleLien, largeurBarre, type LienTraceAvecClics } from './liens-traces';

const lien = (over: Partial<LienTraceAvecClics> = {}): LienTraceAvecClics => ({
  code: 'ab12cd34ef56',
  templateName: 'promo',
  templateLanguage: 'fr',
  cardIndex: null,
  buttonIndex: 0,
  destination: 'https://client.fr/promo',
  clics: 12,
  ...over,
});

describe('libelleLien', () => {
  it('nomme par le template et la POSITION du bouton', () => {
    // Le libellé du bouton vit chez Meta, pas dans notre table : on nomme par ce dont on est sûr.
    expect(libelleLien(lien())).toBe('promo · bouton 1');
    expect(libelleLien(lien({ buttonIndex: 1 }))).toBe('promo · bouton 2');
  });

  it('un bouton de carousel dit sa carte', () => {
    expect(libelleLien(lien({ cardIndex: 2, buttonIndex: 0 }))).toBe('promo · carte 3, bouton 1');
  });

  it('🔴 deux boutons du MÊME template restent discernables', () => {
    // C'est ce qui a fait abandonner l'histogramme pour cette carte : il tronquait les titres à une
    // quinzaine de caractères, et deux boutons d'un template au nom long devenaient identiques à l'écran.
    const a = libelleLien(lien({ templateName: 'relance_campagne_longue', buttonIndex: 0 }));
    const b = libelleLien(lien({ templateName: 'relance_campagne_longue', buttonIndex: 1 }));
    expect(a).not.toBe(b);
  });
});

describe('largeurBarre', () => {
  it('proportionnelle au plus cliqué', () => {
    expect(largeurBarre(50, 100)).toBe(50);
    expect(largeurBarre(100, 100)).toBe(100);
  });

  it('🔴 une valeur non nulle garde une barre VISIBLE', () => {
    // Sinon « 1 clic sur 5000 » se dessine comme « aucun », et une barre invisible se lit comme une mesure
    // absente alors que quelqu'un a bel et bien cliqué.
    expect(largeurBarre(1, 5000)).toBe(4);
  });

  it('zéro reste zéro : aucun clic est une information, pas un détail d’affichage', () => {
    expect(largeurBarre(0, 100)).toBe(0);
  });

  it('ne divise jamais par zéro', () => {
    expect(largeurBarre(0, 0)).toBe(0);
    expect(largeurBarre(5, 0)).toBe(0);
  });
});
