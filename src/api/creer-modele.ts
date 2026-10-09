import { creerUnModele, refusDesChamps, type TemplateRouteDeps } from '../http/templates';
import { MetaApiError } from '../meta/errors';
import { MediaUploadError } from '../meta/media';
import { isValidTemplateLanguage } from '../meta/languages';
import type { CodeApi } from './erreurs';
import { versModeleConsole, type ModeleMeta } from './modele-meta';
import type { FormatEntete } from './entete-par-url';

/**
 * LES MODÈLES PAR L'API ET PAR CLAUDE (lot 13, domaine 3) : `POST /v1/templates` et l'outil `create_template` partagent
 * CE chemin, qui ne fait que traduire et déposer l'en-tête, puis passe par `creerUnModele`, la création de l'écran
 * Modèles. Aucune garde ici que la console n'aurait pas : une garde ajoutée l'est dans `creerUnModele`.
 */

export interface DepsCreationModele {
  /** Les dépendances de l'écran Modèles, le MÊME objet (`src/index.ts`). */
  modeles: TemplateRouteDeps;
  /** Le téléchargement gardé d'une adresse saisie par un client : `telechargerEnteteProduction` en production. */
  telechargerEntete(format: FormatEntete, url: string): Promise<{ octets: Buffer; mime: string } | { refus: string }>;
  /** Le dépôt chez Meta (Resumable Upload), qui rend le `header_handle` : le `uploadImage` de l'écran Modèles. */
  deposerEntete(octets: Buffer, mime: string): Promise<string>;
  /**
   * Les places d'en-tête de la copie (`placesDeTelechargement`) : une place est TENUE du téléchargement à la fin du dépôt
   * chez Meta, le fichier (jusqu'à 16 Mo) restant en mémoire jusque-là. `null` : toutes prises.
   */
  placesEntete: { prendre(): (() => void) | null };
}

/**
 * Un refus, rendu par la route en `{ error, code }` et par l'outil en `RefusOutil`. `reessayerDansS` : un refus
 * passager, que la route accompagne d'un `Retry-After` (sans lui, un client réessaie aussitôt).
 */
export interface RefusModele { statut: number; code: CodeApi; message: string; reessayerDansS?: number }

export interface ModeleCree {
  id: string;
  name: string;
  language: string;
  /** Celle de Meta, en minuscules : il peut reclasser un utility en marketing. */
  category: string;
  /** `pending`, `approved` ou `rejected` à la création. */
  status: string;
}

/**
 * Ce qu'une erreur de Meta veut dire pour l'appelant, ou `null` (une panne inconnue, qui reste une erreur du serveur) :
 *  - le JETON de l'espace refusé (401, code 190) : le modèle n'y est pour rien, le compte est à reconnecter ;
 *  - un refus PASSAGER (limite, panne de Meta, dépôt sans handle) : à réessayer, avec son délai ;
 *  - un refus du CONTENU (4xx terminal) : son motif, le lisible de Meta (`error_user_msg`) d'abord.
 */
export function refusDeMeta(err: unknown): RefusModele | null {
  if (err instanceof MediaUploadError) {
    return { statut: 429, code: 'rate_limited', message: 'le dépôt du fichier d’en-tête chez Meta a échoué : réessayez dans un instant', reessayerDansS: 30 };
  }
  if (!(err instanceof MetaApiError)) return null;
  if (err.httpStatus === 401 || err.code === 190) {
    return { statut: 409, code: 'meta_auth_failed', message: 'Meta refuse le jeton de l’espace : reconnectez le compte WhatsApp depuis la console' };
  }
  if (err.retryable) {
    const s = err.retryAfterMs !== undefined ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : 30;
    return { statut: 429, code: 'rate_limited', message: 'Meta ne répond pas pour l’instant (limite ou panne passagère) : réessayez dans un instant', reessayerDansS: s };
  }
  if (err.httpStatus >= 400 && err.httpStatus < 500) {
    return { statut: 422, code: 'meta_rejected', message: `Meta a refusé le modèle : ${(err.userMessage ?? err.message).slice(0, 300)}` };
  }
  return null;
}

const AUCUN_COMPTE: RefusModele = { statut: 409, code: 'no_whatsapp_number', message: 'aucun compte WhatsApp n’est relié à cet espace' };
const OCCUPE: RefusModele = {
  statut: 429, code: 'rate_limited', message: 'trop de fichiers d’en-tête en cours de dépôt, réessayez dans un instant', reessayerDansS: 2,
};

/** Un refus des gardes de la console, sous un code de l'API. Un 422 de `refusDesChamps` est une panne de lecture : à réessayer. */
function refusDeLaConsole(r: { statut: 400 | 422; error: string }): RefusModele {
  if (r.statut === 400) return { statut: 400, code: 'invalid_body', message: r.error };
  return { statut: 429, code: 'rate_limited', message: r.error, reessayerDansS: 5 };
}

/** Télécharge l'en-tête et le dépose chez Meta en tenant une place de la copie : le handle, ou un refus. */
async function deposerLEntete(deps: DepsCreationModele, format: FormatEntete, url: string): Promise<{ handle: string } | { refus: RefusModele }> {
  const rendre = deps.placesEntete.prendre();
  if (rendre === null) return { refus: OCCUPE };
  try {
    const fichier = await deps.telechargerEntete(format, url);
    if ('refus' in fichier) return { refus: { statut: 422, code: 'invalid_header_media', message: `en-tête : ${fichier.refus}` } };
    return { handle: await deps.deposerEntete(fichier.octets, fichier.mime) };
  } finally {
    rendre();
  }
}

/** Crée le modèle, corps déjà validé par `schemaModeleMeta`. Une erreur de Meta connue devient un refus, une panne lève. */
export async function creerModeleDepuisMeta(deps: DepsCreationModele, tenantId: string, lu: ModeleMeta): Promise<{ refus: RefusModele } | { modele: ModeleCree }> {
  const { input, enteteMedia } = versModeleConsole(lu);
  // Avant de télécharger quoi que ce soit : un espace sans compte n'a rien à déposer.
  if (!(await deps.modeles.repo.getTenantWabaId(tenantId))) return { refus: AUCUN_COMPTE };
  try {
    let complet = input;
    if (enteteMedia) {
      // La seule garde de la console qui peut refuser ce corps (les champs `{cle}` des liens), avant de télécharger et de
      // déposer jusqu'à 16 Mo pour rien. `creerUnModele` la rejoue : elle ne lit les champs que si une adresse en porte.
      const avant = await refusDesChamps(deps.modeles, tenantId, input);
      if (avant) return { refus: refusDeLaConsole(avant) };
      const depot = await deposerLEntete(deps, enteteMedia.format, enteteMedia.url);
      if ('refus' in depot) return depot;
      complet = { ...input, header: { format: enteteMedia.format, handle: depot.handle } };
    }
    const issue = await creerUnModele(deps.modeles, tenantId, complet);
    if (!('res' in issue)) {
      if (issue.motif === 'compte') return { refus: AUCUN_COMPTE };
      if (issue.motif === 'champs') return { refus: refusDeLaConsole(issue) };
      return { refus: { statut: issue.statut, code: issue.statut === 400 ? 'invalid_body' : 'template_rejected', message: issue.error } };
    }
    return {
      modele: {
        id: issue.res.id, name: input.name, language: input.language,
        category: issue.res.category.toLowerCase(), status: issue.res.status.toLowerCase(),
      },
    };
  } catch (err) {
    const refus = refusDeMeta(err);
    if (refus !== null) return { refus };
    throw err;
  }
}

/** Le statut d'une langue, tel que l'API et Claude le rendent. */
export interface StatutLangue { language: string; status: string; category: string | null; rejectedReason: string | null }

/** Un nom de modèle tel que Meta les accepte : un autre ne peut pas exister, il est donc inconnu. */
export const estNomDeModele = (n: string): boolean => /^[a-z0-9_]{1,512}$/.test(n);

/** Le statut de chaque langue d'un modèle, ou un refus (aucun compte, modèle inconnu, langue hors liste, Meta). */
export async function statutsDuModele(
  deps: Pick<DepsCreationModele, 'modeles'>,
  tenantId: string,
  name: string,
  language?: string,
): Promise<{ refus: RefusModele } | { name: string; languages: StatutLangue[] }> {
  if (language !== undefined && !isValidTemplateLanguage(language)) {
    return { refus: { statut: 400, code: 'invalid_body', message: 'language : langue hors de la liste WhatsApp (fr, en_US, es…)' } };
  }
  const inconnu: RefusModele = { statut: 404, code: 'template_not_found', message: 'modèle inconnu' };
  if (!estNomDeModele(name)) return { refus: inconnu };
  const waba = await deps.modeles.repo.getTenantWabaId(tenantId);
  if (!waba) return { refus: AUCUN_COMPTE };
  let tous;
  try {
    tous = await (await deps.modeles.meta.templateClientForTenant(tenantId)).statutsDuNom(waba, name);
  } catch (err) {
    const refus = refusDeMeta(err);
    if (refus !== null) return { refus };
    throw err;
  }
  const retenus = tous.filter((s) => language === undefined || s.language === language);
  if (retenus.length === 0) return { refus: inconnu };
  return {
    name,
    languages: retenus.map((s) => ({
      language: s.language, status: s.status.toLowerCase(), category: s.category?.toLowerCase() ?? null, rejectedReason: s.rejectedReason,
    })),
  };
}
