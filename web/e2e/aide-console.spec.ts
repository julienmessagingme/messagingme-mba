import { test, expect } from '@playwright/test';

/**
 * LE BOUTON D'AIDE DE LA CONSOLE.
 *
 * 🔴 CE QUI EST VÉRIFIÉ ICI, ET QU'AUCUN TEST UNITAIRE NE PEUT VOIR : le bouton est présent sur un écran
 * quelconque sans que cet écran en sache rien (il est posé une seule fois dans la coquille), la question
 * part avec la CLÉ DE L'ÉCRAN COURANT, le lien proposé ouvre le bon écran, et quand le serveur dit qu'il ne
 * sait pas, le panneau propose le recours humain au lieu d'une réponse inventée.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Reponse = { sait: boolean; texte: string; sources: string[]; ecrans: Array<Record<string, unknown>> };

const SAIT: Reponse = {
  sait: true,
  texte: 'Ouvrez Campagnes, choisissez votre modèle, puis votre audience.',
  sources: ['Lancer une campagne'],
  ecrans: [{ cle: 'campagnes', href: '/campaigns', fr: 'Campagnes', en: 'Campaigns', chemin: [] }],
};

async function mock(page: import('@playwright/test').Page, reponse: Reponse | 'panne', vues: Array<Record<string, unknown>>) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/aide')) {
      vues.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      if (reponse === 'panne') return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"x"}' });
      return json(reponse);
    }
    // Les bouchons dont l'ECRAN CAMPAGNES a besoin pour se rendre. Sans eux il jette une exception cliente,
    // React demonte la page, et le bouton d'aide disparait avec elle : l'echec ressemble alors a un defaut
    // du bouton alors qu'il vient de l'ecran d'accueil du test.
    if (url.includes('/contacts/count')) return json({ total: 0 });
    if (url.includes('/contacts')) return json({ contacts: [], total: 0 });
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Bouton d’aide de la console', () => {
  test('🔴 il est là sans que l’écran en sache rien, et il transmet la clé de l’écran courant', async ({ page }) => {
    // `/campaigns` ne connaît pas ce bouton : il vient de la coquille commune. Le mettre page par page
    // serait 36 occasions de l'oublier.
    const vues: Array<Record<string, unknown>> = [];
    await mock(page, SAIT, vues);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('comment lancer une campagne');
    await page.getByTestId('aide-envoyer').click();

    await expect(page.getByTestId('aide-reponse')).toBeVisible();
    await expect.poll(() => vues[0]?.ecranCourant).toBe('campagnes');
  });

  test('🔴 le lien proposé ouvre le BON écran, et ferme le panneau', async ({ page }) => {
    await mock(page, SAIT, []);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('q');
    await page.getByTestId('aide-envoyer').click();
    const lien = page.getByTestId('aide-lien-campagnes');
    await expect(lien).toBeVisible();
    await expect(lien).toHaveAttribute('href', '/campaigns');
    await lien.click();
    await expect(page.getByTestId('aide-panneau')).toHaveCount(0);
  });

  test('la SOURCE est affichée : le client voit d’où sort la réponse', async ({ page }) => {
    await mock(page, SAIT, []);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('q');
    await page.getByTestId('aide-envoyer').click();
    await expect(page.getByTestId('aide-sources')).toContainText('Lancer une campagne');
  });

  test('🔴 quand il ne sait pas, il le DIT et propose le recours humain', async ({ page }) => {
    // Inventer une réponse plausible est la seule chose qu'on ne tolère pas. L'écran de recours existe déjà.
    await mock(page, { sait: false, texte: '', sources: [], ecrans: [] }, []);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('quelle est la capitale de la Bolivie');
    await page.getByTestId('aide-envoyer').click();
    await expect(page.getByTestId('aide-je-ne-sais-pas')).toBeVisible();
    await expect(page.getByTestId('aide-recours')).toHaveAttribute('href', '/support');
  });

  test('⚠️ une PANNE propose la même issue, jamais une trace technique', async ({ page }) => {
    await mock(page, 'panne', []);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('q');
    await page.getByTestId('aide-envoyer').click();
    await expect(page.getByTestId('aide-erreur')).toBeVisible();
    await expect(page.getByTestId('aide-recours')).toBeVisible();
    await expect(page.getByTestId('aide-erreur')).not.toContainText('502');
  });

  test('🔴 la question QUITTE le champ dès qu’on l’envoie', async ({ page }) => {
    // Elle y restait, et la question suivante venait se coller à la précédente. Signalé par Julien le
    // 2026-09-11 en essayant le bouton pour la première fois.
    await mock(page, SAIT, []);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('comment lancer une campagne');
    await page.getByTestId('aide-question').press('Enter');
    await expect(page.getByTestId('aide-question')).toHaveValue('');
    await expect(page.getByTestId('aide-reponse')).toBeVisible();
  });

  test('🔴 le fil SURVIT au changement d’écran', async ({ page }) => {
    // La coquille est remontée à chaque navigation : un fil gardé en mémoire disparaissait dès qu'on suivait
    // le lien que le bot venait de donner, c'est-à-dire au moment précis où l'on voulait enchaîner.
    const vues: Array<Record<string, unknown>> = [];
    await mock(page, SAIT, vues);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('comment lancer une campagne');
    await page.getByTestId('aide-envoyer').click();
    await expect(page.getByTestId('aide-reponse')).toBeVisible();

    await page.goto('/contacts');
    await page.getByTestId('aide-bouton').click();
    await expect(page.getByTestId('aide-question-posee')).toContainText('comment lancer une campagne');
    await expect(page.getByTestId('aide-reponse')).toBeVisible();
  });

  test('🔴 la question suivante emporte le fil au serveur', async ({ page }) => {
    // Sans lui, « et ensuite ? » serait incompréhensible et l'écran afficherait une conversation à laquelle
    // le bot répond comme si rien ne précédait.
    const vues: Array<Record<string, unknown>> = [];
    await mock(page, SAIT, vues);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('comment lancer une campagne');
    await page.getByTestId('aide-envoyer').click();
    await expect(page.getByTestId('aide-reponse')).toBeVisible();

    await page.getByTestId('aide-question').fill('et ensuite ?');
    await page.getByTestId('aide-envoyer').click();
    await expect.poll(() => (vues[1]?.historique as unknown[] | undefined)?.length).toBe(1);
    expect((vues[1]!.historique as Array<{ question: string }>)[0]!.question).toBe('comment lancer une campagne');
  });

  test('⚠️ une question en ÉCHEC n’entre pas dans le fil', async ({ page }) => {
    // Sinon le modèle croirait avoir répondu quelque chose, et la question suivante s'appuierait sur une
    // réponse qui n'a jamais existé.
    await mock(page, 'panne', []);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await page.getByTestId('aide-question').fill('q');
    await page.getByTestId('aide-envoyer').click();
    await expect(page.getByTestId('aide-erreur')).toBeVisible();
    await expect(page.getByTestId('aide-question-posee')).toHaveCount(0);
  });

  test('le bouton d’envoi reste inerte tant que la question est vide', async ({ page }) => {
    await mock(page, SAIT, []);
    await page.goto('/campaigns');
    await page.getByTestId('aide-bouton').click();
    await expect(page.getByTestId('aide-envoyer')).toBeDisabled();
    await page.getByTestId('aide-question').fill('q');
    await expect(page.getByTestId('aide-envoyer')).toBeEnabled();
  });
});
