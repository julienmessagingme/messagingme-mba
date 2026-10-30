import { test, expect, type Page } from './aide/test';
import { repondre } from './aide/confirmation';

/**
 * LES SIÈGES PAYANTS DU PRO DANS LA CONSOLE (spec offres v2, livraison 7). Une invitation au-delà des 3 utilisateurs d'un Pro
 * est refusée AVEC le prix : l'administrateur confirme, le siège est payé chez Stripe d'abord, puis la même invitation
 * repart. Un prorata impayé laisse la facture à régler, sans inviter. La page Offre dit les utilisateurs achetés et en
 * retire un, sans remboursement.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const PRO = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email', 'console'];
const limites = (o: 'free' | 'pro', utilisateurs: number) => ({
  utilisateurs, admins: o === 'free' ? 1 : 2, contacts: o === 'free' ? 100 : 5000, envoisModelesMois: o === 'free' ? 1000 : null,
  automations: o === 'free' ? 10 : null, suppressionsJour: o === 'free' ? 10 : null, adressesWebhook: o === 'free' ? 1 : 5,
  journalWebhooksJours: o === 'free' ? 3 : 30, conservationJours: o === 'free' ? 30 : 90, commissionPct: o === 'free' ? 50 : 20,
  badge: o === 'free', numeroInclus: o !== 'free',
});
const GRILLE = {
  free: { fonctions: [], limites: limites('free', 1) },
  pro: { fonctions: PRO, limites: limites('pro', 3) },
  entreprise: { fonctions: [...PRO, 'analyse', 'publicites', 'chaines', 'crm', 'rcs', 'performance_lab'], limites: { ...limites('pro', 3), utilisateurs: null, admins: null } },
};
const PRIX_SIEGE = { moisCentimes: 1500, anCentimes: 15000 };
const vuePro = (achetes: number, periodicite: 'mois' | 'an' = 'mois') => ({
  offre: 'pro', fonctions: PRO, limites: limites('pro', 3 + achetes),
  usage: { envoisModelesMois: null, contacts: 10, automations: 1, membres: 3 + achetes }, grille: GRILLE,
  prixPro: { moisCentimes: 4900, anCentimes: 49000 }, suiteDuNumero: null, essai: { jours: 14, possible: false, finLe: null },
  sieges: { inclus: 3, achetes, periodicite }, prixSiege: PRIX_SIEGE, upgradeUrl: 'https://console.e2e.test/offre',
});
const vueFree = {
  offre: 'free', fonctions: [], limites: limites('free', 1),
  usage: { envoisModelesMois: 0, contacts: 0, automations: 0, membres: 1 }, grille: GRILLE,
  prixPro: { moisCentimes: 4900, anCentimes: 49000 }, suiteDuNumero: null, essai: { jours: 14, possible: true, finLe: null },
  sieges: null, prixSiege: PRIX_SIEGE, upgradeUrl: 'https://console.e2e.test/offre',
};
const USERS = [
  { id: 'u-moi', email: 'admin@e2e.test', name: 'Moi', role: 'admin', disabled: false, pending: false, createdAt: '2026-09-01T00:00:00.000Z', lastLoginAt: null },
];
const REFUS_SIEGE = {
  error: 'Limite de votre offre atteinte : 3 utilisateurs. Ajoutez un utilisateur (15 € HT par mois) depuis la page Offre, ou passez en Entreprise : https://console.e2e.test/offre',
  code: 'plan_limit_reached', limite: 'utilisateurs', max: 3, upgradeUrl: 'https://console.e2e.test/offre',
  siege: { cible: 1, periodicite: 'mois', prixHtCentimes: 1500 },
};

type Reponse = { status: number; corps: unknown };
async function monter(page: Page, offre: unknown, o: { invitations?: Reponse[]; sieges?: Reponse } = {}) {
  const invitations: unknown[] = [];
  const sieges: unknown[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && chemin === '/tenants/t-e2e/invitations') {
      invitations.push(req.postDataJSON());
      const r = o.invitations?.shift();
      return r ? json(r.corps, r.status) : json({ user: { ...USERS[0], id: 'u-neuf', email: 'neuf@e2e.test', pending: true }, emailSent: true });
    }
    if (req.method() === 'POST' && chemin === '/tenants/t-e2e/offre/sieges') {
      sieges.push(req.postDataJSON());
      return o.sieges ? json(o.sieges.corps, o.sieges.status) : json({ sieges: (req.postDataJSON() as { cible: number }).cible });
    }
    if (chemin === '/tenants/t-e2e/offre') return json(offre);
    if (chemin === '/tenants/t-e2e/users') return json({ users: USERS });
    if (chemin === '/tenants/t-e2e/nom') return json({ nom: 'Espace E2E' });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Moi', role: 'admin' });
    return json({});
  });
  return { invitations, sieges };
}

async function inviter(page: Page) {
  await page.goto('/admin');
  await page.getByPlaceholder('membre@entreprise.fr').fill('neuf@e2e.test');
  await page.getByRole('button', { name: 'Inviter', exact: true }).click();
}

test.describe('🔴 inviter au-delà des utilisateurs du Pro', () => {
  test('le prix est dit, rien n’est facturé avant la confirmation ; confirmé, le siège puis la même invitation', async ({ page }) => {
    const { invitations, sieges } = await monter(page, vuePro(0), { invitations: [{ status: 402, corps: REFUS_SIEGE }] });
    await inviter(page);
    const bloc = page.getByTestId('siege-requis');
    await expect(bloc).toContainText('15 € HT par mois');
    await expect(bloc).toContainText('prorata');
    // L'écran propose l'achat lui-même : le bandeau du refus d'offre, qui renverrait à la page Offre, ne s'affiche pas.
    await expect(page.getByTestId('refus-offre')).toHaveCount(0);
    expect(sieges).toEqual([]);
    await page.getByRole('button', { name: 'Ajouter et inviter' }).click();
    await expect(page.getByText('Invitation envoyée à neuf@e2e.test.')).toBeVisible();
    // L'état de départ voyage avec la cible : une vue périmée serait refusée, jamais changée en retrait.
    expect(sieges).toEqual([{ depuis: 0, cible: 1 }]);
    expect(invitations).toHaveLength(2);
    await expect(bloc).toHaveCount(0);
  });

  test('annulé : ni siège ni invitation de plus', async ({ page }) => {
    const { invitations, sieges } = await monter(page, vuePro(0), { invitations: [{ status: 402, corps: REFUS_SIEGE }] });
    await inviter(page);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByTestId('siege-requis')).toHaveCount(0);
    expect([sieges, invitations.length]).toEqual([[], 1]);
  });

  test('🔴 le prorata pas payé : la phrase du serveur et la facture à régler, sans inviter', async ({ page }) => {
    const { invitations } = await monter(page, vuePro(0), {
      invitations: [{ status: 402, corps: REFUS_SIEGE }],
      sieges: { status: 402, corps: { error: 'Le paiement de l’utilisateur en plus n’a pas abouti : réglez la facture sur sa page.', code: 'paiement_siege_incomplet', url: 'https://invoice.stripe.com/i/e2e' } },
    });
    await inviter(page);
    await page.getByRole('button', { name: 'Ajouter et inviter' }).click();
    await expect(page.getByText('Le paiement de l’utilisateur en plus n’a pas abouti')).toBeVisible();
    await expect(page.getByTestId('siege-facture')).toHaveAttribute('href', 'https://invoice.stripe.com/i/e2e');
    expect(invitations).toHaveLength(1);
  });

  test('un refus sans siège (sièges pas en vente) : la phrase seule, rien à acheter', async ({ page }) => {
    const sans = { ...REFUS_SIEGE, error: 'Limite de votre offre atteinte : 3 utilisateurs. Passez en Entreprise pour la lever : https://console.e2e.test/offre' } as Record<string, unknown>;
    delete sans.siege;
    await monter(page, vuePro(0), { invitations: [{ status: 402, corps: sans }] });
    await inviter(page);
    await expect(page.getByText('Passez en Entreprise pour la lever', { exact: false }).first()).toBeVisible();
    await expect(page.getByTestId('siege-requis')).toHaveCount(0);
  });
});

test.describe('la page Offre et les sièges', () => {
  test('🔴 un Pro avec un utilisateur payé : il le lit, et le retire après confirmation, sans remboursement', async ({ page }) => {
    const { sieges } = await monter(page, vuePro(1));
    await page.goto('/offre');
    const bloc = page.getByTestId('offre-sieges');
    await expect(bloc).toContainText('3 utilisateurs, et 1 utilisateur payé en plus');
    await expect(bloc).toContainText('15 € HT par mois');
    await expect(bloc).toContainText('ne rembourse pas');
    await page.getByTestId('offre-retirer-siege').click();
    await repondre(page, true, 'n’est pas remboursée');
    await expect(bloc).toContainText('Votre formule Pro comprend 3 utilisateurs.');
    await expect(page.getByTestId('offre-retirer-siege')).toHaveCount(0);
    expect(sieges).toEqual([{ depuis: 1, cible: 0 }]);
  });

  test('un retrait annulé dans la fenêtre : rien ne part', async ({ page }) => {
    const { sieges } = await monter(page, vuePro(1));
    await page.goto('/offre');
    await page.getByTestId('offre-retirer-siege').click();
    await repondre(page, false);
    await expect(page.getByTestId('offre-sieges')).toContainText('1 utilisateur payé en plus');
    expect(sieges).toEqual([]);
  });

  test('un Pro annuel lit le prix annuel ; sans siège payé, rien à retirer', async ({ page }) => {
    await monter(page, vuePro(0, 'an'));
    await page.goto('/offre');
    await expect(page.getByTestId('offre-sieges')).toContainText('150 € HT par an');
    await expect(page.getByTestId('offre-retirer-siege')).toHaveCount(0);
  });

  test('un retrait refusé (des membres en trop) : la phrase du serveur', async ({ page }) => {
    await monter(page, vuePro(1), { sieges: { status: 409, corps: { error: 'Votre espace compte 4 membres actifs : désactivez-en d’abord.', code: 'membres_en_trop' } } });
    await page.goto('/offre');
    await page.getByTestId('offre-retirer-siege').click();
    await repondre(page, true);
    await expect(page.getByTestId('offre-sieges-erreur')).toContainText('désactivez-en d’abord');
  });

  test('une Free lit le prix d’un utilisateur en plus sous l’offre du Pro', async ({ page }) => {
    await monter(page, vueFree);
    await page.goto('/offre');
    await expect(page.getByTestId('offre-sieges-prix')).toContainText('15 € HT par mois');
    await expect(page.getByTestId('offre-sieges-prix')).toContainText('150 € HT par an');
  });
});
