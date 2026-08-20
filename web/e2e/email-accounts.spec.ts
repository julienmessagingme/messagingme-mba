import { test, expect } from '@playwright/test';

/**
 * Écran « Boîtes email » (menu Compte > Boîtes email, admin-only) : un admin connecte une boîte SMTP, la voit
 * listée, l'édite sans jamais voir le mot de passe pré-rempli, envoie un test, et supprime une boîte. Backend
 * intercepté, aucune base (même pattern que les autres E2E de la console, cf. workflow-rcs-node.spec.ts).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Account = Record<string, unknown>;

function baseAccount(over: Partial<Account> = {}): Account {
  return {
    id: 'a1', label: 'Support', host: 'ssl0.ovh.net', port: 465, secure: true, username: 'support@exemple.fr',
    fromAddress: 'support@exemple.fr', fromName: null, replyTo: null, verifiedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z', hasPassword: true,
    ...over,
  };
}

async function mockPage(page: import('@playwright/test').Page, accounts: Account[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const created: Account[] = [];
  const patched: Array<{ id: string; body: Record<string, unknown> }> = [];
  const deletedIds: string[] = [];
  const tested: Array<{ id: string; to: string }> = [];
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });

    if (req.method() === 'POST' && /\/email\/accounts$/.test(path)) {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const acc = baseAccount({ id: `a${accounts.length + 1}`, verifiedAt: null, ...body });
      delete acc.password; // le serveur ne le renvoie jamais
      created.push(acc);
      accounts.push(acc);
      return json(acc);
    }
    if (req.method() === 'POST' && /\/test$/.test(path)) {
      const id = path.split('/').slice(-2)[0]!;
      const body = (req.postDataJSON() ?? {}) as { to: string };
      tested.push({ id, to: body.to });
      return json({ ok: true });
    }
    if (req.method() === 'PATCH' && /\/email\/accounts\//.test(path)) {
      const id = path.split('/').pop()!;
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      patched.push({ id, body });
      const idx = accounts.findIndex((a) => a.id === id);
      if (idx >= 0) accounts[idx] = { ...accounts[idx], ...body };
      return json(accounts[idx] ?? {});
    }
    if (req.method() === 'DELETE' && /\/email\/accounts\//.test(path)) {
      const id = path.split('/').pop()!;
      deletedIds.push(id);
      return json({ ok: true });
    }
    if (path.includes('/email/accounts')) return json({ accounts });
    if (path.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { created, patched, deletedIds, tested };
}

test.describe('Réglages : boîtes email (SMTP)', () => {
  test('un admin connecte une boîte SMTP et la voit listée', async ({ page }) => {
    const accounts: Account[] = [];
    const { created } = await mockPage(page, accounts);

    await page.goto('/settings/email');
    await expect(page.getByText('Aucune boîte connectée')).toBeVisible();

    await page.getByRole('button', { name: /Connecter une boîte/i }).click();
    await page.getByTestId('email-account-label').fill('Support');
    await page.getByTestId('email-account-host').fill('ssl0.ovh.net');
    await page.getByTestId('email-account-port').fill('465');
    await page.getByTestId('email-account-username').fill('support@exemple.fr');
    await page.getByTestId('email-account-password').fill('s3cret');
    await page.getByTestId('email-account-from').fill('support@exemple.fr');
    await page.getByTestId('email-account-save').click();

    await expect.poll(() => created.length).toBe(1);
    expect(created[0]).toMatchObject({ label: 'Support', host: 'ssl0.ovh.net', username: 'support@exemple.fr', fromAddress: 'support@exemple.fr' });
    expect(created[0]).not.toHaveProperty('password');
    // La CELLULE du tableau, pas « le texte Support quelque part » : cette page porte aussi un lien
    // « Support » dans le menu et une adresse « support@exemple.fr », donc trois éléments correspondent.
    // La ligne apparaissant APRÈS le reste, le localisateur large passait ou violait le mode strict selon
    // l'instant où il s'évaluait : un test rouge une fois sur trois, sans rien à voir avec le code.
    await expect(page.getByRole('cell', { name: 'Support', exact: true })).toBeVisible();
    await expect(page.getByText('Non testée')).toBeVisible();
  });

  test('éditer une boîte existante ne pré-remplit jamais le mot de passe, et l’omet si laissé vide', async ({ page }) => {
    const accounts: Account[] = [baseAccount()];
    const { patched } = await mockPage(page, accounts);

    await page.goto('/settings/email');
    // Cf. plus haut : la cellule, et elle seule. Attendre la ligne du tableau est bien ce qu'on veut ici,
    // c'est le localisateur qui était ambigu.
    await page.getByRole('cell', { name: 'Support', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Modifier' }).click();

    await expect(page.getByTestId('email-account-password')).toHaveValue('');

    await page.getByTestId('email-account-label').fill('Support (renommé)');
    await page.getByTestId('email-account-save').click();

    await expect.poll(() => patched.length).toBe(1);
    expect(patched[0]!.body).not.toHaveProperty('password');
    expect(patched[0]!.body).toMatchObject({ label: 'Support (renommé)' });
  });

  test('un mot de passe saisi à l’édition part bien dans la requête', async ({ page }) => {
    const accounts: Account[] = [baseAccount()];
    const { patched } = await mockPage(page, accounts);

    await page.goto('/settings/email');
    await page.getByRole('button', { name: 'Modifier' }).click();
    await page.getByTestId('email-account-password').fill('nouveau-secret');
    await page.getByTestId('email-account-save').click();

    await expect.poll(() => patched.length).toBe(1);
    expect(patched[0]!.body).toMatchObject({ password: 'nouveau-secret' });
  });

  test('envoyer un test appelle la route de test et affiche la confirmation', async ({ page }) => {
    const accounts: Account[] = [baseAccount()]; // verifiedAt: null -> pastille « Non testée » au départ
    const { tested } = await mockPage(page, accounts);

    await page.goto('/settings/email');
    await page.getByRole('button', { name: 'Tester' }).click();
    await page.getByPlaceholder('toi@exemple.fr').fill('julien@exemple.fr');
    await page.getByRole('button', { name: 'Envoyer' }).click();

    await expect.poll(() => tested.length).toBe(1);
    expect(tested[0]).toEqual({ id: 'a1', to: 'julien@exemple.fr' });
    await expect(page.getByText('Email de test envoyé.')).toBeVisible();
  });

  test('échec d’envoi de test : le message d’erreur du serveur est affiché, pas un crash', async ({ page }) => {
    const accounts: Account[] = [baseAccount()];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
      if (req.method() === 'POST' && /\/test$/.test(path)) return json({ error: 'envoi de test échoué' }, 422);
      if (path.includes('/email/accounts')) return json({ accounts });
      if (path.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/settings/email');
    await page.getByRole('button', { name: 'Tester' }).click();
    await page.getByPlaceholder('toi@exemple.fr').fill('julien@exemple.fr');
    await page.getByRole('button', { name: 'Envoyer' }).click();

    await expect(page.getByText('envoi de test échoué')).toBeVisible();
  });

  test('supprimer une boîte demande confirmation puis appelle la suppression', async ({ page }) => {
    const accounts: Account[] = [baseAccount()];
    const { deletedIds } = await mockPage(page, accounts);
    page.on('dialog', (d) => d.accept());

    await page.goto('/settings/email');
    await page.getByRole('button', { name: 'Supprimer' }).click();

    await expect.poll(() => deletedIds.length).toBe(1);
    expect(deletedIds[0]).toBe('a1');
  });

});
