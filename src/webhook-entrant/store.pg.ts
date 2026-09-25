import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { sha256Hex } from '../lib/signature';
import { newWebhookCode } from '../ids/code';
import { coerceMapping } from './mapping';
import type { RegleMapping } from './mapping';

/**
 * Webhooks ENTRANTS. Tout est scopé `tenant_id` sur CHAQUE requête, SAUF `getByCode` : là le code EST la
 * preuve d'appartenance, et c'est lui qui rend le tenant (même doctrine que `/r/:code`, où aucune session
 * n'existe).
 *
 * Ce store porte aussi la ligne `automations` COMPAGNON d'un webhook (cf. migration 0074). Écrire dans une
 * table qui appartient à `PgAutomationStore` se justifie ici par l'atomicité : le lien webhook <-> automation
 * est un invariant, et le rompre laisserait soit un webhook qui ne déclenche rien en silence, soit une
 * automation orpheline qu'aucun écran ne montre. Les deux écritures vivent donc dans une transaction.
 */

/** Ce que la route PUBLIQUE a besoin pour traiter un appel. */
export interface WebhookPublic {
  id: string;
  tenantId: string;
  enabled: boolean;
  /** Empreinte du secret d'en-tête, ou null si ce webhook n'en exige pas. */
  secretHash: string | null;
  mapping: RegleMapping[];
  createContact: boolean;
  /**
   * Les contacts nés de ce webhook sont-ils considérés comme CONSENTANTS ?
   *
   * C'est l'opérateur qui l'affirme, jamais nous qui le déduisons : même doctrine que l'import CSV et l'API
   * publique. Faux -> consentement « inconnu », ce qui ferme le marketing pour ce contact.
   */
  optIn: boolean;
  /** Nom du webhook, tracé dans `contacts.opt_in_source` : c'est ce qui dit PAR OÙ un consentement est entré. */
  name: string;
  /** null = ce webhook n'écrit que des champs, il n'y a aucun scénario à déclencher. */
  automationId: string | null;
  /**
   * Une campagne AU FIL DE L'EAU en cours attend-elle les arrivants de cette adresse ?
   *
   * Sert UNIQUEMENT à décider de publier l'événement : un webhook sans scénario ne publiait rien, ce qui
   * suffisait tant que le scénario était le seul consommateur. Absent (faux store de test) -> comportement
   * d'avant, c'est-à-dire « publie seulement s'il y a un scénario ».
   */
  alimenteCampagne?: boolean;
}

/** Ce que l'écran d'administration affiche. Ne contient JAMAIS le hash du secret, ni son clair (qu'on n'a pas). */
export interface WebhookRow {
  id: string;
  name: string;
  enabled: boolean;
  code: string;
  hasSecret: boolean;
  mapping: RegleMapping[];
  createContact: boolean;
  optIn: boolean;
  workflowId: string | null;
  startNodeId: string | null;
  cooldownSeconds: number | null;
  lastPayload: unknown;
  lastReceivedAt: string | null;
  contactsCreated: number;
  createdAt: string;
}

/** Ce qu'une route peut écrire. Le code et le secret ne sont jamais fournis par l'appelant. */
export interface WebhookInput {
  name: string;
  enabled: boolean;
  mapping: RegleMapping[];
  createContact: boolean;
  optIn: boolean;
  /** null = aucun scénario -> la ligne compagnon est supprimée. */
  workflowId: string | null;
  startNodeId: string | null;
  cooldownSeconds: number | null;
}

export interface RawAdmin {
  id: string; name: string; enabled: boolean; code: string; secret_hash: string | null;
  mapping: unknown; create_contact: boolean; opt_in: boolean; last_payload: unknown; last_received_at: Date | null;
  contacts_created: number; created_at: Date;
  workflow_id: string | null; start_node_id: string | null; cooldown_seconds: number | null;
}

/**
 * Colonnes de l'écran. La jointure sur `automations` est un LEFT JOIN : un webhook sans scénario, ou dont le
 * scénario vient d'être supprimé (cascade `automations` -> `webhooks.automation_id` mis à null), reste
 * listable avec son URL et son mapping.
 */
const COLS_ADMIN = `w.id, w.name, w.enabled, w.code, w.secret_hash, w.mapping, w.create_contact, w.opt_in,
       w.last_payload, w.last_received_at, w.contacts_created, w.created_at,
       a.workflow_id, a.start_node_id, a.cooldown_seconds`;

/**
 * Ligne de base -> ligne d'ecran. C'est ICI que le secret est retire : `COLS_ADMIN` selectionne bien
 * `secret_hash` (il faut savoir si un secret existe), et cette fonction n'en garde que le BOOLEEN. Exportee
 * pour etre testee directement : un test qui passe par un faux store ne prouve rien de cette frontiere,
 * puisque le faux ne porte deja pas de secret.
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
  constructor(private readonly pool: Pool) {}

  /**
   * CHEMIN PUBLIC : retrouve un webhook par son code. Le tenant vient d'ICI, jamais du corps de la requête.
   *
   * `enabled` est RENDU au lieu d'être filtré en SQL : c'est la route qui décide du 404, ce qui la rend
   * testable sans base (`server.inject` avec un faux store).
   */
  async getByCode(code: string): Promise<WebhookPublic | null> {
    const res = await this.pool.query<{ id: string; tenant_id: string; name: string; enabled: boolean; secret_hash: string | null; mapping: unknown; create_contact: boolean; opt_in: boolean; automation_id: string | null; alimente_campagne: boolean }>(
      // `alimente_campagne` : une campagne AU FIL DE L'EAU attend-elle les arrivants de cette adresse ?
      // Calculé ICI, dans la requête qui a lieu de toute façon, plutôt que tenu en compteur sur la table (un
      // compteur se désynchronise au premier arrêt, archivage ou suppression oubliés). C'est ce booléen qui
      // décide de publier l'événement quand le webhook n'a AUCUN scénario attaché : sans lui, une campagne au
      // fil de l'eau ne recevrait jamais rien, sans le moindre signal.
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
   * Ce webhook est-il utilisable comme SOURCE d'une campagne au fil de l'eau ? Il doit appartenir à l'espace
   * et être actif : brancher une campagne sur une adresse éteinte donnerait une campagne qui n'attrape rien.
   */
  async usableByTenant(tenantId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from webhooks where tenant_id = $1 and id = $2 and enabled = true`,
      [tenantId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Enregistre le passage d'un appel : le dernier payload REMPLACE le précédent (jamais d'historique, cf. la
   * note RGPD de la migration) et le compteur de contacts créés avance.
   *
   * Best-effort côté appelant : l'échec de cette écriture ne doit pas faire échouer l'appel du tiers.
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
  async create(tenantId: string, input: WebhookInput): Promise<{ id: string; code: string }> {
    return enTransaction(this.pool, async (client) => {
      const code = newWebhookCode();
      const res = await client.query<{ id: string }>(
        `insert into webhooks (tenant_id, name, enabled, code, mapping, create_contact, opt_in)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning id`,
        [tenantId, input.name, input.enabled, code, JSON.stringify(input.mapping), input.createContact, input.optIn],
      );
      const id = res.rows[0]!.id;
      await this.syncAutomation(client, tenantId, id, null, input);
      return { id, code };
    });
  }

  /** Met à jour un webhook et réaligne sa ligne compagnon. false = webhook inconnu dans cet espace. */
  async update(tenantId: string, id: string, input: WebhookInput): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      const actuel = await client.query<{ automation_id: string | null }>(
        `select automation_id from webhooks where tenant_id = $1 and id = $2 for update`,
        [tenantId, id],
      );
      const ligne = actuel.rows[0];
      if (!ligne) return false;
      await client.query(
        `update webhooks set name = $3, enabled = $4, mapping = $5::jsonb, create_contact = $6, opt_in = $7, updated_at = now()
          where tenant_id = $1 and id = $2`,
        [tenantId, id, input.name, input.enabled, JSON.stringify(input.mapping), input.createContact, input.optIn],
      );
      await this.syncAutomation(client, tenantId, id, ligne.automation_id, input);
      return true;
    });
  }

  /**
   * Aligne la ligne `automations` compagnon sur l'état voulu du webhook.
   *
   * Trois cas, et un seul invariant : `webhooks.automation_id` pointe une automation de type `webhook` dont
   * le `trigger_config.webhookId` est CE webhook. La ligne peut avoir disparu sans nous (cascade quand le
   * scénario est supprimé), d'où la ré-insertion quand la mise à jour ne touche aucune ligne.
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

    // Le nom porte celui du webhook : si cette ligne apparaît un jour dans une surface d'exploitation, on
    // doit pouvoir dire d'où elle vient sans requête supplémentaire.
    const nom = `Webhook : ${input.name}`.slice(0, 200);
    const cfg = JSON.stringify({ webhookId });

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

  /** Supprime le webhook. La ligne compagnon part avec lui : sans son webhook, elle ne peut plus se déclencher. */
  async remove(tenantId: string, id: string): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      const res = await client.query<{ automation_id: string | null }>(
        `delete from webhooks where tenant_id = $1 and id = $2 returning automation_id`,
        [tenantId, id],
      );
      const ligne = res.rows[0];
      if (!ligne) return false;
      if (ligne.automation_id !== null) {
        await client.query(`delete from automations where id = $1 and tenant_id = $2`, [ligne.automation_id, tenantId]);
      }
      return true;
    });
  }

  /**
   * Pose un secret d'en-tête neuf et renvoie son CLAIR, une seule fois (jamais re-affichable), comme
   * `PgApiKeyStore.create`. Seule l'empreinte est stockée. null = webhook inconnu dans cet espace.
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
   * Purge automatique des payloads dormants (balayage périodique). CROSS-TENANT par nature, comme les autres
   * balayages du worker : c'est une obligation de conservation, pas une action d'utilisateur.
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
