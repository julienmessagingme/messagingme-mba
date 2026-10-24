/**
 * Les outils du serveur MCP, rangés par famille pour le README du plugin (Julien, 2026-10-21). `tests/plugin-readme.test.ts`
 * exige que chaque outil du catalogue figure dans une famille, et dans une seule : un outil ajouté sans y être rangé rend
 * la CI rouge, au lieu de manquer en silence au README.
 */
import type { NomOutilMcp } from '../../web/lib/partage/catalogue-mcp';

export const FAMILLES_OUTILS: ReadonlyArray<{ readonly titre: string; readonly outils: readonly NomOutilMcp[] }> = [
  { titre: 'Setup and plan', outils: ['get_setup_state', 'get_plan', 'subscribe_pro', 'get_credit', 'buy_credit', 'create_api_key', 'list_members'] },
  {
    titre: 'WhatsApp number',
    outils: ['start_whatsapp_connection', 'watch_whatsapp_connection', 'get_number_subscription', 'manage_number_subscription', 'resubscribe_number', 'return_number_at_plan_end'],
  },
  {
    titre: 'AI agent',
    outils: [
      'list_agents', 'get_agent', 'create_agent', 'update_agent', 'set_agent_limits', 'set_agent_tools', 'set_agent_action', 'delete_agent_action',
      'test_agent', 'activate_agent', 'set_default_responder', 'set_transfer_mode', 'set_business_hours',
    ],
  },
  { titre: 'Agent knowledge', outils: ['list_knowledge', 'add_knowledge', 'delete_knowledge', 'preview_site', 'import_site', 'import_document_text'] },
  {
    titre: 'Conversations',
    outils: [
      'list_conversations', 'get_conversation', 'get_messages', 'reply_in_open_window', 'write_first_message', 'send_message', 'control_conversation',
      'tag_conversation', 'assign_conversation', 'get_conversation_insights',
    ],
  },
  { titre: 'Templates', outils: ['list_templates', 'get_template_status', 'create_template', 'update_template', 'delete_template', 'send_template_to_contact', 'get_message_status'] },
  {
    titre: 'Contacts and campaigns',
    outils: ['search_contacts', 'get_contact', 'block_contact', 'find_contacts', 'tag_contacts', 'list_fields', 'create_field', 'set_contact_field', 'prepare_campaign', 'launch_campaign', 'control_campaign', 'list_scenarios'],
  },
  { titre: 'Chat bubble', outils: ['list_widgets', 'create_widget', 'update_widget'] },
  { titre: 'Shopify store', outils: ['connect_shopify', 'set_shopify_message', 'get_shopify_state', 'preview_shopify_customers', 'import_shopify_customers', 'disconnect_shopify'] },
  { titre: 'Webhooks', outils: ['create_webhook_endpoint', 'list_webhook_endpoints', 'update_webhook_endpoint', 'delete_webhook_endpoint', 'send_test_event', 'get_webhook_deliveries', 'replay_webhook_delivery'] },
  { titre: 'Statistics', outils: ['get_message_stats', 'get_campaign_stats', 'get_ai_stats'] },
];
