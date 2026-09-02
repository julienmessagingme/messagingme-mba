/**
 * LE BAIL DU TOUR D'AVANCE, ET SON RENOUVELLEMENT (lot 1 du plan post-audit, 2026-09-02).
 *
 * 🔴 POURQUOI LE RENOUVELLEMENT EXISTE, et pourquoi allonger le bail n'aurait pas suffi. La migration 0104 a
 * fermé la course COURTE : deux avances qui démarrent ensemble, une seule réserve le tour. Restait la course
 * LONGUE, celle du porteur qui n'est pas mort mais seulement LENT. `withRetry` (`src/meta/http.ts`) autorise
 * cinq tentatives à 30 s de plafond plus le backoff, soit ~154 s au pire pour UN SEUL envoi Meta, et une
 * avance peut en enchaîner plusieurs. Le bail expirait donc pendant que le premier porteur travaillait encore,
 * un second prenait le tour, et les deux envoyaient. Le contact recevait un message qu'il ne devait pas voir.
 *
 * Aucune constante n'est sûre contre ça : le nombre d'envois d'une avance n'est pas borné, donc sa durée non
 * plus. La seule pièce qui distingue « porteur mort » de « porteur lent » est un signe de vie PÉRIODIQUE. Un
 * porteur vivant prolonge son bail, un porteur mort cesse de le prolonger et le tour se libère tout seul.
 *
 * Ce module ne connaît ni la base ni les runs : il ne sait que battre. Le SQL du renouvellement vit dans
 * `run-store.pg.ts` (`prolongerAvance`, gardé par le jeton) et le câblage dans `executor.ts`. Découpé ainsi
 * parce qu'un battement se teste avec des minuteurs simulés, ce qu'une méthode d'exécuteur ne permettrait pas.
 */

/**
 * Durée du bail d'une avance, en secondes (migration 0104).
 *
 * Assez long pour couvrir un traitement lent (un envoi Meta, l'ouverture d'une session d'agent), assez court
 * pour qu'un worker tué en plein traitement ne fasse pas attendre le contact plus d'une poignée de secondes.
 * Depuis le renouvellement, ce n'est plus un plafond de durée de traitement : c'est le délai au bout duquel un
 * porteur qui ne donne PLUS de signe de vie perd son tour.
 */
export const BAIL_AVANCE_S = 60;

/**
 * Cadence du renouvellement. Un TIERS du bail, et ce n'est pas un réglage esthétique : il faut que deux
 * battements consécutifs puissent être manqués (une base lente, une pause du process) sans que le bail tombe.
 * À la moitié, un seul raté suffirait à le perdre.
 */
export const PERIODE_RENOUVELLEMENT_MS = Math.floor((BAIL_AVANCE_S * 1000) / 3);

export interface Renouvellement {
  /** Arrête le battement. À appeler dans un `finally` : un battement qui survit à son avance tient un tour pour rien. */
  arreter(): void;
}

/**
 * Démarre le battement qui garde le bail vivant.
 *
 * `prolonger` rend `false` quand le bail N'EST PLUS À NOUS (un autre porteur l'a repris). Ce n'est pas une
 * erreur transitoire, c'est un verdict : on arrête de battre et on prévient l'appelant, qui le journalise.
 * L'écriture d'état, elle, est de toute façon clôturée par le jeton côté SQL, donc un porteur déchu ne peut
 * plus rien écrire même s'il continue son traitement.
 *
 * Une ERREUR (`prolonger` qui jette) est traitée à l'opposé : elle ne prouve rien sur la propriété du bail,
 * seulement que la base n'a pas répondu. On continue de battre, parce qu'il reste deux tiers de bail devant
 * nous et que le battement suivant peut très bien réussir. Abandonner sur un hoquet réseau ferait perdre un
 * tour parfaitement sain.
 */
export function renouvelerLeBail(opts: {
  prolonger: () => Promise<boolean>;
  /** Le bail a été REPRIS par un autre : on ne bat plus. */
  perdu: () => void;
  /** Un battement a échoué sans rien prouver. Journalisation seulement, le battement continue. */
  echec?: (err: unknown) => void;
  periodeMs?: number;
}): Renouvellement {
  let timer: ReturnType<typeof setInterval> | null = null;
  const arreter = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  // Un battement en cours interdit le suivant : sur une base lente, des renouvellements empilés feraient la
  // queue sur le pool de connexions au moment précis où il est déjà sous tension.
  let enCours = false;

  timer = setInterval(() => {
    if (enCours) return;
    enCours = true;
    void opts
      .prolonger()
      .then((tenu) => {
        if (!tenu) {
          arreter();
          opts.perdu();
        }
      })
      .catch((err: unknown) => {
        opts.echec?.(err);
      })
      .finally(() => {
        enCours = false;
      });
  }, opts.periodeMs ?? PERIODE_RENOUVELLEMENT_MS);

  // Un battement ne doit jamais retenir le process au moment de sortir : il accompagne un travail, il n'en est
  // pas un. `unref` n'existe pas sur le minuteur des navigateurs ni sur celui de certains simulateurs de test.
  timer.unref?.();

  return { arreter };
}
