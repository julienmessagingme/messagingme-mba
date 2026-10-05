import type { Pool } from 'pg';

/**
 * La réserve de numéros fournis et les codes de vérification captés (migration 0210, lot 3a, spec
 * `docs/superpowers/specs/2026-10-05-pont-du-code-design.md`).
 *
 * ⚠️ AUCUN FILTRE PAR ESPACE, ET C'EST DÉLIBÉRÉ : la réserve est à nous, pas à un client. Ses deux lecteurs sont
 * transverses par nature, la session d'exploitation de /ops et la route du pont, que l'Asterisk appelle pour un numéro
 * et non pour un espace. Le jour où un client lira son numéro (lot 3b), ce sera par une lecture filtrée sur
 * `tenant_id`, à écrire à côté de celles-ci.
 */

/** Un code ne vaut que dix minutes ; la transcription sert au dépannage une semaine, puis le balayage l'efface. */
export const RETENTION_CODES_VERIFICATION_JOURS = 7;

export type StatutNumero = 'libre' | 'attribue' | 'resilie';

/** Pourquoi un appel n'a pas rendu de code : la transcription n'a pas abouti, ou aucun code certain n'y figure. */
export type CauseSansCode = 'transcription_indisponible' | 'code_introuvable';

export interface NumeroFourni {
  id: string;
  /** Chiffres seuls, au format `wa_id` (« 442071234567 »). */
  numero: string;
  didwwDidId: string;
  statut: StatutNumero;
  tenantId: string | null;
  attribueLe: Date | null;
  creeLe: Date;
}

export interface CodeCapte {
  appelId: string;
  recuLe: Date;
  /** `null` = aucun code certain : `cause` dit pourquoi. */
  code: string | null;
  transcription: string;
  cause: CauseSansCode | null;
}

export interface NumeroEtDernierCode extends NumeroFourni {
  dernierCode: CodeCapte | null;
}

/** Ce que l'appel a produit, écrit tel quel. Les deux formes sont celles du CHECK `codes_verification_cause_chk`. */
export type ResultatAppel =
  | { appelId: string; code: string; transcription: string }
  | { appelId: string; code: null; transcription: string; cause: CauseSansCode };

interface LigneNumero {
  id: string; numero: string; didww_did_id: string; statut: StatutNumero; tenant_id: string | null;
  attribue_le: Date | null; cree_le: Date;
}

const COLONNES_NUMERO = 'n.id, n.numero, n.didww_did_id, n.statut, n.tenant_id, n.attribue_le, n.cree_le';

function versNumero(l: LigneNumero): NumeroFourni {
  return {
    id: l.id, numero: l.numero, didwwDidId: l.didww_did_id, statut: l.statut, tenantId: l.tenant_id,
    attribueLe: l.attribue_le, creeLe: l.cree_le,
  };
}

/** Le numéro DIDWW est déjà déclaré sous un AUTRE numéro : une incohérence que la route rend en 409. */
export class DidDejaDeclare extends Error {
  constructor(readonly didwwDidId: string) {
    super(`le numéro DIDWW ${didwwDidId} est déjà déclaré sous un autre numéro`);
    this.name = 'DidDejaDeclare';
  }
}

export class PgNumerosFournisStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Inscrit un numéro `libre`. Déjà déclaré : rend la ligne existante, `cree: false`, sans rien réécrire (une
   * seconde déclaration ne remet jamais à `libre` un numéro attribué). Le même identifiant DIDWW sous un autre
   * numéro lève `DidDejaDeclare`.
   */
  async declarer(numero: string, didwwDidId: string): Promise<{ numero: NumeroFourni; cree: boolean }> {
    try {
      const ins = await this.pool.query<LigneNumero>(
        `insert into numeros_fournis as n (numero, didww_did_id) values ($1, $2)
           on conflict (numero) do nothing
         returning ${COLONNES_NUMERO}`,
        [numero, didwwDidId],
      );
      if (ins.rows[0]) return { numero: versNumero(ins.rows[0]), cree: true };
    } catch (err) {
      if ((err as { code?: unknown }).code === '23505') throw new DidDejaDeclare(didwwDidId);
      throw err;
    }
    const existant = await this.parNumero(numero);
    if (!existant) throw new Error(`numéro ${numero} introuvable juste après un conflit d’insertion`);
    return { numero: existant, cree: false };
  }

  async parNumero(numero: string): Promise<NumeroFourni | null> {
    const res = await this.pool.query<LigneNumero>(`select ${COLONNES_NUMERO} from numeros_fournis n where n.numero = $1`, [numero]);
    return res.rows[0] ? versNumero(res.rows[0]) : null;
  }

  /** La réserve entière, avec le dernier appel reçu par numéro, pour /ops. */
  async lister(): Promise<NumeroEtDernierCode[]> {
    const res = await this.pool.query<LigneNumero & {
      appel_id: string | null; recu_le: Date | null; code: string | null; transcription: string | null; cause: CauseSansCode | null;
    }>(
      `select ${COLONNES_NUMERO}, c.appel_id, c.recu_le, c.code, c.transcription, c.cause
         from numeros_fournis n
         left join lateral (
           select appel_id, recu_le, code, transcription, cause from codes_verification
            where numero_id = n.id order by recu_le desc limit 1
         ) c on true
        order by n.cree_le desc`,
    );
    return res.rows.map((l) => ({
      ...versNumero(l),
      dernierCode: l.appel_id === null || l.recu_le === null ? null : {
        appelId: l.appel_id, recuLe: l.recu_le, code: l.code, transcription: l.transcription ?? '', cause: l.cause,
      },
    }));
  }

  /**
   * Écrit l'appel. `false` = cet appel était déjà lu (le script a rejoué l'envoi) : rien n'est réécrit. SAUF une ligne
   * `transcription_indisponible` : une panne passagère du service ne doit pas perdre le code, et le rejeu de
   * l'enregistrement (que le script garde, la route ayant rendu 503) la remplace.
   */
  async ecrireCode(numeroId: string, r: ResultatAppel): Promise<boolean> {
    const res = await this.pool.query(
      `insert into codes_verification as c (numero_id, appel_id, code, transcription, cause) values ($1, $2, $3, $4, $5)
         on conflict (appel_id) do update
           set code = excluded.code, transcription = excluded.transcription, cause = excluded.cause, recu_le = now()
           where c.cause = 'transcription_indisponible'`,
      [numeroId, r.appelId, r.code, r.transcription, r.code === null ? r.cause : null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Cet appel a-t-il déjà été LU (un code, ou aucun code certain) ? Une transcription en panne ne compte pas. */
  async appelDejaLu(appelId: string): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from codes_verification where appel_id = $1 and cause is distinct from 'transcription_indisponible'`,
      [appelId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Les appels reçus sur ce numéro depuis `minutes` minutes : le plafond de la transcription, qui part sur notre clé. */
  async appelsRecents(numeroId: string, minutes: number): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `select count(*)::int as n from codes_verification where numero_id = $1 and recu_le > now() - make_interval(mins => $2::int)`,
      [numeroId, Math.max(1, Math.floor(minutes))],
    );
    return res.rows[0]?.n ?? 0;
  }

  /** Les appels de plus de `jours` jours : ils ne servent plus qu'au dépannage, et un code n'est valable que dix minutes. */
  async purgerAvant(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from codes_verification where recu_le < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
