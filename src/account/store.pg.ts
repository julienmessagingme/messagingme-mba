import type { Pool } from 'pg';
import type { PhoneNumberRecord } from '../http/account';

/** Accès en lecture/écriture au statut d'un numéro (page Accueil : numéro + pastille de statut). */
export class PgPhoneStatusStore {
  constructor(private readonly pool: Pool) {}

  /** Numéro principal du tenant avec son statut persisté. null si aucun numéro. */
  async getPhoneNumber(tenantId: string): Promise<PhoneNumberRecord | null> {
    const res = await this.pool.query<{
      id: string; display_phone_number: string | null; status: string | null; quality_rating: string | null; messaging_limit_tier: string | null;
    }>(
      `select id, display_phone_number, status, quality_rating, messaging_limit_tier
         from phone_numbers where tenant_id = $1 order by created_at limit 1`,
      [tenantId],
    );
    const r = res.rows[0];
    return r
      ? { id: r.id, displayPhoneNumber: r.display_phone_number, status: r.status, qualityRating: r.quality_rating, messagingLimitTier: r.messaging_limit_tier }
      : null;
  }

  /**
   * Persiste un statut fraîchement pull. `coalesce($n, col)` : un champ absent du pull (undefined -> null)
   * NE remplace PAS la valeur connue en base. Note : `quality_rating` porte un CHECK
   * (GREEN/YELLOW/RED/UNKNOWN) ; l'appelant ne passe qu'une valeur normalisée à cet ensemble.
   */
  async saveStatus(phoneNumberId: string, patch: { status?: string; qualityRating?: string; messagingLimitTier?: string }): Promise<void> {
    await this.pool.query(
      `update phone_numbers set
         status = coalesce($2, status),
         quality_rating = coalesce($3, quality_rating),
         messaging_limit_tier = coalesce($4, messaging_limit_tier)
       where id = $1`,
      [phoneNumberId, patch.status ?? null, patch.qualityRating ?? null, patch.messagingLimitTier ?? null],
    );
  }
}
