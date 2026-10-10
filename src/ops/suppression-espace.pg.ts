import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../db/transaction';
import { vuDeMeta } from '../numero/liberation.pg';
import { lienTableauStripe } from '../stripe/liens';
import { estAdresseOps } from '../auth/middleware';
import type { PgSalesforceStore } from '../salesforce/store.pg';
import type { AbonnementStripe, BilanSuppression, ComptesPurges, EtapeJouee, IssuePurge } from './suppression-espace';

/**
 * LA LECTURE ET LA PURGE D'UN ESPACE QU'ON SUPPRIME (RC8). L'ordre des étapes vit dans `suppression-espace.ts`.
 *
 * 🔴 ISOLATION : chaque requête porte `tenant_id = $1` (ou `id = $1` sur `tenants`), et les identités effacées sont
 * celles des comptes de CET espace qui n'ont plus aucun compte nulle part, relues dans la transaction de la purge.
 * `tests/integration/suppression-espace.integration.test.ts` vérifie qu'un espace voisin, peuplé des mêmes tables, sort
 * intact.
 */
/** Ce que les gestes chez Meta viseraient pour un espace, et si un AUTRE espace le nomme. */
export interface ObjetsMeta {
  /** Les numéros de l'espace, les premiers créés d'abord. */
  phoneNumberIds: string[];
  /** Les comptes WhatsApp de l'espace (`waba`), les premiers créés d'abord. */
  wabasPropres: string[];
  /** Un autre espace nomme l'un de ces comptes ou de ces numéros : rien ne doit se faire chez Meta. */
  partage: boolean;
}

/**
 * Le numéro et le compte WhatsApp que les gestes chez Meta viseraient (les premiers créés, comme les lisent l'activation
 * de l'agent, `getTenantPhoneNumberId`, et le jeton, `getTenantWabaId`), et la règle « partagé ». Une seule définition
 * pour la suppression d'un espace (RC8) et la déconnexion de son numéro : deux copies divergeraient à la première table
 * neuve qui nomme un numéro. Lecture seule.
 *
 * 🔴 PARTAGÉ : un AUTRE espace nomme ce compte WhatsApp ou ce numéro, dans une table qui porte un `waba_id` ou un
 * `phone_number_id` vivant (`credits_offerts` est une mémoire, pas un usage : elle n'y est pas). Alors rien ne se fait
 * chez Meta : désabonner le compte, éteindre l'agent ou vider sa liste toucherait cet autre espace.
 */
export async function objetsMetaDeLEspace(db: Pool | PoolClient, tenantId: string): Promise<ObjetsMeta> {
  const numeros = (await db.query<{ id: string; waba_id: string }>(
    'select id, waba_id from phone_numbers where tenant_id = $1 order by created_at', [tenantId],
  )).rows;
  const wabasPropres = (await db.query<{ id: string }>(
    'select id from waba where tenant_id = $1 order by created_at', [tenantId],
  )).rows.map((r) => r.id);
  const wabas = [...new Set([...wabasPropres, ...numeros.map((r) => r.waba_id)])];
  const pns = numeros.map((r) => r.id);
  const partage = (await db.query<{ partage: boolean }>(
    `select exists (select 1 from phone_numbers p where p.tenant_id <> $1 and (p.waba_id = any($2::text[]) or p.id = any($3::text[])))
         or exists (select 1 from waba w where w.tenant_id <> $1 and w.id = any($2::text[]))
         or exists (select 1 from waba_credentials c where c.tenant_id <> $1 and c.waba_id = any($2::text[]))
         or exists (select 1 from campaigns c where c.tenant_id <> $1 and c.phone_number_id = any($3::text[]))
         or exists (select 1 from mba_liste m where m.tenant_id <> $1 and m.phone_number_id = any($3::text[]))
         or exists (select 1 from agent_tool_consommateurs a where a.tenant_id <> $1 and a.consommateur = any($4::text[]))
         as partage`,
    [tenantId, wabas, pns, pns.map((pn) => `mba:${pn}`)],
  )).rows[0]!.partage;
  return { phoneNumberIds: pns, wabasPropres, partage };
}

export class PgSuppressionEspaceStore {
  constructor(
    private readonly pool: Pool,
    /** `OPS_EMAILS` : une adresse de l'exploitation n'est jamais effacée, même sans autre espace (elle perdrait `/ops`). */
    private readonly opsEmails: readonly string[],
    /**
     * L'organisation Salesforce de l'espace, lue par son propre magasin : le schéma `salesforce` ne se nomme que dans
     * `src/salesforce/` (`tests/salesforce-isolation.test.ts`), pour pouvoir partir sur sa propre base. La purge ne le
     * touche donc pas : c'est l'étape `salesforce` qui délie l'org.
     */
    private readonly salesforce: Pick<PgSalesforceStore, 'lire'>,
  ) {}

  /**
   * Ce que la cascade emportera et ce qu'il faudra faire chez les tiers, lu AVANT la suppression. `null` = espace
   * inconnu. Lecture seule.
   */
  async bilan(tenantId: string): Promise<BilanSuppression | null> {
    const t = await this.pool.query<{ name: string; created_at: Date; status: string }>(
      'select name, created_at, status from tenants where id = $1', [tenantId],
    );
    const espace = t.rows[0];
    if (!espace) return null;

    const n = (await this.pool.query<{
      utilisateurs: number; contacts: number; conversations: number; scenarios: number; solde: string;
      cle_vercel: boolean; mba_allume: boolean; liste: number;
    }>(
      `select (select count(*) from users where tenant_id = $1)::int as utilisateurs,
              (select count(*) from contacts where tenant_id = $1)::int as contacts,
              (select count(*) from conversations where tenant_id = $1)::int as conversations,
              (select count(*) from workflows where tenant_id = $1)::int as scenarios,
              coalesce((select solde_micro_eur from agent_credits where tenant_id = $1), 0)::text as solde,
              exists (select 1 from agent_gateway_keys where tenant_id = $1) as cle_vercel,
              coalesce((select mba_enabled from tenant_settings where tenant_id = $1), false) as mba_allume,
              (select count(*) from mba_liste where tenant_id = $1)::int as liste`,
      [tenantId],
    )).rows[0]!;

    const clients = (await this.pool.query<{ customer_id: string; livemode: boolean }>(
      'select customer_id, livemode from stripe_clients where tenant_id = $1 order by livemode desc', [tenantId],
    )).rows.map((r) => ({ customerId: r.customer_id, livemode: r.livemode, lien: lienTableauStripe('customers', r.customer_id, r.livemode) }));
    // Les deux abonnements que Stripe peut encore facturer : le numéro fourni (lot 3c) et l'offre Pro (lot 6). Vivant =
    // pas encore résilié (numéro) ou sans fin annoncée par Stripe (offre), la définition de chacun des deux magasins.
    const abonnements: AbonnementStripe[] = [
      ...(await this.pool.query<{ id: string; statut: string; livemode: boolean }>(
        'select stripe_subscription_id as id, statut, livemode from abonnements_numero where tenant_id = $1 order by cree_le', [tenantId],
      )).rows.map((r) => ({ id: r.id, produit: 'numero' as const, statut: r.statut, livemode: r.livemode, vivant: r.statut !== 'resilie', lien: lienTableauStripe('subscriptions', r.id, r.livemode) })),
      ...(await this.pool.query<{ id: string; statut: string; livemode: boolean; vivant: boolean }>(
        'select stripe_subscription_id as id, statut, livemode, fini_le is null as vivant from abonnements_offre where tenant_id = $1 order by cree_le', [tenantId],
      )).rows.map((r) => ({ id: r.id, produit: 'offre' as const, statut: r.statut, livemode: r.livemode, vivant: r.vivant, lien: lienTableauStripe('subscriptions', r.id, r.livemode) })),
    ];

    const f = (await this.pool.query<{ id: string; numero: string }>(
      `select id, numero from numeros_fournis where tenant_id = $1 and statut = 'attribue'`, [tenantId],
    )).rows[0];
    const numeroFourni = f ? { numero: f.numero, vuDeMeta: (await vuDeMeta(this.pool, tenantId, f)).vu } : null;

    const { phoneNumberIds: pns, wabasPropres, partage } = await objetsMetaDeLEspace(this.pool, tenantId);

    const personnes = (await this.pool.query<{ email: string; ailleurs: boolean }>(
      `select i.email,
              exists (select 1 from users u2 where u2.identity_id = i.id and u2.tenant_id <> $1) as ailleurs
         from identities i
        where i.id in (select u.identity_id from users u where u.tenant_id = $1 and u.identity_id is not null)
        order by lower(i.email)`,
      [tenantId],
    )).rows;
    const gardee = (p: { email: string; ailleurs: boolean }): boolean => p.ailleurs || estAdresseOps(this.opsEmails, p.email);

    return {
      tenantId,
      nom: espace.name,
      creeLe: espace.created_at.toISOString(),
      statut: espace.status,
      comptes: { utilisateurs: n.utilisateurs, contacts: n.contacts, conversations: n.conversations, scenarios: n.scenarios },
      soldeMicroEur: Number(n.solde),
      stripe: { clients, abonnements },
      numeroFourni,
      meta: {
        phoneNumberId: pns[0] ?? null,
        wabaId: wabasPropres[0] ?? null,
        partage,
        mbaAllume: n.mba_allume,
        contactsSurLaListe: n.liste,
      },
      salesforce: (await this.salesforce.lire(tenantId)) !== null,
      cleVercel: n.cle_vercel,
      adresses: {
        effacees: personnes.filter((p) => !gardee(p)).map((p) => p.email),
        gardees: personnes.filter(gardee).map((p) => p.email),
      },
    };
  }

  /**
   * LA PURGE, EN UNE TRANSACTION, et la ligne de trace avec elle (elle sert de pierre tombale aux jobs de file : elle
   * doit exister dès que l'espace a disparu). Rien n'est touché si l'espace a disparu entre-temps, ou si une clé Vercel
   * s'est rouverte depuis la révocation (la cascade en perdrait l'identifiant).
   *
   * 🔴 L'ORDRE DE LA CASCADE N'EST PAS GARANTI, et six clés en `restrict` ou `no action` la feraient échouer selon
   * l'ordre : les publications et les liens de chaîne (vers `workflows`), les outils (vers les requêtes de connecteur et
   * les sources), les requêtes (vers les sources). Leurs lignes partent d'abord, à la main, du plus profond au moins
   * profond. `users.identity_id` (restrict vers `identities`) ne gêne pas : les comptes partent avec l'espace, les
   * identités après lui.
   *
   * 🔴 `credits_offerts` N'EST PAS TOUCHÉE : c'est la mémoire « jamais deux offres pour un numéro », et l'effacer rendrait
   * l'offre récoltable par suppression puis recréation d'un espace.
   */
  async purger(tenantId: string, trace: { par: string; etapes: EtapeJouee[] }): Promise<IssuePurge> {
    return enTransaction(this.pool, async (client) => {
      // Le verrou de la ligne de l'espace : une écriture concurrente qui le nomme (un compte, une clé) attend la fin de
      // la purge, puis échoue sur sa clé étrangère. Rien ne peut donc apparaître entre la relecture et le `delete`.
      const t = await client.query<{ name: string; created_at: Date }>(
        'select name, created_at from tenants where id = $1 for update', [tenantId],
      );
      const espace = t.rows[0];
      if (!espace) return { fait: false, raison: 'disparu' } as const;
      const cle = await client.query('select 1 from agent_gateway_keys where tenant_id = $1', [tenantId]);
      if ((cle.rowCount ?? 0) > 0) return { fait: false, raison: 'cle_rouverte' } as const;

      const identites = (await client.query<{ identity_id: string }>(
        'select distinct identity_id from users where tenant_id = $1 and identity_id is not null', [tenantId],
      )).rows.map((r) => r.identity_id);
      const n = (await client.query<{ utilisateurs: number; contacts: number; conversations: number; messages: number; scenarios: number }>(
        `select (select count(*) from users where tenant_id = $1)::int as utilisateurs,
                (select count(*) from contacts where tenant_id = $1)::int as contacts,
                (select count(*) from conversations where tenant_id = $1)::int as conversations,
                (select count(*) from conversation_messages m join conversations c on c.id = m.conversation_id where c.tenant_id = $1)::int as messages,
                (select count(*) from workflows where tenant_id = $1)::int as scenarios`,
        [tenantId],
      )).rows[0]!;

      // Le filet du numéro fourni : s'il est encore attribué (l'étape d'avant a échoué), il sort en `bloque`, comme le
      // 2026-10-06. Sans quoi la clé en `set null` le laisserait `attribue` à personne, hors de la réserve pour toujours.
      await client.query(
        `update numeros_fournis set statut = 'bloque', tenant_id = null, attribue_le = null where tenant_id = $1 and statut = 'attribue'`,
        [tenantId],
      );
      await client.query('delete from channelsme_posts where tenant_id = $1', [tenantId]);
      await client.query('delete from channelsme_links where tenant_id = $1', [tenantId]);
      await client.query('delete from agent_tools where tenant_id = $1', [tenantId]);
      await client.query('delete from connector_requests where tenant_id = $1', [tenantId]);
      await client.query('delete from tenants where id = $1', [tenantId]);

      // Les identités de CET espace qui n'ont plus aucun compte, sauf une adresse de l'exploitation.
      const effacees = await client.query(
        `delete from identities i
          where i.id = any($1::uuid[])
            and not exists (select 1 from users u where u.identity_id = i.id)
            and lower(i.email) <> all($2::text[])`,
        [identites, this.opsEmails.map((e) => e.trim().toLowerCase()).filter((e) => e !== '')],
      );
      const comptes: ComptesPurges = {
        ...n,
        identitesEffacees: effacees.rowCount ?? 0,
        identitesGardees: identites.length - (effacees.rowCount ?? 0),
      };
      await client.query(
        `insert into espaces_supprimes (tenant_id, nom, cree_le, par, etapes, comptes) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [tenantId, espace.name, espace.created_at, trace.par, JSON.stringify(trace.etapes), JSON.stringify(comptes)],
      );
      return { fait: true, comptes } as const;
    });
  }
}
