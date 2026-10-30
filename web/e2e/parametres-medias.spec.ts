import { test, expect, type Page } from './aide/test';
import { repondre } from './aide/confirmation';

/**
 * LA MÉDIATHÈQUE (spec médias du 2026-10-14, lot B). L'écran montre ce que pèsent les fichiers face au quota de l'offre,
 * les liste, et la suppression d'un fichier encore utilisé est refusée avec ce qui l'utilise, quand celle d'un fichier
 * inutilisé part et le retire de la liste.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const MO = 1024 * 1024;
const UTILISE = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIBRE = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const fichier = (code: string, nom: string, taille: number) => ({
  id: code, code, mime: 'image/png', taille, nom, createdAt: '2026-10-15T09:00:00.000Z', url: `https://api.e2e.test/m/${code}.png`,
});

async function monter(page: Page) {
  const supprimes: string[] = [];
  /** Les noms des fichiers reçus par le dépôt, dans l'ordre d'arrivée. */
  const deposes: string[] = [];
  let fichiers = [fichier(UTILISE, 'banniere.png', MO), fichier(LIBRE, 'ancien.png', MO / 2)];
  // Les vignettes ne sont jamais jointes : une réponse vide suffit.
  await page.route('https://api.e2e.test/m/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: '' }));
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'GET' && chemin.endsWith('/rcs/media')) {
      return json({ fichiers, occupation: fichiers.reduce((n, f) => n + f.taille, 0), quota: 100 * MO });
    }
    if (req.method() === 'DELETE' && chemin.includes('/rcs/media/')) {
      const code = chemin.split('/').pop()!;
      supprimes.push(code);
      if (code === UTILISE) {
        return json({ error: 'ce fichier est encore utilisé', code: 'media_utilise', utilisations: [{ lieu: 'scenario', nom: 'Bienvenue' }] }, 409);
      }
      fichiers = fichiers.filter((f) => f.code !== code);
      return route.fulfill({ status: 204, body: '' });
    }
    if (req.method() === 'POST' && chemin.endsWith('/rcs/media')) {
      const corps = (req.postDataJSON() ?? {}) as { nom?: string; dataUrl?: string };
      deposes.push(corps.nom ?? '');
      // Le vrai serveur relit la signature du fichier ; le faux range tout en PNG, l'écran ne lit que la liste.
      const code = `c${String(deposes.length).padStart(25, '0')}`;
      const neuf = fichier(code, corps.nom ?? code, 1000);
      fichiers = [neuf, ...fichiers];
      return json({ media: neuf, url: neuf.url, existant: false }, 201);
    }
    return json({});
  });
  return { supprimes, deposes };
}

test.describe('la médiathèque', () => {
  /**
   * 🔴 ON AJOUTE DEPUIS LA MÉDIATHÈQUE ELLE-MÊME (Julien, 2026-10-30). Plusieurs fichiers d'un coup : ceux qui passent les
   * règles du champ partent, un par un, et celui qui ne les passe pas est refusé AVANT l'envoi, avec son nom.
   */
  test('🔴 ajoute des fichiers depuis la page, et nomme celui qui est refusé avant l’envoi', async ({ page }) => {
    const { deposes } = await monter(page);
    await page.goto('/parametres/medias');
    await expect(page.getByTestId('medias-ligne')).toHaveCount(2);
    await expect(page.getByTestId('medias-ajouter')).toBeVisible();

    await page.getByTestId('medias-ajouter-fichier').setInputFiles([
      { name: 'visuel.png', mimeType: 'image/png', buffer: Buffer.from('png') },
      { name: 'film.mov', mimeType: 'video/quicktime', buffer: Buffer.from('mov') },
      { name: 'brochure.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') },
    ]);

    await expect(page.getByTestId('medias-ligne')).toHaveCount(4);
    await expect(page.getByTestId('medias-info')).toHaveText('2 fichiers ajoutés.');
    await expect(page.getByTestId('medias-erreur')).toContainText('« film.mov » : Cette vidéo est au format MOV');
    expect(deposes).toEqual(['visuel.png', 'brochure.pdf']);
  });

  test('montre le poids face au quota, et la liste des fichiers', async ({ page }) => {
    await monter(page);
    await page.goto('/parametres/medias');
    await expect(page.getByTestId('medias-jauge')).toContainText('1,5 Mo utilisés sur 100 Mo');
    await expect(page.getByTestId('medias-ligne')).toHaveCount(2);
  });

  test('🔴 refuse de supprimer un fichier utilisé, en disant par quoi ; supprime un fichier libre', async ({ page }) => {
    const { supprimes } = await monter(page);
    await page.goto('/parametres/medias');

    await page.getByTestId('medias-ligne').filter({ hasText: 'banniere.png' }).getByRole('button', { name: 'Supprimer' }).click();
    await repondre(page, true, /banniere\.png/);
    await expect(page.getByTestId('medias-erreur')).toContainText('Utilisé par le scénario « Bienvenue »');
    await expect(page.getByTestId('medias-ligne')).toHaveCount(2);

    await page.getByTestId('medias-ligne').filter({ hasText: 'ancien.png' }).getByRole('button', { name: 'Supprimer' }).click();
    await repondre(page, true, /ancien\.png/);
    await expect(page.getByTestId('medias-ligne')).toHaveCount(1);
    await expect(page.getByTestId('medias-jauge')).toContainText('1 Mo utilisés sur 100 Mo');
    expect(supprimes).toEqual([UTILISE, LIBRE]);
  });
});
