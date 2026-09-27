import { decider } from './bascule';
import type { AutoRetryRecipient, CandidatBascule } from './store.pg';
import { messageDe } from '../lib/erreur';

/**
 * Auto-relance des échecs de livraison. Fonction pure (dépendances injectées), testable sans base ni horloge.
 *
 * Deux politiques exclusives : une campagne qui porte une chaîne de repli passe par la bascule d'étage
 * (`bascule.ts`) ; une campagne sans repli garde la politique de réessai ci-dessous. L'exclusion est une clause
 * SQL (`SANS_REPLI_SQL`), pas l'ordre des passes.
 *
 * Politique des campagnes sans repli :
 *  - 131049 (Meta a plafonné le marketing) : relancer une fois, plus de 24 h après l'échec, dans une fenêtre
 *    « début de journée » (`isMorningWindow`).
 *  - 131026 (non délivrable) : retenter une fois. Au second échec, marquer le contact injoignable dans HubSpot
 *    (best-effort) et chez nous, puis clore seulement si les deux ont réussi (sinon réessayé au tour suivant).
 *  - Toute relance et tout repli passent par la fenêtre de rattrapage de l'espace, sauf si la campagne s'en
 *    affranchit (`rattrapage_hors_horaires`, distinct de `business_hours_only` qui gouverne l'envoi initial).
 *
 * La relance remet en `pending` et enfile un `campaign-run` : runCampaign et son claim atomique empêchent le
 * double envoi. Un échec par destinataire n'interrompt jamais le balayage.
 */
export interface RetrySweepDeps {
  /** Sommes-nous dans la fenêtre « début de journée » (fuseau géré par l'appelant) pour relancer les 131049 ? */
  isMorningWindow(): boolean;
  list131049(): Promise<AutoRetryRecipient[]>;
  /** Le dépôt des campagnes et de leurs destinataires. */
  repo: {
    listRetry131026(): Promise<AutoRetryRecipient[]>;
    listRetry131026SecondFail(): Promise<AutoRetryRecipient[]>;
    /** Remet le destinataire en pending (retry_count++), atomique. true si repris. */
    resetForRetry(id: string): Promise<boolean>;
    /** Clôt un destinataire injoignable (terminal). À appeler après le flag HubSpot et la note, tous deux réussis. */
    markUnreachableDone(id: string): Promise<boolean>;
    /**
     * Les destinataires en échec d'une campagne qui a un repli, avec de quoi appliquer `decider`. Elle rend aussi
     * ceux du dernier étage : c'est `decider` qui tranche.
     */
    listCandidatsBascule(): Promise<CandidatBascule[]>;
    /** Fait avancer le destinataire à l'étage `rang` et le remet en `pending`, atomique. true si repris. */
    basculerEtage(id: string, rang: number): Promise<boolean>;
  };
  /** Enfile un campaign-run. Non dédupliqué : un run par destinataire relancé. */
  enqueueRun(campaignId: string): Promise<void>;
  /** Marque le contact injoignable dans HubSpot (best-effort ; throw -> on ne note ni ne clôt, réessayé au tour suivant). */
  flagUnreachable(tenantId: string, e164: string): Promise<void>;
  /**
   * Écrit chez nous ce que ce second échec vient d'apprendre, à côté de `flagUnreachable` et jamais à sa
   * place : un verdict rangé seulement chez HubSpot n'est relu par rien ici.
   */
  noterJoignabilite(tenantId: string, contactId: string, joignable: boolean): Promise<void>;
  /**
   * L'espace est-il dans ses heures d'ouverture maintenant (fuseau géré par l'appelant) ? Interrogée seulement
   * pour les campagnes qui refusent le rattrapage hors horaires, une fois par espace et par tour.
   */
  fenetreOuverte(tenantId: string): Promise<boolean>;
}

function logErr(kind: string, id: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`retry-sweep: échec ${kind} sur le destinataire ${id}`, messageDe(err));
}

export async function runRetrySweep(deps: RetrySweepDeps): Promise<{ retried: number; flagged: number; bascules: number }> {
  let retried = 0;
  let flagged = 0;
  let bascules = 0;

  /**
   * A-t-on le droit de faire partir quelque chose pour ce destinataire, maintenant ?
   *
   * La garde est ici, pas dans une mise en pause : un rattrapage arrive souvent sur une campagne terminée. Ne
   * rien faire ne perd rien, le destinataire reste en échec et sera listé au tour suivant.
   *
   * Elle échoue fermé, à l'inverse de `horairesOuvres` du moteur : une lecture ratée saute le tour (le `catch`
   * par destinataire l'applique). Le cache vaut pour un tour de balayage, pas pour le process.
   */
  const fenetres = new Map<string, boolean>();
  const peutPartirMaintenant = async (r: { tenantId: string; rattrapageHorsHoraires: boolean }): Promise<boolean> => {
    if (r.rattrapageHorsHoraires) return true;
    const connue = fenetres.get(r.tenantId);
    if (connue !== undefined) return connue;
    const ouverte = await deps.fenetreOuverte(r.tenantId);
    fenetres.set(r.tenantId, ouverte);
    return ouverte;
  };

  // La bascule d'étage d'abord (la frontière avec les passes suivantes est en SQL, `SANS_REPLI_SQL`). On n'agit
  // que sur `bascule` : les réessais sont faits par les passes ci-dessous, `terminal` se joue en ne faisant rien.
  // Un étage non servable échoue avec sa raison, au vrai rang et au vrai canal, sans renvoyer le même message.
  for (const c of await deps.repo.listCandidatsBascule()) {
    try {
      const geste = decider(c);
      if (geste.type !== 'bascule') continue;
      // Le repli passe par la garde d'horaire, et avant d'écrire : basculer puis ne pas enfiler laisserait le
      // destinataire `pending` sur le nouvel étage, hors de toute liste d'échec.
      if (!(await peutPartirMaintenant(c))) continue;
      if (await deps.repo.basculerEtage(c.id, geste.rang)) { await deps.enqueueRun(c.campaignId); bascules += 1; }
    } catch (err) { logErr('bascule', c.id, err); }
  }

  // 131049 : seulement en fenêtre matinale, une seule relance (les listes ne rendent que retry_count=0).
  // Deux gardes se cumulent : `isMorningWindow` (le bon moment pour un plafond marketing) et
  // `peutPartirMaintenant` (l'espace accepte qu'on écrive maintenant). Un matin de jour férié, elles divergent.
  if (deps.isMorningWindow()) {
    for (const r of await deps.list131049()) {
      try {
        if (!(await peutPartirMaintenant(r))) continue;
        if (await deps.repo.resetForRetry(r.id)) { await deps.enqueueRun(r.campaignId); retried += 1; }
      } catch (err) { logErr('131049', r.id, err); }
    }
  }

  // 131026 : retenter une fois, sans délai depuis l'échec, mais dans la fenêtre de rattrapage.
  for (const r of await deps.repo.listRetry131026()) {
    try {
      if (!(await peutPartirMaintenant(r))) continue;
      if (await deps.repo.resetForRetry(r.id)) { await deps.enqueueRun(r.campaignId); retried += 1; }
    } catch (err) { logErr('131026', r.id, err); }
  }

  // 131026 second échec : flag, puis mémoire, puis clôture en dernier (tant qu'elle n'est pas passée, le
  // destinataire est relisté, donc un échec diffère sans rien perdre). Pas de garde d'horaire : rien n'est envoyé.
  for (const r of await deps.repo.listRetry131026SecondFail()) {
    try {
      await deps.flagUnreachable(r.tenantId, r.toE164);
      await deps.noterJoignabilite(r.tenantId, r.contactId, false);
      await deps.repo.markUnreachableDone(r.id);
      flagged += 1;
    } catch (err) { logErr('131026-injoignable', r.id, err); }
  }

  return { retried, flagged, bascules };
}
