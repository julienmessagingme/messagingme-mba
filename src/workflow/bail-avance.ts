/**
 * Le bail du tour d'avance, et son renouvellement.
 *
 * Le bail empêche deux avances simultanées de réserver le même tour. Mais un porteur peut être lent sans être
 * mort : un seul envoi Meta peut durer ~154 s avec les reprises de `withRetry` (`src/meta/http.ts`), et une
 * avance en enchaîne un nombre non borné. Aucune durée de bail n'est donc sûre ; seul un signe de vie
 * périodique distingue « porteur mort » (le bail expire, le tour se libère) de « porteur lent » (il prolonge
 * son bail). Sinon un second porteur prend le tour et les deux envoient.
 *
 * Ce module ne fait que battre : le SQL vit dans `run-store.pg.ts` (`prolongerAvance`, gardé par le jeton) et
 * le câblage dans `executor.ts`, pour qu'un battement se teste avec des minuteurs simulés.
 */

/**
 * Durée du bail d'une avance, en secondes : le délai au bout duquel un porteur qui ne donne plus de signe de
 * vie perd son tour. Assez court pour qu'un worker tué ne fasse pas attendre le contact longtemps.
 */
export const BAIL_AVANCE_S = 60;

/**
 * Cadence du renouvellement : un tiers du bail, pour que deux battements consécutifs puissent être manqués
 * (base lente, pause du process) sans que le bail tombe. À la moitié, un seul raté suffirait.
 */
export const PERIODE_RENOUVELLEMENT_MS = Math.floor((BAIL_AVANCE_S * 1000) / 3);

/**
 * Durée totale maximale d'une avance. Le battement distingue un porteur mort d'un porteur lent, pas d'un
 * porteur pendu : une promesse qui ne se résout jamais ferait renouveler le bail à vie, et le contact
 * n'aurait plus jamais de réponse. Aucune avance légitime n'approche dix minutes. Au-delà, on cesse de battre
 * et on déclare le tour perdu : les effets suivants s'arrêtent et le bail expire normalement.
 */
export const DUREE_MAX_AVANCE_MS = 10 * 60 * 1000;

/**
 * Ce qu'un chemin d'effet a besoin de savoir du bail : « le tour est-il encore à nous ? ». Type séparé plutôt
 * qu'un `Pick<Renouvellement, ...>` : `apply` et `walkResolved` n'ont pas à pouvoir arrêter le battement ni
 * écouter le signal.
 */
export interface GardeDuTour {
  /**
   * Le tour est-il encore à nous ? À consulter avant chaque effet irréversible : le jeton clôture l'écriture
   * d'état, pas les envois, donc sans cette question l'ancien porteur continuerait d'envoyer après avoir perdu
   * son bail. Rend la raison (`bail repris`, `durée maximale dépassée`) ou `null` tant que tout va bien.
   */
  perduPourquoi(): string | null;
}

export interface Renouvellement extends GardeDuTour {
  /** Arrête le battement. À appeler dans un `finally` : un battement qui survit à son avance tient un tour pour rien. */
  arreter(): void;
  /**
   * Signal d'annulation, abattu dès que le tour est perdu. Aucun transport d'envoi ne l'écoute, exprès : un
   * envoi Meta n'a pas de clé d'idempotence, et couper en plein vol laisserait un message parti mais non
   * enregistré. La garde réelle est le point de contrôle entre deux effets. Le signal sert aux travaux
   * annulables sans ambiguïté (recherche de connaissance, lecture de connecteur).
   */
  readonly signal: AbortSignal;
}

/**
 * Démarre le battement qui garde le bail vivant.
 *
 * `prolonger` rend `false` quand le bail n'est plus à nous : c'est un verdict, on arrête de battre et on
 * prévient l'appelant (l'écriture d'état reste de toute façon clôturée par le jeton côté SQL). Une erreur
 * (`prolonger` qui jette) ne prouve rien sur la propriété du bail : on continue de battre, il reste deux
 * tiers de bail et le battement suivant peut réussir.
 */
export function renouvelerLeBail(opts: {
  prolonger: () => Promise<boolean>;
  /** Le bail a été repris par un autre : on ne bat plus. */
  perdu: () => void;
  /** Un battement a échoué sans rien prouver. Journalisation seulement, le battement continue. */
  echec?: (err: unknown) => void;
  periodeMs?: number;
  /** Durée totale au-delà de laquelle l'avance est déclarée perdue, même si le bail tient encore. */
  dureeMaxMs?: number;
  /** Horloge injectable, pour tester la durée maximale sans attendre dix minutes. */
  maintenant?: () => number;
}): Renouvellement {
  const periodeMs = opts.periodeMs ?? PERIODE_RENOUVELLEMENT_MS;
  const dureeMaxMs = opts.dureeMaxMs ?? DUREE_MAX_AVANCE_MS;
  const maintenant = opts.maintenant ?? (() => Date.now());
  const debut = maintenant();

  const abandon = new AbortController();
  let raisonPerte: string | null = null;

  let timer: ReturnType<typeof setInterval> | null = null;
  const arreter = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  // Déclare le tour perdu une fois : la première raison est celle qui a réellement arrêté le travail.
  const declarerPerdu = (raison: string): void => {
    if (raisonPerte !== null) return;
    raisonPerte = raison;
    arreter();
    abandon.abort(new Error(`avance abandonnée : ${raison}`));
    opts.perdu();
  };

  // Un battement en cours interdit le suivant : sur une base lente, des renouvellements empilés feraient la
  // queue sur le pool de connexions au moment précis où il est déjà sous tension.
  let enCours = false;

  timer = setInterval(() => {
    // La durée maximale se vérifie avant de prolonger : prolonger un bail qu'on va abandonner le tiendrait une
    // minute de plus pour rien.
    if (maintenant() - debut >= dureeMaxMs) {
      declarerPerdu(`durée maximale d'avance dépassée (${Math.round(dureeMaxMs / 1000)} s)`);
      return;
    }
    if (enCours) return;
    enCours = true;
    void opts
      .prolonger()
      .then((tenu) => {
        if (!tenu) declarerPerdu('bail repris par un autre traitement');
      })
      .catch((err: unknown) => {
        opts.echec?.(err);
      })
      .finally(() => {
        enCours = false;
      });
  }, periodeMs);

  // Un battement ne doit pas retenir le process à la sortie. `unref` n'existe pas sur tous les minuteurs
  // (navigateurs, simulateurs de test).
  timer.unref?.();

  return {
    arreter,
    perduPourquoi: () => raisonPerte,
    signal: abandon.signal,
  };
}
