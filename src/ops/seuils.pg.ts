import type { Pool } from 'pg';
import { seuilsEnregistres, SEUILS_DEFAUT, type SeuilsCapacite } from './seuils';
import type { EtatBrique } from './sante';

/**
 * Les seuils de capacité et l'historique des alertes de Santé (migration 0262). Les seuils se relisent signal par signal
 * (`seuilsEnregistres`) : une ligne absente ou abîmée rend les défauts, jamais une exception.
 */

/** Ce que l'historique des alertes garde : trente jours, comme les courbes. */
export const RETENTION_ALERTES_JOURS = 30;

export interface SeuilsLus {
  seuils: SeuilsCapacite;
  /** `null` : jamais réglés, ce sont les défauts. */
  modifieLe: string | null;
  modifiePar: string | null;
}

export interface AlerteCapacite {
  signal: string;
  etat: EtatBrique;
  mesure: number | null;
  envoyeLe: string;
}

export class PgSeuilsStore {
  constructor(private readonly pool: Pool) {}

  async lire(): Promise<SeuilsLus> {
    const res = await this.pool.query<{ valeurs: unknown; modifie_le: Date; modifie_par: string }>(
      `select valeurs, modifie_le, modifie_par from seuils_capacite where id`,
    );
    const ligne = res.rows[0];
    if (!ligne) return { seuils: SEUILS_DEFAUT, modifieLe: null, modifiePar: null };
    return { seuils: seuilsEnregistres(ligne.valeurs), modifieLe: ligne.modifie_le.toISOString(), modifiePar: ligne.modifie_par };
  }

  /**
   * `seuils` déjà validés (`valideSeuils`) ; `par` = la note signée de son auteur, comme la grille de prix. Rend l'auteur
   * et l'heure enregistrés : l'écran les affiche sans relire. Le plafond couvre l'adresse plus la note (500) : la note
   * n'est jamais coupée.
   */
  async ecrire(seuils: SeuilsCapacite, par: string): Promise<{ modifieLe: string; modifiePar: string }> {
    const res = await this.pool.query<{ modifie_le: Date; modifie_par: string }>(
      `insert into seuils_capacite (id, valeurs, modifie_le, modifie_par) values (true, $1::jsonb, now(), $2)
       on conflict (id) do update set valeurs = excluded.valeurs, modifie_le = now(), modifie_par = excluded.modifie_par
       returning modifie_le, modifie_par`,
      [JSON.stringify(seuils), par.slice(0, 1000)],
    );
    const ligne = res.rows[0]!;
    return { modifieLe: ligne.modifie_le.toISOString(), modifiePar: ligne.modifie_par };
  }

  /** La dernière alerte de chaque signal : elle dit l'état que Telegram connaît. */
  async dernieresAlertes(): Promise<Map<string, AlerteCapacite>> {
    const res = await this.pool.query<{ signal: string; etat: EtatBrique; mesure: number | null; envoye_le: Date }>(
      `select distinct on (signal) signal, etat, mesure, envoye_le
         from alertes_capacite
        order by signal, envoye_le desc`,
    );
    return new Map(res.rows.map((r) => [r.signal, { signal: r.signal, etat: r.etat, mesure: r.mesure, envoyeLe: r.envoye_le.toISOString() }]));
  }

  async noterAlerte(signal: string, etat: EtatBrique, mesure: number | null): Promise<void> {
    await this.pool.query(
      `insert into alertes_capacite (signal, etat, mesure) values ($1, $2, $3)`,
      [signal, etat, mesure === null || !Number.isFinite(mesure) ? null : mesure],
    );
  }

  /** Les alertes des `heures` dernières heures, les plus récentes d'abord. */
  async alertesDepuis(heures: number): Promise<AlerteCapacite[]> {
    const res = await this.pool.query<{ signal: string; etat: EtatBrique; mesure: number | null; envoye_le: Date }>(
      `select signal, etat, mesure, envoye_le from alertes_capacite
        where envoye_le > now() - make_interval(hours => $1::int)
        order by envoye_le desc limit 50`,
      [Math.max(1, Math.min(Math.floor(heures), 24 * 30))],
    );
    return res.rows.map((r) => ({ signal: r.signal, etat: r.etat, mesure: r.mesure, envoyeLe: r.envoye_le.toISOString() }));
  }

  async purgeAlertes(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from alertes_capacite where envoye_le < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
