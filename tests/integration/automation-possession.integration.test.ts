import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { POSSESSEUR_LIEN_CHAINE } from '../../src/automation/match';
import { PgAutomationStore } from '../../src/automation/store.pg';

/**
 * Possession d'une automation par un lien de chaine (colonne `possede_par`, migration 0114). Frere de
 * `automation-webhook-ownership.integration.test.ts`, pour le SECOND proprietaire.
 *
 * Ce test tape la vraie base, parce que c'est le seul endroit ou un predicat SQL peut etre verifie : un
 * test qui relirait la chaine de la requete ne prouverait que sa propre copie.
 *
 * Ne PAS le lancer en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION (cf. CLAUDE.md
 * du repo), et ce fichier cree et supprime des tenants. La CI monte un Postgres jetable pour ca (job
 * `integration`). `describe.skipIf(!url)` le rend inerte si DATABASE_URL n'est pas defini, mais ne protege
 * pas contre un DATABASE_URL defini qui pointerait sur la prod.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('automations possedees par un lien de chaine : hors de portee de l ecran', () => {
  let pool: Pool;
  let store: PgAutomationStore;
  let tenantId = '';
  let workflowId = '';
  let idPossedee = '';
  let idNormale = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgAutomationStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-automation-possession') returning id`,
    )).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;

    // Ecrite PAR LE STORE, exactement comme un lien de chaine la fabriquera : c'est `create` qui doit
    // savoir poser un proprietaire, sinon aucune automation possedee ne peut naitre.
    idPossedee = (await store.create(tenantId, {
      name: 'Chaine : newsletter', triggerKind: 'keyword',
      // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
      triggerConfig: { keywords: ['cm-a7k2m9p3'], mode: 'contains' },
      conditionGroup: null, workflowId, startNodeId: null, cooldownSeconds: 300, enabled: true,
      possedePar: POSSESSEUR_LIEN_CHAINE, maxFiresPerHour: 2000,
    })).id;
    idNormale = (await store.create(tenantId, {
      name: 'Mot-cle rdv', triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] },
      conditionGroup: null, workflowId, startNodeId: null, cooldownSeconds: null, enabled: true,
    })).id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 `list` ne montre pas la possedee, et montre l ordinaire', async () => {
    const noms = (await store.list(tenantId)).map((a) => a.name);
    expect(noms).toContain('Mot-cle rdv');
    expect(noms).not.toContain('Chaine : newsletter');
  });

  it('🔴 `getById` ne la trouve pas, `update` ne la modifie pas, `remove` ne la supprime pas', async () => {
    expect(await store.getById(idPossedee, tenantId)).toBeNull();
    // Eteindre le compagnon d'un post publie depuis l'ecran Automation tuerait son bouton en silence.
    expect(await store.update(idPossedee, tenantId, { enabled: false })).toBe(false);
    expect(await store.remove(idPossedee, tenantId)).toBe(false);
    const relu = await pool.query<{ enabled: boolean }>('select enabled from automations where id = $1', [idPossedee]);
    expect(relu.rows[0]?.enabled).toBe(true);
  });

  it('le chemin CHAUD la voit, avec son plafond propre : c est elle qui declenche le scenario', async () => {
    const chaud = await store.listEnabled(tenantId, ['keyword']);
    expect(chaud.find((a) => a.id === idPossedee)?.maxFiresPerHour).toBe(2000);
    // L'automation ordinaire n'a pas de plafond propre : c'est celui de l'instance qui s'applique.
    expect(chaud.find((a) => a.id === idNormale)?.maxFiresPerHour).toBeNull();
    // 🔴 ET SON PROPRIETAIRE FAIT L ALLER-RETOUR, contre un VRAI Postgres (2026-09-08). C'est lui qui decide
    // qu'un clic sur un bouton de chaine REPREND la main sur le fil (`vientDuneChaine`, puis
    // `ignoreHumanControl` dans le worker). Un test de texte SQL ne prouve pas qu'une valeur revient : il a
    // suffi que la colonne manque de `COLS` pour que `possedePar` soit nul partout sans qu'aucun type ne
    // bouge, et les boutons de chaine auraient cesse de demarrer des qu'un fil est tenu.
    expect(chaud.find((a) => a.id === idPossedee)?.possedePar).toBe(POSSESSEUR_LIEN_CHAINE);
    expect(chaud.find((a) => a.id === idNormale)?.possedePar).toBeNull();
  });

  it('l automation ordinaire reste pilotable (le second terme n a pas tout verrouille)', async () => {
    expect(await store.update(idNormale, tenantId, { name: 'Mot-cle rdv (modifie)' })).toBe(true);
    expect((await store.getById(idNormale, tenantId))?.name).toBe('Mot-cle rdv (modifie)');
  });

  it('les webhooks restent exclus comme avant : le `and` n a rien desserre', async () => {
    const idWebhook = (await pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id)
       values ($1, 'Webhook : commandes', true, 'webhook', '{"webhookId":"wh-itest"}'::jsonb, $2) returning id`,
      [tenantId, workflowId],
    )).rows[0]!.id;
    // `possede_par` y vaut null : c'est le PREMIER terme qui doit continuer a l'exclure, tout seul.
    expect(await store.getById(idWebhook, tenantId)).toBeNull();
    expect((await store.list(tenantId)).map((a) => a.id)).not.toContain(idWebhook);
  });
});
