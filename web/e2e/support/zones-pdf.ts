import type { Page } from '@playwright/test';

/**
 * Les identifiants de ZONE D'EXPORT PDF réellement rendus par la page, lus dans le DOM.
 *
 * 🔴 DÉRIVÉ, JAMAIS ÉNUMÉRÉ. L'inventaire des zones était une liste écrite à la main, donc une vérification
 * de SOUS-ENSEMBLE : une carte ajoutée n'y entrait pas, et le test restait vert en ne la vérifiant jamais.
 * Deux zones ont dérivé ainsi (`quanti-facture`, `quanti-origine-service`).
 *
 * ⚠️ Une lecture du DOM n'est dérivée que si la page a RENDU toutes ses cartes : une fixture incomplète en
 * fait taire une sans que rien ne le dise (`OrigineServiceCard` rend `null` sans `serviceParOrigine`). Les
 * deux specs qui l'emploient posent donc des fixtures complètes, et comptent les zones attendues.
 *
 * Ce helper vivait en double, à l'identique, dans `exports.spec.ts` et `quantitatif-sous-onglets.spec.ts`.
 */
export function zonesDeLaPage(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('[id^="quanti-"]')].map((e) => e.id).sort());
}
