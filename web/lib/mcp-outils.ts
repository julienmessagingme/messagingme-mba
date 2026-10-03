/**
 * Ce que l'écran « Serveur MCP » annonce aux intégrateurs.
 *
 * Simple donnée, dans `lib/` et pas dans la page : c'est ce qui permet à un test du serveur
 * (`tests/mcp-doc-parite.test.ts`) de lire cette liste et de la comparer au catalogue réel de
 * `src/mcp/outils.ts`. Sans cette garde, la page promettrait un jour un outil retiré, ou tairait un outil
 * ajouté, et personne ne s'en apercevrait avant qu'un intégrateur ne s'en plaigne.
 */
export interface OutilDocumente {
  nom: string;
  scope: 'mcp:read' | 'mcp:write';
  /** Description bilingue, passée telle quelle au traducteur de l'écran. */
  quoi: [string, string];
}

export const OUTILS_MCP: OutilDocumente[] = [
  { nom: 'list_conversations', scope: 'mcp:read', quoi: ['Les conversations, la plus active en premier.', 'Conversations, most recently active first.'] },
  { nom: 'get_conversation', scope: 'mcp:read', quoi: ['Le détail d’un fil, et surtout si la fenêtre de 24 h est ouverte.', 'Thread details, and whether the 24 h window is open.'] },
  { nom: 'get_messages', scope: 'mcp:read', quoi: ['Les 50 derniers messages d’un fil, du plus ancien au plus récent.', 'The last 50 messages of a thread, oldest first.'] },
  { nom: 'search_contacts', scope: 'mcp:read', quoi: ['Chercher un contact par nom ou par numéro, avec sa dernière analyse.', 'Find a contact by name or number, with their latest analysis.'] },
  { nom: 'get_contact', scope: 'mcp:read', quoi: ['La fiche d’un contact à partir de son numéro, avec sa dernière analyse et le résumé de celle-ci.', 'A contact record from its number, with their latest analysis and its summary.'] },
  { nom: 'list_members', scope: 'mcp:read', quoi: ['Les membres de l’espace, pour pouvoir leur confier un fil.', 'Workspace members, to assign threads to them.'] },
  { nom: 'reply_in_open_window', scope: 'mcp:write', quoi: ['Répondre, uniquement si la fenêtre de 24 h est ouverte.', 'Reply, only while the 24 h window is open.'] },
  { nom: 'tag_conversation', scope: 'mcp:write', quoi: ['Poser des tags sur le contact d’un fil.', 'Add tags to a thread’s contact.'] },
  { nom: 'assign_conversation', scope: 'mcp:write', quoi: ['Confier un fil à un membre, ou le libérer.', 'Assign a thread to a member, or release it.'] },
  { nom: 'list_widgets', scope: 'mcp:read', quoi: ['Les widgets WhatsApp de l’espace, avec la balise à coller sur le site.', 'The workspace’s WhatsApp widgets, with the tag to paste on the site.'] },
  { nom: 'list_scenarios', scope: 'mcp:read', quoi: ['Les scénarios, et lesquels sont publiés : un widget ne démarre qu’un scénario publié.', 'Scenarios, and which are published: a widget only starts a published scenario.'] },
  { nom: 'create_widget', scope: 'mcp:write', quoi: ['Créer un widget WhatsApp, avec les contrôles de l’écran, et recevoir sa balise.', 'Create a WhatsApp widget, with the screen’s checks, and get its tag.'] },
  { nom: 'update_widget', scope: 'mcp:write', quoi: ['Modifier un widget ; sa balise ne change jamais.', 'Edit a widget; its tag never changes.'] },
];
