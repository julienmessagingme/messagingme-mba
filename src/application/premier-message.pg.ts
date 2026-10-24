import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import type { IssueJobPremier, NouveauPremier, OriginePremier, PremierMessage, PremiersMessages, StatutPremier } from './premier-message';

/**
 * La file des premiers messages de la filière application, en base (migration 0252). Chaque requête porte son espace,
 * ou l'identifiant de la ligne qu'elle a réclamée, ou celui du compte.
 */

interface LignePremier {
  id: string; tenant_id: string; cle: string; wa_id: string; texte: string; origine: OriginePremier; reference: string | null;
  statut: StatutPremier; issue: IssueJobPremier | null; prevu_le: Date; essais: number; message_id: string | null;
}

const COLONNES = 'id, tenant_id, cle, wa_id, texte, origine, reference, statut, issue, prevu_le, essais, message_id';

function versPremier(l: LignePremier): PremierMessage {
  return {
    id: l.id, tenantId: l.tenant_id, cle: l.cle, waId: l.wa_id, texte: l.texte, origine: l.origine, reference: l.reference,
    statut: l.statut, issue: l.issue, prevuLe: l.prevu_le, essais: l.essais, messageId: l.message_id,
  };
}

/**
 * 🔴 LE CRÉNEAU D'UN ESPACE se réserve sous un verrou consultatif de l'espace, tenu jusqu'à la fin de la transaction :
 * deux demandes concurrentes lisent chacune le dernier prévu APRÈS l'insertion de l'autre, donc s'espacent. Le verrou
 * ne gêne que l'espace lui-même. L'instruction d'insertion suit le verrou : en lecture validée, elle voit la ligne que
 * la demande précédente a validée en le relâchant.
 */
const VERROU_ESPACE_SQL = `select pg_advisory_xact_lock(hashtext('premiers-messages:' || $1::text))`;

export class PgPremiersMessages implements PremiersMessages {
  constructor(private readonly pool: Pool) {}

  async existant(tenantId: string, cle: string): Promise<PremierMessage | null> {
    const r = await this.pool.query<LignePremier>(
      `select ${COLONNES} from application_premiers_messages where tenant_id = $1 and cle = $2`,
      [tenantId, cle],
    );
    return r.rows[0] ? versPremier(r.rows[0]) : null;
  }

  async inserer(m: NouveauPremier, aleatoire: number): Promise<{ ligne: PremierMessage; cree: boolean }> {
    return enTransaction(this.pool, async (client) => {
      await client.query(VERROU_ESPACE_SQL, [m.tenantId]);
      // `clock_timestamp()` et non `now()` : `now()` est l'instant du début de la transaction, avant l'attente du verrou.
      const r = await client.query<LignePremier>(
        `insert into application_premiers_messages (tenant_id, cle, wa_id, texte, origine, reference, prevu_le)
         values ($1, $2, $3, $4, $5, $6,
                 greatest(clock_timestamp(),
                          coalesce((select max(prevu_le) from application_premiers_messages where tenant_id = $1), clock_timestamp()))
                   + make_interval(secs => 30 + $7::float8 * 30))
         on conflict (tenant_id, cle) do nothing
         returning ${COLONNES}`,
        [m.tenantId, m.cle, m.waId, m.texte, m.origine, m.reference, aleatoire],
      );
      if (r.rows[0]) return { ligne: versPremier(r.rows[0]), cree: true };
      // La clé est déjà là (un rejeu concurrent) : la ligne existante, sans rien réserver.
      const deja = await client.query<LignePremier>(
        `select ${COLONNES} from application_premiers_messages where tenant_id = $1 and cle = $2`,
        [m.tenantId, m.cle],
      );
      return { ligne: versPremier(deja.rows[0]!), cree: false };
    });
  }

  async reclamer(id: string): Promise<PremierMessage | null> {
    // 🔴 UNE seule écriture gardée : deux jobs de la même ligne ne la réclament pas à deux.
    const r = await this.pool.query<LignePremier>(
      `update application_premiers_messages set statut = 'envoi', essais = essais + 1
        where id = $1 and statut = 'en_file'
        returning ${COLONNES}`,
      [id],
    );
    return r.rows[0] ? versPremier(r.rows[0]) : null;
  }

  async remettreEnFile(id: string, prevuLe: Date): Promise<void> {
    await this.pool.query(
      `update application_premiers_messages set statut = 'en_file', prevu_le = $2 where id = $1 and statut = 'envoi'`,
      [id, prevuLe],
    );
  }

  async terminer(id: string, statut: 'envoye' | 'abandonne', issue: IssueJobPremier, messageId: string | null): Promise<void> {
    await this.pool.query(
      `update application_premiers_messages
          set statut = $2, issue = $3, message_id = $4, envoye_le = case when $2 = 'envoye' then now() else null end
        where id = $1 and statut = 'envoi'`,
      [id, statut, issue, messageId],
    );
  }

  async geleJusqua(compteId: string): Promise<Date | null> {
    const r = await this.pool.query<{ premiers_geles_jusqu_au: Date | null }>(
      'select premiers_geles_jusqu_au from comptes_application where id = $1',
      [compteId],
    );
    return r.rows[0]?.premiers_geles_jusqu_au ?? null;
  }

  async geler(compteId: string, jusqua: Date): Promise<boolean> {
    // Un gel déjà actif n'est ni prolongé ni reposé : deux refus rapprochés ne font qu'un gel, donc un seul courriel.
    const r = await this.pool.query(
      `update comptes_application set premiers_geles_jusqu_au = $2
        where id = $1 and (premiers_geles_jusqu_au is null or premiers_geles_jusqu_au <= now())`,
      [compteId, jusqua],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async purgerTermines(jours: number): Promise<number> {
    // Tous les statuts : une ligne `en_file` ou `envoi` de cet âge ne partira plus (péremption de 24 h), et elle garde
    // le numéro et le texte d'un client.
    const r = await this.pool.query(
      `delete from application_premiers_messages where cree_le < now() - make_interval(days => $1)`,
      [jours],
    );
    return r.rowCount ?? 0;
  }
}
