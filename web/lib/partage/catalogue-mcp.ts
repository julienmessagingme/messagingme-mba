/** Faits mécaniques du catalogue MCP, communs aux handlers et à la documentation publique. */
export type ScopeMcp = 'mcp:read' | 'mcp:write';

export const CATALOGUE_MCP = {
  list_conversations: { scope: 'mcp:read' },
  get_conversation: { scope: 'mcp:read' },
  get_messages: { scope: 'mcp:read' },
  get_message_status: { scope: 'mcp:read' },
  get_message_stats: { scope: 'mcp:read' },
  get_campaign_stats: { scope: 'mcp:read' },
  get_conversation_insights: { scope: 'mcp:read' },
  get_ai_stats: { scope: 'mcp:read' },
  search_contacts: { scope: 'mcp:read' },
  get_contact: { scope: 'mcp:read' },
  /** Bloquer un contact (2026-10-22) : une décision qui coupe la relation avec un client, signée d'une personne. */
  block_contact: { scope: 'mcp:write', exigePersonne: true },
  /**
   * Supprimer des contacts en masse (2026-10-26) : un aperçu et son code, puis l'effacement, irréversible, au nom d'une
   * personne, jamais d'une clé. L'aperçu n'efface rien, mais il est du scope d'écriture, comme `prepare_campaign`.
   */
  prepare_contacts_deletion: { scope: 'mcp:write', exigePersonne: true },
  delete_contacts: { scope: 'mcp:write', exigePersonne: true },
  list_members: { scope: 'mcp:read' },
  reply_in_open_window: { scope: 'mcp:write' },
  send_message: { scope: 'mcp:write' },
  tag_conversation: { scope: 'mcp:write' },
  assign_conversation: { scope: 'mcp:write' },
  /** Prendre et rendre la main sur un fil (2026-10-22), sans personne exigée : `reply_in_open_window` prend déjà le fil. */
  control_conversation: { scope: 'mcp:write' },
  list_widgets: { scope: 'mcp:read' },
  list_scenarios: { scope: 'mcp:read' },
  create_widget: { scope: 'mcp:write' },
  update_widget: { scope: 'mcp:write' },
  get_plan: { scope: 'mcp:read' },
  get_setup_state: { scope: 'mcp:read' },
  list_agents: { scope: 'mcp:read' },
  get_agent: { scope: 'mcp:read' },
  create_agent: { scope: 'mcp:write', exigePersonne: true },
  update_agent: { scope: 'mcp:write', exigePersonne: true },
  /** Les limites d'une conversation de l'agent (2026-10-23) : elles s'écrivent dans la fiche, au nom d'une personne. */
  set_agent_limits: { scope: 'mcp:write', exigePersonne: true },
  set_agent_tools: { scope: 'mcp:write', exigePersonne: true },
  activate_agent: { scope: 'mcp:write', exigePersonne: true },
  set_default_responder: { scope: 'mcp:write', exigePersonne: true },
  test_agent: { scope: 'mcp:write', exigePersonne: true },
  list_knowledge: { scope: 'mcp:read' },
  add_knowledge: { scope: 'mcp:write', exigePersonne: true },
  delete_knowledge: { scope: 'mcp:write', exigePersonne: true },
  preview_site: { scope: 'mcp:read', exigePersonne: true },
  import_site: { scope: 'mcp:write', exigePersonne: true },
  import_document_text: { scope: 'mcp:write', exigePersonne: true },
  set_transfer_mode: { scope: 'mcp:write', exigePersonne: true },
  set_business_hours: { scope: 'mcp:write', exigePersonne: true },
  set_agent_action: { scope: 'mcp:write', exigePersonne: true },
  delete_agent_action: { scope: 'mcp:write', exigePersonne: true },
  get_credit: { scope: 'mcp:read' },
  buy_credit: { scope: 'mcp:write', exigePersonne: true },
  /** La clé de l'application et le paiement du Pro (spec offres v2) : ce qu'une Free ne fait plus dans la console. */
  create_api_key: { scope: 'mcp:write', exigePersonne: true },
  subscribe_pro: { scope: 'mcp:write', exigePersonne: true },
  return_number_at_plan_end: { scope: 'mcp:write', exigePersonne: true },
  get_number_subscription: { scope: 'mcp:read' },
  manage_number_subscription: { scope: 'mcp:write', exigePersonne: true },
  resubscribe_number: { scope: 'mcp:write', exigePersonne: true },
  start_whatsapp_connection: { scope: 'mcp:write', exigePersonne: true },
  watch_whatsapp_connection: { scope: 'mcp:write', exigePersonne: true },
  create_webhook_endpoint: { scope: 'mcp:write', exigePersonne: true },
  send_test_event: { scope: 'mcp:write', exigePersonne: true },
  list_webhook_endpoints: { scope: 'mcp:read', exigePersonne: true },
  get_webhook_deliveries: { scope: 'mcp:read', exigePersonne: true },
  replay_webhook_delivery: { scope: 'mcp:write', exigePersonne: true },
  /** Modifier et supprimer une adresse (2026-10-22) : la Free n'a qu'une adresse, et plus de console pour la changer. */
  update_webhook_endpoint: { scope: 'mcp:write', exigePersonne: true },
  delete_webhook_endpoint: { scope: 'mcp:write', exigePersonne: true },
  list_templates: { scope: 'mcp:read' },
  get_template_status: { scope: 'mcp:read' },
  /**
   * Une personne OAuth, jamais une clé d'API (décision du 2026-10-09) : une injection dans un message client pourrait
   * faire créer des modèles en boucle et épuiser le plafond du compte WhatsApp. L'API REST garde son droit explicite
   * `templates:write`.
   */
  create_template: { scope: 'mcp:write', exigePersonne: true },
  /** Corriger et supprimer un modèle (2026-10-22), pour la même raison que la création : une personne, jamais une clé. */
  update_template: { scope: 'mcp:write', exigePersonne: true },
  delete_template: { scope: 'mcp:write', exigePersonne: true },
  /** Un envoi facturé à un contact exige également une personne OAuth. */
  send_template_to_contact: { scope: 'mcp:write', exigePersonne: true },
  /** Les campagnes depuis l'assistant (2026-10-20) : trouver les contacts d'une cible, une lecture. */
  find_contacts: { scope: 'mcp:read' },
  tag_contacts: { scope: 'mcp:write', exigePersonne: true },
  prepare_campaign: { scope: 'mcp:write', exigePersonne: true },
  launch_campaign: { scope: 'mcp:write', exigePersonne: true },
  /** Les freins et la reprise (2026-10-22) : la reprise passe par un code, puis par `launch_campaign`. */
  control_campaign: { scope: 'mcp:write', exigePersonne: true },
  /** Les champs depuis l'assistant (2026-10-20). */
  list_fields: { scope: 'mcp:read' },
  create_field: { scope: 'mcp:write', exigePersonne: true },
  set_contact_field: { scope: 'mcp:write', exigePersonne: true },
  /** Le connecteur Shopify (2026-10-21) : les quatre exigent une personne nommée, la lecture comprise. */
  connect_shopify: { scope: 'mcp:write', exigePersonne: true },
  set_shopify_message: { scope: 'mcp:write', exigePersonne: true },
  get_shopify_state: { scope: 'mcp:read', exigePersonne: true },
  disconnect_shopify: { scope: 'mcp:write', exigePersonne: true },
  /** L'import des clients abonnés (lot 3, 2026-10-22) : compter, puis importer ce que le marchand a choisi. */
  preview_shopify_customers: { scope: 'mcp:read', exigePersonne: true },
  import_shopify_customers: { scope: 'mcp:write', exigePersonne: true },
} as const satisfies Record<string, { scope: ScopeMcp; exigePersonne?: true }>;

export type NomOutilMcp = keyof typeof CATALOGUE_MCP;

/** Les handlers fournissent l'implémentation ; cette fiche leur donne leurs droits et leur nom. */
export function ficheOutilMcp<N extends NomOutilMcp>(nom: N) {
  return { nom, ...CATALOGUE_MCP[nom] };
}

export const MAX_MESSAGES_MCP = 50;
/**
 * Contacts au plus par suppression en masse (`prepare_contacts_deletion`, `delete_contacts`, plan du 2026-10-26) : une
 * sélection plus grande est refusée, jamais tronquée. Mille, pas cinq mille (relecture du lot) : la purge est UNE
 * transaction et l'audit écrit une ligne par fiche, des durées que personne n'a mesurées derrière le proxy et son délai.
 * Et les fiches que montre l'aperçu.
 */
export const MAX_FICHES_PAR_SUPPRESSION = 1000;
export const FICHES_DE_L_APERCU = 10;
/** Nombre de fiches que l'ajout en bloc via MCP peut déposer en une fois. */
export const MAX_FICHES_PAR_AJOUT = 50;
