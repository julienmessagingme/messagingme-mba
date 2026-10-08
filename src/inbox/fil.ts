import type { ControlOwner } from './store.pg';
import { messageDe } from '../lib/erreur';
import { automatique, parCause, type AuteurDuChangement } from './evenements';
import { ListePleine, type ListeDeLAgent } from '../mba/liste';
import { delaiHumainMs, repriseDue } from './delai-reprise';
import { destinataireAgentEvent, evenementMessageSansSuite, traceReponse, type EvenementAgent } from '../mba/evenement';
import type { DemarreurRepondeur } from '../repondeur/demarrer';
import type { DemarreurScenario } from '../repondeur/scenario';
import type { DemandeALApplication } from '../evenements/besoin-reponse';
import { leMbaRepond, modeEffectif, sousLOffre, type ReglageDuRepondeur } from '../repondeur/mode';
import type { SourceOffres } from '../offres/offre.pg';
import { journaliser } from '../lib/journal';

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
 *     Pour confier, c'est la LISTE qui décide si l'agent parle : un `release` refusé après elle n'est pas un refus
 *     (`confier`). Et un client qu'on n'a pas pu confier passe à l'équipe, pour rester visible
 *     (`remettreSiPersonneNeSuit`).
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
 *  5. **Un fil de test** (`is_test`) n'est jamais rendu automatiquement à l'agent. Seul « Rendre la main », geste
 *     humain explicite, le peut. ⚠️ Plus rien ne marque une conversation comme test depuis le 2026-10-03 (le lien
 *     de test ne le fait plus, décision de Julien) : la règle ne vaut que pour les conversations marquées avant.
 *  6. **Chaque écriture dit qui la demande** (`EcritureDuFil.par`, requis) : le collaborateur que l'appelant
 *     nomme pour un geste de la console, une cause écrite ici (`CAUSES`) pour tout le reste. Le dépôt en fait,
 *     dans la même requête, l'événement que raconte le panneau Détail de l'Inbox (migration 0192).
 *
 * QUI RÉPOND AU CLIENT (RC6, `src/repondeur/mode.ts`). Un réglage de l'espace, le MODE, décide qui reçoit un contact
 * que personne ne tient : l'agent de Meta (`mba`), un agent IA (`agent`, lot 5), un scénario (`scenario`), ou l'équipe
 * (`equipe`). La remise « personne ne suit » garde ses gardes, dans le même ordre, puis suit le mode
 * (`remettreSiPersonneNeSuit`). 🔴 L'agent de Meta ALLUMÉ n'est répondeur qu'en mode `mba` (`leMbaRepond`) : en veille,
 * ni la remise, ni « Rendre la main », ni la fin de parcours (l'exécuteur, `mbaActifPour`), ni le balayage
 * (`src/inbox/control-sweep.ts`) ne lui confient rien, et seul le bloc « Envoyer au MBA » d'un scénario le fait
 * (`envoyerAuMba`). Hors du mode `mba`, la fin de parcours et le balayage laissent le fil à `app_workflow`, et c'est
 * le prochain message du client qui relance le répondeur du mode, exactement comme l'agent de Meta répond au prochain
 * message. Une exception, le pendant de la transmission à l'agent de Meta : le message « à côté » d'un parcours qui
 * finit, que l'exécuteur confie au répondeur par cette même remise (`WorkflowExecutorDeps.confierAuRepondeur`).
 * ⚠️ `confier` ne lit que l'allumage (le bloc confie en veille) : la question « est-il le répondeur ? » appartient à
 * chaque appelant, et la fin d'un geste de l'agent de Meta lui-même (`src/mba/gestes-envoi.ts`) lui rend toujours
 * le fil.
 *
 * Deux courses sont assumées entre la lecture du détenteur et l'appel à Meta (balayage, client que personne ne
 * suit, lead publicitaire) : un « Reprendre la main » cliqué pendant l'appel, que répare un second clic ; et, sur un
 * fil de l'équipe dont le délai vient d'expirer, une réponse d'opérateur écrite pendant l'appel, que la garde `only`
 * ne voit pas (le fil reste `app_human`). Une
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
    /**
     * Ce que la remise « personne ne suit » lit du fil : son détenteur, le temps écoulé depuis `control_changed_at`
     * (`null` = non daté), et s'il porte une escalade sans réponse. L'absence de conversation vaut `app_workflow`.
     */
    etatDuFil(tenantId: string, waId: string): Promise<{ owner: ControlOwner; depuisMs: number | null; escaladee: boolean }>;
    /**
     * Ouvre une demande du Quantitatif > Performance (l'événement `escaladee`) sur un fil que l'équipe tient encore,
     * sans bascule : un client rouvre une conversation « Traité » ou archivée, et c'est l'équipe qui lui doit la
     * réponse. `cause` : ce que la frise du panneau Détail en dit. Rien si le fil n'est plus à l'équipe.
     */
    ouvrirUneDemande(tenantId: string, waId: string, cause: string): Promise<void>;
    /**
     * Fait repartir le délai de reprise (`control_changed_at = now()`) d'un fil que l'équipe tient, sans bascule. Rien
     * si le fil n'est pas à l'équipe.
     */
    relancerLeDelai(tenantId: string, waId: string): Promise<void>;
    /** Les contacts dont notre colonne dit le fil tenu par l'agent de Meta, par `wa_id` croissant, après `apres`. */
    filsDeLAgentDeMeta(tenantId: string, apres: string | null, limite: number): Promise<string[]>;
    /**
     * Note dans la frise que le bloc « Envoyer au MBA » a trouvé l'agent de Meta éteint (`mba_indisponible`, 0217).
     * `cause` : le scénario, tel que la frise le dit. Aucune conversation : rien.
     */
    noterMbaIndisponible(tenantId: string, waId: string, cause: string): Promise<void>;
  };
  /**
   * Les réglages de l'espace : qui répond au client (le mode, sa cible, l'agent de Meta allumé, `src/repondeur/mode.ts`),
   * le délai du mode Scénario (secondes), et le délai de reprise de l'équipe (secondes ; `null` = le défaut du serveur,
   * 0 = jamais).
   */
  reglages: {
    get(tenantId: string): Promise<ReglageDuRepondeur & { repondeurDelaiScenarioS: number; controlHandbackSeconds: number | null }>;
  };
  /**
   * L'offre de l'espace (`OffresEnCache`, lot 6, B2a) : les réglages se lisent TOUJOURS sous elle (`sousLOffre`), donc
   * en Base l'agent de Meta ne reçoit plus rien et le scénario répondeur ne part plus. Une offre illisible se lit
   * Entreprise : une panne de lecture ne gèle rien.
   */
  offres: SourceOffres;
  /**
   * Le délai de reprise de l'équipe quand l'espace n'en a pas réglé (`CONTROL_HUMAN_TIMEOUT_MS`), le même que celui
   * du balayage. Requis : sans lui, la remise « personne ne suit » et le balayage ne compteraient pas le même délai.
   */
  delaiRepriseParDefautMs: number;
  /** Un parcours attend-il la réponse de ce contact ? */
  parcours: { findWaitingByWaId(tenantId: string, waId: string): Promise<object | null> };
  /**
   * Numéro Meta de l'espace ; `null` = aucun numéro connecté. `numeroBloque` : délié, ou suspendu faute de paiement
   * (lot 4, `creerNumeroBloqueDeLEspace`) ; aucun robot ne prend alors le message.
   */
  numeros: {
    getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
    numeroBloque(tenantId: string): Promise<boolean>;
  };
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
  /**
   * Les démarreurs du répondeur : l'agent IA (`src/repondeur/demarrer.ts`) et le scénario (`src/repondeur/scenario.ts`,
   * RC6). 🔴 REQUIS : optionnels, un câblage qui les oublierait compilerait, et chaque message d'un espace à répondeur
   * resterait sans réponse, hors d'« À traiter ». Le fil est construit AVANT l'exécuteur dont les démarreurs dépendent :
   * le socle les branche par une liaison tardive qui lève si on l'appelle avant (`src/socle.ts`).
   */
  repondeur: Pick<DemarreurRepondeur, 'demarrer'> & DemarreurScenario;
  /**
   * « Mon application répond » (lot 12, livraison B, `src/evenements/besoin-reponse.ts`) : la demande de réponse envoyée
   * à l'adresse désignée. REQUISE, pour la même raison que les démarreurs.
   */
  application: DemandeALApplication;
}

/**
 * Ce que la remise « personne ne suit » sait des messages qu'elle remet. `rouverte` : l'un d'eux vient de sortir la
 * conversation de « Traité » ou d'Archivé. Les deux autres ne servent que le répondeur IA, et leur absence vaut
 * « inconnu » : `messageDeclencheur`, le dernier message du contact (le parcours du répondeur naît en l'ayant reçu,
 * sa redélivrance n'enfile pas un second tour) ; `redelivre`, tous ses messages étaient déjà connus ;
 * `reactionsSeules`, ce ne sont que des réactions (un emoji, ou son retrait), décidé sur leur TYPE par la remise
 * (`src/webhooks/remise-mba-entrant.ts`) et jamais sur un texte vide : la réponse « à côté » que confie la fin d'un
 * parcours (`confierAuRepondeur`) arrive sans texte, et il faut y répondre.
 */
export interface EntreeDuContact {
  rouverte: boolean;
  messageDeclencheur?: string | null;
  redelivre?: boolean;
  reactionsSeules?: boolean;
}

/** Ce que « Rendre la main » a fait : le nouveau détenteur, ou rien faute de numéro (règle 3). */
export type IssueRendreLaMain = 'app_workflow' | 'mba' | 'aucun_numero';

/**
 * Ce que le bloc « Envoyer au MBA » a fait. `confie` : l'agent de Meta tient le contact et a été prévenu ;
 * `mba_eteint` : la frise le dit et l'équipe le tient ; `non_confie` : contact muet, fil de test, aucun numéro, ou
 * Meta a refusé l'ajout, et l'équipe le tient.
 */
export type IssueEnvoiAuMba = 'confie' | 'mba_eteint' | 'non_confie';

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
   * « Mon application répond » (lot 12, B) : l'espace est-il dans ce mode (sous l'offre), et ce fil tenu par les robots ?
   * La réponse de l'application par l'API ne prend alors pas le fil, sans quoi elle ne serait plus jamais sollicitée.
   */
  tenuParLApplication(tenantId: string, waId: string): Promise<boolean>;
  /** L'espace est-il en mode « mon application répond » (sous l'offre) ? Ses réponses par l'API sortent du quota du jour. */
  enModeApplication(tenantId: string): Promise<boolean>;
  /**
   * « Reprendre la main » (et le rangement « À traiter ») : prendre le fil sans écrire au client. Le contact est
   * retiré de la liste de l'agent s'il y est, quelle que soit notre colonne ; absent, aucun appel. `'refuse'` : Meta
   * a refusé le retrait, rien n'est écrit.
   */
  reprendreLaMain(tenantId: string, waId: string, par: AuteurDuChangement): Promise<'pris' | 'refuse'>;
  /**
   * « Rendre la main » / « Passer à l'agent Meta ». Sur un fil que notre colonne donne déjà à l'agent, on ne rouvre
   * que notre côté (`release` sans tenir le fil est hors contrat) ; l'agent de Meta n'est pas le répondeur (éteint, ou
   * en veille hors du mode `mba`) : `app_workflow`, et le prochain message relance le répondeur du mode ; sinon on
   * confie (liste, puis `release`) et on écrit `mba`. Aucun événement : l'agent parle au prochain message du client. Lève si
   * Meta refuse l'ajout à la liste (un `release` refusé n'en est pas un, `confier`). Efface l'escalade. Seul geste
   * qui confie un fil de test.
   */
  rendreLaMain(tenantId: string, waId: string, par: AuteurDuChangement): Promise<IssueRendreLaMain>;
  /**
   * Fin de parcours (chaîne finie, question expirée, réponse à côté ; échec d'un geste du relais de l'agent de
   * Meta) : `app_human` en attente, puis remise à l'accusé de notre dernier envoi, ou tout de suite si rien n'est en
   * vol. Seulement depuis `app_workflow`. Lève si Meta refuse l'ajout à la liste ; le fil reste `app_human`, le
   * balayage rattrape.
   */
  rendreApresParcours(tenantId: string, waId: string): Promise<void>;
  /** L'accusé d'un de nos envois est arrivé : si un fil l'attendait, il est rendu à l'agent maintenant. */
  remettreSurAccuse(messageId: string): Promise<void>;
  /**
   * Le client écrit et personne ne suit : le MODE de l'espace décide (RC6, `src/repondeur/mode.ts`), après les mêmes
   * gardes, dans le même ordre, pour tous (fil de l'équipe dans son délai, parcours en attente, numéro bloqué).
   *  - `equipe` : le fil passe à l'équipe (`app_human`, pot commun) avec une demande et la marque d'escalade, pour qu'il
   *    entre dans « À traiter » et que le balayage ne l'en sorte pas avant qu'on lui ait répondu. Un fil que l'équipe
   *    tient lui reste, délai écoulé ou non : il n'y a aucun robot à qui le rendre.
   *  - `agent` (lot 5) : l'agent IA démarre (`DepsControleDuFil.repondeur`) ; s'il ne le peut pas (crédit épuisé, modèle
   *    absent, agent inactif, lancement refusé), la conversation passe à l'équipe avec une demande.
   *  - `scenario` : le scénario démarre, au plus une fois par délai pour ce contact (la réclamation est atomique : deux
   *    entrants simultanés, un seul départ) ; entre-temps, à l'équipe comme en `equipe` ; s'il ne peut pas partir, à
   *    l'équipe comme l'agent IA.
   *  - `mba` : le reste de ce commentaire.
   * `entree.messageDeclencheur` : le dernier message du contact, que le parcours naît en ayant reçu ;
   * `entree.redelivre` : tous ses messages étaient déjà connus (redélivrance de Meta), rien ne démarre ;
   * `entree.reactionsSeules` : rien que des réactions, rien ne démarre non plus.
   *
   * La conversation est confiée à l'agent, qui y répond tout de suite
   * (événement `message_sans_suite`, avec `contenu`, le texte du ou des messages reçus). Gardes : agent allumé,
   * aucun parcours en attente, et un opérateur n'est pas doublé (détenteur relu AVANT l'appel, `only` ne protégeant
   * que la colonne). Si confier lève, aucun événement ne part, la conversation passe à l'équipe (`app_human`, pour
   * entrer dans « À traiter ») et l'erreur remonte. Sur une conversation déjà confiée (sur la liste, et `mba` chez
   * nous), l'agent n'est prévenu que si le `release` vient de passer : nous tenions donc le fil, et il n'a pas vu ce
   * message. Refusé, l'agent tenait déjà le fil, et la réponse « à côté » d'un scénario lui a été transmise par son
   * propre événement.
   *
   * Un fil tenu par l'équipe (`app_human`) ne lui est pris que si son délai de reprise est écoulé (la règle du
   * balayage, `./delai-reprise.ts`) : il est alors confié à l'agent, qui répond à CE message, même après plus de
   * 24 h de silence (c'est le client qui vient d'ouvrir la fenêtre). Sinon il reste à l'équipe, et si ce message
   * vient de rouvrir la conversation (`entree.rouverte` : elle était « Traité » ou archivée), une demande s'ouvre
   * pour elle (`ouvrirUneDemande`).
   */
  remettreSiPersonneNeSuit(tenantId: string, waId: string, contenu: string, entree: EntreeDuContact): Promise<void>;
  /**
   * Reprendre le fil pour un scénario qu'on démarre délibérément (campagne, lancement depuis l'Inbox, lien de
   * chaîne, `/v1/sends`, jeton de test, relais de l'agent de Meta) : le contact est retiré de la liste de l'agent,
   * puis `app_workflow`. Reprend même un fil d'opérateur, sauf `saufOperateur` : un démarrage que le CLIENT
   * déclenche (clic sur une publicité, arrivée par un widget) laisse la main à l'opérateur qui la tient.
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
  /**
   * Le bloc « Envoyer au MBA » d'un scénario (RC6, type `vers_mba`), dans TOUS les modes : le seul chemin qui confie un
   * contact à l'agent de Meta en veille. Allumé : il confie (liste, `release`), écrit `mba`, puis le prévient avec
   * `contenu`, le dernier message du contact, pour qu'il y réponde tout de suite. Éteint : la frise le dit
   * (`mba_indisponible`) et le fil passe à l'équipe avec une demande. Contact muet, fil de test, aucun numéro, ou un
   * ajout que Meta refuse : à l'équipe aussi. `cause` : le scénario, tel que la frise le dit. Ne lève que si la base
   * lève (un refus de Meta est rattrapé ici) : l'exécuteur, dont le parcours a déjà fini, l'isole.
   */
  envoyerAuMba(tenantId: string, waId: string, o: { contenu: string; cause: string }): Promise<IssueEnvoiAuMba>;
  /**
   * L'agent de Meta vient de cesser d'être le répondeur (`src/repondeur/reglage.ts`) : chaque fil que notre
   * colonne lui donnait revient aux robots (`app_workflow`), un événement `prise_mba` chacun. Laissé `mba`, le fil
   * n'est plus tenu par personne : un parcours qui attend ce contact gèle (« le fil ne nous appartient pas ») et
   * la remise refuse de lui donner l'agent IA, donc le client n'a plus aucune réponse (essai réel du 2026-10-05).
   * Aucun appel à Meta : son agent est éteint, et ses contacts viennent d'être retirés de sa liste. Rend le nombre
   * de fils repris.
   */
  reprendreLesFilsDeMeta(tenantId: string): Promise<number>;
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
  nonConfiee: parCause('l’agent de Meta n’a pas pu prendre la conversation'),
  apresLeDelai: parCause('le contact réécrit après le délai de reprise'),
  scenario: parCause('un scénario reprend la conversation'),
  standby: parCause('Meta rend la conversation à son agent'),
  inactivite: parCause('délai de reprise écoulé'),
  creditEpuise: parCause('crédit IA épuisé, le répondeur automatique ne peut pas répondre'),
  repondeurIndisponible: parCause('le répondeur automatique ne peut pas répondre'),
  agentDeMetaRemplace: parCause('l’agent de Meta n’est plus le répondeur de l’espace'),
  equipe: parCause('le contact écrit, l’équipe répond'),
  scenarioDejaParti: parCause('le scénario répondeur est déjà parti pour ce contact, l’équipe prend la suite'),
} satisfies Record<string, AuteurDuChangement>;
const CAUSE_PASSATION = automatique('agent de Meta');
/** La taille d'un paquet de `reprendreLesFilsDeMeta` : une lecture par paquet, une écriture gardée par fil. */
const PAQUET_FILS_DE_META = 200;
/** La demande qu'ouvre un client en rouvrant une conversation que l'équipe tient encore (`remettreSiPersonneNeSuit`). */
export const CAUSE_REOUVERTURE = automatique('le contact réécrit après « Traité » ou l’archivage');

/**
 * Ce que « confier » a fait. `confie` : le contact est sur la liste de l'agent ; `ajoute` dit s'il vient d'y entrer,
 * `rendu` si Meta a accepté le `release` (refusé : l'agent tenait déjà le fil, ou nous le tenons encore). Les autres
 * n'ont rien fait chez Meta.
 */
type IssueConfier =
  | { sorte: 'confie'; numero: string; ajoute: boolean; rendu: boolean }
  | { sorte: 'agent_eteint' | 'aucun_numero' | 'conversation_de_test' | 'contact_muet' };

export function creerControleDuFil(deps: DepsControleDuFil): ControleDuFil {
  const { depot } = deps;

  /** Les réglages de l'espace SOUS SON OFFRE (`sousLOffre`) : la seule lecture des réglages de ce module. */
  const reglagesDe = async (tenantId: string) => {
    const [r, o] = await Promise.all([deps.reglages.get(tenantId), deps.offres.offreDe(tenantId)]);
    return sousLOffre(r, o.droits.fonctions);
  };
  const mbaAllume = async (tenantId: string): Promise<boolean> => (await reglagesDe(tenantId)).mbaEnabled;

  /**
   * Confier la conversation à l'agent : le contact sur sa liste, puis `release`, dans cet ordre (rendu sans être sur
   * la liste, le fil irait à un agent qui ne parle pas à ce contact). Agent éteint, aucun numéro, ou fil de test sur
   * un chemin automatique (règle 5) : rien. Lève si Meta refuse l'ajout.
   *
   * 🔴 Un `release` refusé APRÈS la liste ne lève pas : c'est la liste qui décide si l'agent parle, et `release`
   * n'est utile que quand nous tenons le fil. Meta le refuse quand son agent le tient déjà, ce qui arrive après tout
   * modèle (vécu le 2026-09-30 : « Rendre la main » répondait une erreur alors que l'agent répondait bien au message
   * suivant). Si nous tenions en fait le fil, le prochain message du client arrive chez nous (`messages`), et la
   * remise « personne ne suit » rejoue le `release` et prévient l'agent.
   */
  const confier = async (tenantId: string, waId: string, o: { automatique: boolean; faireDeLaPlace: boolean }): Promise<IssueConfier> => {
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
    const ajoute = await deps.liste.ajouter(tenantId, numero, waId, { faireDeLaPlace: o.faireDeLaPlace });
    try {
      await (await deps.meta.mbaClientForTenant(tenantId)).releaseThread(numero, waId);
      return { sorte: 'confie', numero, ajoute, rendu: true };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`release refusé pour ${waId} (${tenantId}), le contact est sur la liste de l’agent de Meta et lui est confié :`, messageDe(err));
      return { sorte: 'confie', numero, ajoute, rendu: false };
    }
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
   * Confie maintenant, puis écrit `mba`, depuis l'état d'attente seulement. Sur un ajout refusé, un fil de test ou
   * une absence de numéro, rien n'est écrit : l'état d'attente est déjà visible. La réponse de Meta au `release` ne
   * dit rien (`{"messaging_product":"whatsapp"}`) : le balayage reste le filet.
   */
  const rendreMaintenant = async (tenantId: string, waId: string): Promise<void> => {
    // 🔴 Relu AVANT de confier : l'accusé attendu peut arriver après qu'un scénario a repris le fil (un test relancé
    // dans la foulée, un mot-clé). Confier d'abord mettait le contact sur la liste et rendait le fil à l'agent en
    // plein parcours, l'écriture gardée `only: ['app_human']` ne protégeant que notre colonne (relecture du 3/10).
    if ((await depot.getControlOwner(tenantId, waId)) !== 'app_human') return;
    if ((await confier(tenantId, waId, { automatique: true, faireDeLaPlace: true })).sorte !== 'confie') return;
    await depot.setControlOwner(tenantId, waId, 'mba', { par: CAUSES.finDeParcours, only: ['app_human'], effacerEscalade: true });
  };

  return {
    async prisEnEcrivant(tenantId, waId, par) {
      await depot.setControlOwner(tenantId, waId, 'app_human', { par });
    },

    async tenuParLApplication(tenantId, waId) {
      if (modeEffectif(await reglagesDe(tenantId)) !== 'application') return false;
      if ((await depot.getControlOwner(tenantId, waId)) !== 'app_workflow') return false;
      // `app_workflow` désigne AUSSI un parcours qui attend la réponse du contact : celui-là, une réponse par l'API le
      // coupe (elle prend le fil), comme avant ce mode ; sinon deux voix parleraient au client.
      return (await deps.parcours.findWaitingByWaId(tenantId, waId)) === null;
    },

    async enModeApplication(tenantId) {
      return modeEffectif(await reglagesDe(tenantId)) === 'application';
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
      // Éteint, ou allumé en veille (RC6) : le fil revient aux robots, et le prochain message relance le répondeur du mode.
      if (!leMbaRepond(await reglagesDe(tenantId))) {
        await depot.setControlOwner(tenantId, waId, 'app_workflow', { par, effacerEscalade: true });
        return 'app_workflow';
      }
      // Geste humain : un fil de test se confie aussi (règle 5).
      if ((await confier(tenantId, waId, { automatique: false, faireDeLaPlace: true })).sorte !== 'confie') return 'aucun_numero';
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

    async remettreSiPersonneNeSuit(tenantId, waId, contenu, entree) {
      const reglages = await reglagesDe(tenantId);
      const mode = modeEffectif(reglages);
      const fil = await depot.etatDuFil(tenantId, waId);
      const tenuParLEquipe = fil.owner === 'app_human';
      /**
       * Le fil reste à l'équipe. Si ce message vient de rouvrir la conversation (elle était « Traité » ou archivée),
       * c'est une nouvelle demande pour elle, que rien d'autre n'ouvrirait : aucun robot ne lui passe la main, elle
       * l'a déjà.
       */
      const laisserALEquipe = async (): Promise<void> => {
        if (tenuParLEquipe && entree.rouverte) await depot.ouvrirUneDemande(tenantId, waId, CAUSE_REOUVERTURE);
      };
      // Un fil de l'équipe ne lui est repris qu'une fois son délai écoulé : la règle même du balayage. En mode `equipe`,
      // jamais : il n'y a aucun robot à qui le rendre.
      const delai = delaiHumainMs(reglages.controlHandbackSeconds, deps.delaiRepriseParDefautMs);
      if (tenuParLEquipe && (mode === 'equipe' || !repriseDue(fil, delai))) return laisserALEquipe();
      // Donner à l'agent un fil qu'un parcours attend serait bien pire que le silence qu'on répare.
      if (await deps.parcours.findWaitingByWaId(tenantId, waId)) return laisserALEquipe();
      // 🔴 Le numéro bloqué (lot 4 : suspendu faute de paiement) : ni le répondeur, qui ne pourrait pas répondre et dont
      // le tour serait payé, ni l'agent de Meta, qui répondrait par Meta sur un numéro impayé. Comme sans numéro : rien
      // n'est écrit, le message reste dans l'Inbox.
      if (await deps.numeros.numeroBloque(tenantId)) return laisserALEquipe();
      /**
       * Un client que personne ne prendra attend l'équipe : `app_human` et une demande, comme un client que l'agent de
       * Meta n'a pas pu prendre. `only` exclut `app_human` : un opérateur qui a pris le fil entre-temps le garde, sans
       * seconde demande. `escalade` : la marque collante, quand c'est le MODE qui donne le fil à l'équipe (`equipe`, ou
       * le scénario déjà parti) ; le balayage ne le rendra pas aux robots avant qu'on ait répondu au client.
       */
      const aLEquipe = (par: AuteurDuChangement, escalade = false): Promise<boolean> =>
        depot.setControlOwner(tenantId, waId, 'app_human', { par, only: ['app_workflow', 'mba'], ouvreUneDemande: true, escalade });
      const muet = async (): Promise<boolean> =>
        (await deps.consentement.estDesabonne(tenantId, waId)) || (await deps.consentement.estBloque(tenantId, waId));
      /**
       * 🔴 Les gardes d'un robot de la console (agent IA, scénario), les MÊMES que vers l'agent de Meta : celles qui
       * précèdent, puis celles de `confier` sur un chemin automatique, dans leur ordre. `false` : le robot ne part pas,
       * et le fil reste où il est (une demande s'ouvre seulement sur une réouverture d'un fil de l'équipe).
       */
      const unRobotPeutPartir = async (): Promise<boolean> => {
        // Redélivré par Meta : le premier passage a démarré le robot, ou passé la main à l'équipe.
        if (entree.redelivre === true) return false;
        // Un pouce levé sur « votre rendez-vous est confirmé », ou son retrait, n'appelle pas de réponse : l'agent de
        // Meta, prévenu d'un texte vide, se tait (`prevenir`). Les robots de la console aussi, sans parcours ni tour.
        if (entree.reactionsSeules === true) return false;
        if (await depot.estConversationDeTest(tenantId, waId)) { await laisserALEquipe(); return false; }
        // Un contact désabonné ou bloqué n'est jamais confié à une machine : elle lui parlerait.
        if (await muet()) { await laisserALEquipe(); return false; }
        if (!(await deps.numeros.getTenantPhoneNumberId(tenantId))) { await laisserALEquipe(); return false; }
        return true;
      };
      /**
       * Le délai de l'équipe est écoulé : le fil revient aux robots d'abord, sinon le lancement (`sauf_operateur`) le
       * laisserait à l'équipe. Même garde que vers l'agent de Meta : pas si une escalade est venue entre-temps.
       */
      const reprendreALEquipe = async (): Promise<boolean> => !tenuParLEquipe || depot.setControlOwner(tenantId, waId, 'app_workflow', {
        par: CAUSES.apresLeDelai, only: ['app_human'], saufEscalade: true, effacerEscalade: true,
      });

      // 🔴 Chaque mode a sa branche, et le `default` refuse de compiler un mode qui n'en aurait pas : sans lui, un mode
      // ajouté tombait en silence dans la remise à l'agent de Meta qui suit (`case 'mba': break`).
      switch (mode) {
        case 'equipe': {
          // Rien pour une redélivrance, une réaction, ou un contact muet : un « STOP » n'ouvre pas de demande.
          if (entree.redelivre === true || entree.reactionsSeules === true || await muet()) return;
          // Une conversation de test n'entre pas dans « À traiter » : les autres modes l'écartent aussi (relecture de RC6).
          if (await depot.estConversationDeTest(tenantId, waId)) return;
          await aLEquipe(CAUSES.equipe, true);
          return;
        }
        case 'agent': {
          const agentId = reglages.repondeurAgentId;
          // Inatteignable (`modeEffectif` lit `equipe` un mode `agent` sans agent) : la ceinture du typage.
          if (agentId === null) return;
          if (!(await unRobotPeutPartir())) return;
          if (!(await reprendreALEquipe())) return laisserALEquipe();
          let demarrage: Awaited<ReturnType<DepsControleDuFil['repondeur']['demarrer']>>;
          try {
            demarrage = await deps.repondeur.demarrer(tenantId, waId, { agentId, messageDeclencheur: entree.messageDeclencheur ?? null });
          } catch (err) {
            await aLEquipe(CAUSES.repondeurIndisponible);
            throw err;
          }
          if (demarrage === 'parti') return;
          await aLEquipe(demarrage === 'credit_epuise' ? CAUSES.creditEpuise : CAUSES.repondeurIndisponible);
          return;
        }
        case 'scenario': {
          const workflowId = reglages.repondeurWorkflowId;
          if (workflowId === null) return;
          if (!(await unRobotPeutPartir())) return;
          /**
           * La réclamation AVANT la reprise du fil : dans le délai, le fil reste (ou va) à l'équipe sans avoir été
           * rendu aux robots un instant. Elle est atomique (`contacts.repondeur_scenario_le`, une instruction gardée) :
           * deux entrants simultanés, un seul départ. Un lancement refusé ensuite la consomme quand même : le contact
           * attend l'équipe jusqu'à la fin du délai, plutôt qu'une tentative ratée à chaque message.
           */
          let reclame: Awaited<ReturnType<DepsControleDuFil['repondeur']['reclamerScenario']>>;
          try {
            reclame = await deps.repondeur.reclamerScenario(tenantId, waId, { workflowId, delaiS: reglages.repondeurDelaiScenarioS });
          } catch (err) {
            await aLEquipe(CAUSES.repondeurIndisponible);
            throw err;
          }
          if (reclame !== 'reclame') {
            // Le fil de l'équipe lui reste ; sinon il lui va, avec la marque quand c'est le délai qui le veut.
            if (tenuParLEquipe) return laisserALEquipe();
            await aLEquipe(reclame === 'deja_parti' ? CAUSES.scenarioDejaParti : CAUSES.repondeurIndisponible, reclame === 'deja_parti');
            return;
          }
          if (!(await reprendreALEquipe())) return laisserALEquipe();
          let lance: Awaited<ReturnType<DepsControleDuFil['repondeur']['lancerScenario']>>;
          try {
            lance = await deps.repondeur.lancerScenario(tenantId, waId, { workflowId, messageDeclencheur: entree.messageDeclencheur ?? null });
          } catch (err) {
            await aLEquipe(CAUSES.repondeurIndisponible);
            throw err;
          }
          if (lance !== 'parti') await aLEquipe(CAUSES.repondeurIndisponible);
          return;
        }
        case 'application': {
          const adresseId = reglages.repondeurAdresseId;
          if (adresseId === null) return;
          if (!(await unRobotPeutPartir())) return;
          if (!(await reprendreALEquipe())) return laisserALEquipe();
          // Un fil resté à l'agent de Meta (sa reprise au changement de mode n'est faite qu'au mieux) revient aux robots :
          // sinon la réponse de l'application le prendrait, et le message suivant irait à l'équipe.
          await depot.setControlOwner(tenantId, waId, 'app_workflow', { par: CAUSES.agentDeMetaRemplace, only: ['mba'] });
          /**
           * Le fil reste tenu par les robots (`app_workflow`), hors d'« À traiter » : l'application répond par l'API, et
           * sa réponse ne prend pas le fil (`repondreDansLaFenetre`). Aucun repli si elle se tait (décision de Julien du
           * 2026-10-08). Une adresse qui ne PEUT pas recevoir (en pause, gelée par l'offre) : comme le mode « équipe ».
           */
          let demande: Awaited<ReturnType<DemandeALApplication['demander']>>;
          try {
            demande = await deps.application.demander(tenantId, waId, { adresseId, messageDeclencheur: entree.messageDeclencheur ?? null, contenu });
          } catch (err) {
            await aLEquipe(CAUSES.repondeurIndisponible);
            throw err;
          }
          if (demande === 'indisponible') await aLEquipe(CAUSES.equipe, true);
          return;
        }
        case 'mba':
          break;
        default: {
          const inconnu: never = mode;
          throw new Error(`mode du répondeur sans branche dans la remise : ${String(inconnu)}`);
        }
      }
      let issue: IssueConfier;
      try {
        issue = await confier(tenantId, waId, { automatique: true, faireDeLaPlace: true });
      } catch (err) {
        // L'agent ne répondra pas (un identifiant qui n'est pas un numéro est refusé à chaque ajout) : la
        // conversation passe, ou reste, à l'équipe. Laissée à `app_workflow`, elle sortirait d'« À traiter » sans
        // réponse.
        if (tenuParLEquipe) await laisserALEquipe();
        // Un client dont personne n'a pris le message attend l'équipe : c'est une demande du Quantitatif > Performance
        // (décision de Julien du 2026-09-30).
        else await depot.setControlOwner(tenantId, waId, 'app_human', { par: CAUSES.nonConfiee, only: ['app_workflow', 'mba'], ouvreUneDemande: true });
        throw err;
      }
      if (issue.sorte !== 'confie') return laisserALEquipe();
      // `app_workflow` : le défaut d'une conversation née d'un envoi sortant, hors « À traiter » et muette sans ce
      // geste. `mba` : notre colonne peut le dire quand Meta pense l'inverse, et l'appel répare. `app_human` : le délai
      // est écoulé, et l'écriture ne prend que si l'équipe tient encore le fil sans escalade venue entre-temps.
      const ecrit = await depot.setControlOwner(tenantId, waId, 'mba', tenuParLEquipe
        ? { par: CAUSES.apresLeDelai, only: ['app_human'], saufEscalade: true, effacerEscalade: true }
        : { par: CAUSES.personneNeSuit, only: ['app_workflow', 'mba'], effacerEscalade: true });
      const detenteur = fil.owner;
      /**
       * Déjà confiée (sur la liste, et `mba` chez nous) : on ne prévient l'agent que si ce geste vient de l'ajouter,
       * ou si Meta vient d'accepter le `release`, ce qui prouve que nous tenions le fil et que l'agent n'a pas vu ce
       * message (un `release` refusé plus tôt). Refusé, l'agent tient déjà le fil : c'est le cas d'une réponse
       * « à côté » transmise par la fin du scénario dans le même lot, et le prévenir le ferait répondre deux fois.
       * Colonne pas écrite depuis un autre détenteur : quelqu'un a pris le fil entre-temps, on ne lui parle pas dessus.
       */
      if (detenteur === 'mba' ? !(issue.ajoute || issue.rendu) : !ecrit) return;
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
      if ((await depot.getControlOwner(tenantId, waId)) === 'app_human') {
        // L'équipe tient déjà la conversation, et la réponse du client la lui garde : le délai de reprise repart d'ici,
        // sans quoi une vieille conversation au délai échu partirait aussitôt à l'agent de Meta par la remise du même
        // job (décision du 2026-09-30, relecture du même jour). Et le client attend l'équipe : une demande du KPI.
        await depot.relancerLeDelai(tenantId, waId);
        await depot.ouvrirUneDemande(tenantId, waId, cause);
        return true;
      }
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
          // Sans droit de faire de la place : ces fils sont inactifs depuis le délai de l'équipe, et les confier en
          // rafale ferait sortir de la liste ceux qui parlent à l'agent en ce moment. Le contact qui réécrit sera
          // confié par la remise, qui, elle, en a le droit.
          if ((await confier(tenantId, waId, { automatique: true, faireDeLaPlace: false })).sorte !== 'confie') return false;
        } catch (err) {
          // Liste pleine : un état normal du balayage, rejoué à chaque passage, qui ne mérite pas une erreur par fil.
          if (err instanceof ListePleine) return false;
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

    async envoyerAuMba(tenantId, waId, { contenu, cause }) {
      const par: AuteurDuChangement = { cause };
      // Le fil va à l'équipe : le parcours vient de finir (`app_workflow`), et un opérateur qui l'aurait pris le garde.
      // 🔴 AVEC la marque d'escalade : le scénario vient d'écrire (« je vous passe à notre assistant »), donc le dernier
      // message est SORTANT, et sans la marque la conversation n'entrerait pas dans « À traiter » (relecture de RC6).
      const aLEquipe = (): Promise<boolean> =>
        depot.setControlOwner(tenantId, waId, 'app_human', { par, only: ['app_workflow', 'mba'], ouvreUneDemande: true, escalade: true });
      let issue: IssueConfier;
      try {
        issue = await confier(tenantId, waId, { automatique: true, faireDeLaPlace: true });
      } catch (err) {
        journaliser('error', 'vers_mba_non_confie', { err, tenantId, waId });
        await aLEquipe();
        return 'non_confie';
      }
      if (issue.sorte === 'agent_eteint') {
        await depot.noterMbaIndisponible(tenantId, waId, cause);
        await aLEquipe();
        return 'mba_eteint';
      }
      if (issue.sorte !== 'confie') {
        await aLEquipe();
        return 'non_confie';
      }
      await depot.setControlOwner(tenantId, waId, 'mba', { par, only: ['app_workflow', 'mba'], effacerEscalade: true });
      // Le dernier message du contact, pour que l'agent y réponde tout de suite : c'est la promesse du bloc.
      await prevenir(tenantId, issue.numero, waId, contenu);
      return 'confie';
    },

    async reprendreLesFilsDeMeta(tenantId) {
      let repris = 0;
      let apres: string | null = null;
      for (;;) {
        const paquet: string[] = await depot.filsDeLAgentDeMeta(tenantId, apres, PAQUET_FILS_DE_META);
        for (const waId of paquet) {
          // `only` : un fil qu'un opérateur ou un scénario a pris entre la lecture et l'écriture reste à lui.
          if (await depot.setControlOwner(tenantId, waId, 'app_workflow', { par: CAUSES.agentDeMetaRemplace, only: ['mba'] })) repris += 1;
        }
        if (paquet.length < PAQUET_FILS_DE_META) return repris;
        apres = paquet[paquet.length - 1] ?? null;
      }
    },
  };
}
