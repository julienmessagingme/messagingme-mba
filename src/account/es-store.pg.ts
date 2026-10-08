import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { offrirAuNumeroVerifie } from '../agent/credits.pg';

/**
 * 🔴 Un WABA, un numéro ou des credentials appartiennent déjà à un autre espace : on refuse de les réaffecter en
 * silence. La route de l'Embedded Signup la traduit en 409.
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
 * L'espace a déjà un numéro, et le produit n'en accepte qu'un.
 *
 * Le modèle de données suppose un fil par `(tenant_id, wa_id)` : conversations, parcours, automations, inbox et
 * analytics ne portent pas `phone_number_id`. Un second numéro fusionnerait donc les deux canaux en silence (une
 * même personne sur les deux numéros tomberait dans une seule conversation). Lever la limite demande de propager
 * `phone_number_id` partout, pas de supprimer ce test.
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
 * 🔴 UN COMPTE SANS NUMÉRO EST PROVISOIRE (lot 3b). Relier un compte à l'espace (`$2`) retire ses AUTRES comptes qui
 * n'ont aucun numéro, et leur jeton par la cascade : sinon l'espace en porterait deux, et `getTenantWabaId` (le
 * premier créé) ferait partir les modèles vers celui qui n'a pas de numéro. Un compte qui porte un numéro n'est
 * jamais retiré. Avant le lot 3b, aucun compte sans numéro ne pouvait exister.
 */
export const RETIRER_COMPTE_SANS_NUMERO = `delete from waba w
  where w.tenant_id = $1 and w.id <> $2
    and not exists (select 1 from phone_numbers p where p.waba_id = w.id)`;

/**
 * Persistance de l'Embedded Signup : rattache le WABA et le numéro à l'espace, et conserve le token business
 * (chiffré en amont par l'appelant) dans `waba_credentials`.
 * 🔴 Chaque upsert porte `where <table>.tenant_id = excluded.tenant_id` : un conflit avec un autre espace ne met
 * rien à jour (rowCount 0) et lève TenantConflictError.
 */
export class PgEmbeddedSignupStore {
  /**
   * `offre.creditOffertMicroEur` : le crédit offert au premier numéro vérifié d'un espace, quelle que soit son origine
   * (`CREDIT_OFFERT_MICRO_EUR`, 1 € par défaut depuis le lot 6, 0 l'éteint). Requis : un câblage qui l'oublierait
   * relierait des numéros sans jamais rien offrir, sans le dire.
   */
  constructor(private readonly pool: Pool, private readonly offre: { creditOffertMicroEur: number }) {}

  /**
   * Rattache le WABA et le numéro à l'espace.
   *
   * 🔴 ELLE N'OFFRE PLUS RIEN (relecture du 2026-09-29). L'offre y était écrite, dans sa transaction, et la liaison
   * tourne AVANT que la route ne sache si Meta a vérifié le numéro : un numéro que Meta dit `NOT_VERIFIED` recevait
   * donc ses 5 €. L'offre vit dans `offrirCredit`, que la route appelle quand Meta dit le numéro vérifié.
   */
  async linkTenant(input: {
    tenantId: string;
    wabaId: string;
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
  }): Promise<void> {
    await enTransaction(this.pool, async (client) => {
      // Conflit d'id avec un autre espace : l'update ne s'exécute pas, rowCount 0, refus.
      const wabaRes = await client.query(
        `insert into waba (id, tenant_id) values ($1, $2)
         on conflict (id) do update set tenant_id = excluded.tenant_id
         where waba.tenant_id = excluded.tenant_id`,
        [input.wabaId, input.tenantId],
      );
      if ((wabaRes.rowCount ?? 0) === 0) throw new TenantConflictError('waba', input.wabaId);

      // Un seul numéro par espace, testé dans la transaction. Le numéro qu'on rattache est ignoré : rejouer
      // l'Embedded Signup sur le même numéro reste idempotent.
      const dejaLa = await client.query<{ id: string }>(
        `select id from phone_numbers where tenant_id = $1 and id <> $2 limit 1`,
        [input.tenantId, input.phoneNumberId],
      );
      const existant = dejaLa.rows[0];
      if (existant) throw new SecondNumeroRefuseError(existant.id, input.phoneNumberId);
      // display/verified fournis quand le GET du numéro a réussi, sinon on garde l'existant (coalesce).
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
      await client.query(RETIRER_COMPTE_SANS_NUMERO, [input.tenantId, input.wabaId]);
    });
  }

  /**
   * Relie à l'espace un compte WhatsApp revenu de la fenêtre SANS numéro (lot 3b), pour que le serveur y ajoute le
   * numéro fourni. Mêmes refus que `linkTenant` : le compte d'un autre espace, un espace qui a déjà son numéro.
   * Rejouer est sans effet ; un compte sans numéro relié avant, sous un autre identifiant, est remplacé.
   */
  async lierCompteSansNumero(input: { tenantId: string; wabaId: string }): Promise<void> {
    await enTransaction(this.pool, async (client) => {
      const dejaLa = await client.query<{ id: string }>(
        `select id from phone_numbers where tenant_id = $1 limit 1`,
        [input.tenantId],
      );
      const existant = dejaLa.rows[0];
      if (existant) throw new SecondNumeroRefuseError(existant.id, '');
      const wabaRes = await client.query(
        `insert into waba (id, tenant_id) values ($1, $2)
         on conflict (id) do update set tenant_id = excluded.tenant_id
         where waba.tenant_id = excluded.tenant_id`,
        [input.wabaId, input.tenantId],
      );
      if ((wabaRes.rowCount ?? 0) === 0) throw new TenantConflictError('waba', input.wabaId);
      await client.query(RETIRER_COMPTE_SANS_NUMERO, [input.tenantId, input.wabaId]);
    });
  }

  /**
   * Offre le crédit de bienvenue pour ce numéro, que Meta vient de dire VÉRIFIÉ (`CONNECTED`, `VERIFIED`, ou un code
   * accepté). C'est la ROUTE qui le sait, pas ce dépôt : il ne l'appelle jamais de lui-même. Rend le montant offert (0
   * si rien), pour que le câblage remonte le plafond d'une clé de modèle déjà ouverte.
   *
   * Les bornes sont celles de `offrirAuNumeroVerifie` (une par espace, jamais deux pour un numéro, par son identifiant
   * ni par son numéro affiché) : rappeler ce geste sur un numéro déjà servi n'offre rien de plus. Une transaction :
   * l'offre et son crédit s'écrivent ensemble ou pas du tout.
   */
  async offrirCredit(tenantId: string, phoneNumberId: string): Promise<number> {
    // Le même montant pour toutes les origines (lot 6, C) : la console et Claude Code offrent 1 €.
    return enTransaction(this.pool, (client) => offrirAuNumeroVerifie(client, tenantId, phoneNumberId, this.offre.creditOffertMicroEur));
  }

  /**
   * Upsert des credentials du WABA. `businessTokenEnc` et `pinEnc` sont déjà chiffrés (AES-GCM) par l'appelant.
   * 🔴 L'état suit le JETON, pas le WABA : un jeton neuf (une reconnexion) repart `active`, sinon un WABA marqué
   * invalide le resterait après avoir été reconnecté. Le même chiffré réécrit garde son état.
   */
  async saveCredentials(wabaId: string, tenantId: string, businessTokenEnc: string, pinEnc: string | null): Promise<void> {
    // Même garde entre espaces que linkTenant : le token d'un WABA d'un autre espace ne se réattribue pas.
    const res = await this.pool.query(
      `insert into waba_credentials (waba_id, tenant_id, business_token_enc, pin_enc)
       values ($1, $2, $3, $4)
       on conflict (waba_id) do update set
         tenant_id = excluded.tenant_id,
         business_token_enc = excluded.business_token_enc,
         pin_enc = coalesce(excluded.pin_enc, waba_credentials.pin_enc),
         token_status = case when waba_credentials.business_token_enc = excluded.business_token_enc
                             then waba_credentials.token_status else 'active' end,
         token_invalid_at = case when waba_credentials.business_token_enc = excluded.business_token_enc
                                 then waba_credentials.token_invalid_at else null end,
         updated_at = now()
       where waba_credentials.tenant_id = excluded.tenant_id`,
      [wabaId, tenantId, businessTokenEnc, pinEnc],
    );
    if ((res.rowCount ?? 0) === 0) throw new TenantConflictError('waba_credentials', wabaId);
  }

  /**
   * Conserve le PIN 2FA d'un numéro activé depuis la console, sans toucher au token business : la route n'a pas le
   * token (le câblage ne le laisse jamais entrer dans une route), et `saveCredentials` l'écraserait.
   * `tenantId` est dans le `where` : même garde entre espaces que partout ailleurs.
   */
  async enregistrerPin(wabaId: string, tenantId: string, pinEnc: string): Promise<void> {
    const res = await this.pool.query(
      `update waba_credentials set pin_enc = $3, updated_at = now() where waba_id = $1 and tenant_id = $2`,
      [wabaId, tenantId, pinEnc],
    );
    if ((res.rowCount ?? 0) === 0) throw new TenantConflictError('waba_credentials', wabaId);
  }

  /**
   * Lit le token business chiffré d'un WABA et son état. null si aucun credential (numéro branché à la main) :
   * l'appelant retombe sur le token global.
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
   * Marque le token d'un WABA invalide (révoqué, expiré), détecté sur une erreur d'auth Meta. Idempotent, garde la
   * première date.
   * 🔴 Seulement si le jeton stocké est ENCORE celui qui a échoué (`businessTokenEnc`, le chiffré lu avant l'appel) :
   * une copie de l'API qui garde l'ancien jeton en cache après une reconnexion ne doit pas condamner le jeton neuf.
   */
  async markTokenInvalid(wabaId: string, businessTokenEnc: string): Promise<void> {
    await this.pool.query(
      `update waba_credentials
       set token_status = 'invalid', token_invalid_at = coalesce(token_invalid_at, now()), updated_at = now()
       where waba_id = $1 and business_token_enc = $2 and token_status <> 'invalid'`,
      [wabaId, businessTokenEnc],
    );
  }
}
