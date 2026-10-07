import { test, expect, type Page } from '@playwright/test';

/**
 * LE BLOC CONDITION À FAMILLES (RC5), DE BOUT EN BOUT DANS L'ÉDITEUR.
 *
 * Ce qu'aucun test unitaire ne voit : que la carte dessine UNE poignée par famille, qu'une flèche tirée depuis
 * chacune s'enregistre sur la bonne poignée, que tout survit à une publication et à une réouverture, et surtout que
 * RETIRER la deuxième famille n'emporte que SON arête. Les poignées sont tirées du code de la famille, pas de sa
 * place : la troisième doit rester reliée au même bloc, sous la même poignée.
 *
 * Backend intercepté, aucune base (pattern des autres E2E du builder). Le faux serveur garde le dernier graphe
 * enregistré et le rend à la réouverture, comme le vrai rend le brouillon.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Edge = { id?: string; source: string; target: string; sourceHandle?: string };
type Graph = { nodes: Array<{ id: string; type: string; data: Record<string, unknown> } & Record<string, unknown>>; edges: Edge[] };

interface Etat { courant: Graph; saved: Graph[]; publications: number }

const INITIAL: Graph = {
  nodes: [
    { id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } },
    { id: 'c', type: 'condition', position: { x: 0, y: 200 }, data: { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] } },
    { id: 'a', type: 'tag', position: { x: 520, y: -60 }, data: { tag: 'france' } },
    { id: 'b', type: 'tag', position: { x: 520, y: 120 }, data: { tag: 'anglais' } },
    { id: 'p', type: 'tag', position: { x: 520, y: 300 }, data: { tag: 'endormi' } },
    { id: 's', type: 'tag', position: { x: 520, y: 480 }, data: { tag: 'sinon' } },
  ],
  edges: [{ id: 'e0', source: 't', target: 'c' }],
};

async function ouvrir(page: Page, etat: Etat): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/workflows\/wf1\/publish$/.test(url)) {
      etat.publications += 1;
      return json({ id: 'wf1', graph: etat.courant, publishedAt: '2026-10-06T10:00:00.000Z' });
    }
    if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
      const body = (req.postDataJSON() ?? {}) as { graph?: Graph };
      if (body.graph) { etat.saved.push(body.graph); etat.courant = body.graph; }
      return json({ id: 'wf1', brouillon: true });
    }
    const wf = { id: 'wf1', name: 'Scénario E2E', graph: etat.courant, draftGraph: null, publishedAt: null, createdAt: '', updatedAt: '' };
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [wf] });
    if (url.includes('/email/accounts')) return json({ accounts: [] });
    if (url.includes('/email/templates')) return json({ templates: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields/usage')) return json({ total: 0, parChamp: {} });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/workflows?open=wf1');
  await page.locator('.react-flow__node[data-id="c"]').waitFor();
  await page.waitForTimeout(500);
}

/** Les points de sortie du bloc Condition, dans l'ordre où ils sont dessinés, avec leur poignée. */
function sortiesDeC(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.react-flow__node[data-id="c"] .react-flow__handle-right')).map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.getAttribute('data-handleid') ?? '', x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }));
}

function centreDuBloc(page: Page, id: string) {
  return page.evaluate((n) => {
    const r = (document.querySelector(`.react-flow__node[data-id="${n}"]`) as HTMLElement).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
}

/** Le geste réel : on tire depuis un point de sortie et on lâche SUR le bloc visé. */
async function tirer(page: Page, de: { x: number; y: number }, vers: { x: number; y: number }) {
  await page.mouse.move(de.x, de.y);
  await page.mouse.down();
  await page.mouse.move((de.x + vers.x) / 2, (de.y + vers.y) / 2, { steps: 8 });
  await page.mouse.move(vers.x, vers.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** Les arêtes qui partent du bloc Condition dans le dernier graphe enregistré : `poignée -> cible`, triées. */
function aretesDeC(etat: Etat): string[] {
  const g = etat.saved[etat.saved.length - 1];
  return g ? g.edges.filter((e) => e.source === 'c').map((e) => `${e.sourceHandle ?? ''}->${e.target}`).sort() : [];
}

function famillesEnregistrees(etat: Etat): Array<{ code: string; nom: string }> {
  const c = etat.saved[etat.saved.length - 1]?.nodes.find((x) => x.id === 'c');
  return (Array.isArray(c?.data.familles) ? c.data.familles : []) as Array<{ code: string; nom: string }>;
}

test.describe('Bloc Condition : les familles', () => {
  test('🔴 trois familles reliées, publiées, rouvertes ; retirer la deuxième ne décroche pas la troisième', async ({ page }) => {
    const etat: Etat = { courant: INITIAL, saved: [], publications: 0 };
    await ouvrir(page, etat);

    // Un bloc d'avant les familles : ses deux sorties d'hier.
    expect((await sortiesDeC(page)).map((s) => s.id)).toEqual(['true', 'false']);
    await expect(page.getByTestId('condition-sortie-true')).toContainText('Si réunie');

    // Deux familles de plus, et un nom pour chacune.
    await page.locator('.react-flow__node[data-id="c"]').click();
    await page.getByTestId('famille-ajouter').click();
    await page.getByTestId('famille-ajouter').click();
    await page.getByTestId('famille-nom-0').fill('France');
    await page.getByTestId('famille-nom-1').fill('Anglais');
    await page.getByTestId('famille-nom-2').fill('Endormi');

    // Quatre sorties, dans l'ordre : la famille d'origine garde `true`, les ajoutées ont un code, « Sinon » en bas.
    await expect.poll(async () => (await sortiesDeC(page)).length).toBe(4);
    const sorties = await sortiesDeC(page);
    const [h1, h2, h3, hSinon] = sorties.map((s) => s.id);
    expect(h1).toBe('true');
    expect(h2).toMatch(/^famille:/);
    expect(h3).toMatch(/^famille:/);
    expect(h2).not.toBe(h3);
    expect(hSinon).toBe('false');
    await expect(page.getByTestId(`condition-sortie-${h2}`)).toContainText('Anglais');

    // On relie chaque sortie à son bloc.
    const cibles = ['a', 'b', 'p', 's'];
    for (let i = 0; i < 4; i += 1) {
      const depart = (await sortiesDeC(page))[i]!;
      await tirer(page, depart, await centreDuBloc(page, cibles[i]!));
    }
    const attendues = [`${h1}->a`, `${h2}->b`, `${h3}->p`, `${hSinon}->s`].sort();
    await expect.poll(() => aretesDeC(etat), { timeout: 10_000 }).toEqual(attendues);
    expect(famillesEnregistrees(etat).map((f) => f.nom)).toEqual(['France', 'Anglais', 'Endormi']);

    // Publier : l'enregistrement part d'abord, puis la mise en ligne.
    await page.getByTestId('workflow-publier').click();
    await expect.poll(() => etat.publications, { timeout: 10_000 }).toBe(1);
    expect(aretesDeC(etat)).toEqual(attendues);

    // Rouvrir : les familles et leurs flèches sont toujours là.
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node[data-id="c"]').waitFor();
    await expect.poll(async () => (await sortiesDeC(page)).map((s) => s.id)).toEqual([h1, h2, h3, hSinon]);
    await expect(page.getByTestId(`condition-sortie-${h3}`)).toContainText('Endormi');
    const avant = etat.saved.length;
    await page.getByTestId('workflow-autoarrange').click(); // un enregistrement, sans toucher aux flèches
    await expect.poll(() => etat.saved.length, { timeout: 10_000 }).toBeGreaterThan(avant);
    expect(aretesDeC(etat)).toEqual(attendues);

    // 🔴 Retirer la DEUXIÈME famille : son arête part, et elle seule. La troisième garde sa poignée et son bloc.
    await page.locator('.react-flow__node[data-id="c"]').click();
    await page.getByTestId('famille-retirer-1').click();
    await expect.poll(() => aretesDeC(etat), { timeout: 10_000 }).toEqual([`${h1}->a`, `${h3}->p`, `${hSinon}->s`].sort());
    expect(famillesEnregistrees(etat).map((f) => f.nom)).toEqual(['France', 'Endormi']);
    expect((await sortiesDeC(page)).map((s) => s.id)).toEqual([h1, h3, hSinon]);
  });

  test('un champ système se choisit dans la liste des champs, sous « Système »', async ({ page }) => {
    const etat: Etat = { courant: INITIAL, saved: [], publications: 0 };
    await ouvrir(page, etat);
    await page.locator('.react-flow__node[data-id="c"]').click();
    // La clause existante (une étiquette) passe en « Champ », puis sur le pays de l'indicatif.
    const type = page.locator('select').filter({ has: page.locator('option[value="analyse"], option[value="field"]') }).first();
    await type.selectOption('field');
    await page.getByTestId('condition-champ').selectOption('systeme:pays');
    await page.getByTestId('condition-pays').fill('FR, BE');
    await expect.poll(() => {
      const c = etat.saved[etat.saved.length - 1]?.nodes.find((x) => x.id === 'c');
      return (c?.data.clauses as unknown[] | undefined) ?? null;
    }, { timeout: 10_000 }).toEqual([{ kind: 'pays', op: 'is_one_of', values: ['FR', 'BE'] }]);
    // Une seule famille, sans nom : l'ancienne forme du bloc est gardée, sans `familles`.
    expect(etat.saved[etat.saved.length - 1]?.nodes.find((x) => x.id === 'c')?.data.familles).toBeUndefined();
  });
});
