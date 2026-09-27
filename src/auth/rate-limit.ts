import type { FastifyReply } from 'fastify';
import type { CodeApi } from '../api/erreurs';

/**
 * Limiteur de débit en mémoire, par clé, à fenêtre fixe et non glissante : ancrée sur le premier appel, elle
 * laisse passer les N requêtes du plafond dans la même milliseconde, puis N autres après la bascule. D'où le
 * plafond d'opérations lourdes simultanées (`ApiUsageGuard`). Que des `import type` : chargeable hors du
 * serveur HTTP.
 *
 * La clé change avec l'appelant, et décide de qui partage un quota avec qui : `ip::discriminant` pour
 * l'authentification (`req.ip` seul désignerait le proxy), le code pour `/w/:code` et `/rcs/callback/:code`,
 * l'espace d'une clé résolue pour `/v1` et `/mcp`, l'empreinte de la clé du relais, l'`userId` pour le
 * plafond général, le `tenantId` pour les routes coûteuses. Une clé ou un code inventé n'entre dans aucune
 * table : les budgets communs à clé constante (`consommerEnSilence`) le freinent avant la base.
 *
 * Local au process : avec deux instances, un attaquant aurait le double. Le jour d'une seconde instance, le
 * compteur part en base ou dans un cache partagé, pas un plafond divisé.
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
     * Nombre maximal de clés vivantes ; au-delà, une clé neuve est refusée. `0` = pas de plafond. À poser quand
     * la clé est choisie par l'appelant (l'`ip::discriminant` de l'authentification) : sinon un robot ferait
     * grossir la table toute la fenêtre. Mais ce refus frappe aussi les vraies clés revenues après expiration :
     * quand la clé se vérifie en base (code de webhook, de rappel RCS, empreinte de clé d'API), on ne consulte
     * plutôt le limiteur que sur des clés qui existent, dont le nombre borne la table.
     */
    private readonly maxCles = 0,
  ) {}

  /**
   * Un plafond à 0 (ou négatif) désactive le limiteur : la convention du dépôt, et le levier d'urgence de
   * `API_KEY_PREFILTRE_MAX`. Tenu par `tests/rate-limit-bornes.test.ts`.
   */
  get desactive(): boolean {
    return this.max <= 0;
  }

  /**
   * Enregistre une tentative pour `key` ; true si elle est autorisée. `max` remplace le plafond du
   * constructeur pour cet appel (le plafond par espace règle un espace sans toucher les autres) ; il doit être
   * le même à `remaining()` et à `take()` pour une clé, sinon l'état annoncé ment.
   */
  take(key: string, max = this.max): boolean {
    // Désactivé : rien n'est compté, donc la table ne grossit pas non plus.
    if (max <= 0) return true;
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t >= entry.resetAt) {
      // Le nombre de clés distinctes peut croître : on purge les entrées expirées avant d'en créer une neuve,
      // sinon une clé jamais re-touchée resterait dans la Map.
      if (this.hits.size >= this.pruneThreshold) this.prune(t);
      // Clé neuve alors que la table est pleine : refus plutôt que croissance. Les clés présentes ne sont pas
      // concernées.
      if (this.maxCles > 0 && !entry && this.hits.size >= this.maxCles) return false;
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  }

  /** Retire les entrées dont la fenêtre est terminée (borne la taille de la Map). */
  private prune(t: number): void {
    for (const [k, e] of this.hits) {
      if (t >= e.resetAt) this.hits.delete(k);
    }
  }

  /** État courant sans consommer de tentative (pour les en-têtes x-ratelimit-*). Une fenêtre expirée ou jamais
   *  ouverte : quota plein, reset dans une fenêtre. `attenteMs` est calculé ici, sur l'horloge du limiteur
   *  (injectable) : le recalculer avec `Date.now()` chez l'appelant donnerait une attente fausse. */
  remaining(key: string, max = this.max): { limit: number; remaining: number; resetAt: number; attenteMs: number } {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t >= entry.resetAt) {
      return { limit: max, remaining: max, resetAt: t + this.windowMs, attenteMs: this.windowMs };
    }
    return {
      limit: max,
      remaining: Math.max(0, max - entry.count),
      resetAt: entry.resetAt,
      attenteMs: Math.max(0, entry.resetAt - t),
    };
  }
}

/**
 * Consomme un jeton pour `cle` et pose les en-têtes `x-ratelimit-*` ; `false` = refusé, le 429 est déjà
 * parti. Point de passage unique des plafonds qu'on annonce à l'appelant (un budget partagé passe par
 * `consommerEnSilence`). L'état se lit avant de consommer, et le `remaining` affiché retire l'appel en cours.
 * Le refus est un 429, jamais un 5xx : Cloudflare remplace le corps des 5xx par sa page.
 */
export async function consommerAvecEntetes(
  limiteur: RateLimiter,
  cle: string,
  reply: FastifyReply,
  message = 'trop de requêtes, patientez un instant',
  /**
   * Facultatif : seule la surface publique (`/v1`, `/mcp`) le passe ; la console, les webhooks entrants et les
   * rappels RCS gardent `{ error }` seul.
   */
  code?: CodeApi,
): Promise<boolean> {
  // Désactivé : aucun en-tête. `x-ratelimit-limit: 0` sur un appel accepté ferait croire à un quota épuisé.
  if (limiteur.desactive) return true;
  const etat = limiteur.remaining(cle);
  reply.header('x-ratelimit-limit', String(etat.limit));
  reply.header('x-ratelimit-remaining', String(Math.max(0, etat.remaining - 1)));
  reply.header('x-ratelimit-reset', String(Math.ceil(etat.resetAt / 1000)));
  if (limiteur.take(cle)) return true;
  reply.header('x-ratelimit-remaining', '0');
  await refuserTropDeRequetes(reply, etat.attenteMs, message, code);
  return false;
}

/**
 * Consomme un jeton sans rien annoncer tant que l'appel passe, pour un budget partagé par tous les appelants
 * (clé constante), comme le budget spéculatif de `/v1`. 🔴 Ses en-têtes diraient à n'importe qui où en est
 * le budget de tous, et le trafic des autres : un plafond annoncé est celui qui appartient à l'appelant. Le
 * refus garde son `Retry-After`.
 */
export async function consommerEnSilence(
  limiteur: RateLimiter,
  cle: string,
  reply: FastifyReply,
  message = 'trop de requêtes, patientez un instant',
  code?: CodeApi,
): Promise<boolean> {
  if (limiteur.take(cle)) return true;
  await refuserTropDeRequetes(reply, limiteur.remaining(cle).attenteMs, message, code);
  return false;
}

/** Le refus de débit, partagé par tous les plafonds (celui de l'API par espace compris) : même `retry-after`, même 429. */
export async function refuserTropDeRequetes(reply: FastifyReply, attenteMs: number, message: string, code?: CodeApi): Promise<void> {
  reply.header('retry-after', String(Math.max(1, Math.ceil(attenteMs / 1000))));
  await reply.code(429).send(code ? { error: message, code } : { error: message });
}

/**
 * Les clés déjà résolues avec succès par ce process, en nombre borné : empreinte d'une clé d'API (`/v1`),
 * code d'un webhook entrant (`/w/:code`), code d'un rappel RCS (`/rcs/callback/:code`). Elles échappent au
 * budget commun des clés jamais vues : sinon une attaque qui l'épuise refuserait aussi les appelants
 * légitimes.
 *
 * 🔴 Ce n'est pas un cache de validité : la lecture en base a lieu à chaque fois, et une clé qui cesse de se
 * résoudre est oubliée (sinon elle échapperait au budget tout en martelant la base). Bornée, on oublie la
 * plus ancienne ; on n'y entre qu'après une résolution réussie. Elle peut garder ce que la résolution a dit
 * d'immuable (`V` : l'espace d'une clé d'API et son droit de relais).
 */
export class ClesResolues<V = never> {
  private readonly vues = new Map<string, V | undefined>();
  constructor(private readonly max: number) {}
  connait(cle: string): boolean { return this.vues.has(cle); }
  /** Ce qui a été retenu avec la clé, `undefined` si elle n'a jamais été résolue (ou rien n'a été retenu). */
  valeur(cle: string): V | undefined { return this.vues.get(cle); }
  oublier(cle: string): void { this.vues.delete(cle); }
  retenir(cle: string, valeur?: V): void {
    if (!this.vues.has(cle) && this.vues.size >= this.max) {
      const plusAncienne = this.vues.keys().next().value;
      if (plusAncienne !== undefined) this.vues.delete(plusAncienne);
    }
    this.vues.set(cle, valeur);
  }
}

/**
 * Un avertissement journalisé au plus une fois par fenêtre : un budget commun épuisé doit laisser une trace,
 * mais jamais une ligne par requête hostile.
 */
export function avertissementBorne(message: string, fenetreMs = 60_000, maintenant: () => number = () => Date.now()): () => void {
  let dernier = Number.NEGATIVE_INFINITY;
  return () => {
    const t = maintenant();
    if (t - dernier < fenetreMs) return;
    dernier = t;
    // eslint-disable-next-line no-console
    console.warn(message);
  };
}
