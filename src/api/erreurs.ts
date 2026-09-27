import type { FastifyReply } from 'fastify';

/**
 * Les codes d'erreur de l'API publique, et le statut HTTP de chacun. Un code par situation qu'un programme
 * peut traiter : un défaut de forme est toujours `invalid_body`, le champ fautif nommé dans le message.
 * `null` = un code qui n'existe qu'en motif d'écart d'un destinataire (`/v1/sends`), jamais en erreur de
 * route. La documentation de l'API doit lister tous ces codes.
 */
export const STATUT_PAR_CODE = {
  invalid_body: 400,
  invalid_recipient: 400,
  invalid_phone: 400,
  unauthorized: 401,
  missing_scope: 403,
  tenant_locked: 403,
  unknown_contact: 404,
  duplicate: null,
  identity_conflict: 409,
  blocked_contact: 409,
  opted_out: 409,
  no_consent: 409,
  window_closed: 422,
  missing_variable: null,
  no_phone: 422,
  rcs_unreachable: 422,
  rcs_not_enabled: 409,
  no_whatsapp_number: 409,
  // Le numéro WhatsApp de l'espace est délié depuis l'Accueil : rien ne part avant qu'il soit relié. Distinct
  // de `no_whatsapp_number` : le numéro existe, et se relie d'un clic.
  number_unlinked: 409,
  scenario_not_found: 404,
  node_not_found: 404,
  template_not_found: 404,
  rcs_message_not_found: 404,
  send_not_found: 404,
  scenario_ambiguous: 409,
  unsendable_target: 422,
  template_category_unknown: 422,
  idempotency_key_required: 400,
  idempotency_in_progress: 409,
  idempotency_key_reused: 422,
  rate_limited: 429,
} as const satisfies Record<string, number | null>;

export type CodeApi = keyof typeof STATUT_PAR_CODE;

/**
 * Refuse une requête de l'API publique : `{ error, code }` avec le statut donné. Le statut reste un
 * paramètre : la route sait si son refus est un 404 ou un 409 ; la table ne sert que de défaut à qui relaie
 * le code d'un service (`STATUT_PAR_CODE[code] ?? 400`).
 */
export function refuser(reply: FastifyReply, statut: number, code: CodeApi, message: string): FastifyReply {
  return reply.code(statut).send({ error: message, code });
}
