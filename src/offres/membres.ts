import type { Pool } from 'pg';
import { LimiteOffreError } from './refus';
import type { SourceOffres } from './offre.pg';

/** Les limites de membres d'une offre (`droits.limites`) : `null` = sans limite. */
export interface LimitesMembres {
  utilisateurs: number | null;
  admins: number | null;
}

/**
 * Le rang d'un membre actif dans son espace (`PgUserStore.rangMembre`) : ce qu'il faut pour savoir s'il tient dans
 * l'offre. `adminsAvant` et `autresAvant` : les membres actifs du même genre créés avant lui ; `admins` : tous les
 * administrateurs actifs.
 */
export interface RangMembre {
  estAdmin: boolean;
  adminsAvant: number;
  autresAvant: number;
  admins: number;
}

/**
 * 🔴 LES MEMBRES EN TROP AU RETOUR EN BASE (lot 6, livraison B2a, spec § 7) : la limite que ce membre dépasse, `null`
 * s'il tient. L'ordre qui fait foi : les administrateurs d'abord, du plus ancien au plus récent, dans la limite
 * d'administrateurs (le plus ancien garde toujours l'accès) ; puis les autres membres, du plus ancien au plus récent,
 * jusqu'à la limite d'utilisateurs. Un administrateur au-delà de sa limite ne prend pas la place d'un autre membre.
 */
export function limiteDepassee(r: RangMembre, l: LimitesMembres): 'utilisateurs' | 'admins' | null {
  if (r.estAdmin) {
    if (l.admins !== null && r.adminsAvant >= l.admins) return 'admins';
    if (l.utilisateurs !== null && r.adminsAvant >= l.utilisateurs) return 'utilisateurs';
    return null;
  }
  const adminsGardes = l.admins === null ? r.admins : Math.min(r.admins, l.admins);
  if (l.utilisateurs !== null && adminsGardes + r.autresAvant >= l.utilisateurs) return 'utilisateurs';
  return null;
}

/** Un membre au-delà de l'offre : la limite dépassée et son maximum, pour le refus 402 (`corpsRefusLimite`). */
export interface HorsOffreMembre {
  limite: 'utilisateurs' | 'admins';
  max: number;
}

/** La question que posent la garde des sessions et celle des jetons de Claude, au même endroit. */
export interface GelMembres {
  horsOffre(tenantId: string, userId: string): Promise<HorsOffreMembre | null>;
}

/**
 * Le gel des membres, sur l'offre en cache : le rang n'est lu que pour un espace limité (Base, Pro), une seule requête
 * de plus par appel de ces espaces. Un membre introuvable n'est pas gelé ici : la garde le refuse déjà (session révoquée).
 * 🔴 En Entreprise, jamais (décision de Julien du 2026-10-07) : une limite posée depuis `/ops` est un contrat négocié,
 * elle ne bloque que les invitations (`verifierPlaceMembre`) et ne coupe personne sur un chiffre tapé.
 */
export function creerGelMembres(d: {
  offres: SourceOffres;
  rang(tenantId: string, userId: string): Promise<RangMembre | null>;
}): GelMembres {
  return {
    async horsOffre(tenantId, userId) {
      const { offre, droits } = await d.offres.offreDe(tenantId);
      if (offre === 'entreprise') return null;
      const { limites } = droits;
      const l: LimitesMembres = { utilisateurs: limites.utilisateurs, admins: limites.admins };
      if (l.utilisateurs === null && l.admins === null) return null;
      const r = await d.rang(tenantId, userId);
      if (r === null) return null;
      const limite = limiteDepassee(r, l);
      const max = limite === null ? null : l[limite];
      return limite === null || max === null ? null : { limite, max };
    },
  };
}

/**
 * LA LIMITE DE MEMBRES DE L'OFFRE (lot 6, spec § 4) : les comptes actifs de l'espace, invitations en attente comprises (un
 * invité qui ne s'est pas encore connecté occupe sa place), et les administrateurs à part. Vérifiée à l'invitation, au
 * passage en administrateur et à la réactivation d'un compte (`PgUserStore`).
 *
 * ⚠️ Lecture puis écriture, sans verrou : deux invitations simultanées à la dernière place peuvent passer toutes les deux.
 */
export async function verifierPlaceMembre(
  q: Pick<Pool, 'query'>,
  tenantId: string,
  limites: LimitesMembres,
  /** Le rôle que le compte aura : un administrateur compte aussi dans la limite des administrateurs. */
  role: string,
  /** Le compte qu'on modifie : il ne se compte pas lui-même. */
  exclure: string | null,
): Promise<void> {
  if (limites.utilisateurs === null && limites.admins === null) return;
  const r = await q.query<{ membres: number; admins: number }>(
    `select count(*)::int as membres, (count(*) filter (where role = 'admin'))::int as admins
       from users
      where tenant_id = $1 and disabled_at is null and ($2::uuid is null or id <> $2::uuid)`,
    [tenantId, exclure],
  );
  const { membres, admins } = r.rows[0] ?? { membres: 0, admins: 0 };
  if (limites.utilisateurs !== null && membres >= limites.utilisateurs) throw new LimiteOffreError(tenantId, 'utilisateurs', limites.utilisateurs);
  if (role === 'admin' && limites.admins !== null && admins >= limites.admins) throw new LimiteOffreError(tenantId, 'admins', limites.admins);
}
