import { z } from 'zod';
import type { CodeApi } from './erreurs';
import type { RcsOutbound } from '../rcs/types';

/**
 * La cible `rcsMessage` de `POST /v1/sends` : un message de Contenu > Messages RCS, désigné par son nom
 * (unique par espace, index partiel `rcs_messages_tenant_name`). Aucun numéro WhatsApp exigé, catégorie
 * obligatoire (elle décide du consentement), pas de `params` (les variables viennent de
 * `recipients[].variables`). Les règles de forme vivent dans `lireCible` (`src/http/v1-sends.ts`) ; ce
 * module fait les lectures et le suivi.
 */

/**
 * La borne d'un nom dans la bibliothèque (`lireNom`, `src/http/rcs-messages.ts`, 120 caractères). Un nom plus
 * long ne désigne aucun message : refusé en forme plutôt que cherché.
 */
export const NOM_MESSAGE_RCS_MAX = 120;

/** Le noyau `{ rcsMessage }` de l'union des cibles de la route. */
export const schemaCibleRcs = z.strictObject({ rcsMessage: z.string().trim().min(1).max(NOM_MESSAGE_RCS_MAX) });

/**
 * Le préfixe du nom d'un envoi de l'API dans Campagnes, posé par la route et retiré par `nomDuMessageRcs` :
 * une seule écriture, sinon les deux divergeraient en silence.
 */
export const PREFIXE_ENVOI_API = '[API] ';

export interface DepsCibleRcs {
  messageRcsParNom(tenantId: string, nom: string): Promise<{ name: string; content: RcsOutbound | null } | null>;
  agentIdForTenant(tenantId: string): Promise<string | null>;
}

export type CibleRcs =
  | { ok: true; nom: string; agentId: string; contenu: RcsOutbound }
  | { ok: false; statut: 404 | 409 | 422; code: Extract<CodeApi, 'rcs_message_not_found' | 'rcs_not_enabled' | 'unsendable_target'>; message: string };

/** Le message, puis l'agent : un message introuvable ne coûte pas la lecture de l'agent. */
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
 * Le nom du message RCS qu'un envoi de l'API a fait partir, relu dans le nom de la campagne (`[API] <nom>`),
 * pour la cible `{ rcsMessage }` de `GET /v1/sends/{sendId}` ; `null` sans le préfixe. C'est le canal qui
 * reconnaît une campagne RCS (`cibleDe`), cette fonction ne fait que nommer le message. Le nom vient de
 * l'envoi, pas de la bibliothèque : il dit ce qui est parti. Une campagne RCS de la console n'a pas le
 * préfixe, donc `null`.
 */
export function nomDuMessageRcs(nomDeCampagne: string): string | null {
  if (!nomDeCampagne.startsWith(PREFIXE_ENVOI_API)) return null;
  const nom = nomDeCampagne.slice(PREFIXE_ENVOI_API.length);
  return nom === '' ? null : nom;
}
