import type { Pool } from 'pg';
import type { TentativeEnvoi } from './engine';

/**
 * LE JOURNAL DES TENTATIVES D'ENVOI, EN AJOUT SEUL (migration 0134).
 *
 * 🔴 IL EXISTE PARCE QUE `campaign_recipients` NE PEUT PAS RÉPONDRE À LA QUESTION. Cette table-là porte
 * UNE ligne par contact, et c'est son `unique (campaign_id, contact_id)` qui garantit qu'une personne ne
 * reçoit pas deux fois le même message : y loger les tentatives aurait ouvert cette porte. Le jour où un
 * destinataire échouera en WhatsApp puis réussira en RCS, la ligne de contact ne gardera que le DERNIER
 * état, donc l'échec WhatsApp deviendrait invisible et le canal qui a vraiment livré, indiscernable.
 *
 * ⚠️ AJOUT SEUL, JAMAIS DE MISE À JOUR ICI. Une tentative est un fait daté : elle ne se corrige pas. La
 * seule colonne qui bouge après coup est `delivery_status`, écrite par l'accusé de Meta depuis
 * `PgRecipientStore.updateDeliveryByMessageId`, qui met à jour les deux tables dans la MÊME instruction.
 *
 * ⚠️ PERSONNE NE LE LIT ENCORE POUR DÉCIDER quoi que ce soit : il se remplit d'abord, et le funnel par
 * canal vient ensuite. C'est délibéré, ça laisse le temps de comparer ce qu'il dit à ce que
 * `campaign_recipients` dit, sur du vrai trafic, avant de faire reposer un écran dessus.
 */
export function creerNoteurEnvois(pool: Pool) {
  return async (t: TentativeEnvoi): Promise<void> => {
    /**
     * ⚠️ PAS DE `tenant_id` SUR CETTE TABLE, ET CE N'EST PAS UN OUBLI. Elle n'en porte pas : son
     * isolation vient de `campaign_id`, dont la campagne porte le tenant, et TOUTE lecture passe par une
     * jointure sur `campaigns` filtrée `tenant_id = $1` (c'est ce que fait `getCampaignFunnel`). Ajouter
     * une colonne de tenant ici créerait une seconde vérité, qu'il faudrait garder d'accord avec la
     * première. L'écriture, elle, ne reçoit que des identifiants que le moteur vient de lire sur la
     * campagne qu'il fait tourner.
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
