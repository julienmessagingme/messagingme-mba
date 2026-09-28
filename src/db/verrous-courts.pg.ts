import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { enTransaction } from './transaction';
import { normaliserCles, type CleDemandee, type Prise, type VerrousCourts } from './verrous-courts';

/** Levée dans la transaction d'une prise pour l'annuler : une clé au moins était tenue. */
class CleTenue extends Error {}

/**
 * Les verrous courts en base (`verrous_courts`, migration 0185), sur le modèle de `src/campaign/run-lock.ts`.
 * L'heure qui décide d'une échéance est celle de la base : toutes les copies lisent la même.
 */
export class PgVerrousCourts implements VerrousCourts {
  constructor(private readonly pool: Pool) {}

  async prendre(demandees: ReadonlyArray<CleDemandee>): Promise<Prise | null> {
    const cles = normaliserCles(demandees);
    const jeton = randomUUID();
    try {
      return await enTransaction(this.pool, async (client) => {
        /**
         * Une instruction par prise : une clé libre s'insère, une clé échue est reprise (`do update ... where`), une
         * clé tenue ne rend aucune ligne. Une prise simultanée de la même clé attend la nôtre sur l'index unique,
         * puis relit la ligne et la trouve tenue. `order by` fixe l'ordre des écritures : deux prises de clés
         * communes les prennent dans le même ordre et ne s'interbloquent pas.
         */
        const res = await client.query(
          `insert into verrous_courts (cle, jeton, expire_le)
           select c, $1, now() + make_interval(secs => d)
           from unnest($2::text[], $3::float8[]) as t(c, d)
           order by c
           on conflict (cle) do update set jeton = excluded.jeton, expire_le = excluded.expire_le
             where verrous_courts.expire_le <= now()
           returning cle`,
          [jeton, cles.map(([c]) => c), cles.map(([, ms]) => ms / 1000)],
        );
        // Toutes ou aucune : lever annule aussi les clés déjà écrites par cette prise.
        if ((res.rowCount ?? 0) < cles.length) throw new CleTenue();
        return { jeton, cles: cles.map(([c]) => c) };
      });
    } catch (err) {
      if (err instanceof CleTenue) return null;
      throw err;
    }
  }

  async relacher(prise: Prise): Promise<void> {
    // Le jeton dans la clause : une clé échue puis reprise par une autre copie porte SON jeton, pas le nôtre.
    await this.pool.query(
      `delete from verrous_courts where cle = any($1::text[]) and jeton = $2`,
      [prise.cles, prise.jeton],
    );
  }

  /**
   * Efface les clés échues (rétention générale du worker). Une clé échue ne garde plus rien, la prise suivante la
   * reprendrait de toute façon : l'effacer ne change aucune décision, cela borne seulement la table, où l'anti-rejeu
   * écrit une clé par message de client.
   */
  async purgerEchues(): Promise<number> {
    const res = await this.pool.query(`delete from verrous_courts where expire_le <= now()`);
    return res.rowCount ?? 0;
  }
}
