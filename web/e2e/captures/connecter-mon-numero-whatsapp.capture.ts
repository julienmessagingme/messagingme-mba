import { test, expect } from '../aide/test';
import { mockAccueil } from '../support/accueil';
import { NAVIGATEUR, REGLAGES_ACCUEIL, capturer, communs, langue, type Locale } from './donnees-demo';
import { fenetreMeta } from './fenetre-meta';

/**
 * « Connecter mon numéro WhatsApp, et lire son état » : la fenêtre de Meta (sa forme générique, `fenetre-meta.ts`), la
 * page « Connecter WhatsApp » (le numéro fourni), un numéro rattaché que Meta n'a pas vérifié, puis un numéro connecté
 * et son état. Rien n'est connecté, rien n'est payé.
 */
const CLE = 'connecter-mon-numero-whatsapp';
/** Le numéro de la marque fictive, dans la plage réservée à la fiction. */
const COMPTE = {
  number: '+33 6 39 98 01 00', verifiedName: 'Votre marque', ownerBusinessName: 'Votre marque', phoneNumberId: 'pn-demo',
};
const VOLUMES = {
  whatsapp: { envoyes: 1284, recus: 937 }, rcs: null,
};

for (const locale of ['fr', 'en'] as Locale[]) {
  test.describe(locale, () => {
    test.use(NAVIGATEUR[locale]);

    test(`${CLE} (${locale}) : la fenêtre de Meta`, async ({ page }) => {
      // 1. La fenêtre de Meta n'est pas la nôtre : sa forme générique, en trois étapes, comme le film du démarrage.
      await page.setContent(fenetreMeta(locale));
      await capturer(page, CLE, 1, locale);
    });

    test(`${CLE} (${locale}) : la page Connecter WhatsApp`, async ({ page }) => {
      await langue(page, locale);
      const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/api/backend/**', (route) => route.fulfill(json({})));
      await page.route('**/api/backend/tenants/*/connexion-numero', (route) => route.fulfill(json({
        etat: { fourni: null, code: null, connecte: null, abonnement: null, inclusDansLePro: true }, empreinte: '0123456789abcdef',
      })));
      await communs(page);
      await page.goto('/connecter-whatsapp');
      // 2. Pas de numéro ? « Fournissez-moi un numéro ».
      await capturer(page, CLE, 2, locale, undefined, 'haut', page.getByTestId('choix-fourni'));
    });

    test(`${CLE} (${locale}) : numéro à vérifier`, async ({ page }) => {
      await langue(page, locale);
      // Le libellé que le serveur donne à un numéro pas encore connecté (`src/account/service.ts`), pas le vert d'un numéro actif.
      await mockAccueil(page, {
        account: {
          ...COMPTE, numberStatus: 'PENDING', codeVerificationStatus: 'NOT_VERIFIED',
          status: { dot: 'grey', label: 'Numéro non connecté', reason: 'Le numéro est en état « PENDING », pas encore connecté.' },
        },
        settings: REGLAGES_ACCUEIL,
      });
      await communs(page);
      await page.reload();
      // 3. Un numéro rattaché que Meta n'a pas vérifié : la carte le dit et porte le bouton.
      await expect(page.getByTestId('numero-card')).toBeVisible();
      await capturer(page, CLE, 3, locale, page.getByTestId('numero-card'), 'haut', page.getByTestId('demander-code'));
    });

    test(`${CLE} (${locale}) : numéro connecté`, async ({ page }) => {
      await langue(page, locale);
      await mockAccueil(page, { account: COMPTE, settings: REGLAGES_ACCUEIL, volumes: VOLUMES });
      await communs(page);
      await page.reload();
      // 4. L'état du numéro : sa carte, le compte WhatsApp Business, et les chiffres.
      await expect(page.getByTestId('numero-card')).toBeVisible();
      await capturer(page, CLE, 4, locale, page.getByTestId('numero-card'));
    });
  });
}
