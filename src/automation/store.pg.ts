import type { Pool } from 'pg';
import { coerceConditionGroup } from '../workflow/conditions';
import { isAutomationTriggerKind } from './match';
import type { AutomationRow, AutomationTriggerKind } from './match';

/** Ce qu'une route peut créer/modifier. `enabled` par défaut false : une automation ne part jamais sans un OUI explicite. */
export interface AutomationInput {
  name: string;
  triggerKind: AutomationTriggerKind;
  triggerConfig: Record<string, unknown>;
  conditionGroup: unknown;
  workflowId: string;
  startNodeId: string | null;
  cooldownSeconds: number | null;
  enabled: boolean;
}

interface Raw {
  id: string; tenant_id: string; name: string; enabled: boolean;
  trigger_kind: string; trigger_config: unknown; condition_group: unknown;
  workflow_id: string; start_node_id: string | null; cooldown_seconds: number | null;
}

/**
 * Ligne d'automation depuis la base. `trigger_config`/`condition_group` sont du jsonb OPAQUE (édité par une
 * route, potentiellement ancien) : tout est coercé défensivement, jamais casté. Un `trigger_kind` inconnu
 * (valeur écrite par une version future, ou à la main) renvoie null -> l'automation est simplement ignorée
 * plutôt que de faire planter le chemin chaud du webhook.
 */
function toRow(r: Raw): AutomationRow | null {
  if (!isAutomationTriggerKind(r.trigger_kind)) return null;
  const cfg = r.trigger_config && typeof r.trigger_config === 'object' && !Array.isArray(r.trigger_config)
    ? (r.trigger_config as Record<string, unknown>)
    : {};
  // `condition_group` absent = aucune condition. Présent = coercé par le MÊME code que le node « Si » du
  // builder, donc une clause malformée devient inoffensive au lieu de casser l'évaluation.
  const group = r.condition_group === null || r.condition_group === undefined
    ? null
    : coerceConditionGroup(r.condition_group);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    enabled: r.enabled,
    triggerKind: r.trigger_kind,
    triggerConfig: cfg,
    conditionGroup: group && group.clauses.length > 0 ? group : null,
    workflowId: r.workflow_id,
    startNodeId: r.start_node_id,
    cooldownSeconds: r.cooldown_seconds,
  };
}

const COLS = 'id, tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds';

/** Automations d'un tenant + garde-fou anti-rebond. Tout est scopé `tenant_id` sur CHAQUE requête. */
export class PgAutomationStore {
  constructor(private readonly pool: Pool) {}

  /** Toutes les automations du tenant (écran Automation), les plus récentes d'abord. */
  async list(tenantId: string): Promise<AutomationRow[]> {
    const res = await this.pool.query<Raw>(
      `select ${COLS} from automations where tenant_id = $1 order by created_at desc limit 200`,
      [tenantId],
    );
    return res.rows.map(toRow).filter((a): a is AutomationRow => a !== null);
  }

  /**
   * CHEMIN CHAUD (chaque message entrant) : uniquement les automations ACTIVES du tenant pour ces types de
   * déclencheur. Sert l'index partiel `automations_tenant_kind_enabled_idx`. Liste de types vide -> aucune requête.
   */
  async listEnabled(tenantId: string, kinds: readonly AutomationTriggerKind[]): Promise<AutomationRow[]> {
    if (kinds.length === 0) return [];
    const res = await this.pool.query<Raw>(
      `select ${COLS} from automations
       where tenant_id = $1 and enabled and trigger_kind = any($2::text[])`,
      [tenantId, [...kinds]],
    );
    return res.rows.map(toRow).filter((a): a is AutomationRow => a !== null);
  }

  /** UNE automation par id, scopée tenant. Lecture ciblée, contrairement à `list` qui est capée. */
  async getById(id: string, tenantId: string): Promise<AutomationRow | null> {
    const res = await this.pool.query<Raw>(
      `select ${COLS} from automations where id = $1 and tenant_id = $2`,
      [id, tenantId],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }

  async create(tenantId: string, input: AutomationInput): Promise<{ id: string }> {
    const res = await this.pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9) returning id`,
      [
        tenantId, input.name, input.enabled, input.triggerKind,
        JSON.stringify(input.triggerConfig),
        input.conditionGroup === null ? null : JSON.stringify(input.conditionGroup),
        input.workflowId, input.startNodeId, input.cooldownSeconds,
      ],
    );
    return { id: res.rows[0]!.id };
  }

  /** Mise à jour PARTIELLE (l'écran ne bascule souvent que `enabled`). Renvoie false si l'id n'est pas au tenant. */
  async update(id: string, tenantId: string, patch: Partial<AutomationInput>): Promise<boolean> {
    const sets: string[] = [];
    const vals: unknown[] = [id, tenantId];
    const push = (sql: string, v: unknown) => { vals.push(v); sets.push(`${sql} = $${vals.length}`); };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.enabled !== undefined) push('enabled', patch.enabled);
    if (patch.triggerKind !== undefined) push('trigger_kind', patch.triggerKind);
    if (patch.triggerConfig !== undefined) push('trigger_config', JSON.stringify(patch.triggerConfig));
    if (patch.conditionGroup !== undefined) push('condition_group', patch.conditionGroup === null ? null : JSON.stringify(patch.conditionGroup));
    if (patch.workflowId !== undefined) push('workflow_id', patch.workflowId);
    if (patch.startNodeId !== undefined) push('start_node_id', patch.startNodeId);
    if (patch.cooldownSeconds !== undefined) push('cooldown_seconds', patch.cooldownSeconds);
    if (sets.length === 0) return false;
    const res = await this.pool.query(
      `update automations set ${sets.join(', ')}, updated_at = now() where id = $1 and tenant_id = $2`,
      vals,
    );
    return (res.rowCount ?? 0) > 0;
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from automations where id = $1 and tenant_id = $2`, [id, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Dernier déclenchement de cette automation pour ce contact (anti-rebond). null = jamais déclenché. */
  async lastFiredAt(automationId: string, waId: string): Promise<Date | null> {
    const res = await this.pool.query<{ fired_at: Date }>(
      `select fired_at from automation_fires where automation_id = $1 and wa_id = $2`,
      [automationId, waId],
    );
    return res.rows[0]?.fired_at ?? null;
  }

  /** Enregistre le déclenchement (une ligne par couple automation/contact, écrasée à chaque tir). */
  async markFired(automationId: string, waId: string): Promise<void> {
    await this.pool.query(
      `insert into automation_fires (automation_id, wa_id, fired_at) values ($1, $2, now())
       on conflict (automation_id, wa_id) do update set fired_at = now()`,
      [automationId, waId],
    );
  }

  /**
   * Nombre de déclenchements de CETTE automation depuis `since`. Sert le plafond horaire : l'anti-rebond est
   * par (automation, contact) et ne borne donc RIEN à l'échelle d'une population. Or un seul acte d'exploitation
   * peut produire des milliers d'événements d'un coup (une campagne directe rouvre l'analyse de tous ses
   * destinataires, qui repartent ensuite en « conversation analysée »). Sans plafond, une automation sans filtre
   * enverrait un message facturé par contact touché.
   */
  async firedSince(automationId: string, since: Date): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `select count(*)::int as n from automation_fires where automation_id = $1 and fired_at >= $2`,
      [automationId, since],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Annule un déclenchement enregistré (le scénario n'a finalement pas démarré, donc rien n'est parti). */
  async clearFired(automationId: string, waId: string): Promise<void> {
    await this.pool.query(`delete from automation_fires where automation_id = $1 and wa_id = $2`, [automationId, waId]);
  }
}
