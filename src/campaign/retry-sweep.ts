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
 *  - Toute relance, et tout repli, passent en plus par la FENÊTRE DE RATTRAPAGE de l'espace, à moins que
 *    la campagne ne s'en affranchisse (`rattrapage_hors_horaires`, migration 0134). C'est un réglage
 *    DISTINCT de `business_hours_only`, qui gouverne l'envoi initial et vit dans le moteur.
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
  /**
   * L'espace est-il DANS ses heures d'ouverture, maintenant ? (fuseau géré par l'appelant)
   *
   * ⚠️ Elle n'est interrogée que pour les campagnes qui REFUSENT le rattrapage hors horaires, et une
   * seule fois par espace et par tour : la réponse ne change pas pendant un balayage, et la poser par
   * destinataire ferait une lecture des réglages par destinataire.
   */
  fenetreOuverte(tenantId: string): Promise<boolean>;
}

function logErr(kind: string, id: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`retry-sweep: échec ${kind} sur le destinataire ${id}`, err instanceof Error ? err.message : err);
}

export async function runRetrySweep(deps: RetrySweepDeps): Promise<{ retried: number; flagged: number; bascules: number }> {
  let retried = 0;
  let flagged = 0;
  let bascules = 0;

  /**
   * A-t-on le droit de faire PARTIR quelque chose pour ce destinataire, maintenant ?
   *
   * 🔴 LA GARDE EST ICI ET PAS DANS UNE MISE EN PAUSE DE LA CAMPAGNE, et ce n'est pas un raccourci :
   * un rattrapage se présente souvent quand la campagne est TERMINÉE depuis longtemps, et mettre en
   * pause une campagne terminée n'a aucun sens. Le balayage teste la fenêtre avant de ré-enfiler et
   * ne fait rien sinon, exactement comme `isMorningWindow()` le fait déjà pour les 131049. Ne rien
   * faire ne perd rien : le destinataire reste en échec, donc listé au tour suivant.
   *
   * 🔴 ET ELLE ÉCHOUE FERMÉ, À L'INVERSE DE `horairesOuvres` DU MOTEUR, qui traite une lecture ratée
   * comme « aucune contrainte » (un envoi que le client vient de lancer ne doit pas être retenu par
   * une panne de lecture). Ici personne n'attend l'envoi à la seconde : une lecture ratée saute le
   * tour, et le tour suivant arrive dans quelques minutes. C'est le `catch` par destinataire des
   * boucles ci-dessous qui l'applique, il n'y a donc rien de plus à écrire.
   *
   * ⚠️ Le cache est par TOUR de balayage, pas par process : une fenêtre qui s'ouvre pendant un tour
   * s'appliquera au tour suivant, et un tour dure quelques secondes.
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
  // 🔴 CETTE PASSE N'EST PLUS DORMANTE DEPUIS LE 2026-09-12, ET CE QU'ELLE DÉCLENCHE PART VRAIMENT.
  // Elle a été dormante tant que `insertCampaignRow` n'écrivait que le rang 1 ; ce chemin écrit désormais
  // la chaîne complète que l'assistant décrit. Et depuis le lot 6, le run qu'elle enfile SERT le canal de
  // l'étage : `run-job` construit un sender et un frein par canal de la chaîne, et le moteur choisit
  // selon `etage_courant` (`etageServable` + `contenuDeLEtage`, `src/campaign/engine.ts`).
  //
  // ⚠️ CE QUI RESTE UN REFUS, ET IL EST LISIBLE : un étage dont le canal n'est pas servable (un étage
  // e-mail, qui n'a aucun sender de campagne ; un étage RCS sur un espace sans agent). Le destinataire
  // échoue alors avec sa raison, au vrai rang et au vrai canal, et le tour suivant le fera avancer ou le
  // clora. Jamais un renvoi du message qui vient d'échouer.
  for (const c of await deps.listCandidatsBascule()) {
    try {
      const geste = decider(c);
      if (geste.type !== 'bascule') continue;
      // Le repli est un envoi que PERSONNE n'a choisi de déclencher maintenant : il passe par la garde
      // d'horaire, comme les réessais. Et il la passe AVANT d'écrire : basculer puis ne pas enfiler
      // laisserait le destinataire `pending` sur le nouvel étage, donc hors de toute liste d'échec.
      if (!(await peutPartirMaintenant(c))) continue;
      if (await deps.basculerEtage(c.id, geste.rang)) { await deps.enqueueRun(c.campaignId); bascules += 1; }
    } catch (err) { logErr('bascule', c.id, err); }
  }

  // 131049 : seulement en fenêtre matinale, une seule relance (les listes ne renvoient que retry_count=0).
  // ⚠️ DEUX GARDES SE CUMULENT DEPUIS L'HORAIRE DE RATTRAPAGE, et elles ne disent pas la même chose :
  // `isMorningWindow` dit « c'est le bon moment de la journée pour retenter un plafond marketing »,
  // `peutPartirMaintenant` dit « l'espace accepte qu'on écrive à ses contacts maintenant ». Un matin de
  // jour férié, la première est vraie et la seconde fausse.
  if (deps.isMorningWindow()) {
    for (const r of await deps.list131049()) {
      try {
        if (!(await peutPartirMaintenant(r))) continue;
        if (await deps.resetForRetry(r.id)) { await deps.enqueueRun(r.campaignId); retried += 1; }
      } catch (err) { logErr('131049', r.id, err); }
    }
  }

  // 131026 : retenter une fois, sans attendre les 24 h qu'exige 131049.
  // ⚠️ « Sans attendre 24 h » N'EST PLUS « tout de suite » : le réessai passe par la fenêtre de
  // rattrapage, donc une campagne qui refuse le rattrapage hors horaires attend l'ouverture. Ce qui
  // reste vrai, c'est qu'il n'attend pas un DÉLAI depuis l'échec.
  for (const r of await deps.list131026()) {
    try {
      if (!(await peutPartirMaintenant(r))) continue;
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
  //
  // 🔴 PAS DE GARDE D'HORAIRE SUR CETTE PASSE, ET C'EST VOLONTAIRE : elle n'envoie RIEN. Elle écrit un
  // constat (le numéro n'a pas WhatsApp) chez nous et chez HubSpot, puis clôt. Lui appliquer la fenêtre
  // de rattrapage repousserait au lendemain une écriture que personne ne reçoit, et un espace fermé
  // sept jours sur sept ne clôturerait jamais ses injoignables.
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
