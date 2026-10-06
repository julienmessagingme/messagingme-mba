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
  /**
   * L'outil agit au nom d'une personne : une clé d'API ne le voit pas, seule une connexion OAuth l'ouvre (l'écran le
   * dit). Miroir de `exigePersonne` côté serveur, tenu par `tests/mcp-doc-parite.test.ts`.
   */
  oauth?: true;
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
  { nom: 'list_agents', scope: 'mcp:read', quoi: ['Les agents IA, leur statut, et ce qui manque encore avant de pouvoir les activer.', 'AI agents, their status, and what is still missing before they can be activated.'] },
  { nom: 'get_agent', scope: 'mcp:read', quoi: ['Un agent IA : sa fiche, son modèle, ses outils, sa connaissance, ce qui lui manque, et les modèles proposés avec leur prix.', 'An AI agent: its profile, model, tools, knowledge, what it lacks, and the offered models with their price.'] },
  { nom: 'create_agent', scope: 'mcp:write', oauth: true, quoi: ['Créer un agent IA en brouillon. Le premier agent d’un espace demande un peu de crédit.', 'Create a draft AI agent. A workspace’s first agent needs a little credit.'] },
  { nom: 'update_agent', scope: 'mcp:write', oauth: true, quoi: ['Modifier la fiche d’un agent IA (objectif, ton, transferts, règles d’arrêt) et son modèle, journalisé au nom de la personne.', 'Edit an AI agent’s profile (goal, tone, handovers, stop rules) and its model, logged under the person’s name.'] },
  { nom: 'set_agent_tools', scope: 'mcp:write', oauth: true, quoi: ['Ajouter et activer les quatre outils sûrs d’un agent IA (terminer, chercher, lire le contact, passer la main).', 'Add and enable an AI agent’s four safe tools (finish, search, read the contact, hand over).'] },
  { nom: 'activate_agent', scope: 'mcp:write', oauth: true, quoi: ['Activer un agent IA complet, ou le désactiver. Il répond dans un scénario publié, ou comme répondeur de l’espace.', 'Activate a complete AI agent, or deactivate it. It answers in a published scenario, or as the workspace responder.'] },
  { nom: 'test_agent', scope: 'mcp:write', oauth: true, quoi: ['Essayer un agent IA sur une conversation fictive. Chaque essai est débité du crédit.', 'Try an AI agent on a mock conversation. Each try is charged to the credit.'] },
  { nom: 'list_knowledge', scope: 'mcp:read', quoi: ['Les fiches de connaissance d’un agent IA, avec leur provenance.', 'An AI agent’s knowledge entries, with their source.'] },
  { nom: 'add_knowledge', scope: 'mcp:write', oauth: true, quoi: ['Ajouter des fiches de connaissance écrites, 50 au plus par appel.', 'Add written knowledge entries, up to 50 per call.'] },
  { nom: 'delete_knowledge', scope: 'mcp:write', oauth: true, quoi: ['Supprimer des fiches de connaissance ; leur contenu reste dans l’historique.', 'Delete knowledge entries; their content stays in the history.'] },
  { nom: 'preview_site', scope: 'mcp:read', oauth: true, quoi: ['Lire un site depuis le serveur et voir ce qu’un import en ferait, sans rien écrire.', 'Read a site from the server and see what an import would make of it, without writing anything.'] },
  { nom: 'import_site', scope: 'mcp:write', oauth: true, quoi: ['Importer les pages d’un site en connaissance ; une page relue remplace ses fiches.', 'Import a site’s pages as knowledge; a page read again replaces its entries.'] },
  { nom: 'import_document_text', scope: 'mcp:write', oauth: true, quoi: ['Importer le texte d’un document sous son nom, rangé comme un document déposé.', 'Import a document’s text under its name, filed like an uploaded document.'] },
  { nom: 'set_transfer_mode', scope: 'mcp:write', oauth: true, quoi: ['Régler ce que les agents IA promettent de la disponibilité de l’équipe quand ils passent la main.', 'Set what AI agents promise about team availability when they hand over.'] },
  { nom: 'set_default_responder', scope: 'mcp:write', oauth: true, quoi: ['Faire d’un agent IA actif le répondeur de l’espace, qui répond à tout message que personne ne tient ; l’agent de Meta est alors éteint.', 'Make an active AI agent the workspace responder, answering every message nobody handles; Meta’s agent is then turned off.'] },
  { nom: 'get_credit', scope: 'mcp:read', quoi: ['Le solde du crédit IA et ses derniers mouvements.', 'The AI credit balance and its latest movements.'] },
  { nom: 'buy_credit', scope: 'mcp:write', oauth: true, quoi: ['Ouvrir le paiement d’une recharge, montant hors taxe ; la personne paie elle-même sur la page de Stripe.', 'Open a top-up payment, amount before tax; the person pays on the Stripe page themselves.'] },
  { nom: 'start_whatsapp_connection', scope: 'mcp:write', oauth: true, quoi: ['Donner le lien qui ouvre la connexion du numéro WhatsApp, sans passer par la console, valable une heure : numéro fourni ou apporté.', 'Give the link that opens the WhatsApp number connection, without the console, valid for one hour: provided or own number.'] },
  { nom: 'get_number_subscription', scope: 'mcp:read', quoi: ['L’abonnement du numéro fourni : son statut, la fin de la période payée et le numéro.', 'The provided number’s subscription: its status, the end of the paid period and the number.'] },
  { nom: 'manage_number_subscription', scope: 'mcp:write', oauth: true, quoi: ['Ouvrir le portail de Stripe pour l’abonnement du numéro : carte, factures, résiliation.', 'Open the Stripe portal for the number subscription: card, invoices, cancellation.'] },
  { nom: 'watch_whatsapp_connection', scope: 'mcp:write', oauth: true, quoi: ['Suivre la connexion du numéro jusqu’au bout : numéro attribué, code de vérification à lire à la personne, numéro connecté.', 'Follow the number connection to the end: number assigned, verification code to read out, number connected.'] },
];
