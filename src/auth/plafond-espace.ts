import type { FastifyReply } from 'fastify';
import { refuserTropDeRequetes } from './rate-limit';
import { restantDe, type CompteurDebit, type EtatFenetre, type VerdictDebit } from '../db/debit';
import { journaliser } from '../lib/journal';

/**
 * Le plafond de l'API publique par espace, commun à toutes les clés d'un espace, `/v1` et `/mcp` confondus,
 * sur deux fenêtres appliquées ensemble (minute et heure) : compté par clé, un espace à dix clés aurait dix
 * fois le débit. Il compte des appels, pas du travail (un lot de 50 fiches vaut un appel) : le travail se
 * mesure dans `src/api/usage-guard.ts`.
 *
 * La clé du relais du Meta Business Agent garde son propre compteur et n'entre jamais ici
 * (`makeRequireApiKey`) : un intégrateur qui charge l'API ne doit pas priver l'agent de Meta de ses outils.
 *
 * 🔴 PARTAGÉ PAR TOUTES LES COPIES DE L'API (lot B, 2026-09-28) : les deux fenêtres se comptent dans le compteur en
 * base (`src/db/debit.ts`), donc un espace a son plafond au TOTAL, quel que soit le nombre de copies. Fenêtres fixes
 * alignées sur l'heure de la base (la minute commence à la minute pleine, l'heure à l'heure pleine) : `retry-after`
 * et `x-ratelimit-reset` disent la fin de CETTE fenêtre-là.
 *
 * 🔴 SI LA BASE NE RÉPOND PAS, L'APPEL PASSE, sans en-têtes, et l'échec se journalise une fois par minute. Choisi :
 * refuser tous les intégrateurs sur une panne de quelques secondes déclencherait leurs rejeux au moment où la base
 * revient, et la route elle-même a besoin de la base (elle échouera si la panne est réelle). Le pire cas est un
 * plafond non tenu le temps de la panne, jamais un client coupé par elle.
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

/**
 * Le réglage d'un espace : son plafond d'appels (`tenant_settings.api_plafond_minute` et `_heure`, 0181) et ses quotas
 * quotidiens (`api_quota_envois_jour` et `api_quota_fiches_jour`, 0208, `src/api/quotas.ts`). `null` = le défaut de la
 * configuration. Une seule lecture par espace sert les deux : le limiteur d'appels et le garde d'usage.
 */
export interface ReglagePlafondApi {
  readonly minute: number | null;
  readonly heure: number | null;
  readonly envoisJour: number | null;
  readonly fichesJour: number | null;
}

export const SANS_REGLAGE: ReglagePlafondApi = { minute: null, heure: null, envoisJour: null, fichesJour: null };

/**
 * Le réglage d'un espace qu'on n'a PAS PU lire (première lecture en échec, aucun réglage connu avant) : les mêmes
 * valeurs que `SANS_REGLAGE`, mais une autre instance, que le garde d'usage reconnaît par identité. Le limiteur
 * d'appels y lit les défauts (une minute de trop au pire) ; le quota, lui, laisse passer (`estReglageInconnu`) : un
 * espace dont on a relevé le quota retomberait sinon au défaut, et son intégrateur, qui respecte `retry-after`,
 * s'arrêterait jusqu'à minuit pour une lecture ratée.
 */
export const REGLAGE_INCONNU: ReglagePlafondApi = { minute: null, heure: null, envoisJour: null, fichesJour: null };

/** Le réglage rendu est-il un repli sur une lecture ratée ? */
export function estReglageInconnu(r: unknown): boolean {
  return r === REGLAGE_INCONNU;
}

/** Les plafonds d'appels de la configuration. `0` = pas de plafond sur cette fenêtre, la convention du dépôt. */
export interface PlafondsAppelsParDefaut {
  readonly minute: number;
  readonly heure: number;
}

/** Les plafonds et les quotas quotidiens de la configuration. `0` = pas de quota. */
export interface PlafondsParDefaut extends PlafondsAppelsParDefaut {
  readonly envoisJour: number;
  readonly fichesJour: number;
}

/** Ce que la route d'exploitation lit et écrit (`PgPlafondEspaceStore`). */
export interface PlafondApiStore {
  /** Le réglage de l'espace, ou `null` si l'espace n'existe pas. Un espace sans réglage rend `SANS_REGLAGE`. */
  lire(tenantId: string): Promise<ReglagePlafondApi | null>;
  /** Écrit les quatre colonnes d'un coup (plafond et quotas). `false` si l'espace n'existe pas. */
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
        return precedent ?? REGLAGE_INCONNU;
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
 * consomme rien, ni la minute ni l'heure (le compteur les compte toutes ou aucune).
 */
export class PlafondEspace {
  private dernierAvertissement = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly defauts: PlafondsAppelsParDefaut,
    private readonly reglages: LecteurReglagePlafond,
    /** Le compteur partagé par les copies de l'API. Aucun plafond de clés : la clé est l'espace d'une clé résolue. */
    private readonly compteur: CompteurDebit,
  ) {}

  /**
   * Compte un appel de l'espace et pose les en-têtes `x-ratelimit-*` ; `false` = refusé, le 429 est déjà
   * parti. Les en-têtes décrivent la fenêtre la plus proche de son plafond. Au refus, `retry-after` vaut
   * l'attente de la fenêtre pleine qui se libère le plus tard : réessayer à la fin de la minute quand l'heure
   * est pleine rendrait un second 429.
   */
  async consommer(tenantId: string, reply: FastifyReply): Promise<boolean> {
    const reglage = await this.reglages.reglage(tenantId);
    const fenetres = [
      { nom: 'minute', dureeMs: FENETRE_MINUTE_MS, max: reglage.minute ?? this.defauts.minute },
      { nom: 'heure', dureeMs: FENETRE_HEURE_MS, max: reglage.heure ?? this.defauts.heure },
    ].filter((f) => f.max > 0);
    // Aucune fenêtre active : aucun en-tête. Annoncer une limite de 0 sur un appel accepté serait faux.
    if (fenetres.length === 0) return true;

    let verdict: VerdictDebit;
    try {
      verdict = await this.compteur.compter(fenetres.map((f) => ({ cle: `api.${f.nom}|${tenantId}`, dureeMs: f.dureeMs, max: f.max })));
    } catch (err) {
      // La politique écrite en tête de fichier : l'appel passe, sans en-têtes, et la panne se dit une fois par minute.
      const t = Date.now();
      if (t - this.dernierAvertissement >= 60_000) {
        this.dernierAvertissement = t;
        journaliser('error', 'plafond_api_compteur_indisponible', { tenantId, err });
      }
      return true;
    }
    const etats: Array<{ nom: string; max: number; etat: EtatFenetre }> = fenetres.map((f, i) => ({ nom: f.nom, max: f.max, etat: verdict.fenetres[i]! }));

    if (!verdict.accepte) {
      // Une fenêtre au moins est pleine (c'est la seule raison d'un refus) ; le repli sur toutes n'est qu'une ceinture.
      const pleines = etats.filter((f) => f.etat.pleine);
      const bloquante = (pleines.length > 0 ? pleines : etats).reduce((a, b) => (b.etat.finMs > a.etat.finMs ? b : a));
      annoncer(reply, bloquante.max, 0, bloquante.etat.finMs);
      await refuserTropDeRequetes(
        reply,
        bloquante.etat.finMs - verdict.maintenantMs,
        `trop de requêtes : plafond de l’espace atteint, ${bloquante.max} appels par ${bloquante.nom}`,
        'rate_limited',
      );
      return false;
    }
    const annoncee = etats.reduce((a, b) => (restantDe(b.etat) < restantDe(a.etat) ? b : a));
    annoncer(reply, annoncee.max, restantDe(annoncee.etat), annoncee.etat.finMs);
    return true;
  }
}

function annoncer(reply: FastifyReply, limite: number, restant: number, resetAt: number): void {
  reply.header('x-ratelimit-limit', String(limite));
  reply.header('x-ratelimit-remaining', String(Math.max(0, restant)));
  reply.header('x-ratelimit-reset', String(Math.ceil(resetAt / 1000)));
}
