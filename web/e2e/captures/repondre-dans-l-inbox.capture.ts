import { test, expect } from '../aide/test';
import { NAVIGATEUR, capturer, communs, langue, type Locale } from './donnees-demo';

/**
 * « Répondre à un client dans l'Inbox » : le dossier « À traiter », une conversation ouverte avec son détail, la réponse
 * en cours d'écriture, puis le menu « Ranger dans… ». Rien n'est envoyé.
 */
const CLE = 'repondre-dans-l-inbox';
const L = {
  fr: { aTraiter: /À traiter/, repondre: /Écrivez votre réponse|Répondre \(fenêtre/, ranger: /Ranger dans/, ouvrir: /^Ouvrir la conversation$/, selection: 'Sélectionner cette conversation' },
  en: { aTraiter: /To handle/, repondre: /Write your reply|Reply \(24h/, ranger: /File in/, ouvrir: /^Open (the )?conversation$/, selection: 'Select this conversation' },
} as const;

const conv = (id: string, nom: string, apercu: string, heure: string, autres: Record<string, unknown> = {}) => ({
  id, waId: `336399801${id.slice(1).padStart(2, '0')}`, profileName: nom, lastPreview: apercu,
  lastMessageAt: `2026-10-21T${heure}:00Z`, controlOwner: 'app_human', unread: false, curseur: `2026-10-21T${heure}:00Z`,
  signaleeMain: false, ...autres,
});
const CONVERSATIONS = [
  conv('c1', 'Léa Martin', 'La veste camel existe en 38 ?', '08:42', { unread: true }),
  conv('c3', 'Inès Petit', 'Je peux passer la retirer samedi ?', '08:15', { unread: true }),
  conv('c2', 'Hugo Bernard', 'Merci pour l’info, bonne journée !', '07:58'),
  conv('c5', 'Chloé Garnier', 'Le code AUTOMNE20 marche en boutique ?', '07:31'),
  conv('c6', 'Nathan Roux', 'Parfait, à demain alors.', '06:50'),
];
const MESSAGES = [
  { id: 'm1', direction: 'out', type: 'template', body: 'Bonjour Léa 🍂 La collection d’automne est arrivée : -20 % avec le code AUTOMNE20.', buttonPayload: null, createdAt: '2026-10-20T09:00:00Z', status: 'read' },
  { id: 'm2', direction: 'in', type: 'text', body: 'Bonjour ! Elle est superbe cette collection 😍', buttonPayload: null, createdAt: '2026-10-21T08:40:00Z' },
  { id: 'm3', direction: 'in', type: 'text', body: 'La veste camel existe en 38 ?', buttonPayload: null, createdAt: '2026-10-21T08:42:00Z' },
];
const DETAIL = {
  conversationId: 'c1',
  identite: {
    contactId: 'c1', waId: '33639980101', nom: 'Martin', prenom: 'Léa', telephone: '+33639980101',
    email: 'lea@exemple.test', tags: ['clientes-fideles'], desabonne: false, bloque: false,
  },
  resume: 'Cliente fidèle, demande si la veste camel de la collection d’automne existe en 38.',
  assignation: null,
  historique: [
    { id: '2', type: 'rouverte', at: '2026-10-21T08:40:00Z', acteur: null, cible: null, cause: 'message du contact', reassignation: false },
  ],
};

for (const locale of ['fr', 'en'] as Locale[]) {
  test.describe(locale, () => {
    test.use(NAVIGATEUR[locale]);

    test(`${CLE} (${locale})`, async ({ page }) => {
      await langue(page, locale);
      await page.route('**/api/backend/**', async (route) => {
        const url = route.request().url();
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (/\/conversations\/c1\/detail$/.test(url)) return json(DETAIL);
        if (/\/conversations\/counts/.test(url)) return json({ tout: 5, aTraiter: 2, signalees: 0, archivees: 0, traitees: 3, nonAffectees: 2, parMembre: [] });
        if (/\/conversations\/c1\/messages/.test(url)) {
          return json({ messages: MESSAGES, windowOpen: true, controlOwner: 'app_human', waId: '33639980101', lastInboundAt: '2026-10-21T08:42:00Z' });
        }
        if (/\/conversations\?|\/conversations$/.test(url)) {
          // Le dossier « À traiter » : les deux conversations où la balle est dans le camp de l'équipe.
          return json({ conversations: /traiter/i.test(url) && !/traitee/i.test(url) ? CONVERSATIONS.filter((c) => c.unread) : CONVERSATIONS });
        }
        if (url.includes('/users')) return json({ users: [{ id: 'u1', email: 'lea@votre-marque.test', name: 'Léa Martin', role: 'admin' }, { id: 'u2', email: 'tom@votre-marque.test', name: 'Tom Lefèvre', role: 'agent' }] });
        return json({});
      });
      await communs(page);
      await page.goto('/inbox');

      // 1. Le dossier « À traiter ».
      await page.getByRole('button', { name: L[locale].aTraiter }).first().click();
      await expect(page.getByText('Léa Martin').first()).toBeVisible();
      await capturer(page, CLE, 1, locale);

      // 2. La conversation de Léa, et son détail sous la liste.
      await page.getByRole('button', { name: L[locale].ouvrir }).first().click();
      await expect(page.getByText('La veste camel existe en 38 ?').last()).toBeVisible();
      await capturer(page, CLE, 2, locale);

      // 3. La réponse, écrite et pas encore envoyée.
      await page.getByPlaceholder(L[locale].repondre).fill('Oui, elle existe en 38 ! Je vous la mets de côté jusqu’à samedi ?');
      await capturer(page, CLE, 3, locale);

      // 4. Ranger : deux conversations cochées, et le même menu « Ranger dans… » au-dessus de la liste (une liste
      // déroulante native ne se dessine pas dans une capture, la sélection montre où il est).
      for (const c of await page.getByRole('checkbox', { name: L[locale].selection }).all()) await c.check();
      await capturer(page, CLE, 4, locale);
    });
  });
}
