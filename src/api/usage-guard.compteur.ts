import type { ApiUsageGuard, CompteurUsage, DemandeUsage, LiberationLourde, OperationApi, VerdictUsage } from './usage-guard';
import type { Comptage, CompteurDebit } from '../db/debit';
import { journaliser } from '../lib/journal';

/**
 * Le garde d'usage de l'API publique, agrégé par minute, compté dans le compteur de débit (`src/db/debit.ts`).
 * Branché sur le compteur en base, il est PARTAGÉ par toutes les copies de l'API : `/ops/usage` montre leur total,
 * et un seuil par espace, le jour où il existera, sera tenu au total. Aucune route ne sait qu'il existe.
 *
 * Coût : une écriture par appel compté (appels et unités, deux lignes d'une instruction), bornée par le plafond de
 * l'espace (un appel au-delà est refusé avant d'arriver ici) ; un refus en coûte une de plus.
 *
 * 🔴 UN COMPTEUR MUET NE REFUSE RIEN : si la base ne répond pas, l'appel passe et la panne se journalise une fois par
 * minute. Ce garde observe (aucun seuil n'est posé en production), il ne doit pas devenir la panne qu'il mesure.
 *
 * Le seul état de CETTE copie : les places d'opérations lourdes (`entrerLourde`), qui protègent son pool à elle.
 */

/** Les clés d'usage : `usage|<champ>|<espace>|<clé>|<opération>`. Le quota d'un espace a sa propre clé. */
const PREFIXE = 'usage|';
type Champ = 'appels' | 'unites' | 'refusees';
const cleUsage = (champ: Champ, d: DemandeUsage): string => `${PREFIXE}${champ}|${d.tenantId}|${d.cleId}|${d.operation}`;

const OPERATIONS: ReadonlySet<OperationApi> = new Set<OperationApi>([
  'contacts.upsert', 'contacts.batch', 'contacts.read', 'sends.create', 'sends.read', 'messages.send',
  'catalogues.read', 'mcp.call', 'mcp.refus',
]);

export interface OptionsGardeUsage {
  /**
   * Combien de minutes on garde (120 = deux heures, de quoi regarder une rafale après coup). La borne est en
   * minutes, pas en lignes : un plafond de lignes se remplirait avec un seul espace bavard.
   */
  readonly minutesGardees?: number;
  /**
   * Le plafond d'unités par espace et par minute ; `0` = observation pure, on compte sans refuser. Il vaut 0 en
   * production : aucun seuil deviné, on compte d'abord ce que font les vrais clients.
   */
  readonly plafondUnitesParEspace?: number;
  /**
   * Combien d'opérations lourdes peuvent être en vol en même temps DANS CETTE COPIE ; `0` = pas de plafond. La valeur
   * et son calcul vivent sur `API_MAX_LOURDES_SIMULTANEES` (`src/config.ts`) ; ce défaut lui est aligné.
   */
  readonly maxLourdesSimultanees?: number;
}

export class GardeUsage implements ApiUsageGuard {
  private readonly minutesGardees: number;
  private readonly plafond: number;
  private readonly maxLourdes: number;
  /** Combien d'opérations lourdes sont en vol à cet instant, dans cette copie. */
  private lourdesEnVol = 0;
  private dernierAvertissement = Number.NEGATIVE_INFINITY;

  constructor(private readonly compteur: CompteurDebit, o: OptionsGardeUsage = {}) {
    this.minutesGardees = o.minutesGardees ?? 120;
    this.plafond = o.plafondUnitesParEspace ?? 0;
    this.maxLourdes = o.maxLourdesSimultanees ?? 1;
  }

  entrerLourde(): LiberationLourde | null {
    if (this.maxLourdes > 0 && this.lourdesEnVol >= this.maxLourdes) return null;
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

  async demander(demande: DemandeUsage): Promise<VerdictUsage> {
    const comptages: Comptage[] = [
      this.comptage('appels', demande, 1),
      this.comptage('unites', demande, demande.unites),
    ];
    /**
     * Le plafond se lit sur l'ESPACE, pas sur la clé : un espace à dix clés aurait sinon dix fois le quota. Compté
     * avec les deux autres, toutes ou aucune : un refus n'ajoute ni appel ni unité, donc il ne s'auto-entretient pas.
     */
    if (this.plafond > 0) {
      comptages.push({ cle: `usage-espace|${demande.tenantId}`, dureeMs: 60_000, max: this.plafond, pas: demande.unites });
    }
    try {
      const verdict = await this.compteur.compter(comptages);
      if (verdict.accepte) return { accepte: true };
    } catch (err) {
      this.avertir(err);
      return { accepte: true };
    }
    await this.noterRefus(demande);
    return { accepte: false, raison: 'quota d’usage de cet espace atteint pour cette minute' };
  }

  /** N'ajoute ni appel ni unité : un appel refusé n'a pas travaillé, et le compter surestimerait l'usage. */
  async noterRefus(demande: DemandeUsage): Promise<void> {
    try {
      await this.compteur.compter([this.comptage('refusees', demande, 1)]);
    } catch (err) {
      this.avertir(err);
    }
  }

  async compteurs(): Promise<CompteurUsage[]> {
    const lignes = await this.compteur.lister(PREFIXE, this.minutesGardees * 60_000);
    const parLigne = new Map<string, CompteurUsage>();
    for (const l of lignes) {
      // `usage|<champ>|<espace>|<clé>|<opération>` : aucun des quatre ne porte `|` (identifiants et opérations fermées).
      const [, champ, tenantId, cleId, operation] = l.cle.split('|');
      if (champ !== 'appels' && champ !== 'unites' && champ !== 'refusees') continue;
      if (!tenantId || !cleId || !OPERATIONS.has(operation as OperationApi)) continue;
      const id = `${l.debutMs}|${tenantId}|${cleId}|${operation}`;
      let ligne = parLigne.get(id);
      if (!ligne) {
        ligne = { minute: l.debutMs, tenantId, cleId, operation: operation as OperationApi, appels: 0, unites: 0, refusees: 0 };
        parLigne.set(id, ligne);
      }
      ligne[champ] += l.n;
    }
    return [...parLigne.values()].sort((a, b) => b.minute - a.minute);
  }

  private comptage(champ: Champ, d: DemandeUsage, pas: number): Comptage {
    return { cle: cleUsage(champ, d), dureeMs: 60_000, max: null, pas, garderMs: this.minutesGardees * 60_000 };
  }

  private avertir(err: unknown): void {
    const t = Date.now();
    if (t - this.dernierAvertissement < 60_000) return;
    this.dernierAvertissement = t;
    journaliser('error', 'usage_api_compteur_indisponible', { err });
  }
}
