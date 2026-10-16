import { describe, it, expect } from 'vitest';
import { lire, pagesHtml } from './vitrine-lecture';
import { enteteVitrine, jumelleDe, normaliserGabarit, pageAvecEntete } from '../scripts/vitrine/entete';

/**
 * L'EN-TÊTE ET LE PIED DE PAGE DE LA VITRINE S'ÉCRIVENT UNE FOIS (lots 6 et 6 bis, tâche 4 du plan
 * `2026-10-16-cas-d-usage-solutions-depot.md`).
 *
 * Ils étaient recopiés à la main dans chaque page : un menu changé se changeait trente fois, et une page oubliée
 * gardait l'ancien. Ils viennent désormais de `scripts/vitrine/` (`npm run vitrine:entete` les réécrit), et chaque page
 * doit être égale, au caractère près, à sa génération. Ce qui varie d'une page à l'autre est calculé : le lien actif
 * (`aria-current`), le groupe du burger qui le contient (ouvert), et le drapeau vers la page jumelle.
 */

const PAGES = pagesHtml();

/** Les adresses des liens d'un fragment, hors logo. */
const adresses = (html: string): string[] =>
  [...html.matchAll(/<a ([^>]*)>/g)].filter((m) => !m[1]!.includes('class="marque"')).map((m) => m[1]!.match(/href="([^"]+)"/)![1]!);

describe('chaque page porte l’en-tête et le pied de page générés', () => {
  it('il y a bien des pages, sinon ce test ne prouve rien', () => expect(PAGES.length).toBeGreaterThan(20));

  for (const page of PAGES) {
    it(page, () => expect(pageAvecEntete(lire(page), page), 'npm run vitrine:entete').toBe(lire(page)));
  }

  it('garde de la garde : un menu retouché à la main dans une page ne passe pas', () => {
    const page = 'fonctionnalites/whatsapp-et-rcs/index.html';
    const retouchee = lire(page).replace('<strong>WhatsApp et RCS</strong>', '<strong>WhatsApp, RCS</strong>');
    expect(retouchee).not.toBe(lire(page));
    expect(pageAvecEntete(retouchee, page)).not.toBe(retouchee);
  });
});

describe('le menu', () => {
  for (const langue of ['fr', 'en'] as const) {
    it(`${langue} : le burger porte les mêmes adresses que le menu de bureau`, () => {
      const entete = enteteVitrine(langue, '/nulle-part/', '/jumelle/');
      const coupe = entete.indexOf('<nav class="nav"');
      expect(coupe).toBeGreaterThan(0);
      expect(new Set(adresses(entete.slice(0, coupe)))).toEqual(new Set(adresses(entete.slice(coupe))));
    });
  }

  it('marque la page active, ouvre son groupe dans le burger, et ne marque jamais le logo ni le drapeau', () => {
    const entete = enteteVitrine('fr', '/fonctionnalites/whatsapp-et-rcs/', '/en/features/whatsapp-and-rcs/');
    expect(entete.match(/href="\/fonctionnalites\/whatsapp-et-rcs\/" aria-current="page"/g)).toHaveLength(2);
    expect(entete).toContain('<details class="burger-groupe" open>');
    for (const accueil of [enteteVitrine('fr', '/', '/en/'), enteteVitrine('en', '/en/', '/')]) {
      expect(accueil).not.toContain('aria-current="page"');
      expect(accueil).not.toContain('<details class="burger-groupe" open>');
    }
  });

  it('insère la jumelle telle quelle, même avec un `$`', () => {
    expect(enteteVitrine('fr', '/', '/en/$&/')).toContain('href="/en/$&/"');
  });
});

describe('la page jumelle', () => {
  it('se lit dans la page ; sans jumelle déclarée, le générateur refuse, sauf pour la page 404', () => {
    const page = '<link rel="alternate" hreflang="en" href="https://app.messagingme.fr/en/contact/">';
    expect(jumelleDe(page, 'contact/index.html')).toBe('/en/contact/');
    expect(() => jumelleDe('<html></html>', 'contact/index.html')).toThrow(/jumelle/);
    expect(jumelleDe('<html></html>', '404.html')).toBe('/en/');
  });

  it('un gabarit enregistré en CRLF est ramené en LF', () => {
    expect(normaliserGabarit('<a>\r\n</a>\r\n')).toBe('<a>\n</a>');
  });
});
