import type { Pool } from 'pg';

/**
 * Persistance de l'Embedded Signup : rattache le WABA + le numéro au workspace, et conserve le token
 * business (chiffré EN AMONT par l'appelant, jamais en clair ici) dans `waba_credentials`.
 * Reconnexion d'un numéro déjà connu (démo : le même numéro passe d'un workspace à un autre) = RÉAFFECTATION
 * (`on conflict ... do update set tenant_id`), pas d'erreur d'unicité.
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
      await client.query(
        `insert into waba (id, tenant_id) values ($1, $2)
         on conflict (id) do update set tenant_id = excluded.tenant_id`,
        [input.wabaId, input.tenantId],
      );
      // display/verified : fournis quand le GET du numéro a réussi ; sinon on GARDE l'existant (coalesce),
      // le pull de statut du dashboard enrichira.
      await client.query(
        `insert into phone_numbers (id, waba_id, tenant_id, display_phone_number, verified_name)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set
           waba_id = excluded.waba_id,
           tenant_id = excluded.tenant_id,
           display_phone_number = coalesce(excluded.display_phone_number, phone_numbers.display_phone_number),
           verified_name = coalesce(excluded.verified_name, phone_numbers.verified_name)`,
        [input.phoneNumberId, input.wabaId, input.tenantId, input.displayPhoneNumber, input.verifiedName],
      );
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
    await this.pool.query(
      `insert into waba_credentials (waba_id, tenant_id, business_token_enc, pin_enc)
       values ($1, $2, $3, $4)
       on conflict (waba_id) do update set
         tenant_id = excluded.tenant_id,
         business_token_enc = excluded.business_token_enc,
         pin_enc = coalesce(excluded.pin_enc, waba_credentials.pin_enc),
         updated_at = now()`,
      [wabaId, tenantId, businessTokenEnc, pinEnc],
    );
  }
}
