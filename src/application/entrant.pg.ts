import type { Pool } from 'pg';

/**
 * Un message de l'application est-il déjà enregistré dans cet espace ? (`traiterEntrantApplication`) 🔴 Le filtre
 * `tenant_id` est le seul contrôle : la lecture passe par la conversation de l'espace. Servie par l'index unique
 * partiel de `conversation_messages.meta_message_id`, que l'égalité suffit à viser.
 */
export function creerDejaRecu(pool: Pool): (tenantId: string, messageId: string) => Promise<boolean> {
  return async (tenantId, messageId) => {
    const r = await pool.query(
      `select 1 from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1 and m.meta_message_id = $2
        limit 1`,
      [tenantId, messageId],
    );
    return (r.rowCount ?? 0) > 0;
  };
}
