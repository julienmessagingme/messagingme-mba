import { expect, type Page } from '@playwright/test';

/**
 * RÉPONDRE À LA FENÊTRE DE CONFIRMATION DE LA CONSOLE (`components/Confirmation.tsx`).
 *
 * Elle a remplacé `window.confirm` le 2026-09-25. Playwright acceptait ou refusait la boîte native par
 * `page.on('dialog')` ; la fenêtre est désormais un élément de la page, qu'on lit et qu'on clique comme le
 * reste. Ce que les tests vérifiaient sur le message (`d.message()`) se vérifie sur son texte.
 *
 * ⚠️ RIEN N'EST ACCEPTÉ EN SILENCE : sans appel à `repondre`, la fenêtre reste ouverte et le geste ne part
 * pas, exactement comme un `page.on('dialog')` absent (Playwright refusait alors la boîte native).
 */
export async function repondre(page: Page, accepter: boolean, message?: string | RegExp): Promise<string> {
  const fenetre = page.getByTestId('confirmation');
  await expect(fenetre).toBeVisible();
  if (message !== undefined) await expect(page.getByTestId('confirmation-message')).toContainText(message);
  const texte = (await page.getByTestId('confirmation-message').textContent()) ?? '';
  await fenetre.getByTestId(accepter ? 'confirmation-oui' : 'confirmation-non').click();
  await expect(fenetre).toHaveCount(0);
  return texte;
}

/** La confirmation SUR PLACE (`BoutonConfirme`) : la question remplace le bouton, on confirme ou on annule. */
export async function repondreSurPlace(page: Page, accepter: boolean, question?: string | RegExp): Promise<void> {
  const groupe = page.getByTestId('confirmation-en-ligne');
  await expect(groupe).toBeVisible();
  if (question !== undefined) await expect(groupe).toContainText(question);
  await groupe.getByTestId(accepter ? 'confirmation-oui' : 'confirmation-non').click();
}

/**
 * L'équivalent d'un `page.on('dialog', …)` : chaque fenêtre de confirmation qui s'ouvre est lue, son message
 * est rangé dans la liste rendue, et `decider` dit s'il faut confirmer. Pour les tests qui enchaînent
 * plusieurs confirmations sans savoir d'avance à quel moment elles tombent.
 *
 * ⚠️ À appeler AVANT `page.goto` : l'observateur est posé au chargement de la page.
 */
export async function repondreAutomatiquement(page: Page, decider: (message: string) => boolean): Promise<string[]> {
  const messages: string[] = [];
  await page.exposeFunction('__deciderConfirmation', (message: string) => { messages.push(message); return decider(message); });
  await page.addInitScript(() => {
    const observateur = new MutationObserver(() => {
      const fenetre = document.querySelector('[data-testid="confirmation"]:not([data-lue])');
      if (!fenetre) return;
      fenetre.setAttribute('data-lue', '');
      const message = fenetre.querySelector('[data-testid="confirmation-message"]')?.textContent ?? '';
      const decider = (window as unknown as { __deciderConfirmation: (m: string) => Promise<boolean> }).__deciderConfirmation;
      void decider(message).then((ok) => {
        const bouton = fenetre.querySelector(`[data-testid="${ok ? 'confirmation-oui' : 'confirmation-non'}"]`);
        if (bouton instanceof HTMLElement) bouton.click();
      });
    });
    observateur.observe(document, { childList: true, subtree: true });
  });
  return messages;
}
