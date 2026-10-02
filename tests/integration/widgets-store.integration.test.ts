import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWidgetStore, type DevenirWidget, type WidgetInput } from '../../src/widgets/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour
// ça (job `integration`). `describe.skipIf(!url)` le rend inerte sans DATABASE_URL, mais ne protège pas contre
// un DATABASE_URL défini qui pointerait sur la production.
const url = process.env.DATABASE_URL ?? '';

/**
 * La table `widgets` (migration 0200) et son store, contre un vrai Postgres.
 *
 * 🔴 POURQUOI EN INTÉGRATION. Tout ce qui compte ici vit dans le SCHÉMA : les CHECK à sens unique du devenir,
 * l'index de filet sur la phrase, les `on delete set null`, et la clause `tenant_id` qui isole deux clients.
 * Un faux pool dirait oui à tout. Chaque refus est attendu sur le NOM de sa contrainte : une contrainte voisine
 * qui refuserait à sa place ferait passer un test qui ne prouverait rien.
 */
describe.skipIf(!url)('PgWidgetStore (Postgres réel)', () => {
  let pool: Pool;
  let store: PgWidgetStore;
  let tenantId: string;
  let autreTenantId: string;

  /** Un widget complet et neutre (aucun devenir, donc le réglage de l'espace) : chaque cas ne change que ce qu'il teste. */
  const widget = (sur: Partial<WidgetInput> = {}): WidgetInput => ({
    nom: 'itest-widget',
    phrase: `itest widget ${randomUUID()}`,
    devenir: null,
    agentId: null,
    workflowId: null,
    couleur: '#25d366',
    position: 'bas_droite',
    libelle: null,
    avatarUrl: null,
    badge: true,
    actif: true,
    maxParHeure: null,
    ...sur,
  });

  const creerAgent = async (tenant: string): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, $2, 'Je suis une IA.', 'm') returning id`,
      [tenant, `itest-widget-${randomUUID()}`],
    )).rows[0]!.id;

  const creerScenario = async (tenant: string): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-widget') returning id`,
      [tenant],
    )).rows[0]!.id;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgWidgetStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-widgets') returning id`,
    )).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-widgets-autre') returning id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    // Les widgets, agents et scénarios partent par cascade avec l'espace : aucune clé étrangère de `widgets`
    // n'est en `restrict`, donc l'ordre entre les branches de la cascade n'importe pas.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 le CHECK refuse un agent quand le devenir n est pas agent, y compris quand il est null', async () => {
    const agentId = await creerAgent(tenantId);
    // `null` est le cas piège : un `devenir = 'agent'` nu vaudrait null, et un CHECK qui vaut null PASSE.
    const autres: (DevenirWidget | null)[] = ['mba', 'scenario', null];
    for (const devenir of autres) {
      await expect(store.creer(tenantId, widget({ devenir, agentId })))
        .rejects.toThrow(/widgets_agent_sans_devenir_chk/);
    }
    // Et par la modification aussi : la garde tient sur l'état écrit, quel que soit le chemin.
    const w = await store.creer(tenantId, widget({ devenir: 'mba' }));
    await expect(store.modifier(tenantId, w.id, widget({ phrase: w.phrase, devenir: 'mba', agentId })))
      .rejects.toThrow(/widgets_agent_sans_devenir_chk/);
  });

  it('🔴 le CHECK refuse un scénario quand le devenir n est pas scenario, y compris quand il est null', async () => {
    const workflowId = await creerScenario(tenantId);
    const autres: (DevenirWidget | null)[] = ['agent', 'mba', null];
    for (const devenir of autres) {
      await expect(store.creer(tenantId, widget({ devenir, workflowId })))
        .rejects.toThrow(/widgets_scenario_sans_devenir_chk/);
    }
  });

  it('🔴 il ACCEPTE devenir = agent avec un agent à null : l état d un agent supprimé après coup', async () => {
    const w = await store.creer(tenantId, widget({ devenir: 'agent', agentId: null }));
    expect(w).toMatchObject({ tenantId, devenir: 'agent', agentId: null });
  });

  it('🔴 deux widgets d un même espace ne peuvent pas partager une phrase, à la casse et aux espaces près', async () => {
    const phrase = `Bonjour, je viens du site ${randomUUID()}`;
    await store.creer(tenantId, widget({ phrase }));
    await expect(store.creer(tenantId, widget({ phrase: `  ${phrase.toUpperCase()}  ` })))
      .rejects.toThrow(/widgets_phrase_key/);
    // L'index tient aussi la modification : un second widget ne peut pas prendre la phrase du premier.
    const second = await store.creer(tenantId, widget());
    await expect(store.modifier(tenantId, second.id, widget({ phrase: phrase.toLowerCase() })))
      .rejects.toThrow(/widgets_phrase_key/);
  });

  it('deux espaces différents peuvent porter la même phrase', async () => {
    const phrase = `Une question sur vos tarifs ${randomUUID()}`;
    const ici = await store.creer(tenantId, widget({ phrase }));
    const ailleurs = await store.creer(autreTenantId, widget({ phrase }));
    expect(ici.phrase).toBe(ailleurs.phrase);
    expect(ici.code).not.toBe(ailleurs.code);
  });

  it('🔴 supprimer le scénario met workflow_id à null SANS détruire le widget', async () => {
    const workflowId = await creerScenario(tenantId);
    const w = await store.creer(tenantId, widget({ devenir: 'scenario', workflowId }));
    await pool.query('delete from workflows where tenant_id = $1 and id = $2', [tenantId, workflowId]);

    const apres = (await store.lister(tenantId)).find((x) => x.id === w.id);
    // Le widget est là, avec le même code : la balise posée chez le client répond toujours.
    expect(apres).toMatchObject({ id: w.id, code: w.code, devenir: 'scenario', workflowId: null });
  });

  it('🔴 supprimer l agent met agent_id à null SANS détruire le widget', async () => {
    const agentId = await creerAgent(tenantId);
    const w = await store.creer(tenantId, widget({ devenir: 'agent', agentId }));
    await pool.query('delete from agents where tenant_id = $1 and id = $2', [tenantId, agentId]);

    const apres = (await store.lister(tenantId)).find((x) => x.id === w.id);
    expect(apres).toMatchObject({ id: w.id, code: w.code, devenir: 'agent', agentId: null });
  });

  it('parCode d un code inconnu rend null, et d un code connu rend le widget AVEC son espace', async () => {
    expect(await store.parCode('codeinconnu0')).toBeNull();
    expect(await store.parCode('')).toBeNull();

    const w = await store.creer(tenantId, widget());
    // Le code arrive d'une URL : la casse ne doit pas le rendre introuvable.
    const lu = await store.parCode(w.code.toUpperCase());
    expect(lu).toMatchObject({ id: w.id, tenantId, code: w.code });
  });

  it('🔴 isolation : lister ne rend jamais les widgets d un autre espace, et rien ne s écrit à travers', async () => {
    const chezMoi = await store.creer(tenantId, widget());
    const chezLui = await store.creer(autreTenantId, widget());

    const miens = await store.lister(tenantId);
    expect(miens.length).toBeGreaterThan(0);
    expect(miens.every((x) => x.tenantId === tenantId)).toBe(true);
    expect(miens.map((x) => x.id)).not.toContain(chezLui.id);
    expect(await store.phrasesDesWidgets(tenantId)).not.toContain(chezLui.phrase);

    const siens = await store.lister(autreTenantId);
    expect(siens.every((x) => x.tenantId === autreTenantId)).toBe(true);
    expect(siens.map((x) => x.id)).not.toContain(chezMoi.id);

    // Modifier ou supprimer le widget d'un autre espace, en connaissant son id : rien ne bouge.
    expect(await store.modifier(autreTenantId, chezMoi.id, widget({ nom: 'detourne' }))).toBeNull();
    expect(await store.supprimer(autreTenantId, chezMoi.id)).toBe(false);
    expect((await store.lister(tenantId)).find((x) => x.id === chezMoi.id)).toMatchObject({
      nom: chezMoi.nom, phrase: chezMoi.phrase,
    });
  });

  it('modifier ne réécrit ni le code ni l espace', async () => {
    const w = await store.creer(tenantId, widget());
    const modifie = await store.modifier(tenantId, w.id, widget({ nom: 'renomme', couleur: '#FF0000' }));
    expect(modifie).toMatchObject({ id: w.id, code: w.code, tenantId, nom: 'renomme', couleur: '#FF0000' });
  });
});
