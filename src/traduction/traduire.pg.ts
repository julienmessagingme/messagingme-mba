import type { Pool } from 'pg';
import type { LangueConsole } from './traduire';

/**
 * Où se range une traduction, et comment on apprend la langue d'un contact.
 *
 * 🔴 La jointure sur `conversations` est le contrôle d'isolation : `conversation_messages` ne porte pas de
 * `tenant_id`, et un identifiant de message deviné permettrait sinon d'écrire dans le fil d'un autre client (RLS
 * contournée par le pooler). Même forme que `lireMessagePourTranscription`.
 */
export class PgTraductionStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Range les traductions d'un lot en une seule requête (`unnest` de trois tableaux) : une requête par message
   * ferait quarante allers-retours sur l'ouverture d'un fil.
   * `conversation_id` s'ajoute au `where` quand l'appelant en a un : garde contre une erreur de câblage, le filtre
   * d'espace portant seul l'isolation.
   */
  async ranger(
    tenantId: string,
    /** `null` = n'importe quelle conversation de cet espace (transcription d'un vocal) : l'isolation reste
     *  portée par la jointure. */
    conversationId: string | null,
    traductions: Array<{ messageId: string; texte: string; langue: LangueConsole }>,
  ): Promise<void> {
    if (traductions.length === 0) return;
    await this.pool.query(
      `update conversation_messages m
          set traduction = v.texte, traduction_langue = v.langue
         from unnest($3::uuid[], $4::text[], $5::text[]) as v(id, texte, langue),
              conversations c
        where m.id = v.id
          and c.id = m.conversation_id
          and c.tenant_id = $1
          and ($2::uuid is null or m.conversation_id = $2::uuid)`,
      [
        tenantId,
        conversationId,
        traductions.map((t) => t.messageId),
        traductions.map((t) => t.texte),
        traductions.map((t) => t.langue),
      ],
    );
  }

  /**
   * Apprend la langue du contact d'une conversation. La date est toujours réécrite, même langue inchangée : une
   * mesure fraîche ne doit pas paraître périmée. Une conversation sans contact rattaché n'écrit rien, sans échec.
   */
  async apprendreLangueContact(tenantId: string, conversationId: string, langue: string): Promise<void> {
    await this.pool.query(
      `update contacts ct
          set langue_detectee = $3, langue_detectee_le = now()
         from conversations c
        where c.id = $2 and c.tenant_id = $1
          and ct.id = c.contact_id and ct.tenant_id = $1`,
      [tenantId, conversationId, langue],
    );
  }
}
