/**
 * Ce que le service de connexions et le worker savent tous deux d'un message de la filière application, sans rien de
 * Baileys : le worker l'importe sans charger le transport.
 */
export const TYPES_MESSAGE = ['text', 'image', 'audio', 'video', 'document', 'sticker'] as const;
export type TypeMessageApplication = (typeof TYPES_MESSAGE)[number];

/** Une conversation individuelle : un contact par son numéro, ou masqué. Les groupes et les statuts n'entrent pas. */
export const estIndividuel = (jid: string): boolean => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

/**
 * L'identifiant d'un message de l'application dans nos tables. Préfixé par le compte : `meta_message_id` est unique
 * pour toute la base, et deux de nos comptes qui s'écrivent recevraient le même identifiant WhatsApp.
 */
export const idDuMessage = (compteId: string, id: string): string => `app:${compteId}:${id}`;
