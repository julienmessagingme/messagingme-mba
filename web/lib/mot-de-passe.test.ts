import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { MIN_MOT_DE_PASSE, aideMotDePasse } from './mot-de-passe';

/**
 * L'arrimage du minimum affiché à celui que le serveur applique.
 *
 * 🔴 CE TEST EST NÉ D'UNE DÉRIVE RÉELLE, PAS D'UNE PRÉCAUTION. Le 2026-09-10, le serveur est passé de 8 à
 * 12 et les quatre écrans qui posent un mot de passe annonçaient toujours 8, avec un `minLength` qui
 * laissait le navigateur accepter avant que le serveur ne refuse. Ce n'est pas une faute d'inattention :
 * rien ne reliait ces écrans à la constante, et un nombre écrit dans un attribut JSX n'est visible d'aucun
 * compilateur. C'est le hook « rayon de souffle » qui l'a trouvé, en demandant qui cite la valeur ailleurs.
 *
 * Le test DÉRIVE la valeur du fichier serveur plutôt que de la recopier : une copie ne ferait que déplacer
 * la dérive d'un fichier à l'autre. Même idiome que `web/lib/nuage.test.ts` pour l'échelle des notes.
 */
describe('mot de passe — alignement avec le serveur', () => {
  it('🔴 MIN_MOT_DE_PASSE vaut le MIN_PASSWORD de src/auth/routes.ts', async () => {
    const src = await readFile(new URL('../../src/auth/routes.ts', import.meta.url), 'utf8');
    const m = src.match(/const MIN_PASSWORD = (\d+);/);
    // Sans cette ligne, un renommage côté serveur rendrait zéro correspondance et le test passerait en ne
    // vérifiant rien : la panne qu'une sonde attrape le moins bien est la sienne.
    expect(m, 'MIN_PASSWORD n’a pas été lu dans le serveur : ce test ne garde plus rien').not.toBeNull();
    expect(MIN_MOT_DE_PASSE).toBe(Number(m![1]));
  });

  it('l’aide annonce le nombre, et AUCUNE règle de composition', () => {
    // Exiger une majuscule ou un chiffre pousse à `Password1!` et raccourcit ce que les gens choisissent.
    // Si une telle règle apparaissait un jour côté serveur, ce texte devrait changer avec elle.
    const aide = aideMotDePasse();
    expect(aide.fr).toContain(String(MIN_MOT_DE_PASSE));
    expect(aide.en).toContain(String(MIN_MOT_DE_PASSE));
    expect(aide.fr).not.toMatch(/majuscule|chiffre|symbole/i);
    expect(aide.en).not.toMatch(/uppercase|digit|symbol/i);
  });

  it('🔴 aucun écran ne réécrit le nombre à la main', async () => {
    // C'est l'inventaire que le test remplace : quatre écrans posent un mot de passe, et c'est le genre de
    // liste qui dérive dès qu'on en ajoute un cinquième. On ne les énumère donc pas, on interdit le motif.
    for (const chemin of ['compte/page.tsx', 'signup/page.tsx', 'invite/[token]/page.tsx', 'reset/[token]/page.tsx']) {
      const src = await readFile(new URL(`../app/${chemin}`, import.meta.url), 'utf8');
      expect(src, `${chemin} : minLength en dur`).not.toMatch(/minLength=\{\d+\}/);
      expect(src, `${chemin} : longueur écrite dans le texte`).not.toMatch(/\d+ caractères min|\d+ characters/);
    }
  });
});
