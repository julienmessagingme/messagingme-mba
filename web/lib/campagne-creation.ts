import type { CreateCampaignInput, EtageCreation } from './api/campagnes';
import type { CampaignCategory } from './api/campagnes';
import type { ContactFilters } from './contact-filters';
import type { RcsOutbound, RcsSuggestion } from './rcs-types';
import type { EtageAssistant } from './campagne-chaine';
import { RANG_INITIAL, reglagesDeCadence, type Cadence } from './campagne-chaine';
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
  cadence: Cadence;
  reessayer: boolean;
  rattrapageHorsHoraires: boolean;
  assignation: 'aucune' | 'personne' | 'tour_de_role';
  assignationUserId: string | null;
  contenus: Record<number, {
    formule: 'seul' | 'avec_scenario';
    templateName?: string;
    templateLanguage?: string;
    workflowId?: string;
    texteRcs?: string;
    suggestions: RcsSuggestion[];
    emailTemplateId?: string;
    /** L'association des variables du modèle de cet étage. Cf. `ContenuEtage.variables`. */
    variables?: VarRow[];
    /** Le modèle par lequel le scénario de cet étage ouvre. Cf. `ContenuEtage.modeleDuScenario`. */
    modeleDuScenario?: { name: string; language: string };
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
): string | null {
  if (etat.nom.trim() === '') return 'Cette campagne n’a pas de nom.';
  const premier = [...chaine].sort((a, b) => a.rang - b.rang)[0];
  if (!premier) return 'Cette campagne n’a aucun étage.';
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
    if (etage.canal === 'rcs' && !c?.texteRcs?.trim()) {
      return `L’étage ${etage.rang} n’a pas de message RCS.`;
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

/** Le message RCS d'un étage, dans la forme que `rcsOutboundSchema` accepte. */
function messageRcs(c: EtatPourCreation['contenus'][number] | undefined): RcsOutbound {
  // ⚠️ Une suggestion SANS LIBELLÉ est écartée ici, pas envoyée : le schéma serveur exige un `text` non
  // vide, et un bouton ajouté puis laissé vierge ferait refuser TOUT le message pour un bouton oublié.
  const suggestions = (c?.suggestions ?? []).filter((s) => s.text.trim() !== '');
  return {
    kind: 'text',
    text: c?.texteRcs ?? '',
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
}

export function entreeDeCreation(
  etat: EtatPourCreation,
  chaine: EtageAssistant[],
  ctx: ContexteDeCreation,
): CreateCampaignInput {
  const tries = [...chaine].sort((a, b) => a.rang - b.rang);
  const premier = tries[0]!;
  const contenuPremier = etat.contenus[premier.rang];
  const cadence = reglagesDeCadence(etat.cadence);
  const rcsPremier = premier.canal === 'rcs';
  const scenarioPremier = contenuPremier?.formule === 'avec_scenario' && !!contenuPremier.workflowId;

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
    contactTarget: { filters: ctx.filtres },
    ratePerMinute: cadence.ratePerMinute,
    businessHoursOnly: cadence.businessHoursOnly,
    // ⚠️ UN SEUL ÉTAGE N'EST PAS UNE CHAÎNE, et on ne l'envoie pas. Le serveur écrit de toute façon le
    // rang 1 depuis les colonnes de la campagne : un tableau à un élément n'ajouterait rien à ce que
    // `channel` dit déjà, et ferait passer par la validation de chaîne une campagne qui n'en a pas.
    ...(etages.length > 1 ? { chaine: etages } : {}),
    reessayer: etat.reessayer,
    rattrapageHorsHoraires: etat.rattrapageHorsHoraires,
    ...(etat.assignation === 'aucune' ? {} : { assignation: etat.assignation }),
    ...(etat.assignation === 'personne' ? { assignationUserId: etat.assignationUserId } : {}),
  };
}
