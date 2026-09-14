import type { CreateCampaignInput, EtageCreation } from './api/campagnes';
import type { CampaignCategory } from './api/campagnes';
import type { ContactFilters } from './contact-filters';
import { cibleDeCreation, type SelectionDestinataires } from './audience';
import type { RcsOutbound, RcsSuggestion } from './rcs-types';
import { maxTexteRcs, versMessageRcs } from './rcs';
import { boutonPret } from './rcs-boutons';
import type { EtageAssistant } from './campagne-chaine';
import { RANG_INITIAL, assignationProposable, debitBorne, reessaiProposable } from './campagne-chaine';
import { problemeDAssociation, versParamMapping, type VarRow } from './variables-template';
import { varCountOf } from './fields';

/**
 * CE QUE L'ASSISTANT ENVOIE AU SERVEUR, en fonction PURE.
 *
 * 🔴 C'EST LA DERNIÈRE TRADUCTION AVANT DES MESSAGES RÉELS, et c'est pour ça qu'elle vit ici et pas dans
 * le bouton. Un écran de récapitulatif se relit à l'œil ; ce qui décide de ce qui PART, c'est cet objet.
 * Le tester coûte quelques millisecondes, et le seul autre moyen de l'éprouver serait un e2e qui monte un
 * serveur Next pour lire un corps de requête.
 *
 * 🔴 LE PREMIER ÉTAGE EST LA CAMPAGNE ELLE-MÊME. `channel`, `templateName`, `rcsMessage` et `workflowId`
 * décrivent le rang 1, et le serveur REFUSE en 422 une chaîne dont le premier étage contredit `channel`
 * (`problemeDeChaine`, `src/campaign/etages.ts`). Les recopier depuis deux endroits différents serait se
 * donner rendez-vous avec ce refus.
 */

/** L'état de l'assistant, réduit à ce dont la création a besoin. Structurel : la lib n'importe aucun `.tsx`. */
export interface EtatPourCreation {
  nom: string;
  category: CampaignCategory;
  /** La jauge de l'étape 5, en messages par minute (1..80). Cf. `DEBIT_DEFAUT`. */
  debitParMinute: number;
  /**
   * « Envoyer uniquement pendant les heures ouvrées » : la SEULE question horaire de l'étape Canal.
   *
   * ⚠️ MÊME NOM, MÊME SENS ET MÊME DÉFAUT QUE DANS L'ANCIEN FORMULAIRE : la question posée à l'opérateur
   * doit se traduire par la même colonne (`campaigns.business_hours_only`, migration 0122), quel que soit
   * l'écran qui l'a posée. Faux par défaut, c'est-à-dire « on envoie à toute heure », le comportement
   * d'aujourd'hui.
   */
  heuresOuvrees: boolean;
  reessayer: boolean;
  /**
   * QUAND LA CAMPAGNE PART : tout de suite, ou à une date choisie.
   *
   * 🔴 CE N'EST PAS `businessHoursOnly`, ET LES DEUX SE CUMULENT. Celui-ci fixe le moment du
   * DÉCLENCHEMENT, celui-là borne les créneaux pendant lesquels l'envoi a le droit de courir : une
   * campagne programmée à 22 h sur un espace fermé la nuit est créée, déclenchée, puis mise en pause
   * jusqu'à l'ouverture. Les confondre ferait disparaître l'une des deux questions.
   */
  quand: 'maintenant' | 'plus_tard';
  /**
   * LA DATE ET L'HEURE CHOISIES POUR « PLUS TARD », en HEURE LOCALE, telles qu'un `<input
   * type="datetime-local">` les rend (`2026-09-20T10:00`, sans fuseau).
   *
   * ⚠️ ELLE EST CONVERTIE EN ISO ABSOLU AU DERNIER MOMENT (`momentDuLancement`) et jamais stockée
   * convertie : `new Date('2026-09-20T10:00')` est interprétée en heure LOCALE par le navigateur, ce qui
   * est bien ce que l'opérateur a saisi. La convertir plus tôt figerait le fuseau de l'instant où l'on a
   * tapé, et un brouillon repris ailleurs partirait à une autre heure.
   */
  dateLocale: string;
  assignation: 'aucune' | 'personne' | 'tour_de_role';
  assignationUserId: string | null;
  contenus: Record<number, {
    formule: 'seul' | 'avec_scenario';
    templateName?: string;
    templateLanguage?: string;
    workflowId?: string;
    texteRcs?: string;
    /** L'URL du VISUEL d'un étage RCS. Renseignée = le message part en CARTE. Cf. `ContenuEtage.imageRcs`. */
    imageRcs?: string;
    suggestions: RcsSuggestion[];
    emailTemplateId?: string;
    /** L'association des variables du modèle de cet étage. Cf. `ContenuEtage.variables`. */
    variables?: VarRow[];
    /** Le modèle par lequel le scénario de cet étage ouvre. Cf. `ContenuEtage.modeleDuScenario`. */
    modeleDuScenario?: { name: string; language: string };
    /** Par quoi le scénario de cet étage ouvre. Cf. `ContenuEtage.canalOuvertureDuScenario`. */
    canalOuvertureDuScenario?: 'whatsapp' | 'rcs' | null;
    /** Cf. `ContenuEtage.devenir`. N'est envoyé que pour un étage SANS scénario. */
    devenir?: 'mba' | 'inbox';
  }>;
}

/**
 * LE MODÈLE DONT UN ÉTAGE ASSOCIE LES VARIABLES, ou `null`.
 *
 * 🔴 DEUX LECTEURS, UNE SEULE RÈGLE, et c'est pour ça qu'elle est ici et pas dans le composant :
 * l'étape Contenu s'en sert pour savoir COMBIEN de lignes afficher, le récapitulatif pour savoir combien
 * il en attend. Si l'un prenait `templateName` quand l'autre prend le modèle du scénario, l'écran
 * montrerait une liste que la garde jugerait incomplète, sans que rien ne l'explique.
 *
 * ⚠️ EN FORMULE « SCÉNARIO », CE N'EST PAS LE MODÈLE DU SÉLECTEUR. La campagne n'envoie pas ce modèle-là :
 * elle démarre un parcours, dont le PREMIER bloc envoie un modèle, et ce sont les variables de celui-ci
 * que `paramMapping` doit couvrir.
 */
export function modeleDeLEtage(
  contenu: EtatPourCreation['contenus'][number] | undefined,
): { name: string } | null {
  if (!contenu) return null;
  if (contenu.formule === 'avec_scenario') return contenu.modeleDuScenario ?? null;
  return contenu.templateName ? { name: contenu.templateName } : null;
}

/**
 * LE NOMBRE DE VARIABLES DU MODÈLE DE CHAQUE ÉTAGE WHATSAPP, PAR RANG.
 *
 * ⚠️ UN RANG DONT LE MODÈLE EST INTROUVABLE N'ENTRE PAS DANS LA TABLE, il n'y entre pas à zéro : « on ne
 * sait pas » et « il n'en a pas » appellent des décisions opposées côté garde. Cf. `variablesDuModele`
 * dans `ContexteDeCreation`.
 */
export function variablesParRang(
  chaine: EtageAssistant[],
  contenus: EtatPourCreation['contenus'],
  modeles: ReadonlyArray<{ name: string; body?: string }>,
): Record<number, number> {
  const table: Record<number, number> = {};
  for (const etage of chaine) {
    if (etage.canal !== 'whatsapp') continue;
    const modele = modeleDeLEtage(contenus[etage.rang]);
    if (!modele) continue;
    const tpl = modeles.find((m) => m.name === modele.name);
    if (!tpl) continue;
    table[etage.rang] = varCountOf(tpl.body);
  }
  return table;
}

/** Ce que l'assistant ne porte pas lui-même : le numéro, l'agent RCS, et les filtres de l'audience. */
export interface ContexteDeCreation {
  phoneNumberId: string;
  rcsAgentId: string | null;
  filtres: ContactFilters;
  /**
   * La CLÉ du champ perso qui porte l'adresse e-mail, telle que l'écran l'a résolue
   * (`champEmailEffectif`). `null` = aucune, et un étage e-mail est alors refusé AVANT l'appel.
   *
   * ⚠️ ELLE ARRIVE PAR LE CONTEXTE ET NON PAR `contenus`, parce qu'elle est le résultat d'une RÉSOLUTION
   * (choix explicite, sinon suggestion) qui doit se faire à UN seul endroit. La recalculer ici en
   * donnerait un second exemplaire, et l'écran pourrait afficher un champ pendant qu'on en envoie un
   * autre.
   */
  champEmail: string | null;
  /**
   * L'ADRESSE QUI AMÈNERA LES DESTINATAIRES AU FIL DE L'EAU, ou `null` pour une campagne sur LISTE.
   *
   * 🔴 TROIS VALEURS, TROIS SENS, ET LA DISTINCTION DÉCIDE DE CE QUI PART. `null` = ce n'est pas une
   * campagne au fil de l'eau, on regarde les filtres et les coches ; une chaîne VIDE = c'en est une, et
   * son adresse n'est pas encore choisie, donc le lancement est refusé ; une chaîne renseignée = c'en
   * est une, et la requête n'emporte QUE cette adresse. Le serveur refuse de recevoir à la fois une
   * adresse et une liste, et il a raison : ce serait laisser croire que la liste va partir.
   *
   * ⚠️ L'APPELANT LA MET À `null` DÈS QUE LA SOURCE N'EST PAS `webhook` (`auFilDeLEau`), même si une
   * adresse traîne encore dans l'état d'un aller-retour précédent. C'est le seul endroit où cet
   * arbitrage se fait.
   */
  webhookId: string | null;
  /**
   * CE QUI A ÉTÉ COCHÉ DANS L'ÉTAPE AUDIENCE.
   *
   * ⚠️ ELLE ARRIVE PAR LE CONTEXTE, À CÔTÉ DE `filtres`, parce que les deux ne se comprennent QUE
   * ensemble : `toutFiltre` vise ce que les filtres décrivent moins les exclusions, son contraire vise
   * une liste. Les séparer ferait envoyer les filtres d'une sélection qu'on n'a pas faite.
   */
  selection: SelectionDestinataires;
  /**
   * LE NOMBRE DE VARIABLES `{{n}}` DU MODÈLE DE CHAQUE ÉTAGE, PAR RANG.
   *
   * 🔴 IL VIENT DE L'ÉCRAN PARCE QU'IL VIENT DU CORPS DU MODÈLE, que cette lib ne connaît pas. Le
   * recalculer ici demanderait la liste des modèles de l'espace, plus la résolution du modèle par lequel
   * un scénario ouvre : deux lectures que l'étape Contenu a déjà faites, et qui divergeraient.
   *
   * ⚠️ UN RANG ABSENT VEUT DIRE « MODÈLE INCONNU », JAMAIS « ZÉRO VARIABLE ». Un modèle qu'on n'a pas su
   * lire (liste non chargée, graphe de scénario illisible) ne doit pas faire croire qu'il n'a rien à
   * associer : la garde se tait et laisse le serveur, puis Meta, trancher. Compter zéro à sa place aurait
   * exactement l'effet qu'on cherche à empêcher, un `paramMapping` vide envoyé sans un mot.
   */
  variablesDuModele: Record<number, number>;
}

/**
 * LE MOMENT DU LANCEMENT : maintenant, à une date, ou un refus.
 *
 * 🔴 UNE SEULE FONCTION POUR LES DEUX QUESTIONS, ET C'EST DÉLIBÉRÉ. Séparer « est-ce valide ? » de
 * « quelle date envoyer ? » laisse exister un état où la première dit oui et la seconde rend `undefined` :
 * `runCampaign` sans date LANCE IMMÉDIATEMENT, donc une campagne programmée pour la semaine prochaine
 * partirait sur-le-champ, à des gens réels, sans que rien ne le signale. Une union fermée rend ce
 * chemin-là impossible à écrire.
 *
 * 🔴 STRICTEMENT DANS LE FUTUR, et l'horloge est INJECTÉE. Une date passée est refusée plutôt que
 * silencieusement ramenée à maintenant, parce que les deux gestes n'ont pas le même coût : « je me suis
 * trompé d'un jour » doit se corriger, pas s'envoyer. L'horloge en paramètre est ce qui rend la règle
 * exerçable sans dépendre de l'heure de la machine qui exécute le test.
 *
 * ⚠️ `new Date('2026-09-20T10:00')` EST LUE EN HEURE LOCALE par le moteur (forme date-heure sans
 * décalage), et c'est bien ce que l'opérateur a tapé dans son `<input type="datetime-local">`. Le `toISOString`
 * qui suit donne l'instant ABSOLU, seul format que le serveur accepte.
 */
export type MomentDuLancement =
  | { maintenant: true }
  | { iso: string }
  | { probleme: string };

export function momentDuLancement(
  etat: Pick<EtatPourCreation, 'quand' | 'dateLocale'>,
  maintenant: number,
): MomentDuLancement {
  if (etat.quand !== 'plus_tard') return { maintenant: true };
  if (etat.dateLocale.trim() === '') return { probleme: 'Choisissez la date et l’heure du départ.' };
  const t = new Date(etat.dateLocale).getTime();
  if (Number.isNaN(t)) return { probleme: 'Cette date n’est pas lisible : choisissez-la dans le sélecteur.' };
  if (t <= maintenant) return { probleme: 'La date du départ doit être dans le futur.' };
  return { iso: new Date(t).toISOString() };
}

/**
 * CE QUI EMPÊCHE DE LANCER, en français, ou `null`.
 *
 * ⚠️ ELLE NE REFAIT PAS LE TRAVAIL DU SERVEUR, elle évite un aller-retour sur ce que l'écran sait déjà.
 * Le serveur reste l'autorité : c'est lui qui refuse un template inconnu, une chaîne mal formée ou une
 * audience vide, et ses refus s'affichent tels quels.
 */
export function problemeAvantLancement(
  etat: EtatPourCreation,
  chaine: EtageAssistant[],
  ctx: ContexteDeCreation,
  /** L'horloge, pour la seule garde qui en dépend (la programmation). Cf. `momentDuLancement`. */
  maintenant: number = Date.now(),
): string | null {
  if (etat.nom.trim() === '') return 'Cette campagne n’a pas de nom.';
  // ⚠️ LA PROGRAMMATION EST VÉRIFIÉE PAR LA MÊME FONCTION QUI LA CALCULE : le bouton ne peut pas être
  // actif sur une date que le lancement refuserait ensuite de traduire.
  const moment = momentDuLancement(etat, maintenant);
  if ('probleme' in moment) return moment.probleme;
  /**
   * 🔴 UNE LISTE EXPLICITEMENT VIDE NE PART PAS, ET L'ÉCRAN LE SAIT SANS DEMANDER. Le serveur refuse déjà
   * en 422 (« Aucun contact ne correspond à cette sélection »), donc rien ne partirait à tout l'espace ;
   * ce qu'on évite ici est un aller-retour et un message d'erreur rouge pour un cas que l'écran a sous les
   * yeux, exactement comme le bouton de lancement de l'ancien formulaire, qui s'éteignait à zéro.
   *
   * ⚠️ SEULEMENT LE MODE LISTE. En mode « tout ce qui correspond », le nombre retenu dépend d'un COMPTE
   * SERVEUR que cette fonction pure n'a pas : y deviner zéro bloquerait une campagne parfaitement valide.
   */
  /**
   * 🔴 AU FIL DE L'EAU, IL N'Y A RIEN À COCHER, ET NAÎTRE VIDE EST L'ÉTAT NORMAL. Appliquer la garde
   * ci-dessous à ce mode refuserait la seule création valide qu'il connaisse. Ce qui se vérifie ici,
   * c'est l'ADRESSE : sans elle, le serveur refuserait en 400 une campagne qui ne recevra jamais
   * personne, et l'écran a la réponse sous les yeux.
   */
  if (ctx.webhookId !== null) {
    if (ctx.webhookId === '') {
      return 'Choisissez l’adresse qui amènera les contacts, à l’étape Audience.';
    }
  } else if (!ctx.selection.toutFiltre && ctx.selection.selected.size === 0) {
    return 'Aucun contact n’est sélectionné : cochez au moins une personne à l’étape Audience.';
  }
  const premier = [...chaine].sort((a, b) => a.rang - b.rang)[0];
  /**
   * ⚠️ CE REFUS EST DEVENU ATTEIGNABLE LE 2026-09-14, ET SON TEXTE A CHANGÉ POUR LE DIRE. Le canal
   * n'a plus de défaut : une adresse ouverte directement sur le récapitulatif (`?etape=recap`) ou un
   * brouillon abandonné avant le choix du canal arrivent ici avec une chaîne VIDE. « Cette campagne n'a
   * aucun étage » décrivait la structure interne ; ce qui manque, vu de l'opérateur, c'est un canal.
   */
  if (!premier) return 'Aucun canal n’est choisi : revenez à l’étape Canal.';
  if (premier.canal === 'whatsapp' && ctx.phoneNumberId === '') {
    return 'Aucun numéro WhatsApp n’est disponible sur cet espace.';
  }
  if (chaine.some((e) => e.canal === 'rcs') && !ctx.rcsAgentId) {
    return 'Cette chaîne comporte un étage RCS : il lui faut un agent RCS.';
  }
  for (const etage of chaine) {
    const c = etat.contenus[etage.rang];
    if (etage.canal === 'whatsapp' && c?.formule !== 'avec_scenario' && !c?.templateName) {
      return `L’étage ${etage.rang} n’a pas de modèle WhatsApp.`;
    }
    if (etage.canal === 'whatsapp' && c?.formule === 'avec_scenario' && !c?.workflowId) {
      return `L’étage ${etage.rang} n’a pas de scénario.`;
    }
    /**
     * 🔴 UN SCÉNARIO QUI N'OUVRE PAS PAR UN MODÈLE NE PEUT PAS OUVRIR UNE CAMPAGNE WHATSAPP (2026-09-13).
     * Une campagne parle à des gens qui ne nous ont pas écrit récemment : son premier message DOIT être
     * un modèle approuvé, sans quoi Meta refuse (fenêtre de 24 h, 131047). `modeleDuScenario` est posé
     * par l'écran depuis le PREMIER BLOC du graphe : absent, c'est que ce scénario ouvre autrement (par
     * un bloc RCS, par un message de session) ou que son graphe n'a pas pu être lu.
     *
     * ⚠️ CE CAS N'ÉTAIT REFUSÉ NULLE PART, ET UN COMMENTAIRE AFFIRMAIT LE CONTRAIRE. Celui de
     * `choisirScenario` disait « une lecture en échec laisse le scénario sans modèle connu, et c'est le
     * récapitulatif qui le dira » : `problemeDesVariables` rend `null` dès que le modèle est inconnu,
     * donc le récapitulatif ne disait rien du tout. La campagne partait avec un `paramMapping` vide sur
     * un modèle à variables, et Meta la refusait ENTIÈREMENT.
     */
    /**
     * ⚠️ LE CANAL D'OUVERTURE EST DIT, QUAND ON LE SAIT. Le refus ci-dessous est le même, mais sa RAISON
     * est exacte : « ce scénario ouvre en RCS » se corrige d'un geste, « il ne commence pas par un modèle »
     * laisse chercher. Le canal vient de la liste des scénarios, calculé par le serveur.
     *
     * ⚠️ ET IL PASSE AVANT la garde du modèle, sinon c'est le message vague qui sortirait le premier.
     */
    if (etage.canal === 'whatsapp' && c?.formule === 'avec_scenario' && c?.canalOuvertureDuScenario === 'rcs') {
      return `L’étage ${etage.rang} : ce scénario ouvre par un message RCS, il ne peut donc pas ouvrir un étage WhatsApp. Choisissez-en un qui démarre par un modèle approuvé.`;
    }
    if (etage.canal === 'whatsapp' && c?.formule === 'avec_scenario' && c?.workflowId && !c?.modeleDuScenario) {
      return `L’étage ${etage.rang} : ce scénario ne commence pas par un modèle WhatsApp, il ne peut donc pas ouvrir une campagne. Choisissez-en un qui démarre par un modèle approuvé.`;
    }
    if (etage.canal === 'rcs' && !c?.texteRcs?.trim()) {
      return `L’étage ${etage.rang} n’a pas de message RCS.`;
    }
    /**
     * 🔴 LE PLAFOND DE TEXTE CHANGE QUAND ON AJOUTE UN VISUEL : 3 072 caractères sur un message nu,
     * 2 000 dans une carte (c'est la borne du champ `description` chez l'opérateur, pas un choix). Un
     * texte déjà saisi ne se raccourcit pas tout seul : sans cette garde, ajouter l'image à la fin ferait
     * échouer la création avec un « content invalide » que personne ne saurait relier à ce geste.
     */
    if (etage.canal === 'rcs' && (c?.texteRcs ?? '').length > maxTexteRcs(c?.imageRcs ?? '')) {
      return `L’étage ${etage.rang} : le message RCS dépasse ${maxTexteRcs(c?.imageRcs ?? '')} caractères (la limite baisse quand il y a un visuel).`;
    }
    /**
     * ⚠️ UN BOUTON INCOMPLET FAIT REFUSER TOUT LE MESSAGE, pas seulement le bouton : le schéma serveur
     * exige l'adresse d'un lien, le numéro d'un appel, les bornes d'un agenda. `versMessageRcs` n'écarte
     * que les boutons SANS LIBELLÉ ; celui qui a un libellé et rien d'autre part tel quel et se fait
     * refuser. C'est la même garde que l'écran en service (`contentReady`).
     */
    if (etage.canal === 'rcs' && (c?.suggestions ?? []).some((b) => !boutonPret(b))) {
      return `L’étage ${etage.rang} : un bouton RCS est incomplet (libellé, lien, numéro ou dates).`;
    }
    if (etage.canal === 'email' && !c?.emailTemplateId) {
      return `L’étage ${etage.rang} n’a pas de modèle d’e-mail.`;
    }
    // 🔴 `contacts` N'A PAS DE COLONNE `email` : l'adresse vit dans le jsonb `fields`, sous un nom que
    // le client choisit. Sans ce nom, l'étage serait enregistré puis SAUTÉ à chaque bascule, en silence.
    if (etage.canal === 'email' && !ctx.champEmail) {
      return `L’étage ${etage.rang} part en e-mail : choisissez le champ de la fiche qui porte l’adresse.`;
    }
    const probleme = problemeDesVariables(etage, etat, ctx);
    if (probleme !== null) return probleme;
  }
  return null;
}

/**
 * CE QUI EMPÊCHE D'ENVOYER LES VARIABLES DE CET ÉTAGE, ou `null`.
 *
 * 🔴 UN MODÈLE À VARIABLES SANS ASSOCIATION FAIT REFUSER LA CAMPAGNE ENTIÈRE, PAS UN DESTINATAIRE. Meta
 * compare le nombre de paramètres fournis à celui du modèle approuvé, et c'est le seul refus de cet écran
 * dont le coût est GLOBAL : les autres écartent une fiche. D'où une garde, plutôt qu'un aller-retour qui
 * reviendrait avec un code Meta que personne ne sait lire.
 *
 * 🔴 ET UN ÉTAGE DE REPLI À VARIABLES EST REFUSÉ TOUT COURT, parce que rien ne peut le porter : la
 * campagne n'a qu'un `param_mapping`, `campaign_etages` n'a pas de colonne pour un second, et
 * `campaign_recipients.resolved_params` est résolu UNE fois, à la création, depuis ce mapping unique
 * (`buildRecipients`). Vérifié dans la migration 0134 et dans `PgCampaignRepo.insertCampaignRow`.
 * Le laisser passer enregistrerait une chaîne dont le repli échouerait chez Meta des jours plus tard, sur
 * un chemin que personne ne regarde.
 */
function problemeDesVariables(
  etage: EtageAssistant,
  etat: EtatPourCreation,
  ctx: ContexteDeCreation,
): string | null {
  if (etage.canal !== 'whatsapp') return null;
  const attendues = ctx.variablesDuModele[etage.rang];
  // Modèle inconnu : on ne sait pas combien il en porte, et inventer zéro serait le défaut qu'on ferme.
  if (attendues === undefined || attendues === 0) return null;
  if (etage.rang !== RANG_INITIAL) {
    return `L’étage ${etage.rang} part sur un modèle à variables : ce n’est pas encore possible sur un repli. Choisissez un modèle sans variable.`;
  }
  const probleme = problemeDAssociation(etat.contenus[etage.rang]?.variables ?? [], attendues);
  return probleme === null ? null : `L’étage ${etage.rang} : ${probleme}.`;
}

/**
 * LE MESSAGE RCS D'UN ÉTAGE, dans la forme que `rcsOutboundSchema` accepte.
 *
 * 🔴 ELLE PASSE PAR `versMessageRcs`, LE CONSTRUCTEUR PARTAGÉ, ET PLUS PAR UN LITTÉRAL `kind: 'text'`.
 * C'est lui qui décide TEXTE ou CARTE selon qu'il y a un visuel, qui accroche les boutons au bon endroit
 * (dans la carte, pleine largeur, 4 au plus ; sinon en pastilles sous la bulle, 11 au plus) et qui écarte
 * les suggestions sans libellé. Écrit en dur ici, l'étage RCS de l'assistant aurait ignoré le visuel EN
 * SILENCE : l'écran l'aurait montré, le message serait parti sans lui, et personne n'aurait su pourquoi.
 *
 * ⚠️ IL EST DÉJÀ CELUI DES TROIS AUTRES ÉCRANS (bibliothèque, bloc de scénario, ancien formulaire) : la
 * même saisie y produit donc le même message, ce qui n'était pas vrai tant que celui-ci en avait un
 * quatrième exemplaire, réduit au texte.
 */
function messageRcs(c: EtatPourCreation['contenus'][number] | undefined): RcsOutbound {
  return versMessageRcs({
    text: c?.texteRcs ?? '',
    imageUrl: c?.imageRcs ?? '',
    suggestions: c?.suggestions ?? [],
  });
}

export function entreeDeCreation(
  etat: EtatPourCreation,
  chaine: EtageAssistant[],
  ctx: ContexteDeCreation,
): CreateCampaignInput {
  const tries = [...chaine].sort((a, b) => a.rang - b.rang);
  const premier = tries[0]!;
  const contenuPremier = etat.contenus[premier.rang];
  const rcsPremier = premier.canal === 'rcs';
  const scenarioPremier = contenuPremier?.formule === 'avec_scenario' && !!contenuPremier.workflowId;
  /**
   * La question « à qui va la conversation ? » a-t-elle été posée à l'écran ?
   *
   * ⚠️ ELLE NE L'EST QUE SI UN ÉTAGE RENVOIE VERS L'INBOX (2026-09-14). Le DEVENIR, lui, est descendu dans
   * les étages : il voyage par étage, plus au niveau de la campagne.
   */
  const devenirDemande = assignationProposable(tries, etat.contenus);

  /**
   * ⚠️ LES ÉTAGES AU-DELÀ DU PREMIER PORTENT LEUR CONTENU ; le rang 1 n'en porte pas, et ce n'est pas un
   * oubli : le serveur l'ignore et le réécrit depuis les colonnes de la campagne (invariant de la
   * migration 0134, « une seule source pour le contenu d'un étage »). L'envoyer quand même donnerait
   * l'illusion qu'il compte.
   */
  const etages: EtageCreation[] = tries.map((e) => {
    if (e.rang === RANG_INITIAL) return { rang: e.rang, canal: e.canal };
    const c = etat.contenus[e.rang];
    return {
      rang: e.rang,
      // ⚠️ Même garde que pour le premier étage : un étage à scénario n'envoie AUCUN devenir, c'est le
      // scénario qui décide. Ce qu'on cache à l'écran doit être exactement ce qu'on n'envoie pas.
      ...(c?.formule === 'seul' && c.devenir ? { devenir: c.devenir } : {}),
      canal: e.canal,
      ...(e.canal === 'whatsapp' && c?.templateName ? { templateName: c.templateName, templateLanguage: c.templateLanguage ?? 'fr' } : {}),
      ...(e.canal === 'rcs' ? { rcsMessage: messageRcs(c) } : {}),
      ...(e.canal === 'email' && c?.emailTemplateId ? { emailTemplateId: c.emailTemplateId } : {}),
      ...(e.canal === 'email' && ctx.champEmail ? { emailChamp: ctx.champEmail } : {}),
      ...(c?.formule === 'avec_scenario' && c.workflowId ? { workflowId: c.workflowId } : {}),
    };
  });

  return {
    phoneNumberId: rcsPremier ? '' : ctx.phoneNumberId,
    name: etat.nom.trim(),
    category: etat.category,
    /**
     * 🔴 L'ASSOCIATION DES VARIABLES DU PREMIER ÉTAGE, ET D'AUCUN AUTRE. `campaigns.param_mapping` décrit
     * le modèle de la campagne, c'est-à-dire le rang 1 : c'est lui que `buildRecipients` résout par contact
     * dans `campaign_recipients.resolved_params`, et c'est cette liste-là que l'envoi passe à Meta. Y mettre
     * les variables d'un étage de repli ferait écarter, dès la création, les contacts à qui il manque une
     * valeur dont le PREMIER étage n'a pas besoin.
     *
     * ⚠️ IL PART AUSSI SUR UNE CAMPAGNE DE SCÉNARIO, et ce n'est pas un oubli du contraire : le premier
     * envoi du scénario reçoit ces variables DÉJÀ RÉSOLUES et les utilise telles quelles, sans relire les
     * indices du modèle (`explicitParams`, `src/workflow/wiring.ts`). Un mapping vide y produit le même
     * refus global de Meta que sur une campagne de modèle direct.
     *
     * ⚠️ VIDE SUR UN PREMIER ÉTAGE RCS : ce canal n'a pas de variables de modèle, et le serveur valide de
     * toute façon `paramMapping ?? []` pour tout le monde.
     */
    paramMapping: rcsPremier ? [] : versParamMapping(contenuPremier?.variables ?? []),
    ...(rcsPremier || scenarioPremier ? {} : {
      templateName: contenuPremier?.templateName ?? '',
      templateLanguage: contenuPremier?.templateLanguage ?? 'fr',
    }),
    ...(scenarioPremier ? { workflowId: contenuPremier!.workflowId } : {}),
    channel: rcsPremier ? 'rcs' : 'whatsapp',
    ...(ctx.rcsAgentId && chaine.some((e) => e.canal === 'rcs') ? { rcsAgentId: ctx.rcsAgentId } : {}),
    ...(rcsPremier ? { rcsMessage: messageRcs(contenuPremier) } : {}),
    /**
     * 🔴 LES DESTINATAIRES PASSENT PAR LE POINT UNIQUE `cibleDeCreation`, PARTAGÉ AVEC L'ÉCRAN EN SERVICE.
     * Cette ligne posait `contactTarget: { filters }` et RIEN D'AUTRE : l'assistant ne savait donc pas
     * emporter une sélection fine, quoi que l'écran ait montré. Les deux formes (une intention filtrée
     * avec ses exclusions, ou une liste d'identifiants) sont exclusives, et le serveur refuse les deux.
     *
     * 🔴 ET UNE TROISIÈME FORME LES EXCLUT TOUTES DEUX : l'adresse du fil de l'eau. Emporter les deux
     * ferait croire que la liste va partir alors que seule l'adresse compte, et le serveur refuse de les
     * recevoir ensemble. C'est le seul endroit du front où cet arbitrage se fait.
     */
    ...(ctx.webhookId !== null ? { webhookId: ctx.webhookId } : cibleDeCreation(ctx.selection, ctx.filtres)),
    ratePerMinute: debitBorne(etat.debitParMinute),
    businessHoursOnly: etat.heuresOuvrees,
    // ⚠️ UN SEUL ÉTAGE N'EST PAS UNE CHAÎNE, et on ne l'envoie pas. Le serveur écrit de toute façon le
    // rang 1 depuis les colonnes de la campagne : un tableau à un élément n'ajouterait rien à ce que
    // `channel` dit déjà, et ferait passer par la validation de chaîne une campagne qui n'en a pas.
    ...(etages.length > 1 ? { chaine: etages } : {}),
    /**
     * 🔴 UNE CHAÎNE N'EMPORTE JAMAIS DE RÉESSAI, ET LA GARDE EST ICI, AU POINT D'ENVOI. L'écran masquait
     * déjà le bloc sur une formule « avec repli », mais masquer n'efface pas : cocher « réessayer » en
     * WhatsApp puis basculer sur « avec repli » laissait la case à vrai dans l'état, et ce corps
     * l'emportait telle quelle vers le serveur. La campagne partait donc avec les DEUX rattrapages,
     * dont aucun écran ne montrait plus le premier.
     */
    reessayer: reessaiProposable(etages) ? etat.reessayer : false,
    /**
     * 🔴 DÉRIVÉE, PLUS DEMANDÉE (2026-09-13, tranché par Julien sur son essai réel) : « on a juste besoin
     * d'Envoyer uniquement pendant les heures ouvrées, cette option vaut pour les primo messages et pour
     * les relances, avec fallback ou pas ». Une seule question gouverne donc les deux moments, et la
     * colonne `rattrapage_hors_horaires` (migration 0134) devient son miroir plutôt qu'un second réglage.
     *
     * ⚠️ LE SENS EST INVERSE, et c'est exactement là qu'on se trompe : `rattrapage_hors_horaires` à vrai
     * veut dire « le rattrapage S'AFFRANCHIT des horaires ». Cocher « heures ouvrées » doit donc l'éteindre.
     * Le serveur n'a pas bougé d'une ligne, c'est la question qui a disparu.
     */
    rattrapageHorsHoraires: !etat.heuresOuvrees,
    /**
     * 🔴 UNE CAMPAGNE DONT TOUT PART EN SCÉNARIO N'EMPORTE AUCUNE ASSIGNATION, ET LA GARDE EST ICI, AU
     * POINT D'ENVOI (2026-09-14). L'écran ne pose plus la question quand chaque étage ouvre un parcours,
     * mais MASQUER N'EFFACE PAS : régler « assignée à une personne » en modèle seul puis basculer sur
     * « modèle et scénario » laissait la valeur dans l'état, et ce corps l'emportait telle quelle. Le
     * serveur, lui, l'applique à l'arrivée de CHAQUE réponse (`assignationDeLaCampagne`,
     * `src/campaign/store.pg.ts`), scénario ou pas : les conversations auraient donc été attribuées par
     * un réglage que plus aucun écran ne montrait.
     *
     * ⚠️ MÊME MOTIF QUE `reessayer` JUSTE AU-DESSUS, ET C'EST LA TROISIÈME FOIS : ce qu'on cache doit être
     * exactement ce qu'on n'envoie pas, et la seule façon de le tenir est d'appeler LA MÊME fonction des
     * deux côtés.
     */
    ...(devenirDemande && etat.assignation !== 'aucune' ? { assignation: etat.assignation } : {}),
    ...(devenirDemande && etat.assignation === 'personne' ? { assignationUserId: etat.assignationUserId } : {}),
    /**
     * CE QUI SE PASSE QUAND LE CONTACT RÉPOND AU PREMIER ÉTAGE (migration 0144).
     *
     * 🔴 IL VIT AU NIVEAU DE LA CAMPAGNE ET NON DANS `chaine`, et c'est l'invariant de la migration 0134 :
     * le rang 1 EST la campagne, ses colonnes en sont la seule source. C'est aussi ce qui permet à une
     * campagne SANS repli (qui n'envoie aucune `chaine`) de dire ce que devient sa réponse.
     *
     * ⚠️ RIEN N'EST ENVOYÉ QUAND CET ÉTAGE OUVRE UN SCÉNARIO : c'est lui qui décide qui répond, et l'écran
     * ne pose alors pas la question. Masquer n'efface pas, c'est la troisième fois que ce motif se pose
     * ici (`reessayer`, `assignation`) : ce qu'on cache doit être exactement ce qu'on n'envoie pas.
     */
    ...(contenuPremier?.formule === 'seul' && contenuPremier.devenir ? { devenir: contenuPremier.devenir } : {}),
  };
}
