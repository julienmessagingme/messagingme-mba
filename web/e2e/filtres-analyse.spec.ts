import { test, expect, type Page } from '@playwright/test';

/**
 * Les filtres de la DERNIÈRE ANALYSE (lot 2b « Tout sur la fiche ») : la liste des contacts, le ciblage d'une
 * campagne et le bloc Condition d'un scénario.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT. Le filtre choisi PART au serveur, dans la forme qu'il accepte (un filtre qui
 * s'affiche et ne part pas viserait tout l'espace). Et une API qui ne décrit pas les champs (404, antérieure au
 * lot) ne se voit pas proposer ces filtres : elle chercherait la clé dans les champs perso et ne trouverait
 * personne, ou pire, l'ignorerait.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** La réponse de `GET /champs-fiche`, telle que le serveur la construit (champs fixes puis perso). */
const CHAMPS_FICHE = {
  champs: [
    { cle: 'nom', libelle: ['nom du contact', 'contact’s name'], provenance: 'base', type: { nature: 'texte' }, operateurs: [] },
    { cle: 'analyse_sentiment', libelle: ['sentiment de la dernière analyse', 'latest analysis sentiment'], provenance: 'analyse', type: { nature: 'choix', valeurs: ['positif', 'neutre', 'negatif'] }, operateurs: ['in', 'empty', 'not_empty'] },
    { cle: 'analyse_urgence', libelle: ['urgence de la dernière analyse (0 à 10)', 'latest analysis urgency (0 to 10)'], provenance: 'analyse', type: { nature: 'note' }, operateurs: ['gte', 'lte', 'empty', 'not_empty'] },
    { cle: 'analyse_resolue', libelle: ['dernière conversation résolue (oui/non)', 'latest conversation resolved (yes/no)'], provenance: 'analyse', type: { nature: 'oui_non' }, operateurs: ['is_true', 'is_false', 'empty', 'not_empty'] },
    { cle: 'analyse_sujet', libelle: ['sujet de la dernière analyse', 'latest analysis topic'], provenance: 'analyse', type: { nature: 'texte' }, operateurs: [] },
    { cle: 'ville', libelle: ['Ville', 'Ville'], provenance: 'perso', type: { nature: 'texte' }, operateurs: [] },
  ],
};

const CONTACTS = [
  { id: 'c1', phoneE164: '+33600000001', bsuid: null, profileName: 'Anna', optInStatus: 'opted_in', fields: {}, tags: [], createdAt: '2026-01-01T00:00:00Z' },
];

/** Les filtres de champ d'une requête de liste, lus dans son paramètre `fields`. */
function champsDe(url: string): Array<{ key: string; op: string; value: string }> {
  const brut = new URL(url).searchParams.get('fields');
  return brut ? (JSON.parse(brut) as Array<{ key: string; op: string; value: string }>) : [];
}

async function mock(page: Page, o: { requetes?: string[]; champsFiche?: 'ok' | 404 } = {}): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const chemin = new URL(url).pathname.replace('/api/backend', '');
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/champs-fiche')) return o.champsFiche === 404 ? json({ error: 'not found' }, 404) : json(CHAMPS_FICHE);
    if (chemin.endsWith('/contacts/count')) { o.requetes?.push(url); return json({ total: CONTACTS.length }); }
    if (chemin.endsWith('/contacts')) { o.requetes?.push(url); return json({ contacts: CONTACTS, total: CONTACTS.length }); }
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/user-fields')) return json({ fields: [{ key: 'ville', label: 'Ville', type: 'text' }] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (chemin.endsWith('/settings')) {
      return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true, timezone: 'Europe/Paris', businessHours: {} });
    }
    if (chemin.endsWith('/templates')) return json({ templates: [] });
    if (chemin.endsWith('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33 5 25 68 02 50', verifiedName: 'Messaging Me' }] });
    return json({});
  });
}

test.describe('Liste des contacts : filtres de la dernière analyse', () => {
  test('🔴 « sentiment négatif, urgence au moins 7 » part au serveur, dans la forme qu’il accepte', async ({ page }) => {
    const requetes: string[] = [];
    await mock(page, { requetes });
    await page.goto('/contacts');
    await page.getByTestId('contacts-toggle-filters').click();
    const section = page.getByTestId('filtres-analyse');
    await expect(section).toContainText('Dernière analyse');

    // Premier filtre : sentiment. 🔴 La valeur cochée d'office (Positif) est REMPLACÉE au premier clic.
    await section.getByTestId('ajouter-filtre-analyse').click();
    const premier = section.getByTestId('filtre-analyse').nth(0);
    await expect(premier.getByRole('button', { name: 'Positif' })).toHaveAttribute('aria-pressed', 'true');
    await premier.getByRole('button', { name: 'Négatif' }).click();
    await expect(premier.getByRole('button', { name: 'Positif' })).toHaveAttribute('aria-pressed', 'false');
    // Les clics suivants ajoutent et retirent.
    await premier.getByRole('button', { name: 'Neutre' }).click();
    await expect(premier.getByRole('button', { name: 'Neutre' })).toHaveAttribute('aria-pressed', 'true');
    await premier.getByRole('button', { name: 'Neutre' }).click();
    // La dernière case restante ne se décoche pas : un choix vide serait refusé par le serveur.
    await premier.getByRole('button', { name: 'Négatif' }).click();
    await expect(premier.getByRole('button', { name: 'Négatif' })).toHaveAttribute('aria-pressed', 'true');

    // Second filtre : l'urgence, au moins 7.
    await section.getByTestId('ajouter-filtre-analyse').click();
    const second = section.getByTestId('filtre-analyse').nth(1);
    await second.getByTestId('filtre-analyse-champ').selectOption('analyse_urgence');
    await expect(second.getByTestId('filtre-analyse-operateur')).toHaveValue('gte');
    await second.getByTestId('filtre-analyse-note').fill('7');

    await expect.poll(() => requetes.map(champsDe).some((ff) =>
      ff.some((f) => f.key === 'analyse_sentiment' && f.op === 'in' && f.value === 'negatif')
      && ff.some((f) => f.key === 'analyse_urgence' && f.op === 'gte' && f.value === '7'))).toBe(true);
    // Le sujet (texte libre) et les champs de base ne sont pas proposés.
    await expect(second.getByTestId('filtre-analyse-champ').locator('option')).toHaveText([
      'sentiment de la dernière analyse', 'urgence de la dernière analyse (0 à 10)', 'dernière conversation résolue (oui/non)',
    ]);
  });

  test('« résolue : non » part sans valeur, et reste un filtre actif', async ({ page }) => {
    const requetes: string[] = [];
    await mock(page, { requetes });
    await page.goto('/contacts');
    await page.getByTestId('contacts-toggle-filters').click();
    await page.getByTestId('ajouter-filtre-analyse').click();
    const ligne = page.getByTestId('filtre-analyse').first();
    await ligne.getByTestId('filtre-analyse-champ').selectOption('analyse_resolue');
    await ligne.getByTestId('filtre-analyse-operateur').selectOption('is_false');
    await expect.poll(() => requetes.map(champsDe).some((ff) => ff.some((f) => f.key === 'analyse_resolue' && f.op === 'is_false'))).toBe(true);
  });

  test('🔴 une API qui ne décrit pas les champs (404) ne se voit PAS proposer ces filtres', async ({ page }) => {
    await mock(page, { champsFiche: 404 });
    await page.goto('/contacts');
    await page.getByTestId('contacts-toggle-filters').click();
    // Le panneau est bien ouvert : l'absence n'est pas celle d'un panneau replié.
    await expect(page.getByTestId('filtre-joignabilite')).toBeVisible();
    await expect(page.getByTestId('filtres-analyse')).toHaveCount(0);
  });
});

test('🔴 le ciblage d’une campagne propose les mêmes filtres, et la liste ciblée les applique', async ({ page }) => {
  const requetes: string[] = [];
  await mock(page, { requetes });
  await page.goto('/campaigns/nouvelle?etape=audience&canal=whatsapp');
  await expect(page.getByTestId('etape-audience')).toBeVisible();
  const section = page.getByTestId('filtres-analyse');
  await section.getByTestId('ajouter-filtre-analyse').click();
  await section.getByTestId('filtre-analyse').first().getByRole('button', { name: 'Négatif' }).click();
  await expect.poll(() => requetes.map(champsDe).some((ff) =>
    ff.some((f) => f.key === 'analyse_sentiment' && f.op === 'in' && f.value === 'negatif'))).toBe(true);
});

test.describe('Bloc Condition : la dernière analyse', () => {
  type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

  test('🔴 « urgence au moins 7 » s’enregistre comme une clause que le moteur lit sur la fiche', async ({ page }) => {
    const saved: Graph[] = [];
    const initial: Graph = { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] };
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
        const body = (req.postDataJSON() ?? {}) as { graph?: Graph };
        if (body.graph) saved.push(body.graph);
        return json({ ok: true });
      }
      if (url.endsWith('/champs-fiche')) return json(CHAMPS_FICHE);
      if (/\/workflows\/wf1$/.test(url)) return json({ workflow: { id: 'wf1', name: 'Scénario E2E', graph: initial, createdAt: '', updatedAt: '' } });
      if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: initial }] });
      if (url.includes('/templates')) return json({ templates: [] });
      if (url.includes('/flows')) return json({ flows: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/workflows?open=wf1');
    await page.getByTestId('add-node-condition').click();
    await page.getByRole('button', { name: /Ajouter une condition/ }).click();
    // La première liste de la clause est son type : « Dernière analyse ».
    const type = page.locator('select').filter({ has: page.locator('option[value="analyse"]') }).first();
    await type.selectOption('analyse');
    await page.getByTestId('filtre-analyse-champ').selectOption('analyse_urgence');
    await page.getByTestId('filtre-analyse-note').fill('7');
    await expect.poll(() => saved.some((g) => g.nodes.some((n) => n.type === 'condition'
      && ((n.data as { clauses?: Array<Record<string, unknown>> }).clauses ?? []).some((c) =>
        c.kind === 'field' && c.key === 'analyse_urgence' && c.op === 'gte' && c.value === '7'))), { timeout: 10_000 }).toBe(true);
  });
});
