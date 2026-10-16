import { describe, it, expect } from 'vitest';
import { lire } from './vitrine-lecture';
import { GENEREES, JUMELLES, dictionnaires, pageAnglaise, type Entree } from '../scripts/vitrine/anglais';

/**
 * LA VITRINE ANGLAISE EST GÉNÉRÉE DEPUIS LA FRANÇAISE (2026-10-16, `scripts/vitrine/anglais.ts`).
 *
 * Chaque page anglaise de `GENEREES` doit être égale, au caractère près, à la traduction de sa jumelle française par les
 * dictionnaires de `scripts/vitrine/anglais/`. Une phrase française changée sans son entrée laisse du français dans la
 * page anglaise : ce test le refuse. Une page anglaise retouchée à la main serait défaite à la génération suivante :
 * ce test le refuse aussi. On traduit dans le dictionnaire, puis `npm run vitrine:anglais`.
 */

const ENTREES = dictionnaires();
const fichier = (adresse: string) => `${adresse.slice(1)}index.html`;
const traductions = GENEREES.map((fr) => ({ fr, t: pageAnglaise(lire(fichier(fr)), fr, ENTREES) }));

describe('chaque page anglaise est la traduction de sa jumelle', () => {
  it('il y a bien des pages et des entrées, sinon ce test ne prouve rien', () => {
    expect(GENEREES.length).toBeGreaterThanOrEqual(11);
    expect(ENTREES.length).toBeGreaterThan(300);
  });

  for (const { fr, t } of traductions) {
    it(`${fr} -> ${JUMELLES[fr]}`, () => expect(t.html, 'npm run vitrine:anglais').toBe(lire(fichier(JUMELLES[fr]!))));
    it(`${fr} : rien ne reste en français`, () => expect(t.restes).toEqual([]));
  }

  it('chaque entrée des dictionnaires sert sur au moins une page', () => {
    const servies = new Set<Entree>(traductions.flatMap(({ t }) => [...t.servies]));
    expect(ENTREES.filter((e) => !servies.has(e)).map((e) => ('fr' in e ? e.fr : e.contexte))).toEqual([]);
  });

  it('garde de la garde : une phrase française ajoutée sans son entrée est vue', () => {
    const fr = '/fonctionnalites/chaines-whatsapp/';
    const retouchee = lire(fichier(fr)).replace('</main>', '<p>Une phrase neuve pour vos clients.</p></main>');
    expect(retouchee).not.toBe(lire(fichier(fr)));
    expect(pageAnglaise(retouchee, fr, ENTREES).restes).toContain('Une phrase neuve pour vos clients.');
  });
});
