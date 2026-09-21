import type { CampaignCategory } from './api/campagnes';
import type { AudienceChoix, SourceAudience } from './audience';
import { audienceInitiale } from './audience';
import type { CanalPremier, FormuleCanal, TroisiemeNiveau } from './campagne-chaine';
import { DEBIT_DEFAUT, debitBorne } from './campagne-chaine';
import { filtresRepris } from './contact-filters';
import type { RcsSuggestion } from './rcs-types';
import { carrouselDepuis, type CarrouselRcs } from './rcs-carrousel';
import type { VarRow } from './variables-template';

/**
 * LE BROUILLON D'UNE CAMPAGNE : ce qu'on écrit, et ce qu'on sait relire.
 *
 * 🔴 CE FICHIER EXISTE PARCE QUE LE RETRAIT DE L'ANCIEN FORMULAIRE POUVAIT DÉTRUIRE DU TRAVAIL EN COURS.
 * Un brouillon est un `jsonb` de forme LIBRE (`campaign_drafts.state`), que le serveur ne valide pas :
 * c'est « l'état d'un écran », et l'écran qui l'a écrit était seul à savoir le relire. Retirer cet écran
 * sans savoir relire ce qu'il a écrit, c'est jeter sans un mot la campagne que quelqu'un avait commencée,
 * destinataires cochés compris (le travail le plus long de tout le parcours). D'où une relecture des DEUX
 * formats, ici, exerçable en quelques millisecondes.
 *
 * 🔴 ET DANS L'AUTRE SENS : CE QU'ON ÉCRIT PORTE UN MARQUEUR DE VERSION. Sans lui, distinguer un
 * brouillon de l'assistant d'un brouillon de l'ancien écran demanderait de deviner d'après les clés
 * présentes, ce qui se trompe dès qu'un champ est vide. `assistant: 1` tranche en un test.
 *
 * ⚠️ MODULE PUR (ni React, ni `@/`) : les seuls tests du front qui tournent hors navigateur sont ceux de
 * `lib/**`. Une relecture enfouie dans un `.tsx` ne serait exerçable que par un e2e, alors qu'elle décide
 * de ce qu'on rend à quelqu'un qui revient sur son travail.
 *
 * ⚠️ CE QUI N'EST PAS RECONNU EST JETÉ, JAMAIS DEVINÉ, et chaque champ est coercé plutôt que transtypé :
 * cet objet revient d'un `jsonb` que rien n'a validé, et un `as` y ferait entrer n'importe quoi dans un
 * état typé. Un champ manquant garde son défaut, ce qui est le seul comportement sûr quand le brouillon a
 * pu être écrit par une version antérieure de l'écran.
 */

/** Le contenu d'un étage, tel qu'un brouillon le porte. Miroir structurel de `ContenuEtage`. */
export interface ContenuBrouillon {
  formule: 'seul' | 'avec_scenario';
  /** Cf. `ContenuEtage.devenir`. Le brouillon le garde par ÉTAGE depuis le 2026-09-14. */
  devenir: 'mba' | 'inbox';
  templateName?: string;
  templateLanguage?: string;
  workflowId?: string;
  texteRcs?: string;
  imageRcs?: string;
  /** Cf. `ContenuEtage.carrouselRcs`. Relu STRICTEMENT (`carrouselDepuis`) : mal formé, il est jeté. */
  carrouselRcs?: CarrouselRcs;
  suggestions: RcsSuggestion[];
  emailTemplateId?: string;
  emailChamp?: string;
  variables?: VarRow[];
  modeleDuScenario?: { name: string; language: string };
}

/**
 * L'ÉTAT DE LA CAMPAGNE QUI SE SÉRIALISE. Miroir structurel de `EtatCampagne`, moins ce qui n'a rien à
 * faire dans un brouillon.
 *
 * ⚠️ `nom` N'EN FAIT PAS PARTIE : il vit dans la COLONNE `campaign_drafts.name`, c'est lui que la liste
 * des brouillons affiche. Le mettre aussi dans le `state` donnerait deux noms à tenir d'accord, et le jour
 * où ils divergent, c'est celui que personne ne voit qui reviendrait à la reprise.
 */
export interface EtatBrouillon {
  /**
   * L'ÉCRAN OÙ L'OPÉRATEUR EN ÉTAIT.
   *
   * 🔴 DEMANDÉ PAR JULIEN LE 2026-09-14 : « dans l'onglet campagne, cela ne retient pas quel est le
   * dernier écran qu'on a rempli, et quand on revient c'est toujours depuis le point de démarrage ». Le
   * brouillon suivait déjà TOUT le contenu ; il ne gardait pas l'endroit, donc reprendre une campagne à
   * moitié remplie obligeait à recliquer « Suivant » jusqu'à retrouver sa place.
   *
   * ⚠️ ABSENT = brouillon d'avant ce champ, ou reprise par une adresse (`?etape=`). On repart alors du
   * début, ce qui est le comportement d'avant : aucune reprise à inventer.
   */
  etape?: 'nom' | 'canal' | 'contenu' | 'audience' | 'recap';
  category: CampaignCategory;
  /**
   * LE CANAL, ou `null` quand la question n'a pas encore reçu de réponse (cf. `EtatCampagne.formule`).
   *
   * ⚠️ IL S'ÉCRIT TEL QUEL ET SE RELIT PAR OMISSION : `dans(null, [...])` ne reconnaît pas `null`, donc la
   * clé n'est pas reposée à la reprise et le défaut de l'assistant (aucun canal) l'emporte. Un brouillon
   * abandonné avant le choix du canal repose donc la question, au lieu d'en inventer une réponse.
   */
  formule: FormuleCanal | null;
  premier: CanalPremier;
  troisieme: TroisiemeNiveau;
  reessayer: boolean;
  heuresOuvrees: boolean;
  debitParMinute: number;
  contenus: Record<number, ContenuBrouillon>;
  assignation: 'aucune' | 'personne' | 'tour_de_role';
  assignationUserId: string | null;
  audience: AudienceChoix;
  quand: 'maintenant' | 'plus_tard';
  dateLocale: string;
}

/** La version du format écrit par l'assistant. Un brouillon sans ce marqueur vient de l'ancien écran. */
export const VERSION_ASSISTANT = 1;

/**
 * CE QU'ON ENREGISTRE.
 *
 * 🔴 LES `Set` NE SURVIVENT PAS À `JSON.stringify` : `new Set(['a'])` s'y sérialise en `{}`, donc en
 * sélection VIDE, sans la moindre erreur. La sélection de destinataires en porte deux, et c'est le
 * travail le plus long du parcours. Elles partent donc en TABLEAUX, et la relecture les rend en `Set`.
 */
export function brouillonDeLEtat(etat: EtatBrouillon): Record<string, unknown> {
  return {
    assistant: VERSION_ASSISTANT,
    // ⚠️ L'étape voyage AVEC le contenu : c'est la même sauvegarde, donc aucun déclencheur de plus à
    // câbler, et changer d'écran suffit à la rafraîchir.
    ...(etat.etape ? { etape: etat.etape } : {}),
    category: etat.category,
    formule: etat.formule,
    premier: etat.premier,
    troisieme: etat.troisieme,
    reessayer: etat.reessayer,
    heuresOuvrees: etat.heuresOuvrees,
    debitParMinute: etat.debitParMinute,
    contenus: etat.contenus,
    assignation: etat.assignation,
    assignationUserId: etat.assignationUserId,
    quand: etat.quand,
    dateLocale: etat.dateLocale,
    audience: {
      source: etat.audience.source,
      webhookId: etat.audience.webhookId,
      filtres: etat.audience.filtres,
      toutFiltre: etat.audience.selection.toutFiltre,
      selected: [...etat.audience.selection.selected],
      exclus: [...etat.audience.selection.exclus],
    },
  };
}

/** Les petits coerceurs. Ce qui n'est pas de la bonne forme n'entre pas, et le défaut s'applique. */
function texte(o: Record<string, unknown>, k: string): string | undefined {
  return typeof o[k] === 'string' ? (o[k] as string) : undefined;
}
function booleen(o: Record<string, unknown>, k: string): boolean | undefined {
  return typeof o[k] === 'boolean' ? (o[k] as boolean) : undefined;
}
function objet(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function identifiants(v: unknown): Set<string> {
  return new Set(Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : []);
}
function dans<T extends string>(v: unknown, valeurs: readonly T[]): T | undefined {
  return typeof v === 'string' && (valeurs as readonly string[]).includes(v) ? (v as T) : undefined;
}
/**
 * Les lignes d'association des variables, telles que les DEUX écrans les écrivent.
 *
 * ⚠️ `sel` ET `value` SONT EXIGÉS TOUS LES DEUX : le type déclare `value` non optionnel, et
 * `problemeDAssociation` appelle `.trim()` dessus sans détour. Une ligne mal formée jetterait pendant le
 * rendu et emporterait tout l'écran, pour un brouillon qu'on essayait justement de sauver.
 */
function lignes(v: unknown): VarRow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const l = (v as unknown[])
    .map(objet)
    .filter((x) => typeof x.sel === 'string' && typeof x.value === 'string')
    .map((x) => ({ sel: x.sel as string, value: x.value as string }));
  return l.length > 0 ? l : undefined;
}
/** Les suggestions RCS. Aucun brouillon n'en a jamais porté (cf. `etatDepuisAncien`), mais le format neuf oui. */
function suggestions(v: unknown): RcsSuggestion[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .map(objet)
    .filter((x) => typeof x.kind === 'string' && typeof x.text === 'string' && typeof x.postbackData === 'string')
    .map((x) => x as unknown as RcsSuggestion);
}

function contenuDe(v: unknown): ContenuBrouillon {
  const o = objet(v);
  const modele = objet(o.modeleDuScenario);
  // 🔴 UN CARROUSEL MAL FORMÉ EST JETÉ, JAMAIS RÉPARÉ : c'est une copie figée qu'on ne peut pas éditer dans
  // l'assistant, la « réparer » enverrait un message que personne n'a relu. L'étage redevient vide, et le
  // récapitulatif le dit.
  const carrousel = carrouselDepuis(o.carrouselRcs);
  return {
    formule: dans(o.formule, ['seul', 'avec_scenario'] as const) ?? 'seul',
    // ⚠️ `mba` EN REPLI, comme `contenuVide()` : c'est le comportement réel sans réglage (l'agent de Meta
    // est le répondeur primaire du numéro). Un brouillon d'avant le 2026-09-14 n'a pas ce champ.
    devenir: dans(o.devenir, ['mba', 'inbox'] as const) ?? 'mba',
    ...(texte(o, 'templateName') ? { templateName: texte(o, 'templateName')! } : {}),
    ...(texte(o, 'templateLanguage') ? { templateLanguage: texte(o, 'templateLanguage')! } : {}),
    ...(texte(o, 'workflowId') ? { workflowId: texte(o, 'workflowId')! } : {}),
    ...(texte(o, 'texteRcs') !== undefined ? { texteRcs: texte(o, 'texteRcs')! } : {}),
    ...(texte(o, 'imageRcs') !== undefined ? { imageRcs: texte(o, 'imageRcs')! } : {}),
    ...(carrousel ? { carrouselRcs: carrousel } : {}),
    ...(texte(o, 'emailTemplateId') ? { emailTemplateId: texte(o, 'emailTemplateId')! } : {}),
    // ⚠️ UNE CHAÎNE VIDE EST UN CHOIX EXPLICITE ici (« aucun champ »), pas une absence : elle ne retombe
    // donc PAS sur la suggestion automatique, cf. `champEmailEffectif`. D'où le test sur `undefined`.
    ...(texte(o, 'emailChamp') !== undefined ? { emailChamp: texte(o, 'emailChamp')! } : {}),
    ...(lignes(o.variables) ? { variables: lignes(o.variables)! } : {}),
    ...(typeof modele.name === 'string' && modele.name !== ''
      ? { modeleDuScenario: { name: modele.name, language: typeof modele.language === 'string' ? modele.language : 'fr' } }
      : {}),
    suggestions: suggestions(o.suggestions),
  };
}

/** L'audience d'un brouillon écrit par l'ASSISTANT. */
function audienceDe(v: unknown): AudienceChoix {
  const o = objet(v);
  const base = audienceInitiale();
  const toutFiltre = booleen(o, 'toutFiltre') ?? base.selection.toutFiltre;
  return {
    source: dans(o.source, ['crm', 'fichier', 'hubspot', 'webhook'] as const) ?? base.source,
    webhookId: texte(o, 'webhookId') ?? '',
    filtres: filtresRepris(o.filtres),
    selection: { toutFiltre, selected: identifiants(o.selected), exclus: identifiants(o.exclus) },
  };
}

/**
 * CE QU'ON RELIT, quel que soit l'écran qui l'a écrit.
 *
 * ⚠️ ELLE REND UN `Partial` : tout ce qui manque garde son défaut, posé par `ETAT_INITIAL`. C'est le
 * seul comportement sûr sur un `jsonb` qu'aucune version antérieure n'était tenue de remplir.
 */
export function etatDeBrouillon(state: unknown): Partial<EtatBrouillon> {
  const o = objet(state);
  return o.assistant === VERSION_ASSISTANT ? etatDepuisAssistant(o) : etatDepuisAncien(o);
}

function etatDepuisAssistant(o: Record<string, unknown>): Partial<EtatBrouillon> {
  const contenus: Record<number, ContenuBrouillon> = {};
  for (const [cle, valeur] of Object.entries(objet(o.contenus))) {
    const rang = Number(cle);
    // ⚠️ Une clé de rang non numérique n'entre pas : `contenus` est indexé par RANG, et un `NaN` y
    // deviendrait une entrée que plus rien ne peut atteindre ni corriger.
    if (Number.isInteger(rang)) contenus[rang] = contenuDe(valeur);
  }
  const cat = dans(o.category, ['marketing', 'utility'] as const);
  return {
    ...(cat ? { category: cat } : {}),
    ...(dans(o.formule, ['whatsapp', 'rcs', 'repli'] as const) ? { formule: o.formule as FormuleCanal } : {}),
    ...(dans(o.premier, ['whatsapp', 'rcs'] as const) ? { premier: o.premier as CanalPremier } : {}),
    ...(dans(o.troisieme, ['aucun', 'email', 'sms'] as const) ? { troisieme: o.troisieme as TroisiemeNiveau } : {}),
    ...(booleen(o, 'reessayer') !== undefined ? { reessayer: booleen(o, 'reessayer')! } : {}),
    ...(booleen(o, 'heuresOuvrees') !== undefined ? { heuresOuvrees: booleen(o, 'heuresOuvrees')! } : {}),
    ...(typeof o.debitParMinute === 'number' ? { debitParMinute: debitBorne(o.debitParMinute) } : {}),
    contenus,
    ...(dans(o.assignation, ['aucune', 'personne', 'tour_de_role'] as const) ? { assignation: o.assignation as 'aucune' | 'personne' | 'tour_de_role' } : {}),
    assignationUserId: texte(o, 'assignationUserId') ?? null,
    ...(dans(o.etape, ['nom', 'canal', 'contenu', 'audience', 'recap'] as const)
      ? { etape: o.etape as 'nom' | 'canal' | 'contenu' | 'audience' | 'recap' } : {}),
    ...(dans(o.quand, ['maintenant', 'plus_tard'] as const) ? { quand: o.quand as 'maintenant' | 'plus_tard' } : {}),
    ...(texte(o, 'dateLocale') !== undefined ? { dateLocale: texte(o, 'dateLocale')! } : {}),
    audience: audienceDe(o.audience),
  };
}

/**
 * UN BROUILLON ÉCRIT PAR L'ANCIEN FORMULAIRE, traduit dans le modèle de l'assistant.
 *
 * 🔴 LES DEUX MODÈLES NE SE RESSEMBLENT PAS, ET LA TRADUCTION QUI COMPTE EST CELLE DU `mode`. L'ancien
 * écran posait une question unique (« un modèle, un scénario, ou un message RCS ? ») qui mélangeait le
 * CANAL et la FORME du contenu. L'assistant les a séparés, parce qu'une chaîne a besoin des deux par
 * ÉTAGE : `mode` devient donc un canal (`formule`) ET une formule d'étage.
 *
 * 🔴 ET `mode: 'workflow'` PORTE UN PIÈGE. L'ancien écran y gardait le modèle par lequel le scénario
 * OUVRE dans `templateName`, avec ses variables dans `vars`. L'assistant, lui, range ce modèle dans
 * `modeleDuScenario` : c'est de LUI qu'il compte les `{{n}}` à associer. Le relire dans `templateName`
 * laisserait les variables sans modèle connu, donc une liste d'associations que la garde de lancement
 * jugerait orpheline, sans rien à l'écran pour l'expliquer.
 *
 * ⚠️ TROIS RÉGLAGES DE L'ANCIEN ÉCRAN NE SONT PAS REPRIS, ET AUCUN N'EST PERDU : `phoneNumberId` et
 * `rcsAgentId` (l'assistant prend le premier numéro et le premier agent de l'espace, il ne pose pas la
 * question), et les boutons RCS, que l'ancien écran n'a JAMAIS enregistrés dans ses brouillons (vérifié
 * dans son `etatDuFormulaire` : `rcsAgentId`, `rcsText` et `rcsImage`, pas `rcsBoutons`). On ne peut pas
 * rendre ce qui n'a jamais été écrit.
 */
function etatDepuisAncien(o: Record<string, unknown>): Partial<EtatBrouillon> {
  const mode = dans(o.mode, ['template', 'workflow', 'rcs'] as const) ?? 'template';
  const nomModele = texte(o, 'templateName') ?? '';
  const langue = texte(o, 'templateLanguage') ?? 'fr';
  const vars = lignes(o.vars);
  const contenu: ContenuBrouillon = {
    formule: mode === 'workflow' ? 'avec_scenario' : 'seul',
    // ⚠️ L'ancien formulaire ne connaissait pas cette question : `mba` est ce qu'il FAISAIT réellement.
    devenir: 'mba',
    suggestions: [],
    ...(mode === 'rcs'
      ? {
        ...(texte(o, 'rcsText') !== undefined ? { texteRcs: texte(o, 'rcsText')! } : {}),
        ...(texte(o, 'rcsImage') !== undefined ? { imageRcs: texte(o, 'rcsImage')! } : {}),
      }
      : {}),
    ...(mode === 'template' && nomModele !== '' ? { templateName: nomModele, templateLanguage: langue } : {}),
    ...(mode === 'workflow'
      ? {
        ...(texte(o, 'workflowId') ? { workflowId: texte(o, 'workflowId')! } : {}),
        ...(nomModele !== '' ? { modeleDuScenario: { name: nomModele, language: langue } } : {}),
      }
      : {}),
    ...(vars && mode !== 'rcs' ? { variables: vars } : {}),
  };

  const cat = dans(o.category, ['marketing', 'utility'] as const);
  const toutFiltre = booleen(o, 'toutFiltre') ?? false;
  return {
    ...(cat ? { category: cat } : {}),
    // Un seul étage : l'ancien écran n'a jamais su faire de chaîne.
    formule: mode === 'rcs' ? 'rcs' : 'whatsapp',
    contenus: { 1: contenu },
    ...(booleen(o, 'heuresOuvrees') !== undefined ? { heuresOuvrees: booleen(o, 'heuresOuvrees')! } : {}),
    ...(typeof o.ratePerMinute === 'number' ? { debitParMinute: debitBorne(o.ratePerMinute) } : { debitParMinute: DEBIT_DEFAUT }),
    // ⚠️ `timing` S'APPELAIT AUTREMENT, et ses deux valeurs aussi : `now`/`later` deviennent
    // `maintenant`/`plus_tard`. Relire la clé sans traduire la valeur aurait rendu `undefined`, donc
    // « maintenant » par défaut, et une campagne programmée serait repartie tout de suite à la reprise.
    ...(o.timing === 'later' ? { quand: 'plus_tard' as const } : { quand: 'maintenant' as const }),
    ...(texte(o, 'scheduledLocal') !== undefined ? { dateLocale: texte(o, 'scheduledLocal')! } : {}),
    audience: {
      // ⚠️ `file` CÔTÉ ANCIEN ÉCRAN S'APPELLE `fichier` ICI. Un nom non traduit retomberait sur `crm`,
      // c'est-à-dire sur une liste de contacts, là où l'opérateur avait commencé un import.
      source: sourceAncienne(texte(o, 'source')),
      webhookId: texte(o, 'webhookId') ?? '',
      filtres: filtresRepris(o.filters),
      selection: { toutFiltre, selected: identifiants(o.selected), exclus: identifiants(o.exclus) },
    },
  };
}

/** Le nom de source de l'ancien écran -> celui de l'assistant. Ce qui n'est pas reconnu retombe sur `crm`. */
function sourceAncienne(v: string | undefined): SourceAudience {
  if (v === 'file') return 'fichier';
  if (v === 'hubspot') return 'hubspot';
  if (v === 'webhook') return 'webhook';
  return 'crm';
}
