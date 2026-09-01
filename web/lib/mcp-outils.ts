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
  { nom: 'get_messages', scope: 'mcp:read', quoi: ['Les messages d’un fil.', 'Messages of a thread.'] },
  { nom: 'search_contacts', scope: 'mcp:read', quoi: ['Chercher un contact par nom ou par numéro.', 'Find a contact by name or number.'] },
  { nom: 'get_contact', scope: 'mcp:read', quoi: ['La fiche d’un contact à partir de son numéro.', 'A contact record from its number.'] },
  { nom: 'list_members', scope: 'mcp:read', quoi: ['Les membres de l’espace, pour pouvoir leur confier un fil.', 'Workspace members, to assign threads to them.'] },
  { nom: 'reply_in_open_window', scope: 'mcp:write', quoi: ['Répondre, uniquement si la fenêtre de 24 h est ouverte.', 'Reply, only while the 24 h window is open.'] },
  { nom: 'tag_conversation', scope: 'mcp:write', quoi: ['Poser des tags sur le contact d’un fil.', 'Add tags to a thread’s contact.'] },
  { nom: 'assign_conversation', scope: 'mcp:write', quoi: ['Confier un fil à un membre, ou le libérer.', 'Assign a thread to a member, or release it.'] },
];
