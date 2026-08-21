import { test, expect } from '@playwright/test';

/**
 * Brouillons de COMPOSITION : une campagne qu'on a commencé à écrire se retrouve après avoir quitté l'écran.
 *
 * Ce que ces tests protègent : qu'UN seul brouillon soit créé (et non un par frappe), et qu'il disparaisse
 * dès que la vraie campagne existe — sinon la liste montrerait les deux, et on ne saurait plus laquelle est
 * la bonne.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Faux backend minimal, avec un état MUTABLE : sans état, un écran qui n'affiche jamais ce qu'il vient
 *  d'écrire passerait tous les tests. */
async function mock(
  page: import('@playwright/test').Page,
  drafts: Array<{ id: string; name: string; state: Record<string, unknown>; updatedAt: string }> = [],
  /** Latence simulée sur la CRÉATION d'un brouillon. Sert à reproduire le cas où une 2e sauvegarde part
   *  pendant que la 1re est encore en vol : sans latence, un faux backend répond trop vite pour l'exposer. */
  delaiCreationMs = 0,
) {
  const appels: Array<{ method: string; url: string; body: unknown }> = [];
  let n = 0;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    let body: unknown = null;
    try { body = req.postDataJSON() ?? null; } catch { body = null; }
    appels.push({ method, url, body });
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });

    if (url.includes('/campaign-drafts')) {
      if (method === 'GET') return json({ drafts });
      if (method === 'POST') {
        if (delaiCreationMs > 0) await new Promise((r) => setTimeout(r, delaiCreationMs));
        n += 1;
        const d = { id: `d${n}`, name: String((body as { name?: string })?.name ?? ''), state: ((body as { state?: Record<string, unknown> })?.state ?? {}), updatedAt: '2026-08-21T10:00:00.000Z' };
        drafts.push(d);
        return json({ draft: d }, 201);
      }
      if (method === 'PUT') {
        const id = url.split('/').pop()!.split('?')[0]!;
        const d = drafts.find((x) => x.id === id);
        if (d) d.name = String((body as { name?: string })?.name ?? d.name);
        return json({ updated: !!d }, d ? 200 : 404);
      }
      if (method === 'DELETE') {
        const id = url.split('/').pop()!.split('?')[0]!;
        const i = drafts.findIndex((x) => x.id === id);
        if (i >= 0) drafts.splice(i, 1);
        return json({ deleted: i >= 0 }, i >= 0 ? 200 : 404);
      }
    }
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33500000000', verifiedName: 'Test' }] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  return { appels, drafts };
}

test.describe('Campagnes : brouillons de composition', () => {
  test('saisir un nom puis quitter le champ enregistre UN brouillon', async ({ page }) => {
    const { drafts } = await mock(page);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
    await page.getByTestId('campaign-name').fill('Promo été');
    await page.getByTestId('campaign-name').blur();

    await expect(page.getByTestId('draft-saved')).toBeVisible();
    expect(drafts.map((d) => d.name)).toEqual(['Promo été']);
  });

  test('🔴 re-saisir ne crée PAS un second brouillon', async ({ page }) => {
    // C'est le piège de l'enregistrement automatique : un brouillon par frappe polluerait la liste au point
    // de la rendre inutilisable, et personne ne saurait lequel reprendre.
    const { drafts } = await mock(page);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
    const champ = page.getByTestId('campaign-name');
    // `fill` prend le focus lui-même : pas de `click` intermédiaire, qui tombait pendant le re-rendu déclenché
    // par la sauvegarde (le message « brouillon enregistré » s'insère sous le champ et décale la mise en page).
    for (const nom of ['Promo', 'Promo é', 'Promo été']) {
      await champ.fill(nom);
      await champ.blur();
    }
    // UNE seule assertion, qui dit les deux choses à la fois : un seul brouillon (pas un par frappe) ET il
    // porte le dernier nom (donc les saisies suivantes l'ont bien MIS À JOUR au lieu d'être perdues).
    // Budget explicite : sous la charge de la suite complète, les workers partagent un serveur et les
    // réponses tardent. Ce qui est vérifié ne change pas, seule la patience.
    await expect.poll(() => drafts.map((d) => d.name), { timeout: 15_000 }).toEqual(['Promo été']);
  });

  test('🔴 deux sorties de champ AVANT la réponse du serveur ne créent qu’UN brouillon', async ({ page }) => {
    // Le cas que le test précédent ne couvre PAS : là-bas chaque sauvegarde a le temps de répondre, donc
    // l'identifiant est connu à temps et rien ne prouve la sérialisation. Ici la création est lente, la 2e
    // sortie de champ part pendant que la 1re est en vol, et les deux liraient un identifiant vide.
    const { drafts } = await mock(page, [], 400);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
    const champ = page.getByTestId('campaign-name');
    await champ.fill('Promo');
    await champ.blur();       // POST parti, réponse dans 400 ms
    await champ.fill('Promo été');
    await champ.blur();       // part AVANT que le premier ait répondu
    await expect.poll(() => drafts.map((d) => d.name), { timeout: 15_000 }).toEqual(['Promo été']);
  });

  test('un nom VIDE n’enregistre rien (pas de brouillon fantôme)', async ({ page }) => {
    const { drafts } = await mock(page);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
    await page.getByTestId('campaign-name').click();
    await page.getByTestId('campaign-name').blur();
    await expect(page.getByTestId('draft-saved')).toHaveCount(0);
    expect(drafts).toEqual([]);
  });

  test('un brouillon existant est listé et se reprend avec son nom', async ({ page }) => {
    await mock(page, [{ id: 'd9', name: 'Reprise du mois', state: { category: 'utility' }, updatedAt: '2026-08-21T10:00:00.000Z' }]);
    await page.goto('/campaigns');
    await expect(page.getByTestId('campaign-drafts')).toBeVisible();
    await page.getByTestId('draft-resume-d9').click();
    // Le formulaire s'ouvre AVEC le nom : c'est tout l'intérêt de la reprise.
    await expect(page.getByTestId('campaign-name')).toHaveValue('Reprise du mois');
  });

  test('sans brouillon, la section n’apparaît pas du tout', async ({ page }) => {
    await mock(page);
    await page.goto('/campaigns');
    await expect(page.getByTestId('campaign-drafts')).toHaveCount(0);
  });
});
