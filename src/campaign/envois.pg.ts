import type { Pool } from 'pg';
import type { TentativeEnvoi } from './engine';

/**
 * Le journal des tentatives d'envoi, en ajout seul.
 *
 * `campaign_recipients` porte une ligne par contact (son unique garantit qu'une personne ne reçoit pas
 * deux fois) et ne garde que le dernier état : un échec WhatsApp suivi d'un succès RCS y serait invisible.
 *
 * Une tentative ne se corrige pas. Seul `delivery_status` bouge ensuite, écrit par l'accusé de Meta dans la
 * même instruction que `campaign_recipients` (`PgRecipientStore.updateDeliveryByMessageId`).
 */
export function creerNoteurEnvois(pool: Pool) {
  return async (t: TentativeEnvoi): Promise<void> => {
    /**
     * 🔴 Pas de `tenant_id` sur cette table : l'isolation passe par `campaign_id`, et toute lecture doit
     * joindre `campaigns` filtrée sur `tenant_id` (comme `getCampaignFunnel`).
     */
    await pool.query(
      `insert into campaign_envois
         (campaign_id, recipient_id, contact_id, rang, canal, statut, message_id, error_code, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        t.campaignId,
        t.recipientId,
        t.contactId,
        t.rang,
        t.canal,
        t.statut,
        t.messageId ?? null,
        t.errorCode ?? null,
        t.error ?? null,
      ],
    );
  };
}
