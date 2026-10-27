import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DROITS, PRIX_BUSINESS_HT_CENTIMES, PRIX_PRO_HT_CENTIMES } from '../src/offres/offres';
import { lire, pagesHtml, parAttribut, texte } from './vitrine-lecture';

/**
 * CE QUE LISENT LES MOTEURS ET LES ASSISTANTS IA, gardé sur toute la vitrine (plan
 * docs/superpowers/plans/2026-10-26-seo-geo-vitrine.md, lot 1).
 *
 * 🔴 POURQUOI UN TEST. Chacun de ces points est une seconde copie d'une chose écrite ailleurs : la question d'une FAQ
 * et son balisage, la phrase de définition dans le pied de page, le JSON-LD et `llms.txt`, le prix du Pro dans le code
 * et dans le JSON-LD. Une copie qu'aucun test ne compare dérive sans bruit, et un moteur lit alors deux versions.
 *
 * ⚠️ Les « 30 secondes » des titres de film ne sont PAS gardés ici, et c'est voulu : c'est une promesse (« ça va
 * vite »), pas une mesure (Julien, 2026-10-26).
 */

const PAGES = pagesHtml();

/** Les blocs JSON-LD d'une page, tels quels. */
const blocsLd = (html: string): string[] =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

type Noeud = Record<string, unknown>;

/** Les nœuds d'un bloc JSON-LD, `@graph` déplié. */
function noeuds(html: string): Noeud[] {
  return blocsLd(html).flatMap((b) => {
    const ld = JSON.parse(b) as Noeud;
    return Array.isArray(ld['@graph']) ? (ld['@graph'] as Noeud[]) : [ld];
  });
}

/** Le texte comparable : balises retirées, entités décodées, espaces insécables et retours ramenés à une espace. */
const plat = (s: string): string => texte(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

const indexable = (html: string): boolean => !/<meta name="robots" content="noindex">/.test(html);

describe('les données structurées de la vitrine', () => {
  it('il y a bien des pages, sinon ce test ne prouve rien', () => expect(PAGES.length).toBeGreaterThan(50));

  it('chaque bloc JSON-LD de chaque page se lit', () => {
    const illisibles = PAGES.flatMap((p) => blocsLd(lire(p)).flatMap((b) => {
      try { JSON.parse(b); return []; } catch { return [p]; }
    }));
    expect(illisibles).toEqual([]);
  });

  it('les questions d’une FAQ balisée sont exactement celles que la page affiche, dans le même ordre', () => {
    const avecFaq = PAGES.filter((p) => noeuds(lire(p)).some((n) => n['@type'] === 'FAQPage'));
    // La garde de la garde : sans pages à FAQ, la boucle ne vérifierait rien.
    expect(avecFaq.length).toBeGreaterThan(10);
    for (const p of avecFaq) {
      const html = lire(p);
      const faq = noeuds(html).find((n) => n['@type'] === 'FAQPage')!;
      const balisees = (faq.mainEntity as Noeud[]).map((q) => plat(String(q.name)));
      const affichees = [...html.matchAll(/<div class="dev-faq">([\s\S]*?)<\/div>/g)]
        .flatMap((m) => [...m[1]!.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((s) => plat(s[1]!)));
      expect(balisees, p).toEqual(affichees);
    }
  });

  // La réponse balisée est le texte affiché, mot pour mot, sur toute page à FAQ. Sauf les deux pages développeurs :
  // leur FAQ affiche une adresse sans `https://` que son balisage écrit en entier, et c'est voulu.
  const ADRESSE_ENTIERE = new Set(['developpeurs/index.html', 'en/developers/index.html']);
  it('les réponses d’une FAQ balisée sont aussi celles qui s’affichent', () => {
    const verifiees = PAGES.filter((p) => !ADRESSE_ENTIERE.has(p) && noeuds(lire(p)).some((n) => n['@type'] === 'FAQPage'));
    // L'accueil et les six fonctionnalités, dans les deux langues, au moins.
    expect(verifiees).toEqual(expect.arrayContaining(['index.html', 'en/index.html', 'fonctionnalites/whatsapp-et-rcs/index.html',
      'en/features/whatsapp-and-rcs/index.html']));
    for (const p of verifiees) {
      const html = lire(p);
      const faq = noeuds(html).find((n) => n['@type'] === 'FAQPage')!;
      const balisees = (faq.mainEntity as Noeud[]).map((q) => plat(String((q.acceptedAnswer as Noeud).text)));
      const affichees = [...html.matchAll(/<div class="dev-faq">([\s\S]*?)<\/div>/g)]
        .flatMap((m) => [...m[1]!.matchAll(/<details[^>]*><summary[^>]*>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/g)].map((s) => plat(s[1]!)));
      expect(balisees, p).toEqual(affichees);
    }
  });
});

describe('les chiffres de l’accueil', () => {
  // Les mêmes clés que la page des tarifs (tests/vitrine-pages.test.ts), limitées à celles que l'accueil cite.
  const ATTENDU: Record<string, number> = {
    'base.envois-modeles-mois': DROITS.base.limites.envoisModelesMois ?? Number.NaN,
    'pro.prix-mois': PRIX_PRO_HT_CENTIMES.mois / 100,
    'business.prix-mois': PRIX_BUSINESS_HT_CENTIMES.mois / 100,
  };
  for (const page of ['index.html', 'en/index.html']) {
    it(`🔴 ${page} : chaque chiffre marqué data-offre vaut ce que dit le code`, () => {
      const marques = parAttribut(lire(page), 'data-offre');
      expect(marques.map((m) => m.valeur).sort()).toEqual(Object.keys(ATTENDU).sort());
      for (const { valeur, contenu } of marques) expect(Number(texte(contenu).replace(/\D/g, '')), valeur).toBe(ATTENDU[valeur]);
    });
  }
});

describe('la phrase de définition, la même partout', () => {
  const definitionDuPied = (langue: 'fr' | 'en'): string => {
    const pied = readFileSync(resolve(__dirname, '..', 'scripts', 'vitrine', `pied.${langue}.html`), 'utf8');
    const m = /<p class="pied-definition">([\s\S]*?)<\/p>/.exec(pied);
    expect(m, `pied.${langue}.html sans phrase de définition`).not.toBeNull();
    return plat(m![1]!);
  };
  const definitionDeLOrganisation = (page: string): string =>
    plat(String(noeuds(lire(page)).find((n) => n['@type'] === 'Organization')?.description ?? ''));

  it('en français : le pied de page, l’Organization de l’accueil et le résumé de llms.txt', () => {
    const pied = definitionDuPied('fr');
    expect(pied.startsWith('Messaging Me est une plateforme')).toBe(true);
    expect(definitionDeLOrganisation('index.html')).toBe(pied);
    const resume = lire('llms.txt').split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2)).join(' ');
    expect(plat(resume)).toBe(pied);
  });

  it('en anglais : le pied de page et l’Organization de l’accueil', () => {
    const pied = definitionDuPied('en');
    expect(pied.startsWith('Messaging Me is a')).toBe(true);
    expect(definitionDeLOrganisation('en/index.html')).toBe(pied);
  });
});

describe('les descriptions des pages', () => {
  it('aucune page indexable n’a une description de plus de 160 caractères (les moteurs la coupent)', () => {
    const longues = PAGES.flatMap((p) => {
      const html = lire(p);
      const m = /<meta name="description" content="([^"]*)">/.exec(html);
      if (!m || !indexable(html)) return [];
      const n = [...plat(m[1]!)].length;
      return n > 160 ? [`${p} (${n})`] : [];
    });
    expect(longues).toEqual([]);
  });
});

describe('les prix du JSON-LD', () => {
  it('🔴 valent ceux du code (PRIX_PRO_HT_CENTIMES), sur l’accueil comme sur les tarifs', () => {
    const vues: string[] = [];
    for (const p of PAGES) {
      for (const n of noeuds(lire(p)).filter((x) => x['@type'] === 'SoftwareApplication' && Array.isArray(x.offers))) {
        vues.push(p);
        for (const o of n.offers as Noeud[]) {
          const spec = o.priceSpecification as Noeud | undefined;
          const attendu = o.name === 'Free' ? 0
            : o.name === 'Business' ? PRIX_BUSINESS_HT_CENTIMES.mois / 100
            : spec?.billingDuration === 'P1M' ? PRIX_PRO_HT_CENTIMES.mois / 100
              : spec?.billingDuration === 'P1Y' ? PRIX_PRO_HT_CENTIMES.an / 100
                : Number.NaN;
          expect(Number(o.price), `${p} : ${String(o.name)} ${String(spec?.billingDuration ?? '')}`).toBe(attendu);
          if (spec) expect(Number(spec.price), `${p} : priceSpecification`).toBe(attendu);
        }
      }
    }
    expect(vues).toEqual(expect.arrayContaining(['index.html', 'tarifs/index.html', 'en/index.html', 'en/pricing/index.html']));
  });
});
