import type { FastifyReply } from 'fastify';

/**
 * Limiteur de débit en mémoire (fenêtre glissante par clé). Aucune dépendance de RUNTIME : le seul import de
 * ce fichier est un `import type`, effacé à la compilation. À garder ainsi, pour que le limiteur reste
 * chargeable depuis n'importe quel contexte, y compris hors du serveur HTTP.
 *
 * ⚠️ Il ne sert plus seulement `/auth/login`, et la CLÉ change avec l'appelant, ce qui est tout le sujet :
 * `ip::discriminant` pour les routes d'authentification (`req.ip` seul désignerait le proxy), le CODE pour
 * `/w/:code`, l'identifiant de clé pour `/v1`, l'`userId` pour le plafond général des routes authentifiées
 * et le `tenantId` pour celui des routes coûteuses. Le choix de clé décide de QUI partage un quota avec qui,
 * et c'est la seule décision qui compte à l'usage.
 *
 * 🔴 EXPLICITEMENT LOCAL AU PROCESS (programme II, lot 8). Le plafond annoncé est celui d'UNE instance : avec
 * deux process d'API derrière le même proxy, un attaquant dispose du DOUBLE, et rien ne le signale. Ce n'est
 * pas un défaut aujourd'hui (il n'y a qu'une instance), c'est une propriété à connaître AVANT d'en lancer une
 * seconde. Le jour où ça arrive, la réponse n'est pas de diviser le plafond par le nombre d'instances (on ne
 * le connaît pas de façon fiable) mais de porter le compteur en base ou dans un cache partagé.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  /** Au-delà de ce nombre de clés, on purge les entrées expirées avant d'en insérer une neuve. */
  private readonly pruneThreshold = 1000;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
    /**
     * Nombre maximal de clés VIVANTES. Au-delà, une clé NEUVE est refusée (les clés déjà connues continuent
     * d'être servies normalement). `0` = pas de plafond, comportement d'origine.
     *
     * 🔴 À poser dès que la clé est choisie par l'APPELANT et non par nous. Le limiteur du webhook entrant est
     * désormais consulté AVANT la requête en base, donc sur un code qui n'existe peut-être pas : sans plafond,
     * un robot qui tire des codes au hasard ferait grossir la table indéfiniment pendant toute la fenêtre (la
     * purge ne retire que les entrées EXPIRÉES, et sous flot rien n'expire). On échange une fuite de mémoire
     * contre un refus, qui est le bon comportement sous attaque.
     */
    private readonly maxCles = 0,
  ) {}

  /** Enregistre une tentative pour `key`. Retourne true si elle est autorisée, false si bloquée. */
  take(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t >= entry.resetAt) {
      // La clé n'est plus une constante (ex. ip::email) : le nombre de clés distinctes peut croître. On purge
      // opportunément les entrées expirées avant d'en créer une neuve, pour ne pas fuir la mémoire (une clé
      // jamais re-touchée resterait sinon indéfiniment dans la Map).
      if (this.hits.size >= this.pruneThreshold) this.prune(t);
      // Clé NEUVE alors que la table est pleine : on refuse plutôt que de grossir. Les clés déjà présentes
      // (donc les vrais webhooks, qui appellent régulièrement) ne sont pas concernées.
      if (this.maxCles > 0 && !entry && this.hits.size >= this.maxCles) return false;
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }

  /** Retire les entrées dont la fenêtre est terminée (borne la taille de la Map). */
  private prune(t: number): void {
    for (const [k, e] of this.hits) {
      if (t >= e.resetAt) this.hits.delete(k);
    }
  }

  /** État courant SANS consommer de tentative (pour les en-têtes x-ratelimit-*). Une fenêtre expirée ou
   *  jamais ouverte -> quota plein, reset dans une fenêtre. `limit` = le plafond configuré.
   *
   *  🔴 `attenteMs` est rendu ICI, et pas recalculé par l'appelant. `resetAt` est daté de l'horloge de CE
   *  limiteur, qui est injectable : le soustraire à `Date.now()` ne veut rien dire dès que les deux
   *  diffèrent, et donne un nombre très négatif que le plancher à 1 seconde masque. L'appelant annonce alors
   *  « réessayez dans 1 seconde » pour une fenêtre d'une minute. La durée d'attente se lit donc sur la même
   *  horloge que la date de reset, et il n'y a qu'un endroit où elle se calcule. */
  remaining(key: string): { limit: number; remaining: number; resetAt: number; attenteMs: number } {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t >= entry.resetAt) {
      return { limit: this.max, remaining: this.max, resetAt: t + this.windowMs, attenteMs: this.windowMs };
    }
    return {
      limit: this.max,
      remaining: Math.max(0, this.max - entry.count),
      resetAt: entry.resetAt,
      attenteMs: Math.max(0, entry.resetAt - t),
    };
  }
}

/**
 * Consomme un jeton pour `cle` et pose les en-têtes `x-ratelimit-*` sur la réponse. Rend `true` si l'appel
 * est autorisé, `false` s'il a été refusé (auquel cas la réponse 429 est DÉJÀ envoyée).
 *
 * 🔴 POINT DE PASSAGE UNIQUE des trois consommateurs (clé d'API, plafond général par utilisateur, plafond
 * par espace des routes coûteuses). La séquence exacte compte et se recopiait de travers : on lit l'état
 * AVANT de consommer, parce que `remaining()` d'après-consommation ne dit plus quel était le plafond restant
 * annoncé à l'appelant, et on retire 1 au `remaining` affiché puisque l'appel en cours vient de le prendre.
 *
 * ⚠️ Le refus est un **429**, jamais un 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa propre
 * page d'erreur, et le message ne parviendrait pas à l'appelant.
 */
export async function consommerAvecEntetes(
  limiteur: RateLimiter,
  cle: string,
  reply: FastifyReply,
  message = 'trop de requêtes, patientez un instant',
): Promise<boolean> {
  const etat = limiteur.remaining(cle);
  reply.header('x-ratelimit-limit', String(etat.limit));
  reply.header('x-ratelimit-remaining', String(Math.max(0, etat.remaining - 1)));
  reply.header('x-ratelimit-reset', String(Math.ceil(etat.resetAt / 1000)));
  if (limiteur.take(cle)) return true;
  reply.header('x-ratelimit-remaining', '0');
  reply.header('retry-after', String(Math.max(1, Math.ceil(etat.attenteMs / 1000))));
  await reply.code(429).send({ error: message });
  return false;
}
