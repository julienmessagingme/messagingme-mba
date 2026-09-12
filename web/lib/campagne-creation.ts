import type { CreateCampaignInput, EtageCreation } from './api/campagnes';
import type { CampaignCategory } from './api/campagnes';
import type { ContactFilters } from './contact-filters';
import type { RcsOutbound, RcsSuggestion } from './rcs-types';
import type { EtageAssistant } from './campagne-chaine';
import { RANG_INITIAL, reglagesDeCadence, type Cadence } from './campagne-chaine';

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
  }>;
}

/** Ce que l'assistant ne porte pas lui-même : le numéro, l'agent RCS, et les filtres de l'audience. */
export interface ContexteDeCreation {
  phoneNumberId: string;
  rcsAgentId: string | null;
  filtres: ContactFilters;
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
  }
  return null;
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
      ...(c?.formule === 'avec_scenario' && c.workflowId ? { workflowId: c.workflowId } : {}),
    };
  });

  return {
    phoneNumberId: rcsPremier ? '' : ctx.phoneNumberId,
    name: etat.nom.trim(),
    category: etat.category,
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
