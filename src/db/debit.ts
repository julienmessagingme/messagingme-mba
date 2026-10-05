/**
 * Les compteurs des plafonds de débit, partagés par toutes les copies de l'API (table `compteurs_debit`, migration
 * 0186). Un plafond qui compte dans la mémoire de son processus est servi N fois par N copies : ce qui doit tenir
 * au TOTAL (l'API publique d'un espace, les opérations coûteuses, les tentatives de connexion, l'usage montré par
 * `/ops`) se compte ici.
 *
 * Trois règles, les mêmes pour l'adaptateur Postgres (`debit.pg.ts`) et pour le compteur d'une seule copie
 * (`debit.memoire.ts`) :
 * - la fenêtre est FIXE et alignée sur l'heure du compteur (celle de la base) : toutes les copies comptent dans la
 *   même fenêtre, quelle que soit leur horloge ;
 * - un appel se compte dans TOUTES ses fenêtres ou dans AUCUNE : un appel refusé par la minute ne consomme pas
 *   l'heure, sinon un client qui réessaie pendant un refus brûlerait son budget horaire sans rien obtenir ;
 * - un appel n'est compté que s'il tient sous le plafond de chaque fenêtre (`n + pas <= max`) : un refus n'ajoute
 *   rien, donc il ne repousse pas la réouverture.
 *
 * 🔴 Ce module compte, il ne décide pas quoi faire quand la base ne répond pas : `compter` lève, et chaque plafond
 * écrit sa propre politique (laisser passer l'API publique, refuser une connexion).
 */

/** Une fenêtre où compter un appel. */
export interface Comptage {
  /**
   * La clé du compteur, préfixée par son usage (`api.minute|<espace>`). Une clé se compte toujours sur la même
   * durée : deux durées sur une même clé partageraient des lignes.
   */
  readonly cle: string;
  /** La durée de la fenêtre, en millisecondes (entier positif). */
  readonly dureeMs: number;
  /** Le plafond de la fenêtre : l'appel n'est compté que si `n + pas` n'y dépasse pas. `null` = compter sans plafond. */
  readonly max: number | null;
  /** Ce que vaut l'appel : 1 par défaut, les unités de travail d'un lot pour l'usage de l'API publique. */
  readonly pas?: number;
  /** Combien de temps garder la ligne après la fin de sa fenêtre (0 par défaut) : ce que `lister` peut encore montrer. */
  readonly garderMs?: number;
  /**
   * L'origine des fenêtres, en millisecondes depuis l'époque (l'époque par défaut). Elle sert une fenêtre qui doit
   * commencer à une heure civile : le jour d'un quota commence à minuit, heure de Paris, et non à minuit UTC. La clé
   * porte alors la date, la durée est celle de CE jour (23, 24 ou 25 h au changement d'heure) et l'origine son minuit :
   * la fenêtre finit pile au minuit suivant, ce que dit le délai de réessai.
   */
  readonly origineMs?: number | null;
}

/** Un comptage validé, tel que les adaptateurs l'écrivent. */
export interface ComptageNormalise {
  readonly cle: string;
  readonly dureeMs: number;
  readonly max: number | null;
  readonly pas: number;
  readonly garderMs: number;
  /** `null` = l'époque : les fenêtres des plafonds par minute ou par heure tombent sur les minutes et heures pleines. */
  readonly origineMs: number | null;
}

/** Une fenêtre, après l'appel. */
export interface EtatFenetre {
  readonly cle: string;
  readonly max: number | null;
  /** L'appel n'y tenait pas : c'est elle qui refuse. */
  readonly pleine: boolean;
  /**
   * Le compte de la fenêtre après l'appel (compté s'il est accepté, rendu s'il est refusé), `null` quand il n'est pas
   * connu : fenêtre pleine, ou verdict rendu par la mémoire d'une copie (`memoireDesPleines`).
   */
  readonly compte: number | null;
  /** La fin de la fenêtre, en millisecondes depuis l'époque, sur l'horloge du compteur. */
  readonly finMs: number;
}

export interface VerdictDebit {
  /** L'appel est compté dans toutes ses fenêtres. Refusé, il n'est compté dans aucune. */
  readonly accepte: boolean;
  /**
   * L'heure du compteur, en millisecondes : une attente se calcule sur elle (`finMs - maintenantMs`), jamais sur
   * l'horloge de la copie, qui peut différer de celle de la base.
   */
  readonly maintenantMs: number;
  /** Une entrée par comptage demandé, dans l'ordre de la demande. */
  readonly fenetres: readonly EtatFenetre[];
}

/** Une ligne de compteur, telle que `lister` la rend. */
export interface LigneCompteur {
  readonly cle: string;
  /** Le début de sa fenêtre, en millisecondes depuis l'époque. */
  readonly debutMs: number;
  readonly n: number;
}

export interface CompteurDebit {
  /**
   * Compte un appel dans chacune de ces fenêtres, toutes ou aucune. Atomique par fenêtre : de deux appels
   * simultanés qui se disputent la dernière place, un seul l'obtient. Lève si le compteur ne répond pas.
   */
  compter(comptages: ReadonlyArray<Comptage>): Promise<VerdictDebit>;
  /**
   * Les lignes dont la clé commence par `prefixe` et dont la fenêtre a commencé il y a moins de `depuisMs`, de la
   * plus récente à la plus ancienne. Sert `/ops/usage` ; aucune décision ne se prend dessus.
   */
  lister(prefixe: string, depuisMs: number): Promise<LigneCompteur[]>;
}

/** Le début de la fenêtre qui contient `maintenantMs`. Le même calcul que la base (`origine + floor((ms - origine) / durée) * durée`). */
export function debutDeFenetre(maintenantMs: number, dureeMs: number, origineMs = 0): number {
  return origineMs + Math.floor((maintenantMs - origineMs) / dureeMs) * dureeMs;
}

const entierPositif = (v: number): boolean => Number.isInteger(v) && v > 0;

/**
 * Les comptages tels qu'un adaptateur les écrit, validés. Une liste vide, une clé en double (Postgres refuse de
 * toucher deux fois la même ligne dans une instruction), une durée, un pas ou un plafond qui n'est pas un entier
 * positif sont des fautes d'appel, jamais un comptage.
 */
export function normaliserComptages(comptages: ReadonlyArray<Comptage>): ComptageNormalise[] {
  if (comptages.length === 0) throw new Error('compteur de débit : aucun comptage demandé');
  const vues = new Set<string>();
  return comptages.map((c) => {
    const pas = c.pas ?? 1;
    const garderMs = c.garderMs ?? 0;
    const origineMs = c.origineMs ?? null;
    if (c.cle === '' || vues.has(c.cle)) throw new Error(`compteur de débit : clé vide ou en double (${c.cle})`);
    if (!entierPositif(c.dureeMs) || !entierPositif(pas) || (c.max !== null && !entierPositif(c.max))
      || !Number.isInteger(garderMs) || garderMs < 0 || (origineMs !== null && !Number.isInteger(origineMs))) {
      throw new Error(`compteur de débit : durée, pas, plafond, conservation ou origine invalide (${c.cle})`);
    }
    vues.add(c.cle);
    return { cle: c.cle, dureeMs: c.dureeMs, max: c.max, pas, garderMs, origineMs };
  });
}

/** Ce qui reste dans une fenêtre après l'appel ; 0 quand elle est pleine ou que son compte n'est pas connu. */
export function restantDe(f: EtatFenetre): number {
  if (f.max === null) return Number.POSITIVE_INFINITY;
  return f.pleine || f.compte === null ? 0 : Math.max(0, f.max - f.compte);
}

/** Combien d'entrées la mémoire d'une copie garde au plus : ses clés peuvent venir de l'appelant (connexion). */
const MAX_PLEINES_MEMORISEES = 10_000;

/**
 * La mémoire des fenêtres pleines d'UNE copie, posée devant le compteur partagé.
 *
 * 🔴 POURQUOI : sans elle, chaque appel refusé coûterait une écriture en base. Un intégrateur dont la boucle
 * réessaie mille fois par seconde contre un plafond atteint ferait mille écritures par seconde sur un pool de huit
 * connexions, et la console tomberait avec lui ; en mémoire, ces refus ne coûtaient rien. Une fenêtre vue pleine le
 * reste jusqu'à sa fin (son compte ne redescend pas), donc la copie refuse elle-même jusque-là, sans la base.
 *
 * Deux gardes la rendent juste : elle ne sert que pour un plafond au plus égal à celui qui a été vu plein (un
 * plafond relevé par `/ops` repasse tout de suite par la base), et pour un pas au moins égal. Sa fin est convertie
 * sur l'horloge de la copie au moment du refus, pour que l'écart entre les deux horloges ne la décale pas.
 */
export function memoireDesPleines(
  compteur: CompteurDebit,
  maintenant: () => number = () => Date.now(),
  maxEntrees = MAX_PLEINES_MEMORISEES,
): CompteurDebit {
  const pleines = new Map<string, { max: number; pas: number; finMs: number; finLocale: number }>();
  const connue = (c: ComptageNormalise, t: number) => {
    const p = pleines.get(c.cle);
    if (!p) return null;
    if (t >= p.finLocale) {
      pleines.delete(c.cle);
      return null;
    }
    return c.max !== null && c.max <= p.max && c.pas >= p.pas ? p : null;
  };
  const retenir = (cle: string, valeur: { max: number; pas: number; finMs: number; finLocale: number }, t: number) => {
    if (!pleines.has(cle) && pleines.size >= maxEntrees) {
      for (const [k, p] of pleines) if (t >= p.finLocale) pleines.delete(k);
      // Toujours pleine : on ne retient pas, la base répondra. Refuser d'apprendre coûte une écriture, pas un refus.
      if (pleines.size >= maxEntrees) return;
    }
    pleines.set(cle, valeur);
  };
  return {
    async compter(comptages) {
      const demandes = normaliserComptages(comptages);
      const t = maintenant();
      const deja = demandes.map((c) => connue(c, t));
      const premiere = deja.find((p) => p !== null);
      if (premiere) {
        // L'heure du compteur, estimée depuis celle du refus mémorisé : l'attente annoncée reste celle de la base.
        const maintenantMs = t + (premiere.finMs - premiere.finLocale);
        return {
          accepte: false,
          maintenantMs,
          fenetres: demandes.map((c, i) => {
            const p = deja[i];
            return p
              ? { cle: c.cle, max: c.max, pleine: true, compte: null, finMs: p.finMs }
              : { cle: c.cle, max: c.max, pleine: false, compte: null, finMs: debutDeFenetre(maintenantMs, c.dureeMs, c.origineMs ?? 0) + c.dureeMs };
          }),
        };
      }
      const verdict = await compteur.compter(demandes);
      const apres = maintenant();
      demandes.forEach((c, i) => {
        const f = verdict.fenetres[i];
        if (f?.pleine && c.max !== null) {
          retenir(c.cle, { max: c.max, pas: c.pas, finMs: f.finMs, finLocale: apres + (f.finMs - verdict.maintenantMs) }, apres);
        }
      });
      return verdict;
    },
    lister: (prefixe, depuisMs) => compteur.lister(prefixe, depuisMs),
  };
}
