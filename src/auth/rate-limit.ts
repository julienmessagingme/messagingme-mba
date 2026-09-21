import type { FastifyReply } from 'fastify';

/**
 * Limiteur de débit en mémoire, par clé.
 *
 * 🔴 SA FENÊTRE EST FIXE, PAS GLISSANTE, et cet en-tête a dit le contraire jusqu'au 2026-09-14. La
 * différence n'est pas théorique : la fenêtre est ANCRÉE sur le premier appel, donc les N requêtes du
 * plafond peuvent tomber dans la même milliseconde, et N autres juste après la bascule. Un lecteur qui
 * croit à une fenêtre glissante en déduit une régularité que ce limiteur ne donne pas, et dimensionne le
 * plafond en conséquence. Une justification fausse est pire qu'aucune, parce qu'elle sera recopiée.
 *
 * ⚠️ C'EST CE QUI A RENDU NÉCESSAIRE LE PLAFOND D'OPÉRATIONS LOURDES SIMULTANÉES (`ApiUsageGuard`) : dix
 * requêtes d'une même fenêtre suffisent à saturer le pool sans jamais franchir le plafond affiché. Aucune dépendance de RUNTIME : le seul import de
 * ce fichier est un `import type`, effacé à la compilation. À garder ainsi, pour que le limiteur reste
 * chargeable depuis n'importe quel contexte, y compris hors du serveur HTTP.
 *
 * ⚠️ Il ne sert plus seulement `/auth/login`, et la CLÉ change avec l'appelant, ce qui est tout le sujet :
 * `ip::discriminant` pour les routes d'authentification (`req.ip` seul désignerait le proxy), le CODE pour
 * `/w/:code`, l'EMPREINTE de la clé pour `/v1` (comptée seulement pour une clé résolue : une clé inventée
 * n'y entre jamais, c'est le budget spéculatif de `api-key.ts` qui la freine avant la base), l'`userId` pour
 * le plafond général des routes authentifiées et le `tenantId` pour celui des routes coûteuses. Le choix de clé décide de QUI partage un quota avec qui,
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
     * 🔴 À poser dès que la clé est choisie par l'APPELANT et non par nous (l'`ip::discriminant` des routes
     * d'authentification) : sans plafond, un robot qui tire des clés au hasard ferait grossir la table pendant
     * toute la fenêtre (la purge ne retire que les entrées EXPIRÉES, et sous flot rien n'expire). On échange
     * une fuite de mémoire contre un refus.
     *
     * 🔴 MAIS CE REFUS FRAPPE AUSSI LES VRAIES CLÉS, et c'est ce qu'il faut peser avant de le poser. L'entrée
     * d'un appelant légitime expire à chaque fenêtre ; s'il revient pendant que la table est pleine, il est une
     * clé NEUVE, donc refusé. Des clés inventées en masse suffisent alors à bloquer un vrai client. Quand la clé
     * est un identifiant qu'on peut VÉRIFIER en base (le code d'un webhook entrant, celui d'un rappel RCS,
     * l'empreinte d'une clé d'API), la bonne réponse n'est pas ce plafond : c'est de ne consulter le limiteur
     * que sur des clés qui existent, dont le nombre borne la table (cf. `registerWebhookEntrant`,
     * `registerRcsCallback`, et `makeRequireApiKey`, qui le consulte avant la base pour une clé DÉJÀ résolue).
     * Ces trois limiteurs-là ont d'abord été consultés AVANT la base sur n'importe quelle clé présentée, et
     * c'est exactement le défaut corrigé le 2026-09-21.
     */
    private readonly maxCles = 0,
  ) {}

  /**
   * 🔴 UN PLAFOND À 0 (OU NÉGATIF) DÉSACTIVE LE LIMITEUR. C'est la convention de toute la configuration du
   * dépôt, et le levier d'urgence documenté de `API_KEY_PREFILTRE_MAX`. Avant le 2026-09-21, un plafond à 0
   * laissait passer le PREMIER appel d'une fenêtre (la branche « clé neuve » ne regardait pas `max`) puis
   * refusait tous les suivants : le levier qui devait libérer l'API la coupait. Le test de ce cas vit dans
   * `tests/rate-limit-bornes.test.ts`.
   */
  get desactive(): boolean {
    return this.max <= 0;
  }

  /** Enregistre une tentative pour `key`. Retourne true si elle est autorisée, false si bloquée. */
  take(key: string): boolean {
    // Désactivé : rien n'est compté, donc la table ne grossit pas non plus.
    if (this.desactive) return true;
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
 * 🔴 POINT DE PASSAGE UNIQUE des plafonds qu'on ANNONCE à l'appelant (le compte n'est pas écrit ici : il
 * dérivait). Un budget PARTAGÉ passe par `consommerEnSilence`, pas par ici. La séquence exacte compte et se
 * recopiait de travers : on lit l'état
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
  // Désactivé : aucun en-tête. Annoncer `x-ratelimit-limit: 0` sur un appel ACCEPTÉ ferait croire à un
  // intégrateur qu'il est à bout de quota alors qu'il n'y en a aucun.
  if (limiteur.desactive) return true;
  const etat = limiteur.remaining(cle);
  reply.header('x-ratelimit-limit', String(etat.limit));
  reply.header('x-ratelimit-remaining', String(Math.max(0, etat.remaining - 1)));
  reply.header('x-ratelimit-reset', String(Math.ceil(etat.resetAt / 1000)));
  if (limiteur.take(cle)) return true;
  reply.header('x-ratelimit-remaining', '0');
  await refuserTropDeRequetes(reply, etat.attenteMs, message);
  return false;
}

/**
 * Consomme un jeton SANS RIEN ANNONCER tant que l'appel passe : pour un budget PARTAGÉ par tous les appelants
 * (clé constante), comme le budget spéculatif de `/v1`.
 *
 * 🔴 SES EN-TÊTES DIRAIENT À N'IMPORTE QUI OÙ EN EST LE BUDGET DE TOUS. Posés par `consommerAvecEntetes`, ils
 * partaient sur le 401 d'une fausse clé : mesuré en production le 2026-09-21, `x-ratelimit-limit: 30` et
 * `x-ratelimit-remaining: 29`. Un sondeur y lisait le moment exact où le budget s'épuise, et le trafic des
 * autres. Un plafond qu'on annonce est celui qui appartient à l'appelant : sa clé, son compte, son espace.
 *
 * ⚠️ LE REFUS GARDE SON `Retry-After` : sans lui, un client légitime réessaierait tout de suite, donc
 * redemanderait la place qu'on vient de lui refuser.
 */
export async function consommerEnSilence(
  limiteur: RateLimiter,
  cle: string,
  reply: FastifyReply,
  message = 'trop de requêtes, patientez un instant',
): Promise<boolean> {
  if (limiteur.take(cle)) return true;
  await refuserTropDeRequetes(reply, limiteur.remaining(cle).attenteMs, message);
  return false;
}

async function refuserTropDeRequetes(reply: FastifyReply, attenteMs: number, message: string): Promise<void> {
  reply.header('retry-after', String(Math.max(1, Math.ceil(attenteMs / 1000))));
  await reply.code(429).send({ error: message });
}

/**
 * LES CLÉS DÉJÀ RÉSOLUES AVEC SUCCÈS PAR CE PROCESS, en nombre borné : l'empreinte d'une clé d'API (`/v1`), le
 * code d'un webhook entrant (`/w/:code`), celui d'un rappel RCS (`/rcs/callback/:code`).
 *
 * 🔴 ELLE EXISTE POUR NE PAS PRENDRE LES CLIENTS EN OTAGE. Chacune de ces portes a un budget COMMUN pour les
 * clés qu'elle n'a jamais vues, pris AVANT la lecture en base : sans cette exception, une attaque qui épuise le
 * budget refuserait aussi les appelants légitimes, c'est-à-dire qu'un attaquant couperait le service à notre
 * place. Une clé déjà reconnue échappe donc au budget.
 *
 * 🔴 ELLE NE MET RIEN EN CACHE, ET LA NUANCE EST TOUTE LA SÉCURITÉ. Elle ne dit pas « cette clé est valide »,
 * elle dit « cette clé a déjà été résolue une fois, elle ne sert pas à sonder » : la lecture en base a lieu À
 * CHAQUE FOIS, donc une clé révoquée ou un webhook éteint cessent de passer immédiatement. Et une clé qui cesse
 * de se résoudre est OUBLIÉE : sinon son porteur échapperait au budget tout en échouant à chaque lecture, donc
 * martèlerait la base sans qu'aucun plafond ne le compte.
 *
 * ⚠️ BORNÉE : au plafond, on oublie la plus ancienne. Les vrais appelants reviennent régulièrement, donc ils se
 * réinscrivent. Ce n'est pas une table indexée sur une valeur que l'appelant choisit : on n'y entre qu'après
 * une résolution réussie.
 */
export class ClesResolues {
  private readonly vues = new Set<string>();
  constructor(private readonly max: number) {}
  connait(cle: string): boolean { return this.vues.has(cle); }
  oublier(cle: string): void { this.vues.delete(cle); }
  retenir(cle: string): void {
    if (this.vues.has(cle)) return;
    if (this.vues.size >= this.max) {
      const plusAncienne = this.vues.values().next().value;
      if (plusAncienne !== undefined) this.vues.delete(plusAncienne);
    }
    this.vues.add(cle);
  }
}
