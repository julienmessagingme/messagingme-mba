import type { ApiUsageGuard, CompteurUsage, DemandeUsage, LiberationLourde, OperationApi, VerdictUsage } from './usage-guard';
import type { Comptage, CompteurDebit, VerdictDebit } from '../db/debit';
import { journaliser } from '../lib/journal';
import { comptageQuota, familleDe, jourDeParis, raisonDuRefus, type FamilleQuota, type QuotasParDefaut } from './quotas';
import { estReglageInconnu } from '../auth/plafond-espace';

/**
 * Ce qu'il faut au garde pour appliquer les quotas quotidiens (`src/api/quotas.ts`) : le réglage de chaque espace (le
 * MÊME cache que le limiteur d'appels, qu'une écriture de `/ops/plafond-api` met à jour tout de suite), les défauts de
 * la configuration, et une alerte quand le compteur ne répond pas (le quota n'est alors pas tenu).
 */
export interface QuotasEspace {
  reglages: { reglage(tenantId: string): Promise<{ envoisJour: number | null; fichesJour: number | null }> };
  defauts: QuotasParDefaut;
  /**
   * Prévient l'exploitation (Telegram) : le compteur muet (au plus une fois par `ALERTE_QUOTA_MS`), et la première fois
   * qu'un espace atteint un quota dans la journée (une fois par espace, famille et jour, dans cette copie).
   */
  alerter: (texte: string) => void;
  /** L'horloge du jour civil ; `Date.now` par défaut. */
  maintenant?: () => number;
}

/** Une alerte de compteur muet au plus toutes les trente minutes : une panne de base ne doit pas inonder le canal. */
export const ALERTE_QUOTA_MS = 30 * 60_000;

/**
 * Le garde d'usage de l'API publique, agrégé par minute, compté dans le compteur de débit (`src/db/debit.ts`).
 * Branché sur le compteur en base, il est PARTAGÉ par toutes les copies de l'API : `/ops/usage` montre leur total, et
 * les quotas quotidiens par espace (`src/api/quotas.ts`) sont tenus au total. Aucune route ne sait qu'il existe.
 *
 * Coût : une écriture par appel compté (appels et unités, deux lignes d'une instruction), bornée par le plafond de
 * l'espace (un appel au-delà est refusé avant d'arriver ici) ; un refus en coûte une de plus.
 *
 * 🔴 UN COMPTEUR MUET NE REFUSE RIEN : si la base ne répond pas, l'appel passe et la panne se journalise une fois par
 * minute (et une alerte dit que les quotas ne sont plus tenus). Le garde ne doit pas devenir la panne qu'il mesure.
 *
 * Le seul état de CETTE copie : les places d'opérations lourdes (`entrerLourde`), qui protègent son pool à elle.
 */

/** Les clés d'usage : `usage|<champ>|<espace>|<clé>|<opération>`. Le quota d'un espace a sa propre clé. */
const PREFIXE = 'usage|';
type Champ = 'appels' | 'unites' | 'refusees';
const cleUsage = (champ: Champ, d: DemandeUsage): string => `${PREFIXE}${champ}|${d.tenantId}|${d.cleId}|${d.operation}`;

const OPERATIONS: ReadonlySet<OperationApi> = new Set<OperationApi>([
  'contacts.upsert', 'contacts.batch', 'contacts.read', 'sends.create', 'sends.read', 'messages.send', 'messages.reponse_application',
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
  private derniereAlerte = Number.NEGATIVE_INFINITY;
  /** Les quotas atteints annoncés aujourd'hui (`espace|famille|jour`) : vidé au changement de jour, donc borné. */
  private quotasAnnonces = new Set<string>();
  private jourAnnonces = '';

  /**
   * `quotas` : `null` se DIT (tests, serveur sans quotas), jamais par oubli. Une dépendance qui porte une règle ne
   * s'omet pas en silence, la leçon d'`estDesabonne`.
   */
  constructor(private readonly compteur: CompteurDebit, private readonly quotas: QuotasEspace | null, o: OptionsGardeUsage = {}) {
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
    /**
     * Le quota du jour, dans la MÊME opération : refusé, l'appel n'est compté nulle part, et un lot qui dépasserait le
     * quota est refusé en entier. Le réglage vient du cache partagé (une lecture par espace toutes les 30 s au plus).
     */
    const quota = await this.quotaDe(demande);
    if (quota) comptages.push(quota.comptage);
    let verdict: VerdictDebit;
    try {
      verdict = await this.compteur.compter(comptages);
      if (verdict.accepte) return { accepte: true };
    } catch (err) {
      this.avertir(err);
      if (quota) this.alerterQuotaNonTenu(err);
      return { accepte: true };
    }
    await this.noterRefus(demande);
    const fenetreQuota = quota ? verdict.fenetres[comptages.length - 1] : undefined;
    if (quota && fenetreQuota?.pleine) {
      this.annoncerQuotaAtteint(demande.tenantId, quota.famille, quota.max);
      return { accepte: false, raison: raisonDuRefus(quota.famille, quota.max), quota: { attenteMs: Math.max(0, fenetreQuota.finMs - verdict.maintenantMs) } };
    }
    return { accepte: false, raison: 'quota d’usage de cet espace atteint pour cette minute' };
  }

  /** Le comptage du quota d'une demande, ou `null` : opération hors quota, quotas absents, ou quota à 0 (désactivé). */
  private async quotaDe(demande: DemandeUsage): Promise<{ famille: 'envois' | 'fiches'; max: number; comptage: Comptage } | null> {
    const famille = familleDe(demande.operation);
    if (!famille || !this.quotas) return null;
    const reglage = await this.quotas.reglages.reglage(demande.tenantId);
    // Lecture ratée sans réglage connu : le quota laisse passer, comme sur un compteur muet (`REGLAGE_INCONNU`).
    if (estReglageInconnu(reglage)) return null;
    const max = (famille === 'envois' ? reglage.envoisJour : reglage.fichesJour) ?? this.quotas.defauts[famille];
    if (max <= 0) return null;
    const maintenant = this.quotas.maintenant ?? Date.now;
    return { famille, max, comptage: comptageQuota(famille, demande.tenantId, max, demande.unites, maintenant()) };
  }

  /**
   * Un espace vient de buter sur son quota : l'exploitation le saura sans attendre l'appel du client, et pourra le
   * relever. Une fois par espace, famille et jour dans cette copie (chaque copie en dirait autant au pire).
   */
  private annoncerQuotaAtteint(tenantId: string, famille: FamilleQuota, max: number): void {
    const jour = jourDeParis((this.quotas?.maintenant ?? Date.now)());
    if (jour !== this.jourAnnonces) { this.quotasAnnonces = new Set(); this.jourAnnonces = jour; }
    const cle = `${tenantId}|${famille}`;
    if (this.quotasAnnonces.has(cle)) return;
    this.quotasAnnonces.add(cle);
    journaliser('warn', 'quota_api_atteint', { tenantId, famille, max, jour });
    this.quotas?.alerter(`quota quotidien de l’API atteint : espace ${tenantId}, ${max} ${famille === 'envois' ? 'envois' : 'fiches écrites'} par jour. À relever par /ops/plafond-api si le client en a besoin.`);
  }

  /** Le compteur ne répond pas : l'appel passe (la politique du garde), mais le quota n'est plus tenu, on le dit. */
  private alerterQuotaNonTenu(err: unknown): void {
    const t = Date.now();
    if (t - this.derniereAlerte < ALERTE_QUOTA_MS) return;
    this.derniereAlerte = t;
    const message = err instanceof Error ? err.message : String(err);
    this.quotas?.alerter(`compteur des quotas de l’API publique indisponible : les appels passent, les quotas quotidiens ne sont plus tenus (${message.slice(0, 200)})`);
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
