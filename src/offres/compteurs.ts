import type { Comptage, CompteurDebit } from '../db/debit';
import { zonedMidnightEpochSec } from '../stats/range';
import { bornesDuJour, jourDeParis } from '../api/quotas';
import { journaliser as journaliserParDefaut } from '../lib/journal';
import type { SourceOffres } from './offre.pg';

/**
 * LES MODÈLES DU MOIS (lot 6, spec § 4) : la limite des envois de modèles par mois civil de Paris (1 000 en Base). Un
 * modèle est un message à l'initiative de l'entreprise ; un message dans la fenêtre de 24 h ne passe jamais par ici.
 *
 * Le compteur est le compteur partagé des copies (`compteurs_debit`, `PgCompteurDebit`) : atomique et tout ou rien, donc
 * deux envois concurrents ne se disputent jamais la dernière place à deux. La fabrique d'envoi le consomme avant chaque
 * modèle (`src/meta/factory.ts`), ce qui couvre tous les chemins : console, API, MCP, automations, scénarios.
 */

/** Le mois civil de Paris qui contient `instantMs` (`AAAA-MM`). */
export function moisDeParis(instantMs: number): string {
  return new Date(instantMs).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(0, 7);
}

/** Le début et la fin du mois civil de Paris, en millisecondes : minuit de Paris, changement d'heure compris. */
export function bornesDuMois(mois: string): { debutMs: number; finMs: number } {
  const [a, m] = mois.split('-').map(Number) as [number, number];
  const suivant = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
  return { debutMs: zonedMidnightEpochSec(`${mois}-01`) * 1000, finMs: zonedMidnightEpochSec(`${suivant}-01`) * 1000 };
}

const cleDuMois = (tenantId: string, mois: string): string => `offre.modeles|${tenantId}|${mois}`;

/** Le comptage d'un envoi de `n` modèles dans le mois de l'espace : la clé porte le mois, la fenêtre finit pile à sa fin. */
export function comptageModelesDuMois(tenantId: string, max: number, n: number, instantMs: number): Comptage {
  const mois = moisDeParis(instantMs);
  const { debutMs, finMs } = bornesDuMois(mois);
  return { cle: cleDuMois(tenantId, mois), dureeMs: finMs - debutMs, origineMs: debutMs, max, pas: n };
}

export type VerdictModeles = { ok: true } | { ok: false; max: number };

export interface DepsQuotaModeles {
  offres: SourceOffres;
  compteur: CompteurDebit;
  maintenant?: () => number;
  journaliser?: (message: string, champs: Record<string, unknown>) => void;
}

export class QuotaModeles {
  private readonly maintenant: () => number;
  private readonly journaliser: (message: string, champs: Record<string, unknown>) => void;

  constructor(private readonly d: DepsQuotaModeles) {
    this.maintenant = d.maintenant ?? Date.now;
    this.journaliser = d.journaliser ?? ((m, c) => journaliserParDefaut('warn', m, c));
  }

  /**
   * Compte `n` modèles pour l'espace. Sans limite : rien n'est écrit. 🔴 Si l'offre ou le compteur ne répondent pas,
   * l'envoi passe et l'incident est journalisé : une panne de la base ne coupe pas les envois de tout le monde pour une
   * limite commerciale (spec § 4).
   */
  async consommer(tenantId: string, n = 1): Promise<VerdictModeles> {
    try {
      const max = (await this.d.offres.offreDe(tenantId)).droits.limites.envoisModelesMois;
      if (max === null) return { ok: true };
      const v = await this.d.compteur.compter([comptageModelesDuMois(tenantId, max, n, this.maintenant())]);
      return v.accepte ? { ok: true } : { ok: false, max };
    } catch (err) {
      this.journaliser('quota_modeles_injoignable', { tenantId, err });
      return { ok: true };
    }
  }

  /**
   * La limite du mois de l'espace et ce qu'il en reste, `null` sans limite ou si le compteur ne répond pas. ⚠️ Une
   * ESTIMATION, pour refuser tôt une campagne ou un envoi qui ne tiendrait pas : la décision qui fait foi reste
   * `consommer`, à l'envoi.
   */
  async etatDuMois(tenantId: string): Promise<{ max: number; reste: number } | null> {
    try {
      const max = (await this.d.offres.offreDe(tenantId)).droits.limites.envoisModelesMois;
      if (max === null) return null;
      const t = this.maintenant();
      const mois = moisDeParis(t);
      const { debutMs, finMs } = bornesDuMois(mois);
      // 🔴 Toute la durée du mois, plus une heure : la clé porte le mois, donc une seule fenêtre peut répondre. Lire
      // « depuis le début du mois » à la milliseconde près la faisait tomber dès que l'horloge de la base était en avance
      // sur celle de la copie, c'est-à-dire presque toujours (relecture finale du lot 6).
      const lignes = await this.d.compteur.lister(cleDuMois(tenantId, mois), (finMs - debutMs) + 3_600_000);
      const fait = lignes.find((l) => l.cle === cleDuMois(tenantId, mois))?.n ?? 0;
      return { max, reste: Math.max(0, max - fait) };
    } catch (err) {
      this.journaliser('quota_modeles_injoignable', { tenantId, err });
      return null;
    }
  }
}

/**
 * La vérification au lancement d'une campagne (lot 6) : la limite et le reste du mois, plus les modèles que la campagne
 * enverrait. `null` sans limite, sans même compter la campagne.
 */
export function creerModelesDuLancement(
  quota: Pick<QuotaModeles, 'etatDuMois'>,
  enAttente: (campaignId: string, tenantId: string) => Promise<number>,
): (tenantId: string, campaignId: string) => Promise<{ max: number; reste: number; demandes: number } | null> {
  return async (tenantId, campaignId) => {
    const etat = await quota.etatDuMois(tenantId);
    if (etat === null) return null;
    return { ...etat, demandes: await enAttente(campaignId, tenantId) };
  };
}

/**
 * LES SUPPRESSIONS DE CONTACTS DU JOUR (lot 6, spec § 4) : 10 par jour civil de Paris en Base, un garde-fou contre la
 * rotation (supprimer pour recréer sous la limite de contacts), pas un argument commercial. Tout ou rien : une purge qui
 * dépasserait est refusée en entier. Même compteur partagé, même conduite qu'une panne que les modèles du mois.
 */
export class QuotaSuppressions {
  private readonly maintenant: () => number;
  private readonly journaliser: (message: string, champs: Record<string, unknown>) => void;

  constructor(private readonly d: DepsQuotaModeles) {
    this.maintenant = d.maintenant ?? Date.now;
    this.journaliser = d.journaliser ?? ((m, c) => journaliserParDefaut('warn', m, c));
  }

  async consommer(tenantId: string, n: number): Promise<VerdictModeles> {
    try {
      const max = (await this.d.offres.offreDe(tenantId)).droits.limites.suppressionsJour;
      if (max === null) return { ok: true };
      const t = this.maintenant();
      const jour = jourDeParis(t);
      const { debutMs, finMs } = bornesDuJour(jour);
      const v = await this.d.compteur.compter([{ cle: `offre.suppressions|${tenantId}|${jour}`, dureeMs: finMs - debutMs, origineMs: debutMs, max, pas: n }]);
      return v.accepte ? { ok: true } : { ok: false, max };
    } catch (err) {
      this.journaliser('quota_suppressions_injoignable', { tenantId, err });
      return { ok: true };
    }
  }
}
