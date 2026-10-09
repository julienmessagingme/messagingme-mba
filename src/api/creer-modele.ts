import { creerUnModele, type TemplateRouteDeps } from '../http/templates';
import { MetaApiError } from '../meta/errors';
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
  telechargerEntete(format: FormatEntete, url: string): Promise<{ octets: Buffer; mime: string } | { refus: string; reessayer?: true }>;
  /** Le dépôt chez Meta (Resumable Upload), qui rend le `header_handle` : le `uploadImage` de l'écran Modèles. */
  deposerEntete(octets: Buffer, mime: string): Promise<string>;
}

/** Un refus, rendu par la route en `{ error, code }` et par l'outil en `RefusOutil`. */
export interface RefusModele { statut: number; code: CodeApi; message: string }

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
 * Un refus de Meta sur ce qu'on lui soumet (4xx non transitoire) : sa phrase, sinon `null` (une panne, qui reste une
 * erreur du serveur). Le motif lisible de Meta (`error_user_msg`) d'abord.
 */
export function refusDeMeta(err: unknown): string | null {
  if (!(err instanceof MetaApiError) || err.httpStatus < 400 || err.httpStatus >= 500 || err.retryable) return null;
  return `Meta a refusé le modèle : ${(err.userMessage ?? err.message).slice(0, 300)}`;
}

const AUCUN_COMPTE: RefusModele = { statut: 409, code: 'no_whatsapp_number', message: 'aucun compte WhatsApp n’est relié à cet espace' };

/** Crée le modèle, corps déjà validé par `schemaModeleMeta`. Un refus de Meta devient un refus, une panne lève. */
export async function creerModeleDepuisMeta(deps: DepsCreationModele, tenantId: string, lu: ModeleMeta): Promise<{ refus: RefusModele } | { modele: ModeleCree }> {
  const { input, enteteMedia } = versModeleConsole(lu);
  // Avant de télécharger quoi que ce soit : un espace sans compte n'a rien à déposer.
  if (!(await deps.modeles.repo.getTenantWabaId(tenantId))) return { refus: AUCUN_COMPTE };
  try {
    let complet = input;
    if (enteteMedia) {
      const fichier = await deps.telechargerEntete(enteteMedia.format, enteteMedia.url);
      if ('refus' in fichier) {
        // Toutes les places de téléchargement prises : à réessayer, comme un plafond, et non un fichier refusé.
        if ('reessayer' in fichier) return { refus: { statut: 429, code: 'rate_limited', message: fichier.refus } };
        return { refus: { statut: 422, code: 'invalid_header_media', message: `en-tête : ${fichier.refus}` } };
      }
      complet = { ...input, header: { format: enteteMedia.format, handle: await deps.deposerEntete(fichier.octets, fichier.mime) } };
    }
    const issue = await creerUnModele(deps.modeles, tenantId, complet);
    if (!('res' in issue)) {
      if (issue.motif === 'compte') return { refus: AUCUN_COMPTE };
      return { refus: { statut: issue.statut, code: issue.statut === 400 ? 'invalid_body' : 'template_rejected', message: issue.error } };
    }
    return {
      modele: {
        id: issue.res.id, name: input.name, language: input.language,
        category: issue.res.category.toLowerCase(), status: issue.res.status.toLowerCase(),
      },
    };
  } catch (err) {
    const motif = refusDeMeta(err);
    if (motif !== null) return { refus: { statut: 422, code: 'meta_rejected', message: motif } };
    throw err;
  }
}

/** Le statut d'une langue, tel que l'API et Claude le rendent. */
export interface StatutLangue { language: string; status: string; category: string | null; rejectedReason: string | null }

/** Un nom de modèle tel que Meta les accepte : un autre ne peut pas exister, il est donc inconnu. */
export const estNomDeModele = (n: string): boolean => /^[a-z0-9_]{1,512}$/.test(n);

/** Le statut de chaque langue d'un modèle, ou un refus (aucun compte, modèle inconnu, langue hors liste). */
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
  const tous = await (await deps.modeles.meta.templateClientForTenant(tenantId)).statutsDuNom(waba, name);
  const retenus = tous.filter((s) => language === undefined || s.language === language);
  if (retenus.length === 0) return { refus: inconnu };
  return {
    name,
    languages: retenus.map((s) => ({
      language: s.language, status: s.status.toLowerCase(), category: s.category?.toLowerCase() ?? null, rejectedReason: s.rejectedReason,
    })),
  };
}
