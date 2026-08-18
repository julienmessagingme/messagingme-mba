import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';

/** Sites web, fichiers de connaissance, liste d'autorisation : trois ressources simples, trois refus utiles. */

test.describe('MBA Paramètres : sites web', () => {
  test('🔴 adresse sans schéma refusée AVANT tout appel réseau', async ({ page }) => {
    // Le schéma Meta est un simple `string` sans contrainte : une adresse sans `https://` revient en 400
    // générique. Autant refuser ici, en nommant le problème.
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=sites');
    await page.getByTestId('mba-website-url').fill('www.exemple.fr');
    await page.getByTestId('mba-website-add').click();
    await expect(page.getByTestId('mba-websites-error')).toContainText('https://');
    expect(appelsMba(calls, 'POST', '/websites')).toHaveLength(0);
  });

  test('adresse complète acceptée', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=sites');
    await page.getByTestId('mba-website-url').fill('https://www.exemple.fr/aide');
    await page.getByTestId('mba-website-add').click();
    await expect.poll(() => appelsMba(calls, 'POST', '/websites')[0]?.body).toEqual({ url: 'https://www.exemple.fr/aide' });
  });

  test('un statut d’exploration inconnu n’est JAMAIS présenté comme un succès', async ({ page }) => {
    // Meta déclare `crawl_status` sans énumération, se contredit sur la casse, et le champ peut être absent.
    await mockMba(page, {
      websites: [
        { id: 'w1', url: 'https://a.fr', crawl_status: 'completed', pages_crawled: 42 },
        { id: 'w2', url: 'https://b.fr', crawl_status: 'something_new' },
        { id: 'w3', url: 'https://c.fr' },
      ],
    });
    await page.goto('/mba/parametres?tab=sites');
    const liste = page.getByTestId('mba-websites-list');
    await expect(liste).toContainText(/Exploré|Crawled/);
    await expect(liste).toContainText('something_new');
    await expect(liste).toContainText(/Inconnu|Unknown/);
  });
});

test.describe('MBA Paramètres : fichiers', () => {
  test('🔴 un nom qui ne correspond pas au contenu est refusé sans envoi', async ({ page }) => {
    // `file_name` est un champ séparé du binaire chez Meta : une extension incohérente peut passer en 201 et
    // n'être jamais indexée. Échec silencieux, le pire des cas.
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=fichiers');
    await page.getByTestId('mba-file-input').setInputFiles({ name: 'guide.docx', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(page.getByTestId('mba-files-error')).toBeVisible();
    expect(appelsMba(calls, 'POST', '/files')).toHaveLength(0);
  });

  test('format absent du schéma Meta refusé côté client', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=fichiers');
    await page.getByTestId('mba-file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('bonjour') });
    await expect(page.getByTestId('mba-files-error')).toContainText(/PDF/);
    expect(appelsMba(calls, 'POST', '/files')).toHaveLength(0);
  });

  test('un PDF part, et l’écran dit que l’indexation n’est pas vérifiable', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=fichiers');
    await page.getByTestId('mba-file-input').setInputFiles({ name: 'guide.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 contenu') });
    await expect.poll(() => appelsMba(calls, 'POST', '/files')[0]?.body?.fileName).toBe('guide.pdf');
    await expect(page.getByTestId('mba-files-list')).toContainText(/indexation|Indexing/i);
  });
});

test.describe('MBA Paramètres : liste d’autorisation', () => {
  test('avertit quand la liste ne sert à rien (audience ouverte)', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba/parametres?tab=allowlist');
    await expect(page.getByTestId('mba-allowlist-inactive')).toBeVisible();
  });

  test('avertit quand l’audience est restreinte et la liste vide (agent muet)', async ({ page }) => {
    await mockMba(page, {
      status: { settings: { agent_id: 'AG1', rollout: { enabled: true }, ai_audience: 'ALLOWLISTED_ONLY', never_say_phrases: [], followup: { enabled: false } } },
    });
    await page.goto('/mba/parametres?tab=allowlist');
    await expect(page.getByTestId('mba-allowlist-empty')).toBeVisible();
  });

  test('ajoute un numéro', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=allowlist');
    await page.getByTestId('mba-allowlist-phone').fill('06 33 92 15 77');
    await page.getByTestId('mba-allowlist-add').click();
    await expect.poll(() => appelsMba(calls, 'POST', '/allowlist')[0]?.body).toEqual({ phone: '06 33 92 15 77' });
  });
});
