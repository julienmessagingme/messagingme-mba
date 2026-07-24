/**
 * Limiteur de débit en mémoire (fenêtre glissante par clé, ex. IP). Sans dépendance,
 * suffisant pour un process unique : borne le brute-force/credential-stuffing sur /auth/login.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  /** Au-delà de ce nombre de clés, on purge les entrées expirées avant d'en insérer une neuve. */
  private readonly pruneThreshold = 1000;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
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
