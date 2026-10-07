import type { Pool } from 'pg';
import { LimiteOffreError } from './refus';

/** Les limites de membres d'une offre (`droits.limites`) : `null` = sans limite. */
export interface LimitesMembres {
  utilisateurs: number | null;
  admins: number | null;
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
