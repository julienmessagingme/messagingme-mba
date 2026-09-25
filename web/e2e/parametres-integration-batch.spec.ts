import { test, expect, type Page } from '@playwright/test';

/**
 * PARAMÈTRES > INTÉGRATIONS > BATCH (lot 6 de l'API publique, spec 2026-09-24, § 8).
 *
 * 🔴 CE QUE SEUL CE TEST PEUT VOIR : ce que l'écran ENVOIE (jamais une clé vide, jamais une clé déjà
 * enregistrée), et ce qu'il MONTRE (le compte des signaux non poussés, le refus des clés). Le serveur tient sa
 * frontière de son côté (`tests/http-integration-batch.test.ts`).
 */
interface Trace { puts: Array<Record<string, unknown>>; suppressions: number }

async function monter(page: Page, initial: Record<string, unknown>, lectureEnPanne = false): Promise<Trace> {
  const trace: Trace = { puts: [], suppressions: 0 };
  const session = { token: 'e2e-token', email: 'moi@e2e.test', role: 'admin', tenantId: 't-e2e' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  let etat: Record<string, unknown> = initial;
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/integrations/batch')) {
      if (req.method() === 'PUT') {
        const corps = req.postDataJSON() as Record<string, unknown>;
        trace.puts.push(corps);
        etat = { branche: true, envoyerResume: corps.envoyerResume === true, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: null, majLe: '2026-09-24T10:00:00.000Z' };
        return json(etat);
      }
      if (req.method() === 'DELETE') {
        trace.suppressions += 1;
        etat = { branche: false };
        return json(etat);
      }
      if (lectureEnPanne) return json({ error: 'lecture en panne' }, 500);
      return json(etat);
    }
    if (chemin.endsWith('/settings/agents-peuvent-prendre')) return json({ actif: false });
    if (chemin.endsWith('/settings')) return json({ mbaEnabled: false, autoRetryEnabled: false, timezone: 'Europe/Paris', businessHours: {} });
    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: 'moi@e2e.test', name: 'Moi', role: 'admin' });
    return json({});
  });
  await page.goto('/parametres');
  return trace;
}

test.describe('Paramètres > Intégrations > Batch', () => {
  test('🔴 non branché : il faut les DEUX clés, et le résumé part décoché', async ({ page }) => {
    const trace = await monter(page, { branche: false });
    const bouton = page.getByTestId('integration-batch-enregistrer');
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Non branché|Not connected/);
    await expect(bouton).toBeDisabled();
    // `new-password`, pas `off` : Chrome ignore `off` sur un champ mot de passe et y remplirait celui de la console.
    for (const champ of ['integration-batch-cle-rest', 'integration-batch-cle-projet']) {
      await expect(page.getByTestId(champ)).toHaveAttribute('autocomplete', 'new-password');
    }
    await page.getByTestId('integration-batch-cle-rest').fill('cle-rest-e2e');
    await expect(bouton).toBeDisabled();
    await page.getByTestId('integration-batch-cle-projet').fill('projet-e2e');
    await expect(page.getByTestId('integration-batch-resume')).not.toBeChecked();
    await bouton.click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    expect(trace.puts[0]).toEqual({ cleRest: 'cle-rest-e2e', cleProjet: 'projet-e2e', envoyerResume: false });
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Branché|Connected/);
    // Les clés ne restent pas à l'écran une fois enregistrées.
    await expect(page.getByTestId('integration-batch-cle-rest')).toHaveValue('');
    await expect(page.getByTestId('integration-batch-cle-projet')).toHaveValue('');
  });

  test('🔴 branché : le compte des signaux non poussés se voit, et l’option s’enregistre SANS renvoyer les clés', async ({ page }) => {
    const trace = await monter(page, {
      branche: true, envoyerResume: false, sansIdentifiant: 12, sansIdentifiantLe: '2026-09-24T09:00:00.000Z', refusClesLe: null, majLe: '2026-09-24T08:00:00.000Z',
    });
    await expect(page.getByTestId('integration-batch-sans-identifiant')).toContainText('12');
    await page.getByTestId('integration-batch-resume').check();
    await page.getByTestId('integration-batch-enregistrer').click();
    await expect.poll(() => trace.puts.length, { timeout: 10_000 }).toBe(1);
    expect(trace.puts[0]).toEqual({ envoyerResume: true });
  });

  test('🔴 des clés refusées par l’outil se voient', async ({ page }) => {
    await monter(page, {
      branche: true, envoyerResume: false, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: '2026-09-24T09:30:00.000Z', majLe: '2026-09-24T08:00:00.000Z',
    });
    await expect(page.getByTestId('integration-batch-refus')).toBeVisible();
  });

  test('🔴 une réponse sans `branche` se lit « non branché », sans faire tomber la page', async ({ page }) => {
    await monter(page, {});
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Non branché|Not connected/);
    await expect(page.getByTestId('param-timezone')).toBeVisible();
  });

  test('🔴 une lecture en ÉCHEC ne dit pas « non branché », et rien ne s’enregistre sur un état non lu', async ({ page }) => {
    await monter(page, { branche: true, envoyerResume: false, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: null, majLe: '2026-09-24T08:00:00.000Z' }, true);
    await expect(page.getByTestId('integration-batch-erreur')).toBeVisible();
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/État inconnu|Unknown state/);
    await expect(page.getByTestId('integration-batch-etat')).not.toContainText(/Non branché|Not connected/);
    await page.getByTestId('integration-batch-cle-rest').fill('cle-rest-e2e');
    await page.getByTestId('integration-batch-cle-projet').fill('projet-e2e');
    await expect(page.getByTestId('integration-batch-enregistrer')).toBeDisabled();
  });

  test('🔴 débrancher se CONFIRME : refusé, rien ne part ; accepté, le débranchement part', async ({ page }) => {
    // Le geste efface les deux clés ET le compte des signaux non poussés, sans retour possible.
    const trace = await monter(page, {
      branche: true, envoyerResume: false, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: null, majLe: '2026-09-24T08:00:00.000Z',
    });
    const dialogues: string[] = [];
    let accepter = false;
    page.on('dialog', (d) => { dialogues.push(d.message()); void (accepter ? d.accept() : d.dismiss()); });

    await page.getByTestId('integration-batch-debrancher').click();
    await expect.poll(() => dialogues.length).toBe(1);
    expect(dialogues[0]).toMatch(/clés|keys/);
    expect(trace.suppressions).toBe(0);
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Branché|Connected/);

    accepter = true;
    await page.getByTestId('integration-batch-debrancher').click();
    await expect.poll(() => trace.suppressions, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('integration-batch-etat')).toContainText(/Non branché|Not connected/);
  });
});
