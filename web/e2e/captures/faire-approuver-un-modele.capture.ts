import { test } from '../aide/test';
import { CHAMPS_DEMO, MODELE_AUTOMNE, MODELE_SUIVI, NAVIGATEUR, capturer, communs, langue, type Locale } from './donnees-demo';

/**
 * « Créer un modèle et le faire approuver » : l'éditeur de l'écran Templates, rempli d'un modèle de la marque fictive
 * (l'offre d'hiver), étape par étape, jusqu'au bouton qui le soumet à WhatsApp. Rien n'est soumis.
 */
const CLE = 'faire-approuver-un-modele';
const L = {
  fr: { creer: /Créer un template/, corps: /Corps du message/i, sept: '7 jours', soumettre: /Créer le template/, pied: /Petit texte en bas/, exemple: /ex\./ },
  en: { creer: /Create a template/, corps: /Message body/i, sept: '7 days', soumettre: /Create template/, pied: /Short text at the bottom|Small text/i, exemple: /e\.g\./ },
} as const;

for (const locale of ['fr', 'en'] as Locale[]) {
  test.describe(locale, () => {
    test.use(NAVIGATEUR[locale]);

    test(`${CLE} (${locale})`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', async (route) => {
        const url = route.request().url();
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (url.includes('/param-hints')) return json({ hints: [] });
        if (url.includes('/dossiers')) return json({ dossiers: [] });
        if (url.includes('/templates')) return json({ templates: [MODELE_AUTOMNE, MODELE_SUIVI] });
        if (url.includes('/flows')) return json({ flows: [] });
        if (url.includes('/user-fields')) return json({ fields: CHAMPS_DEMO });
        return json({});
      });
      await communs(page);
      await page.goto('/templates');
      await page.getByRole('button', { name: L[locale].creer }).first().click();

      // 1. Le message : son nom, son corps, son pied de page.
      await page.getByTestId('template-nom').fill('offre_hiver');
      const corps = page.getByRole('textbox', { name: L[locale].corps });
      await corps.fill('Bonjour {{1}} ❄️ Notre collection d’hiver arrive : découvrez-la en avant-première avec le code HIVER15.');
      await page.getByPlaceholder(L[locale].pied).fill('Répondez STOP pour ne plus recevoir nos offres');
      await capturer(page, CLE, 1, locale, page.getByTestId('template-nom'));

      // 2. La variable, et l'exemple que WhatsApp demande.
      await page.getByPlaceholder(L[locale].exemple).first().fill('Léa');
      await capturer(page, CLE, 2, locale, corps);

      // 3. La durée de validité : sept jours pour une offre.
      await page.getByTestId('template-duree').selectOption({ label: L[locale].sept });
      await capturer(page, CLE, 3, locale, page.getByTestId('template-duree'));

      // 4. La langue choisie en haut, puis le bouton qui soumet le modèle à WhatsApp (il n'est pas cliqué).
      await capturer(page, CLE, 4, locale, page.getByRole('button', { name: L[locale].soumettre }), 'bas');
    });
  });
}
