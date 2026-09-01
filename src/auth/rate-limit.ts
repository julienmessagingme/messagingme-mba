/**
 * Limiteur de débit en mémoire (fenêtre glissante par clé, ex. IP). Sans dépendance,
 * suffisant pour un process unique : borne le brute-force/credential-stuffing sur /auth/login.
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
   *  jamais ouverte -> quota plein, reset dans une fenêtre. `limit` = le plafond configuré. */
  remaining(key: string): { limit: number; remaining: number; resetAt: number } {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t >= entry.resetAt) {
      return { limit: this.max, remaining: this.max, resetAt: t + this.windowMs };
    }
    return { limit: this.max, remaining: Math.max(0, this.max - entry.count), resetAt: entry.resetAt };
  }
}
