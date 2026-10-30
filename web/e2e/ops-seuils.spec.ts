import { test, expect, type Page } from './aide/test';

/**
 * LES SEUILS RÉGLABLES ET LES ALERTES DE SANTÉ DANS `/ops` (refonte, lot 4). Ce que ces tests tiennent à l'écran : la
 * carte des seuils dans Réglages (les valeurs en vigueur, la note obligatoire, le champ fautif nommé en rouge, les
 * valeurs par défaut), les alertes envoyées dans les incidents de Santé, et une API d'avant le lot 4 qui ne fait rien
 * tomber.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const DEFAUTS = {
  accuses: { orange: 60, rouge: 120 }, entrants: { orange: 5, rouge: 30 }, connexions: { orange: 70, rouge: 85 },
  erreurs: { orange: 1, rouge: 5 }, battement: { orange: 120, rouge: 300 }, processeurBase: { orange: 60, rouge: 80 },
  processeurMachine: { orange: 60, rouge: 80 }, memoireWorker: { orange: 70, rouge: 85 }, secondeCopie: { orange: 3, rouge: 60 },
};
const REGLES = { ...DEFAUTS, processeurBase: { orange: 50, rouge: 75 } };

type Appel = { methode: string; corps: unknown };

async function monter(page: Page, o: { seuils?: 'absente' | 'ok'; refus?: string; alertesIllisibles?: boolean } = {}): Promise<Appel[]> {
  const appels: Appel[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = req.url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) return json({ tenants: [], daily: [], queues: [], workers: [] });
    if (chemin.endsWith('/ops/seuils')) {
      if (o.seuils === 'absente') return json({ error: 'Not Found' }, 404);
      if (req.method() === 'PATCH') {
        appels.push({ methode: 'PATCH', corps: req.postDataJSON() });
        if (o.refus) return json({ error: `champ invalide : ${o.refus}`, champ: o.refus }, 400);
        const envoye = req.postDataJSON() as { seuils: unknown; note: string };
        return json({ seuils: envoye.seuils, modifieLe: '2026-10-30T10:00:00.000Z', modifiePar: `exploitant@e2e.test : ${envoye.note}` });
      }
      return json({ seuils: REGLES, defauts: DEFAUTS, bornes: {}, modifieLe: '2026-10-30T09:00:00.000Z', modifiePar: 'exploitant@e2e.test : après le banc' });
    }
    if (chemin.endsWith('/ops/sante')) {
      return json({
        briques: [{ cle: 'processeur-base', etat: 'orange', mesure: 65 }],
        jauge: { margePourcent: 20, signal: 'processeur-base', partielle: false },
        connexions: { utilisees: 20, max: 147 }, meta: { dernierMessage: null, dernierAccuse: null },
        incidents: { erreurs5xx: 0, tachesEnEchec: 0, fileEchec: 0, demarrages: [], alertes: o.alertesIllisibles ? null : [
          { signal: 'processeur-base', etat: 'orange', mesure: 65, envoyeLe: '2026-10-30T09:05:00.000Z' },
        ] },
        seuils: REGLES,
      });
    }
    return json({});
  });
  return appels;
}

test.describe('Ops : les seuils réglables et les alertes', () => {
  test('🔴 Réglages : les seuils en vigueur et leur auteur ; la note obligatoire ; l’envoi de TOUS les signaux', async ({ page }) => {
    const appels = await monter(page);
    await page.goto('/ops?tab=reglages');
    await expect(page.getByTestId('ops-seuil-processeurBase-orange')).toHaveValue('50');
    await expect(page.getByTestId('ops-seuils-auteur')).toContainText('après le banc');
    await page.getByTestId('ops-seuil-processeurBase-rouge').fill('70');
    await page.getByTestId('ops-seuils-note').fill('alerte plus tôt sur la base');
    await page.getByTestId('ops-seuils-enregistrer').click();
    await expect(page.getByTestId('ops-seuils-ok')).toBeVisible();
    // L'auteur affiché est celui que le serveur a enregistré, pas l'ancien.
    await expect(page.getByTestId('ops-seuils-auteur')).toContainText('alerte plus tôt sur la base');
    const corps = appels[0]!.corps as { seuils: Record<string, { orange: number; rouge: number }>; note: string };
    expect(corps.note).toBe('alerte plus tôt sur la base');
    expect(corps.seuils.processeurBase).toEqual({ orange: 50, rouge: 70 });
    expect(Object.keys(corps.seuils).sort()).toEqual(Object.keys(DEFAUTS).sort());
  });

  test('🔴 un refus du serveur : le champ fautif bordé de rouge ; « valeurs par défaut » remet la spec', async ({ page }) => {
    await monter(page, { refus: 'memoireWorker.orange' });
    await page.goto('/ops?tab=reglages');
    await page.getByTestId('ops-seuil-memoireWorker-orange').fill('90');
    await page.getByTestId('ops-seuils-note').fill('essai');
    await page.getByTestId('ops-seuils-enregistrer').click();
    await expect(page.getByTestId('ops-seuils-erreur')).toBeVisible();
    await expect(page.getByTestId('ops-seuil-memoireWorker-orange')).toHaveClass(/border-danger/);
    await page.getByTestId('ops-seuils-defauts').click();
    await expect(page.getByTestId('ops-seuil-processeurBase-orange')).toHaveValue('60');
    await expect(page.getByTestId('ops-seuil-memoireWorker-orange')).toHaveValue('70');
  });

  test('Santé : les alertes Telegram des 24 h dans les incidents', async ({ page }) => {
    await monter(page);
    await page.goto('/ops');
    await expect(page.getByTestId('ops-alerte')).toContainText(/Processeur de la base|Database CPU/);
  });

  test('Santé : des alertes illisibles se disent, pas « aucune alerte »', async ({ page }) => {
    await monter(page, { alertesIllisibles: true });
    await page.goto('/ops');
    await expect(page.getByTestId('ops-alertes-illisibles')).toBeVisible();
    await expect(page.getByTestId('ops-alertes-aucune')).toHaveCount(0);
  });

  test('⚠️ une API d’avant le lot 4 (404) : la carte le dit, la page tient', async ({ page }) => {
    await monter(page, { seuils: 'absente' });
    await page.goto('/ops?tab=reglages');
    await expect(page.getByTestId('ops-seuils-absente')).toBeVisible();
  });
});
