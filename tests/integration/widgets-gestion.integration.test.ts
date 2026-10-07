import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import {
  SCENARIO_NON_PUBLIE, creerWidget, gestionDesWidgetsEnBase, modifierWidget, type DepsGestionWidgets,
} from '../../src/widgets/gestion';
import { conflitDansLEspace } from '../../src/widgets/phrases';
import { PgWidgetStore, type WidgetInput } from '../../src/widgets/store.pg';
import { PgChannelsMeLinkStore } from '../../src/channels-me/link-store.pg';
import { nouveauJeton } from '../../src/channels-me/jeton';
import { offresToutOuvert } from '../gardes';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION (cf. CLAUDE.md du
// repo), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour ça (job `integration`).
// `describe.skipIf(!url)` le rend inerte sans DATABASE_URL, mais ne protège pas contre un DATABASE_URL défini qui
// pointerait sur la production.
const url = process.env.DATABASE_URL ?? '';

/**
 * La gestion des widgets (lot 4) contre un vrai Postgres, par son ASSEMBLAGE DE PRODUCTION
 * (`gestionDesWidgetsEnBase`, celui que `src/index.ts` câble).
 *
 * 🔴 POURQUOI EN INTÉGRATION. Le test unitaire prouve que la gestion REFUSE quand on lui dit « ce scénario n'est pas
 * de cet espace ». Il ne prouve pas que la requête de production le dit : c'est `getById(id, tenant)`, et un `where`
 * qui oublierait l'espace répondrait « il existe » pour le scénario de n'importe qui. Seule une base le voit. Même
 * chose pour la phrase d'un lien de chaîne, lue par `phrasesDesLiens`, et pour le nom de la contrainte que la
 * gestion traduit en 409 : un nom deviné à côté laisserait passer la course en 500.
 */
describe.skipIf(!url)('la gestion des widgets (Postgres réel)', () => {
  let pool: Pool;
  let deps: DepsGestionWidgets;
  let store: PgWidgetStore;
  let tenantA = '';
  let tenantB = '';
  let scenarioA = '';
  let scenarioB = '';

  const phrase = (): string => `itest widget gestion ${randomUUID()}`;
  const brut = (p: string): WidgetInput => ({
    nom: 'itest-widget-gestion', phrase: p, devenir: null, agentId: null, workflowId: null, couleur: '#25d366',
    position: 'bas_droite', libelle: null, avatarUrl: null, badge: true, actif: true, maxParHeure: null,
  });
  const widgetsDe = async (tenant: string) =>
    (await pool.query<{ phrase: string; workflow_id: string | null }>(
      'select phrase, workflow_id from widgets where tenant_id = $1', [tenant],
    )).rows;

  /**
   * Un scénario PUBLIÉ : son graphe publié porte un bloc (lot 5, un widget ne désigne qu'un scénario qui peut
   * démarrer). `brouillon` : le bloc n'est que dans le brouillon, le publié reste celui de la création, vide.
   */
  const scenario = async (tenant: string, o: { brouillon?: boolean } = {}): Promise<string> => {
    const graphe = JSON.stringify({ nodes: [{ id: 'n1', type: 'message', data: { text: 'Bonjour' } }], edges: [] });
    return (await pool.query<{ id: string }>(
      o.brouillon === true
        ? `insert into workflows (tenant_id, name, draft_graph) values ($1, 'itest-widget-gestion', $2::jsonb) returning id`
        : `insert into workflows (tenant_id, name, graph) values ($1, 'itest-widget-gestion', $2::jsonb) returning id`,
      [tenant, graphe],
    )).rows[0]!.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    deps = gestionDesWidgetsEnBase(pool, offresToutOuvert);
    store = new PgWidgetStore(pool);
    tenantA = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-widgets-gestion-a') returning id`)).rows[0]!.id;
    tenantB = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-widgets-gestion-b') returning id`)).rows[0]!.id;
    scenarioA = await scenario(tenantA);
    scenarioB = await scenario(tenantB);
  });

  afterAll(async () => {
    // 🔴 LES LIENS DE CHAÎNE D'ABORD : `channelsme_links.workflow_id` est en `on delete restrict`, NON différable. La
    // cascade de l'espace vers `workflows` et vers `channelsme_links` n'a pas d'ordre garanti, et une branche qui
    // supprime le scénario avant son lien ferait échouer tout le nettoyage (même raison que
    // `channels-me-stores.integration.test.ts`).
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await pool.query('delete from channelsme_links where tenant_id = $1', [t]);
      await pool.query('delete from tenants where id = $1', [t]);
    }
    await pool.end();
  });

  it('🔴 un scénario d’un AUTRE espace est refusé à la création, et rien n’est écrit', async () => {
    const r = await creerWidget(deps, tenantA, { nom: 'itest', phrase: phrase(), devenir: 'scenario', workflowId: scenarioB });
    expect(r).toMatchObject({ ok: false, statut: 400 });
    expect(await widgetsDe(tenantA)).toEqual([]);
  });

  it('le pendant : le scénario de l’espace est accepté, et écrit', async () => {
    const p = phrase();
    const r = await creerWidget(deps, tenantA, { nom: 'itest', phrase: p, devenir: 'scenario', workflowId: scenarioA });
    expect(r.ok).toBe(true);
    expect(await widgetsDe(tenantA)).toContainEqual({ phrase: p, workflow_id: scenarioA });
  });

  it('🔴 un scénario de l’espace SANS version publiée est refusé (409), même avec un brouillon, par la vraie lecture', async () => {
    // `etatDuScenario` lit le graphe PUBLIÉ, le seul que l'exécuteur joue : un brouillon plein ne démarre rien.
    for (const id of [await scenario(tenantA, { brouillon: true }), (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-widget-gestion') returning id`, [tenantA],
    )).rows[0]!.id]) {
      const p = phrase();
      const r = await creerWidget(deps, tenantA, { nom: 'itest', phrase: p, devenir: 'scenario', workflowId: id });
      expect(r).toMatchObject({ ok: false, statut: 409, erreur: SCENARIO_NON_PUBLIE });
      expect(await widgetsDe(tenantA)).not.toContainEqual({ phrase: p, workflow_id: id });
    }
  });

  it('🔴 à la modification aussi : le widget garde son état', async () => {
    const p = phrase();
    const w = await store.creer(tenantA, brut(p));
    const r = await modifierWidget(deps, tenantA, w.id, { devenir: 'scenario', workflowId: scenarioB });
    expect(r).toMatchObject({ ok: false, statut: 400 });
    expect(await widgetsDe(tenantA)).toContainEqual({ phrase: p, workflow_id: null });
  });

  it('🔴 la phrase d’un lien de chaîne de l’espace est lue par la vraie requête, et seulement dans cet espace', async () => {
    const liens = new PgChannelsMeLinkStore(pool);
    const p = phrase();
    await liens.create(tenantA, {
      workflowId: scenarioA, startNodeId: null, token: nouveauJeton(), phrase: p, automationId: null, maxParHeure: null,
    });
    expect(await creerWidget(deps, tenantA, { nom: 'itest', phrase: `${p} 2026` })).toMatchObject({ ok: false, statut: 409 });
    // Dans l'autre espace, la même phrase est libre : la lecture est bornée à `tenant_id = $1`.
    expect((await creerWidget(deps, tenantB, { nom: 'itest', phrase: `${p} 2026` })).ok).toBe(true);
  });

  it('🔴 l’autre sens : le contrôle d’un lien de chaîne lit les widgets de l’espace, par la vraie requête', async () => {
    const p = phrase();
    await store.creer(tenantA, brut(p));
    const liens = new PgChannelsMeLinkStore(pool);
    const enConflit = conflitDansLEspace({
      phrasesDesLiens: (t) => liens.phrasesDesLiens(t),
      phrasesDesWidgets: (t) => store.phrasesDesWidgets(t),
    });
    expect(await enConflit(tenantA, `Bonjour, ${p}`)).toBe(true);
    expect(await enConflit(tenantB, `Bonjour, ${p}`)).toBe(false);
  });

  it('une course : la base tranche par `widgets_phrase_key`, et la gestion le traduit en 409, pas en 500', async () => {
    const p = phrase();
    await store.creer(tenantB, brut(p));
    // Deux créations simultanées passent toutes les deux le contrôle applicatif : on le simule par une liste vide,
    // et c'est la VRAIE contrainte qui doit refuser, sous le nom que la gestion attend.
    const course: DepsGestionWidgets = {
      ...deps,
      widgets: {
        lister: async () => [],
        creer: (t, w) => deps.widgets.creer(t, w),
        modifier: (t, id, w) => deps.widgets.modifier(t, id, w),
        supprimer: (t, id) => deps.widgets.supprimer(t, id),
      },
    };
    const r = await creerWidget(course, tenantB, { nom: 'itest', phrase: `  ${p.toUpperCase()} ` });
    expect(r).toMatchObject({ ok: false, statut: 409 });
  });
});
