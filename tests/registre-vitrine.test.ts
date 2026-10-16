import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ENTREES, PROFILS, entreesEnLigne } from '../web/lib/registre-vitrine';
import { GROUPES_DOC, PAGES_DOC } from '../web/lib/doc-api-pages';
import { SITE, lire, pagesHtml } from './vitrine-lecture';

/**
 * LE REGISTRE DE LA VITRINE DIT CE QUI EXISTE, DANS LES DEUX SENS (lots 6 et 6 bis, spec
 * `2026-10-16-cas-d-usage-par-profil-design.md`, § « Enrichir sans désordre »).
 *
 * Une entrée en ligne a ses deux pages ; une entrée hors ligne n'a ni page ni lien entrant ; et une page de cas ou de
 * Solutions posée dans `site/` sans entrée rend ce test rouge. C'est ce qui empêche une page orpheline, un carrefour
 * qui lie dans le vide ou une adresse inventée à côté de la spec.
 */

/** Les rubriques que le registre gouverne : leur carrefour est à leur racine, chaque sous-dossier est une entrée. */
const RUBRIQUES = ['cas-d-usage', 'solutions', 'en/use-cases', 'en/solutions'];

const fichierDe = (adresse: string): string => join(SITE, adresse, 'index.html');

/**
 * Ce que la vitrine publie et qui peut citer une page : chaque page, le plan du site et `llms.txt`. Lu BRUT : une
 * adresse se cite sans barre finale, en absolu, dans un JSON-LD ou un `og:url`, et Vercel ramène chacune de ces formes à
 * la page ; chercher l'adresse sans sa barre finale les attrape toutes, au risque d'un rouge de trop, jamais d'un vert.
 */
const PUBLIES = [...pagesHtml(), 'sitemap.xml', 'llms.txt'];

/** Tous les fichiers sous une rubrique, en chemins relatifs à `site/`. */
function fichiersSous(rubrique: string): string[] {
  const dossier = join(SITE, rubrique);
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier, { recursive: true, encoding: 'utf8' })
    .map((p) => `${rubrique}/${p.split('\\').join('/')}`)
    .filter((p) => !statSync(join(SITE, p)).isDirectory());
}

describe('le registre de la vitrine', () => {
  it('porte les sept cas et les cinq pages Solutions de la spec', () => {
    expect(ENTREES.filter((e) => e.nature === 'cas')).toHaveLength(7);
    expect(ENTREES.filter((e) => e.nature === 'secteur')).toHaveLength(3);
    expect(ENTREES.filter((e) => e.nature === 'metier')).toHaveLength(2);
  });

  it('ne répète ni une clé, ni une adresse, ni une recherche visée', () => {
    const uniques = (valeurs: string[]) => expect(new Set(valeurs).size).toBe(valeurs.length);
    uniques(ENTREES.map((e) => e.cle));
    uniques(ENTREES.flatMap((e) => [e.fr.adresse, e.en.adresse]));
    uniques(ENTREES.map((e) => e.recherche));
  });

  it('range chaque adresse sous la rubrique de sa nature', () => {
    for (const e of ENTREES) {
      const [fr, en] = e.nature === 'cas' ? ['/cas-d-usage/', '/en/use-cases/'] : ['/solutions/', '/en/solutions/'];
      expect(e.fr.adresse, e.cle).toMatch(new RegExp(`^${fr}[a-z0-9-]+/$`));
      expect(e.en.adresse, e.cle).toMatch(new RegExp(`^${en}[a-z0-9-]+/$`));
    }
  });

  it('donne des profils aux cas, et à eux seuls', () => {
    for (const e of ENTREES) {
      if (e.nature === 'cas') expect(e.profils.length, e.cle).toBeGreaterThan(0);
      else expect(e.profils, e.cle).toEqual([]);
      for (const p of e.profils) expect(PROFILS, e.cle).toContain(p);
    }
  });

  it('donne un guide à tout cas qui demande du code', () => {
    for (const e of ENTREES.filter((x) => x.nature === 'cas' && x.chemin === 'code')) expect(e.guide, e.cle).toBeTruthy();
  });

  it('range sous « Recettes » chaque guide du registre déjà écrit dans la doc', () => {
    expect(GROUPES_DOC.find((g) => g.cle === 'recettes')?.titre).toEqual(['Recettes', 'Recipes']);
    const guides = new Set(ENTREES.flatMap((e) => (e.guide ? [`/developers/api/guides/${e.guide}`] : [])));
    const ecrits = PAGES_DOC.filter((p) => guides.has(p.href));
    expect(ecrits.length, 'la recette Next.js, guide des notifications, existe déjà').toBeGreaterThan(0);
    for (const p of ecrits) expect(p.groupe, p.href).toBe('recettes');
  });

  it('une entrée en ligne a ses deux pages', () => {
    for (const e of entreesEnLigne()) {
      expect(existsSync(fichierDe(e.fr.adresse)), e.fr.adresse).toBe(true);
      expect(existsSync(fichierDe(e.en.adresse)), e.en.adresse).toBe(true);
    }
  });

  it('une entrée hors ligne n’a ni page ni lien entrant, sous aucune forme', () => {
    const horsLigne = ENTREES.filter((e) => !e.enLigne).flatMap((e) => [e.fr.adresse, e.en.adresse]);
    for (const a of horsLigne) expect(existsSync(fichierDe(a)), a).toBe(false);
    for (const fichier of PUBLIES) {
      const brut = lire(fichier);
      for (const a of horsLigne) expect(brut.includes(a.replace(/\/$/, '')), `${fichier} cite ${a}, hors ligne`).toBe(false);
    }
  });

  it('toute page sous une rubrique est le carrefour ou la page d’une entrée', () => {
    const permis = new Set(ENTREES.flatMap((e) => [e.fr.adresse, e.en.adresse]).map((a) => `${a.slice(1)}index.html`));
    for (const rubrique of RUBRIQUES) {
      for (const f of fichiersSous(rubrique).filter((x) => x.endsWith('.html'))) {
        if (f === `${rubrique}/index.html`) continue;
        expect(permis, `site/${f} n’est ni un carrefour ni la page d’une entrée du registre`).toContain(f);
      }
    }
  });
});
