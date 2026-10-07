import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { droitsDe, type Droits, type Offre } from './offres';

/**
 * L'OFFRE D'UN ESPACE (lot 6, spec `docs/superpowers/specs/2026-10-07-offres-et-limites-design.md`, § 3).
 *
 * 🔴 UNE SEULE DÉFINITION, EN SQL : `offre_de_l_espace` (migration 0218). Ce store la lit, les balayages qui dépendent
 * de l'offre (l'analyse, la purge des conversations) l'appellent dans leur requête. Une seconde définition en TypeScript
 * finirait par diverger de celle des balayages. La lecture passe par `OffresEnCache` (`src/offres/cache.ts`).
 */
export interface OffreEspace {
  offre: Offre;
  droits: Droits;
  /** La fin effective du dernier Pro d'un espace revenu en Base (le gel, le délai de la conservation) ; `null` sinon. */
  retourEnBaseLe: Date | null;
}

export interface SourceOffres {
  offreDe(tenantId: string): Promise<OffreEspace>;
}

const OFFRES: ReadonlySet<string> = new Set<Offre>(['base', 'pro', 'entreprise']);

export class PgOffresStore implements SourceOffres {
  constructor(private readonly pool: Pool) {}

  /** Un espace inconnu est en Base : la fonction SQL le dit aussi. */
  async offreDe(tenantId: string): Promise<OffreEspace> {
    const r = await this.pool.query<{ offre: string; entreprise_utilisateurs: number | null; conservation: number | null; dernier_fini: Date | null }>(
      `select offre_de_l_espace($1::uuid) as offre,
              (select t.entreprise_utilisateurs from tenants t where t.id = $1::uuid) as entreprise_utilisateurs,
              (select s.conversation_retention_days from tenant_settings s where s.tenant_id = $1::uuid) as conservation,
              (select max(a.fini_le) from abonnements_offre a where a.tenant_id = $1::uuid) as dernier_fini`,
      [tenantId],
    );
    const l = r.rows[0];
    const offre: Offre = l && OFFRES.has(l.offre) ? (l.offre as Offre) : 'base';
    return {
      offre,
      droits: droitsDe(offre, offre === 'entreprise'
        ? { utilisateurs: l?.entreprise_utilisateurs ?? null, conservationJours: l?.conservation ?? null }
        : null),
      retourEnBaseLe: offre === 'base' ? (l?.dernier_fini ?? null) : null,
    };
  }

  /**
   * Ce que l'espace a consommé de ses limites, en une requête : les fiches créées actives (pas nées d'un entrant), les
   * automations allumées du client (aucun propriétaire), les membres actifs (invitations en attente comprises). Les mêmes
   * comptes que les gardes (`PgContactStore.verifierPlaceContacts`, `src/offres/automations.ts`, `src/offres/membres.ts`).
   */
  async usage(tenantId: string): Promise<{ contacts: number; automations: number; membres: number }> {
    const r = await this.pool.query<{ contacts: number; automations: number; membres: number }>(
      `select (select count(*) from contacts c
                where c.tenant_id = $1 and not c.ne_entrant and c.deleted_at is null and c.anonymized_at is null)::int as contacts,
              (select count(*) from automations a where a.tenant_id = $1 and a.enabled and a.possede_par is null)::int as automations,
              (select count(*) from users u where u.tenant_id = $1 and u.disabled_at is null)::int as membres`,
      [tenantId],
    );
    return r.rows[0] ?? { contacts: 0, automations: 0, membres: 0 };
  }

  /** L'Entreprise d'un espace telle que l'exploitation l'a posée, `null` pour un espace inconnu. */
  async lireEntreprise(tenantId: string): Promise<ReglageEntreprise | null> {
    const r = await this.pool.query<{ offre_entreprise: boolean; entreprise_utilisateurs: number | null; conversation_retention_days: number | null }>(
      `select t.offre_entreprise, t.entreprise_utilisateurs, s.conversation_retention_days
         from tenants t left join tenant_settings s on s.tenant_id = t.id
        where t.id = $1`,
      [tenantId],
    );
    const l = r.rows[0];
    return l ? { entreprise: l.offre_entreprise, utilisateurs: l.entreprise_utilisateurs, conservationJours: l.conversation_retention_days } : null;
  }

  /**
   * Pose ou retire l'Entreprise, sa limite d'utilisateurs et sa conservation (lot 6, `/ops`), en une transaction. La
   * conservation (`tenant_settings.conversation_retention_days`) s'écrit par un upsert ciblé, qui ne touche aucun autre
   * réglage, et SEULEMENT si elle est donnée : changer d'offre ne doit jamais déclencher une purge. `false` pour un espace
   * inconnu, sans rien écrire.
   */
  async ecrireEntreprise(tenantId: string, r: EcritureEntreprise): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      const maj = await client.query(
        `update tenants set offre_entreprise = $2, entreprise_utilisateurs = $3 where id = $1`,
        [tenantId, r.entreprise, r.utilisateurs],
      );
      if ((maj.rowCount ?? 0) === 0) return false;
      if (r.conservationJours === undefined) return true;
      await client.query(
        `insert into tenant_settings (tenant_id, conversation_retention_days, updated_at) values ($1, $2, now())
         on conflict (tenant_id) do update set conversation_retention_days = excluded.conversation_retention_days, updated_at = now()`,
        [tenantId, r.conservationJours],
      );
      return true;
    });
  }
}

/**
 * Ce que l'exploitation ÉCRIT : la conservation ABSENTE est laissée telle quelle (relecture finale du lot 6). `null` = sans
 * limite pour les utilisateurs, le défaut de l'instance pour la conservation.
 */
export interface EcritureEntreprise {
  entreprise: boolean;
  utilisateurs: number | null;
  conservationJours?: number | null;
}

/** Ce que l'exploitation règle sur un espace (`/ops/offre/:tenantId`). `null` = sans limite, ou le défaut de l'instance. */
export interface ReglageEntreprise {
  entreprise: boolean;
  utilisateurs: number | null;
  conservationJours: number | null;
}
