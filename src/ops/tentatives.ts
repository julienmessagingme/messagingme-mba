/**
 * SURVEILLANCE DES TENTATIVES SUR `/ops` (décision de Julien, 2026-09-03).
 *
 * 🔴 LE TROU QUE ÇA FERME N'EST PAS LA GARDE, C'EST L'AVEUGLEMENT. `/ops` est protégé par un jeton de 32
 * octets minimum, comparé en temps constant, et l'emprunt qu'il autorise est en lecture seule. C'est correct.
 * Mais Fastify tourne en `logger: false` : aujourd'hui, quelqu'un qui essaierait des jetons toute la nuit ne
 * laisserait AUCUNE trace, et personne ne l'apprendrait jamais. Le jour où l'adresse passe de
 * `/api/backend/ops/overview`, noyée, à `api.messagingme.app/ops/overview`, devinable, cet aveuglement coûte
 * beaucoup plus cher.
 *
 * On ne durcit donc pas l'accès (Julien consulte `/ops` d'où il veut, une liste blanche d'IP le couperait dès
 * que son IP change) : on le REND VISIBLE.
 *
 * ⚠️ TROIS RÈGLES QUI RENDENT CETTE SURVEILLANCE SÛRE, et dont l'oubli la retournerait contre nous :
 *  1. le jeton PRÉSENTÉ n'est JAMAIS journalisé, ni en clair ni tronqué. Une tentative est presque toujours
 *     un secret voisin du vrai (une faute de frappe de Julien, une vieille valeur) : l'écrire dans les logs
 *     reviendrait à publier le secret qu'on protège ;
 *  2. on n'alerte PAS au premier échec. Un jeton mal recopié est le cas courant, et une alerte qui crie pour
 *     rien se fait ignorer le jour où elle a raison ;
 *  3. rien ici ne peut faire échouer une requête ni ralentir le refus. Une surveillance qui casse ce qu'elle
 *     observe est pire que pas de surveillance.
 */

/** Échecs à atteindre DANS la fenêtre avant d'alerter. Un jeton mal recopié en produit un ou deux, pas cinq. */
export const SEUIL_ALERTE = 5;
/** Fenêtre de comptage. Assez large pour attraper un balayage lent, assez courte pour ne pas cumuler des mois. */
export const FENETRE_MS = 5 * 60_000;
/** Silence entre deux alertes. Une attaque soutenue doit prévenir une fois, pas mille. */
export const REPOS_ALERTE_MS = 30 * 60_000;

export interface SurveillanceOps {
  /** À appeler à CHAQUE refus de `/ops`. Ne lève jamais, ne rend rien, ne bloque rien. */
  refus(info: { chemin: string; ip: string }): void;
}

/**
 * Construit la surveillance.
 *
 * `alerter` est injecté plutôt qu'importé : c'est ce qui permet de l'éprouver sans réseau, et de ne rien
 * envoyer du tout quand Telegram n'est pas configuré (l'appelant passe alors une fonction vide).
 */
export function surveillerOps(deps: {
  alerter: (message: string) => void;
  journaliser?: (message: string) => void;
  maintenant?: () => number;
}): SurveillanceOps {
  const maintenant = deps.maintenant ?? ((): number => Date.now());
  /** Instants des échecs encore dans la fenêtre. Bornée par construction : on ne garde que la fenêtre. */
  let echecs: number[] = [];
  /**
   * Instant de la dernière alerte, ou `null` si on n'a JAMAIS alerté.
   *
   * ⚠️ `0` ne convient pas comme sentinelle, et ce n'est pas un détail de style : `t - 0` doit dépasser le
   * repos pour que la première alerte parte, ce qui est vrai avec une horloge réelle mais faux dès que
   * l'horloge repart de bas. La première alerte serait alors silencieusement retenue. Trouvé par le test.
   */
  let derniereAlerte: number | null = null;

  return {
    refus(info) {
      const t = maintenant();
      echecs = echecs.filter((e) => t - e < FENETRE_MS);
      echecs.push(t);

      // Le journal, à chaque fois : c'est lui qui permettra de reconstituer après coup, même si l'alerte a
      // été étouffée par le repos. Jamais le jeton présenté, seulement le fait.
      deps.journaliser?.(
        JSON.stringify({ lvl: 'warn', msg: 'ops_refus', chemin: info.chemin, ip: info.ip, dansLaFenetre: echecs.length }),
      );

      if (echecs.length < SEUIL_ALERTE) return;
      if (derniereAlerte !== null && t - derniereAlerte < REPOS_ALERTE_MS) return;
      derniereAlerte = t;
      deps.alerter(
        `ops : ${echecs.length} tentatives refusées en moins de ${Math.round(FENETRE_MS / 60_000)} min `
        + `(dernière sur ${info.chemin}, ip ${info.ip}). Si ce n'est pas toi, le jeton d'exploitation est cherché.`,
      );
    },
  };
}

/**
 * L'adresse du client, telle qu'on peut la connaître.
 *
 * ⚠️ `req.ip` désigne le PROXY, pas le client : Fastify est construit sans `trustProxy`, et Cloudflare puis
 * NPM sont devant. On lit donc l'en-tête que Cloudflare pose. Il est INDICATIF et rien de plus : un appel
 * direct à l'IP du VPS pourrait le forger. C'est acceptable ici parce qu'il ne sert qu'à renseigner un
 * journal, JAMAIS à prendre une décision d'autorisation.
 */
export function ipIndicative(req: { ip: string; headers: Record<string, unknown> }): string {
  const cf = req.headers['cf-connecting-ip'];
  const brut = Array.isArray(cf) ? cf[0] : cf;
  return typeof brut === 'string' && brut.trim() !== '' ? brut.trim() : req.ip;
}
