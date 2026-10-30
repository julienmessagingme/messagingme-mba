import type { TemplateSummary } from '../meta/templates';
import type { IndiceDuTemplate } from '../crm/template-hints.pg';
import { resolveHintParams, type ParamSource, type ResolvableContact } from '../crm/template';
import { optInAllows } from '../campaign/guardrails';
import type { LectureModele } from '../api/modele-envoi';
import type { DepsEnvoiModeleDansLeFil } from '../inbox/envoi-operateur';
import type { PlafondPartage } from '../auth/plafond-partage';
import { MetaApiError } from '../meta/errors';
import { NumeroBloqueError } from '../meta/numero-delie';
import { CreditWhatsappRefus } from '../credit-whatsapp/refus';
import { LimiteOffreError, corpsRefusLimite } from '../offres/refus';
import { journaliser } from '../lib/journal';
import { catalogueTemplates, type EnteteTemplate } from './v1-catalogues';

/**
 * LES MODÈLES DE LA CARTE HUBSPOT (sous-lot « relancer » de la reprise humaine, plan
 * `~/mm-hubspot/docs/2026-10-26-sous-lot-relancer-modele-plan.md`, décisions A à H validées par Julien le 2026-10-26) :
 * ce que la carte propose pour UN contact quand la fenêtre de 24 h est fermée, et les refus de l'envoi. Fonctions pures et
 * dépendances ; les routes vivent dans `hubspot-conversation.ts`, avec les gardes communes.
 */

/** Ce que la route relit d'un modèle avant de l'envoyer (`templateVarInfo`, cache de cinq minutes). */
export interface ModeleRelu {
  /** Le jugement de `/v1/sends` (`verdictModele`) : statut, langue exacte, catégorie, nombre de variables. */
  verdict: LectureModele;
  /** Un carrousel ne part pas depuis HubSpot (décision F) : ses visuels se re-téléversent un par un. */
  carrousel: boolean;
  /** L'en-tête média du modèle, que la route prépare en `media id` (invariant 9) ; `null` sans en-tête média. */
  entete: { url: string; format: 'IMAGE' | 'VIDEO' | 'DOCUMENT' } | null;
}

export interface DepsModelesHubspot {
  /** « Envoyer des modèles depuis HubSpot » (`lireChoixHubspot(t).modeles`, décision E). */
  branches(tenantId: string): Promise<boolean>;
  /** Les modèles de l'espace tels que Meta les rend (`listerModeles`, cache d'une minute, celui de `GET /v1/templates`). */
  catalogue(tenantId: string): Promise<TemplateSummary[]>;
  /** Les sources des variables de l'espace (`template_param_hints`), lues une fois pour toute la liste. */
  indices(tenantId: string): Promise<IndiceDuTemplate[]>;
  /** Le consentement et les champs du contact (`getContactStateByWaId`), `null` hors base. */
  fiche(tenantId: string, waId: string): Promise<{ optIn: string; fiche: ResolvableContact } | null>;
  /** Le modèle relu, jamais reçu de la carte : sa catégorie et son nombre de variables viennent de Meta. */
  lire(tenantId: string, name: string, language: string): Promise<ModeleRelu>;
  /** Le `media id` de l'en-tête, re-téléversé sur le numéro d'envoi (`prepareHeaderMedia`) ; `null` s'il n'a pas pu l'être. */
  preparerEntete(tenantId: string, url: string): Promise<string | null>;
  /** Le chemin d'envoi d'un modèle de l'Inbox, tel quel (décision A) : il prend le fil et clôt l'escalade. */
  envoi: DepsEnvoiModeleDansLeFil;
  /** Les modèles par personne et par espace (`HUBSPOT_MODELES_PAR_MINUTE`, décision D), à part des réponses. */
  plafond: Pick<PlafondPartage, 'consommer'>;
  /**
   * 🔴 La préparation de l'en-tête (téléchargement chez Meta, re-téléversement) n'a pas de délai à elle : la route la
   * borne (`DELAI_ENTETE_DEFAUT_MS`), et la fait AVANT de poser la clé. Au-delà, refus sans rien réserver ni envoyer
   * (relecture du plan, le rouge).
   */
  delaiEnteteMs?: number;
}

/** Un modèle tel que la carte le propose pour un contact. */
export interface ModelePropose {
  name: string;
  language: string;
  category: 'marketing' | 'utility';
  header: EnteteTemplate;
  /** Le corps du modèle, ses `{{n}}` en clair : la personne voit ce qu'elle envoie. */
  texte: string;
  /** Une valeur pré-remplie depuis la fiche (vide si inconnue) et d'où elle vient. */
  variables: Array<{ position: number; valeur: string; libelle: string }>;
  /** Peut-il partir à CE contact (décision C) ? Sinon `raison` le dit. */
  envoyable: boolean;
  raison: string | null;
}

/** Les valeurs d'un modèle : autant que Meta en accepte dans un composant, 1 024 caractères chacune (l'outil de Claude). */
export const VALEURS_MAX = 50;
export const VALEUR_MAX_CARACTERES = 1024;

export const PHRASE_SANS_CONSENTEMENT =
  'Ce contact n’a pas donné son accord pour recevoir des messages marketing : seuls les modèles Service partent depuis HubSpot.';

/** D'où vient une valeur pré-remplie : le libellé de l'Inbox (`resolveTemplateParams`). */
function libelleDe(src: ParamSource | null): string {
  if (!src) return '';
  if (src.type === 'now') return 'date du jour';
  if (src.type === 'literal') return 'texte fixe';
  return src.key;
}

const statutConsentement = (s: string): 'opted_in' | 'opted_out' | 'unknown' =>
  (s === 'opted_in' || s === 'opted_out' ? s : 'unknown');

/**
 * Les modèles que la carte propose pour un contact : le catalogue de `GET /v1/templates` (approuvé, langue exacte,
 * catégorie connue, envoyable ; invariant 35), sans carrousel, chacun jugé par la règle du consentement des campagnes
 * (`optInAllows`, décision C) et pré-rempli depuis la fiche (`resolveHintParams`, la résolution de l'Inbox).
 */
export function modelesPourLeContact(
  templates: readonly TemplateSummary[],
  indices: readonly IndiceDuTemplate[],
  contact: { optIn: string; fiche: ResolvableContact },
  now: Date,
): ModelePropose[] {
  const sansCarrousel = templates.filter((t) => !t.carousel && !t.isCarousel);
  const corps = new Map(sansCarrousel.map((t) => [JSON.stringify([t.name, t.language]), t.body]));
  const consentement = { optInStatus: statutConsentement(contact.optIn) };
  return catalogueTemplates(sansCarrousel, indices).map((m) => {
    const sources = m.variables.flatMap((v) => (v.source ? [{ position: v.position, source: v.source }] : []));
    const { values } = resolveHintParams(sources, m.variables.length, contact.fiche, { now });
    const envoyable = optInAllows(m.category, consentement);
    return {
      name: m.name,
      language: m.language,
      category: m.category,
      header: m.header,
      texte: corps.get(JSON.stringify([m.name, m.language])) ?? '',
      variables: m.variables.map((v, i) => ({ position: v.position, valeur: values[i] ?? '', libelle: libelleDe(v.source) })),
      envoyable,
      raison: envoyable ? null : PHRASE_SANS_CONSENTEMENT,
    };
  });
}

/** Un refus rendu tel quel par la route, et transmis tel quel par le connecteur (il porte toujours un `code`). */
export interface RefusModele { statut: number; corps: { error: string; code: string } & Record<string, unknown> }

/**
 * Le modèle relu peut-il partir avec ces valeurs ? Les codes de `modeleEnvoyable` (`/v1/sends`), plus le carrousel.
 * Sinon sa catégorie, lue chez Meta, celle qui choisit la Marketing Messages API et la règle du consentement.
 */
export function refusDuModele(lu: ModeleRelu, nbValeurs: number): RefusModele | { categorie: 'marketing' | 'utility' } {
  const v = lu.verdict;
  if (v.statut === 'absent') {
    return { statut: 404, corps: { error: 'Ce modèle est introuvable, n’est plus approuvé ou n’existe pas dans cette langue.', code: 'template_not_found' } };
  }
  if (v.statut === 'illisible') {
    return { statut: 422, corps: { error: 'La catégorie de ce modèle n’a pas pu être lue chez Meta : réessayez dans un instant.', code: 'template_category_unknown' } };
  }
  if (v.statut === 'categorie_non_admise') {
    return { statut: 422, corps: { error: 'Seuls les modèles Marketing et Service partent depuis HubSpot.', code: 'template_category_unknown' } };
  }
  if (v.statut === 'non_envoyable') {
    return { statut: 422, corps: { error: `Ce modèle ne peut pas partir : ${v.raison}.`, code: 'unsendable_target' } };
  }
  if (lu.carrousel) {
    return { statut: 422, corps: { error: 'Un modèle carrousel ne part pas depuis HubSpot : envoyez-le depuis la console.', code: 'carousel_unsupported' } };
  }
  if (nbValeurs !== v.variables) {
    return { statut: 422, corps: { error: `Ce modèle attend ${v.variables} valeur(s), ${nbValeurs} reçue(s).`, code: 'unsendable_target' } };
  }
  return { categorie: v.categorie };
}

/**
 * 🔴 UN REFUS QUI N'A RIEN ENVOYÉ, levé par le chemin d'envoi : la clé se rend, un nouvel essai peut partir (décision H).
 * Un refus explicite de Meta, un numéro délié ou suspendu (levé avant Meta par la fabrique), la limite des modèles du mois
 * (avant Meta aussi, sur un modèle seulement). `null` : toute autre erreur laisse un doute (délai, réseau), la clé reste
 * « en cours » jusqu'à son bail plutôt que d'écrire deux fois au client.
 */
export function refusAvantEnvoi(err: unknown): RefusModele | null {
  if (err instanceof MetaApiError) {
    // La phrase de Meta pour la personne (comme le gestionnaire commun), avec un code : la carte la montre telle quelle.
    const detail = (err.userMessage ?? err.message).replace(/\s+/g, ' ').trim().slice(0, 200);
    return { statut: 422, corps: { error: `Meta a refusé le message : ${detail}`, code: 'meta_rejected' } };
  }
  if (err instanceof NumeroBloqueError) {
    return { statut: 409, corps: { error: err.message, code: err.motif === 'numero_delie' ? 'number_unlinked' : 'number_suspended' } };
  }
  if (err instanceof LimiteOffreError) return { statut: 402, corps: corpsRefusLimite(err) };
  // Le Crédit WhatsApp a refusé avant tout appel à Meta : rien n'est parti, la clé se rend.
  if (err instanceof CreditWhatsappRefus) return { statut: err.statusCode, corps: { error: err.message, code: err.code } };
  return null;
}

/**
 * La durée maximale de la préparation de l'en-tête, par défaut. Sous les 8 s où le connecteur coupe mba (relecture du lot) :
 * au-delà, un refus NET avant la clé (la préparation continue en arrière-plan et son cache sert l'essai suivant) vaut mieux
 * qu'un envoi parti pendant que la carte reçoit un 504 « incertain ».
 */
export const DELAI_ENTETE_DEFAUT_MS = 5_000;

/**
 * Le `media id` de l'en-tête, ou un refus. Bornée par une course : la préparation qui traîne continue en arrière-plan
 * (son cache servira l'essai suivant), la requête, elle, s'arrête sans avoir rien réservé ni envoyé.
 */
export async function enteteBornee(
  deps: Pick<DepsModelesHubspot, 'preparerEntete' | 'delaiEnteteMs'>,
  tenantId: string,
  entete: NonNullable<ModeleRelu['entete']>,
): Promise<{ mediaId: string } | RefusModele> {
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<'delai'>((resolve) => { minuterie = setTimeout(() => resolve('delai'), deps.delaiEnteteMs ?? DELAI_ENTETE_DEFAUT_MS); });
  try {
    const issue = await Promise.race([deps.preparerEntete(tenantId, entete.url).catch(() => null), delai]);
    if (issue === 'delai') {
      // Tracé : la durée réelle d'une préparation à froid se lit ici (essai réel du plan). Un 4xx codé, que le connecteur
      // transmet tel quel (un 5xx y deviendrait une panne générique).
      journaliser('warn', 'hubspot_entete_lent', { tenantId, delaiMs: deps.delaiEnteteMs ?? DELAI_ENTETE_DEFAUT_MS });
      return { statut: 422, corps: { error: 'Le visuel du modèle met trop de temps à se préparer : réessayez dans un instant.', code: 'header_media_slow' } };
    }
    if (issue === null) {
      return { statut: 422, corps: { error: 'Le visuel du modèle n’a pas pu être préparé pour l’envoi : réessayez, ou envoyez-le depuis la console.', code: 'header_media_unavailable' } };
    }
    return { mediaId: issue };
  } finally {
    clearTimeout(minuterie);
  }
}
