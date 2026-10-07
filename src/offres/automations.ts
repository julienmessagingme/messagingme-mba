import type { Pool } from 'pg';
import { LimiteOffreError } from './refus';

/**
 * LA LIMITE D'AUTOMATIONS DE L'OFFRE (lot 6, spec § 4) : on compte les automations ALLUMÉES du client, celles qu'aucun lien
 * de chaîne, aucune publicité, aucun widget ne possède (`possede_par` vide). Celles des webhooks entrants comptent : c'est
 * précisément l'usage de la Base (un déclencheur de chez le client qui envoie un modèle). Vérifiée à la création d'une
 * automation allumée et au rallumage, par les deux magasins qui en écrivent (`PgAutomationStore`, `PgWebhookStore`).
 *
 * ⚠️ Lecture puis écriture, sans verrou : deux allumages simultanés à la dernière place peuvent passer tous les deux. Une
 * limite commerciale tolère ce dépassement.
 */
export async function verifierPlaceAutomation(
  q: Pick<Pool, 'query'>,
  tenantId: string,
  limite: number | null,
  /** L'automation qu'on rallume : elle ne se compte pas elle-même. */
  exclure: string | null,
): Promise<void> {
  if (limite === null) return;
  const r = await q.query<{ n: number }>(
    `select count(*)::int as n from automations
      where tenant_id = $1 and enabled and possede_par is null and ($2::uuid is null or id <> $2::uuid)`,
    [tenantId, exclure],
  );
  if ((r.rows[0]?.n ?? 0) >= limite) throw new LimiteOffreError(tenantId, 'automations', limite);
}
