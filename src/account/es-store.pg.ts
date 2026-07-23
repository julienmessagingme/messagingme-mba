import type { Pool } from 'pg';

/**
 * Un WABA / numéro / credentials appartient DÉJÀ à un autre workspace. On refuse de le réaffecter en silence.
 * La route de l'Embedded Signup la traduit en 409.
 */
export class TenantConflictError extends Error {
  constructor(
    readonly resource: 'waba' | 'phone_number' | 'waba_credentials',
    readonly id: string,
  ) {
    super(`${resource} ${id} appartient déjà à un autre workspace`);
    this.name = 'TenantConflictError';
  }
}

/**
 * Persistance de l'Embedded Signup : rattache le WABA + le numéro au workspace, et conserve le token
 * business (chiffré EN AMONT par l'appelant, jamais en clair ici) dans `waba_credentials`.
 *
 * ⚠️ Un WABA/numéro/credentials déjà rattaché à un AUTRE workspace n'est PAS réaffecté en silence : chaque upsert
 * porte `where <table>.tenant_id = excluded.tenant_id`, donc un conflit inter-tenant ne met rien à jour (rowCount 0)
 * et lève TenantConflictError. La migration VOLONTAIRE d'un numéro passe par un chemin admin séparé, pas par ici.
 */
export class PgEmbeddedSignupStore {
  constructor(private readonly pool: Pool) {}

  async linkTenant(input: {
    tenantId: string;
    wabaId: string;
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // `where waba.tenant_id = excluded.tenant_id` : sur conflit d'id avec un AUTRE tenant, l'update ne s'exécute
      // pas -> rowCount 0 -> on refuse (pas de réaffectation silencieuse). Même tenant ou insert neuf -> rowCount 1.
      const wabaRes = await client.query(
        `insert into waba (id, tenant_id) values ($1, $2)
         on conflict (id) do update set tenant_id = excluded.tenant_id
         where waba.tenant_id = excluded.tenant_id`,
        [input.wabaId, input.tenantId],
      );
      if ((wabaRes.rowCount ?? 0) === 0) throw new TenantConflictError('waba', input.wabaId);
      // display/verified : fournis quand le GET du numéro a réussi ; sinon on GARDE l'existant (coalesce),
      // le pull de statut du dashboard enrichira.
      const phoneRes = await client.query(
        `insert into phone_numbers (id, waba_id, tenant_id, display_phone_number, verified_name)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set
           waba_id = excluded.waba_id,
           tenant_id = excluded.tenant_id,
           display_phone_number = coalesce(excluded.display_phone_number, phone_numbers.display_phone_number),
           verified_name = coalesce(excluded.verified_name, phone_numbers.verified_name)
         where phone_numbers.tenant_id = excluded.tenant_id`,
        [input.phoneNumberId, input.wabaId, input.tenantId, input.displayPhoneNumber, input.verifiedName],
      );
      if ((phoneRes.rowCount ?? 0) === 0) throw new TenantConflictError('phone_number', input.phoneNumberId);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Upsert des credentials du WABA. `businessTokenEnc` et `pinEnc` = DÉJÀ chiffrés (AES-GCM) par l'appelant. */
  async saveCredentials(wabaId: string, tenantId: string, businessTokenEnc: string, pinEnc: string | null): Promise<void> {
    // Même garde inter-tenant que linkTenant : un WABA d'un autre workspace ne se fait pas réattribuer son token
    // business chiffré en silence (conflit -> rowCount 0 -> TenantConflictError).
    const res = await this.pool.query(
      `insert into waba_credentials (waba_id, tenant_id, business_token_enc, pin_enc)
       values ($1, $2, $3, $4)
       on conflict (waba_id) do update set
         tenant_id = excluded.tenant_id,
         business_token_enc = excluded.business_token_enc,
         pin_enc = coalesce(excluded.pin_enc, waba_credentials.pin_enc),
         updated_at = now()
       where waba_credentials.tenant_id = excluded.tenant_id`,
      [wabaId, tenantId, businessTokenEnc, pinEnc],
    );
    if ((res.rowCount ?? 0) === 0) throw new TenantConflictError('waba_credentials', wabaId);
  }
}
