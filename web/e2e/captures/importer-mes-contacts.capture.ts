import { test, expect } from '../aide/test';
import { CHAMPS_DEMO, CONTACTS_DEMO, NAVIGATEUR, capturer, communs, langue, type Locale } from './donnees-demo';

/**
 * « Ajouter ou importer mes contacts » : le menu d'ajout, l'import d'un fichier inventé (ses colonnes associées), la
 * case du consentement, puis la recherche et l'action en masse. Rien n'est importé.
 */
const CLE = 'importer-mes-contacts';
const CSV = 'Prénom,Nom,Téléphone,Ville\nLéa,Martin,+33639980101,Lyon\nHugo,Bernard,+33639980102,Paris\nInès,Petit,+33639980103,Lyon';
const L = {
  fr: { coller: /coller le texte/i, analyser: /Analyser/, consentement: /Consentement \(opt-in\) donné/, exempleEtiquette: 'salon-2026, prospect', etiquette: 'Étiquette…', action: /^Action/, filtres: /^Filtres/ },
  en: { coller: /paste the text/i, analyser: /Analyze/, consentement: /Consent \(opt-in\) given/, exempleEtiquette: 'expo-2026, prospect', etiquette: 'Tag…', action: /^Action/, filtres: /^Filters/ },
} as const;

for (const locale of ['fr', 'en'] as Locale[]) {
  test.describe(locale, () => {
    test.use(NAVIGATEUR[locale]);

    test(`${CLE} (${locale})`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (url.pathname.endsWith('/contacts/import/preview')) {
          return json({
            headers: ['Prénom', 'Nom', 'Téléphone', 'Ville'],
            sampleRows: [
              { Prénom: 'Léa', Nom: 'Martin', Téléphone: '+33639980101', Ville: 'Lyon' },
              { Prénom: 'Hugo', Nom: 'Bernard', Téléphone: '+33639980102', Ville: 'Paris' },
              { Prénom: 'Inès', Nom: 'Petit', Téléphone: '+33639980103', Ville: 'Lyon' },
            ],
            rowCount: 412,
            mapping: { columns: { Prénom: { target: 'custom', key: 'prenom' }, Nom: { target: 'name' }, Téléphone: { target: 'phone' }, Ville: { target: 'custom', key: 'ville' } } },
          });
        }
        if (url.pathname.endsWith('/contacts/count')) return json({ total: url.searchParams.get('tags') ? 186 : 412, count: 412 });
        if (url.pathname.endsWith('/contacts')) {
          const filtre = url.searchParams.get('tags') === 'clientes-fideles';
          return json({ contacts: filtre ? CONTACTS_DEMO.filter((c) => c.tags.includes('clientes-fideles')) : CONTACTS_DEMO, total: filtre ? 186 : 412 });
        }
        if (url.pathname.endsWith('/tags')) return json({ tags: ['clientes-fideles', 'newsletter', 'boutique-lyon'] });
        if (url.pathname.endsWith('/user-fields')) return json({ fields: CHAMPS_DEMO });
        return json({});
      });
      await communs(page);
      await page.goto('/contacts');
      await expect(page.getByText('Léa Martin').first()).toBeVisible();

      // 1. Le bouton d'ajout et ses deux chemins.
      await page.getByTestId('contacts-ajouter-menu').click();
      await expect(page.getByTestId('contact-importer-csv')).toBeVisible();
      await capturer(page, CLE, 1, locale, undefined, 'haut', page.getByTestId('contact-importer-csv'));

      // 2. L'import : le fichier collé, puis ses colonnes associées aux champs de la fiche.
      await page.getByTestId('contact-importer-csv').click();
      await page.getByText(L[locale].coller).click();
      await page.locator('textarea').first().fill(CSV);
      await page.getByRole('button', { name: L[locale].analyser }).click();
      await expect(page.getByText('Léa').first()).toBeVisible();
      // Le geste de l'étape : associer une colonne à un champ. JAMAIS le bouton « Importer » : il part tout de suite, avec
      // la case du consentement cochée d'office, que l'étape suivante seulement explique (relecture du lot 5).
      await capturer(page, CLE, 2, locale, undefined, 'haut', page.locator('select').first());

      // 3. Une étiquette pour tout le fichier, et la case du consentement, qui vaut pour tout le fichier.
      await page.getByPlaceholder(L[locale].exempleEtiquette).fill('salon-2026');
      const consentement = page.getByText(L[locale].consentement).first();
      // Le curseur va à l'étiquette, pas à la case : cochée d'office, un clic la DÉCOCHERAIT.
      await capturer(page, CLE, 3, locale, consentement, 'haut', page.getByPlaceholder(L[locale].exempleEtiquette));

      // 4. Retour à la liste : un filtre, une sélection, et le menu « Action ».
      await page.goto('/contacts');
      await page.getByRole('button', { name: L[locale].filtres }).click();
      const etiquette = page.getByPlaceholder(L[locale].etiquette).first();
      await etiquette.fill('clientes-fideles');
      await etiquette.press('Enter');
      await expect(page.getByText('Inès Petit').first()).toBeVisible();
      await page.getByRole('checkbox').nth(1).check();
      await page.getByRole('checkbox').nth(2).check();
      await page.getByRole('button', { name: L[locale].action }).first().click();
      await capturer(page, CLE, 4, locale, undefined, 'haut', page.getByRole('button', { name: L[locale].action }).first());
    });
  });
}
