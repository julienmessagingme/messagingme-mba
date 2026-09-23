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
  /**
   * Proprietaire de cette automation quand elle en a un ('channelsme_link' pour un lien de chaine).
   * Absent ou null = automation ordinaire, pilotee depuis l'ecran Automation.
   *
   * ⚠️ N'est JAMAIS lu du corps d'une requete HTTP : `parseBody` (`src/http/automations.ts`) recopie une
   * liste FERMEE de champs. Un client qui pourrait le poser se fabriquerait une automation que son propre
   * ecran ne liste plus, ne modifie plus et ne supprime plus.
   */
  possedePar?: string | null;
  /**
   * Plafond horaire de declenchements propre a cette automation. Absent ou null = plafond global de
   * l'instance (`AUTOMATION_MAX_FIRES_PER_HOUR`). Meme remarque que ci-dessus : il ne se regle pas depuis
   * l'ecran, il desserrerait la garde qui borne des envois factures.
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
    maxFiresPerHour: r.max_fires_per_hour,
    // Lu par le CHEMIN CHAUD depuis le 2026-09-08 : c'est lui qui dit si le declenchement vient d'un geste
    // EXPLICITE du contact (un bouton de chaine, ou depuis le lot 3 un clic sur une publicite), donc s'il
    // reprend la main sur le fil (`reprendLaMain`).
    possedePar: r.possede_par,
  };
}

// ⚠️ Liste tenue A LA MAIN : ajouter une colonne ici oblige a toucher `Raw` ET `toRow`, sinon la valeur
// arrive de la base et se perd en silence dans le mapping.
const COLS = 'id, tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds, max_fires_per_hour, possede_par';

/**
 * DEUX familles d'automations sont possedees par autre chose que l'ecran Automation, et ce predicat les met
 * hors de portee de CE store, donc de cet ecran.
 *
 * 1. `trigger_kind = 'webhook'` (migration 0074) : creees, modifiees et supprimees depuis l'ecran
 *    Tools > Webhooks, via `PgWebhookStore`, qui ecrit ses propres requetes.
 * 2. `possede_par is not null` (migration 0114) : le proprietaire se nomme dans la colonne,
 *    'channelsme_link' pour un lien de chaine WhatsApp, 'publicite' pour une publicite Click-to-WhatsApp
 *    (lot 3). Sans ce second terme, une automation `keyword`
 *    posee par un lien resterait listable, modifiable et supprimable ici : un PATCH la reaffecterait a un
 *    autre declencheur, un DELETE la retirerait, et le bouton d'un post DEJA PUBLIE cesserait de declencher
 *    en silence. Un post publie circule pour toujours, il n'y a pas de retour arriere.
 *
 * Sans ce predicat, l'invariant ne tiendrait qu'au fait que l'identifiant de ces lignes n'est expose nulle
 * part : vrai aujourd'hui, faux le jour ou une route le rend pour une raison quelconque.
 *
 * ⚠️ `listEnabled` (chemin chaud) ne le porte PAS et ne doit jamais le porter : l'y ajouter rendrait muets
 * le webhook, le lien de chaine ET la publicite. `create` non plus, evidemment : c'est par la qu'une
 * automation possedee naît.
 *
 * ⚠️ Et depuis le 2026-09-08, `possede_par` n'est plus seulement un PREDICAT de portee : sa VALEUR est lue
 * par le chemin chaud (elle est dans `COLS`), parce qu'une automation nee d'un lien de chaine, et depuis le
 * lot 3 d'une publicite, reprend la main sur le fil quand une automation ordinaire ne le fait pas. La
 * retirer de `COLS` ne casserait aucun type, elle rendrait seulement `possedePar` nul partout : les boutons
 * de chaine cesseraient de demarrer des qu'un fil est tenu, et les leads d'une publicite avec eux, sur un
 * numero ou l'agent de Meta tient justement tous les fils.
 *
 * Le NOM de la constante reste `HORS_WEBHOOK` alors qu'elle couvre desormais deux familles : la renommer
 * dans le meme commit melerait un renommage a un changement de comportement, et rendrait la relecture du
 * second impossible.
 */
const HORS_WEBHOOK = "and trigger_kind <> 'webhook' and possede_par is null";

/** Automations d'un tenant + garde-fou anti-rebond. Tout est scopé `tenant_id` sur CHAQUE requête. */
export class PgAutomationStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Automations du tenant (écran Automation), les plus récentes d'abord.
   *
   * ⚠️ Les automations de type `webhook` sont EXCLUES : elles sont possédées par leur webhook (migration
   * 0074), créées et supprimées depuis l'écran Tools > Webhooks, et n'ont aucun sens hors de lui. Les
   * afficher ici donnerait à l'utilisateur une ligne qu'il n'a pas créée, et un second endroit pour la
   * modifier, donc une désynchronisation garantie. Seule `listEnabled` (chemin chaud) les voit.
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
      `select ${COLS} from automations where id = $1 and tenant_id = $2 ${HORS_WEBHOOK}`,
      [id, tenantId],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }

  async create(tenantId: string, input: AutomationInput): Promise<{ id: string }> {
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
   * `marqueur` (migration 0075) retient POUR QUELLE VALEUR on a tiré. Il ne sert qu'au déclencheur
   * `avant_date` : une date qui change est une occurrence NEUVE, et un simple « déjà tiré » laisserait un
   * rendez-vous reporté sans rappel, en silence. Absent -> la colonne est remise à null, ce qui est le
   * comportement de tous les autres déclencheurs.
   */
  /**
   * 🔴 CLAIM CONDITIONNEL QUAND UN MARQUEUR EST DONNÉ (R10). Rend `false` si le marqueur stocké est DÉJÀ
   * celui-ci : un autre tour a tiré pour cette même occurrence, il ne faut pas tirer une seconde fois.
   *
   * Ce qu'il répare : la déduplication du rappel « avant date » vivait UNIQUEMENT dans le balayage, qui lit
   * `fired_for` avant de publier. Tant que l'événement publié n'était pas consommé, le balayage suivant
   * revoyait le contact comme dû et republiait. Un client avec quinze rendez-vous à la même heure fabrique
   * assez d'événements pour que la file prenne du retard : deux, parfois trois rappels WhatsApp IDENTIQUES,
   * facturés, visibles du client, avec le risque de note de qualité Meta. La garantie descend donc du
   * balayage au RUNNER, c'est-à-dire au seul endroit qui soit atomique.
   *
   * ⚠️ SANS marqueur (tous les déclencheurs sauf `avant_date`), l'écriture reste INCONDITIONNELLE et rend
   * toujours `true`. La rendre conditionnelle là aussi casserait l'anti-boucle : `fired_for` y vaut toujours
   * `null`, `null is distinct from null` est faux, et plus AUCUN déclenchement répété ne passerait.
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
   * Contacts d'une automation `avant_date` dont la date de champ tombe dans une fenêtre GROSSIÈRE autour de
   * l'échéance, avec la valeur pour laquelle on a déjà tiré.
   *
   * ⚠️ Le tri se fait sur du TEXTE. Les dates sont stockées en ISO (canonicalisées à l'écriture), donc
   * l'ordre lexicographique suit l'ordre chronologique... à fuseau égal. Une base qui mélange `Z`, `+02:00`
   * et des heures murales peut décaler de quelques heures : d'où une fenêtre élargie d'un JOUR de chaque
   * côté, et la décision fine laissée à `estDu`, qui sait lire un fuseau. Filtrer serré ici ferait manquer
   * des rappels, et ça ne se verrait pas.
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

  /** Espaces ayant au moins une automation `avant_date` ACTIVE. Évite de balayer tout le monde pour rien. */
  async tenantsAvecDeclencheurDate(): Promise<string[]> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select distinct tenant_id from automations where enabled and trigger_kind = 'avant_date'`,
    );
    return res.rows.map((r) => r.tenant_id);
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
