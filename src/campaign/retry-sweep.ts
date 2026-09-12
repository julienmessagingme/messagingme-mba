import type { AutoRetryRecipient } from './store.pg';

/**
 * Auto-relance des échecs de livraison (F6). Fonction PURE (deps injectés) -> testable sans DB ni horloge, comme
 * `runCampaignScheduleSweep`. Politique de recouvrement :
 *  - 131049 (Meta a plafonné le marketing) : relancer UNE fois, plus de 24 h après l'échec, et seulement dans une
 *    fenêtre « début de journée » (le plafond se libère avec le temps ; on ne re-tape pas dans la foulée). Le fenêtrage
 *    horaire est décidé par `isMorningWindow` (le worker le câble sur Europe/Paris).
 *  - 131026 (non délivrable) : retenter UNE fois. Si ça re-échoue (retry_count=1), marquer le contact INJOIGNABLE dans
 *    HubSpot (best-effort), l'écrire CHEZ NOUS (migration 0133), puis clore (retry_count=2) UNIQUEMENT si les deux ont
 *    réussi (sinon réessayé au tour suivant).
 * La relance passe par une remise en `pending` + un `campaign-run` : on RÉUTILISE runCampaign (aucun envoi ad hoc), et
 * son claim atomique garantit l'absence de double-envoi. Un échec par destinataire n'interrompt jamais le balayage.
 */
export interface RetrySweepDeps {
  /** Sommes-nous dans la fenêtre « début de journée » (fuseau géré par l'appelant) pour relancer les 131049 ? */
  isMorningWindow(): boolean;
  list131049(): Promise<AutoRetryRecipient[]>;
  list131026(): Promise<AutoRetryRecipient[]>;
  list131026SecondFail(): Promise<AutoRetryRecipient[]>;
  /** Remet le destinataire en pending (retry_count++), atomique. true si repris. */
  resetForRetry(id: string): Promise<boolean>;
  /** Clôt un destinataire injoignable (terminal). À appeler APRÈS le flag HubSpot ET la note, tous deux réussis. */
  markUnreachableDone(id: string): Promise<boolean>;
  /** Enfile un campaign-run. ⚠️ NON dédupliqué : un run par destinataire relancé (cf. `enqueue.ts`). */
  enqueueRun(campaignId: string): Promise<void>;
  /** Marque le contact injoignable dans HubSpot (best-effort ; throw -> on ne note ni ne clôt, réessayé au tour suivant). */
  flagUnreachable(tenantId: string, e164: string): Promise<void>;
  /**
   * Écrit CHEZ NOUS ce que ce second échec vient de nous apprendre (migration 0133).
   *
   * 🔴 À CÔTÉ de `flagUnreachable`, jamais à sa place. Le verdict était déjà calculé ici et partait
   * uniquement dans HubSpot : un espace sans HubSpot le jetait, et un espace avec HubSpot le rangeait chez
   * un tiers, d'où il ne revient pas (aucune audience, aucun écran, aucune chaîne de repli ne le relit).
   */
  noterJoignabilite(tenantId: string, contactId: string, joignable: boolean): Promise<void>;
}

function logErr(kind: string, id: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`retry-sweep: échec ${kind} sur le destinataire ${id}`, err instanceof Error ? err.message : err);
}

export async function runRetrySweep(deps: RetrySweepDeps): Promise<{ retried: number; flagged: number }> {
  let retried = 0;
  let flagged = 0;

  // 131049 : seulement en fenêtre matinale, une seule relance (les listes ne renvoient que retry_count=0).
  if (deps.isMorningWindow()) {
    for (const r of await deps.list131049()) {
      try {
        if (await deps.resetForRetry(r.id)) { await deps.enqueueRun(r.campaignId); retried += 1; }
      } catch (err) { logErr('131049', r.id, err); }
    }
  }

  // 131026 : retenter une fois, tout de suite (pas d'attente de 24 h).
  for (const r of await deps.list131026()) {
    try {
      if (await deps.resetForRetry(r.id)) { await deps.enqueueRun(r.campaignId); retried += 1; }
    } catch (err) { logErr('131026', r.id, err); }
  }

  // 131026 2e échec : injoignable. flag PUIS mémoire PUIS terminal, dans cet ordre.
  //
  // 🔴 LA CLÔTURE RESTE LA DERNIÈRE ÉCRITURE, et c'est ce qui rend l'ordre sûr : tant qu'elle n'est pas
  // passée, le destinataire reste `error_code=131026, retry_count=1`, donc relisté au tour suivant. Un échec
  // de l'une des deux écritures d'avant ne perd donc rien, il diffère. Noter APRÈS la clôture serait le seul
  // ordre faux : le destinataire ne serait plus jamais listé et le verdict serait perdu pour toujours.
  //
  // ⚠️ La mémoire vient APRÈS le flag, pas avant : mettre du code neuf devant un chemin qui marchait
  // ferait dépendre le flag HubSpot de notre nouvelle écriture, alors que l'inverse coûte au pire un tour
  // de balayage de retard.
  for (const r of await deps.list131026SecondFail()) {
    try {
      await deps.flagUnreachable(r.tenantId, r.toE164);
      await deps.noterJoignabilite(r.tenantId, r.contactId, false);
      await deps.markUnreachableDone(r.id);
      flagged += 1;
    } catch (err) { logErr('131026-injoignable', r.id, err); }
  }

  return { retried, flagged };
}
