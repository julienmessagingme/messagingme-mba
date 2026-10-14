import { test as base, expect } from '@playwright/test';

export * from '@playwright/test';

/**
 * LE `test` DE TOUS LES SPECS : celui de Playwright, plus une garde qui fait échouer le test si une page a violé la
 * politique de sécurité de la console (CSP, `next.config.mjs`).
 *
 * 🔴 POURQUOI. La CSP est en observation (`Content-Security-Policy-Report-Only`) : une violation ne casse rien, le
 * navigateur la signale dans sa console et continue. Passée en blocage, la même violation couperait l'écran. Lire
 * ces signalements pendant chaque e2e, c'est savoir AVANT de basculer ce que la politique interdirait, écran par
 * écran ; et une fois la politique bloquante, un écran qui la viole serait cassé, ce que la garde voit aussi.
 *
 * Chromium écrit chaque violation dans la console de la page (« … violates the following Content Security Policy
 * directive … »), en observation comme en blocage, et Playwright la reçoit : mesuré le 2026-10-14. La garde écoute
 * toutes les pages du contexte, fenêtres surgissantes comprises.
 *
 * ⚠️ Un spec qui importerait `test` de `@playwright/test` échapperait à la garde : `tests/e2e-garde-csp.test.ts`
 * le refuse.
 */
export const test = base.extend<{ gardeCsp: void }>({
  gardeCsp: [async ({ context }, use) => {
    const violations = new Set<string>();
    const ecouter = (page: import('@playwright/test').Page) => {
      page.on('console', (message) => {
        const texte = message.text();
        if (texte.includes('Content Security Policy')) violations.add(`${page.url()} : ${texte}`);
      });
    };
    context.pages().forEach(ecouter);
    context.on('page', ecouter);
    await use();
    expect([...violations], 'la page a violé la CSP de la console (next.config.mjs)').toEqual([]);
  }, { auto: true }],
});
