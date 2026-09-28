/**
 * Surveillance des tentatives sur `/ops`.
 *
 * `/ops` est gardé par une session d'exploitation nominative (`makeRequireOps`), mais Fastify tourne en
 * `logger: false` : sans ce module, des essais toute la nuit ne laisseraient aucune trace. Un refus compte aussi
 * la session d'une adresse retirée de la liste, ou dont le second facteur a été retiré.
 *
 * Trois règles :
 *  1. 🔴 le jeton présenté n'est jamais journalisé, ni en clair ni tronqué : une session, même refusée, reste un
 *     secret ;
 *  2. pas d'alerte au premier échec : une session expirée est le cas courant ;
 *  3. rien ici ne peut faire échouer une requête ni ralentir le refus.
 */

/** Échecs à atteindre dans la fenêtre avant d'alerter. Une session expirée en produit un ou deux, pas cinq. */
export const SEUIL_ALERTE = 5;
/** Fenêtre de comptage. Assez large pour attraper un balayage lent, assez courte pour ne pas cumuler des mois. */
export const FENETRE_MS = 5 * 60_000;
/** Silence entre deux alertes. Une attaque soutenue doit prévenir une fois, pas mille. */
export const REPOS_ALERTE_MS = 30 * 60_000;

export interface SurveillanceOps {
  /** À appeler à chaque refus de `/ops`. Ne lève jamais, ne rend rien, ne bloque rien. */
  refus(info: { chemin: string; ip: string }): void;
}

/**
 * Construit la surveillance. `alerter` est injecté : testable sans réseau, et une fonction vide quand Telegram
 * n'est pas configuré.
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
   * Instant de la dernière alerte, `null` si on n'a jamais alerté. Pas `0` comme sentinelle : avec une horloge
   * qui part de bas, `t - 0` ne dépasserait pas le repos et la première alerte serait retenue.
   */
  let derniereAlerte: number | null = null;

  return {
    refus(info) {
      const t = maintenant();
      echecs = echecs.filter((e) => t - e < FENETRE_MS);
      echecs.push(t);

      // Journalisé à chaque refus, même quand l'alerte est étouffée par le repos. Jamais le jeton, seulement le fait.
      deps.journaliser?.(
        JSON.stringify({ lvl: 'warn', msg: 'ops_refus', chemin: info.chemin, ip: info.ip, dansLaFenetre: echecs.length }),
      );

      if (echecs.length < SEUIL_ALERTE) return;
      if (derniereAlerte !== null && t - derniereAlerte < REPOS_ALERTE_MS) return;
      derniereAlerte = t;
      deps.alerter(
        `ops : ${echecs.length} tentatives refusées en moins de ${Math.round(FENETRE_MS / 60_000)} min `
        + `(dernière sur ${info.chemin}, ip ${info.ip}). Si ce n'est pas toi, quelqu'un cherche à entrer dans l'exploitation.`,
      );
    },
  };
}

/**
 * L'adresse du client, à titre indicatif. `req.ip` désigne le proxy (pas de `trustProxy`, Cloudflare puis NPM
 * devant) : on lit l'en-tête de Cloudflare, qu'un appel direct au VPS pourrait forger. Il ne sert qu'au
 * journal, jamais à une décision d'autorisation.
 */
export function ipIndicative(req: { ip: string; headers: Record<string, unknown> }): string {
  const cf = req.headers['cf-connecting-ip'];
  const brut = Array.isArray(cf) ? cf[0] : cf;
  return typeof brut === 'string' && brut.trim() !== '' ? brut.trim() : req.ip;
}
