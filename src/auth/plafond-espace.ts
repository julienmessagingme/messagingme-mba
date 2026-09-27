import type { FastifyReply } from 'fastify';
import { RateLimiter, refuserTropDeRequetes } from './rate-limit';
import { journaliser } from '../lib/journal';

/**
 * Le plafond de l'API publique par espace, commun à toutes les clés d'un espace, `/v1` et `/mcp` confondus,
 * sur deux fenêtres appliquées ensemble (minute et heure) : compté par clé, un espace à dix clés aurait dix
 * fois le débit. Il compte des appels, pas du travail (un lot de 50 fiches vaut un appel) : le travail se
 * mesure dans `src/api/usage-guard.ts`.
 *
 * La clé du relais du Meta Business Agent garde son propre compteur et n'entre jamais ici
 * (`makeRequireApiKey`) : un intégrateur qui charge l'API ne doit pas priver l'agent de Meta de ses outils.
 * Local au process : avec deux instances d'API, un espace aurait le double sans que rien le signale.
 */

/** Les plafonds par défaut ; la configuration les reprend (`config.ts`). */
export const PLAFOND_API_DEFAUT = { minute: 60, heure: 1000 } as const;

export const FENETRE_MINUTE_MS = 60_000;
export const FENETRE_HEURE_MS = 3_600_000;

/**
 * Combien de temps le réglage d'un espace reste en mémoire avant relecture. Court, et remplacé à l'écriture
 * par la route d'exploitation : il ne compte que pour une écriture faite ailleurs. Sans lui, chaque appel
 * paierait une requête de plus.
 */
export const DUREE_CACHE_REGLAGE_MS = 30_000;

/** Le réglage d'un espace (`tenant_settings.api_plafond_minute` et `_heure`). `null` = le défaut de la configuration. */
export interface ReglagePlafondApi {
  readonly minute: number | null;
  readonly heure: number | null;
}

export const SANS_REGLAGE: ReglagePlafondApi = { minute: null, heure: null };

/** Les plafonds de la configuration. `0` = pas de plafond sur cette fenêtre, la convention du dépôt. */
export interface PlafondsParDefaut {
  readonly minute: number;
  readonly heure: number;
}

/** Ce que la route d'exploitation lit et écrit (`PgPlafondEspaceStore`). */
export interface PlafondApiStore {
  /** Le réglage de l'espace, ou `null` si l'espace n'existe pas. Un espace sans réglage rend `SANS_REGLAGE`. */
  lire(tenantId: string): Promise<ReglagePlafondApi | null>;
  /** Écrit les deux colonnes d'un coup. `false` si l'espace n'existe pas. */
  ecrire(tenantId: string, reglage: ReglagePlafondApi): Promise<boolean>;
}

export interface LecteurReglagePlafond {
  reglage(tenantId: string): Promise<ReglagePlafondApi>;
}

/**
 * Le réglage d'un espace, gardé `DUREE_CACHE_REGLAGE_MS` et remplacé par `poser` à l'écriture. Une lecture
 * en vol est partagée : une rafale d'un même espace ne fait qu'une requête.
 *
 * Une lecture qui échoue ne coupe pas l'API et ne l'ouvre pas : on garde le dernier réglage connu, sinon le
 * défaut de la configuration (un code déployé avant sa migration reste servi). L'échec se journalise au plus
 * une fois par minute. La table est bornée par les espaces qui ont une clé résolue, jamais par une valeur
 * choisie par l'appelant.
 */
export class ReglagesPlafondEnCache implements LecteurReglagePlafond {
  private readonly entrees = new Map<string, { valeur: Promise<ReglagePlafondApi>; expire: number }>();
  private dernierAvertissement = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly lire: (tenantId: string) => Promise<ReglagePlafondApi | null>,
    private readonly dureeMs = DUREE_CACHE_REGLAGE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  reglage(tenantId: string): Promise<ReglagePlafondApi> {
    const t = this.now();
    const entree = this.entrees.get(tenantId);
    if (entree && t < entree.expire) return entree.valeur;
    const precedent = entree?.valeur;
    const valeur = this.lire(tenantId).then(
      (r) => r ?? SANS_REGLAGE,
      (err: unknown) => {
        if (t - this.dernierAvertissement >= 60_000) {
          this.dernierAvertissement = t;
          journaliser('warn', 'plafond_api_reglage_illisible', { tenantId, err });
        }
        return precedent ?? SANS_REGLAGE;
      },
    );
    this.entrees.set(tenantId, { valeur, expire: t + this.dureeMs });
    return valeur;
  }

  /**
   * Pose le réglage qu'on vient d'écrire en base, pour une durée de cache neuve (appelé par la route
   * d'exploitation, après son écriture). Plutôt que supprimer l'entrée : une relecture en échec retomberait
   * sinon au défaut, perdant le réglage que l'opérateur vient de poser. Après l'écriture, jamais avant : une
   * lecture partie avant ne peut plus remettre l'ancien dans la table.
   */
  poser(tenantId: string, reglage: ReglagePlafondApi): void {
    this.entrees.set(tenantId, { valeur: Promise.resolve(reglage), expire: this.now() + this.dureeMs });
  }
}

/**
 * Les deux fenêtres d'un espace : un appel passe s'il reste de la place dans chacune, et refusé il ne
 * consomme rien. Les deux se vérifient avant qu'aucune ne consomme (rien n'est attendu entre les deux, la
 * paire est atomique dans ce process).
 */
export class PlafondEspace {
  private readonly minute: RateLimiter;
  private readonly heure: RateLimiter;

  constructor(
    private readonly defauts: PlafondsParDefaut,
    private readonly reglages: LecteurReglagePlafond,
    now: () => number = () => Date.now(),
  ) {
    // Aucun plafond de clés : la clé est l'espace d'une clé résolue, jamais une valeur choisie par l'appelant.
    this.minute = new RateLimiter(defauts.minute, FENETRE_MINUTE_MS, now);
    this.heure = new RateLimiter(defauts.heure, FENETRE_HEURE_MS, now);
  }

  /**
   * Compte un appel de l'espace et pose les en-têtes `x-ratelimit-*` ; `false` = refusé, le 429 est déjà
   * parti. Les en-têtes décrivent la fenêtre la plus proche de son plafond. Au refus, `retry-after` vaut
   * l'attente de la fenêtre pleine qui se libère le plus tard : réessayer à la fin de la minute quand l'heure
   * est pleine rendrait un second 429.
   */
  async consommer(tenantId: string, reply: FastifyReply): Promise<boolean> {
    const reglage = await this.reglages.reglage(tenantId);
    const fenetres = [
      { nom: 'minute', limiteur: this.minute, max: reglage.minute ?? this.defauts.minute },
      { nom: 'heure', limiteur: this.heure, max: reglage.heure ?? this.defauts.heure },
    ]
      .filter((f) => f.max > 0)
      .map((f) => ({ ...f, etat: f.limiteur.remaining(tenantId, f.max) }));
    // Aucune fenêtre active : aucun en-tête. Annoncer une limite de 0 sur un appel accepté serait faux.
    if (fenetres.length === 0) return true;

    const pleines = fenetres.filter((f) => f.etat.remaining <= 0);
    if (pleines.length > 0) {
      const bloquante = pleines.reduce((a, b) => (b.etat.attenteMs > a.etat.attenteMs ? b : a));
      annoncer(reply, bloquante.max, 0, bloquante.etat.resetAt);
      await refuserTropDeRequetes(
        reply,
        bloquante.etat.attenteMs,
        `trop de requêtes : plafond de l’espace atteint, ${bloquante.max} appels par ${bloquante.nom}`,
        'rate_limited',
      );
      return false;
    }
    for (const f of fenetres) f.limiteur.take(tenantId, f.max);
    const annoncee = fenetres.reduce((a, b) => (b.etat.remaining < a.etat.remaining ? b : a));
    annoncer(reply, annoncee.max, annoncee.etat.remaining - 1, annoncee.etat.resetAt);
    return true;
  }
}

function annoncer(reply: FastifyReply, limite: number, restant: number, resetAt: number): void {
  reply.header('x-ratelimit-limit', String(limite));
  reply.header('x-ratelimit-remaining', String(Math.max(0, restant)));
  reply.header('x-ratelimit-reset', String(Math.ceil(resetAt / 1000)));
}
