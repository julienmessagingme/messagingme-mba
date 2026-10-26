import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { aideMotDePasse } from './mot-de-passe';
import { MIN_MOT_DE_PASSE } from './partage/mot-de-passe';

/**
 * L'arrimage du minimum affiché à celui que le serveur applique.
 *
 * 🔴 CE TEST EST NÉ D'UNE DÉRIVE RÉELLE, PAS D'UNE PRÉCAUTION. Le 2026-09-10, le serveur est passé de 8 à
 * 12 et les quatre écrans qui posent un mot de passe annonçaient toujours 8, avec un `minLength` qui
 * laissait le navigateur accepter avant que le serveur ne refuse. Ce n'est pas une faute d'inattention :
 * rien ne reliait ces écrans à la constante, et un nombre écrit dans un attribut JSX n'est visible d'aucun
 * compilateur. C'est le hook « rayon de souffle » qui l'a trouvé, en demandant qui cite la valeur ailleurs.
 *
 * La valeur est désormais lue au même endroit par le serveur et la console (`web/lib/partage/mot-de-passe.ts`) : il
 * reste à vérifier que l'aide l'annonce, et qu'aucun écran ne réécrit le nombre à la main.
 */
describe('mot de passe — alignement avec le serveur', () => {
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
