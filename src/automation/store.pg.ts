import type { Pool } from 'pg';
import { coerceConditionGroup } from '../workflow/conditions';
import { isAutomationTriggerKind } from './match';
import type { AutomationRow, AutomationTriggerKind } from './match';
import { verifierPlaceAutomation } from '../offres/automations';

/** Ce qu'une route peut créer ou modifier. `enabled` par défaut false : une automation ne part jamais sans un
 *  oui explicite. */
export interface AutomationInput {
  name: string;
  triggerKind: AutomationTriggerKind;
  triggerConfig: Record<string, unknown>;
  conditionGroup: unknown;
  workflowId: string;
  startNodeId: string | null;
  cooldownSeconds: number | null;
  enabled: boolean;
  /**
   * Propriétaire de cette automation quand elle en a un ('channelsme_link' pour un lien de chaîne) ; null =
   * automation ordinaire. Jamais lu du corps d'une requête HTTP (`parseBody` recopie une liste fermée) : un
   * client qui le poserait se fabriquerait une automation que son propre écran ne liste plus.
   */
  possedePar?: string | null;
  /**
   * Plafond horaire de déclenchements propre à cette automation ; null = plafond global
   * (`AUTOMATION_MAX_FIRES_PER_HOUR`). Pas réglable depuis l'écran : il desserrerait la garde qui borne des
   * envois facturés.
   */
  maxFiresPerHour?: number | null;
}

interface Raw {
  id: string; tenant_id: string; name: string; enabled: boolean;
  trigger_kind: string; trigger_config: unknown; condition_group: unknown;
  workflow_id: string; start_node_id: string | null; cooldown_seconds: number | null;
  max_fires_per_hour: number | null; possede_par: string | null;
}

/**
 * Ligne d'automation depuis la base. Les jsonb sont coercés défensivement, jamais castés ; un `trigger_kind`
 * inconnu rend null et l'automation est ignorée plutôt que de faire planter le chemin chaud du webhook.
 */
function toRow(r: Raw): AutomationRow | null {
  if (!isAutomationTriggerKind(r.trigger_kind)) return null;
  const cfg = r.trigger_config && typeof r.trigger_config === 'object' && !Array.isArray(r.trigger_config)
    ? (r.trigger_config as Record<string, unknown>)
    : {};
  // `condition_group` coercé par le même code que le bloc « Si » : une clause malformée devient inoffensive.
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
    maxFiresPerHour: r.max_fires_per_hour,
    // Lu par le chemin chaud : un déclenchement né d'un geste explicite du contact (bouton de chaîne, clic sur
    // une publicité ; le widget, lui, n'est pas en base) reprend la main sur le fil (`typeDeLancementDe`).
    possedePar: r.possede_par,
  };
}

// Liste tenue à la main : une colonne ajoutée ici doit l'être aussi dans `Raw` et `toRow`, sinon elle se
// perd en silence dans le mapping.
const COLS = 'id, tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds, max_fires_per_hour, possede_par';

/**
 * Met hors de portée de ce store (donc de l'écran Automation) les automations possédées par autre chose :
 * `trigger_kind = 'webhook'` (gérées par `PgWebhookStore`) et `possede_par is not null` (lien de chaîne,
 * publicité). Sans le second terme, un PATCH ou un DELETE ici ferait cesser en silence le bouton d'un post
 * déjà publié, qui circule pour toujours.
 *
 * `listEnabled` (chemin chaud) ne le porte pas et ne doit jamais le porter, `create` non plus. La valeur de
 * `possede_par` est lue par le chemin chaud (dans `COLS`) : la retirer rendrait `possedePar` nul partout, et
 * les boutons de chaîne ne démarreraient plus dès qu'un fil est tenu.
 */
const HORS_WEBHOOK = "and trigger_kind <> 'webhook' and possede_par is null";

/** Automations d'un tenant et garde-fou anti-rebond. 🔴 Toute requête sur un espace filtre par `tenant_id`. */
export class PgAutomationStore {
  /**
   * @param limiteAutomations la limite d'automations allumées de l'offre de l'espace (lot 6, `null` = sans limite),
   *   vérifiée à la création d'une automation allumée et au rallumage (`src/offres/automations.ts`). Absente : sans
   *   limite (scripts et tests).
   */
  constructor(
    private readonly pool: Pool,
    private readonly limiteAutomations?: (tenantId: string) => Promise<number | null>,
  ) {}

  /**
   * Automations du tenant (écran Automation), les plus récentes d'abord. Celles possédées par un webhook, un
   * lien ou une publicité sont exclues (`HORS_WEBHOOK`) : les montrer offrirait un second endroit pour les
   * modifier.
   */
  async list(tenantId: string): Promise<AutomationRow[]> {
    const res = await this.pool.query<Raw>(
      `select ${COLS} from automations
        where tenant_id = $1 ${HORS_WEBHOOK} order by created_at desc limit 200`,
      [tenantId],
    );
    return res.rows.map(toRow).filter((a): a is AutomationRow => a !== null);
  }

  /**
   * Chemin chaud (chaque message entrant) : les automations actives du tenant pour ces types. Sert l'index
   * partiel `automations_tenant_kind_enabled_idx`. Liste de types vide : aucune requête.
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

  /**
   * Les `n` automations du client les plus anciennes (lot 6, B2a) : la population que compte la limite de l'offre
   * (`verifierPlaceAutomation` : allumées, sans propriétaire, webhooks entrants compris), par date de création puis
   * identifiant. Sous une limite, seules elles tirent encore (le gel au retour en Base, `runAutomations`).
   */
  async plusAnciennes(tenantId: string, n: number): Promise<ReadonlySet<string>> {
    const res = await this.pool.query<{ id: string }>(
      `select id from automations where tenant_id = $1 and enabled and possede_par is null
        order by created_at, id limit $2`,
      [tenantId, n],
    );
    return new Set(res.rows.map((r) => r.id));
  }

  /** Une automation par id, scopée tenant. */
  async getById(id: string, tenantId: string): Promise<AutomationRow | null> {
    const res = await this.pool.query<Raw>(
      `select ${COLS} from automations where id = $1 and tenant_id = $2 ${HORS_WEBHOOK}`,
      [id, tenantId],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }

  async create(tenantId: string, input: AutomationInput): Promise<{ id: string }> {
    // Une automation possédée (lien, publicité, widget) ne compte pas dans la limite de l'offre ; une éteinte non plus.
    if (input.enabled && !input.possedePar && this.limiteAutomations) {
      await verifierPlaceAutomation(this.pool, tenantId, await this.limiteAutomations(tenantId), null);
    }
    const res = await this.pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds, possede_par, max_fires_per_hour)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11) returning id`,
      [
        tenantId, input.name, input.enabled, input.triggerKind,
        JSON.stringify(input.triggerConfig),
        input.conditionGroup === null ? null : JSON.stringify(input.conditionGroup),
        input.workflowId, input.startNodeId, input.cooldownSeconds,
        input.possedePar ?? null, input.maxFiresPerHour ?? null,
      ],
    );
    return { id: res.rows[0]!.id };
  }

  /** Mise à jour partielle (l'écran ne bascule souvent que `enabled`). false si l'id n'est pas au tenant. */
  async update(id: string, tenantId: string, patch: Partial<AutomationInput>): Promise<boolean> {
    // Rallumer compte dans la limite de l'offre (l'écran ne touche que les automations du client : `HORS_WEBHOOK`).
    if (patch.enabled === true && this.limiteAutomations) {
      await verifierPlaceAutomation(this.pool, tenantId, await this.limiteAutomations(tenantId), id);
    }
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
      `update automations set ${sets.join(', ')}, updated_at = now()
        where id = $1 and tenant_id = $2 ${HORS_WEBHOOK}`,
      vals,
    );
    return (res.rowCount ?? 0) > 0;
  }

  async remove(id: string, tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from automations where id = $1 and tenant_id = $2 ${HORS_WEBHOOK}`, [id, tenantId]);
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

  /**
   * Enregistre le déclenchement (une ligne par couple automation/contact, écrasée à chaque tir).
   *
   * 🔴 Avec un `marqueur` (seul `avant_date` : la valeur pour laquelle on tire), l'écriture est un claim
   * conditionnel : `false` si ce marqueur est déjà stocké, pour qu'un événement republié avant d'être consommé
   * ne donne pas deux rappels facturés. Sans marqueur, elle reste inconditionnelle et rend `true` :
   * conditionnelle, `null is distinct from null` étant faux, plus aucun déclenchement répété ne passerait.
   */
  async markFired(automationId: string, waId: string, marqueur?: string): Promise<boolean> {
    const res = await this.pool.query(
      `insert into automation_fires (automation_id, wa_id, fired_at, fired_for) values ($1, $2, now(), $3)
       on conflict (automation_id, wa_id) do update set fired_at = now(), fired_for = excluded.fired_for
       where $3::text is null or automation_fires.fired_for is distinct from excluded.fired_for`,
      [automationId, waId, marqueur ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Contacts d'une automation `avant_date` dont la date tombe dans une fenêtre grossière autour de l'échéance,
   * avec la valeur pour laquelle on a déjà tiré. Le tri se fait sur du texte ISO, chronologique seulement à
   * fuseau égal : la fenêtre est élargie d'un jour, et la décision fine revient à `estDu`.
   */
  async contactsDusPourDate(
    tenantId: string,
    automationId: string,
    fieldKey: string,
    borneBasse: string,
    borneHaute: string,
    cap = 500,
  ): Promise<Array<{ waId: string; valeur: string; dejaTirePour: string | null }>> {
    const res = await this.pool.query<{ wa_id: string; valeur: string; fired_for: string | null }>(
      `select coalesce(regexp_replace(c.phone_e164, '[^0-9]', '', 'g'), c.bsuid) as wa_id,
              c.fields->>$3 as valeur,
              f.fired_for
         from contacts c
         left join automation_fires f
           on f.automation_id = $2
          and f.wa_id = coalesce(regexp_replace(c.phone_e164, '[^0-9]', '', 'g'), c.bsuid)
        where c.tenant_id = $1
          and c.deleted_at is null
          and c.blocked_at is null
          and c.fields->>$3 is not null
          and c.fields->>$3 <> ''
          and c.fields->>$3 >= $4
          and c.fields->>$3 <= $5
        limit $6`,
      [tenantId, automationId, fieldKey, borneBasse, borneHaute, cap],
    );
    return res.rows
      .filter((r) => r.wa_id !== null && r.wa_id !== '')
      .map((r) => ({ waId: r.wa_id, valeur: r.valeur, dejaTirePour: r.fired_for }));
  }

  /** Espaces ayant au moins une automation `avant_date` active, pour ne pas balayer tout le monde. */
  async tenantsAvecDeclencheurDate(): Promise<string[]> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select distinct tenant_id from automations where enabled and trigger_kind = 'avant_date'`,
    );
    return res.rows.map((r) => r.tenant_id);
  }

  /**
   * Déclenchements de cette automation depuis `since`, pour le plafond horaire. L'anti-rebond est par
   * (automation, contact) et ne borne rien à l'échelle d'une population : un seul acte d'exploitation peut
   * produire des milliers d'événements, donc autant de messages facturés.
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
