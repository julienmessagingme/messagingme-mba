import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAutomationStore } from '../../src/automation/store.pg';

/**
 * Une automation de type `webhook` appartient à SON webhook entrant (migration 0074) : elle se crée, se
 * modifie et se supprime depuis l'écran Tools > Webhooks, jamais depuis l'écran Automation.
 *
 * L'invariant ne tenait d'abord qu'à un fait de présentation : l'identifiant de cette ligne n'est exposé
 * nulle part, donc personne ne pouvait la viser. C'est vrai aujourd'hui, et ça cesse de l'être le jour où
 * une route rend cet identifiant pour une raison quelconque. Il est désormais tenu EN BASE, par un prédicat
 * dans les quatre requêtes de `PgAutomationStore`.
 *
 * Ce test tape la vraie base, parce que c'est le seul endroit où un prédicat SQL peut être vérifié : un test
 * qui relirait la chaîne de la requête ne prouverait que sa propre copie.
 */

const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('automations possédées par un webhook : hors de portée de l’écran Automation', () => {
  let pool: Pool;
  let tenantId: string;
  let workflowId: string;
  let idWebhook: string;
  let idNormale: string;
  let store: PgAutomationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgAutomationStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-webhook-ownership') returning id`,
    )).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;

    // La ligne POSSÉDÉE par un webhook, écrite comme `PgWebhookStore.syncAutomation` l'écrit.
    idWebhook = (await pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id)
       values ($1, 'Webhook : commandes', true, 'webhook', '{"webhookId":"wh-itest"}'::jsonb, $2) returning id`,
      [tenantId, workflowId],
    )).rows[0]!.id;

    // Une automation ordinaire, témoin : elle doit rester pilotable normalement.
    idNormale = (await pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id)
       values ($1, 'Mot-clé rdv', true, 'keyword', '{"keywords":["rdv"]}'::jsonb, $2) returning id`,
      [tenantId, workflowId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 `list` ne la montre pas, mais montre l’automation ordinaire', async () => {
    const noms = (await store.list(tenantId)).map((a) => a.name);
    expect(noms).toContain('Mot-clé rdv');
    expect(noms).not.toContain('Webhook : commandes');
  });

  it('🔴 `getById` ne la trouve pas', async () => {
    expect(await store.getById(idWebhook, tenantId)).toBeNull();
    expect(await store.getById(idNormale, tenantId)).not.toBeNull();
  });

  it('le chemin CHAUD, lui, la voit : c’est elle qui déclenche le scénario', async () => {
    // `listEnabled` ne porte volontairement PAS le prédicat : le sortir du chemin chaud rendrait le webhook
    // muet, ce qui est exactement l'inverse du but.
    const chaud = await store.listEnabled(tenantId, ['webhook']);
    expect(chaud.map((a) => a.id)).toContain(idWebhook);
    expect(chaud[0]?.triggerConfig.webhookId).toBe('wh-itest');
  });

  it('🔴 `update` ne peut pas la RÉAFFECTER à un autre déclencheur', async () => {
    // Sans le prédicat, ce PATCH transformait une ligne de webhook en automation par mot-clé : le webhook
    // croyait encore déclencher son scénario, et plus rien ne partait.
    expect(await store.update(idWebhook, tenantId, { triggerKind: 'keyword', triggerConfig: { keywords: ['x'] } })).toBe(false);
    const relu = await pool.query<{ trigger_kind: string }>('select trigger_kind from automations where id = $1', [idWebhook]);
    expect(relu.rows[0]?.trigger_kind).toBe('webhook');
  });

  it('🔴 `remove` ne peut pas la supprimer', async () => {
    expect(await store.remove(idWebhook, tenantId)).toBe(false);
    const reste = await pool.query('select 1 from automations where id = $1', [idWebhook]);
    expect(reste.rowCount).toBe(1);
  });

  it('l’automation ordinaire reste pilotable (le prédicat n’a pas tout verrouillé)', async () => {
    expect(await store.update(idNormale, tenantId, { name: 'Mot-clé rdv (modifié)' })).toBe(true);
    expect((await store.getById(idNormale, tenantId))?.name).toBe('Mot-clé rdv (modifié)');
    expect(await store.remove(idNormale, tenantId)).toBe(true);
  });
  /**
   * 🔴 R10 : LE CLAIM D'OCCURRENCE, EN SQL.
   *
   * C'est ici que vit la correction ; le reste n'est que du câblage. La déduplication du rappel « avant date »
   * vivait uniquement dans le balayage, qui lit le marqueur avant de publier : tant que l'événement n'était pas
   * consommé, le balayage suivant republiait la MÊME échéance et le rappel partait deux fois, facturé, chez un
   * vrai client.
   */
  describe('markFired : claim conditionnel sur le marqueur d’occurrence', () => {
    const wa = '33600000777';
    // 🔴 SA PROPRE automation. Emprunter `idNormale` marchait en local et cassait en CI : le dernier test du
    // bloc précédent la SUPPRIME, et l'ordre d'exécution décidait donc du résultat. Un test qui dépend de ce
    // qu'un autre a laissé n'est pas un test, c'est un pari.
    let idClaim = '';
    beforeAll(async () => {
      idClaim = (await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id)
         values ($1, 'Rappel avant date', true, 'avant_date', '{"fieldKey":"rdv","delai":"1j"}'::jsonb, $2) returning id`,
        [tenantId, workflowId],
      )).rows[0]!.id;
    });

    it('🔴 le MÊME marqueur ne passe qu’UNE fois', async () => {
      await pool.query(`delete from automation_fires where automation_id = $1`, [idClaim]);
      expect(await store.markFired(idClaim, wa, '2026-09-04')).toBe(true);
      // Le second tour, celui que le balayage a republié parce que la file avait pris du retard.
      expect(await store.markFired(idClaim, wa, '2026-09-04')).toBe(false);
      expect(await store.markFired(idClaim, wa, '2026-09-04')).toBe(false);
    });

    it('🔴 un marqueur DIFFÉRENT passe : un rendez-vous reporté redonne son rappel', async () => {
      await pool.query(`delete from automation_fires where automation_id = $1`, [idClaim]);
      expect(await store.markFired(idClaim, wa, '2026-09-04')).toBe(true);
      expect(await store.markFired(idClaim, wa, '2026-09-11')).toBe(true);
      // Et l'ancien marqueur ne « revient » pas : c'est le nouveau qui est en place.
      expect(await store.markFired(idClaim, wa, '2026-09-11')).toBe(false);
    });

    it('🔴 SANS marqueur, l’écriture reste INCONDITIONNELLE : l’anti-boucle n’est pas cassé', async () => {
      // `fired_for` y vaut toujours null, et `null is distinct from null` est faux : rendre ce cas conditionnel
      // aurait fait échouer TOUT déclenchement répété, sur tous les autres types d'automation.
      await pool.query(`delete from automation_fires where automation_id = $1`, [idClaim]);
      expect(await store.markFired(idClaim, wa)).toBe(true);
      expect(await store.markFired(idClaim, wa)).toBe(true);
      expect(await store.markFired(idClaim, wa)).toBe(true);
    });

    it('🔴 clearFired rend le claim : c’est ce qui préserve le rattrapage du balayage', async () => {
      // Quand le scénario ne démarre pas, rien n'est parti : la tentative suivante doit pouvoir regagner le
      // claim, sinon un fil momentanément tenu par un opérateur condamnerait le rappel pour de bon.
      await pool.query(`delete from automation_fires where automation_id = $1`, [idClaim]);
      expect(await store.markFired(idClaim, wa, '2026-09-04')).toBe(true);
      await store.clearFired(idClaim, wa);
      expect(await store.markFired(idClaim, wa, '2026-09-04')).toBe(true);
    });

    it('le marqueur est par CONTACT : deux contacts à la même échéance tirent chacun le leur', async () => {
      await pool.query(`delete from automation_fires where automation_id = $1`, [idClaim]);
      expect(await store.markFired(idClaim, wa, '2026-09-04')).toBe(true);
      expect(await store.markFired(idClaim, '33600000778', '2026-09-04')).toBe(true);
    });
  });
});