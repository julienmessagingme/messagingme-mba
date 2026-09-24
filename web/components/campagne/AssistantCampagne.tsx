'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createCampaignDraft, deleteCampaignDraft, updateCampaignDraft,
  type BusinessHours, type CampaignDraft,
} from '@/lib/api';
import { brouillonDeLEtat, etatDeBrouillon } from '@/lib/campagne-brouillon';
import {
  chaineDeLaFormule,
  rangsSansContenu,
  DEBIT_DEFAUT,
  type CanalPremier,
  type EtageAssistant,
  type FormuleCanal,
  type TroisiemeNiveau,
} from '@/lib/campagne-chaine';
import { EtapeCanal } from '@/components/campagne/EtapeCanal';
import { EtapeContenu, contenuVide } from '@/components/campagne/EtapeContenu';
import { EtapeAudience } from '@/components/campagne/EtapeAudience';
import { EtapeRecap } from '@/components/campagne/EtapeRecap';
import { audienceInitiale, type AudienceChoix } from '@/lib/audience';
import type { CreatedTemplate } from '@/components/TemplateForm';
import type { RestaurationSelection } from '@/components/campagne/ListeDestinataires';
import type { VarRow } from '@/lib/variables-template';
import type { CarrouselRcs } from '@/lib/rcs-carrousel';
import type { CampaignCategory, PhoneNumber, RcsAgent, RcsMessage, RcsSuggestion, TagCount, TemplateSummary, UserFieldDef, WorkflowSummary } from '@/lib/api';

/**
 * L'ASSISTANT DE CRÉATION D'UNE CAMPAGNE : cinq étapes, une question par écran, retour libre.
 *
 * 🔴 IL EST LE SEUL CHEMIN DE CRÉATION DEPUIS LE 2026-09-13. L'ancien formulaire a été RETIRÉ ce
 * jour-là, après que la liste « ce qui manque encore » soit tombée à zéro : la liste est donc vide, et
 * elle n'est pas conservée vide, elle a disparu. Ce qui reste ci-dessous, ce sont les LIMITES connues du
 * produit, qui ne sont pas des capacités perdues.
 *
 * ⚠️ CE QUE PORTE CE COMPOSANT, ET RIEN DE PLUS : l'état de la campagne en cours d'écriture, son
 * brouillon, et la navigation. Chaque étape est un composant qui reçoit ce dont elle a besoin et rend ce
 * qu'elle change. C'est la leçon de l'ancien formulaire, 48 états dans un seul fichier, que l'audit du
 * 2026-08-31 a demandé de découper en prévenant dans la même phrase qu'« une extraction mécanique ne
 * réduit pas la complexité d'état » : on découpe par QUESTION POSÉE, pas par zone de rendu.
 *
 * 🔴 LE RETRAIT A ÉTÉ FAIT EN RÉUTILISANT, JAMAIS EN RECOPIANT, et c'est ce qui le rend sûr. Les six
 * capacités qui manquaient existaient déjà et fonctionnaient : l'aperçu est `TemplatePreview`, celui de
 * l'Inbox et de l'écran en service ; la création de modèle à la volée est `CreationModeleEnLigne`,
 * extraite telle quelle avec son suivi de la revue Meta ; le fil de l'eau est `SourceWebhook`, avec ses
 * deux avertissements ; le visuel RCS passe par `versMessageRcs`, `ChampImageHebergee` et
 * `ChampCorpsVariables`, que trois autres écrans utilisent déjà. L'ancien formulaire a PERDU 214 lignes
 * avant de disparaître : c'est l'inverse d'une duplication.
 *
 * ⚠️ LA LIMITE CONNUE, ET ELLE N'A JAMAIS ÉTÉ UNE CAPACITÉ DE L'ÉCRAN RETIRÉ : l'association des
 * variables d'un modèle sur un étage de REPLI. La campagne n'a qu'un `param_mapping`, `campaign_etages`
 * n'a pas de colonne pour un second, et `campaign_recipients.resolved_params` est résolu UNE fois à la
 * création depuis ce mapping unique. Un repli à variables est donc REFUSÉ au récapitulatif AVEC sa
 * raison, le rang 1 étant servi normalement. ⚠️ VÉRIFIÉ AVANT LE RETRAIT, pas supposé : le
 * constructeur de requête de l'ancien formulaire n'envoyait JAMAIS de `chaine`, il ne savait donc créer
 * qu'une campagne à UN étage. Retirer cet écran n'a pu retirer cette capacité, puisqu'il ne l'avait pas.
 *
 * ⚠️ UNE SECONDE DIFFÉRENCE, DÉLIBÉRÉE ET ANTÉRIEURE À CE LOT : l'écran retiré proposait de choisir le
 * NUMÉRO émetteur et l'AGENT RCS quand l'espace en compte plusieurs ; l'assistant prend le premier des
 * deux (cf. `ReferencesContenu`). C'est la décision « un assistant ne pose pas la question », et elle
 * reste discutable sur un espace multi-numéros : c'est le seul point de ce lot qui mériterait d'être
 * retranché si quelqu'un s'en plaint.
 */

/**
 * Délai avant qu'un changement de l'écran parte dans le brouillon.
 *
 * Assez court pour qu'un aller-retour dans un autre onglet ne perde rien, assez long pour que cocher dix
 * contacts ne fasse pas dix écritures : le plafond de débit des routes authentifiées est partagé avec
 * tout le reste de la console.
 */
const DELAI_SAUVEGARDE_MS = 1200;

/** Les cinq étapes, dans l'ordre décidé par Julien le 2026-09-12. */
export type EtapeAssistant = 'nom' | 'canal' | 'contenu' | 'audience' | 'recap';

/**
 * L'ÉTAT DE LA CAMPAGNE EN COURS D'ÉCRITURE.
 *
 * ⚠️ LA CHAÎNE N'EST PAS STOCKÉE, ELLE EST DÉRIVÉE (`chaineDeLaFormule`). Garder à la fois les choix de
 * l'écran et leur résultat, c'est se donner deux vérités à tenir d'accord à la main : revenir en arrière
 * pour passer de « avec repli » à « WhatsApp » laisserait une chaîne à deux étages que plus rien à
 * l'écran ne décrit.
 */
export interface EtatCampagne {
  nom: string;
  /**
   * À QUOI SERT LA CAMPAGNE, au sens de Meta.
   *
   * 🔴 ELLE N'A PAS DE DÉFAUT SILENCIEUX POSSIBLE DANS L'AUTRE SENS. `marketing` exige le consentement
   * (`buildRecipients` écarte les contacts sans opt-in), `utility` non : partir sur `utility` par défaut
   * enverrait du marketing à des gens qui ne l'ont pas accepté, sans que rien ne le signale. Le défaut est
   * donc le plus RESTRICTIF, et la question est posée quand même.
   */
  category: CampaignCategory;
  /**
   * LE CANAL, ET IL N'A PAS DE DÉFAUT : `null` = LA QUESTION N'A PAS ENCORE ÉTÉ POSÉE.
   *
   * 🔴 C'EST CE QUI PERMET DE POSER LA QUESTION SEULE (2026-09-14, demande de Julien) : « tu poses
   * d'abord la question du canal, avant de faire apparaître (ou pas) Réessayer les envois qui échouent ».
   * Une valeur par défaut rendrait ce parcours IMPOSSIBLE à tenir honnêtement : l'écran montrerait
   * « WhatsApp » coché tout en cachant la suite, c'est-à-dire un choix que personne n'a fait et dont on
   * masque pourtant les conséquences. Et sans clic, la campagne serait partie en WhatsApp.
   *
   * ⚠️ ELLE REND LA CHAÎNE VIDE, et le gardien de l'étape Canal s'appuie sur elle : on ne passe pas à
   * l'étape Contenu sans canal, sinon il n'y aurait aucun étage à remplir.
   */
  formule: FormuleCanal | null;
  premier: CanalPremier;
  troisieme: TroisiemeNiveau;
  /**
   * « Réessayer les envois qui échouent ». Ne vaut que sur un canal SEUL.
   *
   * ⚠️ SA VALEUR N'EST PAS SA CONSÉQUENCE : sur une chaîne de repli, l'écran ne pose plus la question et
   * `entreeDeCreation` envoie `false` quoi qu'il y ait ici. Ce champ garde donc le dernier choix de
   * l'opérateur pour le lui rendre s'il revient à un canal seul, au lieu de l'effacer sous ses pieds.
   */
  reessayer: boolean;
  /**
   * « N'envoyer que pendant les heures ouvrées » : LA SEULE QUESTION HORAIRE de l'étape Canal.
   *
   * 🔴 ELLE A REMPLACÉ TROIS « INTENTIONS DE CADENCE » QUI N'AVAIENT JAMAIS ÉTÉ DEMANDÉES (2026-09-12).
   * Elles venaient d'une recommandation écrite dans la spec et non validée, et retiraient au passage la
   * jauge de débit de l'ancien formulaire. Julien : « je veux juste une seule question : envoyer ou pas
   * hors des business hours. C'est tout ! et après on shoote au rythme du canon que le client choisit ».
   */
  heuresOuvrees: boolean;
  /**
   * LA JAUGE DE DÉBIT, en messages par minute (1..80), demandée à l'étape 5.
   *
   * ⚠️ ELLE VIT À LA FIN DU PARCOURS et non à l'étape du canal, parce que c'est là seulement que
   * l'audience est connue : une durée estimée sans nombre de destinataires ne veut rien dire.
   * Le plafond RÉEL reste résolu PAR CANAL côté serveur (`plafondDuCanal`) : une campagne RCS n'est pas
   * soumise au plafond de Meta, et ce chiffre-là ne se recopie pas dans l'écran.
   */
  debitParMinute: number;
  /**
   * Le contenu de chaque étage, PAR RANG.
   *
   * ⚠️ INDEXÉ PAR RANG, PAS PAR POSITION DANS UN TABLEAU. Changer l'ordre du repli (« RCS en premier »)
   * réécrit la chaîne : un tableau ferait glisser le contenu WhatsApp sur l'étage RCS sans que rien ne le
   * signale. Le rang est ce que la base stocke (`campaign_etages.rang`), c'est donc la bonne clé.
   */
  contenus: Record<number, ContenuEtage>;
  /**
   * La répartition, quand la conversation tombe dans l'Inbox.
   *
   * ⚠️ SA VALEUR N'EST PAS SA CONSÉQUENCE, exactement comme `reessayer` : quand tous les étages ouvrent
   * un scénario, l'écran ne pose plus la question et `entreeDeCreation` n'envoie RIEN, quoi qu'il y ait
   * ici (`devenirProposable`). Ce champ garde donc le dernier choix de l'opérateur pour le lui rendre
   * s'il revient à un modèle seul, au lieu de l'effacer sous ses pieds.
   */
  assignation: Assignation;
  /** La personne, quand `assignation` vaut `personne`. */
  assignationUserId: string | null;
  /** QUI reçoit (étape 4). */
  audience: AudienceChoix;
  /**
   * QUAND LA CAMPAGNE PART : tout de suite, ou à une date choisie (étape 5).
   *
   * ⚠️ CE N'EST PAS `heuresOuvrees`, ET LES DEUX SE CUMULENT. Celui-ci fixe le moment du DÉCLENCHEMENT,
   * l'autre borne les créneaux pendant lesquels l'envoi a le droit de courir. Une campagne programmée à
   * 22 h sur un espace fermé la nuit est bien déclenchée à 22 h, puis mise en pause jusqu'à l'ouverture.
   */
  quand: 'maintenant' | 'plus_tard';
  /** La date/heure du départ, en HEURE LOCALE (valeur brute d'un `<input type="datetime-local">`). */
  dateLocale: string;
}

/** Le contenu d'UN étage. Les champs inutiles au canal de l'étage restent absents. */
export interface ContenuEtage {
  /** `seul` = le contenu part tel quel ; `avec_scenario` = il ouvre un parcours. */
  formule: 'seul' | 'avec_scenario';
  /**
   * CE QUI SE PASSE QUAND LE CONTACT RÉPOND À CET ÉTAGE (migration 0144).
   *
   * 🔴 PAR ÉTAGE DEPUIS LE 2026-09-14, demandé par Julien : « si la personne dit Modèle + scénario, tu ne
   * fais pas apparaître cette question, et si elle choisit modèle tu fais apparaître la question, qui
   * s'appliquera alors QUE pour le WhatsApp ; et ensuite tu passes à l'étage 2 ». Une chaîne de repli peut
   * donc laisser l'agent de Meta répondre en WhatsApp et renvoyer le RCS à l'équipe.
   *
   * ⚠️ N'A DE SENS QUE POUR `formule: 'seul'`. Avec un scénario, c'est LUI qui décide qui répond, et la
   * question n'est pas posée : la valeur reste alors celle du dernier choix, pour la rendre à l'opérateur
   * s'il revient en arrière, mais elle n'est PAS envoyée (`entreeDeCreation`).
   */
  devenir: Devenir;
  templateName?: string;
  templateLanguage?: string;
  workflowId?: string;
  texteRcs?: string;
  /**
   * L'URL DU VISUEL D'UN ÉTAGE RCS. Vide ou absente = message TEXTE ; renseignée = message CARTE.
   *
   * 🔴 CE N'EST PAS UNE DÉCORATION, C'EST LE FORMAT DU MESSAGE. Avec un visuel, `versMessageRcs` bascule
   * en carte : l'image passe au-dessus du texte, les boutons deviennent des boutons PLEINE LARGEUR
   * empilés dans la carte (4 au plus, le surplus retombant en pastilles), et le plafond de texte descend
   * de 3 072 à 2 000 caractères. C'est la forme qu'on reconnaît des grandes campagnes RCS.
   */
  imageRcs?: string;
  /**
   * LE CARROUSEL CHOISI DANS LA BIBLIOTHÈQUE, COPIÉ EN ENTIER SUR L'ÉTAGE (spec du 2026-09-21).
   *
   * 🔴 PRÉSENT, C'EST LUI QUI PART, ET RIEN D'AUTRE. `texteRcs`, `imageRcs` et `suggestions` restent en mémoire
   * pour « Revenir à un message simple », mais ne partent pas : ce qu'on cache doit être exactement ce qu'on
   * n'envoie pas (`messageRcs`, `campagne-creation.ts`).
   *
   * ⚠️ UNE COPIE, JAMAIS UN LIEN, comme un message simple : modifier la bibliothèque ensuite ne réécrit pas une
   * campagne. Pour le changer, on le modifie dans Contenu > Messages RCS, puis on le choisit à nouveau.
   */
  carrouselRcs?: CarrouselRcs;
  suggestions: RcsSuggestion[];
  emailTemplateId?: string;
  /**
   * LA CLÉ DU CHAMP PERSO QUI PORTE L'ADRESSE E-MAIL DU CONTACT.
   *
   * 🔴 IL N'Y A AUCUNE CONVENTION DANS CE PRODUIT, ET C'EST UN FAIT VÉRIFIÉ : `contacts` n'a PAS de
   * colonne `email` (0001 et les `alter table contacts` qui ont suivi), l'adresse vit dans le jsonb
   * `fields` sous la clé que le client a créée. Le dépôt porte déjà la trace d'un espace qui l'appelait
   * « mail » quand un autre l'appelait « email » (`src/workflow/wiring.ts`, cas du 2026-08-25). La
   * deviner, c'est se tromper une fois sur deux EN SILENCE.
   */
  emailChamp?: string;
  /**
   * L'ASSOCIATION DES VARIABLES `{{n}}` DU MODÈLE DE CET ÉTAGE (ce qui devient `paramMapping`).
   *
   * 🔴 SANS ELLE, UN MODÈLE À VARIABLES FAIT REFUSER LA CAMPAGNE ENTIÈRE. Meta compare le nombre de
   * paramètres fournis à celui du modèle approuvé : zéro paramètre sur un modèle qui porte `{{1}}` est un
   * refus global, pas un destinataire sauté (`resolveHintParams`, `src/crm/template.ts`).
   *
   * ⚠️ ELLE EST PAR ÉTAGE, comme le reste du contenu, mais SEUL LE RANG 1 PART AUJOURD'HUI : la campagne
   * n'a qu'un `param_mapping`, et `campaign_etages` n'a pas de colonne pour en porter un second. Un étage
   * de repli sur un modèle à variables est donc REFUSÉ au récapitulatif, avec sa raison, plutôt que
   * enregistré puis refusé par Meta le jour où le repli part.
   */
  variables?: VarRow[];
  /**
   * LE MODÈLE PAR LEQUEL LE SCÉNARIO DE CET ÉTAGE OUVRE, quand la formule est « modèle et scénario ».
   *
   * 🔴 IL NE SORT JAMAIS DE L'ÉCRAN, ET C'EST VOLONTAIRE. Le serveur ne veut pas de modèle sur une
   * campagne de scénario (il écrit `template_name = ''`) : c'est le premier bloc du graphe qui dit ce qui
   * part. Mais ses variables, elles, voyagent dans `paramMapping` et sont passées telles quelles au
   * premier envoi. Il faut donc savoir COMBIEN il en porte, sans pour autant l'enregistrer.
   */
  modeleDuScenario?: { name: string; language: string };
  /**
   * PAR QUOI LE SCÉNARIO CHOISI OUVRE, lu dans la liste au moment du choix.
   *
   * 🔴 IL NE SORT PAS DE L'ÉCRAN NON PLUS. Il sert au récapitulatif à refuser, AVANT le clic, un scénario
   * qui ouvrirait sur un autre canal que celui de l'étage : une campagne dont l'ouverture ne correspond
   * pas est refusée ENTIÈREMENT par Meta, pas destinataire par destinataire.
   *
   * ⚠️ ABSENT = on ne sait pas (serveur plus ancien, ou brouillon d'avant ce champ). On ne refuse alors
   * rien sur cette base : c'est `modeleDuScenario` qui reste la garde, comme avant.
   */
  canalOuvertureDuScenario?: 'whatsapp' | 'rcs' | null;
}

/** Où va la conversation quand le contact répond. */
/**
 * Ce qui se passe quand le contact répond à un étage. DEUX valeurs, plus trois.
 *
 * 🔴 « UN AGENT IA PREND LA MAIN » A ÉTÉ RETIRÉ LE 2026-09-14, et ce n'est pas un renoncement : c'est un
 * fait d'architecture mesuré. `agent_sessions.run_id` est `NOT NULL` et référence `workflow_runs`, donc un
 * agent IA de ce produit ne sait pas exister hors d'un scénario. Julien : « si le user veut que ça aille
 * vers son autre agent IA, il faut qu'il fasse un scénario et qu'il utilise l'option modèle + scénario ».
 * L'option existait à l'écran et ne produisait AUCUN effet, en faisant pourtant choisir un agent précis.
 */
export type Devenir = 'mba' | 'inbox';
/** Comment la conversation se répartit, quand elle tombe dans l'Inbox. */
export type Assignation = 'aucune' | 'personne' | 'tour_de_role';

/** Un collaborateur de l'espace, tel que l'étape Contenu le propose pour l'affectation. */
export interface MembreAssistant {
  id: string;
  nom: string;
  /**
   * LE COMPTE N'A JAMAIS ÉTÉ ACTIVÉ : son invitation est en attente (`users.last_login_at is null`).
   *
   * 🔴 IL EST GRISÉ, PAS MASQUÉ, ET C'EST LE PREMIER RETOUR DE JULIEN SUR CET ÉCRAN (2026-09-12) : il
   * voyait UNE personne alors que son espace en compte trois. Le filtre silencieux faisait exactement ce
   * qu'il annonçait (assigner à quelqu'un qui ne peut pas se connecter range les conversations là où
   * personne ne les lira), mais le produit s'interdit ailleurs de masquer une option indisponible : un
   * canal non configuré est grisé AVEC SA RAISON. Ici l'empêchement est en plus LEVABLE par celui qui le
   * voit, il suffit que la personne accepte son invitation.
   *
   * ⚠️ UN COMPTE RÉVOQUÉ, LUI, RESTE MASQUÉ, et la différence n'est pas cosmétique : son empêchement
   * n'est pas levable par la personne qui le lit, et il ne redeviendra actif que si un administrateur le
   * décide. L'afficher grisé ferait grossir la liste de comptes qui ne reviendront pas.
   */
  enAttente: boolean;
}

/** Ce que l'étape Contenu propose à choisir. Chargé par l'écran, jamais par l'étape. */
export interface ReferencesContenu {
  templates: TemplateSummary[];
  workflows: WorkflowSummary[];
  emailTemplates: Array<{ id: string; name: string }>;
  membres: MembreAssistant[];
  agents: Array<{ id: string; label: string }>;
  /** Les tags de l'espace, pour cibler l'audience. */
  tags: TagCount[];
  /** Les champs perso, pour désigner celui qui porte l'adresse e-mail. */
  userFields: UserFieldDef[];
  /** Les numéros Meta de l'espace. Le premier sert d'expéditeur : un assistant ne pose pas la question. */
  numeros: PhoneNumber[];
  /** Les agents RCS de l'espace. Le premier sert de marque, même raison. */
  agentsRcs: RcsAgent[];
  /**
   * LES MESSAGES RCS ENREGISTRÉS de l'espace (Contenu > Messages RCS), pour partir de l'un d'eux.
   *
   * ⚠️ C'EST UNE COPIE QUI EST FAITE, PAS UN LIEN : la campagne garde le message tel qu'il était au
   * moment où on l'a repris. Modifier la bibliothèque ensuite ne doit pas réécrire une campagne déjà
   * partie, et c'est déjà la règle de l'écran en service.
   */
  messagesRcs: RcsMessage[];
}

export const REFERENCES_VIDES: ReferencesContenu = {
  templates: [], workflows: [], emailTemplates: [], membres: [], agents: [],
  tags: [], userFields: [], numeros: [], agentsRcs: [], messagesRcs: [],
};

export const ETAT_INITIAL: EtatCampagne = {
  nom: '',
  // 🔴 LE DÉFAUT LE PLUS RESTRICTIF : `marketing` exige le consentement, `utility` non.
  category: 'marketing',
  // 🔴 AUCUN CANAL CHOISI : la question se pose seule, et rien d'autre n'apparaît avant la réponse.
  formule: null,
  // ⚠️ CEUX-CI GARDENT LEUR DÉFAUT : ce sont des SOUS-questions du repli, elles n'apparaissent qu'une fois
  // « avec repli » choisi, donc leur valeur d'ouverture est vue au moment où elle commence à compter.
  premier: 'whatsapp',
  troisieme: 'aucun',
  // 🔴 COCHÉE PAR DÉFAUT : sans chaîne de repli, c'est le SEUL rattrapage disponible.
  reessayer: true,
  // ⚠️ Faux par défaut, c'est-à-dire « on envoie à toute heure » : le comportement d'aujourd'hui, et
  // celui de l'ancien formulaire. Cocher cette case sur un espace sans horaires ARRÊTE la campagne
  // pour toujours, l'étape Canal le dit au moment du clic.
  heuresOuvrees: false,
  debitParMinute: DEBIT_DEFAUT,
  contenus: {},
  /**
   * 🔴 DÉFAUT « INBOX », ET C'EST LE COMPORTEMENT D'AUJOURD'HUI. Une réponse à une campagne arrive dans
   * l'Inbox tant que personne n'a décidé autre chose. Prendre l'agent de Meta ou une IA par défaut
   * ferait répondre une machine à la place de l'équipe sans que quiconque l'ait choisi.
   */
  /** Sans assignation : la conversation arrive dans « À traiter », comme aujourd'hui. */
  assignation: 'aucune',
  assignationUserId: null,
  // ⚠️ « Tous les contacts » par défaut, et l'écran l'affiche COMPTÉ : un défaut qui ne se voit pas serait
  // le pire des deux, puisque c'est la sélection la plus large du produit. Cf. `audienceInitiale`.
  audience: audienceInitiale(),
  // ⚠️ « Maintenant » par défaut : c'est le geste courant, et c'était celui de l'ancien formulaire. Un
  // défaut « plus tard » obligerait à saisir une date pour la campagne qu'on veut envoyer tout de suite.
  quand: 'maintenant',
  dateLocale: '',
};

/** Ce que l'espace sait faire, lu une fois et passé aux étapes qui en dépendent. */
export interface CapacitesEspace {
  /** Un agent RCS est rattaché à l'espace. Faux = l'entrée RCS est grisée AVEC sa raison. */
  rcsEnabled: boolean;
  /**
   * L'agent de Meta est-il activé sur cet espace ? Faux = l'entrée est grisée AVEC sa raison.
   *
   * ⚠️ IL VIT ICI ET NON DANS `ReferencesContenu`, où il a passé une heure : ce n'est pas quelque chose
   * qu'on CHOISIT dans une liste, c'est ce que l'espace sait faire, exactement comme `rcsEnabled`. Deux
   * objets qui décrivent tous deux les capacités de l'espace, c'est la question « lequel des deux ? » à
   * chaque ajout suivant.
   */
  mbaEnabled: boolean;
  /**
   * Le connecteur HubSpot est-il branché sur cet espace ? Faux = la source HubSpot n'est pas AFFICHÉE.
   *
   * ⚠️ MASQUÉE ET NON GRISÉE, à l'inverse du RCS, et c'est une demande de Julien du 2026-08-26 reprise
   * telle quelle de l'ancien formulaire : un bouton grisé pour une intégration qu'on n'a pas est du
   * bruit, pas une information. La PAUSE, elle, se grise avec sa raison : elle se lève d'un clic.
   */
  hubspotListes: boolean;
  /** La synchronisation HubSpot est en pause (drapeau d'espace) : la source s'affiche, grisée. */
  hubspotEnPause: boolean;
  /** Les heures d'ouverture de l'espace, pour dire la vérité au moment où l'on coche. */
  businessHours?: BusinessHours;
}

const ORDRE: EtapeAssistant[] = ['nom', 'canal', 'contenu', 'audience', 'recap'];
const TITRES: Record<EtapeAssistant, string> = {
  nom: 'Nom',
  canal: 'Canal',
  contenu: 'Contenu',
  audience: 'Audience',
  recap: 'Récapitulatif',
};

export function AssistantCampagne({
  tenantId,
  capacites,
  references = REFERENCES_VIDES,
  etapeInitiale = 'nom',
  etatInitial,
  rechargerTemplates,
  rechargerScenarios,
  rechargerMessagesRcs,
  brouillon,
  onCree,
}: {
  tenantId: string;
  capacites: CapacitesEspace;
  /**
   * Relit la liste des modèles et rend la liste COMPLÈTE (statuts non approuvés compris).
   *
   * 🔴 ABSENTE, LA CRÉATION DE MODÈLE À LA VOLÉE N'EST PAS PROPOSÉE, et c'est délibéré : le panneau
   * promet de choisir le modèle dès son approbation par Meta, ce qui suppose de pouvoir relire la liste.
   * Afficher le bouton sans ce moyen offrirait un parcours qui s'arrête au milieu.
   */
  rechargerTemplates?: (silencieux?: boolean) => Promise<TemplateSummary[]>;
  /**
   * Relit la liste des scénarios. ABSENTE = « Créer un scénario » n'est pas proposé, même convention que
   * `rechargerTemplates` : sans relecture, un scénario neuf serait choisi sans figurer dans la liste, et
   * le sélecteur afficherait un vide sur un champ pourtant rempli.
   */
  rechargerScenarios?: () => Promise<WorkflowSummary[]>;
  /** Cf. `EtapeContenu.rechargerMessagesRcs`. Absente = pas de création de message RCS à la volée. */
  rechargerMessagesRcs?: () => Promise<RcsMessage[]>;
  /** Ce que l'étape Contenu propose à choisir. Absent = tout est vide, et chaque cas vide le DIT. */
  references?: ReferencesContenu;
  /** L'étape d'ouverture. Sert au retour sur un brouillon, et aux tests d'écran qui visent une étape. */
  etapeInitiale?: EtapeAssistant;
  etatInitial?: Partial<EtatCampagne>;
  /**
   * UN BROUILLON REPRIS. Son `state` est relu par `etatDeBrouillon`, qui sait lire les DEUX formats.
   *
   * 🔴 IL EST LU UNE SEULE FOIS, À L'INITIALISATION, et l'écran ne doit donc être monté qu'une fois le
   * brouillon chargé : arrivé plus tard, il ne serait jamais appliqué, et l'opérateur retrouverait un
   * écran vierge là où il attend son travail. C'est la page qui tient cette condition.
   */
  brouillon?: CampaignDraft;
  /** Appelé une fois la campagne créée ET lancée. Absent = l'écran se contente de le dire. */
  onCree?: (campaignId: string) => void;
}) {
  const [etat, setEtat] = useState<EtatCampagne>({
    ...ETAT_INITIAL,
    ...etatInitial,
    // ⚠️ LE BROUILLON PASSE APRÈS `etatInitial` : ce qu'on a réellement écrit l'emporte sur les valeurs
    // d'ouverture posées par l'adresse (`?canal=repli`), qui ne servent qu'à une création neuve.
    ...(brouillon ? { ...etatDeBrouillon(brouillon.state), nom: brouillon.name } : {}),
  });
  /**
   * ⚠️ LE BROUILLON PRIME SUR LE DÉFAUT, MAIS PAS SUR L'ADRESSE. Un `?etape=` explicite est une intention
   * de l'utilisateur (un lien partagé, un test d'écran) : la reprise automatique ne doit pas l'écraser.
   * Sans brouillon ni adresse, on repart du début, comme avant.
   */
  const [etape, setEtape] = useState<EtapeAssistant>(
    etapeInitiale !== 'nom' ? etapeInitiale : (brouillon?.state as { etape?: EtapeAssistant } | undefined)?.etape ?? 'nom',
  );
  /**
   * LE MODÈLE QU'ON VIENT DE SOUMETTRE À META, et qui passe en revue.
   *
   * 🔴 IL VIT DANS LA COQUILLE, PAS DANS LE CADRE QUI L'A CRÉÉ, et sa durée de vie EST la promesse de
   * l'écran : « on vérifie automatiquement et il sera sélectionné dès qu'il est approuvé ». Rangé dans le
   * cadre de l'étage, replier ce cadre ou passer à l'étape suivante l'effacerait, et la promesse
   * disparaîtrait sans un mot, ce qui est pire que de ne pas l'avoir faite.
   *
   * ⚠️ IL N'EST PAS DANS `EtatCampagne` : ce n'est pas la campagne, c'est l'état d'un écran. L'y mettre
   * l'enverrait dans le brouillon, où un statut Meta périmé n'a rien à faire.
   */
  const [modeleSoumis, setModeleSoumis] = useState<CreatedTemplate | null>(null);

  /**
   * LA SÉLECTION D'UN BROUILLON REPRIS, À APPLIQUER AU PREMIER CHARGEMENT DE LA LISTE ET À LUI SEUL.
   *
   * 🔴 SANS ELLE, REPRENDRE UN BROUILLON PERD SES DESTINATAIRES, ET C'EST LE DÉFAUT EXACT QUE JULIEN A
   * SIGNALÉ LE 2026-09-08 : « la campagne est enregistrée mais il faut à nouveau que je sélectionne les
   * personnes ». Le chargement de la liste RECOCHE tout par défaut, ce qui est le bon comportement quand
   * les filtres changent (on vient de désigner un autre ensemble) ; à la reprise, il tombe juste après la
   * restauration et l'efface.
   *
   * ⚠️ UNE `ref` ET NON UN ÉTAT : le chargement la CONSOMME (il la remet à `null`) et doit lire sa
   * valeur à l'instant même. La mettre dans les dépendances de l'effet le relancerait à chaque coche.
   *
   * 🔴 ET ELLE PORTE LES EXCLUSIONS, pas seulement la sélection. Perdre une sélection fait envoyer à
   * MOINS de monde ; perdre une exclusion fait envoyer à PLUS, c'est-à-dire viser quelqu'un que
   * l'opérateur avait explicitement retiré. Les deux ne se valent pas.
   */
  const selectionRestauree = useRef<RestaurationSelection | null>(
    brouillon
      ? { selected: new Set(etat.audience.selection.selected), exclus: new Set(etat.audience.selection.exclus) }
      : null,
  );

  /**
   * LE BROUILLON DE COMPOSITION : la campagne en cours d'écriture, enregistrée toute seule.
   *
   * 🔴 UNE `ref` ET NON UN ÉTAT POUR L'IDENTIFIANT. Un état React n'est visible qu'au rendu SUIVANT : deux
   * sauvegardes rapprochées le liraient toutes les deux à `null` et créeraient DEUX brouillons pour une
   * seule campagne. La ref porte la valeur à l'instant même.
   */
  const idBrouillon = useRef<string | null>(brouillon?.id ?? null);
  /** Sauvegarde en vol, pour ENCHAÎNER au lieu de doubler : même raison que la ref ci-dessus. */
  const sauvegardeEnVol = useRef<Promise<void> | null>(null);
  /**
   * 🔴 LE BROUILLON EST ABANDONNÉ : plus aucune sauvegarde, même déjà programmée. Sans cette marque, la
   * minuterie en vol rejouerait APRÈS la suppression : la campagne est lancée, le brouillon retiré, puis
   * une minuterie le RECRÉE, sans identifiant, donc en double dans la liste.
   */
  const abandonne = useRef(false);
  const [enregistre, setEnregistre] = useState(brouillon !== undefined);

  /**
   * ENREGISTRE : création au premier nom, mise à jour ensuite.
   *
   * ⚠️ SILENCIEUX EN CAS D'ÉCHEC, et c'est un choix : perdre un brouillon est ennuyeux, mais un bandeau
   * rouge au milieu de la saisie le serait davantage, et l'écran reste utilisable tel quel.
   */
  const enregistrerBrouillon = async (nom: string, etatCourant: EtatCampagne): Promise<void> => {
    if (nom === '' || abandonne.current) return;
    const corps = brouillonDeLEtat({ ...etatCourant, etape });
    // Sérialisé sur la sauvegarde précédente : sans cette file, deux écritures rapprochées partiraient en
    // parallèle, toutes deux sans identifiant, et créeraient deux brouillons pour une seule campagne.
    const suite = (sauvegardeEnVol.current ?? Promise.resolve()).then(async () => {
      try {
        if (idBrouillon.current === null) {
          const { draft } = await createCampaignDraft(tenantId, nom, corps);
          idBrouillon.current = draft.id;
        } else {
          await updateCampaignDraft(tenantId, idBrouillon.current, nom, corps);
        }
        setEnregistre(true);
      } catch { /* un brouillon qui ne s'enregistre pas ne doit pas interrompre la saisie */ }
    });
    sauvegardeEnVol.current = suite;
    await suite;
  };

  /**
   * 🔴 IL SUIT TOUT L'ÉCRAN, PAS SEULEMENT LE NOM, et c'est la leçon du 2026-09-08 sur l'ancien
   * formulaire. Julien : « la campagne est enregistrée mais il faut à nouveau que je sélectionne les
   * personnes ». La cause n'était pas seulement que les destinataires manquaient de l'état enregistré :
   * la sauvegarde ne partait QU'AU MOMENT où le champ du nom perdait le focus. Or le nom est la PREMIÈRE
   * chose qu'on tape : le brouillon photographiait donc un écran encore vide. Un seul déclencheur, placé
   * au début, ne peut capturer que le début.
   *
   * ⚠️ L'ÉTAT EST SÉRIALISÉ À CHAQUE RENDU plutôt que suivi champ par champ : une liste de dépendances
   * tenue à la main dériverait dès qu'on ajoute un réglage, et la sauvegarde cesserait de le suivre sans
   * que rien ne le signale. Le coût est une sérialisation par frappe, invisible devant le rendu lui-même.
   *
   * ⚠️ LE DÉLAI N'EST PAS DE LA COQUETTERIE : sans lui, cocher dix contacts ferait dix écritures, et le
   * plafond de débit des routes authentifiées est partagé avec tout le reste de la console.
   */
  // ⚠️ L'ÉTAPE ENTRE DANS LA SÉRIALISATION, donc changer d'écran déclenche une sauvegarde au même titre
  // qu'une frappe. C'est ce qui permet de retrouver sa place en revenant, sans ajouter de déclencheur.
  const serialise = JSON.stringify(brouillonDeLEtat({ ...etat, etape }));
  const nomEcrit = etat.nom.trim();
  useEffect(() => {
    if (nomEcrit === '' || abandonne.current) return;
    const minuterie = setTimeout(() => { void enregistrerBrouillon(nomEcrit, etat); }, DELAI_SAUVEGARDE_MS);
    return () => clearTimeout(minuterie);
    // `serialise` porte TOUT ce qui est enregistré : c'est la seule dépendance qui ne dérive pas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialise, nomEcrit]);

  /**
   * LA CAMPAGNE EXISTE : le brouillon n'a plus lieu d'être, sinon la liste montrerait les deux.
   *
   * ⚠️ LA MARQUE D'ABANDON EST POSÉE AVANT TOUTE ATTENTE, et l'ordre est ce qui la rend utile : une
   * minuterie déjà en vol recréerait le brouillon juste après sa suppression. On attend ensuite la
   * sauvegarde en cours, pour ne pas supprimer pendant une création qui le laisserait derrière soi.
   */
  const retirerBrouillon = async (): Promise<void> => {
    abandonne.current = true;
    await (sauvegardeEnVol.current ?? Promise.resolve());
    const id = idBrouillon.current;
    if (id === null) return;
    try {
      await deleteCampaignDraft(tenantId, id);
      idBrouillon.current = null;
      setEnregistre(false);
    } catch { /* un brouillon qui survit est visible et supprimable à la main */ }
  };

  const chaine: EtageAssistant[] = useMemo(
    // ⚠️ SANS CANAL, AUCUN ÉTAGE, et surtout pas un étage par défaut : tout ce qui se dérive de la chaîne
    // (les cadres de contenu, le réessai, le récapitulatif) doit rester muet tant que la question n'a pas
    // reçu sa réponse. Le gardien de l'étape Canal interdit d'aller plus loin dans cet état.
    () => (etat.formule === null
      ? []
      : chaineDeLaFormule({ formule: etat.formule, premier: etat.premier, troisieme: etat.troisieme })),
    [etat.formule, etat.premier, etat.troisieme],
  );

  const rang = ORDRE.indexOf(etape);
  /**
   * LES RANGS DONT LE CONTENU MANQUE. Vide = l'étape Contenu est franchissable.
   *
   * 🔴 CE GARDIEN NE CONTRÔLAIT QUE LE NOM, ET C'EST CE QUI A LAISSÉ PASSER UNE CAMPAGNE SANS MODÈLE
   * (2026-09-13, essai réel de Julien : « j'ai pu avancer sans mettre de contenu »). Le commentaire
   * qu'il portait affirmait que « les autres étapes portent leurs conditions, là où elles savent ce qui
   * manque » : c'était vrai du récapitulatif, qui refuse bien, et faux de l'étape Contenu, qui ne
   * refusait rien. Une justification à moitié vraie est plus dangereuse qu'aucune, parce qu'elle a l'air
   * vérifiée et qu'on ne la relit plus. L'étape Contenu SAIT ce qui manque : elle le dit maintenant, au
   * moment où l'on peut encore le corriger, et non trois écrans plus loin.
   */
  const rangsIncomplets = useMemo(() => rangsSansContenu(chaine, etat.contenus), [chaine, etat.contenus]);
  /**
   * LE GARDIEN DE CHAQUE ÉTAPE.
   *
   * 🔴 L'ÉTAPE CANAL EN A UN DEPUIS LE 2026-09-14, et il vient avec le retrait du canal par défaut :
   * sans lui, « Suivant » emmènerait à l'étape Contenu avec une chaîne VIDE, donc un écran sans aucun
   * cadre à remplir, et `rangsSansContenu([])` rendrait la liste vide, c'est-à-dire « rien ne manque ».
   * Le parcours entier se serait laissé traverser jusqu'au récapitulatif.
   */
  const peutAvancer = etape === 'nom'
    ? etat.nom.trim() !== ''
    : etape === 'canal'
      ? etat.formule !== null
      : etape !== 'contenu' || rangsIncomplets.length === 0;

  const modifier = (patch: Partial<EtatCampagne>): void => setEtat((e) => ({ ...e, ...patch }));

  /**
   * MODIFIER LE CONTENU D'UN ÉTAGE, SUR L'ÉTAT COURANT ET NON SUR CELUI DU RENDU.
   *
   * 🔴 ELLE EXISTE PARCE QUE DEUX ÉCRITURES DE SUITE EN PERDAIENT UNE. L'étape Contenu fabriquait son
   * patch en relisant `etat.contenus`, c'est-à-dire la valeur CAPTURÉE au rendu : choisir un modèle écrit
   * son nom, puis ses variables, et la seconde écriture repartait d'un `contenus` où le nom n'était pas
   * encore. Le modèle disparaissait. Le cas asynchrone était pire : les indices d'un modèle reviennent du
   * réseau avec la fermeture d'un rendu périmé, donc ils effaçaient le choix fait entre-temps.
   *
   * ⚠️ LA FORME FONCTIONNELLE EST LA SEULE QUI TIENNE : `setEtat(e => ...)` reçoit l'état COURANT, jamais
   * celui du rendu. Un `modifier({ contenus })` calculé au-dehors a exactement le défaut qu'on ferme ici.
   */
  const modifierContenu = (rang: number, patch: Partial<ContenuEtage>): void => setEtat((e) => ({
    ...e,
    contenus: { ...e.contenus, [rang]: { ...(e.contenus[rang] ?? contenuVide(capacites.mbaEnabled)), ...patch } },
  }));

  /**
   * MODIFIER L'AUDIENCE, SUR L'ÉTAT COURANT ET NON SUR CELUI DU RENDU.
   *
   * 🔴 MÊME RAISON QUE `modifierContenu` JUSTE AU-DESSUS, ET LE MÊME DÉFAUT ÉTAIT ARMÉ ICI. L'étape
   * Audience fabriquait son patch en relisant `etat.audience`, c'est-à-dire la valeur CAPTURÉE au rendu.
   * Une écriture ASYNCHRONE y suffit à tout perdre : le panneau du fil de l'eau efface une adresse morte
   * quand la liste des adresses revient du réseau, avec la fermeture d'un rendu périmé, donc il
   * remettrait au passage les filtres et les coches d'AVANT. Perdre une sélection de destinataires est
   * précisément le travail le plus long du parcours.
   */
  const modifierAudience = (patch: Partial<AudienceChoix>): void =>
    setEtat((e) => ({ ...e, audience: { ...e.audience, ...patch } }));

  return (
    // ⚠️ UNE SEULE COLONNE, BORNÉE. L'écran de référence est un 13 pouces (1280 x 800) moins la barre
    // latérale de 240 px et les marges de la coquille, soit environ 990 px utiles. Une colonne bornée à
    // 768 px y tient sans jamais dépendre de la largeur réelle de la fenêtre, et les blocs s'empilent :
    // rien ne peut se retrouver côte à côte sous un seuil, donc rien ne peut se chevaucher.
    <div className="mx-auto w-full max-w-3xl" data-testid="assistant-campagne">
      <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-400" data-testid="assistant-etapes">
        {ORDRE.map((e, i) => (
          <li key={e} className={i === rang ? 'font-semibold text-brand-600' : ''}>
            {i > 0 && <span className="mr-2 text-ink-300">/</span>}
            {TITRES[e]}
          </li>
        ))}
      </ol>

      {etape === 'nom' && (
        <section data-testid="etape-nom">
          <h2 className="text-lg font-semibold text-ink-800">Nom de la campagne</h2>
          {/* ⚠️ Rien d'autre sur cet écran : c'est la décision d'ordre du 2026-09-12, une question par
              écran, et celle-ci est obligatoire avant tout le reste. */}
          <label className="mt-4 block text-sm text-ink-700">
            <span className="block font-medium">Nom de la campagne</span>
            <input
              type="text"
              value={etat.nom}
              onChange={(ev) => modifier({ nom: ev.target.value })}
              data-testid="assistant-nom"
              className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
          </label>
          <p className="mt-2 text-xs text-ink-400">Il n&apos;est visible que de votre équipe.</p>
          {/* ⚠️ LE DIRE, ET SEULEMENT UNE FOIS QUE C'EST VRAI : le bandeau n'apparaît qu'après une
              écriture réussie, sinon il promettrait une reprise que l'échec silencieux n'offrirait pas. */}
          {enregistre && (
            <p className="mt-1 text-xs text-ink-400" data-testid="brouillon-enregistre">
              Brouillon enregistré : vous pouvez quitter cet écran et reprendre plus tard.
            </p>
          )}

          {/*
            🔴 LA CATÉGORIE EST POSÉE ICI PARCE QU'ELLE GOUVERNE LE CONSENTEMENT, PAS LE CONTENU. Une
            campagne `marketing` écarte à la création tout contact sans opt-in (`buildRecipients`), une
            campagne `utility` non. Elle ne peut donc pas être devinée depuis le message, et la poser à
            l'étape du contenu la ferait passer pour un détail de rédaction.
          */}
          <fieldset className="mt-6 w-full rounded-xl border border-ink-200 p-4" data-testid="choix-categorie">
            <legend className="px-1 text-sm font-medium text-ink-700">Nature de la campagne</legend>
            <div className="space-y-2">
              <RadioSimple
                groupe="categorie"
                libelle="Marketing"
                coche={etat.category === 'marketing'}
                onCheck={() => modifier({ category: 'marketing' })}
              />
              <RadioSimple
                groupe="categorie"
                libelle="Service (information liée à une commande, un rendez-vous, un compte)"
                coche={etat.category === 'utility'}
                onCheck={() => modifier({ category: 'utility' })}
              />
            </div>
            <p className="mt-2 text-xs text-ink-500">
              {etat.category === 'marketing'
                ? 'Seuls les contacts qui ont accepté le marketing seront retenus.'
                : 'Une campagne de service ne demande pas de consentement marketing : ne l’utilisez pas pour une promotion.'}
            </p>
          </fieldset>
        </section>
      )}

      {etape === 'canal' && (
        <EtapeCanal
          etat={etat}
          chaine={chaine}
          capacites={capacites}
          onChange={modifier}
        />
      )}

      {etape === 'contenu' && (
        <EtapeContenu
          tenantId={tenantId}
          etat={etat}
          chaine={chaine}
          references={references}
          capacites={capacites}
          /**
           * 🔴 `null` TANT QUE L'AUDIENCE N'EST PAS CHOISIE, et ce n'est pas un câblage manquant : elle
           * est demandée à l'étape SUIVANTE. L'étape Contenu ne peut donc pas afficher un compte, et
           * l'écran le dit plutôt que d'en inventer un.
           */
          nbDestinataires={null}
          /**
           * 🔴 CE QUI MANQUE, TRANSMIS À L'ÉTAPE, parce qu'elle en fait DEUX choses : masquer la question
           * du devenir de la conversation tant qu'un étage reste vide (demande de Julien du 2026-09-13,
           * ÉLARGIE le 2026-09-14 de l'étage 1 à TOUS les étages : « d'abord se concentrer sur le
           * contenu, étage 1, étage 2 si campagne avec fallback ; ne pas faire apparaître de suite la
           * question »), et nommer les étages à remplir. La même liste sert au gardien du bouton : une
           * seconde règle écrite ici aurait pu dire l'inverse de celle qui bloque.
           */
          rangsIncomplets={rangsIncomplets}
          onChange={modifier}
          onContenu={modifierContenu}
          {...(rechargerTemplates ? { rechargerTemplates } : {})}
          {...(rechargerScenarios ? { rechargerScenarios } : {})}
          {...(rechargerMessagesRcs ? { rechargerMessagesRcs } : {})}
          modeleSoumis={modeleSoumis}
          onModeleSoumis={setModeleSoumis}
        />
      )}

      {etape === 'audience' && (
        <EtapeAudience
          tenantId={tenantId}
          etat={etat}
          references={references}
          capacites={capacites}
          restauration={selectionRestauree}
          onAudience={modifierAudience}
        />
      )}

      {etape === 'recap' && (
        <EtapeRecap
          tenantId={tenantId}
          etat={etat}
          chaine={chaine}
          references={references}
          aller={setEtape}
          onChange={modifier}
          /**
           * ⚠️ LE BROUILLON PART AVANT LA SUITE : la campagne existe désormais pour de bon, et laisser
           * son brouillon derrière ferait apparaître les deux dans la liste, dont un qu'on croirait
           * encore à finir. `retirerBrouillon` est best-effort et n'interrompt donc jamais l'accusé de
           * réception du lancement.
           */
          onCree={(id) => { void retirerBrouillon(); onCree?.(id); }}
        />
      )}

      <div className="mt-8 flex items-center gap-2 border-t border-ink-100 pt-4">
        {rang > 0 && (
          <button
            type="button"
            onClick={() => setEtape(ORDRE[rang - 1]!)}
            className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            Retour
          </button>
        )}
        {rang < ORDRE.length - 1 && (
          <button
            type="button"
            disabled={!peutAvancer}
            onClick={() => setEtape(ORDRE[rang + 1]!)}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Suivant
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Un radio dont le NOM ACCESSIBLE est exactement son libellé.
 *
 * ⚠️ Même invariant que dans les étapes Canal et Contenu : rien d'autre que le libellé n'entre dans le
 * `<label>`, sinon aucune requête par rôle ne peut désigner la commande sans réciter sa phrase entière.
 */
function RadioSimple({
  groupe, libelle, coche, onCheck,
}: { groupe: string; libelle: string; coche: boolean; onCheck: () => void }) {
  return (
    <label className="flex w-full items-center gap-2 text-sm text-ink-800">
      <input
        type="radio"
        name={groupe}
        checked={coche}
        onChange={onCheck}
        className="h-4 w-4 shrink-0 accent-brand-500"
      />
      <span className="min-w-0 break-words">{libelle}</span>
    </label>
  );
}
