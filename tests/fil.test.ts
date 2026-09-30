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
import { agentEteintALArrivee, aucunNumeroDelie, aucunRoutagePub, aucunSignalReponse, aucuneArriveePub, entrantsDe } from './webhook-fixtures';
import { aucunStop, jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';

/**
 * LA TABLE DU CONTRÔLE DU FIL, EXÉCUTÉE (`src/inbox/fil.ts`).
 *
 * Chaque ligne : un geste, l'état de départ de la conversation (et de la liste de l'agent de Meta), ce que Meta
 * répond, et ce qu'on attend (ce que le geste rend, les appels partis chez Meta dans l'ordre, l'état d'arrivée de
 * notre colonne, de ses marques et de la liste). Le module réel et la vraie liste (`src/mba/liste.ts`) tournent sur
 * un dépôt et une table en mémoire fidèles au `update` gardé de `PgInboxStore.setControlOwner`, et sur un faux
 * client Meta qui accepte, refuse, ou refuse une fois puis accepte (`tests/banc-du-fil.ts`).
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
  arrivee: { owner: ControlOwner; escaladee?: boolean; marque?: string | null; surLaListe?: boolean } | null;
}

const escaladee = { escaladeeLe: ESCALADE };
/** La cause que l'appelant d'un passage à l'équipe porte (le scénario ou l'agent IA qui passe la main). */
const CAUSE_SCENARIO = 'automatique : scénario test';
/** Le contact `w` est déjà sur la liste de l'agent (notre table et chez Meta). */
const surLaListe = { surLaListe: ['w'] };
/** Le texte du message que la remise « personne ne suit » transmet à l'agent. */
const MSG = 'Bonjour, vous êtes ouverts demain ?';

const TABLE: Cas[] = [
  // 1. Un opérateur ou une machine écrit : aucun appel, l'envoi WhatsApp prend le fil.
  { nom: '1. écrit, depuis mba : app_human sans appel', depart: { owner: 'mba' }, geste: (f) => f.prisEnEcrivant('t1', 'w', { collaborateur: null }), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '1. écrit, depuis app_workflow : app_human sans appel', depart: { owner: 'app_workflow' }, geste: (f) => f.prisEnEcrivant('t1', 'w', { collaborateur: null }), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '1. écrit, fil escaladé : l’escalade reste (c’est l’équipe qu’on attend)', depart: { owner: 'mba', ...escaladee }, geste: (f) => f.prisEnEcrivant('t1', 'w', { collaborateur: null }), meta: [], arrivee: { owner: 'app_human', escaladee: true } },

  // 2. « Reprendre la main » : le contact quitte la liste de l'agent, s'il y est, quelle que soit la colonne.
  { nom: '2. reprendre, sur la liste, Meta accepte : retrait puis app_human', depart: { owner: 'mba' }, banc: surLaListe, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: ['retrait:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '2. reprendre, sur la liste, Meta refuse : rien d’écrit, le contact reste', depart: { owner: 'mba' }, banc: { ...surLaListe, retrait: ['refuse'] }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'refuse', meta: ['retrait:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '2. reprendre, Meta refuse une fois puis accepte : un rejeu', depart: { owner: 'mba' }, banc: { ...surLaListe, retrait: ['passager', 'accepte'] }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: ['retrait:w', 'retrait:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '2. reprendre, l’entrée n’existe plus chez Meta (404) : vaut retrait', depart: { owner: 'mba' }, banc: { ...surLaListe, retrait: ['absente'] }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: ['retrait:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '2. reprendre, absent de la liste : aucun appel', depart: { owner: 'mba' }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: [], arrivee: { owner: 'app_human' } },
  { nom: '2. reprendre, agent éteint : le contact sort quand même de la liste', depart: { owner: 'mba' }, banc: { ...surLaListe, mbaEnabled: false }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: ['retrait:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '2. reprendre, colonne à nous mais contact sur la liste : retiré', depart: { owner: 'app_workflow' }, banc: surLaListe, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: ['retrait:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '2. reprendre, aucun numéro connecté : retiré avec le numéro gardé', depart: { owner: 'mba' }, banc: { ...surLaListe, numero: null }, geste: (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), rend: 'pris', meta: ['retrait:w'], arrivee: { owner: 'app_human', surLaListe: false } },

  // 3. « Rendre la main » : confier (liste, puis release), aucun événement.
  { nom: '3. rendre, humain escaladé : ajout, release puis mba, escalade effacée', depart: { owner: 'app_human', ...escaladee }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'mba', meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', escaladee: false, surLaListe: true } },
  { nom: '3. rendre, déjà sur la liste : release seul', depart: { owner: 'app_human' }, banc: surLaListe, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'mba', meta: ['release:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '3. rendre, Meta refuse l’ajout : lève, rien d’écrit, aucun release', depart: { owner: 'app_human' }, banc: { ajout: ['refuse'] }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), leve: true, meta: ['ajout:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  // 🔴 Essai réel du 2026-09-30 : après un modèle, l'agent de Meta tient déjà le fil et Meta refuse le `release`. Le
  // contact est sur la liste, l'agent répond au message suivant : c'est confié, pas une erreur.
  { nom: '3. rendre, Meta refuse le release (son agent tient déjà le fil) : confié quand même, mba', depart: { owner: 'app_human' }, banc: { release: ['refuse'] }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'mba', meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '3. rendre, agent éteint : app_workflow sans appel, escalade effacée', depart: { owner: 'app_human', ...escaladee }, banc: { mbaEnabled: false }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'app_workflow', meta: [], arrivee: { owner: 'app_workflow', escaladee: false } },
  { nom: '3. rendre, colonne déjà mba : on rouvre notre côté sans appel (release hors contrat)', depart: { owner: 'mba' }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'app_workflow', meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '3. rendre, agent allumé sans numéro : rien d’écrit', depart: { owner: 'app_human' }, banc: { numero: null }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'aucun_numero', meta: [], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '3. rendre, fil de test : le bouton le peut', depart: { owner: 'app_human', test: true }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'mba', meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba' } },
  { nom: '3. rendre, contact désabonné : le bouton le peut (geste humain, délibéré)', depart: { owner: 'app_human' }, banc: { desabonnes: ['w'] }, geste: (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), rend: 'mba', meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', surLaListe: true } },

  // 4. Fin de parcours.
  { nom: '4. fin de parcours, rien en vol, Meta accepte : app_human puis confié, mba', depart: { owner: 'app_workflow' }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '4. fin de parcours, envoi en vol : marque, attente, aucun appel', depart: { owner: 'app_workflow', enVol: 'wamid.X' }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human', marque: 'wamid.X' } },
  { nom: '4. fin de parcours, Meta refuse l’ajout : lève, reste app_human', depart: { owner: 'app_workflow' }, banc: { ajout: ['refuse'] }, geste: (f) => f.rendreApresParcours('t1', 'w'), leve: true, meta: ['ajout:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '4. fin de parcours, Meta refuse le release : confié quand même, mba', depart: { owner: 'app_workflow' }, banc: { release: ['refuse'] }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '4. fin de parcours, fil escaladé : l’escalade part dès l’attente', depart: { owner: 'app_workflow', ...escaladee }, banc: { ajout: ['refuse'] }, geste: (f) => f.rendreApresParcours('t1', 'w'), leve: true, meta: ['ajout:w'], arrivee: { owner: 'app_human', escaladee: false } },
  { nom: '4. fin de parcours, un opérateur tient le fil : rien', depart: { owner: 'app_human' }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '4. fin de parcours, aucun numéro : reste en attente, jamais mba', depart: { owner: 'app_workflow' }, banc: { numero: null }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human' } },
  { nom: '4. fin de parcours, fil de test : reste en attente, aucun appel', depart: { owner: 'app_workflow', test: true }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '4. fin de parcours, agent éteint entre-temps : reste en attente, aucun appel', depart: { owner: 'app_workflow' }, banc: { mbaEnabled: false }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '4. fin de parcours, le contact a dit STOP : reste chez l’équipe, jamais confié', depart: { owner: 'app_workflow' }, banc: { desabonnes: ['w'] }, geste: (f) => f.rendreApresParcours('t1', 'w'), meta: [], arrivee: { owner: 'app_human', surLaListe: false } },

  // 5. Remise sur accusé.
  { nom: '5. accusé attendu, Meta accepte : marque consommée, confié, mba, escalade effacée', depart: { owner: 'app_human', marque: 'wamid.A', ...escaladee }, geste: (f) => f.remettreSurAccuse('wamid.A'), meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', marque: null, escaladee: false, surLaListe: true } },
  { nom: '5. accusé d’un autre message : rien', depart: { owner: 'app_human', marque: 'wamid.A' }, geste: (f) => f.remettreSurAccuse('wamid.B'), meta: [], arrivee: { owner: 'app_human', marque: 'wamid.A' } },
  { nom: '5. accusé, Meta refuse l’ajout : marque consommée quand même, reste app_human', depart: { owner: 'app_human', marque: 'wamid.A' }, banc: { ajout: ['refuse'] }, geste: (f) => f.remettreSurAccuse('wamid.A'), leve: true, meta: ['ajout:w'], arrivee: { owner: 'app_human', marque: null } },
  { nom: '5. accusé, Meta refuse le release : confié quand même, mba', depart: { owner: 'app_human', marque: 'wamid.A' }, banc: { release: ['refuse'] }, geste: (f) => f.remettreSurAccuse('wamid.A'), meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', marque: null, surLaListe: true } },
  { nom: '5. accusé, aucun numéro : reste app_human', depart: { owner: 'app_human', marque: 'wamid.A' }, banc: { numero: null }, geste: (f) => f.remettreSurAccuse('wamid.A'), meta: [], arrivee: { owner: 'app_human', marque: null } },

  // 6. Le client écrit et personne ne suit : confier, `mba`, puis l'événement `message_sans_suite`.
  { nom: '6. personne ne suit, app_workflow : ajout, release, mba, événement', depart: { owner: 'app_workflow' }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: ['ajout:w', 'release:w', 'evenement:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '6. personne ne suit, colonne mba mais absent de la liste : confié, et l’agent est prévenu', depart: { owner: 'mba' }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: ['ajout:w', 'release:w', 'evenement:w'], arrivee: { owner: 'mba', surLaListe: true } },
  // Déjà confié : Meta refuse le `release` quand son agent tient le fil (la réponse « à côté » d'un scénario, qu'il
  // a reçue par son propre événement) ; il l'accepte quand nous le tenions, donc que ce message est arrivé chez nous.
  { nom: '6. personne ne suit, déjà confié et son agent tient le fil (release refusé) : AUCUN événement', depart: { owner: 'mba' }, banc: { ...surLaListe, release: ['refuse'] }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: ['release:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '6. personne ne suit, déjà confié mais le fil était chez nous (release accepté) : l’agent est prévenu', depart: { owner: 'mba' }, banc: surLaListe, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: ['release:w', 'evenement:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '6. personne ne suit, sur la liste mais fil chez nous (release refusé avant) : release, mba, événement', depart: { owner: 'app_workflow' }, banc: surLaListe, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: ['release:w', 'evenement:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '6. personne ne suit, un opérateur tient le fil : rien', depart: { owner: 'app_human' }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: [], arrivee: { owner: 'app_human' } },
  // 🔴 Relecture du 2026-09-30 : un « STOP » que personne ne prenait partait chez l'agent, avec l'ordre de répondre.
  { nom: '6. personne ne suit, le contact a dit STOP : ni liste, ni release, ni événement', depart: { owner: 'app_workflow' }, banc: { desabonnes: ['w'] }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', 'STOP', { rouverte: false }), meta: [], arrivee: { owner: 'app_workflow', surLaListe: false } },
  { nom: '6. personne ne suit, le contact est bloqué : ni liste, ni release, ni événement', depart: { owner: 'app_workflow' }, banc: { bloques: ['w'] }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: [], arrivee: { owner: 'app_workflow', surLaListe: false } },
  { nom: '6. personne ne suit, agent éteint : rien', depart: { owner: 'app_workflow' }, banc: { mbaEnabled: false }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '6. personne ne suit, un parcours attend : rien', depart: { owner: 'app_workflow' }, banc: { enAttente: true }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '6. personne ne suit, aucun numéro : rien d’écrit', depart: { owner: 'app_workflow' }, banc: { numero: null }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '6. personne ne suit, fil de test : rien', depart: { owner: 'app_workflow', test: true }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: [], arrivee: { owner: 'app_workflow', surLaListe: false } },
  // 🔴 Relecture du 2026-09-30 : laissée `app_workflow`, la conversation sortait d'« À traiter » sans que personne
  // réponde (un identifiant qui n'est pas un numéro est refusé à chaque ajout). Elle passe à l'équipe.
  { nom: '6. personne ne suit, Meta refuse l’ajout : lève, aucun événement, la conversation passe à l’équipe', depart: { owner: 'app_workflow' }, banc: { ajout: ['refuse'] }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), leve: true, meta: ['ajout:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '6. personne ne suit, colonne mba, Meta refuse l’ajout : la conversation passe à l’équipe', depart: { owner: 'mba' }, banc: { ajout: ['refuse'] }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), leve: true, meta: ['ajout:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '6. personne ne suit, Meta refuse le release : confié quand même, mba, événement', depart: { owner: 'app_workflow' }, banc: { release: ['refuse'] }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: ['ajout:w', 'release:w', 'evenement:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '6. personne ne suit, événement refusé : journalisé, la colonne reste mba', depart: { owner: 'app_workflow' }, banc: { evenement: ['refuse'] }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: ['ajout:w', 'release:w', 'evenement:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '6. personne ne suit, aucun texte lisible : confié, sans événement', depart: { owner: 'app_workflow' }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', '  ', { rouverte: false }), meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '6. personne ne suit, escalade périmée : effacée', depart: { owner: 'app_workflow', ...escaladee }, geste: (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), meta: ['ajout:w', 'release:w', 'evenement:w'], arrivee: { owner: 'mba', escaladee: false } },

  // 7. Reprise pour un scénario : le contact quitte la liste, puis `app_workflow`.
  { nom: '7. reprise, sur la liste, Meta accepte : retrait puis app_workflow', depart: { owner: 'mba' }, banc: surLaListe, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: ['retrait:w'], arrivee: { owner: 'app_workflow', surLaListe: false } },
  { nom: '7. reprise, Meta refuse : false, rien d’écrit', depart: { owner: 'mba' }, banc: { ...surLaListe, retrait: ['refuse'] }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: false, meta: ['retrait:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '7. reprise, Meta refuse une fois puis accepte : un rejeu', depart: { owner: 'mba' }, banc: { ...surLaListe, retrait: ['passager', 'accepte'] }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: ['retrait:w', 'retrait:w'], arrivee: { owner: 'app_workflow', surLaListe: false } },
  { nom: '7. reprise, absent de la liste : aucun appel, app_workflow', depart: { owner: 'mba' }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '7. reprise explicite, un opérateur tient le fil : reprise quand même', depart: { owner: 'app_human' }, banc: surLaListe, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: ['retrait:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '7. reprise explicite, fil escaladé : escalade effacée', depart: { owner: 'app_human', ...escaladee }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: [], arrivee: { owner: 'app_workflow', escaladee: false } },
  { nom: '7. reprise déclenchée par le client, un opérateur tient le fil : il la garde', depart: { owner: 'app_human' }, banc: surLaListe, geste: (f) => f.reprendrePourLApp('t1', 'w', { saufOperateur: true }), rend: 'operateur', meta: [], arrivee: { owner: 'app_human', surLaListe: true } },
  { nom: '7. reprise déclenchée par le client, l’agent tient le fil : reprise', depart: { owner: 'mba' }, banc: surLaListe, geste: (f) => f.reprendrePourLApp('t1', 'w', { saufOperateur: true }), rend: true, meta: ['retrait:w'], arrivee: { owner: 'app_workflow' } },
  { nom: '7. reprise, agent éteint : le contact sort quand même de la liste', depart: { owner: 'mba' }, banc: { ...surLaListe, mbaEnabled: false }, geste: (f) => f.reprendrePourLApp('t1', 'w'), rend: true, meta: ['retrait:w'], arrivee: { owner: 'app_workflow', surLaListe: false } },

  // 7b. Réponse de campagne « Inbox ».
  { nom: '7b. équipe, sur la liste, Meta accepte : retrait puis app_human', depart: { owner: 'app_workflow' }, banc: surLaListe, geste: (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), rend: true, meta: ['retrait:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '7b. équipe, Meta refuse : false, rien d’écrit', depart: { owner: 'mba' }, banc: { ...surLaListe, retrait: ['refuse'] }, geste: (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), rend: false, meta: ['retrait:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '7b. équipe, un opérateur tient déjà le fil : aucun appel, il le garde', depart: { owner: 'app_human' }, banc: surLaListe, geste: (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), rend: true, meta: [], arrivee: { owner: 'app_human' } },
  { nom: '7b. équipe, absent de la liste : app_human sans appel', depart: { owner: 'app_workflow' }, geste: (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), rend: true, meta: [], arrivee: { owner: 'app_human' } },

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

  // 12. Le balayage d'inactivité : vers `mba`, confier, sans événement.
  { nom: '12. balayage vers mba, Meta accepte : ajout, release puis mba', depart: { owner: 'app_human' }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: true, meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '12. balayage vers mba, Meta refuse l’ajout : false, rien d’écrit', depart: { owner: 'app_human' }, banc: { ajout: ['refuse'] }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: false, meta: ['ajout:w'], arrivee: { owner: 'app_human', surLaListe: false } },
  { nom: '12. balayage vers mba, Meta refuse le release : confié quand même, mba', depart: { owner: 'app_human' }, banc: { release: ['refuse'] }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: true, meta: ['ajout:w', 'release:w'], arrivee: { owner: 'mba', surLaListe: true } },
  { nom: '12. balayage vers mba, aucun numéro : false, rien d’écrit', depart: { owner: 'app_human' }, banc: { numero: null }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: false, meta: [], arrivee: { owner: 'app_human' } },
  { nom: '12. balayage vers mba, fil de test : false, aucun appel', depart: { owner: 'app_human', test: true }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), rend: false, meta: [], arrivee: { owner: 'app_human' } },
  { nom: '12. balayage mba vers app_workflow : aucun appel', depart: { owner: 'mba' }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'mba', 'app_workflow'), rend: true, meta: [], arrivee: { owner: 'app_workflow' } },
  { nom: '12. balayage, le détenteur a changé depuis la lecture : false', depart: { owner: 'app_human' }, geste: (f) => f.rendreApresInactivite('t1', 'w', 'app_workflow', 'mba'), rend: false, meta: ['ajout:w', 'release:w'], arrivee: { owner: 'app_human' } },
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
  /** Les deux formes d'appel : `client.x(` et `client['x'](` (guillemets simples, doubles ou gabarit). */
  const appelsDe = (noms: string): RegExp => new RegExp(`(?:\\.|\\[\\s*['"\`])(${noms})(?:['"\`]\\s*\\])?\\s*\\(`, 'g');
  const sitesDe = (noms: string): string[] => sources().flatMap(({ fichier, texte }) => [...texte.matchAll(appelsDe(noms))].map((m) => `${fichier} ${m[1]}`));

  it('🔴 aucun autre fichier n’appelle l’écriture de la colonne ni le `release` de Meta', () => {
    // Un appelant qui composerait lui-même « appel à Meta, puis écriture » referait, ailleurs, l'ordre et les gardes
    // que ce module porte seul : c'était l'asymétrie A (deux fabriques) et H (deux `takeControl`, deux `mayAct`).
    // Un appel par crochets échapperait sinon à la garde (relecture du lot 4).
    const sites = sitesDe('setControlOwner|releaseThread|demanderReleaseMba|consommerReleaseMba');
    expect(sites.filter((s) => !s.startsWith('src/inbox/fil.ts '))).toEqual([]);
    expect(sites.length, 'le module lui-même doit les appeler : sinon cette garde ne regarde plus rien').toBeGreaterThan(0);
  });

  it('🔴 et la liste de l’agent ne se touche que par son module', () => {
    // Une entrée posée ailleurs échapperait à notre table : un contact sur la liste que plus rien ne retire, qui
    // recevrait nos modèles avec l'agent qui répond.
    const sites = sitesDe('addToAllowlist|removeFromAllowlist|listAllowlist');
    expect(sites.filter((s) => !s.startsWith('src/mba/liste.ts ')).filter((s) => !s.startsWith('src/mba/client.ts '))).toEqual([]);
    expect(sites.some((s) => s.startsWith('src/mba/liste.ts ')), 'le module de la liste doit les appeler').toBe(true);
  });

  it('🔴 plus aucune prise par `take` : ni `takeThread`, ni l’action `take`, nulle part dans `src/`', () => {
    // Mesuré le 2026-09-29 : `take` ne nous rend rien, Meta répond 200 sans effet ou l'agent envoie sa phrase de
    // passation. Seul le retrait de la liste fait taire l'agent ; un `take` qui reviendrait serait un geste mort.
    const sites = sources().flatMap(({ fichier, texte }) => (/\btakeThread\b|['"`]take['"`]/.test(texte) ? [fichier] : []));
    expect(sites).toEqual([]);
    // Ancre positive : la même recherche voit bien l'action qui reste.
    expect(sources().some(({ texte }) => /['"`]release['"`]/.test(texte))).toBe(true);
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
    if (c.arrivee.surLaListe !== undefined) expect(b.table.has('w'), 'le contact sur la liste de l’agent').toBe(c.arrivee.surLaListe);
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
    // Confier : l'ajout à la liste, puis le release, puis la colonne. Reprendre (le contact est sur la liste) : le
    // retrait, puis la colonne. L'événement de la remise « personne ne suit » vient après la colonne.
    const gestes: Array<[string, (f: ControleDuFil) => Promise<unknown>, ControlOwner, string[], string[]]> = [
      ['reprendreLaMain', (f) => f.reprendreLaMain('t1', 'w', { collaborateur: null }), 'mba', ['w'], ['retrait:w', 'colonne:app_human']],
      ['rendreLaMain', (f) => f.rendreLaMain('t1', 'w', { collaborateur: null }), 'app_human', [], ['ajout:w', 'release:w', 'colonne:mba']],
      ['remettreSiPersonneNeSuit', (f) => f.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false }), 'app_workflow', [], ['ajout:w', 'release:w', 'colonne:mba', 'evenement:w']],
      ['reprendrePourLApp', (f) => f.reprendrePourLApp('t1', 'w'), 'mba', ['w'], ['retrait:w', 'colonne:app_workflow']],
      ['prendrePourLEquipe', (f) => f.prendrePourLEquipe('t1', 'w', 'automatique : campagne test'), 'mba', ['w'], ['retrait:w', 'colonne:app_human']],
      ['rendreApresInactivite', (f) => f.rendreApresInactivite('t1', 'w', 'app_human', 'mba'), 'app_human', [], ['ajout:w', 'release:w', 'colonne:mba']],
    ];
    for (const [nom, geste, detenteur, liste, attendu] of gestes) {
      ordre.length = 0;
      const b = bancDuFil({
        appels: ordre,
        surLaListe: liste,
        depot: { getControlOwner: async () => detenteur, setControlOwner: async (_t, _w, owner) => surveille(owner) },
      });
      await geste(b.fil);
      expect(ordre, `${nom} : Meta doit passer avant la colonne`).toEqual(attendu);
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
    // la remise (l'ajout à la liste). Avant : `app_human` escaladée, que le balayage exclut pour toujours.
    const b = bancDuFil({ ajout: ['refuse', 'accepte'], conversations: { w: { owner: 'app_human', escaladeeLe: ESCALADE } } });
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
    // Conversation née de l'envoi de la campagne : `app_workflow` par défaut, l'agent de Meta allumé, et le contact
    // encore sur sa liste (un ancien fil que l'agent tenait).
    const b = bancDuFil({ surLaListe: [WA], conversations: { [WA]: { owner: 'app_workflow' } } });
    const affectees: Array<[string, string]> = [];
    const deps: WebhookJobDeps = {
      store: { insertEvent: async () => true },
      inbox: { recordInbound: async () => ({ rouverte: false }), phoneNumberTenant: async () => 't1' },
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
      listeALArrivee: agentEteintALArrivee,
    };
    await handleWebhookJob(payload, deps);
    expect(b.appels, 'le fil est pris (le contact quitte la liste), puis jamais rendu à l’agent').toEqual([`retrait:${WA}`]);
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
      inbox: { recordInbound: async (_t, m) => { enregistres.push(m.messageId); return { rouverte: false }; }, phoneNumberTenant: async () => 't1' },
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
      // La vraie liste du banc : un `standby` d'un contact qui y est reste un `standby`.
      listeALArrivee: { agentAllume: async () => true, presents: (t, w) => b.liste.presents(t, w) },
    };
    return { deps, prises };
  }

  it('🔴 deux messages d’affilée du même contact : la prise n’est demandée qu’au premier', async () => {
    const b = bancDuFil({ surLaListe: [WA], conversations: { [WA]: { owner: 'app_workflow' } } });
    const j = monterLeJob(b);
    await handleWebhookJob(message('wamid.P1', 'Oui'), j.deps);
    await handleWebhookJob(message('wamid.P2', 'Vous êtes là ?'), j.deps);
    expect(j.prises).toEqual([WA]);
    expect(b.appels).toEqual([`retrait:${WA}`]);
    expect(b.etat(WA)?.owner).toBe('app_human');
  });

  it('🔴 « Rendre la main » tient : le message suivant du client ne reprend pas le fil à l’agent de Meta', async () => {
    const b = bancDuFil({ surLaListe: [WA], conversations: { [WA]: { owner: 'app_workflow' } } });
    const j = monterLeJob(b);
    await handleWebhookJob(message('wamid.P1', 'Oui'), j.deps);
    expect(b.etat(WA)?.owner).toBe('app_human');
    // L'opérateur rend la main : le contact revient sur la liste, `release`, puis `mba`.
    expect(await b.fil.rendreLaMain('t1', WA, { collaborateur: null })).toBe('mba');
    // Son agent tient désormais le fil : Meta range le message suivant en `standby`, et le contact est sur la liste.
    // (Arrivé en `messages`, il prouverait que nous tenions encore le fil, et l'agent serait prévenu : table, cas 6.)
    await handleWebhookJob({
      entry: [{ changes: [{ field: 'standby', value: {
        metadata: { phone_number_id: 'pn1' },
        standby: { contacts: [{ wa_id: WA }], messages: [{ id: 'wamid.P2', from: WA, type: 'text', timestamp: '1789465356', text: { body: 'Et demain ?' } }] },
      } }] }],
    }, j.deps);
    expect(j.prises).toEqual([WA]);
    expect(b.appels.filter((a) => a.startsWith('retrait:')), 'aucun retrait après le geste de l’opérateur').toEqual([`retrait:${WA}`]);
    expect(b.table.has(WA), 'le contact est resté sur la liste').toBe(true);
    expect(b.etat(WA)?.owner, 'le fil reste à l’agent de Meta').toBe('mba');
    // Et l'agent n'est pas prévenu une seconde fois : « Rendre la main » ne l'a pas prévenu, il parle au message.
    expect(b.evenements).toEqual([]);
  });

  /**
   * 🔴 La prise n'ayant plus lieu qu'une fois, elle doit TENIR. Une première réponse arrivée en `standby` (le fil
   * était revenu à l'agent de Meta entre l'envoi et la réponse) était prise pour l'équipe, puis la correction du
   * détenteur du même message réécrivait `mba` : Meta nous avait cédé le fil, notre colonne le donnait à l'agent.
   * Vérifié dans les deux sens : la correction remise après l'affectation dans `processInbound`, la colonne finit
   * à `mba`.
   */
  it('🔴 une première réponse arrivée en `standby` : le détenteur est corrigé AVANT la prise, qui tient', async () => {
    // Le contact est sur la liste de l'agent : son `standby` en reste un (absent, il deviendrait un `messages`).
    const b = bancDuFil({ surLaListe: [WA], conversations: { [WA]: { owner: 'app_workflow' } } });
    const j = monterLeJob(b);
    await handleWebhookJob({
      entry: [{ changes: [{ field: 'standby', value: {
        metadata: { phone_number_id: 'pn1' },
        standby: { contacts: [{ wa_id: WA }], messages: [{ id: 'wamid.S1', from: WA, type: 'text', timestamp: '1789465356', text: { body: 'Oui' } }] },
      } }] }],
    }, j.deps);
    expect(b.appels).toEqual([`retrait:${WA}`]);
    expect(b.etat(WA)?.owner, 'l’agent ne parle plus à ce contact, notre colonne le dit').toBe('app_human');
  });
});

/**
 * DÉCISION 3 (asymétrie A) : « Reprendre la main » rejoue une fois, comme les automates. Le geste est désormais le
 * retrait de la liste de l'agent (`src/mba/liste.ts`), qui porte le rejeu. Vérifié dans les deux sens : sans rejeu,
 * le cas rend `refuse` et le contact reste sur la liste.
 */
/**
 * 🔴 RELECTURE DU 2026-09-30 : la réponse à une campagne au devenir « Inbox », sur une conversation que l'équipe tient
 * depuis longtemps (délai de reprise échu), partait à l'agent de Meta par la remise du même job, alors que la campagne
 * l'envoie à l'équipe. Vérifié dans les deux sens : `relancerLeDelai` retiré de `prendrePourLEquipe`, ce cas échoue
 * (ajout, release, événement).
 */
describe('la réponse à une campagne au devenir Inbox reste à l’équipe', () => {
  it('🔴 fil de l’équipe au délai échu : le délai repart, une demande s’ouvre, la remise ne confie rien', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const il_y_a_3h = new Date(Date.now() - 3 * 3600_000);
    const b = bancDuFil({ conversations: { w: { owner: 'app_human', changedAt: il_y_a_3h } } });
    expect(await b.fil.prendrePourLEquipe('t1', 'w', 'automatique : campagne Rentrée')).toBe(true);
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', 'Oui, ça m’intéresse', { rouverte: false });
    expect(b.appels).toEqual([]);
    expect(b.etat('w')?.owner).toBe('app_human');
    expect(b.demandes).toEqual([{ waId: 'w', cause: 'automatique : campagne Rentrée' }]);
    expect(b.etat('w')!.changedAt!.getTime()).toBeGreaterThan(il_y_a_3h.getTime());
    vi.restoreAllMocks();
  });
});

describe('décision 3 : le bouton « Reprendre la main » rejoue une fois', () => {
  it('🔴 un refus passager suivi d’un accord : le fil est pris, en deux appels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = bancDuFil({ surLaListe: ['w'], retrait: ['passager', 'accepte'], conversations: { w: { owner: 'mba' } } });
    expect(await b.fil.reprendreLaMain('t1', 'w', { collaborateur: null })).toBe('pris');
    expect(b.appels).toEqual(['retrait:w', 'retrait:w']);
    expect(b.attentes).toHaveLength(1);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('⚠️ et jamais deux : deux refus passagers rendent `refuse`', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = bancDuFil({ surLaListe: ['w'], retrait: ['passager', 'passager', 'accepte'], conversations: { w: { owner: 'mba' } } });
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
    await b.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
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
    // Le contact est sur la liste de l'agent : une reprise l'en retire, et c'est l'appel qu'on observe.
    const b = bancDuFil({ surLaListe: [WA], conversations: { [WA]: { owner: depart } } });
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
    expect(m.b.appels).toEqual([`retrait:${WA}`]);
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
    expect(m.b.appels).toEqual([`retrait:${WA}`]);
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
      // Le même câblage que `src/worker.ts` : le routage vient de reprendre le fil, rien n'est à rouvrir.
      rendreLeFil: (t, w, contenu) => b.fil.remettreSiPersonneNeSuit(t, w, contenu, { rouverte: false }),
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
