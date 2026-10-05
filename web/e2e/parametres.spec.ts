import { test, expect, type Page } from '@playwright/test';

/**
 * E2E page Paramètres : le fuseau se règle (PATCH .../settings/timezone) et les heures d'ouverture
 * S'ENREGISTRENT D'ELLES-MÊMES (PATCH .../settings/business-hours, 7 jours), sans bouton. Backend intercepté,
 * aucune base requise (pattern des E2E accueil).
 *
 * 🔴 POURQUOI (2026-10-05) : sur Groupama PJ, l'écran montrait du lundi au vendredi de 9 h à 18 h quand la base
 * portait `null`. Les horaires avaient été saisis sans cliquer « Enregistrer les horaires », et rien ne le
 * signalait. Décision de Julien : « à partir du moment où ils sont rentrés, il faut qu'ils soient enregistrés ».
 *
 * ⚠️ Les attentes de 1,5 s ne sont pas du confort : l'envoi part 800 ms après la dernière modification. Une
 * ABSENCE d'envoi ne se constate qu'après ce délai, sinon elle est garantie d'avance.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const BUSINESS_HOURS = {
  '0': { closed: true, open: '', close: '' }, '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' }, '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' }, '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};
const SETTINGS = { controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, timezone: 'Europe/Paris', businessHours: BUSINESS_HOURS };
const PLUS_QUE_LE_DELAI = 1500;

type Patch = { url: string; body: Record<string, unknown> };
type Jour = { closed: boolean; open: string; close: string };

/**
 * Monte la page et rend les PATCH reçus. `refus` : combien d'enregistrements d'horaires échouent (500) d'abord ;
 * `lectureRatee` : la lecture des réglages échoue.
 */
async function monter(page: Page, o: { refus?: number; lectureRatee?: boolean } = {}): Promise<Patch[]> {
  const patches: Patch[] = [];
  let refus = o.refus ?? 0;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'PATCH' && url.includes('/settings/timezone')) {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      patches.push({ url, body });
      return json({ timezone: body.timezone });
    }
    if (req.method() === 'PATCH' && url.includes('/settings/business-hours')) {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      patches.push({ url, body });
      if (refus > 0) { refus -= 1; return json({ error: 'panne' }, 500); }
      return json({ businessHours: body.businessHours });
    }
    if (url.includes('/settings')) return o.lectureRatee ? json({ error: 'panne' }, 500) : json(SETTINGS);
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/parametres');
  if (!o.lectureRatee) await expect(page.getByTestId('param-hours')).toBeVisible();
  return patches;
}

const horaires = (patches: Patch[]) => patches.filter((p) => p.url.includes('/settings/business-hours'));
const jour = (p: Patch, d: string) => (p.body.businessHours as Record<string, Jour>)[d];

test.describe('Paramètres : fuseau + heures d’ouverture', () => {
  test('règle le fuseau, et les horaires partent d’eux-mêmes : sans bouton, et rien au chargement', async ({ page }) => {
    const patches = await monter(page);

    // Fuseau : présélectionné, puis changé -> PATCH .../settings/timezone { timezone }.
    const tz = page.getByTestId('param-timezone');
    await expect(tz).toHaveValue('Europe/Paris');
    await tz.selectOption('America/New_York');
    await expect.poll(() => patches.find((p) => p.url.includes('/settings/timezone'))?.body).toMatchObject({ timezone: 'America/New_York' });

    // 🔴 Le chargement n'écrit rien : un envoi parti de lui-même aurait eu le temps d'arriver.
    await page.waitForTimeout(PLUS_QUE_LE_DELAI);
    expect(horaires(patches)).toHaveLength(0);
    await expect(page.getByTestId('param-save-hours')).toHaveCount(0);

    // Une modification VALIDE part seule, avec les 7 jours '0'..'6'.
    await page.getByTestId('param-hours-1-fin').fill('19:00');
    await expect.poll(() => horaires(patches).length).toBe(1);
    const envoi = horaires(patches)[0]!;
    expect(Object.keys(envoi.body.businessHours as object).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(jour(envoi, '1')).toMatchObject({ closed: false, open: '09:00', close: '19:00' });
    await expect(page.getByTestId('param-hours-statut')).toHaveText('enregistré');
  });

  test('deux modifications rapprochées font UN envoi, qui porte les deux', async ({ page }) => {
    const patches = await monter(page);
    await page.getByTestId('param-hours-1-debut').fill('08:30');
    await page.getByTestId('param-hours-1-fin').fill('17:30');
    await expect.poll(() => horaires(patches).length).toBe(1);
    expect(jour(horaires(patches)[0]!, '1')).toMatchObject({ open: '08:30', close: '17:30' });
    await page.waitForTimeout(PLUS_QUE_LE_DELAI);
    expect(horaires(patches)).toHaveLength(1);
  });

  test('🔴 un jour faux n’envoie rien et le dit ; corrigé, la semaine part', async ({ page }) => {
    const patches = await monter(page);

    // Fin avant le début : rouge, aucun envoi, et aucun « enregistré » pour faire croire le contraire.
    await page.getByTestId('param-hours-1-fin').fill('08:00');
    await expect(page.getByTestId('param-hours-invalide')).toBeVisible();
    await expect(page.getByTestId('param-hours-statut')).toHaveText('');
    await page.waitForTimeout(PLUS_QUE_LE_DELAI);
    expect(horaires(patches)).toHaveLength(0);

    // Corrigé : la semaine part, et le message s'efface.
    await page.getByTestId('param-hours-1-fin').fill('19:00');
    await expect.poll(() => horaires(patches).length).toBe(1);
    expect(jour(horaires(patches)[0]!, '1')).toMatchObject({ close: '19:00' });
    await expect(page.getByTestId('param-hours-invalide')).toHaveCount(0);
    await expect(page.getByTestId('param-hours-statut')).toHaveText('enregistré');

    // Ouvrir le samedi sans ses heures : faux aussi, donc rien ne part tant qu'elles manquent, et le
    // « enregistré » d'avant se masque (constaté APRÈS l'avoir vu, sinon l'état initial suffirait).
    await page.getByTestId('param-hours-6-ferme').uncheck();
    await expect(page.getByTestId('param-hours-invalide')).toBeVisible();
    await expect(page.getByTestId('param-hours-statut')).toHaveText('');
    await page.waitForTimeout(PLUS_QUE_LE_DELAI);
    expect(horaires(patches)).toHaveLength(1);
    await page.getByTestId('param-hours-6-debut').fill('10:00');
    await page.getByTestId('param-hours-6-fin').fill('12:00');
    await expect.poll(() => horaires(patches).length).toBe(2);
    expect(jour(horaires(patches)[1]!, '6')).toMatchObject({ closed: false, open: '10:00', close: '12:00' });
  });

  test('un échec se dit, ne se relance pas seul, et « réessayer » renvoie la semaine', async ({ page }) => {
    const patches = await monter(page, { refus: 1 });
    await page.getByTestId('param-hours-1-fin').fill('19:00');
    await expect(page.getByTestId('param-hours-statut')).toHaveText('erreur');
    await page.waitForTimeout(PLUS_QUE_LE_DELAI);
    expect(horaires(patches)).toHaveLength(1);

    await page.getByTestId('param-hours-reessayer').click();
    await expect(page.getByTestId('param-hours-statut')).toHaveText('enregistré');
    expect(horaires(patches)).toHaveLength(2);
    expect(jour(horaires(patches)[1]!, '1')).toMatchObject({ close: '19:00' });
    await expect(page.getByTestId('param-hours-reessayer')).toHaveCount(0);
  });

  test('🔴 une lecture ratée ne montre aucun éditeur : aucune valeur par défaut ne peut partir', async ({ page }) => {
    const patches = await monter(page, { lectureRatee: true });
    await expect(page.getByTestId('param-lecture-ratee')).toBeVisible();
    await expect(page.getByTestId('param-hours')).toHaveCount(0);
    await expect(page.getByTestId('param-timezone')).toHaveCount(0);
    expect(patches).toHaveLength(0);
  });

  test('🔴 une modification faite juste avant de recharger la page part quand même', async ({ page }) => {
    const patches = await monter(page);
    await page.getByTestId('param-hours-1-fin').fill('19:00');
    // Recharger AVANT les 800 ms : seul le vidage à la fermeture de la page peut encore l'envoyer.
    await page.reload();
    await expect.poll(() => horaires(patches).length).toBe(1);
    expect(jour(horaires(patches)[0]!, '1')).toMatchObject({ close: '19:00' });
  });
});
