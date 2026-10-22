import type { NomOutilMcp } from '../../web/lib/partage/catalogue-mcp';

/**
 * LES OUTILS SANS OBJET SUR LA FILIÈRE APPLICATION (plan 2026-10-22, tâche 7) : ils parlent de ce que seule l'API
 * WhatsApp officielle porte. Sur un espace de la filière application, ils restent listés et refusent avec une phrase qui
 * dit pourquoi et propose le passage à l'API, comme un outil hors offre propose le Pro. Aucun ne parle à Meta avant.
 */
const SANS_OBJET = {
  list_templates: 'les modèles approuvés par Meta',
  create_template: 'les modèles approuvés par Meta',
  send_template_to_contact: 'les modèles approuvés par Meta',
  get_template_status: 'les modèles approuvés par Meta',
  get_message_status: 'les accusés de livraison de Meta',
  prepare_campaign: 'les campagnes',
  launch_campaign: 'les campagnes',
  get_campaign_stats: 'les campagnes',
} satisfies Partial<Record<NomOutilMcp, string>>;

/** Ce dont un outil parle, s'il n'a pas d'objet sur la filière application ; `undefined` sinon. */
export const sansObjetSurApplication = (nom: string): string | undefined => new Map<string, string>(Object.entries(SANS_OBJET)).get(nom);

export function phraseOutilSansObjet(quoi: string): string {
  return `Sur un numéro de l’application WhatsApp Business, ${quoi} n’existent pas : cet outil demande l’API WhatsApp `
    + 'officielle, avec un compte Meta Business. Le passage à l’API se fait en reliant un numéro par un compte Meta Business '
    + '(start_whatsapp_connection, filiere « api »).';
}
