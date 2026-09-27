import { setTimeout as dormir } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { PorteDeDebit } from './http';
import type { ArbitreDeDebit } from './arbitre-debit';
import { messageDe } from '../lib/erreur';

/**
 * Arbitre de débit partagé entre les process. L'arbitre en mémoire (`arbitre-debit.ts`) donne une porte par
 * numéro et par process ; ici, la réservation du créneau suivant devient une ligne et une instruction SQL
 * atomique, et deux process se sérialisent sur le verrou de ligne. L'algorithme ne change pas.
 *
 * L'attente se fait hors de la base : la réservation rend un délai en ms et le sommeil a lieu ensuite, pour ne
 * pas immobiliser une connexion du pool pendant un appel à Meta.
 *
 * En cas de panne de la base, on retombe sur la porte en mémoire, jamais sur « laisser passer », et l'envoi
 * n'échoue pas pour autant. Aucune priorité : inbox et campagne réservent dans l'ordre d'arrivée.
 */

/** Ce dont l'arbitre a besoin, réduit au strict nécessaire (et donc simple à simuler dans un test). */
export interface DepsPorteDebit {
  /** Réserve le créneau suivant pour ce numéro et rend l'attente à observer avant d'envoyer, en ms. */
  reserver(phoneNumberId: string, intervalleMs: number): Promise<number>;
  /** Le sommeil, injecté pour que les tests n'attendent pas. */
  dormir(ms: number): Promise<void>;
  /** Signale une panne de la base de débit (repli sur la porte en mémoire). */
  signaler(err: unknown, phoneNumberId: string): void;
}

/**
 * La réservation en SQL. Réserver pousse `next_allowed_at` d'un intervalle en repartant de
 * `greatest(valeur, now())` : un numéro inactif repart de maintenant, sans accumuler de crédit. Le `RETURNING`
 * compare l'instant réservé par cet appelant à `now()`, dans la même instruction, sur l'horloge de Postgres :
 * deux conteneurs aux horloges décalées laisseraient sinon passer une rafale.
 */
export const SQL_RESERVER = `
  with reserve as (
    insert into phone_rate_gate as g (phone_number_id, next_allowed_at, updated_at)
    values ($1, now() + make_interval(secs => $2::double precision), now())
    on conflict (phone_number_id) do update
      set next_allowed_at = greatest(g.next_allowed_at, now()) + make_interval(secs => $2::double precision),
          updated_at = now()
    returning next_allowed_at
  )
  select greatest(0, extract(epoch from (next_allowed_at - make_interval(secs => $2::double precision) - now())) * 1000)::bigint as attente_ms
  from reserve`;

/** Au-delà de cette attente, on le signale : une file d'envoi qui s'allonge doit se voir. */
export const ATTENTE_SIGNALEE_MS = 30_000;

export function depsPorteDebitPg(pool: Pool): DepsPorteDebit {
  return {
    async reserver(phoneNumberId, intervalleMs) {
      const res = await pool.query<{ attente_ms: string }>(SQL_RESERVER, [phoneNumberId, intervalleMs / 1000]);
      return Number(res.rows[0]?.attente_ms ?? 0);
    },
    dormir: (ms) => dormir(ms),
    signaler(err, phoneNumberId) {
      // eslint-disable-next-line no-console
      console.error(
        `debit partage indisponible pour le numero ${phoneNumberId}, repli sur le frein LOCAL de ce process `
        + `(le plafond redevient par process, comme avant la migration 0102) :`,
        messageDe(err),
      );
    },
  };
}

/**
 * Enveloppe un arbitre en mémoire d'une réservation partagée ; l'arbitre local reste le repli quand la base
 * ne répond pas.
 *
 * @param parMinute même réglage que l'arbitre local. `<= 0` = aucun frein : on rend l'arbitre local tel quel
 *   (une porte ouverte) sans jamais toucher la base.
 */
export function arbitreDeDebitPartage(
  local: ArbitreDeDebit,
  parMinute: number,
  deps: DepsPorteDebit,
): ArbitreDeDebit {
  if (parMinute <= 0) return local;
  const intervalleMs = Math.ceil(60_000 / parMinute);
  const portes = new Map<string, PorteDeDebit>();
  return {
    pour(phoneNumberId) {
      let porte = portes.get(phoneNumberId);
      if (porte) return porte;
      const secours = local.pour(phoneNumberId);
      porte = {
        async acquire() {
          let attente: number;
          try {
            attente = await deps.reserver(phoneNumberId, intervalleMs);
          } catch (err) {
            deps.signaler(err, phoneNumberId);
            // Repli, jamais « laisser passer » : on redevient l'arbitre local.
            await secours.acquire();
            return;
          }
          if (attente >= ATTENTE_SIGNALEE_MS) {
            // eslint-disable-next-line no-console
            console.warn(`debit du numero ${phoneNumberId} : ${Math.round(attente / 1000)} s d'attente avant l'envoi suivant`);
          }
          if (attente > 0) await deps.dormir(attente);
        },
      };
      portes.set(phoneNumberId, porte);
      return porte;
    },
  };
}
