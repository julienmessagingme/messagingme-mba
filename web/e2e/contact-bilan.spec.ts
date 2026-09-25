import { test, expect } from '@playwright/test';

/**
 * LE BILAN D'UN CONTACT, en haut de l'onglet Historique (demande de Julien, 2026-09-11 : « mettre le fric
 * que la personne nous a coûté et EN FACE le nombre d'engagements de 1er niveau [...] puis de 2e niveau »).
 *
 * ⚠️ IL SE CHARGE À PART DE L'HISTORIQUE, et ces cas le tiennent : la route du bilan appelle Meta pour les
 * tarifs, donc elle est plus lente et elle peut tomber seule. La fiche doit s'ouvrir sans elle.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const BILAN = {
  cout: { envoyes: 21, cout: 1.68, nonChiffrables: 2, sansCategorie: 2, sansTarif: 0, currency: 'EUR' },
  entonnoir: [
    { niveau: 1, parcours: 16 }, { niveau: 2, parcours: 7 }, { niveau: 3, parcours: 2 },
    { niveau: 4, parcours: 0 }, { niveau: 5, parcours: 0 },
  ],
};

async function ouvrir(page: import('@playwright/test').Page, bilan: unknown | 'panne') {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/bilan$/.test(url)) {
      if (bilan === 'panne') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' });
      return json(bilan);
    }
    if (/\/history$/.test(url)) return json({ sends: [], conversations: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (/\/contacts/.test(url)) {
      return json({ contacts: [{ id: 'ct1', phoneE164: '+33611111111', profileName: 'Claire Fontaine', optInStatus: 'in', tags: [], fields: {}, createdAt: '2026-09-01T10:00:00Z' }], total: 1 });
    }
    if (/\/user-fields/.test(url)) return json({ fields: [] });
    return json({});
  });
  await page.goto('/contacts');
  await page.getByText('Claire Fontaine').first().click();
  await page.getByRole('button', { name: /Historique|History/ }).first().click();
}

test.describe('Le bilan d’un contact', () => {
  test('🔴 le coût et l’entonnoir s’affichent, et la troncature se DIT', async ({ page }) => {
    await ouvrir(page, BILAN);
    await expect(page.getByTestId('contact-bilan-cout')).toContainText('1,68');
    await expect(page.getByTestId('contact-bilan-niveau-1')).toContainText('16');
    await expect(page.getByTestId('contact-bilan-niveau-3')).toContainText('2');
    // ⚠️ Un total amputé en silence se lit comme un total : les envois non chiffrés sont annoncés, AVEC leur
    // cause, parce qu'une catégorie absente et un tarif manquant ne se réparent pas pareil.
    await expect(page.getByTestId('contact-bilan-nonchiffrables')).toContainText(/sans catégorie/);
  });

  test('🔴 un coût INCONNU affiche « — », jamais « 0 € »', async ({ page }) => {
    // Un zéro se lirait « ce contact ne nous a rien coûté », alors que la vérité est « on ne sait pas ».
    await ouvrir(page, { ...BILAN, cout: { ...BILAN.cout, cout: null } });
    await expect(page.getByTestId('contact-bilan-cout')).toHaveText('n/d');
  });

  test('🔴 le bilan en PANNE ne fait pas disparaître l’historique', async ({ page }) => {
    // C'est tout l'intérêt des deux appels : la carte passe par Meta, la liste des envois non. Échanger
    // l'essentiel contre l'accessoire serait le pire des deux.
    await ouvrir(page, 'panne');
    await expect(page.getByTestId('contact-bilan')).toHaveCount(0);
    await expect(page.getByText(/Aucun envoi|No send|Aucune conversation|No conversation/).first()).toBeVisible();
  });
});
