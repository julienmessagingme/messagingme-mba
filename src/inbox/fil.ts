import type { ControlOwner } from './store.pg';
import { MetaApiError } from '../meta/errors';
import { messageDe } from '../lib/erreur';
import { automatique, parCause, type AuteurDuChangement } from './evenements';

/**
 * Le contrôle du fil : qui répond au client, l'agent de Meta (`mba`), un scénario ou un agent IA (`app_workflow`),
 * ou l'équipe (`app_human`). C'est le seul endroit qui parle à Meta (`thread_control`, actions `take` et `release`)
 * ET qui écrit notre colonne `conversations.control_owner` : chaque geste a son nom ici, et aucun appelant ne
 * compose lui-même « appel à Meta, puis écriture de la colonne ». Meta n'offre aucun moyen de LIRE qui tient le
 * fil : notre colonne est une croyance, que deux webhooks corrigent (`entrantEnStandby`, `agentDeMetaPasseLaMain`).
 *
 * Les règles que tous les gestes suivent, et qui ne s'écrivent donc qu'ici :
 *
 *  1. **Meta d'abord, notre colonne ensuite, et rien d'écrit si Meta refuse.** Une colonne qui annonce ce que Meta
 *     n'a pas fait laisse deux systèmes se croire chacun déchargés du client, et rend le problème invisible. Deux
 *     exceptions délibérées : l'état d'attente `app_human` d'une fin de parcours est posé AVANT la remise (il est
 *     vrai tout de suite, garde la conversation dans « À traiter » et arme le balayage), et la marque d'accusé est
 *     consommée AVANT l'appel (un refus ne se retente pas à chaque statut du même message, le balayage reprend).
 *  2. **Prendre est un privilège, rendre un droit.** Meta réserve `take` au « configured escalation partner » : un
 *     refus est un cas normal, rejoué une fois s'il est passager, jamais deux. `release` exige de tenir le fil.
 *  3. **Aucun numéro connecté : aucun fil à contrôler chez Meta.** Une prise réussit alors (notre colonne est la
 *     seule vérité), une remise vers l'agent n'écrit rien : annoncer `mba` sur un espace où l'agent ne peut pas
 *     répondre mentirait, et `app_workflow` sortirait la conversation d'« À traiter ». Même règle partout.
 *  4. **La marque d'escalade** (`escaladee_le` : quelqu'un a promis un humain au client) s'efface dès qu'un robot
 *     reprend le fil, agent de Meta ou scénario, et quand un opérateur le rend. Elle ne s'efface pas quand le fil
 *     va à l'équipe : c'est l'équipe qu'on attend. Sans ça, une conversation restait dans « À traiter » pendant que
 *     l'agent répondait, ou collée pour toujours après un refus de Meta (le balayage ne rend jamais un fil escaladé).
 *  5. **Un fil de test** (`is_test`) n'est jamais rendu automatiquement à l'agent : celui qui teste enchaîne les
 *     essais, et l'agent répondrait au scan suivant. Seul « Rendre la main », geste humain explicite, le peut.
 *  6. **Chaque écriture dit qui la demande** (`EcritureDuFil.par`, requis) : le collaborateur que l'appelant
 *     nomme pour un geste de la console, une cause écrite ici (`CAUSES`) pour tout le reste. Le dépôt en fait,
 *     dans la même requête, l'événement que raconte le panneau Détail de l'Inbox (migration 0192).
 *
 * Deux courses sont assumées entre la lecture du détenteur et l'appel à Meta (balayage, client que personne ne
 * suit, lead publicitaire) : un « Reprendre la main » cliqué pendant l'appel, que répare un second clic. Une
 * exception reste hors de ce module, délibérément : l'escalade d'un agent IA (`src/agent/escalade.ts`) clôt sa
 * session et sort du bloc avant de passer la main, sans poser de marque de tour en vol (la raison y est écrite).
 */

/** Les options d'écriture de la colonne, telles que le dépôt les applique dans un seul `update` gardé. */
export interface EcritureDuFil {
  /**
   * Qui demande la bascule : un collaborateur, ou une cause automatique. REQUIS : le dépôt écrit, dans la même
   * requête, l'événement que le panneau Détail raconte (`prise_mba`, `rendue_mba`, migration 0192), et une
   * bascule sans auteur ni cause ne dirait rien. Chaque geste de ce module sait qui le demande, c'est donc ici
   * qu'il se décide.
   */
  par: AuteurDuChangement;
  /** La transition n'a lieu que depuis ces détenteurs (garde atomique, dans le `where`). */
  only?: readonly ControlOwner[];
  /** Un `standby` antérieur à l'escalade est un retardataire : il n'écrit pas (sauf `messageEnvoyeLe` plus récent). */
  saufEscalade?: boolean;
  messageEnvoyeLe?: Date;
  /** Efface la marque d'escalade, si l'écriture a lieu. */
  effacerEscalade?: boolean;
  /**
   * Pose la marque d'escalade, si l'écriture a lieu et vise `app_human`. Depuis un robot (`app_workflow`), écrit
   * aussi l'événement `escaladee` (migration 0194) : l'ouverture d'une demande du Quantitatif > Performance.
   */
  escalade?: boolean;
  /**
   * Ce geste REND le fil à l'agent de Meta, quelle que soit la valeur écrite : l'événement est `rendue_mba`. Seul
   * « Rendre la main » sur un fil que notre colonne croit déjà à l'agent le pose, parce qu'il y écrit `app_workflow`
   * et que la règle des colonnes lirait alors un fil qui QUITTE l'agent (`prise_mba`), l'inverse du geste.
   */
  rendAgentDeMeta?: boolean;
}

/**
 * Ce dont le module a besoin, déclaré ici : le dépôt Inbox, les réglages, les parcours, le numéro et le client
 * Meta de l'espace. Construit une fois par processus (`src/socle.ts`).
 */
export interface DepsControleDuFil {
  depot: {
    /** L'absence de conversation vaut `app_workflow`. */
    getControlOwner(tenantId: string, waId: string): Promise<ControlOwner>;
    /** `true` si la bascule a eu lieu ; jamais d'erreur sur une garde refusée. */
    setControlOwner(tenantId: string, waId: string, owner: ControlOwner, opts: EcritureDuFil): Promise<boolean>;
    /** Marque le fil « à rendre dès l'accusé de notre dernier envoi » et rend ce message, ou `null` : rien en vol. */
    demanderReleaseMba(tenantId: string, waId: string): Promise<string | null>;
    /** Consomme la marque que ce message portait, et rend le fil concerné. */
    consommerReleaseMba(messageId: string): Promise<{ tenantId: string; waId: string } | null>;
    estConversationDeTest(tenantId: string, waId: string): Promise<boolean>;
    /**
     * `app_human` plus la marque d'escalade, en upsert : la passation peut précéder l'écho qui crée la conversation.
     * `cause` : ce que la frise du panneau Détail dit de la passation.
     */
    marquerEscalade(tenantId: string, waId: string, cause: string): Promise<void>;
  };
  reglages: { get(tenantId: string): Promise<{ mbaEnabled: boolean }> };
  /** Un parcours attend-il la réponse de ce contact ? */
  parcours: { findWaitingByWaId(tenantId: string, waId: string): Promise<object | null> };
  /** Numéro Meta de l'espace ; `null` = aucun numéro connecté. */
  numeros: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  meta: {
    mbaClientForTenant(tenantId: string): Promise<{
      releaseThread(phoneNumberId: string, waId: string): Promise<unknown>;
      takeThread(phoneNumberId: string, waId: string): Promise<unknown>;
    }>;
  };
  /**
   * Attendre, en millisecondes, entre deux tentatives de prise. Injectée et requise : la durée d'attente est un
   * comportement observable, et un test doit pouvoir vérifier le plafond sans dormir.
   */
  attendre(ms: number): Promise<void>;
}

/**
 * L'attente entre les deux tentatives de prise quand Meta ne dit pas combien patienter, et son plafond : dans la
 * boucle d'envoi d'une campagne, une attente longue retarde tous les destinataires suivants.
 */
export const REJEU_ATTENTE_DEFAUT_MS = 500;
export const REJEU_ATTENTE_MAX_MS = 2000;
/** Le nombre total de tentatives de prise : un essai, puis un rejeu. */
export const REJEU_TENTATIVES = 2;

/** Ce que « Rendre la main » a fait : le nouveau détenteur, ou rien faute de numéro (règle 3). */
export type IssueRendreLaMain = 'app_workflow' | 'mba' | 'aucun_numero';

/**
 * Ce qu'une reprise pour un scénario a donné. `false` = Meta a refusé de céder le fil ; `'operateur'` = un
 * opérateur le tient et ce démarrage ne le lui prend pas (`saufOperateur`).
 */
export type IssueReprise = boolean | 'operateur';

/** Les gestes. Chaque méthode est une fermeture : on peut la passer seule, sans `this`. */
export interface ControleDuFil {
  /**
   * Un opérateur ou une machine (API, MCP) vient d'écrire au client : le fil est à l'équipe. Aucun appel à Meta,
   * l'envoi WhatsApp prend le fil implicitement. Ne touche pas l'escalade.
   */
  prisEnEcrivant(tenantId: string, waId: string, par: AuteurDuChangement): Promise<void>;
  /**
   * « Reprendre la main » (et le rangement « À traiter ») : prendre le fil sans écrire au client. Meta n'est appelé
   * que si notre colonne dit `mba` et que l'agent est allumé, avec un rejeu comme les automates. `'refuse'` : Meta
   * n'a pas cédé, rien n'est écrit.
   */
  reprendreLaMain(tenantId: string, waId: string, par: AuteurDuChangement): Promise<'pris' | 'refuse'>;
  /**
   * « Rendre la main » / « Passer à l'agent Meta ». Sur un fil que notre colonne donne déjà à l'agent, on ne rouvre
   * que notre côté (`release` sans tenir le fil est hors contrat) ; agent éteint : `app_workflow` ; sinon `release`
   * puis `mba`. Lève si Meta refuse. Efface l'escalade. Seul geste qui rend un fil de test.
   */
  rendreLaMain(tenantId: string, waId: string, par: AuteurDuChangement): Promise<IssueRendreLaMain>;
  /**
   * Fin de parcours (chaîne finie, question expirée, réponse à côté ; échec d'un geste du relais de l'agent de
   * Meta) : `app_human` en attente, puis remise à l'accusé de notre dernier envoi, ou tout de suite si rien n'est en
   * vol. Seulement depuis `app_workflow`. Lève si Meta refuse ; le fil reste `app_human`, le balayage rattrape.
   */
  rendreApresParcours(tenantId: string, waId: string): Promise<void>;
  /** L'accusé d'un de nos envois est arrivé : si un fil l'attendait, il est rendu à l'agent maintenant. */
  remettreSurAccuse(messageId: string): Promise<void>;
  /**
   * Le client revient et personne ne suit : le fil repart chez l'agent. Gardes : agent allumé, aucun parcours en
   * attente, et un opérateur n'est pas doublé (détenteur relu AVANT l'appel, `only` ne protégeant que la colonne).
   */
  remettreSiPersonneNeSuit(tenantId: string, waId: string): Promise<void>;
  /**
   * Reprendre le fil pour un scénario qu'on démarre délibérément (campagne, lancement depuis l'Inbox, lien de
   * chaîne, `/v1/sends`, jeton de test, relais de l'agent de Meta) : `take` avec un rejeu si l'agent est allumé,
   * puis `app_workflow`. Reprend même un fil d'opérateur, sauf `saufOperateur` : un démarrage que le CLIENT
   * déclenche (clic sur une publicité) laisse la main à l'opérateur qui la tient.
   */
  reprendrePourLApp(tenantId: string, waId: string, opts?: { saufOperateur?: boolean }): Promise<IssueReprise>;
  /**
   * Le contact tape un de NOS boutons, mais Meta le livre en `standby` (il croit que son agent tient le fil) alors
   * qu'un parcours attend ce contact : la réponse est pour le scénario (décision de Julien du 2026-09-29, vécu le
   * même jour : le bouton « En savoir plus » d'un scénario lancé depuis l'Inbox n'a jamais atteint le bloc suivant).
   * On reprend le fil comme au démarrage, et l'appelant fait avancer le parcours. `false` : aucun parcours
   * n'attend (la réponse reste à l'agent de Meta), ou Meta refuse de céder le fil.
   */
  reprendreSurNotreBouton(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Un scénario vient d'envoyer un MODÈLE : reprendre le fil chez Meta tout de suite, avant la réponse du contact.
   * Mesuré le 2026-09-29, trois fois de suite : le fil pris au lancement ne survit pas à l'envoi d'un modèle, la
   * réponse arrive chez l'agent de Meta (`standby`), et le reprendre à ce moment-là lui fait envoyer son message de
   * passation au client. Un message libre, lui, garde le fil (les boutons d'un scénario sans modèle marchaient).
   * Seulement sur un fil que tient le scénario (`app_workflow`) et si l'agent est allumé ; rien n'est écrit chez
   * nous, la colonne dit déjà `app_workflow`. Un refus de Meta est journalisé, jamais levé.
   */
  retenirApresNotreModele(tenantId: string, waId: string): Promise<void>;
  /**
   * La réponse à une campagne dont le devenir est « Inbox » : prendre le fil pour l'équipe (`app_human`), pour
   * qu'aucun robot ne réponde et que la conversation entre dans « À traiter ». Un fil déjà tenu par un opérateur
   * reste tel quel. `false` = Meta a refusé de céder le fil, son agent répond. `cause` : la campagne, telle que la
   * frise du panneau Détail la dit (« automatique : campagne Rentrée »).
   */
  prendrePourLEquipe(tenantId: string, waId: string, cause: string): Promise<boolean>;
  /**
   * Un scénario (bloc « passer à un humain », échec d'un parcours) ou un agent IA remonte la conversation à
   * l'équipe, seulement si le fil était encore aux robots. `escalade` : quelqu'un attend une réponse. Rend `true`
   * si la bascule a eu lieu.
   *
   * `cause` REQUISE, portée par l'appelant, le seul à savoir QUI passe la main (« automatique : scénario
   * Bienvenue », « automatique : agent IA Léa ») : avec le drapeau, la bascule écrit l'événement `escaladee`
   * (migration 0194), qui ouvre une demande du Quantitatif > Performance et que la frise du panneau Détail raconte.
   */
  passerAUnHumain(tenantId: string, waId: string, opts: { escalade: boolean; cause: string }): Promise<boolean>;
  /** L'agent de Meta passe la main à l'équipe (`control_passed`) : `app_human` et escalade. */
  agentDeMetaPasseLaMain(tenantId: string, waId: string): Promise<void>;
  /**
   * Un entrant arrive en `standby` : l'agent de Meta tient le fil, Meta fait autorité, y compris contre un
   * opérateur. Sauf après une escalade, que seul un `standby` plus récent qu'elle lève (et efface).
   */
  entrantEnStandby(tenantId: string, waId: string, envoyeLe?: Date): Promise<void>;
  /**
   * Le balayage d'inactivité rend un fil que plus personne ne traite. Vers `mba` : Meta d'abord, et un refus, une
   * absence de numéro ou un fil de test n'écrivent rien (réessai à la passe suivante). Rend `true` si la bascule a
   * eu lieu. `detenteur` est celui que le balayage a lu : la garde `only` refuse s'il a changé depuis.
   */
  rendreApresInactivite(tenantId: string, waId: string, detenteur: ControlOwner, vers: 'mba' | 'app_workflow'): Promise<boolean>;
  /** Un scénario ou un agent IA peut-il écrire dans ce fil ? Seulement s'il est `app_workflow`. */
  peutAgir(tenantId: string, waId: string): Promise<boolean>;
}

/**
 * Les causes des bascules que ce module décide seul, telles que la frise du panneau Détail les affiche (migration
 * 0192). Écrites une fois : deux libellés pour le même geste feraient croire à deux gestes. Les gestes d'un
 * opérateur, eux, reçoivent leur auteur de l'appelant, seul à connaître la session ; et le passage d'un robot à
 * l'équipe reçoit la sienne de l'appelant aussi (`passerAUnHumain`), seul à savoir quel scénario ou quel agent IA
 * passe la main. Il portait ici un « escalade vers l'équipe » qui ne disait ni l'un ni l'autre.
 */
const CAUSES = {
  finDeParcours: parCause('fin du scénario'),
  personneNeSuit: parCause('le contact écrit et personne ne suit la conversation'),
  scenario: parCause('un scénario reprend la conversation'),
  boutonDuScenario: parCause('le contact répond au bouton d’un scénario'),
  standby: parCause('Meta rend la conversation à son agent'),
  inactivite: parCause('délai de reprise écoulé'),
} satisfies Record<string, AuteurDuChangement>;
const CAUSE_PASSATION = automatique('agent de Meta');

export function creerControleDuFil(deps: DepsControleDuFil): ControleDuFil {
  const { depot } = deps;

  /** L'acte chez Meta. `false` sans numéro connecté ; lève si Meta refuse. */
  const acteChezMeta = async (tenantId: string, waId: string, acte: 'releaseThread' | 'takeThread'): Promise<boolean> => {
    const numero = await deps.numeros.getTenantPhoneNumberId(tenantId);
    if (!numero) return false;
    const client = await deps.meta.mbaClientForTenant(tenantId);
    await client[acte](numero, waId);
    return true;
  };

  /**
   * Prendre le fil chez Meta, avec un rejeu et jamais deux. `true` = Meta n'a pas protesté (il a cédé le fil, ou
   * aucun numéro n'est connecté). Ne lève pas : l'appelant écrit sa colonne selon ce booléen. Le client MBA lève
   * sur tout refus, 429 compris, et ce geste devient un appel par destinataire de campagne : sans rejeu, un
   * plafond de débit ferait échouer tous les suivants. `classify` (`src/meta/errors.ts`) dit ce qui se rejoue.
   */
  const prendreAvecUnRejeu = async (tenantId: string, waId: string): Promise<boolean> => {
    for (let tentative = 0; tentative < REJEU_TENTATIVES; tentative += 1) {
      try {
        await acteChezMeta(tenantId, waId, 'takeThread');
        return true;
      } catch (err) {
        const derniere = tentative === REJEU_TENTATIVES - 1;
        const rejouable = err instanceof MetaApiError && err.retryable;
        if (!rejouable || derniere) {
          // eslint-disable-next-line no-console
          console.warn(`prise du fil : Meta a REFUSÉ de nous céder le fil pour ${waId} (${tenantId}) après ${tentative + 1} tentative(s), le détenteur ne change pas :`, messageDe(err));
          return false;
        }
        await deps.attendre(Math.min(err.retryAfterMs ?? REJEU_ATTENTE_DEFAUT_MS, REJEU_ATTENTE_MAX_MS));
      }
    }
    return false;
  };

  /** Toute remise AUTOMATIQUE à l'agent passe par ici : jamais un fil de test (règle 5). Lève si Meta refuse. */
  const remiseAutomatique = async (tenantId: string, waId: string): Promise<'rendu' | 'aucun_numero' | 'conversation_de_test'> => {
    if (await depot.estConversationDeTest(tenantId, waId)) {
      // eslint-disable-next-line no-console
      console.log(`release vers MBA ignoré pour ${waId} : conversation de TEST, le fil reste à l'app`);
      return 'conversation_de_test';
    }
    return (await acteChezMeta(tenantId, waId, 'releaseThread')) ? 'rendu' : 'aucun_numero';
  };

  /**
   * Relâche le fil maintenant, puis écrit `mba`, depuis l'état d'attente seulement. Sur un refus, un fil de test
   * ou une absence de numéro, rien n'est écrit : l'état d'attente est déjà visible. La réponse de Meta ne dit rien
   * (`{"messaging_product":"whatsapp"}`) : le balayage reste le filet.
   */
  const rendreMaintenant = async (tenantId: string, waId: string): Promise<void> => {
    if ((await remiseAutomatique(tenantId, waId)) !== 'rendu') return;
    await depot.setControlOwner(tenantId, waId, 'mba', { par: CAUSES.finDeParcours, only: ['app_human'], effacerEscalade: true });
  };

  const mbaAllume = async (tenantId: string): Promise<boolean> => (await deps.reglages.get(tenantId)).mbaEnabled;

  return {
    async prisEnEcrivant(tenantId, waId, par) {
      await depot.setControlOwner(tenantId, waId, 'app_human', { par });
    },

    async reprendreLaMain(tenantId, waId, par) {
      // `take` sur un fil que nous tenons déjà serait au mieux inutile, au pire une erreur lue comme une panne.
      if ((await depot.getControlOwner(tenantId, waId)) === 'mba' && (await mbaAllume(tenantId))
        && !(await prendreAvecUnRejeu(tenantId, waId))) return 'refuse';
      await depot.setControlOwner(tenantId, waId, 'app_human', { par });
      return 'pris';
    },

    async rendreLaMain(tenantId, waId, par) {
      // Les trois écritures clôturent l'escalade : c'est le même geste délibéré quelle que soit la valeur écrite.
      // Sur un fil que notre colonne donne déjà à l'agent, le geste reste un rendu : la frise le dit comme tel
      // (`rendAgentDeMeta`), et pas comme une prise, que la seule lecture des colonnes y aurait vue.
      if ((await depot.getControlOwner(tenantId, waId)) === 'mba') {
        await depot.setControlOwner(tenantId, waId, 'app_workflow', { par, effacerEscalade: true, rendAgentDeMeta: true });
        return 'app_workflow';
      }
      if (!(await mbaAllume(tenantId))) {
        await depot.setControlOwner(tenantId, waId, 'app_workflow', { par, effacerEscalade: true });
        return 'app_workflow';
      }
      if (!(await acteChezMeta(tenantId, waId, 'releaseThread'))) return 'aucun_numero';
      await depot.setControlOwner(tenantId, waId, 'mba', { par, effacerEscalade: true });
      return 'mba';
    },

    async rendreApresParcours(tenantId, waId) {
      // L'état d'attente est `app_human` : `mba` mentirait tant que Meta n'a pas confirmé, et `app_workflow` est la
      // seule valeur que « À traiter » exclut. Envoyer un message prend le fil chez Meta : un release émis juste
      // après notre dernier envoi serait annulé par lui, d'où l'attente de son accusé (`demanderReleaseMba`).
      if (!(await depot.setControlOwner(tenantId, waId, 'app_human', { par: CAUSES.finDeParcours, only: ['app_workflow'], effacerEscalade: true }))) return;
      if (await depot.demanderReleaseMba(tenantId, waId)) return;
      await rendreMaintenant(tenantId, waId);
    },

    async remettreSurAccuse(messageId) {
      // Appelée pour chaque statut reçu (chemin très chaud) : sans fil en attente, la requête ne touche rien.
      const cible = await depot.consommerReleaseMba(messageId);
      if (!cible) return;
      await rendreMaintenant(cible.tenantId, cible.waId);
    },

    async remettreSiPersonneNeSuit(tenantId, waId) {
      if (!(await mbaAllume(tenantId))) return;
      // Donner à l'agent un fil qu'un parcours attend serait bien pire que le silence qu'on répare.
      if (await deps.parcours.findWaitingByWaId(tenantId, waId)) return;
      if ((await depot.getControlOwner(tenantId, waId)) === 'app_human') return;
      if ((await remiseAutomatique(tenantId, waId)) !== 'rendu') return;
      // `app_workflow` : le défaut d'une conversation née d'un envoi sortant, hors « À traiter » et muette sans ce
      // geste. `mba` : notre colonne peut le dire quand Meta pense l'inverse, et l'appel répare.
      await depot.setControlOwner(tenantId, waId, 'mba', { par: CAUSES.personneNeSuit, only: ['app_workflow', 'mba'], effacerEscalade: true });
    },

    async reprendrePourLApp(tenantId, waId, opts) {
      if (opts?.saufOperateur === true && (await depot.getControlOwner(tenantId, waId)) === 'app_human') {
        // eslint-disable-next-line no-console
        console.log(`reprise du fil écartée pour ${waId} (${tenantId}) : un opérateur le tient, et ce démarrage vient du client`);
        return 'operateur';
      }
      // L'agent de Meta est le répondeur primaire du numéro : tant qu'on ne lui a pas pris le fil, il répond quoi
      // que dise notre base. Dans l'ordre inverse, le scénario répondrait par-dessus lui.
      if ((await mbaAllume(tenantId)) && !(await prendreAvecUnRejeu(tenantId, waId))) return false;
      await depot.setControlOwner(tenantId, waId, 'app_workflow', { par: CAUSES.scenario, effacerEscalade: true });
      return true;
    },

    async reprendreSurNotreBouton(tenantId, waId) {
      if (!(await deps.parcours.findWaitingByWaId(tenantId, waId))) return false;
      if ((await mbaAllume(tenantId)) && !(await prendreAvecUnRejeu(tenantId, waId))) return false;
      await depot.setControlOwner(tenantId, waId, 'app_workflow', { par: CAUSES.boutonDuScenario, effacerEscalade: true });
      return true;
    },

    async retenirApresNotreModele(tenantId, waId) {
      if (!(await mbaAllume(tenantId))) return;
      if ((await depot.getControlOwner(tenantId, waId)) !== 'app_workflow') return;
      await prendreAvecUnRejeu(tenantId, waId);
    },

    async prendrePourLEquipe(tenantId, waId, cause) {
      if ((await depot.getControlOwner(tenantId, waId)) === 'app_human') return true;
      if ((await mbaAllume(tenantId)) && !(await prendreAvecUnRejeu(tenantId, waId))) return false;
      await depot.setControlOwner(tenantId, waId, 'app_human', { par: { cause } });
      return true;
    },

    passerAUnHumain(tenantId, waId, { escalade, cause }) {
      return depot.setControlOwner(tenantId, waId, 'app_human', { par: { cause }, only: ['app_workflow'], escalade });
    },

    agentDeMetaPasseLaMain(tenantId, waId) {
      return depot.marquerEscalade(tenantId, waId, CAUSE_PASSATION);
    },

    async entrantEnStandby(tenantId, waId, envoyeLe) {
      // La date du message tranche : un standby antérieur à l'escalade est un retardataire (il rendrait la
      // conversation à l'agent sous le nez de l'équipe) ; postérieur, il prouve que Meta a redonné le fil à l'agent.
      // Sans date, la garde reste stricte.
      await depot.setControlOwner(tenantId, waId, 'mba', {
        par: CAUSES.standby, saufEscalade: true, effacerEscalade: true, ...(envoyeLe ? { messageEnvoyeLe: envoyeLe } : {}),
      });
    },

    async rendreApresInactivite(tenantId, waId, detenteur, vers) {
      if (vers === 'mba') {
        try {
          if ((await remiseAutomatique(tenantId, waId)) !== 'rendu') return false;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`release vers MBA REFUSÉ pour ${waId}, l’état local n’a pas été écrit:`, messageDe(err));
          return false;
        }
      }
      return depot.setControlOwner(tenantId, waId, vers, { par: CAUSES.inactivite, only: [detenteur], effacerEscalade: true });
    },

    async peutAgir(tenantId, waId) {
      return (await depot.getControlOwner(tenantId, waId)) === 'app_workflow';
    },
  };
}
