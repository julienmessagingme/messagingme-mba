import { test, expect, type Page } from '@playwright/test';

/**
 * 🔴 UNE REQUÊTE DE FIL LENTE NE DOIT PAS ÊTRE RELANCÉE TOUTES LES 4 SECONDES (2026-09-13).
 *
 * Trouvé en revue du lot traduction, avant tout déploiement. Depuis que le fil se fait traduire, sa
 * requête peut durer jusqu'à 20 secondes (le plafond que s'accorde `creerTraducteur`), pendant que le
 * minuteur de l'écran la relance toutes les 4 secondes. Le code annulait alors la requête en vol, ce
 * qui semble propre et ne l'est pas : `abort()` ferme la connexion du NAVIGATEUR, il n'annule pas
 * l'appel au modèle, déjà parti et déjà facturé au crédit prépayé du client. Et comme le curseur du
 * delta ne se pose qu'à la RÉCEPTION d'une réponse, chaque tour repartait du fil ENTIER et relançait
 * une traduction complète : jusqu'à cinq fois le même lot payé par minute, en boucle tant que
 * l'opérateur reste sur la conversation, avec un écran qui peut ne jamais afficher la traduction
 * puisque chaque requête est tuée avant d'aboutir.
 *
 * 🔴 CE TEST COMPTE LES REQUÊTES, il ne regarde pas l'écran, et c'est le seul angle qui prouve quelque
 * chose ici : le défaut est INVISIBLE à l'affichage (le fil finit par apparaître), il ne se voit que
 * sur la facture. C'est la parade écrite dans `wip.md` après le motif vu deux fois sur les campagnes,
 * appliquée à un cas de dépense plutôt qu'à un corps de requête.
 *
 * ⚠️ LES DEUX SENS DANS LE MÊME FICHIER. Sans le second cas, une page qui aurait tout simplement cessé
 * de se rafraîchir passerait le premier haut la main, et on aurait remplacé une dépense en boucle par
 * une Inbox morte.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Ana Lenta', lastPreview: 'hola', lastMessageAt: '2026-09-13T10:00:00Z', controlOwner: 'app_human', unread: false },
];

const MESSAGES = [
  {
    id: 'm1', direction: 'in', type: 'text', body: 'Hola, tengo un problema',
    buttonPayload: null, createdAt: '2026-09-13T10:00:00Z', curseur: null,
    affiche: 'Bonjour, j ai un probleme', traduit: true, traductionEchouee: false,
  },
];

/**
 * Le fil répond après `latenceMs`, et CHAQUE appel est compté.
 *
 * ⚠️ LE CURSEUR RESTE NUL, délibérément : c'est le pire cas, celui où le tour suivant redemanderait le
 * fil ENTIER, donc celui où une relance coûte une traduction complète. Un curseur posé masquerait le
 * défaut au lieu de l'exercer.
 */
async function monter(page: Page, latenceMs: number): Promise<{ appelsFil: () => number }> {
  let appels = 0;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/conversations/unread-count')) return json({ count: 0 });
    if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: CONVERSATIONS });
    if (url.includes('/messages')) {
      appels += 1;
      if (latenceMs > 0) await new Promise((r) => setTimeout(r, latenceMs));
      return json({
        waId: '33600000001', windowOpen: true, lastInboundAt: '2026-09-13T10:00:00Z',
        controlOwner: 'app_human', messages: MESSAGES, langueContact: 'es',
      });
    }
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/inbox');
  await page.locator('li', { hasText: 'Ana Lenta' }).getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
  return { appelsFil: () => appels };
}

test('🔴 un fil LENT a traduire n est pas relance toutes les 4 secondes', async ({ page }) => {
  // 9 secondes de latence : plus de DEUX tours de minuteur tiennent dedans. Sans la garde, on
  // compterait trois appels ou plus ; avec elle, le tour qui tombe pendant le vol passe son tour.
  const { appelsFil } = await monter(page, 9_000);
  await page.waitForTimeout(13_000);
  const n = appelsFil();
  // Deux au plus : celui du montage, et AU PLUS un tour une fois le premier revenu.
  expect(n, `le fil a ete demande ${n} fois en 13 s alors qu une seule traduction etait due`).toBeLessThanOrEqual(2);
});

test('🔴 mais un fil RAPIDE continue de se rafraichir : la garde n a pas gele l Inbox', async ({ page }) => {
  const { appelsFil } = await monter(page, 0);
  await page.waitForTimeout(13_000);
  const n = appelsFil();
  // ~4 s par tour : trois tours au moins tiennent dans 13 s, plus le montage. On borne bas pour ne pas
  // dependre de la gigue du minuteur (0,8 a 1,2 fois la periode).
  expect(n, `le fil n a ete demande que ${n} fois en 13 s : le rafraichissement ne marche plus`).toBeGreaterThanOrEqual(3);
});
