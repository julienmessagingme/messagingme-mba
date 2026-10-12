import type { Comptage, CompteurDebit } from '../db/debit';
import type { Offre } from '../offres/offres';
import { journaliser } from '../lib/journal';

/**
 * Le plafond de TOUTE la plateforme sur `/v1` et `/mcp` (lot 14, décision de Julien du 2026-10-12) : un compteur
 * partagé par tous les espaces et toutes les copies de l'API, par fenêtre de 10 secondes, Free d'abord. Les plafonds
 * par espace (`plafond-espace.ts`) bornent un espace ; aucun ne bornait leur somme, et cent espaces à leur plafond
 * font 100 appels par seconde.
 *
 * 🔴 UN COMPTEUR, DEUX PLAFONDS. Un espace de l'offre Base (Free) n'est accepté que si le compteur reste sous la part
 * Free (`partFreePct` % du plafond), un espace payant jusqu'au plafond : à la saturation, les Free reçoivent le 429 en
 * premier et Pro et Entreprise gardent le reste. Une seule clé suffit parce que la mémoire des fenêtres pleines
 * (`memoireDesPleines`) ne réutilise un refus que pour un plafond au plus égal : un refus Free ne fait jamais refuser
 * un payant.
 *
 * 🔴 COMPTÉ DANS LA MÊME INSTRUCTION QUE LES FENÊTRES DE L'ESPACE (`PlafondEspace.consommer`), toutes ou aucune : un
 * refus de l'espace ne consomme pas la plateforme (un espace qui s'emballe ne prend pas la place des autres), un refus
 * de la plateforme ne consomme pas l'espace, et la boucle d'un intégrateur refusé est servie par la mémoire, sans
 * écrire en base. Compté à part, il coûterait une écriture de plus par appel, et chaque refus en coûterait une.
 *
 * Éteint à 0 (le défaut), comme les autres plafonds du dépôt : la valeur se pose sur la mesure du banc (livraison B),
 * par variable d'environnement. La clé du relais du Meta Business Agent n'y entre jamais (elle n'atteint pas
 * `PlafondEspace`, `makeRequireApiKey`). Base muette : l'appel passe, la politique de `PlafondEspace`.
 */

export const FENETRE_GLOBALE_MS = 10_000;

/**
 * La clé du compteur de la plateforme (`compteurs_debit`). 🔴 Elle se trie APRÈS `api.heure|` et `api.minute|`, dans
 * l'ordre binaire comme dans l'ordre linguistique : `PgCompteurDebit` verrouille ses lignes `order by cle`, et celle que
 * TOUS les appels se disputent doit être prise en dernier, donc tenue le moins longtemps (tenu par son test).
 */
export const CLE_GLOBALE = 'api.zz-plateforme';

/** Le préfixe des refus, suivi de la sorte (`free`, `payant`) : la veille de charge les lit par minute. */
export const CLE_REFUS_GLOBAL = 'api.global-refus|';

/** Les refus se comptent par minute et se gardent dix minutes : de quoi lire la minute écoulée sans course. */
export const FENETRE_REFUS_MS = 60_000;
const GARDER_REFUS_MS = 600_000;

/** Les refus s'agrègent en mémoire et s'écrivent en une instruction au plus toutes les deux secondes. */
const DELAI_ECRITURE_REFUS_MS = 2_000;

export const MESSAGE_PLATEFORME_SATUREE = 'trop de requêtes : la plateforme est saturée, réessayez dans quelques secondes';

/** `parFenetre` : appels par fenêtre de 10 s, toutes offres, 0 = éteint. `partFreePct` : la part Free, de 0 à 100. */
export interface ReglagePlafondGlobal {
  readonly parFenetre: number;
  readonly partFreePct: number;
}

export type SorteAppelant = 'free' | 'payant';

/** L'offre d'un espace (`OffresEnCache`). */
export interface SourceOffre {
  offreDe(tenantId: string): Promise<{ readonly offre: Offre }>;
}

export class PlafondGlobal {
  private readonly refus: Record<SorteAppelant, number> = { free: 0, payant: 0 };
  private minuterie: ReturnType<typeof setTimeout> | null = null;
  private dernierAvertissement = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly reglage: ReglagePlafondGlobal,
    private readonly offres: SourceOffre,
    /** Le compteur partagé, pour les refus. L'appel lui-même se compte dans l'instruction de `PlafondEspace`. */
    private readonly compteur: CompteurDebit,
  ) {}

  /**
   * La fenêtre de la plateforme pour un appel de cet espace, ou `null` si le plafond est éteint. Une offre illisible
   * compte comme payante : l'offre range la file d'attente, elle ne garde rien, et la lire de travers ne doit pas
   * refuser un client qui paie.
   */
  async fenetre(tenantId: string): Promise<{ comptage: Comptage; sorte: SorteAppelant } | null> {
    const { parFenetre, partFreePct } = this.reglage;
    if (parFenetre <= 0) return null;
    let offre: Offre = 'entreprise';
    try {
      offre = (await this.offres.offreDe(tenantId)).offre;
    } catch (err) {
      this.avertir('plafond_global_offre_illisible', { tenantId, err });
    }
    const sorte: SorteAppelant = offre === 'base' ? 'free' : 'payant';
    // Une part nulle s'écrit 0 : `n + 1 <= 0` n'est jamais vrai, donc tout Free est refusé tant que le plafond est allumé.
    const max = sorte === 'free' ? Math.floor((parFenetre * partFreePct) / 100) : parFenetre;
    return { comptage: { cle: CLE_GLOBALE, dureeMs: FENETRE_GLOBALE_MS, max }, sorte };
  }

  /** Note un refus de la plateforme. Écrit en différé et groupé : une boucle de refus ne fait pas une écriture par appel. */
  noterRefus(sorte: SorteAppelant): void {
    this.refus[sorte] += 1;
    if (this.minuterie !== null) return;
    this.minuterie = setTimeout(() => void this.vider(), DELAI_ECRITURE_REFUS_MS);
    this.minuterie.unref?.();
  }

  /** Écrit les refus accumulés, en une instruction. Sans erreur : un compte de refus perdu ne coupe rien. */
  async vider(): Promise<void> {
    if (this.minuterie !== null) clearTimeout(this.minuterie);
    this.minuterie = null;
    const comptages: Comptage[] = (['free', 'payant'] as const)
      .filter((s) => this.refus[s] > 0)
      .map((s) => ({ cle: `${CLE_REFUS_GLOBAL}${s}`, dureeMs: FENETRE_REFUS_MS, max: null, pas: this.refus[s], garderMs: GARDER_REFUS_MS }));
    this.refus.free = 0;
    this.refus.payant = 0;
    if (comptages.length === 0) return;
    try {
      await this.compteur.compter(comptages);
    } catch (err) {
      this.avertir('plafond_global_refus_non_comptes', { err });
    }
  }

  private avertir(msg: string, champs: Record<string, unknown>): void {
    const t = Date.now();
    if (t - this.dernierAvertissement < 60_000) return;
    this.dernierAvertissement = t;
    journaliser('warn', msg, champs);
  }
}
