import type { Pool } from 'pg';
import { MAX_LIGNES_CSP, type RapportCsp } from './rapports';

/**
 * Les rapports CSP agrégés (`csp_rapports`, migration 0236) : une ligne par règle, origine bloquée, page et disposition.
 *
 * 🔴 LA TABLE EST BORNÉE PAR L'INSERTION ELLE-MÊME. Une combinaison neuve n'entre que sous `maxLignes` ; une combinaison
 * déjà vue compte toujours. Un faux rapport en rafale ne la fait donc pas grossir, mais il PEUT la remplir de bruit
 * jusqu'à la borne, après quoi une vraie combinaison neuve n'entre plus : une table pleine se lit comme suspecte
 * (`documentation.md`, la CSP de la console). Sous concurrence, la borne peut être dépassée de quelques lignes.
 */
export class PgCspRapportsStore {
  constructor(private readonly pool: Pool, private readonly maxLignes = MAX_LIGNES_CSP) {}

  async noter(r: RapportCsp): Promise<void> {
    await this.pool.query(
      `insert into csp_rapports (directive, bloque, page, disposition)
       select $1::text, $2::text, $3::text, $4::text
        where (select count(*) from csp_rapports) < $5::int
           or exists (
             select 1 from csp_rapports
              where directive = $1::text and bloque = $2::text and page = $3::text and disposition = $4::text
           )
       on conflict (directive, bloque, page, disposition)
       do update set compte = csp_rapports.compte + 1, dernier_vu = now()`,
      [r.directive, r.bloque, r.page, r.disposition, this.maxLignes],
    );
  }
}
