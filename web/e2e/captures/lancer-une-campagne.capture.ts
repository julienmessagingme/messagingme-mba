import { test, expect } from '../aide/test';
import { poserFaux } from '../aide/assistant';
import {
  CHAMPS_DEMO, CONTACTS_DEMO, MODELE_AUTOMNE, MODELE_SUIVI, NAVIGATEUR, NUMEROS_DEMO, REGLAGES_DEMO, TAGS_DEMO,
  capturer, communs, langue, type Locale,
} from './donnees-demo';

/**
 * « Lancer une campagne » : les cinq étapes de l'assistant, traversées comme une personne le ferait, avec la campagne
 * de la collection d'automne envoyée aux clientes fidèles. L'assistant n'est pas traduit : la version anglaise montre
 * les mêmes écrans, dans la console en anglais.
 */
const CLE = 'lancer-une-campagne';
const FIDELES = CONTACTS_DEMO.filter((c) => c.tags.includes('clientes-fideles'));

for (const locale of ['fr', 'en'] as Locale[]) {
  test.describe(locale, () => {
    test.use(NAVIGATEUR[locale]);

    test(`${CLE} (${locale})`, async ({ page }) => {
      await langue(page, locale);
      await poserFaux(page, {
        templates: [MODELE_AUTOMNE, MODELE_SUIVI], tags: TAGS_DEMO, contacts: CONTACTS_DEMO, total: 412,
        userFields: CHAMPS_DEMO, phoneNumbers: NUMEROS_DEMO, settings: REGLAGES_DEMO,
        users: [{ id: 'u1', email: 'lea@votre-marque.test', name: 'Léa Martin', role: 'admin' }],
      });
      // La liste et le compteur suivent le filtre d'étiquette, comme le serveur.
      await page.route('**/api/backend/**/contacts**', async (route) => {
        const url = new URL(route.request().url());
        const filtre = url.searchParams.get('tags') === 'clientes-fideles';
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (url.pathname.endsWith('/contacts/count')) return json({ total: filtre ? 186 : 412 });
        if (url.pathname.endsWith('/contacts')) return json({ contacts: filtre ? FIDELES : CONTACTS_DEMO });
        return route.fallback();
      });
      await communs(page);
      await page.goto('/campaigns/nouvelle');

      // 1. Le nom, et la nature de la campagne.
      await page.getByLabel('Nom de la campagne').fill('Collection d’automne');
      await capturer(page, CLE, 1, locale);
      await page.getByRole('button', { name: 'Suivant' }).click();

      // 2. Le canal, et les heures d'ouverture.
      await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Envoyer uniquement pendant les heures ouvrées' }).check();
      await capturer(page, CLE, 2, locale);
      await page.getByRole('button', { name: 'Suivant' }).click();

      // 3. Le contenu : le modèle de la collection d'automne, et son aperçu.
      await page.getByTestId('etage-1').click();
      await page.getByTestId('modele-1').selectOption(MODELE_AUTOMNE.name);
      await expect(page.getByTestId('apercu-1')).toBeVisible({ timeout: 15_000 });
      await capturer(page, CLE, 3, locale);
      await page.getByRole('button', { name: 'Suivant' }).click();

      // 4. L'audience : les clientes fidèles, et le compteur.
      // Le filtre des contacts est un composant partagé, lui traduit.
      const etiquette = page.getByPlaceholder(locale === 'fr' ? 'Étiquette…' : 'Tag…').first();
      await etiquette.fill('clientes-fideles');
      await etiquette.press('Enter');
      await expect(page.getByText(/186 contact/).first()).toBeVisible();
      await capturer(page, CLE, 4, locale);
      await page.getByRole('button', { name: 'Suivant' }).click();

      // 5. Le récapitulatif : « Plus tard », demain à 10 h.
      await page.getByTestId('quand-plus_tard').click();
      await page.getByLabel('Date et heure du départ').fill('2026-10-22T10:00');
      await capturer(page, CLE, 5, locale, page.getByRole('heading', { name: 'Récapitulatif' }));
    });
  });
}
