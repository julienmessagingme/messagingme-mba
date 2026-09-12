import type { Pool } from 'pg';

/**
 * L'écriture de ce qu'on vient d'apprendre sur la joignabilité WhatsApp d'un contact (migration 0133).
 *
 * 🔴 UNE SEULE FORME D'ÉCRITURE, POUR LES DEUX SENS. Le « non » vient du second échec 131026 du balayage
 * de relance, le « oui » d'un envoi WhatsApp accepté par Meta : deux chemins, une seule requête, sans quoi
 * la date de mesure serait posée différemment d'un côté et de l'autre et la péremption cesserait de vouloir
 * dire la même chose selon la source.
 *
 * ⚠️ LA DATE EST TOUJOURS RÉÉCRITE, y compris quand la valeur ne change pas. C'est elle qui porte la
 * péremption de 90 jours (`PEREMPTION_WHATSAPP_MS`) : garder l'ancienne date sur une mesure fraîche ferait
 * périmer un constat qu'on vient de refaire.
 */
export function creerNoteurJoignabilite(pool: Pool) {
  /**
   * ⚠️ `tenant_id = $1` comme partout : le pooler est superuser, la RLS est contournée, ce filtre est le
   * seul contrôle d'isolation.
   */
  return async (tenantId: string, contactId: string, joignable: boolean): Promise<void> => {
    await pool.query(
      `update contacts set whatsapp_joignable = $3, whatsapp_joignable_le = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, contactId, joignable],
    );
  };
}
