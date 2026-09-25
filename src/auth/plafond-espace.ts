import type { FastifyReply } from 'fastify';
import { RateLimiter, refuserTropDeRequetes } from './rate-limit';
import { journaliser } from '../lib/journal';

/**
 * LE PLAFOND DE L'API PUBLIQUE PAR ESPACE (décision de Julien du 2026-09-25, migration 0181).
 *
 * 🔴 IL REMPLACE LE PLAFOND PAR CLÉ, ET C'EST TOUT LE SUJET. Compté par clé, un espace qui créait dix clés
 * avait dix fois le débit : le plafond ne bornait que la patience de l'intégrateur à cliquer « Créer une clé ».
 * Il est désormais COMMUN à toutes les clés d'un espace, `/v1` et `/mcp` confondus, sur DEUX fenêtres qui
 * s'appliquent ensemble : une minute ET une heure.
 *
 * ⚠️ IL COMPTE DES APPELS, PAS DU TRAVAIL : un lot de 500 fiches vaut un appel. Le travail est mesuré à part par
 * le garde d'usage (`src/api/usage-guard.ts`), qui n'a pas bougé.
 *
 * 🔴 UNE EXCEPTION, ET ELLE N'EST PAS ICI : la clé du relais du Meta Business Agent garde son propre compteur par
 * clé et n'entre JAMAIS dans ce plafond (`makeRequireApiKey`). Un intégrateur qui charge l'API ne doit pas priver
 * l'agent de Meta de ses outils en pleine conversation avec un client.
 *
 * 🔴 LOCAL AU PROCESS, comme tous les limiteurs du dépôt (`rate-limit.ts`) : le plafond annoncé est celui d'UNE
 * instance. Avec deux process d'API, un espace disposerait du double sans que rien ne le signale. Il n'y a qu'une
 * instance aujourd'hui ; le jour d'une seconde, le compteur part en base ou dans un cache partagé.
 */

/** Les plafonds par défaut, tranchés par Julien le 2026-09-25. La configuration les reprend (`config.ts`). */
export const PLAFOND_API_DEFAUT = { minute: 60, heure: 1000 } as const;

export const FENETRE_MINUTE_MS = 60_000;
export const FENETRE_HEURE_MS = 3_600_000;

/**
 * Combien de temps le réglage d'un espace est gardé en mémoire avant d'être relu.
 *
 * ⚠️ COURT, ET REMPLACÉ À L'ÉCRITURE : la route d'exploitation qui règle un espace y pose la valeur écrite, donc ce délai
 * ne compte que pour une écriture faite AILLEURS (à la main en base). Il existe parce que le limiteur est sur le
 * chemin de CHAQUE appel : sans lui, chaque appel paierait une requête de plus.
 */
export const DUREE_CACHE_REGLAGE_MS = 30_000;

/** Le réglage d'un espace (`tenant_settings.api_plafond_minute` et `_heure`). `null` = le défaut de la configuration. */
export interface ReglagePlafondApi {
  readonly minute: number | null;
  readonly heure: number | null;
}

export const SANS_REGLAGE: ReglagePlafondApi = { minute: null, heure: null };

/** Les plafonds de la configuration. ⚠️ `0` = pas de plafond sur cette fenêtre, la convention de tout le dépôt. */
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
 * Le réglage d'un espace, gardé `DUREE_CACHE_REGLAGE_MS` et remplacé par `poser` quand la route d'exploitation l'écrit.
 *
 * ⚠️ UNE LECTURE EN VOL EST PARTAGÉE : la promesse elle-même est gardée, donc une rafale d'appels simultanés d'un
 * même espace ne produit qu'UNE requête.
 *
 * 🔴 UNE LECTURE QUI ÉCHOUE NE COUPE PAS L'API, ET NE L'OUVRE PAS NON PLUS. On garde le dernier réglage connu,
 * sinon on applique le défaut de la configuration, c'est-à-dire un plafond. Le cas attendu est un code déployé
 * avant sa migration (`42703`) : l'API reste servie au défaut. L'échec se journalise au plus une fois par minute,
 * jamais une fois par appel.
 *
 * ⚠️ La table est bornée par le nombre d'ESPACES qui ont une clé résolue par ce process : on n'y entre qu'après
 * une résolution réussie, jamais sur une valeur choisie par l'appelant.
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
   * Pose le réglage qu'on VIENT D'ÉCRIRE en base, pour une durée de cache neuve. Appelé par la route d'exploitation,
   * après son écriture.
   *
   * 🔴 IL REMPLACE `invalider`, QUI SUPPRIMAIT L'ENTRÉE (relecture du 2026-09-25). Supprimée, elle emportait le
   * « dernier réglage connu » : si la relecture suivante échouait sur un incident de base passager, l'espace qu'un
   * opérateur venait de relever à 600 appels par minute retombait au défaut de 60 pendant toute la durée du cache.
   * Poser la valeur écrite est plus juste que la relire : c'est exactement ce que la base contient, et c'est elle
   * qu'une lecture en échec gardera ensuite.
   *
   * ⚠️ APRÈS l'écriture, jamais avant : une lecture partie avant l'écriture peut encore se résoudre, mais elle ne
   * touche plus la table (l'entrée qu'elle avait posée est remplacée ici), donc elle ne peut pas y remettre l'ancien.
   */
  poser(tenantId: string, reglage: ReglagePlafondApi): void {
    this.entrees.set(tenantId, { valeur: Promise.resolve(reglage), expire: this.now() + this.dureeMs });
  }
}

/**
 * Les deux fenêtres d'un espace. Un appel passe s'il reste de la place dans CHACUNE ; refusé, il ne consomme rien.
 *
 * 🔴 LES DEUX SE VÉRIFIENT AVANT QU'AUCUNE NE CONSOMME. Prendre la minute puis constater l'heure pleine ferait
 * payer à l'espace un appel qu'on lui refuse. Rien n'est attendu entre la lecture et la prise, donc la paire est
 * atomique dans ce process.
 */
export class PlafondEspace {
  private readonly minute: RateLimiter;
  private readonly heure: RateLimiter;

  constructor(
    private readonly defauts: PlafondsParDefaut,
    private readonly reglages: LecteurReglagePlafond,
    now: () => number = () => Date.now(),
  ) {
    // Aucun plafond de clés : la clé est l'ESPACE d'une clé résolue, jamais une valeur choisie par l'appelant.
    this.minute = new RateLimiter(defauts.minute, FENETRE_MINUTE_MS, now);
    this.heure = new RateLimiter(defauts.heure, FENETRE_HEURE_MS, now);
  }

  /**
   * Compte un appel de l'espace et pose les en-têtes `x-ratelimit-*`. `false` = refusé, le 429 est DÉJÀ parti.
   *
   * ⚠️ LES EN-TÊTES DÉCRIVENT LA FENÊTRE LA PLUS PROCHE DE SON PLAFOND : `x-ratelimit-remaining` est alors le
   * nombre d'appels qui passeront encore avant un refus, quelle que soit la fenêtre qui le prononcera. En début
   * d'heure c'est la minute ; quand l'heure s'épuise, c'est elle.
   *
   * ⚠️ AU REFUS, `retry-after` vaut l'attente de la fenêtre pleine qui se libère LE PLUS TARD : réessayer à la fin
   * de la minute quand l'heure est pleine rendrait un second 429. Le message nomme cette fenêtre et son plafond.
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
