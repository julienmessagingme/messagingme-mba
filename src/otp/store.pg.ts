import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../db/transaction';

/**
 * La réserve de numéros fournis et les codes de vérification captés (migration 0210, lot 3a, spec
 * `docs/superpowers/specs/2026-10-05-pont-du-code-design.md`).
 *
 * ⚠️ LA RÉSERVE EST À NOUS, PAS À UN CLIENT : `declarer`, `lister`, `ecrireCode` et la suite ne filtrent sur aucun
 * espace, délibérément (la session d'exploitation de /ops et la route du pont, que l'Asterisk appelle pour un numéro
 * et non pour un espace). Ce qu'un CLIENT lit ou écrit (lot 3b : `attribuer`, `numeroDeLEspace`, `codeDeLEspace`,
 * `remplacerNumero`, `rendre`) est filtré sur `tenant_id`, sans exception.
 */

/** Un code ne vaut que dix minutes ; la transcription sert au dépannage une semaine, puis le balayage l'efface. */
export const RETENTION_CODES_VERIFICATION_JOURS = 7;

/** `bloque` (0212) : refusé par Meta (déjà actif ailleurs), sorti de la réserve sans être résilié chez DIDWW. */
export type StatutNumero = 'libre' | 'attribue' | 'resilie' | 'bloque';

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

/** Un code d'un espace ne vaut que le temps de le recopier dans la fenêtre de Meta (lot 3b). */
export const VALIDITE_CODE_ESPACE_MINUTES = 15;

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

  /**
   * Les appels de plus de `jours` jours : ils ne servent plus qu'au dépannage, et un code n'est valable que dix minutes.
   * 🔴 SAUF ceux d'un numéro encore ATTRIBUÉ : un code capté prouve que Meta a vu ce numéro, et la libération (lot 4,
   * livraison B), qui arrive au plus tôt 7 jours après la fin de l'abonnement, s'en sert pour le résilier plutôt que le
   * remettre en réserve (rouge 2 de la relecture de B). Ils partent à la purge suivant la sortie du numéro.
   */
  async purgerAvant(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from codes_verification
        where recu_le < now() - make_interval(days => $1::int)
          and numero_id not in (select id from numeros_fournis where statut = 'attribue')`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }

  // ----- Le numéro fourni côté client (lot 3b, migration 0212) : TOUT est filtré sur l'espace -----

  /** Le numéro attribué à cet espace, `null` s'il n'en a pas. */
  async numeroDeLEspace(tenantId: string): Promise<NumeroFourni | null> {
    return lireAttribue(this.pool, tenantId);
  }

  /**
   * Donne un numéro libre à l'espace, ou rend celui qu'il a déjà ; `null` = la réserve est vide. Une seule instruction
   * pose ensemble le statut, l'espace et l'heure (sans quoi `numeros_fournis_espace_chk` refuse), sur une ligne prise
   * en `for update skip locked` : deux espaces qui se disputent le dernier numéro n'en reçoivent pas deux. Deux
   * demandes du MÊME espace : l'index `numeros_fournis_un_par_espace` fait échouer la seconde (23505), qui relit la
   * première.
   */
  async attribuer(tenantId: string): Promise<NumeroFourni | null> {
    try {
      return await attribuerAvec(this.pool, tenantId);
    } catch (err) {
      if ((err as { code?: unknown }).code !== '23505') throw err;
      return lireAttribue(this.pool, tenantId);
    }
  }

  /**
   * Le dernier code CERTAIN capté sur le numéro de cet espace, reçu après l'attribution et dans les
   * `VALIDITE_CODE_ESPACE_MINUTES` dernières minutes. Jamais la transcription, jamais le code d'un autre espace.
   */
  async codeDeLEspace(tenantId: string): Promise<{ code: string; recuLe: Date } | null> {
    const res = await this.pool.query<{ code: string; recu_le: Date }>(
      `select c.code, c.recu_le
         from codes_verification c join numeros_fournis n on n.id = c.numero_id
        where n.tenant_id = $1 and n.statut = 'attribue' and c.code is not null
          and c.recu_le >= n.attribue_le and c.recu_le > now() - make_interval(mins => $2::int)
        order by c.recu_le desc limit 1`,
      [tenantId, VALIDITE_CODE_ESPACE_MINUTES],
    );
    const l = res.rows[0];
    return l ? { code: l.code, recuLe: l.recu_le } : null;
  }

  /**
   * Meta refuse le numéro de cet espace (déjà actif sur WhatsApp ailleurs) : il passe en `bloque`, sans espace, et un
   * autre est attribué, dans la même transaction. `bloque` = le numéro sorti (`null` si l'espace n'en avait pas),
   * `nouveau` = le suivant (`null` si la réserve est vide).
   */
  async remplacerNumero(tenantId: string): Promise<{ bloque: string | null; nouveau: NumeroFourni | null }> {
    try {
      return await this.remplacerDansUneTransaction(tenantId);
    } catch (err) {
      // Une attribution concurrente du même espace (« Obtenir » et « Remplacer » en même temps) : la transaction est
      // annulée, rien n'a été bloqué, et l'attribution qui a gagné est relue.
      if ((err as { code?: unknown }).code !== '23505') throw err;
      return { bloque: null, nouveau: await lireAttribue(this.pool, tenantId) };
    }
  }

  private async remplacerDansUneTransaction(tenantId: string): Promise<{ bloque: string | null; nouveau: NumeroFourni | null }> {
    return enTransaction(this.pool, async (client) => {
      const b = await client.query<{ numero: string }>(
        `update numeros_fournis set statut = 'bloque', tenant_id = null
          where tenant_id = $1 and statut = 'attribue' returning numero`,
        [tenantId],
      );
      return { bloque: b.rows[0]?.numero ?? null, nouveau: await attribuerAvec(client, tenantId) };
    });
  }

  /** Rend le numéro de cet espace à la réserve ; rend le numéro rendu, `null` s'il n'y en avait pas. */
  async rendre(tenantId: string): Promise<string | null> {
    const res = await this.pool.query<{ numero: string }>(
      `update numeros_fournis set statut = 'libre', tenant_id = null, attribue_le = null
        where tenant_id = $1 and statut = 'attribue' returning numero`,
      [tenantId],
    );
    return res.rows[0]?.numero ?? null;
  }

  /** Les numéros encore libres : l'alerte de réserve basse. */
  async compterLibres(): Promise<number> {
    const res = await this.pool.query<{ n: number }>(`select count(*)::int as n from numeros_fournis where statut = 'libre'`);
    return res.rows[0]?.n ?? 0;
  }
}

async function lireAttribue(db: Pool | PoolClient, tenantId: string): Promise<NumeroFourni | null> {
  const res = await db.query<LigneNumero>(
    `select ${COLONNES_NUMERO} from numeros_fournis n where n.tenant_id = $1 and n.statut = 'attribue'`,
    [tenantId],
  );
  return res.rows[0] ? versNumero(res.rows[0]) : null;
}

/** L'attribution en une instruction : l'existant de l'espace, sinon le plus ancien numéro libre, pris sans attendre. */
/**
 * L'attribution, sur une connexion donnée : `attribuer` la prend sur le pool, l'abonnement du numéro (lot 3c,
 * `src/stripe/abonnements.pg.ts`) DANS la transaction qui enregistre le paiement, pour qu'un abonnement payé ait
 * son numéro ou qu'aucun des deux ne soit écrit.
 */
export async function attribuerAvec(db: Pool | PoolClient, tenantId: string): Promise<NumeroFourni | null> {
  const existant = await lireAttribue(db, tenantId);
  if (existant) return existant;
  const res = await db.query<LigneNumero>(
    `update numeros_fournis n set statut = 'attribue', tenant_id = $1, attribue_le = now()
      where n.id = (select id from numeros_fournis where statut = 'libre' order by cree_le, id limit 1 for update skip locked)
     returning ${COLONNES_NUMERO}`,
    [tenantId],
  );
  return res.rows[0] ? versNumero(res.rows[0]) : null;
}
