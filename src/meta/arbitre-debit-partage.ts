import { setTimeout as dormir } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { PorteDeDebit } from './http';
import type { ArbitreDeDebit } from './arbitre-debit';
import { messageDe } from '../lib/erreur';

/**
 * ARBITRE DE DÉBIT PARTAGÉ ENTRE LES PROCESS (migration 0102).
 *
 * 🔴 Le problème qu'il ferme, et il existait DÉJÀ en production. L'arbitre en mémoire (`arbitre-debit.ts`)
 * donne bien une porte unique par numéro, mais une par PROCESS. L'API et le worker sont deux conteneurs :
 * un numéro avait donc deux budgets, et le pire cas était le double du plafond, atteint dès qu'un opérateur
 * répond depuis l'inbox pendant qu'une campagne tourne. Ce n'est pas un sujet de gros volume, c'est un
 * sujet de deux messages.
 *
 * Ce que fait celui-ci : le champ `nextAllowed` que le limiteur en mémoire gardait dans une variable devient
 * une LIGNE, et la réservation devient une instruction SQL atomique. Deux process qui réservent en même
 * temps se sérialisent sur le verrou de ligne, ce qui est exactement le comportement voulu. L'algorithme,
 * lui, ne change pas : chaque appelant réserve le créneau suivant et attend son tour.
 *
 * 🔴 L'ATTENTE SE FAIT HORS DE LA BASE. La réservation est une instruction, elle rend un nombre de
 * millisecondes, et le sommeil a lieu ensuite. Tenir une transaction ouverte pendant l'appel à Meta serait
 * la faute classique de ce genre de brique : on immobiliserait une connexion du pool pendant tout un
 * aller-retour réseau chez un tiers, pour tous les envois du numéro.
 *
 * 🔴 EN CAS DE PANNE DE LA BASE, ON RETOMBE SUR LA PORTE EN MÉMOIRE, jamais sur « laisser passer ». C'est ce
 * qui rend ce changement sûr : le pire comportement possible après cette migration est EXACTEMENT le
 * comportement d'avant, pas une absence de frein. Un envoi ne doit pas non plus échouer parce que la table
 * de débit est indisponible : le frein est une protection de qualité, pas une autorisation.
 *
 * ⚠️ Ce qu'il ne fait PAS. Il ne donne aucune PRIORITÉ : un envoi d'inbox et un envoi de campagne réservent
 * dans l'ordre où ils arrivent. Faire passer l'humain devant demanderait une file d'envoi ordonnée, donc un
 * autre modèle (et une latence de plus sur le chemin interactif). Le trou d'aujourd'hui est un trou de
 * COMPTAGE, pas d'ordonnancement : on le ferme sans changer le comportement de l'inbox.
 */

/** Ce dont l'arbitre a besoin, réduit au strict nécessaire (et donc simple à simuler dans un test). */
export interface DepsPorteDebit {
  /** Réserve le créneau suivant pour ce numéro, et rend l'attente à observer AVANT d'envoyer, en ms. */
  reserver(phoneNumberId: string, intervalleMs: number): Promise<number>;
  /** Le sommeil. Injecté pour que les tests n'attendent pas vraiment. */
  dormir(ms: number): Promise<void>;
  /** Signale une panne de la base de débit (repli sur la porte en mémoire). */
  signaler(err: unknown, phoneNumberId: string): void;
}

/**
 * La réservation, en SQL.
 *
 * `next_allowed_at` porte l'instant du prochain envoi autorisé. Réserver, c'est le POUSSER d'un intervalle
 * et repartir de `greatest(valeur, now())` : une ligne dont l'instant est dans le passé (numéro inactif)
 * repart de maintenant, sans accumuler de crédit. C'est le même calcul que le limiteur en mémoire.
 *
 * Le `RETURNING` retranche l'intervalle pour retrouver l'instant réservé PAR CET APPELANT, et le compare à
 * `now()`. Les deux `now()` sont dans la même instruction, donc la même valeur : le calcul est cohérent, et
 * il se fait sur l'horloge de Postgres. Deux conteneurs dont les horloges dérivent de quelques secondes
 * suffiraient sinon à laisser passer une rafale, et personne ne surveille l'heure d'un conteneur.
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

/** Au-delà de cette attente, on le DIT : une file d'envoi qui s'allonge doit se voir, pas se subir. */
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
 * Enveloppe un arbitre EN MÉMOIRE d'une réservation partagée.
 *
 * On garde l'arbitre local plutôt que de le remplacer, et ce n'est pas de la prudence décorative : c'est lui
 * le repli quand la base ne répond pas, et c'est ce qui garantit que le pire cas de cette migration est le
 * comportement d'avant.
 *
 * @param parMinute même réglage que l'arbitre local. `<= 0` = aucun frein, on rend l'arbitre local tel quel
 *   (qui est alors une porte ouverte) et on ne touche jamais la base.
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
            // 🔴 REPLI, jamais « laisser passer » : on redevient exactement l'arbitre d'avant.
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
