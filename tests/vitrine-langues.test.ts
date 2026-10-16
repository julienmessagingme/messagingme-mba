import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PAGES } from '../src/http/contact-vitrine';
import { ORIGINE_VITRINE, SITE, adresseDe, lire, pagesHtml } from './vitrine-lecture';

/**
 * LA VITRINE EN DEUX LANGUES (2026-10-16). Chaque page française a sa jumelle anglaise sous `/en/`, et le drapeau de
 * chacune mène à l'autre. Rien ne relie les deux exemplaires sinon ce test : une page ajoutée d'un seul côté, un drapeau
 * qui pointe dans le vide ou un hreflang à sens unique ne cassent rien de visible, ils font seulement perdre la page
 * aux moteurs ou le visiteur au clic.
 *
 * ⚠️ Les pages anglaises sont rangées un étage plus bas que leurs sources : un chemin RELATIF recopié de l'accueil
 * (`favicon.svg`, une image) y viserait `/en/favicon.svg`, qui n'existe pas. D'où l'interdiction, sous `/en/`, de tout
 * chemin qui ne commence pas par `/`.
 */

const JUMELLES: Record<string, string> = {
  'index.html': 'en/index.html',
  'fonctionnalites/whatsapp-et-rcs/index.html': 'en/features/whatsapp-and-rcs/index.html',
  'fonctionnalites/campagnes-et-scenarios/index.html': 'en/features/campaigns-and-scenarios/index.html',
  'fonctionnalites/chaines-whatsapp/index.html': 'en/features/whatsapp-channels/index.html',
  'fonctionnalites/conversations-en-actions/index.html': 'en/features/conversations-into-actions/index.html',
  'fonctionnalites/publicites-click-to-whatsapp/index.html': 'en/features/click-to-whatsapp-ads/index.html',
  'fonctionnalites/pilotage-des-couts/index.html': 'en/features/cost-control/index.html',
  'industries/index.html': 'en/industries/index.html',
  'pricing/index.html': 'en/pricing/index.html',
  'developpeurs/index.html': 'en/developers/index.html',
  'contact/index.html': 'en/contact/index.html',
  'contact/merci/index.html': 'en/contact/thanks/index.html',
};

/** Le chemin qu'un lien vise : `index.html` -> `/`, `en/contact/index.html` -> `/en/contact/`. */
const chemin = (page: string) => adresseDe(page).slice(ORIGINE_VITRINE.length);
const anglaises = () => pagesHtml().filter((p) => p.startsWith('en/'));

describe('chaque page a sa jumelle, et elles se déclarent l’une l’autre', () => {
  it('toute page française a sa jumelle, et toute page anglaise est la jumelle d’une page française', () => {
    const francaises = pagesHtml().filter((p) => !p.startsWith('en/') && p !== '404.html');
    expect(new Set(francaises)).toEqual(new Set(Object.keys(JUMELLES)));
    expect(new Set(anglaises())).toEqual(new Set(Object.values(JUMELLES)));
  });

  for (const [fr, en] of Object.entries(JUMELLES)) {
    it(`${fr} et ${en}`, () => {
      const [hFr, hEn] = [lire(fr), lire(en)];
      expect(hFr).toContain('<html lang="fr">');
      expect(hEn).toContain('<html lang="en">');
      for (const html of [hFr, hEn]) {
        expect(html).toContain(`<link rel="alternate" hreflang="fr" href="${adresseDe(fr)}">`);
        expect(html).toContain(`<link rel="alternate" hreflang="en" href="${adresseDe(en)}">`);
        expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${adresseDe(fr)}">`);
      }
      expect(hFr).toContain(`<link rel="canonical" href="${adresseDe(fr)}">`);
      expect(hEn).toContain(`<link rel="canonical" href="${adresseDe(en)}">`);
      // Le drapeau de chaque page mène à SA jumelle, pas à l'accueil de l'autre langue.
      expect(hFr).toMatch(new RegExp(`<a class="langue" href="${chemin(en)}" hreflang="en"`));
      expect(hEn).toMatch(new RegExp(`<a class="langue" href="${chemin(fr)}" hreflang="fr"`));
    });
  }
});

describe('les liens et les fichiers', () => {
  const VISEURS = /\s(?:href|src|poster|data-vertical|data-affiche-verticale)="([^"]*)"/g;

  it('chaque lien et chaque fichier interne de chaque page existe', () => {
    for (const page of pagesHtml()) {
      for (const m of lire(page).matchAll(VISEURS)) {
        const c = /^(\/[^?#]*)/.exec(m[1]!)?.[1];
        if (!c) continue;
        const fichier = c.endsWith('/') ? join(SITE, c, 'index.html') : join(SITE, c);
        expect(existsSync(fichier), `${page} -> ${c}`).toBe(true);
      }
    }
  });

  it('sous `/en/`, aucun chemin relatif : il viserait un fichier sous `/en/`', () => {
    for (const page of anglaises()) {
      for (const m of lire(page).matchAll(VISEURS)) {
        expect(m[1], page).toMatch(/^(\/|#|[a-z][a-z0-9+.-]*:)/i);
      }
    }
  });

  it('une page anglaise ne mène à une page française que par un lien qui le dit (`hreflang="fr"`)', () => {
    for (const page of anglaises()) {
      for (const [balise, c] of lire(page).matchAll(/<a\s[^>]*href="(\/[^"#?]*)[^"]*"[^>]*>/g)) {
        if (c!.startsWith('/en/') || /\.\w+$/.test(c!)) continue;
        expect(balise, `${page} -> ${c}`).toContain('hreflang="fr"');
      }
    }
  });

  it('une page anglaise ouvre la console en anglais', () => {
    for (const page of anglaises()) {
      for (const [, l] of lire(page).matchAll(/href="(https:\/\/console\.messagingme\.app[^"]*)"/g)) {
        expect(new URL(l!.replace(/&amp;/g, '&')).searchParams.get('lang'), `${page} -> ${l}`).toBe('en');
      }
    }
  });

  it('le formulaire anglais dit sa langue à l’API, DANS le formulaire qui poste, le français non', () => {
    const formulaire = /<form class="c-form"[^>]*>[\s\S]*?<\/form>/.exec(lire('en/contact/index.html'))?.[0] ?? '';
    expect(formulaire).toContain('action="https://api.messagingme.app/vitrine/contact"');
    expect(formulaire).toContain('<input type="hidden" name="langue" value="en">');
    expect(lire('contact/index.html')).not.toContain('name="langue"');
  });

  it('chaque page où l’API renvoie le visiteur existe (`PAGES`, src/http/contact-vitrine.ts)', () => {
    // Écrites en dur chez l'API : une page renommée ferait aboutir une demande bien envoyée sur la 404.
    for (const pages of Object.values(PAGES)) {
      for (const c of Object.values(pages)) expect(existsSync(join(SITE, c, 'index.html')), c).toBe(true);
    }
  });

  it('une page anglaise charge la bulle anglaise (« Got a question? »), jamais la française', () => {
    // Deux widgets de l'espace de la vitrine : leurs textes se règlent dans la console, pas dans la page.
    for (const page of anglaises()) expect(lire(page), page).not.toContain('/widget/ndabjvs20vc4.js');
    expect(lire('en/index.html')).toContain('<script src="https://api.messagingme.app/widget/dyzfezy33kcx.js" async></script>');
  });

  it('aucun tiret long, ni cadratin ni demi-cadratin, dans aucune page', () => {
    for (const page of pagesHtml()) expect(lire(page), page).not.toMatch(/[–—]|&mdash;|&ndash;|&#821[12];/);
  });
});

describe('ce que lisent les moteurs', () => {
  it('le plan du site cite exactement les pages indexables, dans les deux langues', () => {
    const indexables = pagesHtml().filter((p) => p !== '404.html' && !/<meta name="robots" content="[^"]*noindex/.test(lire(p)));
    const cites = [...lire('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(new Set(cites)).toEqual(new Set(indexables.map(adresseDe)));
    expect(cites.length).toBe(new Set(cites).size);
  });

  it('chaque page anglaise qui a une carte de partage s’y déclare en anglais', () => {
    // Les deux pages en attente (industries, tarifs) n'ont de carte dans aucune langue.
    const avecCarte = anglaises().filter((p) => lire(p).includes('property="og:'));
    expect(avecCarte.length).toBeGreaterThanOrEqual(10);
    for (const page of avecCarte) expect(lire(page), page).toContain('<meta property="og:locale" content="en_US">');
  });
});
