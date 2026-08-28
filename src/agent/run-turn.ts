import type { AgentBrain } from './brain';
import type { FicheAgent } from './agent-store';
import type { AgentSession, AgentSessionStore } from './session-store';
import type { AgentTurnJob } from './turn-job';
import { SORTIE_ECHEC, SORTIE_PLAFOND } from './sorties';
import { restToState } from '../workflow/executor';
import type { SendRefusal } from '../workflow/executor';
import type { RunState } from '../workflow/run-store.pg';

/** Ce que `runTurn` a besoin de savoir du run, et rien de plus. */
export interface EtatRun {
  status: string;
  currentNode: string | null;
}

/**
 * Résultat d'un envoi : une chaîne non vide vaut refus, le reste vaut succès.
 *
 * C'est `SendRefusal` de l'exécuteur, importé et non recopié. L'ancienne recopie s'appuyait sur un cycle
 * d'imports qui n'existe pas : les imports de l'exécuteur vers ce dossier sont tous des `import type`, donc
 * effacés à la compilation, et ce module importe désormais une VALEUR de l'exécuteur (`restToState`) sans
 * qu'aucun cycle n'apparaisse.
 */
export type ResultatEnvoi = SendRefusal;

export interface RunTurnDeps {
  sessions: Pick<AgentSessionStore, 'prendreLeTour' | 'clore' | 'ajouterAuTranscript'>;
  brain: AgentBrain;
  /** Relit le run par son id. `null` = introuvable, donc traité comme un run mort. */
  lireRun(tenantId: string, runId: string): Promise<EtatRun | null>;
  /**
   * La fiche d'agent. `null` = introuvable, on ne devine pas, on sort en erreur.
   *
   * La fiche ENTIÈRE et pas seulement ses plafonds : le tour a aussi besoin de l'inactivité, et deux lectures
   * de la même ligne seraient deux requêtes pour rien. C'est `AgentStore.byId` au câblage.
   */
  lireFiche(tenantId: string, agentId: string): Promise<FicheAgent | null>;
  /**
   * Écrit l'état du run après un tour qui ATTEND (l'agent a parlé, ou la main lui a échappé), et c'est ce qui
   * pose l'échéance d'inactivité.
   *
   * 🔴 L'ÉCRITURE DOIT ÊTRE CONDITIONNELLE : `nodeId` est le bloc sur lequel le run est censé attendre, et
   * rien ne doit être écrit s'il a bougé. Le tour dure plusieurs secondes, pendant lesquelles un opérateur
   * peut avoir tué ce run ; l'écrire quand même le ressusciterait avec une échéance, et le balayeur
   * déclencherait plus tard la branche « pas de réponse » d'un parcours fermé exprès. Au câblage, c'est
   * `runs.setStateSiEncoreSur`, qui porte la garde en SQL.
   *
   * Optionnelle, comme les autres deps de câblage : absente, le parcours attend sans limite, ce qui est le
   * comportement d'avant cette tâche.
   */
  majRun?(tenantId: string, runId: string, nodeId: string, state: RunState): Promise<void>;
  /** Le fil est-il encore à nous ? Absent -> considéré comme oui (suites à deps minimales). */
  mayAct?(tenantId: string, waId: string): Promise<boolean>;
  /** Envoie le texte de l'agent. MÊME dépendance que le reste du scénario, donc DRY_RUN honoré et
   *  message journalisé dans le fil. */
  envoyer(tenantId: string, waId: string, texte: string): Promise<ResultatEnvoi>;
  /** Mesure du bloc (Analytics). Optionnelle. */
  mesurer?(input: { tenantId: string; workflowId: string; nodeId: string; waId: string; kind: 'sent' | 'failed' }): Promise<void>;
  /** Clôt la session et reprend le scénario par la branche `sortie`. Fournie par le câblage (13b). */
  sortir?(input: { tenantId: string; waId: string; runId: string; sessionId: string; sortie: string }): Promise<void>;
  now?: () => number;
}

/** Le repos d'un parcours après un tour qui attend. Sous-ensemble de `WalkRest`, volontairement : un tour ne
 *  peut rendre QUE cette forme-là, jamais un sommeil ni une fin de chaîne. */
export interface ReposApresTour {
  status: 'waiting';
  nodeId: string;
  /** Échéance d'inactivité. ABSENT, jamais zéro : voir `reposApresReponse`. */
  timeoutInMs?: number;
}

/** Ce que le tour a fait, pour le journal et les tests. Jamais une exception sur un cas métier. */
export interface ResultatTour {
  fait: 'rejeu' | 'run_mort' | 'plafond' | 'main_perdue' | 'repondu' | 'sorti' | 'erreur';
  sortie?: string;
  /**
   * Le repos posé sur le parcours, quand le tour s'est terminé en attente.
   *
   * ⚠️ POUR LE JOURNAL ET LES TESTS UNIQUEMENT. L'écriture est faite ICI, par le tour : un appelant qui le
   * repersisterait poserait l'échéance deux fois, la seconde sans la garde du bloc attendu.
   */
  repos?: ReposApresTour;
}

/**
 * Le repos d'un parcours après que l'agent a répondu et attend.
 *
 * 🔴 LE PIÈGE EST LE ZÉRO, et il est déjà documenté deux fois dans `src/queue/pgboss.ts` pour `startAfter` et
 * `max`. `restToState` n'écrit un `resume_at` que si `timeoutInMs` est DÉFINI : transmettre `0` au lieu d'un
 * champ absent poserait une échéance IMMÉDIATE, donc réveillerait le parcours dans la seconde et sortirait
 * l'agent par `timeout` avant que le contact ait eu le temps de lire. Une inactivité nulle ou négative veut
 * dire « attendre sans limite », et s'écrit en OMETTANT le champ.
 *
 * La colonne `agents.inactivite_minutes` est bornée entre 1 et 1440 en base, donc le zéro ne peut pas venir
 * de là. Il peut venir d'une fiche construite en mémoire, d'un test, ou d'un futur réglage : la garde reste.
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
 * Persiste le repos du parcours, échéance comprise. `restToState` est réutilisée TELLE QUELLE : la traduction
 * repos vers état de run n'a aucune raison d'être réécrite ici, et c'est elle qui porte le piège du zéro.
 *
 * BEST-EFFORT : l'agent a déjà parlé au contact quand on arrive ici. Faire échouer le tour renverrait le job
 * en file d'échec, donc renverrait le message. On dégrade vers « attente sans échéance », qui est le
 * comportement d'avant cette tâche, et la trace dit pourquoi.
 */
async function poserEcheance(
  job: AgentTurnJob, repos: ReposApresTour, maintenant: number, deps: RunTurnDeps,
): Promise<void> {
  if (!deps.majRun) return;
  try {
    await deps.majRun(job.tenantId, job.runId, job.nodeId, restToState(repos, maintenant));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: échéance d'inactivité non posée sur le run ${job.runId}`, err instanceof Error ? err.message : err);
  }
}

/**
 * UN tour d'agent.
 *
 * L'ordre des étapes EST le sujet : chacune est une garde, et leur ordre est ce qui rend le tour sûr. Voir
 * les commentaires de chaque étape. La fonction ne lève jamais sur un cas métier : elle rend ce qu'elle a
 * fait, pour que l'appelant (le job) journalise sans transformer un cas nominal en échec de file.
 */
export async function runTurn(job: AgentTurnJob, deps: RunTurnDeps): Promise<ResultatTour> {
  const maintenant = deps.now ? deps.now() : Date.now();

  // 1. PRENDRE LE TOUR (verrou optimiste). `null` vaut REJEU : pg-boss est at-least-once, et un réveil
  // d'inactivité différé peut arriver après que le contact a déjà répondu et fait avancer le tour. On sort
  // sans rien faire plutôt que de rejouer une réponse périmée.
  const session: AgentSession | null = await deps.sessions.prendreLeTour(job.tenantId, job.sessionId, job.tours);
  if (!session) return { fait: 'rejeu' };

  // 2. RELIRE LE RUN. Une SEULE garde plutôt que six correctifs : plusieurs chemins tuent un run `waiting`
  // sans rien savoir des sessions d'agent (lancement manuel depuis l'inbox, jeton de test, clôtures internes
  // d'`advance` et de `resume`). En exigeant ici que le run attende toujours SUR CE bloc, tout tueur de run
  // FUTUR devient automatiquement sûr, sans qu'on ait à le connaître.
  const run = await deps.lireRun(job.tenantId, job.runId);
  if (!run || run.status !== 'waiting' || run.currentNode !== job.nodeId) {
    await deps.sessions.clore(job.tenantId, session.id, 'erreur');
    return { fait: 'run_mort' };
  }

  // 3. LES PLAFONDS, AVANT d'appeler le cerveau : on ne paie pas un appel dont on jettera la réponse. Ce sont
  // des gardes de sécurité, pas de la comptabilité : une injection qui fait boucler l'agent brûlerait le
  // compte prépayé du tenant.
  const fiche = await deps.lireFiche(job.tenantId, session.agentId);
  if (!fiche) {
    // Même traitement que les autres échecs : on sort par la branche d'échec plutôt que de laisser le
    // parcours en plan. Sans ça, ce chemin clôturait la session mais laissait le run en attente sur le bloc,
    // donc une conversation muette. Cas quasi inatteignable (la session tombe avec l'agent, `on delete
    // cascade`), mais l'incohérence n'a pas de raison d'être.
    // eslint-disable-next-line no-console
    console.error(`agent: fiche introuvable pour l'agent ${session.agentId}, session ${session.id} close`);
    await deps.sessions.clore(job.tenantId, session.id, 'erreur', SORTIE_ECHEC);
    if (deps.sortir) {
      await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: SORTIE_ECHEC });
    }
    return { fait: 'erreur', sortie: SORTIE_ECHEC };
  }
  if (session.tours > fiche.plafonds.maxTours
    || session.appelsOutils > fiche.plafonds.maxAppelsOutils
    || session.coutMicroEur >= fiche.plafonds.budgetMicroEur) {
    await deps.sessions.clore(job.tenantId, session.id, 'plafond', SORTIE_PLAFOND);
    if (deps.sortir) {
      await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: SORTIE_PLAFOND });
    }
    return { fait: 'plafond', sortie: SORTIE_PLAFOND };
  }

  // 4. LE CERVEAU, sous une échéance dure. Une conversation qui pend coûte plus cher qu'une sortie propre.
  let decision;
  try {
    decision = await deps.brain.penser({
      agentId: session.agentId,
      tenantId: job.tenantId,
      transcript: [],
      deadline: maintenant + DEADLINE_MS,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: le tour a échoué pour la session ${session.id}`, err instanceof Error ? err.message : err);
    await deps.sessions.clore(job.tenantId, session.id, 'erreur', SORTIE_ECHEC);
    if (deps.sortir) {
      await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: SORTIE_ECHEC });
    }
    return { fait: 'erreur', sortie: SORTIE_ECHEC };
  }

  // 5. RELIRE `mayAct` JUSTE AVANT D'ENVOYER, pas seulement à l'entrée du tour : entre l'enfilage du job et
  // son exécution il s'est écoulé plusieurs secondes, et un opérateur a pu prendre la main entre-temps. On ne
  // clôt PAS la session : le gel est transitoire, la conversation repartira quand le contrôle reviendra.
  //
  // L'échéance d'inactivité est posée QUAND MÊME, et c'est voulu : `advance` vient de l'effacer en enfilant ce
  // tour, et sans elle un fil repris par un humain qui ne revient jamais laisserait un run en attente et une
  // session vivante pour toujours. Avec elle, le balayage les ramasse au bout du délai.
  if (deps.mayAct && !(await deps.mayAct(job.tenantId, job.waId))) {
    const repos = reposApresReponse(job.nodeId, fiche.inactiviteMinutes);
    await poserEcheance(job, repos, maintenant, deps);
    return { fait: 'main_perdue', repos };
  }

  // 6 et 7. ENVOYER, puis MESURER. `texte: null` est un cas nominal : l'agent ne dit rien parce que c'est le
  // bloc AVAL qui parle (escalade, reprise du scénario).
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
      // Le contact n'a rien reçu : on ne laisse pas la session ouverte en silence, on sort par la branche
      // d'échec pour que le scénario reprenne avec le message de repli du client.
      // eslint-disable-next-line no-console
      console.error(`agent: envoi refusé pour ${job.waId} : ${res}`);
      await deps.sessions.clore(job.tenantId, session.id, 'erreur', SORTIE_ECHEC);
      if (deps.sortir) {
        await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: SORTIE_ECHEC });
      }
      return { fait: 'erreur', sortie: SORTIE_ECHEC };
    }
    await deps.sessions.ajouterAuTranscript(job.tenantId, session.id, { role: 'agent', texte: decision.texte });
  }

  // 8. SORTIR, ou ATTENDRE SOUS ÉCHÉANCE.
  //
  // 🔴 IL N'Y A AUCUN MÉCANISME D'INACTIVITÉ À ÉCRIRE, et c'est tout l'intérêt : le bloc Question en a déjà
  // apporté un, en production, et l'agent monte dessus. Le run reste `waiting` (donc `findWaitingByWaId` le
  // voit et une réponse du contact peut le reprendre) et porte EN PLUS un `resume_at` que le balayeur de
  // réveil consomme. C'est le seul état du produit qui attend les deux à la fois.
  if (decision.sortie === null) {
    const repos = reposApresReponse(job.nodeId, fiche.inactiviteMinutes);
    await poserEcheance(job, repos, maintenant, deps);
    return { fait: 'repondu', repos };
  }
  await deps.sessions.clore(job.tenantId, session.id, 'sortie', decision.sortie);
  if (deps.sortir) {
    await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: decision.sortie });
  }
  return { fait: 'sorti', sortie: decision.sortie };
}
