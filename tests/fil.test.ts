import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ControleDuFil } from '../src/inbox/fil';
import type { ControlOwner } from '../src/inbox/store.pg';
import { runControlSweep } from '../src/inbox/control-sweep';
import { handleWebhookJob, type WebhookJobDeps } from '../src/webhooks/handler';
import { assignerReponse, type CampagneAssignante } from '../src/inbox/assignation-campagne';
import { processRoutagePub, type RoutagePubDeps } from '../src/webhooks/routage-pub';
import { runAutomations, type AutomationRunnerDeps } from '../src/automation/runner';
import { POSSESSEUR_LIEN_CHAINE, POSSESSEUR_PUBLICITE } from '../src/automation/match';
import type { AutomationEvent, AutomationRow } from '../src/automation/match';
import { WorkflowExecutor, type WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';
import type { IssueRoutage } from '../src/pubs/routage';
import { bancDuFil, type EtatDuFil, type OptionsBanc } from './banc-du-fil';
import { aucunNumeroDelie, aucunRoutagePub, aucunSignalReponse, aucuneArriveePub, entrantsDe } from './webhook-fixtures';
import { aucunStop, jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';

/**
 * LA TABLE DU CONTRÔLE DU FIL, EXÉCUTÉE (`src/inbox/fil.ts`).
 *
 * Chaque ligne : un geste, l'état de départ de la conversation, ce que Meta répond, et ce qu'on attend (ce que le
 * geste rend, les appels partis chez Meta dans l'ordre, l'état d'arrivée de notre colonne et de ses marques). Le
 * module réel tourne sur un dépôt en mémoire fidèle au `update` gardé de `PgInboxStore.setControlOwner`, et sur un
 * faux client Meta qui accepte, refuse, ou refuse une fois puis accepte (`tests/banc-du-fil.ts`).
 *
 * Les décisions de Julien du 2026-09-27 ont chacune leur `describe` plus bas, et chacune a été vérifiée dans les
 * deux sens : l'ancien comportement remis, le cas échoue avec son symptôme.
 */

const ESCALADE = new Date('2026-09-27T10:00:00Z');
const AVANT_ESCALADE = new Date('2026-09-27T09:00:00Z');
const APRES_ESCALADE = new Date('2026-09-27T11:00:00Z');

interface Cas {
  nom: string;
  depart: Partial<EtatDuFil> | null;
  banc?: Omit<OptionsBanc, 'conversations'>;
  geste: (fil: ControleDuFil) => Promise<unknown>;
  rend?: unknown;
  leve?: true;
  meta: string[];
  arrivee: { owner: ControlOwner; escaladee?: boolean; marque?: string | null } | null;
}

const escaladee = { escaladeeLe: ESCALADE };
/** La cause que l'appelant d'un passage à l'équipe porte (le scénario ou l'agent IA qui passe la main). */
const CAUSE_SCENARIO = 'automatique : scénario test';

const TABLE: Cas[] = [
  // 1. Un opérateur ou une machine écrit : aucun appel, l'envoi WhatsApp prend le fil.
  { nom: '1. écrit, depuis mba : app_human sans appel', depart: { owner: 'mba' }, geste: (f) => f.prisEnEcrivant('t1', 'w', { collaborateur: null }), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '1. écrit, depuis app_workflow : app_human sans appel', depart: { owner: 'app_workflow' }, geste: (f) => f.prisEnEcrivant('t1', 'w', { collaborateur: null }), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '1. écrit, fil escaladé : l’escalade reste (c’est l’équipe qu’on attend)', depart: { owner: 'mba', ...escaladee }, geste: (f) => f.prisEnEcrivant('t1', 'w', { collaborateur: null }), meta: [], arrivee: { owner: 'app_human', escaladee: true } },

  // 2. « Reprendre la main ».
  { nom: '2. reprendre, mba, Meta accepte : take puis app_human', depart: { owner: 'mba' }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: ['take:w'], arrivee: { owner: 'app_human' } },
  { nom: '2. reprendre, mba, Meta refuse : rien d’écrit', depart: { owner: 'mba' }, banc: { take: ['refuse'] }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'refuse', meta: ['take:w'], arrivee: { owner: 'mba' } },
  { nom: '2. reprendre, mba, Meta refuse une fois puis accepte : un rejeu', depart: { owner: 'mba' }, banc: { take: ['passager', 'accepte'] }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: ['take:w', 'take:w'], arrivee: { owner: 'app_human' } },
  { nom: '2. reprendre, agent éteint : aucun appel', depart: { owner: 'mba' }, banc: { mbaEnabled: false }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: [], arrivee: { owner: 'app_human' } },
  { nom: '2. reprendre, fil déjà à nous : aucun appel', depart: { owner: 'app_workflow' }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: [], arrivee: { owner: 'app_human' } },
  { nom: '2. reprendre, aucun numéro : aucun appel, le fil est à l’équipe', depart: { owner: 'mba' }, banc: { numero: null }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: [], arrivee: { owner: 'app_human' } },

  // 3. « Rendre la main ».
  { nom: '3. rendre, humain escaladé, Meta accepte : release puis mba, escalade effacée', depart: { owner: 'app_human', ...escaladee }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'mba', meta: ['release:w'], arrivee: { owner: 'mba', escaladee: false } },
  { nom: '3. rendre, Meta refuse : lève, rien d’écrit', depart: { owner: 'app_human' }, banc: { release: ['refuse'] }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), leve: true, meta: ['release:w'], arrivee: { owner: 'app_human' } },
  { nom: '3. rendre, agent éteint : app_workflow sans appel, escalade effacée', depart: { owner: 'app_human', ...escaladee }, banc: { mbaEnabled: false }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'app_workflow', meta: [], arrivee: { owner: 'app_workflow', escaladee: false } },
  { nom: '3. rendre, colonne déjà mba : on rouvre notre côté sans appel (release hors contrat)', depart: { owner: 'mba' }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'app_workflow', meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '3. rendre, agent allumé sans numéro : rien d’écrit', depart: { owner: 'app_human' }, banc: { numero: null }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'aucun_numero', meta: [], arrivee: { owner: 'app_human' } },
  { nom: '3. rendre, fil de test : le bouton le peut', depart: { owner: 'app_human', test: true }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'mba', meta: ['release:w'], arrivee: { owner: 'mba' } },

  // 4. Fin de parcours.
  { nom: '4. fin de parcours, rien en vol, Meta accepte : app_human puis mba', depart: { owner: 'app_workflow' }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: ['release:w'], arrivee: { owner: 'mba' } },
  { nom: '4. fin de parcours, envoi en vol : marque, attente, aucun appel', depart: { owner: 'app_workflow', enVol: 'wamid.X' }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human', marque: 'wamid.X' } },
  { nom: '4. fin de parcours, Meta refuse : lève, reste app_human', depart: { owner: 'app_workflow' }, banc: { release: ['refuse'] }, geste: (f) => f.rendreApresParcours('t1', 'w'), leve: true, meta: ['release:w'], arrivee: { owner: 'app_human' } },
  { nom: '4. fin de parcours, fil escaladé : l’escalade part dès l’attente', depart: { owner: 'app_workflow', ...escaladee }, banc: { release: ['refuse'] }, geste: (f) => f.rendreApresParcours('t1', 'w'), leve: true, meta: ['release:w'], arrivee: { owner: 'app_human', escaladee: false } },
  { nom: '4. fin de parcours, un opérateur tient le fil : rien', depart: { owner: 'app_human' }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '4. fin de parcours, aucun numéro : reste en attente, jamais mba', depart: { owner: 'app_workflow' }, banc: { numero: null }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '4. fin de parcours, fil de test : reste en attente, aucun appel', depart: { owner: 'app_workflow', test: true }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human' } },

  // 5. Remise sur accusé.
  { nom: '5. accusé attendu, Meta accepte : marque consommée, mba, escalade effacée', depart: { owner: 'app_human', marque: 'wamid.A', ...escaladee }, geste: (f) => f.remettreSurAccuse('wamid.A'), meta: ['release:w'], arrivee: { owner: 'mba', marque: null, escaladee: false } },
  { nom: '5. accusé d’un autre message : rien', depart: { owner: 'app_human', marque: 'wamid.A' }, geste: (f) => f.remettreSurAccuse('wamid.B'), meta: [], arrivee: { owner: 'app_human', marque: 'wamid.A' } },
  { nom: '5. accusé, Meta refuse : marque consommée quand même, reste app_human', depart: { owner: 'app_human', marque: 'wamid.A' }, banc: { release: ['refuse'] }, geste: (f) => f.remettreSurAccuse('wamid.A'), leve: true, meta: ['release:w'], arrivee: { owner: 'app_human', marque: null } },
  { nom: '5. accusé, aucun numéro : reste app_human', depart: { owner: 'app_human', marque: 'wamid.A' }, banc: { numero: null }, geste: (f) => f.remettreSurAccuse('wamid.A'), meta: [], arrivee: { owner: 'app_human', marque: null } },

  // 6. Le client revient et personne ne suit.
  { nom: '6. personne ne suit, app_workflow : release puis mba', depart: { owner: 'app_workflow' }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w'), meta: ['release:w'], arrivee: { owner: 'mba' } },
  { nom: '6. personne ne suit, colonne mba : release (répare Meta), colonne inchangée', depart: { owner: 'mba' }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w'), meta: ['release:w'], arrivee: { owner: 'mba' } },
  { nom: '6. personne ne suit, un opérateur tient le fil : rien', depart: { owner: 'app_human' }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w'), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '6. personne ne suit, agent éteint : rien', depart: { owner: 'app_workflow' }, banc: { mbaEnabled: false }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w'), meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '6. personne ne suit, un parcours attend : rien', depart: { owner: 'app_workflow' }, banc: { enAttente: true }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w'), meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '6. personne ne suit, aucun numéro : rien d’écrit', depart: { owner: 'app_workflow' }, banc: { numero: null }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w'), meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '6. personne ne suit, Meta refuse : lève, rien d’écrit', depart: { owner: 'app_workflow' }, banc: { release: ['refuse'] }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w'), leve: true, meta: ['release:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '6. personne ne suit, escalade périmée : effacée', depart: { owner: 'app_workflow', ...escaladee }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w'), meta: ['release:w'], arrivee: { owner: 'mba', escaladee: false } },

  // 7. Reprise pour un scénario.
  { nom: '7. reprise, mba, Meta accepte : take puis app_workflow', depart: { owner: 'mba' }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: ['take:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '7. reprise, Meta refuse : false, rien d’écrit', depart: { owner: 'mba' }, banc: { take: ['refuse'] }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: false, meta: ['take:w'], arrivee: { owner: 'mba' } },
  { nom: '7. reprise, Meta refuse une fois puis accepte : un rejeu', depart: { owner: 'mba' }, banc: { take: ['passager', 'accepte'] }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: ['take:w', 'take:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '7. reprise explicite, un opérateur tient le fil : reprise quand même', depart: { owner: 'app_human' }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: ['take:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '7. reprise explicite, fil escaladé : escalade effacée', depart: { owner: 'app_human', ...escaladee }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: ['take:w'], arrivee: { owner: 'app_workflow', escaladee: false } },
  { nom: '7. reprise déclenchée par le client, un opérateur tient le fil : il la garde', depart: { owner: 'app_human' }, geste: (f) => f.reprendrePourLApp('t1', 'w', { saufOperateur: true }), rend: 'operateur', meta: [], arrivee: { owner: 'app_human' } },
  { nom: '7. reprise déclenchée par le client, l’agent tient le fil : reprise', depart: { owner: 'mba' }, geste: (f) => f.reprendrePourLApp('t1', 'w', { saufOperateur: true }), rend: true, meta: ['take:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '7. reprise, agent éteint : aucun appel', depart: { owner: 'mba' }, banc: { mbaEnabled: false }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: [], arrivee: { owner: 'app_workflow' } },

  // 7c. Un tap sur un de nos boutons, livré en standby (décision de Julien du 2026-09-29).
  { nom: '7c. bouton, un parcours attend, Meta accepte : take puis app_workflow', depart: { owner: 'mba' }, banc: { enAttente: true }, geste: (f) => f.reprendreSurNotreBouton('t1', 'w'), rend: true, meta: ['take:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '7c. bouton, aucun parcours n’attend : false, aucun appel', depart: { owner: 'mba' }, geste: (f) => f.reprendreSurNotreBouton('t1', 'w'), rend: false, meta: [], arrivee: { owner: 'mba' } },
  { nom: '7c. bouton, Meta refuse : false, rien d’écrit', depart: { owner: 'mba' }, banc: { enAttente: true, take: ['refuse'] }, geste: (f) => f.reprendreSurNotreBouton('t1', 'w'), rend: false, meta: ['take:w'], arrivee: { owner: 'mba' } },
  { nom: '7c. bouton, agent éteint : app_workflow sans appel', depart: { owner: 'mba' }, banc: { enAttente: true, mbaEnabled: false }, geste: (f) => f.reprendreSurNotreBouton('t1', 'w'), rend: true, meta: [], arrivee: { owner: 'app_workflow' } },

  // 7d. Après l'envoi d'un modèle par un scénario : reprendre le fil avant la réponse (mesure du 2026-09-29).
  { nom: '7d. après un modèle, le scénario tient le fil : take, rien d’écrit', depart: { owner: 'app_workflow' }, geste: (f) => f.retenirApresNotreModele('t1', 'w'), meta: ['take:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '7d. après un modèle, un opérateur tient le fil : aucun appel', depart: { owner: 'app_human' }, geste: (f) => f.retenirApresNotreModele('t1', 'w'), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '7d. après un modèle, l’agent tient le fil : aucun appel', depart: { owner: 'mba' }, geste: (f) => f.retenirApresNotreModele('t1', 'w'), meta: [], arrivee: { owner: 'mba' } },
  { nom: '7d. après un modèle, agent éteint : aucun appel', depart: { owner: 'app_workflow' }, banc: { mbaEnabled: false }, geste: (f) => f.retenirApresNotreModele('t1', 'w'), meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '7d. après un modèle, Meta refuse : rien ne lève, rien d’écrit', depart: { owner: 'app_workflow' }, banc: { take: ['refuse'] }, geste: (f) => f.retenirApresNotreModele('t1', 'w'), meta: ['take:w'], arrivee: { owner: 'app_workflow' } },

  // 7b. Réponse de campagne « Inbox ».
  { nom: '7b. équipe, app_workflow, Meta accepte : take puis app_human', depart: { owner: 'app_workflow' }, geste: (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), rend: true, meta: ['take:w'], arrivee: { owner: 'app_human' } },
  { nom: '7b. équipe, Meta refuse : false, rien d’écrit', depart: { owner: 'mba' }, banc: { take: ['refuse'] }, geste: (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), rend: false, meta: ['take:w'], arrivee: { owner: 'mba' } },
  { nom: '7b. équipe, un opérateur tient déjà le fil : rien ne bouge', depart: { owner: 'app_human' }, geste: (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), rend: true, meta: [], arrivee: { owner: 'app_human' } },
  { nom: '7b. équipe, agent éteint : app_human sans appel', depart: { owner: 'app_workflow' }, banc: { mbaEnabled: false }, geste: (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), rend: true, meta: [], arrivee: { owner: 'app_human' } },

  // 8 et 9. Un scénario ou un agent IA passe à un humain.
  { nom: '8. passer à un humain, avec escalade', depart: { owner: 'app_workflow' }, geste: (f) => f.passerAUnHumain('t1', 'w', { escalade: true, cause: CAUSE_SCENARIO }), rend: true, meta: [], arrivee: { owner: 'app_human', escaladee: true } },
  { nom: '8. passer à un humain, sans escalade (échec de réveil)', depart: { owner: 'app_workflow' }, geste: (f) => f.passerAUnHumain('t1', 'w', { escalade: false, cause: CAUSE_SCENARIO }), rend: true, meta: [], arrivee: { owner: 'app_human', escaladee: false } },
  { nom: '8. passer à un humain, un opérateur tient déjà le fil : false', depart: { owner: 'app_human' }, geste: (f) => f.passerAUnHumain('t1', 'w', { escalade: true, cause: CAUSE_SCENARIO }), rend: false, meta: [], arrivee: { owner: 'app_human', escaladee: false } },
  { nom: '8. passer à un humain, l’agent tient le fil : false', depart: { owner: 'mba' }, geste: (f) => f.passerAUnHumain('t1', 'w', { escalade: true, cause: CAUSE_SCENARIO }), rend: false, meta: [], arrivee: { owner: 'mba' } },

  // 10. L'agent de Meta passe la main.
  { nom: '10. control_passed : app_human et escalade', depart: { owner: 'mba' }, geste: (f) => f.agentDeMetaPasseLaMain('t1', 'w'), meta: [], arrivee: { owner: 'app_human', escaladee: true } },
  { nom: '10. control_passed avant l’écho : la conversation est créée', depart: null, geste: (f) => f.agentDeMetaPasseLaMain('t1', 'w'), meta: [], arrivee: { owner: 'app_human', escaladee: true } },

  // 11. Un entrant en standby.
  { nom: '11. standby : Meta fait autorité, mba même contre un opérateur', depart: { owner: 'app_human' }, geste: (f) => f.entrantEnStandby('t1', 'w', APRES_ESCALADE), meta: [], arrivee: { owner: 'mba' } },
  { nom: '11. standby antérieur à l’escalade : retardataire, rien', depart: { owner: 'app_human', ...escaladee }, geste: (f) => f.entrantEnStandby('t1', 'w', AVANT_ESCALADE), meta: [], arrivee: { owner: 'app_human', escaladee: true } },
  { nom: '11. standby postérieur à l’escalade : mba, escalade effacée', depart: { owner: 'app_human', ...escaladee }, geste: (f) => f.entrantEnStandby('t1', 'w', APRES_ESCALADE), meta: [], arrivee: { owner: 'mba', escaladee: false } },
  { nom: '11. standby sans date, fil escaladé : garde stricte, rien', depart: { owner: 'app_human', ...escaladee }, geste: (f) => f.entrantEnStandby('t1', 'w'), meta: [], arrivee: { owner: 'app_human', escaladee: true } },

  // 12. Le balayage d'inactivité.
  { nom: '12. balayage vers mba, Meta accepte : release puis mba', depart: { owner: 'app_human' }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: true, meta: ['release:w'], arrivee: { owner: 'mba' } },
  { nom: '12. balayage vers mba, Meta refuse : false, rien d’écrit', depart: { owner: 'app_human' }, banc: { release: ['refuse'] }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: false, meta: ['release:w'], arrivee: { owner: 'app_human' } },
  { nom: '12. balayage vers mba, aucun numéro : false, rien d’écrit', depart: { owner: 'app_human' }, banc: { numero: null }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: false, meta: [], arrivee: { owner: 'app_human' } },
  { nom: '12. balayage vers mba, fil de test : false, aucun appel', depart: { owner: 'app_human', test: true }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: false, meta: [], arrivee: { owner: 'app_human' } },
  { nom: '12. balayage mba vers app_workflow : aucun appel', depart: { owner: 'mba' }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'mba', 'app_workflow'), rend: true, meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '12. balayage, le détenteur a changé depuis la lecture : false', depart: { owner: 'app_human' }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_workflow', 'mba'), rend: false, meta: ['release:w'], arrivee: { owner: 'app_human' } },
];

afterEach(() => { vi.restoreAllMocks(); });

/** Les fichiers de `src/`, sans leurs commentaires : une explication qui cite le code ne compte pas. */
function sources(): Array<{ fichier: string; texte: string }> {
  const racine = fileURLToPath(new URL('../src', import.meta.url));
  const out: Array<{ fichier: string; texte: string }> = [];
  const visiter = (dossier: string): void => {
    for (const nom of readdirSync(dossier)) {
      const complet = join(dossier, nom);
      if (statSync(complet).isDirectory()) { visiter(complet); continue; }
      if (!nom.endsWith('.ts')) continue;
      const texte = readFileSync(complet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      out.push({ fichier: `src/${relative(racine, complet).split('\\').join('/')}`, texte });
    }
  };
  visiter(racine);
  return out;
}

describe('le module est le seul à parler au fil', () => {
  it('🔴 aucun autre fichier n’appelle l’écriture de la colonne ni les actes `take` / `release` de Meta', () => {
    // Un appelant qui composerait lui-même « appel à Meta, puis écriture » referait, ailleurs, l'ordre et les gardes
    // que ce module porte seul : c'était l'asymétrie A (deux fabriques) et H (deux `takeControl`, deux `mayAct`).
    // Les deux formes d'appel : `client.takeThread(` et `client['takeThread'](` (guillemets simples, doubles ou
    // gabarit), sans quoi un appel par crochets échapperait à la garde (relecture du lot 4).
    const appels = /(?:\.|\[\s*['"`])(setControlOwner|takeThread|releaseThread|demanderReleaseMba|consommerReleaseMba)(?:['"`]\s*\])?\s*\(/g;
    const sites = sources().flatMap(({ fichier, texte }) => [...texte.matchAll(appels)].map((m) => `${fichier} ${m[1]}`));
    expect(sites.filter((s) => !s.startsWith('src/inbox/fil.ts '))).toEqual([]);
    expect(sites.length, 'le module lui-même doit les appeler : sinon cette garde ne regarde plus rien').toBeGreaterThan(0);
  });
});

describe('la table des transitions', () => {
  it.each(TABLE)('$nom', async (c) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = bancDuFil({ ...c.banc, ...(c.depart ? { conversations: { w: c.depart } } : {}) });
    if (c.leve) {
      await expect(c.geste(b.fil)).rejects.toThrow();
    } else {
      const rendu = await c.geste(b.fil);
      if ('rend' in c) expect(rendu).toEqual(c.rend);
    }
    expect(b.appels).toEqual(c.meta);
    const e = b.etat('w');
    if (c.arrivee === null) { expect(e).toBeUndefined(); return; }
    expect(e?.owner).toBe(c.arrivee.owner);
    if (c.arrivee.escaladee !== undefined) expect(e?.escaladeeLe !== null).toBe(c.arrivee.escaladee);
    if (c.arrivee.marque !== undefined) expect(e?.marque).toBe(c.arrivee.marque);
  });

  it('lecture : seul `app_workflow` laisse un scénario ou un agent IA écrire, et une conversation inconnue aussi', async () => {
    const b = bancDuFil({ conversations: { h: { owner: 'app_human' }, m: { owner: 'mba' }, a: { owner: 'app_workflow' } } });
    expect(await b.fil.peutAgir('t1', 'h')).toBe(false);
    expect(await b.fil.peutAgir('t1', 'm')).toBe(false);
    expect(await b.fil.peutAgir('t1', 'a')).toBe(true);
    expect(await b.fil.peutAgir('t1', 'inconnue')).toBe(true);
  });

  it('🔴 Meta d’abord : l’écriture de la colonne suit toujours l’appel, jamais l’inverse', async () => {
    const ordre: string[] = [];
    const surveille = (owner: ControlOwner) => { ordre.push(`colonne:${owner}`); return true; };
    const gestes: Array<[string, (f: ControleDuFil) => Promise<unknown>, ControlOwner]> = [
      ['reprendreLaMain', (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), 'mba'],
      ['rendreLaMain', (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), 'app_human'],
      ['remettreSiPersonneNeSuit', (f) => f.remettreSiPersonneNeSuit('t1', 'w'), 'app_workflow'],
      ['reprendrePourLApp', (f) => f.reprendrePourLApp('t1', 'w'), 'mba'],
      ['prendrePourLEquipe', (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), 'mba'],
      ['rendreApresInactivite', (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), 'app_human'],
    ];
    for (const [nom, geste, detenteur] of gestes) {
      ordre.length = 0;
      const b = bancDuFil({
        appels: ordre,
        depot: { getControlOwner: async () => detenteur, setControlOwner: async (_t, _w, owner) => surveille(owner) },
      });
      await geste(b.fil);
      expect(ordre, nom).toHaveLength(2);
      expect(ordre[0], `${nom} : Meta doit passer avant la colonne`).toMatch(/^(take|release):w$/);
    }
  });
});

/**
 * DÉCISION 1 (asymétrie C) : un robot qui reprend le fil efface l'escalade. Plus de conversation collante dans
 * « À traiter ». Vérifié dans les deux sens : sans `effacerEscalade` sur les gestes 5, 6, 7, 11 et la fin de
 * parcours, les lignes de la table qui les portent échouent (escalade toujours là), et le cas ci-dessous aussi.
 */
describe('décision 1 : l’escalade ne survit pas à un robot qui reprend le fil', () => {
  it('🔴 le scénario de l’asymétrie C : lancé depuis l’Inbox, fin refusée par Meta, puis rendu par le balayage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Une conversation escaladée ; l'opérateur lance un scénario sans répondre, le parcours finit, et Meta refuse
    // la remise. Avant : `app_human` escaladée, que le balayage exclut pour toujours.
    const b = bancDuFil({ release: ['refuse', 'accepte'], conversations: { w: { owner: 'app_human', escaladeeLe: ESCALADE } } });
    expect(await b.fil.reprendrePourLApp('t1', 'w')).toBe(true);
    await expect(b.fil.rendreApresParcours('t1', 'w')).rejects.toThrow();
    expect(b.etat('w')?.owner).toBe('app_human');
    expect(b.etat('w')?.escaladeeLe, 'la conversation resterait collée dans « À traiter »').toBeNull();

    const MAINTENANT = Date.parse('2026-09-27T20:00:00Z');
    const rendues = await runControlSweep({
      inbox: {
        listHeldControl: async () => [...b.lignes].map(([waId, l]) => ({
          tenantId: 't1', waId, owner: l.owner, changedAt: new Date(MAINTENANT - 3 * 3600_000),
          lastMessageAt: new Date(MAINTENANT - 3600_000), escaladee: l.escaladeeLe !== null,
        })),
      },
      reglages: { mbaActifParTenant: async () => new Set(['t1']) },
      timeouts: { app_human: 2 * 3600_000, mba: 24 * 3600_000 },
      fil: b.fil,
      now: () => MAINTENANT,
    });
    expect(rendues).toBe(1);
    expect(b.etat('w')?.owner).toBe('mba');
  });
});

/**
 * DÉCISION 2 (asymétrie D) : la réponse à une campagne « Inbox » prend le fil pour l'équipe, et la remise
 * « personne ne suit » du même job la respecte. Vérifié dans les deux sens : `prendrePourLEquipe` remis à écrire
 * `app_workflow` (l'ancien `reprendreLeFilPourLApp`), le cas échoue : la remise relâche le fil (`release:…`) et la
 * conversation finit `mba`, hors de l'équipe, l'agent répondant.
 */
describe('décision 2 : une réponse de campagne « Inbox » arrive à l’équipe, et y reste', () => {
  const WA = '33600000001';
  const payload = {
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' }, contacts: [{ wa_id: WA }],
      messages: [{ id: 'wamid.R1', from: WA, type: 'text', timestamp: '1789465356', text: { body: 'Oui, ça m’intéresse' } }],
    } }] }],
  };
  const campagne: CampagneAssignante = { campaignId: 'c1', nom: 'Rentrée', devenir: 'inbox', assignation: 'tour_de_role', assignationUserId: null, premiereReponse: true };

  it('🔴 dans le MÊME job : la prise écrit `app_human`, la remise ne rend pas le fil, la conversation est affectée', async () => {
    // Conversation née de l'envoi de la campagne : `app_workflow` par défaut, l'agent de Meta allumé.
    const b = bancDuFil({ conversations: { [WA]: { owner: 'app_workflow' } } });
    const affectees: Array<[string, string]> = [];
    const deps: WebhookJobDeps = {
      store: { insertEvent: async () => true },
      inbox: { recordInbound: async () => {}, phoneNumberTenant: async () => 't1' },
      arriveesPub: aucuneArriveePub,
      routagePub: aucunRoutagePub,
      signalReponse: aucunSignalReponse,
      numerosDelies: aucunNumeroDelie,
      inboundOptOut: aucunStop,
      inboundAssignation: (t, w) => assignerReponse(t, w, {
        campagneDeLaReponse: async () => campagne,
        membres: async () => ['u1'],
        prendreUnRang: async () => 0,
        assigner: async (_t, waId, userId) => { affectees.push([waId, userId]); return true; },
        prendreLeFil: b.fil.prendrePourLEquipe,
      }),
      remiseMbaEntrant: { remettre: b.fil.remettreSiPersonneNeSuit },
      detenteur: b.fil,
    };
    await handleWebhookJob(payload, deps);
    expect(b.appels, 'le fil est pris, puis jamais rendu à l’agent').toEqual([`take:${WA}`]);
    expect(b.etat(WA)?.owner, 'dans « À traiter », aucun robot ne répond').toBe('app_human');
    expect(affectees).toEqual([[WA, 'u1']]);
    // Et une automation par mot-clé s'y tait : l'exécuteur ne démarre que sur `app_workflow`.
    expect(await b.fil.peutAgir('t1', WA)).toBe(false);
  });
});

/**
 * RELECTURE DU LOT 4 : la réponse à une campagne « Inbox » ne prend le fil qu'à la PREMIÈRE réponse. Une campagne
 * « Inbox » sans affectation (le défaut de l'assistant) ne pose jamais `assigned_to`, seule garde qui arrêtait
 * l'affectation : la prise rejouait donc à chaque message du contact, pour toujours.
 *
 * Le vrai job, et un faux dépôt qui calcule `premiereReponse` comme `campagneAssignanteDuContact` : au plus UN entrant
 * ENREGISTRÉ depuis l'envoi. Il éprouve donc aussi l'ordre dont la requête dépend (`recordInbound`, puis
 * l'affectation) : dans l'ordre inverse, le second message se croirait encore le premier. Vérifié dans les deux
 * sens : la condition `premiereReponse` retirée de `assignerReponse`, les deux cas rougissent (une seconde prise demandée ; et,
 * après le « Rendre la main », un second `take` parti chez Meta).
 */
describe('relecture du lot 4 : une réponse de campagne « Inbox » ne prend le fil qu’une fois', () => {
  const WA = '33600000002';
  const message = (id: string, texte: string) => ({
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' }, contacts: [{ wa_id: WA }],
      messages: [{ id, from: WA, type: 'text', timestamp: '1789465356', text: { body: texte } }],
    } }] }],
  });

  /** La file `webhook` d'un espace qui a envoyé une campagne « Inbox » SANS affectation à ce contact. */
  function monterLeJob(b: ReturnType<typeof bancDuFil>) {
    const enregistres: string[] = [];
    const prises: string[] = [];
    const deps: WebhookJobDeps = {
      store: { insertEvent: async () => true },
      inbox: { recordInbound: async (_t, m) => { enregistres.push(m.messageId); }, phoneNumberTenant: async () => 't1' },
      arriveesPub: aucuneArriveePub,
      routagePub: aucunRoutagePub,
      signalReponse: aucunSignalReponse,
      numerosDelies: aucunNumeroDelie,
      inboundOptOut: aucunStop,
      inboundAssignation: (t, w) => assignerReponse(t, w, {
        campagneDeLaReponse: async () => ({
          campaignId: 'c1', nom: 'Rentrée', devenir: 'inbox', assignation: null, assignationUserId: null,
          premiereReponse: enregistres.length <= 1,
        }),
        membres: async () => ['u1'],
        prendreUnRang: async () => 0,
        assigner: async () => true,
        prendreLeFil: async (t, waId) => { prises.push(waId); return b.fil.prendrePourLEquipe(t, waId, 'automatique : campagne test'); },
      }),
      remiseMbaEntrant: { remettre: b.fil.remettreSiPersonneNeSuit },
      detenteur: b.fil,
    };
    return { deps, prises };
  }

  it('🔴 deux messages d’affilée du même contact : la prise n’est demandée qu’au premier', async () => {
    const b = bancDuFil({ conversations: { [WA]: { owner: 'app_workflow' } } });
    const j = monterLeJob(b);
    await handleWebhookJob(message('wamid.P1', 'Oui'), j.deps);
    await handleWebhookJob(message('wamid.P2', 'Vous êtes là ?'), j.deps);
    expect(j.prises).toEqual([WA]);
    expect(b.appels).toEqual([`take:${WA}`]);
    expect(b.etat(WA)?.owner).toBe('app_human');
  });

  it('🔴 « Rendre la main » tient : le message suivant du client ne reprend pas le fil à l’agent de Meta', async () => {
    const b = bancDuFil({ conversations: { [WA]: { owner: 'app_workflow' } } });
    const j = monterLeJob(b);
    await handleWebhookJob(message('wamid.P1', 'Oui'), j.deps);
    expect(b.etat(WA)?.owner).toBe('app_human');
    // L'opérateur rend la main : `release`, puis `mba`.
    expect(await b.fil.rendreLaMain('t1', WA, { collaborateur: null })).toBe('mba');
    await handleWebhookJob(message('wamid.P2', 'Et demain ?'), j.deps);
    expect(j.prises).toEqual([WA]);
    expect(b.appels.filter((a) => a.startsWith('take:')), 'aucun `take` après le geste de l’opérateur').toEqual([`take:${WA}`]);
    expect(b.etat(WA)?.owner, 'le fil reste à l’agent de Meta').toBe('mba');
  });

  /**
   * 🔴 La prise n'ayant plus lieu qu'une fois, elle doit TENIR. Une première réponse arrivée en `standby` (le fil
   * était revenu à l'agent de Meta entre l'envoi et la réponse) était prise pour l'équipe, puis la correction du
   * détenteur du même message réécrivait `mba` : Meta nous avait cédé le fil, notre colonne le donnait à l'agent.
   * Vérifié dans les deux sens : la correction remise après l'affectation dans `processInbound`, la colonne finit
   * à `mba`.
   */
  it('🔴 une première réponse arrivée en `standby` : le détenteur est corrigé AVANT la prise, qui tient', async () => {
    const b = bancDuFil({ conversations: { [WA]: { owner: 'app_workflow' } } });
    const j = monterLeJob(b);
    await handleWebhookJob({
      entry: [{ changes: [{ field: 'standby', value: {
        metadata: { phone_number_id: 'pn1' },
        standby: { contacts: [{ wa_id: WA }], messages: [{ id: 'wamid.S1', from: WA, type: 'text', timestamp: '1789465356', text: { body: 'Oui' } }] },
      } }] }],
    }, j.deps);
    expect(b.appels).toEqual([`take:${WA}`]);
    expect(b.etat(WA)?.owner, 'Meta nous a cédé le fil, notre colonne le dit').toBe('app_human');
  });
});

/**
 * DÉCISION 3 (asymétrie A) : « Reprendre la main » rejoue une fois, comme les automates. Vérifié dans les deux
 * sens : sans rejeu (prise nue), le cas rend `refuse` et le fil reste à l'agent.
 */
describe('décision 3 : le bouton « Reprendre la main » rejoue une fois', () => {
  it('🔴 un refus passager suivi d’un accord : le fil est pris, en deux appels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = bancDuFil({ take: ['passager', 'accepte'], conversations: { w: { owner: 'mba' } } });
    expect(await b.fil.reprendreLaMain('t1', 'w', { collaborateur: null })).toBe('pris');
    expect(b.appels).toEqual(['take:w', 'take:w']);
    expect(b.attentes).toHaveLength(1);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('⚠️ et jamais deux : deux refus passagers rendent `refuse`', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = bancDuFil({ take: ['passager', 'passager', 'accepte'], conversations: { w: { owner: 'mba' } } });
    expect(await b.fil.reprendreLaMain('t1', 'w', { collaborateur: null })).toBe('refuse');
    expect(b.appels).toHaveLength(2);
    expect(b.etat('w')?.owner).toBe('mba');
  });
});

/**
 * DÉCISION 4 (asymétrie B) : agent allumé, aucun numéro connecté, la colonne ne bouge pas, quelle que soit la
 * porte. Vérifié dans les deux sens : l'ancienne règle remise (fin de parcours et remise « personne ne suit »
 * écrivant `mba` sur « aucun numéro », bouton écrivant `app_workflow`), chacun des trois cas échoue.
 */
describe('décision 4 : un agent sans numéro ne s’annonce jamais', () => {
  it('🔴 fin de parcours : la conversation reste en attente, visible, jamais `mba`', async () => {
    const b = bancDuFil({ numero: null, conversations: { w: { owner: 'app_workflow' } } });
    await b.fil.rendreApresParcours('t1', 'w');
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('🔴 le client revient : rien d’écrit', async () => {
    const b = bancDuFil({ numero: null, conversations: { w: { owner: 'app_workflow' } } });
    await b.fil.remettreSiPersonneNeSuit('t1', 'w');
    expect(b.etat('w')?.owner).toBe('app_workflow');
  });

  it('🔴 le bouton « Rendre la main » : rien d’écrit, et il le dit', async () => {
    const b = bancDuFil({ numero: null, conversations: { w: { owner: 'app_human' } } });
    expect(await b.fil.rendreLaMain('t1', 'w', { collaborateur: null })).toBe('aucun_numero');
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('et le balayage, qui portait déjà la règle, la garde', async () => {
    const b = bancDuFil({ numero: null, conversations: { w: { owner: 'app_human' } } });
    expect(await b.fil.rendreApresInactivite('t1', 'w', 'app_human', 'mba')).toBe(false);
    expect(b.etat('w')?.owner).toBe('app_human');
  });
});

/**
 * DÉCISION 5 (asymétrie E) : un démarrage que le CLIENT déclenche (clic sur une publicité, réponse de campagne)
 * ne prend pas une conversation à l'opérateur qui la tient ; les lancements explicites, si. Vérifié dans les deux
 * sens : la garde `saufOperateur` retirée du module, le lead publicitaire repart sur le fil de l'opérateur (un
 * `take`, un message envoyé, la colonne à `app_workflow`).
 */
describe('décision 5 : un lead ne prend pas la main à un opérateur', () => {
  const graphe: WorkflowGraph = {
    nodes: [{ id: 'a', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Merci pour votre clic !' } }],
    edges: [],
  };
  const auto = (over: Partial<AutomationRow>): AutomationRow => ({
    id: 'a1', tenantId: 't1', name: 'automation', enabled: true,
    triggerKind: 'ctwa_ad', triggerConfig: { campaignId: 'camp-1' },
    conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null,
    maxFiresPerHour: 0, possedePar: POSSESSEUR_PUBLICITE, ...over,
  });
  const WA = '33611223344';
  const lead: AutomationEvent = {
    kind: 'message', waId: WA, body: 'Bonjour', isNewContact: false, channel: 'whatsapp', adId: 'ad-1', campagneId: 'camp-1',
  };

  /** Le vrai exécuteur, dont la prise et la lecture du fil sont celles du module, et le câblage du worker. */
  function monter(depart: ControlOwner, rows: AutomationRow[]) {
    const b = bancDuFil({ conversations: { [WA]: { owner: depart } } });
    const envois: string[] = [];
    const execDeps: WorkflowExecutorDeps = {
      ...depsInertes,
      estDesabonne: jamaisDesabonne,
      runs: avecGardesDEtatInertes({
        start: async () => ({ id: 'r1' }),
        findWaitingByWaId: async () => null,
        setState: async () => {},
        closeActiveByWaId: async () => [],
      }),
      getGraph: async () => graphe,
      applyTag: async () => {},
      setField: async () => {},
      removeTag: async () => {},
      clearField: async () => {},
      sendTemplate: async () => {},
      sendQuickMessage: async (_t, _w, texte) => { envois.push(texte); },
      sendFlow: async () => {},
      sendQuestion: async () => {},
      mayAct: b.fil.peutAgir,
      reclaimControl: b.fil.reprendrePourLApp,
    };
    const ex = new WorkflowExecutor(execDeps);
    const runner: AutomationRunnerDeps = {
      automations: { listEnabled: async () => rows, lastFiredAt: async () => null, markFired: async () => true, clearFired: async () => {} },
      evalContext: async () => null,
      // Le MÊME câblage que `src/worker.ts`.
      startWorkflow: async (t, workflowId, waId, opts) => ex.startInWindow(t, workflowId, graphe, { waId, contactId: null },
        { emitEvents: true, ignoreHumanControl: opts.reprendLaMain, saufOperateur: opts.saufOperateur === true }),
      defaultCooldownSeconds: 0,
    };
    return { b, ex, envois, runner };
  }

  it('🔴 lead publicitaire sur une conversation d’opérateur : le scénario de la pub ne démarre pas, rien n’est pris', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = monter('app_human', [auto({})]);
    expect(await runAutomations('t1', lead, m.runner)).toBe(0);
    expect(m.envois).toEqual([]);
    expect(m.b.appels).toEqual([]);
    expect(m.b.etat(WA)?.owner).toBe('app_human');
  });

  it('le même lead sur un fil que l’agent de Meta tient : reprise, le scénario part', async () => {
    const m = monter('mba', [auto({})]);
    expect(await runAutomations('t1', lead, m.runner)).toBe(1);
    expect(m.envois).toEqual(['Merci pour votre clic !']);
    expect(m.b.appels).toEqual([`take:${WA}`]);
  });

  it('⚠️ un lancement EXPLICITE (bouton de chaîne) reprend toujours la main à l’opérateur', async () => {
    const m = monter('app_human', [auto({ possedePar: POSSESSEUR_LIEN_CHAINE, triggerKind: 'keyword', triggerConfig: { keywords: ['bonjour'], mode: 'contains' } })]);
    expect(await runAutomations('t1', { ...lead, adId: undefined, campagneId: undefined }, m.runner)).toBe(1);
    expect(m.envois).toEqual(['Merci pour votre clic !']);
    expect(m.b.etat(WA)?.owner).toBe('app_workflow');
  });

  it('⚠️ un lancement depuis l’Inbox aussi : l’opérateur l’a déclenché', async () => {
    const m = monter('app_human', []);
    expect(await m.ex.startInWindow('t1', 'wf1', graphe, { waId: WA, contactId: null }, { ignoreHumanControl: true })).toBe(true);
    expect(m.envois).toEqual(['Merci pour votre clic !']);
    expect(m.b.appels).toEqual([`take:${WA}`]);
    expect(m.b.etat(WA)?.owner).toBe('app_workflow');
  });

  /**
   * ⚠️ LE ROUTAGE SEUL, sur un fil d'opérateur ESCALADÉ et un `standby` SANS DATE. C'est ce qui garde la colonne à
   * `app_human` jusqu'au routage : dans le vrai job, `processInbound` corrige d'abord le détenteur, et
   * `entrantEnStandby` écrit `mba` (Meta fait autorité) dès que la conversation n'est pas escaladée, ou que le
   * `standby` est daté après l'escalade ; le routage voit alors un fil de l'agent de Meta, et le reprend pour le
   * scénario de la publicité. `saufOperateur` ne protège donc un opérateur que là où notre colonne le dit encore
   * maître du fil.
   */
  it('🔴 routage seul, lead en standby non daté sur un fil d’opérateur escaladé : pas de reprise, plus aucun déclencheur', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = bancDuFil({ conversations: { [WA]: { owner: 'app_human', escaladeeLe: ESCALADE } } });
    const notes: IssueRoutage[] = [];
    const deps: RoutagePubDeps = {
      campagneConnue: async () => 'camp-1',
      resoudreChezMeta: async () => null,
      publiciteDeLaCampagne: async () => ({ campagneId: 'camp-1', destination: 'scenario', automationId: 'auto-pub' }),
      contactBloque: async () => false,
      estDesabonne: jamaisDesabonne,
      reprendreLeFil: (t, w) => b.fil.reprendrePourLApp(t, w, { saufOperateur: true }),
      rendreLeFil: b.fil.remettreSiPersonneNeSuit,
      noterIssue: async (_t, _m, v) => { notes.push(v.issue); },
    };
    const standby = {
      entry: [{ changes: [{ field: 'standby', value: { metadata: { phone_number_id: 'pn1' }, messages: [
        { id: 'wamid.L1', from: WA, type: 'text', text: { body: 'Bonjour' }, referral: { source_id: 'ad-1', source_type: 'ad', source_url: 'https://fb.me/x', ctwa_clid: 'clid-1' } },
      ] } }] }],
    };
    const routes = await processRoutagePub(await entrantsDe(standby), deps);
    expect(b.appels).toEqual([]);
    expect(notes).toEqual(['reprise_refusee']);
    expect(routes.get('wamid.L1')?.restriction).toEqual({ sorte: 'aucun' });
    expect(b.etat(WA)?.owner).toBe('app_human');
  });

  it('🔴 une réponse de campagne « Inbox » sur une conversation d’opérateur : rien ne bouge, l’affectation suit', async () => {
    const b = bancDuFil({ conversations: { [WA]: { owner: 'app_human' } } });
    const affectees: string[] = [];
    const qui = await assignerReponse('t1', WA, {
      campagneDeLaReponse: async () => ({ campaignId: 'c1', nom: 'Rentrée', devenir: 'inbox', assignation: 'personne', assignationUserId: 'u1', premiereReponse: true }),
      membres: async () => ['u1'],
      prendreUnRang: async () => 0,
      assigner: async (_t, waId) => { affectees.push(waId); return true; },
      prendreLeFil: b.fil.prendrePourLEquipe,
    });
    expect(qui).toBe('u1');
    expect(b.appels).toEqual([]);
    expect(b.etat(WA)?.owner).toBe('app_human');
  });
});
