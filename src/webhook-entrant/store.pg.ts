import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../db/transaction';
import { sha256Hex } from '../lib/signature';
import { newWebhookCode } from '../ids/code';
import { coerceMapping } from './mapping';
import { verifierPlaceAutomation } from '../offres/automations';
import type {
  IssueCreationWebhook, IssueModificationWebhook, IssueSuppressionWebhook, WebhookInput, WebhookPublic, WebhookRow,
} from './modele';

/**
 * Webhooks entrants. 🔴 `tenant_id` sur chaque requête, sauf `getByCode` : là, le code est la preuve
 * d'appartenance et c'est lui qui rend l'espace (comme `/r/:code`, sans session).
 *
 * Ce store écrit aussi la ligne `automations` compagnon d'un webhook, dans la même transaction : le lien webhook
 * <-> automation est un invariant, et le rompre laisserait un webhook qui ne déclenche rien ou une automation
 * orpheline.
 */

export interface RawAdmin {
  id: string; name: string; enabled: boolean; code: string; secret_hash: string | null;
  mapping: unknown; create_contact: boolean; opt_in: boolean; last_payload: unknown; last_received_at: Date | null;
  contacts_created: number; created_at: Date;
  workflow_id: string | null; start_node_id: string | null; cooldown_seconds: number | null;
}

/**
 * Colonnes de l'écran. LEFT JOIN sur `automations` : un webhook sans scénario (ou dont le scénario vient d'être
 * supprimé) reste listable.
 */
const COLS_ADMIN = `w.id, w.name, w.enabled, w.code, w.secret_hash, w.mapping, w.create_contact, w.opt_in,
       w.last_payload, w.last_received_at, w.contacts_created, w.created_at,
       a.workflow_id, a.start_node_id, a.cooldown_seconds`;

/**
 * Ligne de base -> ligne d'écran. 🔴 C'est ici que le secret est retiré : `COLS_ADMIN` sélectionne `secret_hash`,
 * et seul le booléen en sort. Exportée pour être testée directement, un faux store ne portant pas de secret.
 */
export function toRow(r: RawAdmin): WebhookRow {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    code: r.code,
    hasSecret: r.secret_hash !== null,
    mapping: coerceMapping(r.mapping),
    createContact: r.create_contact,
    optIn: r.opt_in,
    workflowId: r.workflow_id,
    startNodeId: r.start_node_id,
    cooldownSeconds: r.cooldown_seconds,
    lastPayload: r.last_payload ?? null,
    lastReceivedAt: r.last_received_at ? r.last_received_at.toISOString() : null,
    contactsCreated: r.contacts_created,
    createdAt: r.created_at.toISOString(),
  };
}

export class PgWebhookStore {
  /**
   * @param limiteAutomations la limite d'automations allumées de l'offre (lot 6, `null` = sans limite) : l'automation
   *   compagnon d'un webhook allumé y compte, c'est l'usage même de la Base. Absente : sans limite (scripts et tests).
   */
  constructor(
    private readonly pool: Pool,
    private readonly limiteAutomations?: (tenantId: string) => Promise<number | null>,
  ) {}

  /**
   * Chemin public : retrouve un webhook par son code. L'espace vient d'ici, jamais du corps de la requête.
   * `enabled` est rendu au lieu d'être filtré : la route décide du 404, testable sans base.
   */
  async getByCode(code: string): Promise<WebhookPublic | null> {
    const res = await this.pool.query<{ id: string; tenant_id: string; name: string; enabled: boolean; secret_hash: string | null; mapping: unknown; create_contact: boolean; opt_in: boolean; automation_id: string | null; alimente_campagne: boolean }>(
      // `alimente_campagne` calculé ici, dans la requête qui a lieu de toute façon, plutôt que tenu en compteur (qui
      // se désynchronise) : sans lui, une campagne au fil de l'eau sur un webhook sans scénario ne recevrait rien.
      `select id, tenant_id, name, enabled, secret_hash, mapping, create_contact, opt_in, automation_id,
              exists (select 1 from campaigns c where c.webhook_id = webhooks.id and c.status = 'running') as alimente_campagne
         from webhooks where code = $1 limit 1`,
      [code],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      enabled: r.enabled,
      secretHash: r.secret_hash,
      mapping: coerceMapping(r.mapping),
      createContact: r.create_contact,
      optIn: r.opt_in,
      name: r.name,
      automationId: r.automation_id,
      alimenteCampagne: r.alimente_campagne,
    };
  }

  /**
   * Ce webhook peut-il servir de source à une campagne au fil de l'eau ? Il doit appartenir à l'espace et être
   * actif, sinon la campagne n'attraperait rien.
   */
  async usableByTenant(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from webhooks where tenant_id = $1 and id = $2 and enabled = true`,
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Enregistre le passage d'un appel : le dernier payload remplace le précédent (jamais d'historique, RGPD) et le
   * compteur de contacts créés avance. Best-effort : l'échec ne fait pas échouer l'appel du tiers.
   */
  async recordCall(tenantId: string, id: string, payload: unknown, contactCreated: boolean): Promise<void> {
    await this.pool.query(
      `update webhooks
          set last_payload = $3::jsonb,
              last_received_at = now(),
              contacts_created = contacts_created + $4,
              updated_at = now()
        where tenant_id = $1 and id = $2`,
      [tenantId, id, JSON.stringify(payload ?? null), contactCreated ? 1 : 0],
    );
  }

  async list(tenantId: string): Promise<WebhookRow[]> {
    const res = await this.pool.query<RawAdmin>(
      `select ${COLS_ADMIN} from webhooks w
         left join automations a on a.id = w.automation_id
        where w.tenant_id = $1 order by w.created_at desc limit 200`,
      [tenantId],
    );
    return res.rows.map(toRow);
  }

  async get(tenantId: string, id: string): Promise<WebhookRow | null> {
    const res = await this.pool.query<RawAdmin>(
      `select ${COLS_ADMIN} from webhooks w
         left join automations a on a.id = w.automation_id
        where w.tenant_id = $1 and w.id = $2 limit 1`,
      [tenantId, id],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }

  /** Crée un webhook et, s'il porte un scénario, sa ligne compagnon. Renvoie le code public à coller chez le tiers. */
  async create(tenantId: string, input: WebhookInput): Promise<IssueCreationWebhook> {
    return enTransaction(this.pool, async (client) => {
      if (input.workflowId !== null) {
        const scenario = await client.query(
          `select 1 from workflows where id = $1 and tenant_id = $2 for key share`,
          [input.workflowId, tenantId],
        );
        if ((scenario.rowCount ?? 0) === 0) return { kind: 'scenario_inconnu' };
      }
      const code = newWebhookCode();
      const res = await client.query<{ id: string }>(
        `insert into webhooks (tenant_id, name, enabled, code, mapping, create_contact, opt_in)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning id`,
        [tenantId, input.name, input.enabled, code, JSON.stringify(input.mapping), input.createContact, input.optIn],
      );
      const id = res.rows[0]!.id;
      await this.syncAutomation(client, tenantId, id, null, input);
      return { kind: 'cree', id, code };
    });
  }

  /** Met à jour un webhook et réaligne sa ligne compagnon dans la même transaction. */
  async update(tenantId: string, id: string, input: WebhookInput): Promise<IssueModificationWebhook> {
    return enTransaction(this.pool, async (client) => {
      const verrou = await this.verrouillerConfiguration(client, tenantId, id, input.workflowId);
      if (verrou.kind !== 'verrouille') return verrou;
      await client.query(
        `update webhooks set name = $3, enabled = $4, mapping = $5::jsonb, create_contact = $6, opt_in = $7, updated_at = now()
          where tenant_id = $1 and id = $2`,
        [tenantId, id, input.name, input.enabled, JSON.stringify(input.mapping), input.createContact, input.optIn],
      );
      await this.syncAutomation(client, tenantId, id, verrou.automationId, input);
      return { kind: 'modifie' };
    });
  }

  /**
   * Prend les verrous dans un ordre unique : scénarios, puis webhook. Une suppression de scénario suit elle aussi
   * cet ordre via sa cascade (`workflows` → `automations` → `webhooks`) ; l'inverser créerait un deadlock. Le verrou
   * consultatif sérialise deux configurations du même webhook avant la lecture de son scénario courant.
   */
  private async verrouillerConfiguration(
    client: PoolClient,
    tenantId: string,
    webhookId: string,
    workflowVise: string | null,
  ): Promise<
    | { kind: 'verrouille'; automationId: string | null }
    | { kind: 'introuvable' }
    | { kind: 'scenario_inconnu' }
  > {
    await client.query(`select pg_advisory_xact_lock(hashtext('webhook-config:' || $1::text))`, [webhookId]);

    const lecture = await client.query<{ automation_id: string | null; workflow_id: string | null }>(
      `select w.automation_id, a.workflow_id
         from webhooks w
         left join automations a on a.id = w.automation_id and a.tenant_id = w.tenant_id
        where w.tenant_id = $1 and w.id = $2`,
      [tenantId, webhookId],
    );
    const avantVerrou = lecture.rows[0];
    if (!avantVerrou) return { kind: 'introuvable' };

    const scenarios = [...new Set([avantVerrou.workflow_id, workflowVise].filter((v): v is string => v !== null))].sort();
    if (scenarios.length > 0) {
      const verrouilles = await client.query<{ id: string }>(
        `select id from workflows
          where tenant_id = $1 and id = any($2::uuid[])
          order by id
          for key share`,
        [tenantId, scenarios],
      );
      if (workflowVise !== null && !verrouilles.rows.some((r) => r.id === workflowVise)) {
        return { kind: 'scenario_inconnu' };
      }
    }

    // La cascade d'un scénario a pu détacher l'automation pendant l'attente du verrou : seule cette relecture fait foi.
    const actuel = await client.query<{ automation_id: string | null }>(
      `select automation_id from webhooks where tenant_id = $1 and id = $2 for update`,
      [tenantId, webhookId],
    );
    const ligne = actuel.rows[0];
    return ligne ? { kind: 'verrouille', automationId: ligne.automation_id } : { kind: 'introuvable' };
  }

  /**
   * Aligne la ligne `automations` compagnon sur l'état voulu. Invariant : `webhooks.automation_id` pointe une
   * automation `webhook` dont `trigger_config.webhookId` est ce webhook. La ligne peut avoir disparu (cascade à la
   * suppression du scénario), d'où la ré-insertion quand la mise à jour ne touche rien.
   */
  private async syncAutomation(
    client: { query: Pool['query'] },
    tenantId: string,
    webhookId: string,
    automationId: string | null,
    input: WebhookInput,
  ): Promise<void> {
    if (input.workflowId === null) {
      if (automationId !== null) {
        await client.query(`delete from automations where id = $1 and tenant_id = $2`, [automationId, tenantId]);
        await client.query(`update webhooks set automation_id = null where id = $1 and tenant_id = $2`, [webhookId, tenantId]);
      }
      return;
    }

    // Le nom porte celui du webhook, pour dire d'où vient cette ligne sans requête supplémentaire.
    const nom = `Webhook : ${input.name}`.slice(0, 200);
    const cfg = JSON.stringify({ webhookId });
    // Allumée, l'automation compagnon compte dans la limite de l'offre (lot 6) ; elle ne se compte pas elle-même.
    if (input.enabled && this.limiteAutomations) {
      await verifierPlaceAutomation(client, tenantId, await this.limiteAutomations(tenantId), automationId);
    }

    if (automationId !== null) {
      const maj = await client.query(
        `update automations
            set name = $3, enabled = $4, workflow_id = $5, start_node_id = $6, cooldown_seconds = $7,
                trigger_kind = 'webhook', trigger_config = $8::jsonb, updated_at = now()
          where id = $1 and tenant_id = $2`,
        [automationId, tenantId, nom, input.enabled, input.workflowId, input.startNodeId, input.cooldownSeconds, cfg],
      );
      if ((maj.rowCount ?? 0) > 0) return;
    }

    const ins = await client.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id, start_node_id, cooldown_seconds)
       values ($1, $2, $3, 'webhook', $4::jsonb, $5, $6, $7) returning id`,
      [tenantId, nom, input.enabled, cfg, input.workflowId, input.startNodeId, input.cooldownSeconds],
    );
    await client.query(`update webhooks set automation_id = $3 where id = $1 and tenant_id = $2`, [webhookId, tenantId, ins.rows[0]!.id]);
  }

  /**
   * Supprime le webhook et sa ligne compagnon. Le verrou du webhook sérialise une campagne qui chercherait à s'y
   * rattacher : la vérification et la suppression forment une seule décision, jamais un check-then-act de route.
   */
  async remove(tenantId: string, id: string): Promise<IssueSuppressionWebhook> {
    return enTransaction(this.pool, async (client) => {
      const verrou = await this.verrouillerConfiguration(client, tenantId, id, null);
      if (verrou.kind === 'introuvable') return verrou;
      // Aucun scénario n'est visé par une suppression : cette branche est impossible par construction.
      if (verrou.kind === 'scenario_inconnu') throw new Error('suppression webhook : scénario visé inattendu');

      const campagne = await client.query<{ name: string }>(
        `select name from campaigns
          where tenant_id = $1 and webhook_id = $2 and status in ('draft', 'scheduled', 'running', 'paused')
          limit 1`,
        [tenantId, id],
      );
      const nomCampagne = campagne.rows[0]?.name;
      if (nomCampagne !== undefined) return { kind: 'campagne_vivante', campagne: nomCampagne };

      await client.query(`delete from webhooks where tenant_id = $1 and id = $2`, [tenantId, id]);
      if (verrou.automationId !== null) {
        await client.query(`delete from automations where id = $1 and tenant_id = $2`, [verrou.automationId, tenantId]);
      }
      return { kind: 'supprime' };
    });
  }

  /**
   * Pose un secret d'en-tête neuf et rend son clair une seule fois, comme `PgApiKeyStore.create` ; seule l'empreinte
   * est stockée. null = webhook inconnu dans cet espace.
   */
  async rotateSecret(tenantId: string, id: string): Promise<string | null> {
    const secret = `whk_${newWebhookCode()}${newWebhookCode()}`;
    const res = await this.pool.query(
      `update webhooks set secret_hash = $3, updated_at = now() where tenant_id = $1 and id = $2`,
      [tenantId, id, sha256Hex(secret)],
    );
    return (res.rowCount ?? 0) > 0 ? secret : null;
  }

  /** Retire l'exigence de secret (un formulaire de site ne sait souvent pas en poser). */
  async clearSecret(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `update webhooks set secret_hash = null, updated_at = now() where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Bouton « oublier ce payload » : le JSON d'un tiers peut contenir des données personnelles non demandées. */
  async forgetPayload(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `update webhooks set last_payload = null, updated_at = now() where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Purge des payloads dormants, tous espaces confondus comme les autres balayages : une obligation de
   * conservation, pas une action d'utilisateur.
   */
  async purgeStalePayloads(days: number): Promise<number> {
    const res = await this.pool.query(
      `update webhooks set last_payload = null
        where last_payload is not null
          and (last_received_at is null or last_received_at < now() - ($1 || ' days')::interval)`,
      [String(Math.max(1, Math.floor(days)))],
    );
    return res.rowCount ?? 0;
  }
}
