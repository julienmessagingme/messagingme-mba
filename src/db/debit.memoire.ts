import { debutDeFenetre, normaliserComptages, type CompteurDebit, type LigneCompteur, type VerdictDebit } from './debit';

/**
 * Le compteur de débit d'UNE seule copie, aux mêmes règles que l'adaptateur Postgres (`debit.pg.ts`) : fenêtres
 * fixes, toutes les fenêtres ou aucune, un appel compté seulement s'il tient sous chaque plafond.
 *
 * ⚠️ UNE DIFFÉRENCE, délibérée : ses fenêtres partent de l'instant de sa CRÉATION, pas de l'époque. En base, l'époque
 * est l'origine commune qui fait tomber toutes les copies dans la même fenêtre ; ici il n'y a qu'une copie, et une
 * origine à la création évite qu'un test qui compte cinq appels en quelques millisecondes ne tombe, une fois sur
 * dix mille, à cheval sur une minute pleine. Une horloge de test qui part d'un multiple de la fenêtre donne les
 * mêmes fenêtres que la base.
 *
 * 🔴 Il ne sert qu'à un serveur construit SANS base (`buildServer` sans `debit` : les tests, l'auto-attaque) et de
 * double aux tests, où deux « copies » qui partagent une instance partagent leurs compteurs. Le câblage de
 * production passe `PgCompteurDebit` (`src/index.ts`, tenu par `tests/debit-cablage.test.ts`) : ici, chaque copie
 * compterait pour elle seule, et un plafond serait servi autant de fois qu'il y a de copies.
 */
export class CompteurDebitMemoire implements CompteurDebit {
  /** `cle` et début de fenêtre -> la ligne. La clé de la Map sépare les deux par un caractère qu'aucune clé ne porte. */
  private readonly lignes = new Map<string, { cle: string; debutMs: number; n: number; expireMs: number }>();

  /** L'origine de ses fenêtres : l'instant de sa création (voir plus haut). */
  private readonly origine: number;

  constructor(private readonly maintenant: () => number = () => Date.now()) {
    this.origine = maintenant();
  }

  // Aucun `await` entre la vérification et l'écriture : les deux forment un seul geste, comme l'instruction en base.
  async compter(comptages: Parameters<CompteurDebit['compter']>[0]): Promise<VerdictDebit> {
    const demandes = normaliserComptages(comptages);
    const t = this.maintenant();
    this.oublierLesEchues(t);
    const lues = demandes.map((c) => {
      // Une origine donnée (le minuit d'un jour civil) est absolue, comme en base ; sinon celle de la création.
      const debutMs = c.origineMs !== null ? debutDeFenetre(t, c.dureeMs, c.origineMs) : this.origine + debutDeFenetre(t - this.origine, c.dureeMs);
      const id = `${c.cle}\u0000${debutMs}`;
      const n = this.lignes.get(id)?.n ?? 0;
      return { c, debutMs, id, n, tient: c.max === null || n + c.pas <= c.max };
    });
    const accepte = lues.every((l) => l.tient);
    if (accepte) {
      for (const l of lues) {
        this.lignes.set(l.id, { cle: l.c.cle, debutMs: l.debutMs, n: l.n + l.c.pas, expireMs: l.debutMs + l.c.dureeMs + l.c.garderMs });
      }
    }
    return {
      accepte,
      maintenantMs: t,
      fenetres: lues.map((l) => ({
        cle: l.c.cle,
        max: l.c.max,
        pleine: !l.tient,
        compte: !l.tient ? null : accepte ? l.n + l.c.pas : l.n,
        finMs: l.debutMs + l.c.dureeMs,
      })),
    };
  }

  async lister(prefixe: string, depuisMs: number): Promise<LigneCompteur[]> {
    const t = this.maintenant();
    this.oublierLesEchues(t);
    return [...this.lignes.values()]
      .filter((l) => l.cle.startsWith(prefixe) && l.debutMs >= t - depuisMs)
      .sort((a, b) => b.debutMs - a.debutMs)
      .map((l) => ({ cle: l.cle, debutMs: l.debutMs, n: l.n }));
  }

  /** Comme la purge du worker : une ligne dont l'échéance est passée ne sert plus. */
  private oublierLesEchues(t: number): void {
    for (const [id, l] of this.lignes) if (l.expireMs <= t) this.lignes.delete(id);
  }
}
