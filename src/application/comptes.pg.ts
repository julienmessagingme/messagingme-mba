import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { numeroNormalise, type CompteApplication, type ComptesApplication, type Filiere, type RefusPreparation, type StatutCompte } from './comptes';

/** Les comptes de la filière application, en base (migration 0247). Chaque requête porte son espace ou son compte. */

interface LigneCompte {
  id: string; tenant_id: string; numero: string; jid: string | null; statut: StatutCompte; fourni_id: string | null;
  relie_le: Date | null; dernier_message_le: Date | null; statut_change_le: Date;
}

const COLONNES = 'id, tenant_id, numero, jid, statut, fourni_id, relie_le, dernier_message_le, statut_change_le';

function versCompte(l: LigneCompte): CompteApplication {
  return {
    id: l.id, tenantId: l.tenant_id, numero: l.numero, jid: l.jid, statut: l.statut, fourniId: l.fourni_id,
    relieLe: l.relie_le, dernierMessageLe: l.dernier_message_le, statutChangeLe: l.statut_change_le,
  };
}

const codeDe = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;

/** Un numéro de l'API encore relié (`delie_le` nul) : l'espace est dans la filière API. */
const API_RELIEE_SQL = 'select 1 from phone_numbers where tenant_id = $1 and delie_le is null';

export class PgComptesApplication implements ComptesApplication {
  constructor(private readonly pool: Pool) {}

  async preparer(tenantId: string, entree: { numero: string; fourniId: string | null }): Promise<{ ok: true; compte: CompteApplication } | { ok: false; raison: RefusPreparation }> {
    const numero = numeroNormalise(entree.numero);
    if (!numero) return { ok: false, raison: 'numero_invalide' };
    try {
      return await enTransaction(this.pool, async (client) => {
        if ((await client.query(API_RELIEE_SQL, [tenantId])).rowCount) return { ok: false as const, raison: 'filiere_api' as const };
        const avant = await client.query<{ statut: StatutCompte }>('select statut from comptes_application where tenant_id = $1 for update', [tenantId]);
        if (avant.rows[0]?.statut === 'relie') return { ok: false as const, raison: 'deja_relie' as const };
        const r = await client.query<LigneCompte>(
          `insert into comptes_application (tenant_id, numero, fourni_id) values ($1, $2, $3)
             on conflict (tenant_id) do update
               set numero = excluded.numero, fourni_id = excluded.fourni_id, statut = 'en_attente', jid = null,
                   relie_le = null, dernier_message_le = null, statut_change_le = now()
           returning ${COLONNES}`,
          [tenantId, numero, entree.fourniId],
        );
        const compte = versCompte(r.rows[0]!);
        // Une session neuve : l'état d'une liaison précédente ne doit pas la rouvrir sous l'ancienne identité.
        await client.query('delete from comptes_application_auth where compte_id = $1', [compte.id]);
        return { ok: true as const, compte };
      });
    } catch (err) {
      // L'index unique partiel : le numéro est tenu par le compte vivant d'un autre espace.
      if (codeDe(err) === '23505') return { ok: false, raison: 'numero_pris' };
      throw err;
    }
  }

  async parEspace(tenantId: string): Promise<CompteApplication | null> {
    const r = await this.pool.query<LigneCompte>(`select ${COLONNES} from comptes_application where tenant_id = $1`, [tenantId]);
    return r.rows[0] ? versCompte(r.rows[0]) : null;
  }

  async parId(id: string): Promise<CompteApplication | null> {
    const r = await this.pool.query<LigneCompte>(`select ${COLONNES} from comptes_application where id = $1`, [id]);
    return r.rows[0] ? versCompte(r.rows[0]) : null;
  }

  async relies(): Promise<CompteApplication[]> {
    const r = await this.pool.query<LigneCompte>(`select ${COLONNES} from comptes_application where statut = 'relie' order by relie_le`);
    return r.rows.map(versCompte);
  }

  async endormables(jours: number): Promise<CompteApplication[]> {
    // Sans message depuis la liaison, c'est la liaison qui compte : un compte relié et resté muet s'endort aussi.
    const r = await this.pool.query<LigneCompte>(
      `select ${COLONNES} from comptes_application
        where statut = 'relie' and coalesce(dernier_message_le, relie_le, statut_change_le) < now() - make_interval(days => $1)`,
      [jours],
    );
    return r.rows.map(versCompte);
  }

  async marquer(id: string, statut: StatutCompte, extra: { jid?: string } = {}): Promise<void> {
    await this.pool.query(
      `update comptes_application
          set statut = $2, statut_change_le = now(),
              relie_le = case when $2 = 'relie' then coalesce(relie_le, now()) else relie_le end,
              jid = coalesce($3, jid)
        where id = $1`,
      [id, statut, extra.jid ?? null],
    );
  }

  async toucher(id: string, quand: Date): Promise<void> {
    await this.pool.query(
      `update comptes_application set dernier_message_le = greatest(coalesce(dernier_message_le, $2), $2) where id = $1`,
      [id, quand],
    );
  }

  async filiereDe(tenantId: string): Promise<Filiere | null> {
    const r = await this.pool.query<{ app: boolean; api: boolean }>(
      `select exists (select 1 from comptes_application where tenant_id = $1 and statut <> 'retire') as app,
              exists (${API_RELIEE_SQL}) as api`,
      [tenantId],
    );
    const l = r.rows[0];
    return l?.app ? 'application' : l?.api ? 'api' : null;
  }
}
