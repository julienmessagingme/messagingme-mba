import type { ApiUsageGuard, CompteurUsage, DemandeUsage, LiberationLourde, VerdictUsage } from './usage-guard';

/**
 * LE GARDE D'USAGE, EN MÉMOIRE, AGRÉGÉ PAR MINUTE.
 *
 * 🔴 IL N'EST PAS UN BROUILLON : il exerce le contrat entier, il sert les tests, et il est ce qui tourne
 * en production tant qu'il n'y a qu'une instance d'API. Le jour du multi-replica, c'est LUI qu'on
 * remplace, et rien d'autre : aucune route ne sait qu'il existe.
 *
 * 🔴 PAS UNE LIGNE SQL PAR REQUÊTE, ET C'EST UNE DÉCISION, PAS UNE ÉCONOMIE. Journaliser chaque appel en
 * base ferait amplifier par la journalisation la charge qu'elle est censée observer : sous rafale, chaque
 * requête hostile en provoquerait une seconde, chez nous, sur le budget de connexions qu'on protège.
 * L'agrégation par minute transforme une rafale de dix mille appels en une ligne.
 *
 * ⚠️ LOCAL AU PROCESS, comme les limiteurs de débit. Les compteurs décrivent CETTE instance : avec deux
 * process d'API, `/ops` en montrerait deux moitiés. Ce n'est pas un défaut aujourd'hui (il n'y a qu'une
 * instance), c'est une propriété à connaître avant d'en lancer une seconde.
 */
export class GardeUsageMemoire implements ApiUsageGuard {
  /** Clé d'agrégation -> compteur. La minute fait partie de la clé, d'où le regroupement naturel. */
  private readonly lignes = new Map<string, CompteurUsage>();

  constructor(
    /**
     * Combien de MINUTES on garde. 120 = deux heures, soit de quoi regarder une rafale après coup sans
     * ouvrir un tableau de bord au moment où elle a lieu.
     *
     * ⚠️ LA BORNE EST EN MINUTES, PAS EN LIGNES, et la nuance compte : un plafond de lignes se remplirait
     * avec les clés d'un seul espace bavard, et effacerait l'historique des autres.
     */
    private readonly minutesGardees = 120,
    /**
     * Le plafond d'unités par espace et par minute. `0` = OBSERVATION PURE : on compte, on ne refuse rien.
     *
     * 🔴 IL VAUT 0 AUJOURD'HUI, ET CE N'EST PAS UN OUBLI (plan du 2026-09-14). Aucun seuil n'est inventé
     * dans ce chantier : on compte d'abord, on regarde ce que font les vrais clients, Julien tranche
     * ensuite. Un seuil deviné qui mord est une panne qu'on s'inflige.
     */
    private readonly plafondUnitesParEspace = 0,
    private readonly maintenant: () => number = () => Date.now(),
    /**
     * COMBIEN D'OPÉRATIONS LOURDES PEUVENT ÊTRE EN VOL EN MÊME TEMPS. `0` = pas de plafond.
     *
     * 🔴 DEUX, ET LE CHIFFRE SE CALCULE : le pool porte 8 connexions pour tout le process
     * (`DB_POOL_MAX`), et un lot de contacts en demande jusqu'à 4 à la fois (`ECRITURES_EN_VOL`). Deux
     * lots en vol saturent donc exactement le pool ; le troisième obtient un 429 avec `Retry-After`
     * plutôt qu'une attente de huit secondes suivie d'une erreur d'acquisition, pendant laquelle l'Inbox
     * et le worker se battent pour les mêmes emplacements.
     *
     * ⚠️ RELEVER CE NOMBRE DEMANDE DE REFAIRE CETTE ARITHMÉTIQUE, pas seulement de changer la variable :
     * c'est la même règle que pour `DB_POOL_MAX` lui-même.
     */
    private readonly maxLourdesSimultanees = 2,
  ) {}

  /** Combien d'opérations lourdes sont en vol à cet instant. */
  private lourdesEnVol = 0;

  entrerLourde(): LiberationLourde | null {
    if (this.maxLourdesSimultanees > 0 && this.lourdesEnVol >= this.maxLourdesSimultanees) return null;
    this.lourdesEnVol += 1;
    /**
     * ⚠️ IDEMPOTENTE : la fermeture porte son propre drapeau. Une réponse peut être close deux fois (un
     * client qui coupe puis le cycle normal), et rendre deux places pour une prise ferait monter le
     * plafond tout seul, ce qui ne se verrait qu'un jour de charge.
     */
    let rendue = false;
    return () => {
      if (rendue) return;
      rendue = true;
      this.lourdesEnVol -= 1;
    };
  }

  demander(demande: DemandeUsage): VerdictUsage {
    const minute = Math.floor(this.maintenant() / 60_000) * 60_000;
    this.oublierLeVieux(minute);
    const ligne = this.ligneDe(minute, demande);

    const verdict = this.verdict(minute, demande);
    if (verdict.accepte) {
      ligne.appels += 1;
      ligne.unites += demande.unites;
    } else {
      ligne.refusees += 1;
    }
    return verdict;
  }

  /**
   * ⚠️ ELLE N'AJOUTE NI APPEL NI UNITÉ, et c'est le point : un appel refusé n'a pas travaillé. Compter son
   * travail ferait surestimer l'usage d'un client precisément les jours où il est bridé.
   */
  noterRefus(demande: DemandeUsage): void {
    const minute = Math.floor(this.maintenant() / 60_000) * 60_000;
    this.oublierLeVieux(minute);
    this.ligneDe(minute, demande).refusees += 1;
  }

  compteurs(): CompteurUsage[] {
    return [...this.lignes.values()].sort((a, b) => b.minute - a.minute);
  }

  /**
   * ⚠️ LE PLAFOND SE LIT SUR L'ESPACE, PAS SUR LA CLÉ, et ce serait le premier piège d'un seuil posé à la
   * légère : un espace à dix clés disposerait sinon de dix fois le quota, et le plafond ne voudrait plus
   * rien dire. Le quota par clé existe déjà, c'est le limiteur de débit.
   */
  private verdict(minute: number, demande: DemandeUsage): VerdictUsage {
    if (this.plafondUnitesParEspace <= 0) return { accepte: true };
    let dejaFait = 0;
    for (const l of this.lignes.values()) {
      if (l.minute === minute && l.tenantId === demande.tenantId) dejaFait += l.unites;
    }
    if (dejaFait + demande.unites <= this.plafondUnitesParEspace) return { accepte: true };
    return { accepte: false, raison: 'quota d’usage de cet espace atteint pour cette minute' };
  }

  private ligneDe(minute: number, d: DemandeUsage): CompteurUsage {
    const cle = `${minute}|${d.tenantId}|${d.cleId}|${d.operation}`;
    const existante = this.lignes.get(cle);
    if (existante) return existante;
    const neuve: CompteurUsage = {
      minute, tenantId: d.tenantId, cleId: d.cleId, operation: d.operation, appels: 0, unites: 0, refusees: 0,
    };
    this.lignes.set(cle, neuve);
    return neuve;
  }

  private oublierLeVieux(minute: number): void {
    const plancher = minute - this.minutesGardees * 60_000;
    for (const [cle, l] of this.lignes) {
      if (l.minute < plancher) this.lignes.delete(cle);
    }
  }
}
