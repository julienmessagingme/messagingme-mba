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
  sessions: Pick<AgentSessionStore, 'prendreLeTour' | 'clore' | 'ajouterAuTranscript' | 'ajouterCout' | 'finirLeTour' | 'sortieAppliquee'>;
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
  /**
   * La conversation, telle que le CERVEAU doit la lire.
   *
   * 🔴 C'EST LA MÉMOIRE DE L'AGENT, et sans elle il redemande son nom au contact à chaque message. Le tour la
   * LIT en base plutôt que de la recevoir : `advance` ne reçoit pas le texte du message entrant, et le lui
   * faire recevoir changerait la signature du chemin le plus chaud du produit et de ses trois appelants.
   * `recordInbound` tourne toujours avant `advance`, donc le fil est déjà à jour quand ce tour s'exécute.
   *
   * Bornée par `depuis` = l'ouverture de la session : l'agent voit ce qui s'est dit DEPUIS QU'IL A LA MAIN.
   *
   * Optionnelle comme les autres deps de câblage : absente, l'agent parle sans mémoire, ce qui est le
   * comportement d'avant cette tâche.
   */
  lireConversation?(tenantId: string, waId: string, depuis: string): Promise<unknown[]>;
  /**
   * Le solde prépayé du workspace, en micro-euros. Absent -> aucun plafond de workspace (suites à deps
   * minimales, et comportement d'avant la tâche 21).
   */
  soldeTenant?(tenantId: string): Promise<number>;
  /** Retire du solde ce que ce tour a coûté. Absent -> rien n'est débité. */
  debiterTenant?(tenantId: string, montantMicroEur: number, sessionId: string): Promise<void>;
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
 * Le tour est fini et la session reste VIVANTE : on retire la marque de tour en vol (migration 0112).
 *
 * 🔴 Les deux seules sorties concernées sont « l'agent a répondu et attend » et « un humain a pris la main » :
 * toutes les autres passent par `clore`, qui efface la marque en même temps qu'il change le statut. Oublier
 * l'une de ces deux ferait tuer par le balayage une conversation parfaitement saine, une dizaine de minutes
 * après une réponse réussie.
 *
 * BEST-EFFORT, comme `poserEcheance` et pour la même raison : l'agent a déjà parlé au contact quand on arrive
 * ici. Faire échouer le tour renverrait le job en file, donc renverrait le message. Le pire d'un échec ici est
 * une sortie par la branche d'échec au prochain balayage, jamais un doublon.
 */
async function finirLeTour(job: AgentTurnJob, sessionId: string, deps: RunTurnDeps): Promise<void> {
  if (!deps.sessions.finirLeTour) return;
  try {
    await deps.sessions.finirLeTour(job.tenantId, sessionId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: marque de tour non effacée sur la session ${sessionId}`, err instanceof Error ? err.message : err);
  }
}

/**
 * Enregistre ce qu'un tour a coûté : le SOLDE prépayé du workspace d'abord, le compteur de la session ensuite.
 *
 * 🔴 C'EST CE QUI RENDAIT LE BUDGET DÉCORATIF. `agent_sessions.cout_micro_eur` existait, la console affichait
 * un plafond par conversation, `runTurn` le comparait, et rien n'écrivait jamais ce cumul : la colonne restait
 * à zéro pour toujours, donc la comparaison était toujours fausse.
 *
 * 🔴 DEUX ÉCRITURES, DEUX GARDES SÉPARÉES, ET LE SOLDE EN PREMIER. Elles touchent deux tables et ne peuvent
 * pas être atomiques entre elles : si la seconde échoue, la première doit tenir. Le solde du workspace passe
 * donc d'abord, parce que c'est de l'ARGENT (un raté y fait consommer sans facturer, indéfiniment), alors
 * qu'un raté sur le compteur de session ne relâche qu'un plafond, sur une seule conversation. Et les deux
 * traces sont distinctes : un incident sur l'argent doit se repérer sans être noyé dans un raté de comptage.
 *
 * BEST-EFFORT dans les deux cas : le modèle a déjà répondu quand on arrive ici. Lever ferait retourner le job
 * en file, donc repayer l'appel et réenvoyer le message. On perd une ligne de comptabilité, jamais une
 * conversation.
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
      console.error(`agent: SOLDE DU WORKSPACE NON DÉBITÉ (${coutMicroEur} micro-eur, session ${sessionId})`, err instanceof Error ? err.message : err);
    }
  }
  try {
    await deps.sessions.ajouterCout(job.tenantId, sessionId, coutMicroEur);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: coût du tour non enregistré sur la session ${sessionId}`, err instanceof Error ? err.message : err);
  }
}

/**
 * UN tour d'agent.
 *
 * L'ordre des étapes EST le sujet : chacune est une garde, et leur ordre est ce qui rend le tour sûr. Voir
 * les commentaires de chaque étape. La fonction ne lève jamais sur un cas métier : elle rend ce qu'elle a
 * fait, pour que l'appelant (le job) journalise sans transformer un cas nominal en échec de file.
 */
/**
 * 🔴 CLORE PUIS FAIRE SORTIR : LA SEULE SÉQUENCE QUI CONVERGE (contre-audit du 2026-09-03).
 *
 * Ces deux écritures étaient recopiées aux cinq sorties terminales du tour, et un crash entre elles laissait
 * un parcours mort POUR TOUJOURS : la session close, le run en attente sur son bloc agent sans échéance, et
 * la clôture avait justement effacé le marqueur qui aurait permis au balayage de le retrouver. Le rejeu de
 * pg-boss ne rattrapait rien non plus, `prendreLeTour` exigeant `en_cours`. Seule une réécriture du contact
 * réveillait la conversation, c'est-à-dire le cas le moins probable : l'agent vient de se taire sur son
 * message. Et ce n'est pas qu'un scénario de crash, `deps.sortir` peut simplement ÉCHOUER (lecture du graphe,
 * pose de tag, pool épuisé) : toute panne passagère condamnait le parcours.
 *
 * ⚠️ L'ORDRE NE S'INVERSE PAS, et c'est le piège de ce correctif. Sortir avant de clore paraît plus sûr,
 * puisqu'un échec laisserait alors une session vivante. Mais `sortirDuBlocAgent` fait AVANCER le parcours,
 * qui peut retomber sur un autre bloc agent DANS LE MÊME APPEL : `demarrerTourAgent` réutilise alors la
 * session encore vivante (`byRun ?? open`), avec ses tours et son budget déjà consommés, et le nouvel agent
 * est muet dès son premier tour. La fenêtre n'est pas de quelques millisecondes, elle couvre tout l'appel.
 *
 * La réparation passe donc par la MARQUE, pas par l'ordre : on clôt en laissant `tour_commence_le` en place,
 * on fait sortir, puis on efface la marque. Une panne au milieu laisse exactement l'état que le balayage des
 * tours bloqués sait déjà réclamer, et `sortirDuBlocAgent` est idempotente (identifiant synthétique porté par
 * la session, déduplication `lastMessageId` à l'entrée d'`advance`).
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
    await cloreEtSortir(job, session.id, 'erreur', SORTIE_ECHEC, deps);
    return { fait: 'erreur', sortie: SORTIE_ECHEC };
  }
  // 🔴 LE SOLDE PRÉPAYÉ DU WORKSPACE, lu ICI et pas ailleurs : avec les autres plafonds, donc AVANT l'appel
  // au modèle. Le lire après reviendrait à payer un appel qu'on savait ne pas pouvoir facturer. Vide, tous
  // les agents du workspace s'arrêtent, et le parcours sort par la même branche que les autres plafonds :
  // le client câble « Plafond atteint » une seule fois, quelle qu'en soit la raison.
  const soldeEpuise = deps.soldeTenant ? (await deps.soldeTenant(job.tenantId)) <= 0 : false;
  if (soldeEpuise
    || session.tours > fiche.plafonds.maxTours
    || session.appelsOutils > fiche.plafonds.maxAppelsOutils
    || session.coutMicroEur >= fiche.plafonds.budgetMicroEur) {
    await cloreEtSortir(job, session.id, 'plafond', SORTIE_PLAFOND, deps);
    return { fait: 'plafond', sortie: SORTIE_PLAFOND };
  }

  // 4. LE CERVEAU, sous une échéance dure. Une conversation qui pend coûte plus cher qu'une sortie propre.
  let decision;
  try {
    // La conversation est lue APRÈS les plafonds : on ne paie pas une requête pour un tour qu'on va refuser.
    // Une lecture qui échoue ne doit pas tuer le tour non plus : l'agent parlera sans mémoire, ce qui est
    // dégradé mais utilisable, alors qu'un tour mort laisse le contact sans réponse.
    let transcript: unknown[] = [];
    if (deps.lireConversation) {
      try {
        transcript = await deps.lireConversation(job.tenantId, job.waId, session.ouvertLe);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`agent: conversation illisible pour la session ${session.id}, tour sans mémoire`, err instanceof Error ? err.message : err);
      }
    }
    decision = await deps.brain.penser({
      agentId: session.agentId,
      tenantId: job.tenantId,
      transcript,
      deadline: maintenant + DEADLINE_MS,
      // 🔴 OÙ EN EST CE TOUR. Un cerveau qui appelle des outils ne peut pas s'en passer : il en tire les
      // identifiants que les outils exigent (envoyer un bloc DE CE parcours, escalader CETTE session) et les
      // compteurs qui rendent les plafonds effectifs d'un tour sur l'autre. Le cerveau réel LÈVE s'il manque,
      // et c'est voulu : un tour sans contexte exécuterait les outils d'une conversation dans une autre.
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
    // 🔴 UN ALLER-RETOUR DÉJÀ FACTURÉ SE PAIE, MÊME QUAND LE SUIVANT ÉCHOUE. Le cerveau lève un
    // `TourInterrompu` qui porte ce qu'il avait déjà dépensé : sans cette ligne, un tour qui appelle un outil
    // puis casse sur son second appel de modèle serait entièrement gratuit pour le workspace, alors que le
    // fournisseur, lui, a bien facturé le premier.
    if (err instanceof TourInterrompu) await enregistrerCout(job, session.id, err.usage.coutMicroEur, deps);
    // 🔴 UN PLAFOND ATTEINT N'EST PAS UN ECHEC, et il sort par la MEME branche que le solde epuise lu plus
    // haut. C'est la meme situation vue des deux cotes : notre comptage dit « plus de credit », le Gateway
    // dit « plafond de la cle atteint ». Les separer obligerait le client a cabler deux sorties pour un seul
    // fait, et lui montrerait « Echec » la ou la reponse est « rechargez ».
    // ⚠️ L'erreur voyage EMBALLEE dans `TourInterrompu` quand un aller-retour avait deja ete facture : il
    // faut donc regarder les deux, l'erreur nue et celle qu'elle transporte.
    const cause = err instanceof TourInterrompu ? err.erreur : err;
    if (cause instanceof PlafondModeleAtteint) {
      await cloreEtSortir(job, session.id, 'plafond', SORTIE_PLAFOND, deps);
      return { fait: 'plafond', sortie: SORTIE_PLAFOND };
    }
    // eslint-disable-next-line no-console
    console.error(`agent: le tour a échoué pour la session ${session.id}`, err instanceof Error ? err.message : err);
    await cloreEtSortir(job, session.id, 'erreur', SORTIE_ECHEC, deps);
    return { fait: 'erreur', sortie: SORTIE_ECHEC };
  }

  // ENREGISTRER CE QUE CE TOUR A COÛTÉ, juste après la décision et pas plus loin : ce qui suit peut sortir par
  // plusieurs chemins (envoi refusé, sortie d'outil, main perdue), et le coût est déjà engagé chez le
  // fournisseur dans tous. Le placer sur un seul de ces chemins ferait des tours gratuits.
  await enregistrerCout(job, session.id, decision.usage?.coutMicroEur ?? 0, deps);

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
    await finirLeTour(job, session.id, deps);
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
      await cloreEtSortir(job, session.id, 'erreur', SORTIE_ECHEC, deps);
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
    await finirLeTour(job, session.id, deps);
    return { fait: 'repondu', repos };
  }
  await cloreEtSortir(job, session.id, 'sortie', decision.sortie, deps);
  return { fait: 'sorti', sortie: decision.sortie };
}
