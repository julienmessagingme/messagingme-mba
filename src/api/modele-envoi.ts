import type { TemplateSummary } from '../meta/templates';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import { countTemplateVariables, type TemplateParam } from '../crm/template';
import { estLienTraceAvecJeton } from '../links/rewrite';
import type { CodeApi } from './erreurs';
import type { CampaignCategory } from '../campaign/types';

/**
 * Ce qu'un envoi par l'API sait d'un template, lu chez Meta.
 *
 * 🔴 La catégorie n'est pas déclarée par l'appelant : un template marketing annoncé « utility » partirait aux
 * contacts dont le consentement est inconnu. Elle se lit chez Meta, par la lecture partagée de l'Inbox
 * (`templateVarInfo`) et son cache.
 *
 * - `absent` : introuvable, pas approuvé, ou d'une autre langue (l'API vise une langue précise, sans repli
 *   sur le nom seul) ;
 * - `illisible` n'est jamais ramené à « utility » : dans le doute, l'envoi est refusé ;
 * - `categorie_non_admise` : la catégorie est lue mais pas de celles que l'API envoie, réessayer n'y changera
 *   rien ;
 * - `non_envoyable` : approuvé, mais aucun envoi ne peut partir ; catalogue et envoi jugent par la même
 *   fonction (`raisonNonEnvoyable`).
 */
export type LectureModele =
  /**
   * `variables` : le nombre de variables du corps (la plus haute position `{{n}}`), celui que Meta exige à
   * chaque envoi ; `params` doit en décrire exactement autant.
   */
  | { statut: 'approuve'; categorie: 'marketing' | 'utility'; variables: number }
  | { statut: 'absent' }
  | { statut: 'illisible' }
  | { statut: 'categorie_non_admise'; categorie: string }
  | { statut: 'non_envoyable'; raison: string };

/** Ce que la lecture partagée rend d'un template (`TplInfo`, `src/workflow/envois-bloc.ts`), réduit à ce qui sert ici. */
export interface ModeleLu {
  statut?: string;
  langue?: string;
  category?: string;
  /** Le nombre de variables du corps, tel que la lecture partagée le calcule. */
  count: number;
  /**
   * Pourquoi aucun envoi de ce template ne peut partir (`raisonNonEnvoyable`), `null` s'il le peut. Requis :
   * une lecture qui l'oublierait ne compile pas, au lieu de laisser passer ce que le catalogue écarte.
   */
  nonEnvoyable: string | null;
}

/**
 * Les formats d'en-tête qu'un envoi sait porter. Un `Set` et pas un objet littéral : sur un objet, un format que
 * Meta inventerait demain sous le nom `toString` y serait « trouvé ».
 */
const ENTETES_ENVOYABLES: ReadonlySet<string> = new Set(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);

/** Ce que `raisonNonEnvoyable` lit d'un template, tel que Meta le rend (`TemplateSummary`). */
export type FormeDuModele = Pick<TemplateSummary, 'headerFormat' | 'headerText' | 'headerMediaUrl' | 'buttons' | 'carousel'>;

/**
 * Pourquoi aucun envoi de ce template ne peut partir, ou `null`. Une fonction pour ses deux lecteurs : le
 * catalogue (`GET /v1/templates`) et l'envoi (`POST /v1/sends`), qui refuse en 422 au lieu d'un 201 suivi
 * d'un échec par destinataire.
 *
 * - un en-tête d'un format qu'un envoi ne sait pas remplir (localisation) ;
 * - ce que le moteur d'envoi refuse avant de partir, par ses fonctions (`carouselSendBlocker`,
 *   `headerMediaSendBlocker`) ; l'adresse d'un visuel tient lieu de l'identifiant que l'envoi obtiendra en
 *   le re-téléversant ;
 * - un paramètre qu'aucun chemin d'envoi ne remplit et que Meta exigerait (132000) : un en-tête texte à
 *   variable, un bouton de lien de premier niveau à variable, sauf un lien tracé à jeton.
 */
export function raisonNonEnvoyable(t: FormeDuModele): string | null {
  if (t.headerFormat !== null && !ENTETES_ENVOYABLES.has(t.headerFormat)) {
    return `son en-tête (${t.headerFormat.slice(0, 20).toLowerCase()}) ne se remplit pas à l’envoi`;
  }
  if (t.carousel) {
    const carte = carouselSendBlocker(t.carousel.cards.map((c) => ({ ...c, mediaId: c.mediaId ?? c.mediaUrl })));
    if (carte !== null) return carte;
  }
  const entete = headerMediaSendBlocker(t.headerFormat ?? undefined, t.headerMediaUrl);
  if (entete !== null) return entete;
  if (t.headerFormat === 'TEXT' && countTemplateVariables(t.headerText ?? '') > 0) {
    return 'son en-tête texte porte une variable, qu’aucun envoi ne remplit';
  }
  const bouton = (t.buttons ?? []).find((b) => b.type === 'URL' && countTemplateVariables(b.url ?? '') > 0 && !estLienTraceAvecJeton(b.url ?? ''));
  if (bouton) return `son bouton de lien « ${bouton.text.slice(0, 40)} » porte une variable, qu’aucun envoi ne remplit`;
  return null;
}

/**
 * Ce qu'un envoi sait d'un template, construit depuis ce que Meta en rend, pour la lecture partagée et le
 * catalogue. Catégorie passée en minuscules ; une catégorie vide est absente (donc illisible, jamais
 * « utility »).
 */
export function modeleLuDe(t: TemplateSummary): ModeleLu & { statut: string; langue: string } {
  return {
    count: countTemplateVariables(t.body),
    statut: t.status,
    langue: t.language,
    ...(t.category ? { category: t.category.toLowerCase() } : {}),
    nonEnvoyable: raisonNonEnvoyable(t),
  };
}

export function verdictModele(info: ModeleLu | null, langue: string): LectureModele {
  if (info === null || info.langue !== langue || info.statut !== 'APPROVED') return { statut: 'absent' };
  if (info.category === 'marketing' || info.category === 'utility') {
    if (info.nonEnvoyable !== null) return { statut: 'non_envoyable', raison: info.nonEnvoyable };
    return { statut: 'approuve', categorie: info.category, variables: info.count };
  }
  if (info.category !== undefined && info.category !== '') return { statut: 'categorie_non_admise', categorie: info.category };
  return { statut: 'illisible' };
}

/** Un refus d'envoi, dans le vocabulaire de l'API publique : son statut HTTP, son code, sa phrase. */
export type RefusEnvoi = { refus: { statut: 400 | 404 | 409 | 422; code: CodeApi; message: string } };

/**
 * Ce que lisent les trois fonctions ci-dessous. Partagées par `POST /v1/sends` et par l'outil `prepare_campaign` de
 * l'assistant (plan « Campagnes depuis Claude ») : un modèle jugé envoyable à un endroit l'est à l'autre.
 */
export interface DepsModeleEnvoyable {
  /** Le template lu chez Meta : sa catégorie, ou pourquoi il ne peut pas partir (`verdictModele`). */
  lireModele(tenantId: string, name: string, language: string): Promise<LectureModele>;
  repo: {
    getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
    phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  };
}

/**
 * Un template qui va partir, lu chez Meta : sa catégorie, ce qui l'empêcherait de partir, et le nombre de
 * variables de son corps. Sert la cible `template` et le template d'ouverture d'un scénario ou d'un bloc.
 * Le nombre de variables se vérifie avant l'envoi : sinon Meta refuserait chaque destinataire après un 201.
 * `params` à `null` = un bloc, dont le template résout ses variables par les sources de la console : rien à
 * comparer. `non_envoyable` est jugé par la fonction du catalogue (`raisonNonEnvoyable`). `illisible` n'est
 * jamais ramené à « utility ».
 */
export async function modeleEnvoyable(
  deps: Pick<DepsModeleEnvoyable, 'lireModele'>, tenantId: string, name: string, language: string, params: TemplateParam[] | null, quoi: string,
): Promise<{ categorie: CampaignCategory } | RefusEnvoi> {
  const lu = await deps.lireModele(tenantId, name, language);
  if (lu.statut === 'absent') {
    return { refus: { statut: 404, code: 'template_not_found', message: `${quoi} introuvable, non approuvé ou d’une autre langue : ${name} (${language})` } };
  }
  if (lu.statut === 'illisible') {
    return { refus: { statut: 422, code: 'template_category_unknown', message: `la catégorie de ce ${quoi} n’a pas pu être lue chez Meta : l’envoi est refusé par prudence, réessayez dans un instant` } };
  }
  if (lu.statut === 'categorie_non_admise') {
    // Lue, et définitive : réessayer n'y changera rien, le message ne doit pas le suggérer.
    return { refus: { statut: 422, code: 'template_category_unknown', message: `catégorie ${lu.categorie.slice(0, 40)} non envoyable par l’API : un template marketing ou utility est attendu` } };
  }
  if (lu.statut === 'non_envoyable') {
    return { refus: { statut: 422, code: 'unsendable_target', message: `le ${quoi} ${name} ne peut partir par aucun envoi : ${lu.raison}. Il n’apparaît pas dans GET /v1/templates` } };
  }
  if (params !== null && params.length !== lu.variables) {
    return { refus: { statut: 422, code: 'unsendable_target', message: `le ${quoi} ${name} attend ${lu.variables} variable(s) dans son corps et params en décrit ${params.length} : Meta refuserait chaque message` } };
  }
  return { categorie: lu.categorie };
}

/**
 * 🔴 La catégorie ne se relâche jamais : celle que Meta donne au template qui part l'emporte sur une déclaration
 * plus permissive (un marketing annoncé « utility » partirait sinon aux contacts sans consentement). Une
 * déclaration plus stricte est gardée.
 */
export function categoriePlusStricte(lue: CampaignCategory, declaree: CampaignCategory): CampaignCategory {
  return lue === 'marketing' || declaree === 'marketing' ? 'marketing' : 'utility';
}

export async function numeroDEnvoi(deps: Pick<DepsModeleEnvoyable, 'repo'>, tenantId: string, demande: string | undefined): Promise<{ phoneNumberId: string } | RefusEnvoi> {
  if (demande !== undefined) {
    return await deps.repo.phoneNumberBelongsToTenant(demande, tenantId)
      ? { phoneNumberId: demande }
      : { refus: { statut: 400, code: 'invalid_body', message: 'phoneNumberId : numéro inconnu de cet espace' } };
  }
  const defaut = await deps.repo.getTenantPhoneNumberId(tenantId);
  return defaut
    ? { phoneNumberId: defaut }
    : { refus: { statut: 409, code: 'no_whatsapp_number', message: 'aucun numéro WhatsApp connecté sur cet espace' } };
}
