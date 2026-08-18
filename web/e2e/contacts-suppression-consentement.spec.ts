import { test, expect } from '@playwright/test';

/**
 * E2E mini-CRM : la SUPPRESSION d'un contact et la bascule de consentement.
 *
 * Ce fichier existe pour une raison précise. Supprimer un contact efface aussi sa conversation, ses messages
 * et son analyse : c'est irréversible, et une cible par filtres peut viser des milliers de fiches d'un coup.
 * Le serveur exige `confirm: 'SUPPRIMER'`, mais c'est le client qui l'envoie, systématiquement : cette garde
 * ne protège donc que d'une erreur d'API, jamais de celle de l'opérateur. La SEULE chose qui protège la
 * personne devant l'écran est la saisie du mot dans la modale, et elle n'est prouvée que par ce test.
 *
 * Backend intercepté, aucune base requise (pattern des E2E accueil / paramètres).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONTACTS = [
  { id: 'c1', phoneE164: '+33611111111', bsuid: null, profileName: 'Alex', optInStatus: 'opted_in', fields: {}, tags: [], createdAt: '2026-08-01T09:00:00.000Z' },
  { id: 'c2', phoneE164: '+33622222222', bsuid: null, profileName: 'Bo', optInStatus: 'unknown', fields: {}, tags: [], createdAt: '2026-08-02T09:00:00.000Z' },
];

/** Monte la page Contacts avec un backend simulé, et rend les corps reçus sur la suppression et sur /bulk. */
async function monter(page: import('@playwright/test').Page) {
  const suppressions: Array<Record<string, unknown>> = [];
  const bulks: Array<Record<string, unknown>> = [];
  const patchs: Array<Record<string, unknown>> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && url.includes('/contacts/purge')) {
      suppressions.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ purges: 1, conversations: 1, messages: 7, analyses: 1 });
    }
    if (req.method() === 'POST' && url.includes('/contacts/bulk')) {
      bulks.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ affected: 1 });
    }
    if (req.method() === 'PATCH' && url.includes('/contacts/')) {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      patchs.push(body);
      // Renvoie la fiche AVEC le nouveau statut : l'écran se réaffiche sur cette réponse.
      return json({ contact: { ...CONTACTS[1], optInStatus: body.optInStatus ?? CONTACTS[1]!.optInStatus } });
    }
    if (url.includes('/contacts/count')) return json({ count: CONTACTS.length });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/contacts')) return json({ contacts: CONTACTS });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/contacts');
  // Coche le premier contact : la barre d'action n'apparaît qu'à partir d'une sélection.
  await page.locator('input[type="checkbox"]').nth(1).check();
  await expect(page.getByTestId('contacts-action')).toBeVisible();
  return { suppressions, bulks, patchs };
}

test.describe('mini-CRM : suppression', () => {
  test('🔴 le bouton reste INACTIF tant que « SUPPRIMER » n’est pas tapé, et aucun appel ne part', async ({ page }) => {
    const { suppressions } = await monter(page);
    await page.getByTestId('contacts-action').click();
    await page.getByTestId('contacts-action-delete').click();

    const valider = page.getByTestId('bulk-submit');
    await expect(valider).toBeDisabled();

    // Un mot approchant ne suffit pas : c'est tout l'intérêt d'une confirmation par saisie.
    await page.getByTestId('suppression-confirm').fill('SUPPRIME');
    await expect(valider).toBeDisabled();
    await page.getByTestId('suppression-confirm').fill('effacer');
    await expect(valider).toBeDisabled();
    expect(suppressions).toEqual([]);

    await page.getByTestId('suppression-confirm').fill('SUPPRIMER');
    await expect(valider).toBeEnabled();
  });

  test('confirmée : part avec la cible cochée et le mot de confirmation', async ({ page }) => {
    const { suppressions } = await monter(page);
    await page.getByTestId('contacts-action').click();
    await page.getByTestId('contacts-action-delete').click();
    await page.getByTestId('suppression-confirm').fill('SUPPRIMER');
    await page.getByTestId('bulk-submit').click();

    await expect.poll(() => suppressions.length).toBe(1);
    expect(suppressions[0]).toEqual({ target: { ids: ['c1'] }, confirm: 'SUPPRIMER' });
  });

  test('🔴 UNE SEULE destruction au menu, et elle annonce que la conversation part avec', async ({ page }) => {
    // Il en a existé deux, une douce et une définitive. Les distinguer laissait le fil dans l'Inbox après une
    // suppression, ce qui est exactement le piège dans lequel l'exploitant est tombé.
    await monter(page);
    await page.getByTestId('contacts-action').click();
    await expect(page.getByRole('button', { name: /supprimer/i })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /effacer|purge/i })).toHaveCount(0);

    await page.getByTestId('contacts-action-delete').click();
    await expect(page.getByText(/IRRÉVERSIBLE/)).toBeVisible();
    await expect(page.getByText(/conversation dans l'Inbox/)).toBeVisible();
  });
});

test.describe('mini-CRM : bascule de consentement', () => {
  test('opt-out : envoie set_optin/opted_out, sans confirmation par saisie', async ({ page }) => {
    // Pas de mot à taper ici : la bascule se défait d'un clic, contrairement à la suppression.
    const { bulks } = await monter(page);
    await page.getByTestId('contacts-action').click();
    await page.getByTestId('contacts-action-optout').click();
    await page.getByTestId('bulk-submit').click();

    await expect.poll(() => bulks.length).toBe(1);
    expect(bulks[0]).toEqual({ target: { ids: ['c1'] }, action: { type: 'set_optin', value: 'opted_out' } });
  });

  test('opt-in : même chemin, valeur opted_in', async ({ page }) => {
    const { bulks } = await monter(page);
    await page.getByTestId('contacts-action').click();
    await page.getByTestId('contacts-action-optin').click();
    await page.getByTestId('bulk-submit').click();

    await expect.poll(() => bulks.length).toBe(1);
    expect(bulks[0]).toMatchObject({ action: { type: 'set_optin', value: 'opted_in' } });
  });
});

test.describe('fiche contact : consentement modifiable à la main', () => {
  /** Ouvre la fiche du contact « Bo », dont le consentement est « inconnu ». */
  async function ouvrirFiche(page: import('@playwright/test').Page) {
    const monte = await monter(page);
    await page.getByText('Bo', { exact: true }).click();
    await expect(page.getByText('Consentement')).toBeVisible();
    return monte;
  }

  test('🔴 un contact « inconnu » peut passer en opt-in depuis sa fiche', async ({ page }) => {
    // C'est le trou signalé : le garde-fou de campagne exige un opt-in EXPLICITE pour le marketing, donc un
    // contact « inconnu » est écarté des envois en silence, et rien ne permettait de le rattraper.
    const { patchs } = await ouvrirFiche(page);
    await page.getByTestId('fiche-optin').click();
    await expect.poll(() => patchs.length).toBe(1);
    expect(patchs[0]).toEqual({ optInStatus: 'opted_in' });
  });

  test('le même écran sait aussi poser un opt-out', async ({ page }) => {
    const { patchs } = await ouvrirFiche(page);
    await page.getByTestId('fiche-optout').click();
    await expect.poll(() => patchs.length).toBe(1);
    expect(patchs[0]).toEqual({ optInStatus: 'opted_out' });
  });

  test('🔴 le statut COURANT n’est pas reproposé, et « inconnu » n’est jamais une option', async ({ page }) => {
    // Reproposer l'état courant invite à un aller-retour qui n'écrit rien mais laisse une trace au journal.
    // Et « inconnu » veut dire « rien n'a jamais été enregistré » : le repeindre falsifierait le registre.
    const { patchs } = await ouvrirFiche(page);
    await expect(page.getByTestId('fiche-optin')).toBeVisible();   // le contact est « inconnu »
    await expect(page.getByTestId('fiche-optout')).toBeVisible();
    await page.getByTestId('fiche-optin').click();
    await expect.poll(() => patchs.length).toBe(1);
    // La fiche revient en opt-in : l'action « passer en opt-in » disparaît, l'opt-out reste.
    await expect(page.getByTestId('fiche-optin')).toHaveCount(0);
    await expect(page.getByTestId('fiche-optout')).toBeVisible();
    await expect(page.getByRole('button', { name: /inconnu/i })).toHaveCount(0);
  });
});
