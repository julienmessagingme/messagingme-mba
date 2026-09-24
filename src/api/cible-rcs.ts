import { z } from 'zod';
import type { CodeApi } from './erreurs';
import type { RcsOutbound } from '../rcs/types';

/**
 * LA CIBLE `rcsMessage` DE `POST /v1/sends` (spec 2026-09-24, § 3, lot 3) : un message de Contenu > Messages
 * RCS, désigné par son NOM (unique par espace en base, index partiel `rcs_messages_tenant_name`, 0077).
 *
 * Elle donne l'ouverture `rcs` : aucun numéro WhatsApp n'est exigé (le message part de l'agent RCS de
 * l'espace), la catégorie est obligatoire (elle décide du consentement exigé), et `params` n'a pas de sens
 * (ses `{{variables}}` viennent de `recipients[].variables`). Ces règles de FORME vivent dans `lireCible`
 * (`src/http/v1-sends.ts`), avec celles des autres cibles ; ce module fait les LECTURES et le suivi.
 */

/**
 * La borne d'un nom dans la bibliothèque (`lireNom`, `src/http/rcs-messages.ts`, 120 caractères). Un nom plus
 * long ne désigne aucun message : refusé en forme plutôt que cherché.
 */
export const NOM_MESSAGE_RCS_MAX = 120;

/** Le noyau `{ rcsMessage }` de l'union des cibles de la route. */
export const schemaCibleRcs = z.strictObject({ rcsMessage: z.string().trim().min(1).max(NOM_MESSAGE_RCS_MAX) });

/**
 * Le préfixe du nom d'un envoi de l'API dans Campagnes. 🔴 UNE SEULE ÉCRITURE : la route de `/v1/sends` le
 * pose, `nomDuMessageRcs` le retire. Recopié en littéral à l'un des deux endroits, il divergerait en silence.
 */
export const PREFIXE_ENVOI_API = '[API] ';

export interface DepsCibleRcs {
  messageRcsParNom(tenantId: string, nom: string): Promise<{ name: string; content: RcsOutbound | null } | null>;
  agentIdForTenant(tenantId: string): Promise<string | null>;
}

export type CibleRcs =
  | { ok: true; nom: string; agentId: string; contenu: RcsOutbound }
  | { ok: false; statut: 404 | 409 | 422; code: Extract<CodeApi, 'rcs_message_not_found' | 'rcs_not_enabled' | 'unsendable_target'>; message: string };

/** Le message, PUIS l'agent : un message introuvable ne coûte pas la lecture de l'agent. */
export async function resoudreCibleRcs(deps: DepsCibleRcs, tenantId: string, nom: string): Promise<CibleRcs> {
  const m = await deps.messageRcsParNom(tenantId, nom);
  if (!m) return { ok: false, statut: 404, code: 'rcs_message_not_found', message: `aucun message RCS nommé « ${nom} » dans Contenu > Messages RCS` };
  if (!m.content) {
    return { ok: false, statut: 422, code: 'unsendable_target', message: 'le contenu de ce message RCS n’est plus reconnu : ouvrez-le dans Contenu > Messages RCS et enregistrez-le de nouveau' };
  }
  const agentId = await deps.agentIdForTenant(tenantId);
  if (!agentId) return { ok: false, statut: 409, code: 'rcs_not_enabled', message: 'le canal RCS n’est pas activé sur cet espace' };
  return { ok: true, nom: m.name, agentId, contenu: m.content };
}

/**
 * Le nom du message RCS qu'un envoi de l'API a fait partir, relu dans le NOM DE LA CAMPAGNE (`[API] <nom>`),
 * pour la cible `{ rcsMessage }` de `GET /v1/sends/{sendId}`. `null` quand le nom ne porte pas le préfixe.
 *
 * ⚠️ C'EST LE CANAL QUI RECONNAÎT UNE CAMPAGNE RCS, pas cette fonction : `cibleDe` (lot 2) le juge AVANT le
 * template, parce qu'une campagne RCS porte `templateName: ''`. Elle ne fait que NOMMER le message.
 * ⚠️ Le nom vient de l'ENVOI (jamais coupé pour une cible RCS, cf. la route), pas de la bibliothèque : il dit
 * ce qui est parti, même si le message a été renommé depuis, et aucune colonne de plus n'est nécessaire.
 * 🔴 UNE CAMPAGNE RCS DE LA CONSOLE N'A PAS LE PRÉFIXE : elle ne garde que le CONTENU du message, son nom de
 * campagne n'est pas un nom de la bibliothèque, donc `null` (le lot 2 ne l'invente pas, celui-ci non plus).
 */
export function nomDuMessageRcs(nomDeCampagne: string): string | null {
  if (!nomDeCampagne.startsWith(PREFIXE_ENVOI_API)) return null;
  const nom = nomDeCampagne.slice(PREFIXE_ENVOI_API.length);
  return nom === '' ? null : nom;
}
