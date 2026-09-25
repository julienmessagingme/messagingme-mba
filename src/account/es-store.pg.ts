import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';

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
 * Le workspace a DÉJÀ un numéro, et le produit n'en accepte qu'un (décision de Julien, 2026-08-31).
 *
 * 🔴 Ce refus n'est pas une limitation arbitraire, c'est la seule réponse HONNÊTE que le code sache donner
 * aujourd'hui. Le modèle de données suppose un fil par `(tenant_id, wa_id)` : `conversations`,
 * `workflow_runs`, les automations, l'inbox et les analytics ne portent PAS `phone_number_id`. Rattacher un
 * second numéro ne créerait donc pas un second canal, ça FUSIONNERAIT les deux : la même personne écrivant aux
 * deux numéros du client tomberait dans une seule conversation, et un parcours démarré sur l'un répondrait sur
 * l'autre. Silencieusement.
 *
 * ⚠️ Lever cette limite ne consiste PAS à supprimer ce test. La liste des chemins à propager est au §A8 de
 * `AUDIT-SYNTHESE-STRUCTURE-SCALABILITE-2026-08-31.md` : propagation de `phone_number_id`, unicité
 * `(tenant_id, phone_number_id, wa_id)`, migration des conversations existantes, portée du consentement,
 * numéro par défaut, throttle et palier par numéro. C'est un chantier, pas un drapeau.
 */
export class SecondNumeroRefuseError extends Error {
  constructor(
    readonly dejaRattache: string,
    readonly refuse: string,
  ) {
    super(`ce workspace a déjà le numéro ${dejaRattache} : un seul numéro par workspace`);
    this.name = 'SecondNumeroRefuseError';
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
    await enTransaction(this.pool, async (client) => {
      // `where waba.tenant_id = excluded.tenant_id` : sur conflit d'id avec un AUTRE tenant, l'update ne s'exécute
      // pas -> rowCount 0 -> on refuse (pas de réaffectation silencieuse). Même tenant ou insert neuf -> rowCount 1.
      const wabaRes = await client.query(
        `insert into waba (id, tenant_id) values ($1, $2)
         on conflict (id) do update set tenant_id = excluded.tenant_id
         where waba.tenant_id = excluded.tenant_id`,
        [input.wabaId, input.tenantId],
      );
      if ((wabaRes.rowCount ?? 0) === 0) throw new TenantConflictError('waba', input.wabaId);

      // UN SEUL numéro par workspace (cf. `SecondNumeroRefuseError`, qui porte le pourquoi). Le test est fait
      // DANS la transaction, donc sur un état cohérent avec l'insertion qui suit, et il ignore le numéro
      // qu'on est en train de rattacher : re-jouer l'Embedded Signup sur le MÊME numéro reste idempotent,
      // c'est un cas normal (l'opérateur recommence après un avertissement).
      const dejaLa = await client.query<{ id: string }>(
        `select id from phone_numbers where tenant_id = $1 and id <> $2 limit 1`,
        [input.tenantId, input.phoneNumberId],
      );
      const existant = dejaLa.rows[0];
      if (existant) throw new SecondNumeroRefuseError(existant.id, input.phoneNumberId);
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
    });
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

  /**
   * Conserve le PIN 2FA d'un numéro activé DEPUIS LA CONSOLE, sans toucher au token business.
   *
   * 🔴 POURQUOI PAS `saveCredentials`. Celui-ci exige le token business, que la route d'activation n'a pas (et
   * ne doit pas avoir : le câblage le résout et ne le laisse jamais entrer dans une route). Lui passer autre
   * chose que le vrai token l'ÉCRASERAIT, et l'espace perdrait sa voix.
   *
   * ⚠️ `tenantId` est dans le `where`, pas seulement dans le `set` : même garde inter-espace que partout
   * ailleurs, la RLS étant contournée par le pooler.
   */
  async enregistrerPin(wabaId: string, tenantId: string, pinEnc: string): Promise<void> {
    const res = await this.pool.query(
      `update waba_credentials set pin_enc = $3, updated_at = now() where waba_id = $1 and tenant_id = $2`,
      [wabaId, tenantId, pinEnc],
    );
    if ((res.rowCount ?? 0) === 0) throw new TenantConflictError('waba_credentials', wabaId);
  }

  /**
   * Lit le token business chiffré d'un WABA + son état. null si aucun credential (numéro branché à la main, hors
   * Embedded Signup) -> l'appelant retombe sur le token global. C'est le chemin de LECTURE qui manquait (le
   * chiffrement au repos ne servait à rien tant que personne ne relisait le token).
   */
  async getCredentialsByWaba(wabaId: string): Promise<{ businessTokenEnc: string; tokenStatus: 'active' | 'invalid' } | null> {
    const res = await this.pool.query<{ business_token_enc: string; token_status: 'active' | 'invalid' }>(
      `select business_token_enc, token_status from waba_credentials where waba_id = $1`,
      [wabaId],
    );
    const r = res.rows[0];
    return r ? { businessTokenEnc: r.business_token_enc, tokenStatus: r.token_status } : null;
  }

  /**
   * Marque le token d'un WABA comme invalide (révoqué/expiré), détecté RÉACTIVEMENT sur une erreur d'auth Meta.
   * Idempotent. N'écrase pas token_invalid_at si déjà invalide (garde la 1re date). Best-effort côté appelant.
   */
  async markTokenInvalid(wabaId: string): Promise<void> {
    await this.pool.query(
      `update waba_credentials
       set token_status = 'invalid', token_invalid_at = coalesce(token_invalid_at, now()), updated_at = now()
       where waba_id = $1 and token_status <> 'invalid'`,
      [wabaId],
    );
  }
}
