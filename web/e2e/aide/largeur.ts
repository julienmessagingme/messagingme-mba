import { expect, type Page } from '@playwright/test';

/** L'écran de référence : un portable 13 pouces. Pas une supposition, la demande de Julien. */
export const TREIZE_POUCES = { width: 1280, height: 800 };

/**
 * Aucun débordement horizontal, et aucun chevauchement entre les blocs nommés.
 *
 * 🔴 LES DEUX CONTRÔLES SONT NÉCESSAIRES ET DIFFÉRENTS. Un `overflow-hidden` supprime le
 * débordement du document en MASQUANT le contenu qui dépasse : la page ne scrolle plus
 * horizontalement, et pourtant la moitié d'un bouton est coupée. Seul le second contrôle le voit.
 */
export async function pasDeDebordement(page: Page): Promise<void> {
  const debord = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  expect(debord, 'la page déborde horizontalement').toBeLessThanOrEqual(0);
}

/**
 * Deux éléments ne se recouvrent pas, et aucun ne sort de son parent.
 * `cles` sont des `data-testid`.
 */
export async function pasDeChevauchement(page: Page, cles: string[]): Promise<void> {
  const boites: Array<{ cle: string; x: number; y: number; width: number; height: number }> = [];
  for (const cle of cles) {
    const b = await page.getByTestId(cle).boundingBox();
    expect(b, `introuvable : ${cle}`).not.toBeNull();
    boites.push({ cle, ...b! });
  }
  for (let i = 0; i < boites.length; i += 1) {
    for (let j = i + 1; j < boites.length; j += 1) {
      const a = boites[i]!;
      const b = boites[j]!;
      const seRecouvrent =
        a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
      expect(seRecouvrent, `${a.cle} chevauche ${b.cle}`).toBe(false);
    }
  }
}

/**
 * LES BLOCS NOMMÉS SONT EMPILÉS, jamais côte à côte.
 *
 * 🔴 UN CONTRÔLE DE DÉGÂT NE REMPLACE PAS UN CONTRÔLE DE DISPOSITION, et c'est la leçon qui a coûté
 * le plus cher ici : trois blocs côte à côte ne débordent pas de la page et ne se CHEVAUCHENT pas non
 * plus (leurs rectangles sont disjoints). Ils passent donc les deux gardes ci-dessus, et pourtant ils
 * produisent exactement la mise en page qu'on cherche à empêcher : une grille qui se réorganise sous un
 * seuil, donc illisible sur un 13 pouces. Seule une assertion d'EMPILEMENT les attrape.
 *
 * ⚠️ ELLE NE JUGE PAS L'ORDRE. Ce qui compte est que chaque bloc commence SOUS le précédent, pas lequel
 * vient en premier : figer l'ordre ici ferait rougir ce contrôle au premier déplacement d'un bloc, pour
 * une raison qui n'a rien à voir avec la largeur.
 */
export async function empiles(page: Page, cles: string[]): Promise<void> {
  const boites = [];
  for (const cle of cles) {
    const b = await page.getByTestId(cle).boundingBox();
    expect(b, `introuvable : ${cle}`).not.toBeNull();
    boites.push({ cle, ...b! });
  }
  boites.sort((a, b) => a.y - b.y);
  for (let i = 1; i < boites.length; i += 1) {
    const avant = boites[i - 1]!;
    const apres = boites[i]!;
    expect(apres.y, `${apres.cle} est à côté de ${avant.cle} au lieu d'être dessous`)
      .toBeGreaterThanOrEqual(avant.y + avant.height - 1);
  }
}
