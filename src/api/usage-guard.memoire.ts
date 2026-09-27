import type { ApiUsageGuard, CompteurUsage, DemandeUsage, LiberationLourde, VerdictUsage } from './usage-guard';

/**
 * Le garde d'usage, en mémoire, agrégé par minute. Il exerce le contrat entier, sert les tests et tourne en
 * production tant qu'il n'y a qu'une instance d'API ; en multi-replica, c'est lui qu'on remplace, aucune
 * route ne sait qu'il existe.
 *
 * Pas une ligne SQL par requête : sous rafale, chaque requête hostile en provoquerait une seconde sur le
 * budget de connexions qu'on protège. Local au process : avec deux instances, `/ops` en montrerait deux
 * moitiés.
 */
export class GardeUsageMemoire implements ApiUsageGuard {
  /** Clé d'agrégation -> compteur. La minute fait partie de la clé, d'où le regroupement naturel. */
  private readonly lignes = new Map<string, CompteurUsage>();

  constructor(
    /**
     * Combien de minutes on garde (120 = deux heures, de quoi regarder une rafale après coup). La borne est en
     * minutes, pas en lignes : un plafond de lignes se remplirait avec un seul espace bavard.
     */
    private readonly minutesGardees = 120,
    /**
     * Le plafond d'unités par espace et par minute ; `0` = observation pure, on compte sans refuser. Il vaut 0 :
     * aucun seuil deviné, on compte d'abord ce que font les vrais clients.
     */
    private readonly plafondUnitesParEspace = 0,
    private readonly maintenant: () => number = () => Date.now(),
    /**
     * Combien d'opérations lourdes peuvent être en vol en même temps ; `0` = pas de plafond. La valeur et son
     * calcul vivent sur `API_MAX_LOURDES_SIMULTANEES` (`src/config.ts`) ; ce défaut lui est aligné.
     */
    private readonly maxLourdesSimultanees = 1,
  ) {}

  /** Combien d'opérations lourdes sont en vol à cet instant. */
  private lourdesEnVol = 0;

  entrerLourde(): LiberationLourde | null {
    if (this.maxLourdesSimultanees > 0 && this.lourdesEnVol >= this.maxLourdesSimultanees) return null;
    this.lourdesEnVol += 1;
    /**
     * Idempotente : une réponse peut être close deux fois, et rendre deux places pour une prise ferait monter le
     * plafond tout seul.
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
   * N'ajoute ni appel ni unité : un appel refusé n'a pas travaillé, et le compter surestimerait l'usage d'un
   * client les jours où il est bridé.
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
   * Le plafond se lit sur l'espace, pas sur la clé : un espace à dix clés aurait sinon dix fois le quota. Le
   * limiteur d'appels (`src/auth/plafond-espace.ts`) compte aussi par espace ; celui-ci compte les unités de
   * travail. Seule la clé du relais du Meta Business Agent garde un compteur par clé, hors de ces plafonds.
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
