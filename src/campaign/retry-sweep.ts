import { decider } from './bascule';
import type { AutoRetryRecipient, CandidatBascule } from './store.pg';

/**
 * Auto-relance des échecs de livraison (F6). Fonction PURE (deps injectés) -> testable sans DB ni horloge, comme
 * `runCampaignScheduleSweep`.
 *
 * 🔴 DEUX POLITIQUES DE RATTRAPAGE COHABITENT ICI, ET ELLES SONT EXCLUSIVES. Une campagne qui porte une
 * CHAÎNE de repli passe par la bascule d'étage, décrite par `bascule.ts` : tout échec la fait avancer d'un
 * étage, sans exception de code, parce que le transport a déjà rejoué ce qui méritait de l'être. Une
 * campagne SANS repli garde la politique de réessai ci-dessous, inchangée. Ce qui les rend exclusives est
 * une clause SQL (`SANS_REPLI_SQL` dans `store.pg.ts`), pas l'ordre des passes de cette fonction.
 *
 * Politique de recouvrement des campagnes SANS repli :
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
  /**
   * Les destinataires en échec d'une campagne qui a un REPLI, avec de quoi appliquer `decider`.
   *
   * ⚠️ Elle rend AUSSI ceux qui sont au dernier étage : c'est `decider` qui tranche, pas la requête
   * (cf. `PgCampaignRepo.listCandidatsBascule`).
   */
  listCandidatsBascule(): Promise<CandidatBascule[]>;
  /** Fait avancer le destinataire à l'étage `rang` et le remet en `pending`, atomique. true si repris. */
  basculerEtage(id: string, rang: number): Promise<boolean>;
}

function logErr(kind: string, id: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`retry-sweep: échec ${kind} sur le destinataire ${id}`, err instanceof Error ? err.message : err);
}

export async function runRetrySweep(deps: RetrySweepDeps): Promise<{ retried: number; flagged: number; bascules: number }> {
  let retried = 0;
  let flagged = 0;
  let bascules = 0;

  // LA BASCULE D'ÉTAGE, en PREMIER. Elle ne concerne que les campagnes à repli, et les trois passes de
  // F6 qui suivent ne concernent QUE celles qui n'en ont pas : la frontière est posée en SQL
  // (`SANS_REPLI_SQL`), pas par cet ordre. L'ordre reste le bon quand même, parce qu'une bascule remet
  // le destinataire en `pending` : si la frontière SQL venait à tomber, il ne serait déjà plus listé
  // comme échoué par les passes d'après, ce qui limite les dégâts à un tour de balayage.
  //
  // 🔴 ON N'AGIT QUE SUR LE VERDICT `bascule`, ET LES TROIS AUTRES NE SONT PAS IGNORÉS POUR AUTANT.
  // `reessai` et `reessai_demain_matin` sont précisément ce que les passes 131026 et 131049
  // ci-dessous font déjà, sur les campagnes sans repli, qui sont les seules à pouvoir les recevoir ;
  // et `terminal` se joue en NE FAISANT RIEN, le destinataire restant `failed` sans que plus personne
  // ne le reprenne. Écrire un second chemin de réessai ici en ferait deux qui doivent rester d'accord.
  //
  // 🔴 CETTE PASSE EST DORMANTE TANT QU'UNE CAMPAGNE NE PEUT PAS AVOIR PLUS D'UN ÉTAGE, et il faut le
  // dire : `insertCampaignRow` n'écrit que le rang 1, et le moteur d'envoi ne lit pas encore
  // `etage_courant`. Le jour où une chaîne à deux étages sera créable, c'est le MOTEUR qui devra
  // apprendre à envoyer le contenu de l'étage courant, sans quoi une bascule ferait renvoyer le
  // contenu de l'étage 1 sur le canal de l'étage 1. La bascule est prête, l'envoi ne l'est pas.
  for (const c of await deps.listCandidatsBascule()) {
    try {
      const geste = decider(c);
      if (geste.type !== 'bascule') continue;
      if (await deps.basculerEtage(c.id, geste.rang)) { await deps.enqueueRun(c.campaignId); bascules += 1; }
    } catch (err) { logErr('bascule', c.id, err); }
  }

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

  return { retried, flagged, bascules };
}
