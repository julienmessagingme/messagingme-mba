import { randomInt } from 'node:crypto';
import { sha256Hex } from '../lib/signature';
import type { CampaignCategory } from './types';
import type { TemplateParam } from '../crm/template';

/**
 * LA CONFIRMATION D'UNE CAMPAGNE PRÉPARÉE PAR L'ASSISTANT (spec « Campagnes depuis Claude ») : `prepare_campaign`
 * rend un récapitulatif et un code, `launch_campaign` exige ce code. Ce qui garantit le « oui » humain, c'est
 * l'annotation `destructiveHint` et la consigne de l'outil ; le code garantit l'autre moitié, que le lancement porte
 * sur EXACTEMENT ce qui a été montré : il est lié à l'empreinte de l'état de la campagne, et toute différence le rend
 * inutilisable. Six caractères, usage unique, 30 minutes.
 */

/** Sans 0, O, 1 ni I : un code relu à voix haute ou recopié ne se confond pas. */
export const ALPHABET_CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LONGUEUR_CODE = 6;
export const DUREE_CODE_MS = 30 * 60 * 1000;

/** L'état d'une campagne tel que le récapitulatif l'a montré, relu en base aux deux bouts. */
export interface EtatConfirme {
  templateName: string;
  templateLanguage: string;
  category: CampaignCategory;
  /** La date prévue, en ISO, ou null pour un lancement immédiat. */
  prevueLe: string | null;
  paramMapping: TemplateParam[];
  /** Les destinataires en attente. */
  recipientCount: number;
  status: string;
}

/** Un JSON à clés triées : la même valeur donne le même texte, quel que soit l'ordre de construction. */
function canonique(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonique).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonique((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function empreinteEtat(e: EtatConfirme): string {
  return sha256Hex(canonique(e));
}

export function nouveauCode(): string {
  return Array.from({ length: LONGUEUR_CODE }, () => ALPHABET_CODE[randomInt(ALPHABET_CODE.length)]).join('');
}

/** Le code n'est jamais gardé en clair. Casse et espaces d'une recopie n'y changent rien. */
export function empreinteCode(code: string): string {
  return sha256Hex(code.trim().toUpperCase());
}

export type IssueReclamation = 'ok' | 'invalide' | 'expire' | 'utilise' | 'modifie';

/**
 * Les confirmations en base (`campagne_confirmations`, migration 0245). 🔴 Chaque requête filtre `tenant_id` : c'est
 * le seul contrôle d'isolation. Une ligne présente dit aussi que le brouillon vient de l'assistant.
 */
export interface ConfirmationStore {
  /** Pose (ou renouvelle) le code d'une campagne de l'espace. `null` : la campagne n'est pas de cet espace. */
  poser(tenantId: string, campaignId: string, etat: string): Promise<{ code: string; expireLe: Date } | null>;
  /** Consomme le code, atomiquement : deux appels simultanés, un seul `ok`. */
  reclamer(tenantId: string, campaignId: string, code: string, etat: string): Promise<IssueReclamation>;
  /** Rend un code consommé, quand le lancement a été refusé après la réclamation. */
  rendre(tenantId: string, campaignId: string): Promise<void>;
  /** Le brouillon a-t-il été préparé depuis l'assistant ? */
  existe(tenantId: string, campaignId: string): Promise<boolean>;
}
