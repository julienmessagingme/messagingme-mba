import type { Pool } from 'pg';
import { PREFIXE_ENVOI_API } from '../api/cible-rcs';
import { PREFIXE_LIGNE_HUBSPOT } from '../hubspot-workflow/envoi';
import { ficheActive } from '../crm/contact-store.pg';
import { LIGNE_RELANCE_PANIER, PREFIXE_LIGNE_SHOPIFY, type SourceVente, type Touche, type VenteAttribuee } from './attribution';

/** Une vente à figer : la commande, son montant dans la devise de la boutique, et son attribution. */
export type VenteAEnregistrer = {
  commandeId: string;
  contactId: string;
  /** Décimal en texte (`49.90`) : jamais un flottant entre Shopify et la base. */
  montant: string;
  devise: string;
  payeeLe: Date;
  test: boolean;
} & VenteAttribuee;

interface LigneTouche { source: SourceVente; le: Date; campaign_id: string | null; modele: string | null; lance_scenario: boolean }

/**
 * LES TOUCHES D'UN CONTACT (migration 0261, plan 2026-10-28, tâche 2), lues à deux endroits :
 * - les DESTINATAIRES de Campagnes, pour les campagnes et la relance de panier. Les autres lignes Shopify (confirmation,
 *   expédition), les envois `[API]` (API publique, `send_template_to_contact`) et ceux des workflows HubSpot n'en sont
 *   jamais une, bien qu'elles partagent l'origine `campagne` : elles se reconnaissent par leur nom (`attribution.ts`,
 *   `PREFIXE_ENVOI_API`, `PREFIXE_LIGNE_HUBSPOT`) ;
 * - les MESSAGES du fil du contact, pour le scénario (`scenario`), l'agent IA (`ia`) et l'agent de Meta (`mba`). Le fil
 *   se trouve par son `wa_id` (chiffres du numéro, ou BSUID), la règle de `matchWaIdPredicat`, par l'index unique.
 * « Livré » = `delivered` ou `read`. En filière `application`, aucun accusé n'arrive jamais : parti sans échec suffit.
 * Une campagne qui lance un scénario n'a pas d'accusé non plus (identifiant de message synthétique) : partie suffit.
 */
const TOUCHES = `
  with fils as (
    select v.id from conversations v
     where v.tenant_id = $1 and v.wa_id in (
       select x from contacts c,
              lateral (values (regexp_replace(coalesce(c.phone_e164, ''), '[^0-9]', '', 'g')), (c.bsuid)) as t(x)
        where c.tenant_id = $1 and c.id = $2 and x is not null and x <> ''
     )
  )
  select case when k.name = $6 then 'relance_panier' else 'campagne' end as source,
         r.sent_at as le,
         case when k.name = $6 then null else k.id end as campaign_id,
         k.template_name as modele,
         (k.workflow_id is not null and k.name <> $6) as lance_scenario
    from campaign_recipients r join campaigns k on k.id = r.campaign_id
   where k.tenant_id = $1 and r.contact_id = $2 and r.status = 'sent'
     and ($3::timestamptz is null or r.sent_at >= $3) and r.sent_at <= $4
     and (k.name = $6 or not (starts_with(k.name, $7) or starts_with(k.name, $8) or starts_with(k.name, $10)))
     and ($9::text is null or k.template_name = $9)
     and (r.delivery_status in ('delivered', 'read')
          or (r.delivery_status is distinct from 'failed' and ($5 or k.workflow_id is not null)))
  union all
  select case m.origin when 'scenario' then 'scenario' when 'ia' then 'agent' else 'agent_meta' end,
         m.created_at, null::uuid, m.template_name, false
    from conversation_messages m
   where m.conversation_id in (select id from fils)
     and m.direction = 'out' and m.origin in ('scenario', 'ia', 'mba')
     and ($3::timestamptz is null or m.created_at >= $3) and m.created_at <= $4
     and ($9::text is null or m.template_name = $9)
     and (m.statut in ('delivered', 'read') or ($5 and m.statut is distinct from 'failed'))
  order by le desc`;

export class PgVentesStore {
  constructor(private readonly pool: Pool) {}

  /** Les touches du contact entre deux dates, la plus récente d'abord. */
  async touches(tenantId: string, contactId: string, depuis: Date, jusqua: Date, filiereApplication: boolean): Promise<Touche[]> {
    return this.lire(tenantId, contactId, depuis, jusqua, filiereApplication, null);
  }

  /** La dernière touche qui a envoyé ce modèle au contact, sans limite de date (la preuve par UTM). */
  async derniereToucheDuModele(tenantId: string, contactId: string, modele: string, jusqua: Date, filiereApplication: boolean): Promise<Touche | null> {
    return (await this.lire(tenantId, contactId, null, jusqua, filiereApplication, modele))[0] ?? null;
  }

  /** La relance PARTIE d'un panier (`issue = 'envoye'`), ou `null` : pas relancé, relance refusée, panier inconnu ou purgé. */
  async panierRelance(tenantId: string, jeton: string): Promise<{ relanceLe: Date } | null> {
    const res = await this.pool.query<{ relance_le: Date }>(
      `select relance_le from shopify_paniers where tenant_id = $1 and jeton = $2 and relance_le is not null and issue = 'envoye'`,
      [tenantId, jeton],
    );
    return res.rows[0] ? { relanceLe: res.rows[0].relance_le } : null;
  }

  /** Fige une vente. `deja` : la commande est déjà là (Shopify réessaie `orders/paid`). */
  async enregistrer(tenantId: string, v: VenteAEnregistrer): Promise<'enregistree' | 'deja'> {
    const res = await this.pool.query(
      `insert into ventes_attribuees
         (tenant_id, commande_id, contact_id, montant, devise, payee_le, source, campaign_id, preuve, relance_le, test)
       values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $11)
       on conflict (tenant_id, commande_id) where commande_id is not null do nothing`,
      [tenantId, v.commandeId, v.contactId, v.montant, v.devise, v.payeeLe, v.source, v.campaignId, v.preuve, v.relanceLe, v.test],
    );
    return (res.rowCount ?? 0) > 0 ? 'enregistree' : 'deja';
  }

  /**
   * La preuve par UTM, relue après coup (`src/shopify/preuve-utm.ts`) : la vente de la commande prend sa source prouvée,
   * sauf si son panier relancé la prouve déjà (la preuve `panier` ne se remplace jamais) ; absente (aucune touche dans la
   * fenêtre à la réception), elle se crée, mais seulement pour une fiche encore VIVANTE (une demande d'effacement arrivée
   * entre-temps ne doit pas recréer de lien vers la personne) et une boutique branchée AVANT le paiement (un rebranchement
   * suit un effacement qui a pu anonymiser la vente : la recréer la doublerait). Une seule instruction : l'instantané commun des CTE fait
   * que l'insertion ne voit pas la mise à jour, et n'insère que s'il n'existait aucune vente.
   */
  async appliquerPreuveUtm(tenantId: string, v: VenteAEnregistrer): Promise<'appliquee' | 'ignoree'> {
    const res = await this.pool.query<{ n: number }>(
      `with maj as (
         update ventes_attribuees set source = $7, campaign_id = $8, preuve = $9, relance_le = $10
          where tenant_id = $1 and commande_id = $2 and preuve is distinct from 'panier'
         returning 1
       ), ins as (
         insert into ventes_attribuees
           (tenant_id, commande_id, contact_id, montant, devise, payee_le, source, campaign_id, preuve, relance_le, test)
         select $1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $11
          where not exists (select 1 from ventes_attribuees where tenant_id = $1 and commande_id = $2)
            and exists (select 1 from contacts c where c.tenant_id = $1 and c.id = $3 and ${ficheActive('c')})
            -- Une boutique (re)branchée APRÈS le paiement : l'effacement d'avant a peut-être anonymisé la vente de cette
            -- commande, introuvable par son numéro ; la recréer la compterait deux fois (relecture du lot 6).
            and exists (select 1 from shopify_boutiques b where b.tenant_id = $1 and b.connectee_le <= $6)
         on conflict (tenant_id, commande_id) where commande_id is not null do nothing
         returning 1
       )
       select ((select count(*) from maj) + (select count(*) from ins))::int as n`,
      [tenantId, v.commandeId, v.contactId, v.montant, v.devise, v.payeeLe, v.source, v.campaignId, v.preuve, v.relanceLe, v.test],
    );
    return (res.rows[0]?.n ?? 0) > 0 ? 'appliquee' : 'ignoree';
  }

  /** `customers/redact` : ces commandes perdent leur numéro et leur contact ; le montant, la devise et la source restent. */
  async anonymiserCommandes(tenantId: string, commandeIds: readonly string[]): Promise<number> {
    if (commandeIds.length === 0) return 0;
    const res = await this.pool.query(
      `update ventes_attribuees set commande_id = null, contact_id = null where tenant_id = $1 and commande_id = any($2::text[])`,
      [tenantId, commandeIds],
    );
    return res.rowCount ?? 0;
  }

  private async lire(
    tenantId: string, contactId: string, depuis: Date | null, jusqua: Date, filiereApplication: boolean, modele: string | null,
  ): Promise<Touche[]> {
    const res = await this.pool.query<LigneTouche>(TOUCHES, [
      tenantId, contactId, depuis, jusqua, filiereApplication, LIGNE_RELANCE_PANIER, PREFIXE_LIGNE_SHOPIFY, PREFIXE_ENVOI_API, modele,
      PREFIXE_LIGNE_HUBSPOT,
    ]);
    return res.rows.map((r) => ({ source: r.source, le: r.le, campaignId: r.campaign_id, modele: r.modele, lanceScenario: r.lance_scenario }));
  }
}
