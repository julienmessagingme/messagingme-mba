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

/**
 * 🔴 DURÉE TOTALE MAXIMALE D'UNE AVANCE, et c'est le mode de panne que le battement seul ne couvre PAS.
 *
 * Le battement distingue un porteur mort d'un porteur lent. Il ne distingue pas un porteur lent d'un porteur
 * PENDU : une promesse métier qui ne se résout jamais laisse le minuteur renouveler le bail indéfiniment, donc
 * le tour reste tenu à vie et le contact n'a plus jamais de réponse. Aucune durée d'avance légitime n'approche
 * dix minutes : un envoi Meta au pire dure ~154 s, et une avance en enchaîne quelques-uns.
 *
 * Au-delà, on cesse de battre ET on déclare le tour perdu, ce qui arrête les effets suivants et laisse le bail
 * expirer normalement pour qu'un autre traitement puisse reprendre.
 */
export const DUREE_MAX_AVANCE_MS = 10 * 60 * 1000;

/**
 * Ce qu'un chemin d'effet a besoin de savoir du bail : rien d'autre que « le tour est-il encore à nous ? ».
 *
 * Type séparé, et pas un `Pick<Renouvellement, ...>` : `apply` et `walkResolved` reçoivent cette garde, et leur
 * donner le renouvellement entier les mettrait en position d'arrêter le battement ou d'écouter le signal, ce
 * qui n'est pas leur travail. Un contrat étroit se lit dans la signature ; un `Pick` se contourne au premier
 * refactor.
 */
export interface GardeDuTour {
  /**
   * 🔴 LE TOUR EST-IL ENCORE À NOUS ? À consulter AVANT chaque effet irréversible.
   *
   * Sans cette question, le renouvellement ne servait qu'à empêcher un AUTRE de prendre le tour ; il
   * n'empêchait pas l'ancien porteur, une fois le bail perdu, de continuer ses envois. Le jeton clôture
   * l'écriture d'ÉTAT, jamais les messages déjà partis. Constat de l'audit externe du 2026-09-02.
   *
   * Rend la RAISON (`bail repris`, `durée maximale dépassée`) ou `null` tant que tout va bien : une raison se
   * journalise et se remonte, un booléen ne dit pas quoi chercher.
   */
  perduPourquoi(): string | null;
}

export interface Renouvellement extends GardeDuTour {
  /** Arrête le battement. À appeler dans un `finally` : un battement qui survit à son avance tient un tour pour rien. */
  arreter(): void;
  /**
   * Signal d'annulation, abattu dès que le tour est perdu.
   *
   * ⚠️ AUCUN transport d'envoi ne l'écoute aujourd'hui, ET C'EST VOULU, pas un reste à faire. Un envoi Meta
   * ne porte pas de clé d'idempotence : couper la connexion en plein vol ne dit pas si le message est parti,
   * donc on troquerait « un message de trop » contre « un message parti que nous n'avons pas enregistré »,
   * qui est pire (l'opérateur ne le verrait dans aucun fil). La garde réelle est donc le point de contrôle
   * ENTRE deux effets : on laisse finir celui qui est en vol, on ne lance pas le suivant.
   *
   * Le signal existe pour les travaux qui SONT annulables sans ambiguïté, et il en viendra : une recherche de
   * connaissance, un appel de reranker, une lecture de connecteur. Le brancher là ne coûtera rien.
   */
  readonly signal: AbortSignal;
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

  // Déclare le tour perdu UNE fois. La première raison gagne : c'est celle qui a réellement arrêté le travail,
  // et l'écraser par une seconde ferait mentir le journal sur la cause.
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
    // La durée maximale se vérifie AVANT de prolonger : prolonger un bail qu'on s'apprête à abandonner le
    // tiendrait une minute de plus pour rien, au détriment du traitement qui va reprendre le tour.
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

  // Un battement ne doit jamais retenir le process au moment de sortir : il accompagne un travail, il n'en est
  // pas un. `unref` n'existe pas sur le minuteur des navigateurs ni sur celui de certains simulateurs de test.
  timer.unref?.();

  return {
    arreter,
    perduPourquoi: () => raisonPerte,
    signal: abandon.signal,
  };
}
