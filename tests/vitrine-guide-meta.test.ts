import { describe, it, expect } from 'vitest';
import { ETAPES_CARTE_META, PREREQUIS_META } from '../web/lib/partage/etapes-meta';
import { PAGES_GUIDE, pageAvecGuide } from '../scripts/vitrine/guide-meta';
import { lire, texte } from './vitrine-lecture';

/**
 * LE GUIDE « VOTRE COMPTE META BUSINESS, PAS À PAS » (Julien, 2026-10-19). C'est le compte qui fait passer un numéro par
 * l'API officielle, et la page Développeurs y renvoie : ses étapes sont celles que la console et Claude donnent, écrites
 * une fois dans `web/lib/partage/etapes-meta.ts`.
 */
describe('le guide Meta Business de la vitrine', () => {
  for (const { chemin, langue } of PAGES_GUIDE) {
    it(`${chemin} : ses étapes sont celles d’etapes-meta.ts, égales à leur génération (npm run vitrine:guide-meta)`, () => {
      const html = lire(chemin);
      expect(pageAvecGuide(html, langue)).toBe(html);
      // Les espaces insécables que la page pose en français ne comptent pas.
      const lu = texte(html).split(String.fromCharCode(160)).join(' ');
      for (const e of [...PREREQUIS_META, ...ETAPES_CARTE_META]) expect(lu).toContain(e[langue].slice(0, 60));
    });

    it(`${chemin} : il mène à l’installation du plugin`, () => {
      expect(lire(chemin)).toContain(langue === 'fr' ? 'href="/developpeurs/#demarrer"' : 'href="/en/developers/#demarrer"');
    });
  }

  it('🔴 la promesse « un compte Meta Business » de la page Développeurs mène au guide, dans les deux langues', () => {
    expect(lire('developpeurs/index.html')).toContain('<li>Il vous faut seulement <a href="/developpeurs/compte-meta-business/">');
    expect(lire('en/developers/index.html')).toContain('<li>All you need is <a href="/en/developers/meta-business-account/">');
  });

  it('le titre de la page Développeurs dit que c’est gratuit, dans les deux langues', () => {
    expect(lire('developpeurs/index.html')).toContain('<span class="dev-gratuit">Gratuit et sans abonnement</span></span>');
    expect(lire('en/developers/index.html')).toContain('<span class="dev-gratuit">Free, no subscription</span></span>');
  });
});
