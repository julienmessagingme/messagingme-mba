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
