/**
 * Limiteur de débit en mémoire (fenêtre glissante par clé, ex. IP). Sans dépendance,
 * suffisant pour un process unique : borne le brute-force/credential-stuffing sur /auth/login.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

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
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
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
