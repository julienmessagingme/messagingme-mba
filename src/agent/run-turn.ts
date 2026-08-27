import type { AgentBrain } from './brain';
import type { AgentSession, AgentSessionStore } from './session-store';
import type { AgentTurnJob } from './turn-job';

/** Les plafonds d'un agent, lus sur sa fiche. Ce sont des gardes de SÉCURITÉ, pas un détail de facturation :
 *  une injection qui fait boucler l'agent brûlerait le compte prépayé du tenant. */
export interface PlafondsAgent {
  maxTours: number;
  maxAppelsOutils: number;
  budgetMicroEur: number;
}

/** Ce que `runTurn` a besoin de savoir du run, et rien de plus. */
export interface EtatRun {
  status: string;
  currentNode: string | null;
}

/**
 * Résultat d'un envoi : une chaîne non vide vaut refus, le reste vaut succès.
 *
 * ⚠️ Même forme que `SendRefusal` (`src/workflow/executor.ts`), et RECOPIÉE plutôt qu'importée : l'exécuteur
 * importe déjà des types de ce dossier (`session-store`, `turn-job`), donc l'importer d'ici créerait un cycle
 * entre les deux modules. Les deux formes doivent rester alignées ; elles ne bougent pas.
 */
export type ResultatEnvoi = void | string | { messageId: string };

export interface RunTurnDeps {
  sessions: Pick<AgentSessionStore, 'prendreLeTour' | 'clore' | 'ajouterAuTranscript'>;
  brain: AgentBrain;
  /** Relit le run par son id. `null` = introuvable, donc traité comme un run mort. */
  lireRun(tenantId: string, runId: string): Promise<EtatRun | null>;
  /** Plafonds de la fiche d'agent. `null` = fiche introuvable, on ne devine pas, on sort en erreur. */
  lirePlafonds(tenantId: string, agentId: string): Promise<PlafondsAgent | null>;
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

/** Ce que le tour a fait, pour le journal et les tests. Jamais une exception sur un cas métier. */
export interface ResultatTour {
  fait: 'rejeu' | 'run_mort' | 'plafond' | 'main_perdue' | 'repondu' | 'sorti' | 'erreur';
  sortie?: string;
}

/** Budget de temps d'un tour. Au-delà, on préfère une sortie propre à une conversation qui pend. */
const DEADLINE_MS = 30_000;

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
  const plafonds = await deps.lirePlafonds(job.tenantId, session.agentId);
  if (!plafonds) {
    // Même traitement que les autres échecs : on sort par la branche d'échec plutôt que de laisser le
    // parcours en plan. Sans ça, ce chemin clôturait la session mais laissait le run en attente sur le bloc,
    // donc une conversation muette. Cas quasi inatteignable (la session tombe avec l'agent, `on delete
    // cascade`), mais l'incohérence n'a pas de raison d'être.
    // eslint-disable-next-line no-console
    console.error(`agent: fiche introuvable pour l'agent ${session.agentId}, session ${session.id} close`);
    await deps.sessions.clore(job.tenantId, session.id, 'erreur', 'echec');
    if (deps.sortir) {
      await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: 'echec' });
    }
    return { fait: 'erreur', sortie: 'echec' };
  }
  if (session.tours > plafonds.maxTours
    || session.appelsOutils > plafonds.maxAppelsOutils
    || session.coutMicroEur >= plafonds.budgetMicroEur) {
    await deps.sessions.clore(job.tenantId, session.id, 'plafond', 'plafond');
    if (deps.sortir) {
      await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: 'plafond' });
    }
    return { fait: 'plafond', sortie: 'plafond' };
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
    await deps.sessions.clore(job.tenantId, session.id, 'erreur', 'echec');
    if (deps.sortir) {
      await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: 'echec' });
    }
    return { fait: 'erreur', sortie: 'echec' };
  }

  // 5. RELIRE `mayAct` JUSTE AVANT D'ENVOYER, pas seulement à l'entrée du tour : entre l'enfilage du job et
  // son exécution il s'est écoulé plusieurs secondes, et un opérateur a pu prendre la main entre-temps. On ne
  // clôt PAS la session : le gel est transitoire, la conversation repartira quand le contrôle reviendra.
  if (deps.mayAct && !(await deps.mayAct(job.tenantId, job.waId))) {
    return { fait: 'main_perdue' };
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
      await deps.sessions.clore(job.tenantId, session.id, 'erreur', 'echec');
      if (deps.sortir) {
        await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: 'echec' });
      }
      return { fait: 'erreur', sortie: 'echec' };
    }
    await deps.sessions.ajouterAuTranscript(job.tenantId, session.id, { role: 'agent', texte: decision.texte });
  }

  // 8. SORTIR, ou attendre. Pas de sortie décidée : le tour se termine et le parcours reste en attente de la
  // réponse du contact (le réveil d'inactivité est posé par la tâche 17). Sortie décidée : on clôt la session
  // et le scénario reprend par sa branche.
  if (decision.sortie === null) return { fait: 'repondu' };
  await deps.sessions.clore(job.tenantId, session.id, 'sortie', decision.sortie);
  if (deps.sortir) {
    await deps.sortir({ tenantId: job.tenantId, waId: job.waId, runId: job.runId, sessionId: session.id, sortie: decision.sortie });
  }
  return { fait: 'sorti', sortie: decision.sortie };
}
