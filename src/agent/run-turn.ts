import type { AgentBrain } from './brain';
import { PlafondModeleAtteint } from '../llm/errors';
import { TourInterrompu } from './brain';
import type { FicheAgent } from './agent-store';
import type { AgentSession, AgentSessionStatus, AgentSessionStore } from './session-store';
import type { AgentTurnJob } from './turn-job';
import { SORTIE_ECHEC, SORTIE_PLAFOND } from './sorties';
import { restToState } from '../workflow/executor';
import type { SendRefusal } from '../workflow/executor';
import type { RunState } from '../workflow/run-store.pg';
import { messageDe } from '../lib/erreur';

/** Ce que `runTurn` a besoin de savoir du run, et rien de plus. */
export interface EtatRun {
  status: string;
  currentNode: string | null;
}

/** Résultat d'un envoi : une chaîne non vide vaut refus, le reste vaut succès (`SendRefusal` de l'exécuteur). */
export type ResultatEnvoi = SendRefusal;

export interface RunTurnDeps {
  sessions: Pick<AgentSessionStore, 'prendreLeTour' | 'clore' | 'ajouterAuTranscript' | 'ajouterCout' | 'finirLeTour' | 'sortieAppliquee'>;
  brain: AgentBrain;
  /** Relit le run par son id. `null` = introuvable, donc traité comme un run mort. */
  lireRun(tenantId: string, runId: string): Promise<EtatRun | null>;
  /** La fiche d'agent entière (plafonds et inactivité, une seule lecture). `null` = introuvable : on sort en
   *  erreur. */
  lireFiche(tenantId: string, agentId: string): Promise<FicheAgent | null>;
  /**
   * Écrit l'état du run après un tour qui attend, et pose l'échéance d'inactivité.
   *
   * 🔴 Écriture conditionnelle : seulement si le run attend toujours sur `nodeId`. Pendant les secondes du
   * tour, un opérateur a pu tuer ce run ; l'écrire le ressusciterait, et le balayeur déclencherait plus tard
   * la branche « pas de réponse » d'un parcours fermé exprès (`runs.setStateSiEncoreSur`, garde en SQL).
   * Absente : le parcours attend sans limite.
   */
  majRun?(tenantId: string, runId: string, nodeId: string, state: RunState): Promise<void>;
  /**
   * La conversation telle que le cerveau doit la lire : la mémoire de l'agent. Lue en base plutôt que reçue,
   * `advance` ne portant pas le texte entrant ; `recordInbound` tourne toujours avant, le fil est à jour.
   * Bornée par `depuis` (l'ouverture de la session). Absente : l'agent parle sans mémoire.
   */
  lireConversation?(tenantId: string, waId: string, depuis: string): Promise<unknown[]>;
  /** Le solde prépayé du workspace, en micro-euros. Absent : aucun plafond de workspace. */
  soldeTenant?(tenantId: string): Promise<number>;
  /** Retire du solde ce que ce tour a coûté. Absent -> rien n'est débité. */
  debiterTenant?(tenantId: string, montantMicroEur: number, sessionId: string): Promise<void>;
  /** Le fil est-il encore à nous ? Absent -> considéré comme oui (suites à deps minimales). */
  mayAct?(tenantId: string, waId: string): Promise<boolean>;
  /**
   * 🔴 Ce contact a-t-il demandé à ne plus rien recevoir ? La réponse de l'agent ne passe pas par
   * `WorkflowExecutor.apply` mais par `deps.envoyer` : elle a donc sa propre garde. Lue au rang des plafonds,
   * avant le modèle, pour ne pas payer un appel dont on jetterait la réponse. Requise : les tests déclarent
   * `jamaisDesabonne` (`tests/consentement.ts`) au lieu de l'omettre.
   */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /** Envoie le texte de l'agent, par la même dépendance que le reste du scénario (DRY_RUN honoré, message
   *  journalisé dans le fil). */
  envoyer(tenantId: string, waId: string, texte: string): Promise<ResultatEnvoi>;
  /** Mesure du bloc (Analytics). Optionnelle. */
  mesurer?(input: { tenantId: string; workflowId: string; nodeId: string; waId: string; kind: 'sent' | 'failed' }): Promise<void>;
  /** Clôt la session et reprend le scénario par la branche `sortie`. Fournie par le câblage. */
  sortir?(input: { tenantId: string; waId: string; runId: string; sessionId: string; sortie: string }): Promise<void>;
  now?: () => number;
}

/** Le repos d'un parcours après un tour qui attend. Sous-ensemble de `WalkRest` : un tour ne rend que cette
 *  forme, jamais un sommeil ni une fin de chaîne. */
export interface ReposApresTour {
  status: 'waiting';
  nodeId: string;
  /** Échéance d'inactivité. Absente, jamais zéro : voir `reposApresReponse`. */
  timeoutInMs?: number;
}

/** Ce que le tour a fait, pour le journal et les tests. Jamais une exception sur un cas métier. */
export interface ResultatTour {
  fait: 'rejeu' | 'run_mort' | 'plafond' | 'main_perdue' | 'desabonne' | 'repondu' | 'sorti' | 'erreur';
  sortie?: string;
  /**
   * Le repos posé sur le parcours, quand le tour s'est terminé en attente. Pour le journal et les tests
   * seulement : l'écriture est faite ici, un appelant qui la referait poserait l'échéance sans la garde du
   * bloc attendu.
   */
  repos?: ReposApresTour;
}

/**
 * Le repos d'un parcours après que l'agent a répondu et attend. Le piège est le zéro : `restToState` écrit
 * un `resume_at` dès que `timeoutInMs` est défini, donc `0` réveillerait le parcours dans la seconde et
 * sortirait l'agent par `timeout`. Une inactivité nulle ou négative veut dire « sans limite » et s'écrit en
 * omettant le champ.
 */
export function reposApresReponse(nodeId: string, inactiviteMinutes: number): ReposApresTour {
  const ms = Math.round(inactiviteMinutes * 60_000);
  return Number.isFinite(ms) && ms > 0
    ? { status: 'waiting', nodeId, timeoutInMs: ms }
    : { status: 'waiting', nodeId };
}

/** Budget de temps d'un tour. Au-delà, on préfère une sortie propre à une conversation qui pend. */
const DEADLINE_MS = 30_000;

/**
 * Persiste le repos du parcours par `restToState`, qui porte le piège du zéro. Best-effort : l'agent a déjà
 * parlé, faire échouer le tour renverrait le job en file, donc le message. On dégrade vers une attente sans
 * échéance.
 */
async function poserEcheance(
  job: AgentTurnJob, repos: ReposApresTour, maintenant: number, deps: RunTurnDeps,
): Promise<void> {
  if (!deps.majRun) return;
  try {
    await deps.majRun(job.tenantId, job.runId, job.nodeId, restToState(repos, maintenant));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: échéance d'inactivité non posée sur le run ${job.runId}`, messageDe(err));
  }
}

/**
 * Le tour est fini et la session reste vivante : on retire la marque de tour en vol, sur les deux seules
 * sorties concernées (l'agent attend, ou un humain a pris la main) ; les autres passent par `clore`. Sans
 * ça, le balayage tuerait une conversation saine. Best-effort, comme `poserEcheance`.
 */
async function finirLeTour(job: AgentTurnJob, sessionId: string, deps: RunTurnDeps): Promise<void> {
  if (!deps.sessions.finirLeTour) return;
  try {
    await deps.sessions.finirLeTour(job.tenantId, sessionId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: marque de tour non effacée sur la session ${sessionId}`, messageDe(err));
  }
}

/**
 * Enregistre ce qu'un tour a coûté : le solde prépayé du workspace d'abord, le compteur de la session
 * ensuite.
 *
 * 🔴 Deux tables, pas d'atomicité possible : le solde passe en premier parce que c'est de l'argent (un raté
 * y fait consommer sans facturer), quand un raté sur la session ne relâche qu'un plafond. Traces distinctes.
 * Best-effort : lever ferait retourner le job en file, donc repayer l'appel et réenvoyer le message.
 */
async function enregistrerCout(
  job: AgentTurnJob, sessionId: string, coutMicroEur: number, deps: RunTurnDeps,
): Promise<void> {
  if (!(coutMicroEur > 0)) return;
  if (deps.debiterTenant) {
    try {
      await deps.debiterTenant(job.tenantId, coutMicroEur, sessionId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`agent: SOLDE DU WORKSPACE NON DÉBITÉ (${coutMicroEur} micro-eur, session ${sessionId})`, messageDe(err));
    }
  }
  try {
    await deps.sessions.ajouterCout(job.tenantId, sessionId, coutMicroEur);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: coût du tour non enregistré sur la session ${sessionId}`, messageDe(err));
  }
}

/**
 * Clore puis faire sortir : la seule séquence qui converge.
 *
 * Un crash (ou un simple échec de `deps.sortir`) entre les deux écritures laissait la session close et le
 * run en attente sans échéance, introuvable. L'ordre ne s'inverse pas : `sortirDuBlocAgent` fait avancer le
 * parcours, qui peut retomber sur un autre bloc agent et réutiliser la session encore vivante, tours et
 * budget consommés. La réparation passe par la marque : on clôt en laissant `tour_commence_le`, on fait
 * sortir, puis on l'efface. Une panne au milieu laisse l'état que le balayage réclame ; `sortirDuBlocAgent`
 * est idempotente.
 */
async function cloreEtSortir(
  job: AgentTurnJob,
  sessionId: string,
  statut: AgentSessionStatus,
  sortie: string,
  deps: RunTurnDeps,
): Promise<void> {
  // `sortieDue` seulement s'il y a quelqu'un pour l'appliquer : sans `sortir` câblé, laisser la marque
  // ferait tourner le balayage sur une ligne que personne ne dénouera jamais.
  await deps.sessions.clore(job.tenantId, sessionId, statut, sortie, { sortieDue: deps.sortir !== undefined });
  if (!deps.sortir) return;
  await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId, sortie });
  await deps.sessions.sortieAppliquee?.(job.tenantId, sessionId);
}

export async function runTurn(job: AgentTurnJob, deps: RunTurnDeps): Promise<ResultatTour> {
  const maintenant = deps.now ? deps.now() : Date.now();

  // 1. Prendre le tour (verrou optimiste). `null` vaut rejeu : pg-boss est at-least-once, et un réveil
  // différé peut arriver après que le contact a fait avancer le tour.
  const session: AgentSession | null = await deps.sessions.prendreLeTour(job.tenantId, job.sessionId, job.tours);
  if (!session) return { fait: 'rejeu' };

  // 2. Relire le run : exiger qu'il attende toujours sur ce bloc rend sûr tout chemin qui tue un run
  // `waiting` sans connaître les sessions d'agent, présent ou futur.
  const run = await deps.lireRun(job.tenantId, job.runId);
  if (!run || run.status !== 'waiting' || run.currentNode !== job.nodeId) {
    await deps.sessions.clore(job.tenantId, session.id, 'erreur');
    return { fait: 'run_mort' };
  }

  // 3. Les plafonds, avant d'appeler le cerveau : on ne paie pas un appel dont on jettera la réponse, et une
  // injection qui fait boucler l'agent brûlerait le compte prépayé.
  const fiche = await deps.lireFiche(job.tenantId, session.agentId);
  if (!fiche) {
    // Même traitement que les autres échecs : sortir par la branche d'échec plutôt que laisser le run en attente.
    // eslint-disable-next-line no-console
    console.error(`agent: fiche introuvable pour l'agent ${session.agentId}, session ${session.id} close`);
    await cloreEtSortir(job, session.id, 'erreur', SORTIE_ECHEC, deps);
    return { fait: 'erreur', sortie: SORTIE_ECHEC };
  }
  // 🔴 Le solde prépayé, lu avec les autres plafonds, donc avant l'appel au modèle. Vide, tous les agents du
  // workspace s'arrêtent, par la même branche que les autres plafonds : le client la câble une seule fois.
  const soldeEpuise = deps.soldeTenant ? (await deps.soldeTenant(job.tenantId)) <= 0 : false;
  if (soldeEpuise
    || session.tours > fiche.plafonds.maxTours
    || session.appelsOutils > fiche.plafonds.maxAppelsOutils
    || session.coutMicroEur >= fiche.plafonds.budgetMicroEur) {
    await cloreEtSortir(job, session.id, 'plafond', SORTIE_PLAFOND, deps);
    return { fait: 'plafond', sortie: SORTIE_PLAFOND };
  }

  /**
   * 3bis. Le refus du contact, au même rang que les plafonds. La machine se tait, sans clore la session ni
   * sortir par l'échec : le message reste dans l'Inbox, où un opérateur peut encore répondre à la main (et
   * accuser réception du désabonnement). Même forme que `mayAct` : échéance posée, tour fini proprement.
   */
  if (await deps.estDesabonne(job.tenantId, job.waId)) {
    const repos = reposApresReponse(job.nodeId, fiche.inactiviteMinutes);
    await poserEcheance(job, repos, maintenant, deps);
    await finirLeTour(job, session.id, deps);
    return { fait: 'desabonne', repos };
  }

  // 4. Le cerveau, sous une échéance dure.
  let decision;
  try {
    // La conversation est lue après les plafonds. Une lecture qui échoue ne tue pas le tour : l'agent parlera
    // sans mémoire, dégradé mais utilisable.
    let transcript: unknown[] = [];
    if (deps.lireConversation) {
      try {
        transcript = await deps.lireConversation(job.tenantId, job.waId, session.ouvertLe);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`agent: conversation illisible pour la session ${session.id}, tour sans mémoire`, messageDe(err));
      }
    }
    decision = await deps.brain.penser({
      agentId: session.agentId,
      tenantId: job.tenantId,
      transcript,
      deadline: maintenant + DEADLINE_MS,
      // Où en est ce tour : les identifiants que les outils exigent et les compteurs des plafonds. Le
      // cerveau réel lève s'il manque : un tour sans contexte exécuterait les outils d'une conversation dans une
      // autre.
      tour: {
        sessionId: session.id,
        runId: job.runId,
        workflowId: job.workflowId,
        waId: job.waId,
        appelsDejaFaits: session.appelsOutils,
        coutDejaMicroEur: session.coutMicroEur,
      },
    });
  } catch (err) {
    // 🔴 Un aller-retour déjà facturé se paie, même quand le suivant échoue : `TourInterrompu` porte ce qui a
    // été dépensé.
    if (err instanceof TourInterrompu) await enregistrerCout(job, session.id, err.usage.coutMicroEur, deps);
    // Un plafond atteint chez le Gateway n'est pas un échec : même branche que le solde épuisé, vu de l'autre
    // côté. L'erreur peut voyager emballée dans `TourInterrompu`.
    const cause = err instanceof TourInterrompu ? err.erreur : err;
    if (cause instanceof PlafondModeleAtteint) {
      await cloreEtSortir(job, session.id, 'plafond', SORTIE_PLAFOND, deps);
      return { fait: 'plafond', sortie: SORTIE_PLAFOND };
    }
    // eslint-disable-next-line no-console
    console.error(`agent: le tour a échoué pour la session ${session.id}`, messageDe(err));
    await cloreEtSortir(job, session.id, 'erreur', SORTIE_ECHEC, deps);
    return { fait: 'erreur', sortie: SORTIE_ECHEC };
  }

  // Le coût est enregistré juste après la décision : tous les chemins qui suivent l'ont déjà engagé chez le
  // fournisseur.
  await enregistrerCout(job, session.id, decision.usage?.coutMicroEur ?? 0, deps);

  // 5. Relire `mayAct` juste avant d'envoyer : un opérateur a pu prendre la main pendant le tour. On ne clôt
  // pas la session (gel transitoire), mais on pose l'échéance d'inactivité, qu'`advance` vient d'effacer,
  // pour que le balayage ramasse un fil jamais rendu. Sauf quand c'est ce tour qui vient de passer la main
  // (`mainPriseParCeTour`, qui vient de l'écriture et non d'une relecture) : sinon la dernière phrase de
  // l'agent serait jetée.
  if (deps.mayAct && !decision.mainPriseParCeTour && !(await deps.mayAct(job.tenantId, job.waId))) {
    const repos = reposApresReponse(job.nodeId, fiche.inactiviteMinutes);
    await poserEcheance(job, repos, maintenant, deps);
    await finirLeTour(job, session.id, deps);
    return { fait: 'main_perdue', repos };
  }

  // 6 et 7. Envoyer, puis mesurer. `texte: null` est nominal : c'est le bloc aval qui parle.
  if (decision.texte !== null && decision.texte !== '') {
    const res = await deps.envoyer(job.tenantId, job.waId, decision.texte);
    const refuse = typeof res === 'string' && res !== '';
    if (deps.mesurer) {
      await deps.mesurer({
        tenantId: job.tenantId, workflowId: job.workflowId, nodeId: job.nodeId, waId: job.waId,
        kind: refuse ? 'failed' : 'sent',
      });
    }
    if (refuse) {
      // Le contact n'a rien reçu : sortie par la branche d'échec, le scénario reprend avec le repli du client.
      // eslint-disable-next-line no-console
      console.error(`agent: envoi refusé pour ${job.waId} : ${res}`);
      await cloreEtSortir(job, session.id, 'erreur', SORTIE_ECHEC, deps);
      return { fait: 'erreur', sortie: SORTIE_ECHEC };
    }
    await deps.sessions.ajouterAuTranscript(job.tenantId, session.id, { role: 'agent', texte: decision.texte });
  }

  // 8. Sortir, ou attendre sous échéance : le run reste `waiting` (une réponse du contact le reprend) et
  // porte un `resume_at` que le balayeur de réveil consomme, le mécanisme du bloc Question.
  if (decision.sortie === null) {
    const repos = reposApresReponse(job.nodeId, fiche.inactiviteMinutes);
    await poserEcheance(job, repos, maintenant, deps);
    await finirLeTour(job, session.id, deps);
    return { fait: 'repondu', repos };
  }
  await cloreEtSortir(job, session.id, 'sortie', decision.sortie, deps);
  return { fait: 'sorti', sortie: decision.sortie };
}
