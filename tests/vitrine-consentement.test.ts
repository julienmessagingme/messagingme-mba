import { describe, it, expect } from 'vitest';
import { lire, pagesHtml } from './vitrine-lecture';

/**
 * LE PIXEL DE META NE PART QU'AVEC L'ACCORD DU VISITEUR (lot 1 du plan docs/superpowers/plans/2026-10-30-pixel-meta.md).
 * Le script de Meta n'est chargé que par `site.js`, dans la fonction appelée sur « Accepter » ou sur un accord encore
 * valide : une page qui le citerait elle-même le chargerait avant toute question, en silence. Le comportement dans un
 * vrai navigateur (rien vers Facebook avant l'accord, `PageView` après, retrait) se vérifie par Playwright avant chaque
 * push qui touche ce bloc ; ce test tient ce qu'un navigateur ne regarde pas : aucune page ne contourne la bannière.
 */
describe('le pixel de Meta, derrière la bannière', () => {
  const js = lire('site.js');

  it('aucune page ne charge le script de Meta elle-même', () => {
    for (const page of pagesHtml()) {
      expect(lire(page), page).not.toMatch(/connect\.facebook\.net|fbevents|fbq\(/);
    }
  });

  it('site.js le charge à un seul endroit, avec un seul identifiant de pixel', () => {
    expect(js.match(/connect\.facebook\.net\/en_US\/fbevents\.js/g)).toHaveLength(1);
    expect(js.match(/var PIXEL = '[0-9]*';/g)).toHaveLength(1);
    // L'appel qui charge le pixel au démarrage n'existe que pour un accord relu et encore valide.
    expect(js).toContain("if (choix === 'accepte') charger();");
  });

  it('chaque page porte le bouton « Gérer les cookies », caché sans script', () => {
    for (const page of pagesHtml()) {
      expect(lire(page), page).toMatch(
        /<li data-cookies hidden><button type="button" class="pied-cookies">(Gérer les cookies|Manage cookies)<\/button><\/li>/,
      );
    }
  });

  it('la bannière nomme Meta dans les deux langues, sans tiret long', () => {
    expect(js.match(/pixel de Meta \(Facebook\)|Meta \(Facebook\) pixel/g)).toHaveLength(2);
    expect(js).not.toMatch(/[–—]/);
  });
});
