import { test, expect } from '@playwright/test';

/**
 * Supprimer un espace depuis la surface d'exploitation (RC8).
 *
 * Ce que ces tests protègent à l'écran : le bilan s'ouvre avant tout, les liens Stripe y sont visibles, rien ne part
 * avant la saisie exacte du nom, et le déroulé affiché est celui que le serveur a rendu. Le serveur, lui, revérifie le
 * nom et décide de chaque étape (`tests/ops-suppression.test.ts`).
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const ESPACE = {
  id: 't-essai', name: 'Essai Dupont', createdAt: '2026-10-01T00:00:00Z', mbaEnabled: false,
  users: 1, contacts: 0, messages: 0, templatesUsed: 0, lastSendAt: null, phone: null, phoneStatus: null, quality: null,
};
const STRIPE = {
  clients: [{ customerId: 'cus_1', livemode: true, lien: 'https://dashboard.stripe.com/customers/cus_1' }],
  abonnements: [{ id: 'sub_1', produit: 'numero', statut: 'actif', livemode: true, vivant: true, lien: 'https://dashboard.stripe.com/subscriptions/sub_1' }],
};

test.describe('Ops : supprimer un espace', () => {
  test('le bilan, les liens Stripe, la saisie du nom, puis le déroulé rendu par le serveur', async ({ page }) => {
    const suppressions: Array<{ methode: string; corps: unknown; autorisation?: string }> = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const chemin = req.url().split('?')[0]!;
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (chemin.endsWith('/ops/overview')) return json({ tenants: [ESPACE], daily: [], queues: [], worker: null });
      if (chemin.endsWith('/ops/espaces/t-essai/suppression')) {
        return json({
          bilan: {
            tenantId: 't-essai', nom: 'Essai Dupont', creeLe: '2026-10-01T00:00:00Z', statut: 'trial',
            comptes: { utilisateurs: 1, contacts: 0, conversations: 0, scenarios: 0 }, soldeMicroEur: 0, stripe: STRIPE,
            numeroFourni: null, meta: { phoneNumberId: null, wabaId: null, partage: false, mbaAllume: false, contactsSurLaListe: 0 },
            salesforce: false, cleVercel: true, adresses: { effacees: ['essai@exemple.test'], gardees: [] },
          },
          etapes: [
            { etape: 'verrou', etat: 'a_faire', detail: null },
            { etape: 'cle_vercel', etat: 'a_faire', detail: null },
            { etape: 'waba_desabonne', etat: 'sautee', detail: 'aucun compte WhatsApp' },
            { etape: 'purge', etat: 'a_faire', detail: null },
          ],
        });
      }
      if (chemin.endsWith('/ops/espaces/t-essai') && req.method() === 'DELETE') {
        suppressions.push({ methode: req.method(), corps: req.postDataJSON(), autorisation: req.headers().authorization });
        return json({
          tenantId: 't-essai', nom: 'Essai Dupont', supprime: true, comptes: { utilisateurs: 1 }, stripe: STRIPE,
          etapes: [
            { etape: 'verrou', etat: 'fait', detail: null },
            { etape: 'cle_vercel', etat: 'fait', detail: 'révoquée chez Vercel' },
            { etape: 'waba_desabonne', etat: 'sautee', detail: 'aucun compte WhatsApp' },
            { etape: 'purge', etat: 'fait', detail: null },
          ],
        });
      }
      return json({});
    });

    await page.goto('/ops');
    await page.getByTestId('supprimer-t-essai').click();
    const modale = page.getByTestId('suppression-modale');
    await expect(modale).toBeVisible();

    // Les liens Stripe, en évidence, avant toute saisie.
    const stripe = modale.getByTestId('suppression-stripe');
    await expect(stripe).toContainText(/à résilier à la main|cancel by hand/);
    await expect(stripe.getByRole('link', { name: 'sub_1' })).toHaveAttribute('href', 'https://dashboard.stripe.com/subscriptions/sub_1');
    await expect(modale.getByTestId('etape-waba_desabonne')).toContainText('aucun compte WhatsApp');

    // 🔴 Rien ne part avant le nom exact.
    const confirmer = modale.getByTestId('suppression-confirmer');
    await expect(confirmer).toBeDisabled();
    await modale.getByTestId('suppression-nom').fill('essai dupont');
    await expect(confirmer).toBeDisabled();
    await modale.getByTestId('suppression-nom').fill('Essai Dupont');
    await expect(confirmer).toBeEnabled();
    await confirmer.click();

    await expect(modale.getByTestId('suppression-issue')).toBeVisible();
    await expect(modale.getByTestId('suppression-deroule')).toContainText('révoquée chez Vercel');
    expect(suppressions).toEqual([{ methode: 'DELETE', corps: { nom: 'Essai Dupont' }, autorisation: 'Bearer session-ops-e2e' }]);
    // Les liens restent sous les yeux après la suppression : c'est là que Julien en a besoin.
    await expect(modale.getByTestId('suppression-stripe')).toBeVisible();
  });

  test('🔴 une suppression arrêtée (Vercel) le dit, sans prétendre avoir supprimé', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const chemin = req.url().split('?')[0]!;
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (chemin.endsWith('/ops/overview')) return json({ tenants: [ESPACE], daily: [], queues: [], worker: null });
      if (chemin.endsWith('/ops/espaces/t-essai/suppression')) {
        return json({
          bilan: {
            tenantId: 't-essai', nom: 'Essai Dupont', creeLe: '2026-10-01T00:00:00Z', statut: 'trial',
            comptes: { utilisateurs: 1, contacts: 0, conversations: 0, scenarios: 0 }, soldeMicroEur: 0,
            stripe: { clients: [], abonnements: [] }, numeroFourni: null,
            meta: { phoneNumberId: null, wabaId: null, partage: false, mbaAllume: false, contactsSurLaListe: 0 },
            salesforce: false, cleVercel: true, adresses: { effacees: [], gardees: [] },
          },
          etapes: [{ etape: 'verrou', etat: 'a_faire', detail: null }, { etape: 'cle_vercel', etat: 'a_faire', detail: null }],
        });
      }
      if (chemin.endsWith('/ops/espaces/t-essai') && req.method() === 'DELETE') {
        return json({
          tenantId: 't-essai', nom: 'Essai Dupont', supprime: false, comptes: null, stripe: { clients: [], abonnements: [] },
          etapes: [
            { etape: 'verrou', etat: 'fait', detail: null },
            { etape: 'cle_vercel', etat: 'echec', detail: 'Vercel n a pas confirme la suppression' },
          ],
        });
      }
      return json({});
    });

    await page.goto('/ops');
    await page.getByTestId('supprimer-t-essai').click();
    const modale = page.getByTestId('suppression-modale');
    await modale.getByTestId('suppression-nom').fill('Essai Dupont');
    await modale.getByTestId('suppression-confirmer').click();
    await expect(modale.getByTestId('suppression-issue')).toContainText(/NON supprimé|NOT deleted/);
    await expect(modale.getByTestId('etape-cle_vercel')).toContainText(/échec|failed/);
    await expect(modale.getByTestId('suppression-stripe')).toHaveCount(0);
  });
});
