import type { Pool } from 'pg';

/**
 * L'écriture de ce qu'on vient d'apprendre sur la joignabilité WhatsApp d'un contact. Une seule forme pour les deux
 * sens (le « non » d'un second échec 131026, le « oui » d'un envoi accepté par Meta), pour que la péremption veuille
 * dire la même chose quelle que soit la source.
 * La date est toujours réécrite, même valeur inchangée : elle porte la péremption (`PEREMPTION_WHATSAPP_MS`).
 */
export function creerNoteurJoignabilite(pool: Pool) {
  /** 🔴 `tenant_id = $1` : le pooler contourne la RLS, ce filtre est le seul contrôle d'isolation. */
  return async (tenantId: string, contactId: string, joignable: boolean): Promise<void> => {
    await pool.query(
      `update contacts set whatsapp_joignable = $3, whatsapp_joignable_le = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, contactId, joignable],
    );
  };
}
