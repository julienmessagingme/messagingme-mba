import type { ControlOwner } from './store.pg';
import { messageDe } from '../lib/erreur';
import { automatique, parCause, type AuteurDuChangement } from './evenements';
import type { ListeDeLAgent } from '../mba/liste';
import { destinataireAgentEvent, evenementMessageSansSuite, traceReponse, type EvenementAgent } from '../mba/evenement';

/**
 * Le contrôle du fil : qui répond au client, l'agent de Meta (`mba`), un scénario ou un agent IA (`app_workflow`),
 * ou l'équipe (`app_human`). C'est le seul endroit qui confie une conversation à l'agent de Meta ou la lui reprend
 * ET qui écrit notre colonne `conversations.control_owner` : chaque geste a son nom ici, et aucun appelant ne
 * compose lui-même « appel à Meta, puis écriture de la colonne ». Meta n'offre aucun moyen de LIRE qui tient le
 * fil : notre colonne est une croyance, que deux webhooks corrigent (`entrantEnStandby`, `agentDeMetaPasseLaMain`).
 *
 * L'agent de Meta est toujours en mode liste : il ne répond qu'aux contacts de sa liste, que la plateforme tient
 * (`src/mba/liste.ts`). Deux gestes en découlent. **Confier** : ajouter le contact à la liste, puis `release`
 * (`thread_control`). **Reprendre** : le retirer de la liste, ce qui fait taire l'agent même quand Meta lui a rendu
 * le fil. L'action `take` ne nous rendait rien (mesuré le 2026-09-29) et n'existe plus.
 *
 * Les règles que tous les gestes suivent, et qui ne s'écrivent donc qu'ici :
 *
 *  1. **Meta d'abord, notre colonne ensuite, et rien d'écrit si Meta refuse.** Une colonne qui annonce ce que Meta
 *     n'a pas fait laisse deux systèmes se croire chacun déchargés du client, et rend le problème invisible. Deux
 *     exceptions délibérées : l'état d'attente `app_human` d'une fin de parcours est posé AVANT la remise (il est
 *     vrai tout de suite, garde la conversation dans « À traiter » et arme le balayage), et la marque d'accusé est
 *     consommée AVANT l'appel (un refus ne se retente pas à chaque statut du même message, le balayage reprend).
 *  2. **Reprendre ne dépend que de notre table.** Un contact absent de la liste se reprend sans aucun appel ; présent,
 *     il est retiré, avec un rejeu sur un refus passager et jamais deux, même agent éteint (sinon l'agent lui
 *     répondrait le jour où on le rallume). `release` exige de tenir le fil.
 *  3. **Aucun numéro connecté : rien à confier chez Meta.** Une remise vers l'agent n'écrit rien : annoncer `mba`
 *     sur un espace où l'agent ne peut pas répondre mentirait, et `app_workflow` sortirait la conversation
 *     d'« À traiter ». Même règle partout. Une reprise, elle, retire avec le numéro que notre table a gardé.
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
   * Pose la marque d'escalade (`escaladee_le` : « À traiter » tout de suite, et le balayage ne rend plus le fil tant
   * que personne n'a répondu), si l'écriture a lieu et vise `app_human`. N'écrit AUCUN événement : c'est
   * `ouvreUneDemande` qui ouvre une demande, drapeau posé ou non.
   */
  escalade?: boolean;
  /**
   * Ce passage d'un robot à l'équipe OUVRE UNE DEMANDE du Quantitatif > Performance : l'événement `escaladee`
   * (migration 0194), si l'écriture a lieu, vise `app_human` et part d'un robot (`app_workflow` ou `mba`). Posé
   * par `passerAUnHumain` et `prendrePourLEquipe`, et par eux seuls : un opérateur qui prend le fil en écrivant
   * (`prisEnEcrivant`) et l'état d'attente d'une fin de parcours (`rendreApresParcours`) n'en ouvrent jamais.
   * Indépendant d'`escalade` (décision de Julien du 2026-09-29) : un scénario qui passe la main sans rien avoir
   * envoyé laisse un client qui attend, et une campagne sans marque d'escalade aussi.
   */
  ouvreUneDemande?: boolean;
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
  /**
   * La liste de l'agent de Meta (`src/mba/liste.ts`) : confier y ajoute le contact, reprendre l'en retire. Requise :
   * sans elle, un geste compilerait et laisserait l'agent parler (ou se taire) à contre-emploi.
   */
  liste: Pick<ListeDeLAgent, 'ajouter' | 'retirer'>;
  /**
   * Le contact a-t-il dit STOP, ou a-t-il été bloqué ? Requise, comme partout où une machine parle (`tests/consentement.ts`) :
   * une remise AUTOMATIQUE confie le contact à l'agent de Meta, qui lui parle. Sans elle, un « STOP » que personne
   * ne prenait partait chez l'agent avec l'ordre de répondre, et le contact restait sur sa liste (relecture du
   * 2026-09-30). Le bouton « Rendre la main » n'y passe pas : c'est un geste humain, délibéré.
   */
  consentement: {
    estDesabonne(tenantId: string, waId: string): Promise<boolean>;
    estBloque(tenantId: string, waId: string): Promise<boolean>;
  };
  meta: {
    mbaClientForTenant(tenantId: string): Promise<{
      releaseThread(phoneNumberId: string, waId: string): Promise<unknown>;
      agentEvent(phoneNumberId: string, to: string, event: EvenementAgent, signal?: AbortSignal): Promise<unknown>;
    }>;
  };
}

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
   * « Reprendre la main » (et le rangement « À traiter ») : prendre le fil sans écrire au client. Le contact est
   * retiré de la liste de l'agent s'il y est, quelle que soit notre colonne ; absent, aucun appel. `'refuse'` : Meta
   * a refusé le retrait, rien n'est écrit.
   */
  reprendreLaMain(tenantId: string, waId: string, par: AuteurDuChangement): Promise<'pris' | 'refuse'>;
  /**
   * « Rendre la main » / « Passer à l'agent Meta ». Sur un fil que notre colonne donne déjà à l'agent, on ne rouvre
   * que notre côté (`release` sans tenir le fil est hors contrat) ; agent éteint : `app_workflow` ; sinon on confie
   * (liste, puis `release`) et on écrit `mba`. Aucun événement : l'agent parle au prochain message du client. Lève si
   * Meta refuse. Efface l'escalade. Seul geste qui confie un fil de test.
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
   * Le client écrit et personne ne suit : la conversation est confiée à l'agent, qui y répond tout de suite
   * (événement `message_sans_suite`, avec `contenu`, le texte du ou des messages reçus). Gardes : agent allumé,
   * aucun parcours en attente, et un opérateur n'est pas doublé (détenteur relu AVANT l'appel, `only` ne protégeant
   * que la colonne). Lève si Meta refuse de confier, et aucun événement ne part alors. Aucun événement non plus sur
   * une conversation déjà confiée (sur la liste, et `mba` chez nous) : l'agent a déjà la parole, et la réponse
   * « à côté » d'un scénario vient d'être transmise par son propre événement.
   */
  remettreSiPersonneNeSuit(tenantId: string, waId: string, contenu: string): Promise<void>;
  /**
   * Reprendre le fil pour un scénario qu'on démarre délibérément (campagne, lancement depuis l'Inbox, lien de
   * chaîne, `/v1/sends`, jeton de test, relais de l'agent de Meta) : le contact est retiré de la liste de l'agent,
   * puis `app_workflow`. Reprend même un fil d'opérateur, sauf `saufOperateur` : un démarrage que le CLIENT
   * déclenche (clic sur une publicité) laisse la main à l'opérateur qui la tient.
   */
  reprendrePourLApp(tenantId: string, waId: string, opts?: { saufOperateur?: boolean }): Promise<IssueReprise>;
  /**
   * La réponse à une campagne dont le devenir est « Inbox » : prendre le fil pour l'équipe (`app_human`), pour
   * qu'aucun robot ne réponde et que la conversation entre dans « À traiter ». Un fil déjà tenu par un opérateur
   * reste tel quel. `false` = Meta a refusé de retirer le contact de la liste, son agent répond. `cause` : la
   * campagne, telle que la frise du panneau Détail la dit (« automatique : campagne Rentrée »). La bascule ouvre une
   * demande du Quantitatif > Performance (`escaladee`, `ouvreUneDemande`) : le client vient de répondre et attend
   * l'équipe.
   */
  prendrePourLEquipe(tenantId: string, waId: string, cause: string): Promise<boolean>;
  /**
   * Un scénario (bloc « passer à un humain », échec d'un parcours) ou un agent IA remonte la conversation à
   * l'équipe, seulement si le fil était encore aux robots. `escalade` : quelqu'un attend une réponse, la marque
   * collante est posée. Rend `true` si la bascule a eu lieu.
   *
   * `cause` REQUISE, portée par l'appelant, le seul à savoir QUI passe la main (« automatique : scénario
   * Bienvenue », « automatique : agent IA Léa ») : drapeau ou non, la bascule écrit l'événement `escaladee`
   * (migration 0194, `ouvreUneDemande`), qui ouvre une demande du Quantitatif > Performance et que la frise du
   * panneau Détail raconte. Le chrono de la demande, lui, ne part que quand le client a écrit
   * (`src/stats/performance.ts`) : une campagne qui passe la main juste après son modèle n'a encore personne à
   * faire attendre.
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
   * Le balayage d'inactivité rend un fil que plus personne ne traite. Vers `mba` : on confie d'abord (liste, puis
   * `release`), et un refus, une absence de numéro ou un fil de test n'écrivent rien (réessai à la passe suivante).
   * Aucun événement : l'agent parle au prochain message. Rend `true` si la bascule a eu lieu. `detenteur` est celui
   * que le balayage a lu : la garde `only` refuse s'il a changé depuis.
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
  standby: parCause('Meta rend la conversation à son agent'),
  inactivite: parCause('délai de reprise écoulé'),
} satisfies Record<string, AuteurDuChangement>;
const CAUSE_PASSATION = automatique('agent de Meta');

/**
 * Ce que « confier » a fait. `confie` : le contact est sur la liste et le fil rendu à l'agent ; `ajoute` dit s'il
 * vient d'y entrer. Les trois autres n'ont rien fait chez Meta.
 */
type IssueConfier =
  | { sorte: 'confie'; numero: string; ajoute: boolean }
  | { sorte: 'agent_eteint' | 'aucun_numero' | 'conversation_de_test' | 'contact_muet' };

export function creerControleDuFil(deps: DepsControleDuFil): ControleDuFil {
  const { depot } = deps;

  const mbaAllume = async (tenantId: string): Promise<boolean> => (await deps.reglages.get(tenantId)).mbaEnabled;

  /**
   * Confier la conversation à l'agent : le contact sur sa liste, puis `release`, dans cet ordre (rendu sans être sur
   * la liste, le fil irait à un agent qui ne parle pas à ce contact). Agent éteint, aucun numéro, ou fil de test sur
   * un chemin automatique (règle 5) : rien. Lève si Meta refuse l'ajout ou le `release` ; un `release` refusé laisse
   * le contact sur la liste, et le prochain message, arrivé chez nous, rejoue la remise.
   */
  const confier = async (tenantId: string, waId: string, o: { automatique: boolean }): Promise<IssueConfier> => {
    if (!(await mbaAllume(tenantId))) return { sorte: 'agent_eteint' };
    if (o.automatique && await depot.estConversationDeTest(tenantId, waId)) {
      // eslint-disable-next-line no-console
      console.log(`remise à l’agent de Meta ignorée pour ${waId} : conversation de TEST, le fil reste à l’app`);
      return { sorte: 'conversation_de_test' };
    }
    // Un contact désabonné ou bloqué n'est jamais confié par une machine : l'agent lui parlerait.
    if (o.automatique && ((await deps.consentement.estDesabonne(tenantId, waId)) || (await deps.consentement.estBloque(tenantId, waId)))) {
      return { sorte: 'contact_muet' };
    }
    const numero = await deps.numeros.getTenantPhoneNumberId(tenantId);
    if (!numero) return { sorte: 'aucun_numero' };
    const ajoute = await deps.liste.ajouter(tenantId, numero, waId);
    await (await deps.meta.mbaClientForTenant(tenantId)).releaseThread(numero, waId);
    return { sorte: 'confie', numero, ajoute };
  };

  /**
   * Prévient l'agent qu'un message l'attend, pour qu'il y réponde tout de suite. Un refus est journalisé, jamais
   * levé : la colonne dit `mba`, et l'agent répondra au prochain message du client.
   */
  const prevenir = async (tenantId: string, numero: string, waId: string, contenu: string): Promise<void> => {
    if (contenu.trim() === '') {
      // eslint-disable-next-line no-console
      console.log(`agent_event non envoyé pour ${waId} : aucun texte lisible, l’agent répondra au prochain message`);
      return;
    }
    try {
      const client = await deps.meta.mbaClientForTenant(tenantId);
      const reponse = await client.agentEvent(numero, destinataireAgentEvent(waId), evenementMessageSansSuite(contenu), AbortSignal.timeout(10_000));
      // La réponse porte l'identifiant de l'événement, seul moyen de demander ensuite à Meta ce qu'il en a fait.
      // eslint-disable-next-line no-console
      console.log(`agent_event sans suite envoyé pour ${waId} : ${traceReponse(reponse)}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`agent_event sans suite REFUSÉ pour ${waId} (${tenantId}), l’agent répondra au prochain message :`, messageDe(err));
    }
  };

  /**
   * Confie maintenant, puis écrit `mba`, depuis l'état d'attente seulement. Sur un refus, un fil de test ou une
   * absence de numéro, rien n'est écrit : l'état d'attente est déjà visible. La réponse de Meta au `release` ne dit
   * rien (`{"messaging_product":"whatsapp"}`) : le balayage reste le filet.
   */
  const rendreMaintenant = async (tenantId: string, waId: string): Promise<void> => {
    if ((await confier(tenantId, waId, { automatique: true })).sorte !== 'confie') return;
    await depot.setControlOwner(tenantId, waId, 'mba', { par: CAUSES.finDeParcours, only: ['app_human'], effacerEscalade: true });
  };

  return {
    async prisEnEcrivant(tenantId, waId, par) {
      await depot.setControlOwner(tenantId, waId, 'app_human', { par });
    },

    async reprendreLaMain(tenantId, waId, par) {
      // Quelle que soit notre colonne : elle peut dire `app_human` d'un contact que l'agent a encore sur sa liste.
      if (!(await deps.liste.retirer(tenantId, waId))) return 'refuse';
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
      // Geste humain : un fil de test se confie aussi (règle 5).
      if ((await confier(tenantId, waId, { automatique: false })).sorte !== 'confie') return 'aucun_numero';
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

    async remettreSiPersonneNeSuit(tenantId, waId, contenu) {
      if (!(await mbaAllume(tenantId))) return;
      // Donner à l'agent un fil qu'un parcours attend serait bien pire que le silence qu'on répare.
      if (await deps.parcours.findWaitingByWaId(tenantId, waId)) return;
      const detenteur = await depot.getControlOwner(tenantId, waId);
      if (detenteur === 'app_human') return;
      const issue = await confier(tenantId, waId, { automatique: true });
      if (issue.sorte !== 'confie') return;
      // `app_workflow` : le défaut d'une conversation née d'un envoi sortant, hors « À traiter » et muette sans ce
      // geste. `mba` : notre colonne peut le dire quand Meta pense l'inverse, et l'appel répare.
      const ecrit = await depot.setControlOwner(tenantId, waId, 'mba', { par: CAUSES.personneNeSuit, only: ['app_workflow', 'mba'], effacerEscalade: true });
      /**
       * Déjà confiée (sur la liste, et `mba` chez nous) : l'agent a la parole, et le prévenir le ferait répondre deux
       * fois quand une réponse « à côté » vient de lui être transmise par la fin du scénario, dans le même lot.
       * Colonne pas écrite depuis un autre détenteur : quelqu'un a pris le fil entre-temps, on ne lui parle pas dessus.
       */
      if (detenteur === 'mba' ? !issue.ajoute : !ecrit) return;
      await prevenir(tenantId, issue.numero, waId, contenu);
    },

    async reprendrePourLApp(tenantId, waId, opts) {
      if (opts?.saufOperateur === true && (await depot.getControlOwner(tenantId, waId)) === 'app_human') {
        // eslint-disable-next-line no-console
        console.log(`reprise du fil écartée pour ${waId} (${tenantId}) : un opérateur le tient, et ce démarrage vient du client`);
        return 'operateur';
      }
      // Tant que le contact est sur la liste de l'agent, l'agent peut lui répondre quoi que dise notre base. Dans
      // l'ordre inverse, le scénario répondrait par-dessus lui.
      if (!(await deps.liste.retirer(tenantId, waId))) return false;
      await depot.setControlOwner(tenantId, waId, 'app_workflow', { par: CAUSES.scenario, effacerEscalade: true });
      return true;
    },

    async prendrePourLEquipe(tenantId, waId, cause) {
      if ((await depot.getControlOwner(tenantId, waId)) === 'app_human') return true;
      if (!(await deps.liste.retirer(tenantId, waId))) return false;
      await depot.setControlOwner(tenantId, waId, 'app_human', { par: { cause }, ouvreUneDemande: true });
      return true;
    },

    passerAUnHumain(tenantId, waId, { escalade, cause }) {
      return depot.setControlOwner(tenantId, waId, 'app_human', { par: { cause }, only: ['app_workflow'], escalade, ouvreUneDemande: true });
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
          if ((await confier(tenantId, waId, { automatique: true })).sorte !== 'confie') return false;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`remise à l’agent de Meta REFUSÉE pour ${waId}, l’état local n’a pas été écrit:`, messageDe(err));
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
