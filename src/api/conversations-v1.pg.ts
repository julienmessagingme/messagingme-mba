import type { Pool } from 'pg';
import type { ControlOwner } from '../inbox/store.pg';
import { MEDIA_EXPIRE_SQL } from '../inbox/media-entrant';
import {
  encoderCurseur, idPublic, lireIdPublic, responsableDe,
  type ConversationV1, type DepotConversationsV1, type MessageV1, type PageV1, type Reprise,
} from './conversations-v1';

/**
 * LE MAGASIN DE LA LECTURE DES FILS PAR L'API (lot 13, domaine 1). Lecture seule, et à part du magasin de l'Inbox : la
 * liste de la console est sur le chemin chaud de l'écran (rafraîchie toutes les 4 s), et lui ajouter les champs de l'API
 * l'alourdirait pour rien.
 *
 * 🔴 ISOLATION : `conversations.tenant_id = $1` sur CHAQUE requête. `conversation_messages` n'a pas de `tenant_id` : la
 * jointure sur `conversations` EST le contrôle (la RLS est contournée par le pooler).
 */

/** « À traiter » : le MÊME prédicat que l'Inbox (`A_TRAITER_SQL`, `src/inbox/store.pg.ts`), recopié et tenu par un test. */
export const A_TRAITER_V1_SQL = `c.control_owner <> 'app_workflow' and ((c.last_direction is not null and c.last_direction <> 'out') or c.escaladee_le is not null) and c.traitee_le is null`;

/** Le dernier message WhatsApp du contact, par l'index `(conversation_id, created_at)` : la fenêtre de 24 h en part. */
const DERNIER_ENTRANT_SQL = `(select m.created_at from conversation_messages m
   where m.conversation_id = c.id and m.direction = 'in' and m.channel = 'whatsapp'
   order by m.created_at desc limit 1)`;

const SELECT_CONVERSATIONS_SQL = `select c.id, c.control_owner, c.last_direction, c.last_message_at,
       to_char(c.last_message_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as curseur,
       (c.archived_at is not null) as archivee,
       (c.archived_at is null and ${A_TRAITER_V1_SQL}) as a_traiter,
       ${DERNIER_ENTRANT_SQL} as dernier_entrant,
       ct.id as contact_id, ct.phone_e164, ct.profile_name, ct.external_id
  from conversations c
  left join contacts ct on ct.id = c.contact_id`;

interface LigneConversation {
  id: string; control_owner: ControlOwner; last_direction: string | null; last_message_at: Date; curseur: string;
  archivee: boolean; a_traiter: boolean; dernier_entrant: Date | null;
  contact_id: string | null; phone_e164: string | null; profile_name: string | null; external_id: string | null;
}

const FENETRE_MS = 24 * 60 * 60 * 1000;

function conversationDeLigne(r: LigneConversation, maintenant: number): ConversationV1 {
  const finFenetre = r.dernier_entrant === null ? null : r.dernier_entrant.getTime() + FENETRE_MS;
  return {
    id: r.id,
    contact: { id: r.contact_id, phone: r.phone_e164, name: r.profile_name, externalId: r.external_id },
    lastMessageAt: r.last_message_at.toISOString(),
    lastDirection: r.last_direction === 'in' || r.last_direction === 'out' ? r.last_direction : null,
    windowExpiresAt: finFenetre !== null && finFenetre > maintenant ? new Date(finFenetre).toISOString() : null,
    handledBy: responsableDe(r.control_owner),
    needsReply: r.a_traiter === true,
    archived: r.archivee === true,
  };
}

const SELECT_MESSAGES_SQL = `select m.id, m.meta_message_id, m.conversation_id, m.direction, m.channel, m.type, m.body,
       m.button_payload, m.transcription, m.media_id, m.media_mime, m.media_nom, m.created_at,
       (m.media_id is not null and ${MEDIA_EXPIRE_SQL}) as media_expire,
       to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as curseur
  from conversation_messages m
  join conversations c on c.id = m.conversation_id`;

interface LigneMessage {
  id: string; meta_message_id: string | null; conversation_id: string; direction: 'in' | 'out'; channel: string | null;
  type: string | null; body: string | null; button_payload: string | null; transcription: string | null;
  media_id: string | null; media_mime: string | null; media_nom: string | null; created_at: Date; media_expire: boolean;
  curseur: string;
}

function messageDeLigne(r: LigneMessage): MessageV1 {
  return {
    id: idPublic(r.meta_message_id, r.id),
    conversationId: r.conversation_id,
    direction: r.direction,
    channel: r.channel === 'rcs' ? 'rcs' : 'whatsapp',
    type: r.type,
    text: r.body,
    buttonPayload: r.button_payload,
    transcription: r.transcription,
    // Un fichier n'est annoncé que REÇU : un média que nous avons envoyé n'est pas gardé chez Meta pour nous.
    media: r.media_id !== null && r.direction === 'in' ? { mimeType: r.media_mime, filename: r.media_nom, expired: r.media_expire === true } : null,
    createdAt: r.created_at.toISOString(),
  };
}

/** Une ligne de plus que la page : c'est elle qui dit s'il en reste, sans compter le fil entier. */
function page<L extends { id: string; curseur: string }, T>(lignes: L[], limite: number, forme: (l: L) => T): PageV1<T> {
  const garde = lignes.slice(0, limite);
  const derniere = garde[garde.length - 1];
  return {
    data: garde.map(forme),
    nextCursor: lignes.length > limite && derniere ? encoderCurseur({ at: derniere.curseur, id: derniere.id }) : null,
  };
}

export class PgConversationsV1 implements DepotConversationsV1 {
  constructor(private readonly pool: Pool, private readonly maintenant: () => number = Date.now) {}

  async lister(tenantId: string, o: { limite: number; avant: Reprise | null; aTraiter: boolean }): Promise<PageV1<ConversationV1>> {
    const params: unknown[] = [tenantId];
    // Un contact bloqué disparaît de l'Inbox : il disparaît aussi d'ici.
    const where = ['c.tenant_id = $1', 'ct.blocked_at is null'];
    if (o.aTraiter) where.push(`c.archived_at is null and ${A_TRAITER_V1_SQL}`);
    if (o.avant) {
      // Comparaison de tuple : elle suit exactement l'ordre de tri, même à horodatage égal.
      params.push(o.avant.at, o.avant.id);
      where.push(`(c.last_message_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(o.limite + 1);
    const res = await this.pool.query<LigneConversation>(
      `${SELECT_CONVERSATIONS_SQL}
        where ${where.join(' and ')}
        order by c.last_message_at desc, c.id desc
        limit $${params.length}`,
      params,
    );
    const maintenant = this.maintenant();
    return page(res.rows, o.limite, (r) => conversationDeLigne(r, maintenant));
  }

  async lire(tenantId: string, conversationId: string): Promise<ConversationV1 | null> {
    const res = await this.pool.query<LigneConversation>(
      `${SELECT_CONVERSATIONS_SQL}
        where c.tenant_id = $1 and c.id = $2::uuid and ct.blocked_at is null`,
      [tenantId, conversationId],
    );
    const r = res.rows[0];
    return r ? conversationDeLigne(r, this.maintenant()) : null;
  }

  async messages(tenantId: string, conversationId: string, o: { limite: number; avant: Reprise | null }): Promise<PageV1<MessageV1> | null> {
    if ((await this.lire(tenantId, conversationId)) === null) return null;
    const params: unknown[] = [tenantId, conversationId];
    const where = ['c.tenant_id = $1', 'm.conversation_id = $2::uuid'];
    if (o.avant) {
      params.push(o.avant.at, o.avant.id);
      where.push(`(m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(o.limite + 1);
    const res = await this.pool.query<LigneMessage>(
      `${SELECT_MESSAGES_SQL}
        where ${where.join(' and ')}
        order by m.created_at desc, m.id desc
        limit $${params.length}`,
      params,
    );
    return page(res.rows, o.limite, messageDeLigne);
  }

  async message(tenantId: string, idPublicDuMessage: string): Promise<(MessageV1 & { idInterne: string }) | null> {
    const cle = lireIdPublic(idPublicDuMessage);
    if (cle === null) return null;
    const res = await this.pool.query<LigneMessage>(
      // L'index unique `conversation_messages_wamid_uidx` sert la première forme, la clé primaire la seconde.
      `${SELECT_MESSAGES_SQL}
        where c.tenant_id = $1 and ${'meta' in cle ? 'm.meta_message_id = $2' : 'm.id = $2::uuid'}
          and not exists (select 1 from contacts ct where ct.id = c.contact_id and ct.blocked_at is not null)
        limit 1`,
      [tenantId, 'meta' in cle ? cle.meta : cle.interne],
    );
    const r = res.rows[0];
    return r ? { ...messageDeLigne(r), idInterne: r.id } : null;
  }
}
