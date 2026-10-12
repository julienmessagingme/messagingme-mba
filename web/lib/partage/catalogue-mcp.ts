/** Faits mécaniques du catalogue MCP, communs aux handlers et à la documentation publique. */
export type ScopeMcp = 'mcp:read' | 'mcp:write';

export const CATALOGUE_MCP = {
  list_conversations: { scope: 'mcp:read' },
  get_conversation: { scope: 'mcp:read' },
  get_messages: { scope: 'mcp:read' },
  get_message_status: { scope: 'mcp:read' },
  search_contacts: { scope: 'mcp:read' },
  get_contact: { scope: 'mcp:read' },
  list_members: { scope: 'mcp:read' },
  reply_in_open_window: { scope: 'mcp:write' },
  send_message: { scope: 'mcp:write' },
  tag_conversation: { scope: 'mcp:write' },
  assign_conversation: { scope: 'mcp:write' },
  list_widgets: { scope: 'mcp:read' },
  list_scenarios: { scope: 'mcp:read' },
  create_widget: { scope: 'mcp:write' },
  update_widget: { scope: 'mcp:write' },
  get_plan: { scope: 'mcp:read' },
  list_agents: { scope: 'mcp:read' },
  get_agent: { scope: 'mcp:read' },
  create_agent: { scope: 'mcp:write', exigePersonne: true },
  update_agent: { scope: 'mcp:write', exigePersonne: true },
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
  get_credit: { scope: 'mcp:read' },
  buy_credit: { scope: 'mcp:write', exigePersonne: true },
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
  list_templates: { scope: 'mcp:read' },
  get_template_status: { scope: 'mcp:read' },
  /**
   * Une personne OAuth, jamais une clé d'API (décision du 2026-10-09) : une injection dans un message client pourrait
   * faire créer des modèles en boucle et épuiser le plafond du compte WhatsApp. L'API REST garde son droit explicite
   * `templates:write`.
   */
  create_template: { scope: 'mcp:write', exigePersonne: true },
  /** Un envoi facturé à un contact exige également une personne OAuth. */
  send_template_to_contact: { scope: 'mcp:write', exigePersonne: true },
} as const satisfies Record<string, { scope: ScopeMcp; exigePersonne?: true }>;

export type NomOutilMcp = keyof typeof CATALOGUE_MCP;

/** Les handlers fournissent l'implémentation ; cette fiche leur donne leurs droits et leur nom. */
export function ficheOutilMcp<N extends NomOutilMcp>(nom: N) {
  return { nom, ...CATALOGUE_MCP[nom] };
}

export const MAX_MESSAGES_MCP = 50;
/** Nombre de fiches que l'ajout en bloc via MCP peut déposer en une fois. */
export const MAX_FICHES_PAR_AJOUT = 50;
