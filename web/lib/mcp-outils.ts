import { ficheOutilMcp, MAX_FICHES_PAR_AJOUT, MAX_MESSAGES_MCP, type NomOutilMcp, type ScopeMcp } from './partage/catalogue-mcp';

/** Les mots de la page MCP ; les droits et la présence OAuth viennent du catalogue partagé. */
export interface OutilDocumente {
  nom: NomOutilMcp;
  scope: ScopeMcp;
  quoi: readonly [string, string];
  oauth?: true;
}

/** Chaque outil du catalogue doit recevoir ses deux textes ; l'ordre est celui de la page publique. */
const TEXTES_MCP = {
  list_conversations: ['Les conversations, la plus active en premier, sur une période si besoin, avec le contact de chacune.', 'Conversations, most recently active first, over a period if needed, with each one’s contact.'],
  get_conversation: ['Le détail d’un fil, et surtout si la fenêtre de 24 h est ouverte.', 'Thread details, and whether the 24 h window is open.'],
  send_message: ['Envoyer dans la fenêtre de 24 h une image, un document, un lieu, des boutons, une liste ou un bouton lien, au format de Meta.', 'Send within the 24-hour window an image, a document, a location, buttons, a list or a link button, in Meta’s format.'],
  list_templates: ['Les modèles WhatsApp de l’espace, avec leur langue, leur catégorie et leur statut chez Meta.', 'The workspace’s WhatsApp templates, with their language, category and status at Meta.'],
  create_template: ['Créer un modèle au format de Meta et le soumettre à sa validation ; une image d’en-tête se donne par son adresse.', 'Create a template in Meta’s format and submit it for review; a header image is given by its address.'],
  send_template_to_contact: ['Envoyer un modèle approuvé à une personne, même hors de la fenêtre de 24 h, avec les règles des envois (consentement, STOP, modèles du mois).', 'Send an approved template to one person, even outside the 24-hour window, with the sends rules (consent, STOP, monthly templates).'],
  get_template_status: ['Le statut d’un modèle chez Meta, langue par langue, avec le motif d’un refus.', 'A template’s status at Meta, language by language, with the reason for a rejection.'],
  get_message_status: ['Le statut de livraison d’un message envoyé : envoyé, distribué, lu ou en échec, avec le motif de Meta.', 'The delivery status of a sent message: sent, delivered, read or failed, with Meta’s reason.'],
  get_message_stats: ['Les chiffres des messages en séries pour un graphique : modèles envoyés, livrés, lus, en échec ; avec les statistiques de l’offre, les catégories, les échanges, les contacts et le coût estimé.', 'Message figures as chart-ready series: templates sent, delivered, read, failed; with the plan’s statistics, categories, exchanges, contacts and estimated cost.'],
  get_campaign_stats: ['Les campagnes de la période avec leur coût estimé, leurs clics et les erreurs de Meta, ou l’entonnoir d’une campagne.', 'The period’s campaigns with their estimated cost, clicks and Meta errors, or one campaign’s funnel.'],
  get_conversation_insights: ['Ce que l’analyse a compris des conversations : sentiment, intentions, résolution, sujets, et la satisfaction et l’urgence par maille.', 'What the analysis understood of conversations: sentiment, intents, resolution, topics, and satisfaction and urgency over time.'],
  get_ai_stats: ['Les chiffres des agents IA : coût des tours d’agent sur le crédit, messages écrits par l’IA, demandes ouvertes pour l’équipe et actions déclenchées.', 'AI agent figures: cost of agent turns on the credit, messages written by AI, requests opened for the team and actions triggered.'],
  get_messages: [`Les ${MAX_MESSAGES_MCP} derniers messages d’un fil, du plus ancien au plus récent, et before pour remonter plus loin.`, `The last ${MAX_MESSAGES_MCP} messages of a thread, oldest first, and before to go further back.`],
  find_contacts: ['Les contacts d’une cible, comme les filtres de la liste des contacts : étiquettes, consentement et, en Entreprise, la dernière analyse. Le total, et 100 contacts au plus.', 'The contacts of a target, like the contact list filters: tags, consent and, on the Enterprise plan, the latest analysis. The total, and up to 100 contacts.'],
  tag_contacts: ['Étiqueter les contacts d’une cible ou d’une liste de conversations : un segment est une étiquette. Par l’action en masse de la console, sans déclencher d’automation.', 'Tag the contacts of a target or of a list of conversations: a segment is a tag. Through the console’s bulk action, without starting any automation.'],
  prepare_campaign: ['Préparer une campagne de modèle sans rien envoyer : un brouillon visible dans la console, un récapitulatif (ciblés, partants, écartés et pourquoi, cinq noms, le volume facturable) et un code de confirmation.', 'Prepare a template campaign without sending anything: a draft visible in the console, a summary (targeted, sent, left out and why, five names, the billable volume) and a confirmation code.'],
  launch_campaign: ['Lancer, ou programmer à sa date, une campagne préparée, avec le code de son récapitulatif, une fois que la personne a dit oui ; par le même chemin que le bouton « Lancer » de la console.', 'Launch, or schedule for its date, a prepared campaign, with the code of its summary, once the person said yes; through the same path as the console’s Launch button.'],
  list_fields: ['Les champs personnalisés des contacts : clé, libellé, type. Une variable de modèle peut en venir.', 'The custom contact fields: key, label, type. A template variable can come from one of them.'],
  create_field: ['Créer un champ personnalisé, comme dans la console : sa clé vient du libellé.', 'Create a custom field, as in the console: its key comes from the label.'],
  set_contact_field: ['Remplir un champ sur les contacts d’une cible ou d’une liste de conversations, comme l’action en masse de la console, sans déclencher d’automation.', 'Set a field on the contacts of a target or of a list of conversations, like the console’s bulk action, without starting any automation.'],
  connect_shopify: ['Brancher la boutique Shopify du marchand avec l’app que la skill shopify a créée dans son organisation ; la connexion est vérifiée chez Shopify avant de garder le secret, chiffré.', 'Connect the merchant’s Shopify store with the app the shopify skill created in its organization; the connection is checked with Shopify before the secret is kept, encrypted.'],
  set_shopify_message: ['Envoyer un modèle approuvé quand une commande est payée ou expédiée, ou relancer une fois un panier abandonné, avec les données Shopify en variables, par les règles des envois (STOP, consentement, modèles du mois, limite de contacts).', 'Send an approved template when an order is paid or fulfilled, or remind an abandoned checkout once, with Shopify data as variables, through the sends rules (STOP, consent, monthly templates, contact limit).'],
  get_shopify_state: ['La boutique Shopify branchée : son état, ses messages, le dernier événement reçu, les issues des 30 derniers jours et les paniers des 7 derniers.', 'The connected Shopify store: its state, its messages, the last event received, the last 30 days of outcomes and the last 7 days of checkouts.'],
  preview_shopify_customers: ['Compter, sans rien écrire, les clients Shopify abonnés au marketing (e-mail ou SMS) qui ont un téléphone : déjà dans l’espace, nouveaux, places libres de l’offre, importables.', 'Count, writing nothing, the Shopify customers subscribed to marketing (email or SMS) who have a phone: already in the workspace, new, free places of the plan, importable.'],
  import_shopify_customers: ['Importer les clients Shopify abonnés que le marchand a choisis, les plus récents d’abord : des fiches étiquetées Shopify, sans consentement WhatsApp, dans la limite de l’offre.', 'Import the subscribed Shopify customers the merchant chose, newest first: records tagged Shopify, without WhatsApp consent, within the plan’s limit.'],
  disconnect_shopify: ['Couper la boutique Shopify : plus aucun message ne part, les demandes RGPD de la boutique restent traitées.', 'Cut the Shopify store: no message leaves anymore, the store’s privacy requests are still honored.'],
  search_contacts: ['Chercher un contact par nom ou par numéro, avec sa dernière analyse.', 'Find a contact by name or number, with their latest analysis.'],
  get_contact: ['La fiche d’un contact à partir de son numéro, avec sa dernière analyse et le résumé de celle-ci.', 'A contact record from its number, with their latest analysis and its summary.'],
  list_members: ['Les membres de l’espace, pour pouvoir leur confier un fil.', 'Workspace members, to assign threads to them.'],
  reply_in_open_window: ['Répondre, uniquement si la fenêtre de 24 h est ouverte.', 'Reply, only while the 24 h window is open.'],
  tag_conversation: ['Poser des tags sur le contact d’un fil.', 'Add tags to a thread’s contact.'],
  assign_conversation: ['Confier un fil à un membre, ou le libérer.', 'Assign a thread to a member, or release it.'],
  control_conversation: ['Prendre la main sur un fil, ou la rendre au répondeur automatique, qui répondra au message suivant.', 'Take over a thread, or hand it back to the automatic responder, which answers the next message.'],
  get_plan: ['L’offre de l’espace, ses limites et ce qui en est consommé, avec le lien pour passer en Pro.', 'The workspace plan, its limits and current usage, with the link to upgrade.'],
  get_setup_state: ['Où en est la mise en service de l’espace (numéro, agent IA, répondeur, bulle, crédit, offre), et l’étape suivante avec ses outils. À appeler en premier pour mettre un espace en service, ou reprendre.', 'Where the workspace setup stands (number, AI agent, responder, bubble, credit, plan), and the next step with its tools. Call it first to set up a workspace, or to resume.'],
  list_widgets: ['Les widgets WhatsApp de l’espace, avec la balise à coller sur le site.', 'The workspace’s WhatsApp widgets, with the tag to paste on the site.'],
  list_scenarios: ['Les scénarios, et lesquels sont publiés : un widget ne démarre qu’un scénario publié.', 'Scenarios, and which are published: a widget only starts a published scenario.'],
  create_widget: ['Créer un widget WhatsApp, avec les contrôles de l’écran, et recevoir sa balise.', 'Create a WhatsApp widget, with the screen’s checks, and get its tag.'],
  update_widget: ['Modifier un widget ; sa balise ne change jamais.', 'Edit a widget; its tag never changes.'],
  list_agents: ['Les agents IA, leur statut, et ce qui manque encore avant de pouvoir les activer.', 'AI agents, their status, and what is still missing before they can be activated.'],
  get_agent: ['Un agent IA : sa fiche, son modèle, ses outils, sa connaissance, ce qui lui manque, et les modèles proposés avec leur prix.', 'An AI agent: its profile, model, tools, knowledge, what it lacks, and the offered models with their price.'],
  create_agent: ['Créer un agent IA en brouillon. Le premier agent d’un espace demande un peu de crédit.', 'Create a draft AI agent. A workspace’s first agent needs a little credit.'],
  update_agent: ['Modifier la fiche d’un agent IA (objectif, ton, transferts, règles d’arrêt) et son modèle, journalisé au nom de la personne.', 'Edit an AI agent’s profile (goal, tone, handovers, stop rules) and its model, logged under the person’s name.'],
  set_agent_tools: ['Ajouter et activer les quatre outils sûrs d’un agent IA (terminer, chercher, lire le contact, passer la main).', 'Add and enable an AI agent’s four safe tools (finish, search, read the contact, hand over).'],
  activate_agent: ['Activer un agent IA complet, ou le désactiver. Il répond dans un scénario publié, ou s’il est choisi pour répondre au client.', 'Activate a complete AI agent, or deactivate it. It answers in a published scenario, or if chosen to answer the customer.'],
  test_agent: ['Essayer un agent IA sur une conversation fictive. Chaque essai est débité du crédit.', 'Try an AI agent on a mock conversation. Each try is charged to the credit.'],
  list_knowledge: ['Les fiches de connaissance d’un agent IA, avec leur provenance.', 'An AI agent’s knowledge entries, with their source.'],
  add_knowledge: [`Ajouter des fiches de connaissance écrites, ${MAX_FICHES_PAR_AJOUT} au plus par appel.`, `Add written knowledge entries, up to ${MAX_FICHES_PAR_AJOUT} per call.`],
  delete_knowledge: ['Supprimer des fiches de connaissance ; leur contenu reste dans l’historique.', 'Delete knowledge entries; their content stays in the history.'],
  preview_site: ['Lire un site depuis le serveur et voir ce qu’un import en ferait, sans rien écrire.', 'Read a site from the server and see what an import would make of it, without writing anything.'],
  import_site: ['Importer les pages d’un site en connaissance ; une page relue remplace ses fiches.', 'Import a site’s pages as knowledge; a page read again replaces its entries.'],
  import_document_text: ['Importer le texte d’un document sous son nom, rangé comme un document déposé.', 'Import a document’s text under its name, filed like an uploaded document.'],
  set_transfer_mode: ['Régler ce que les agents IA promettent de la disponibilité de l’équipe quand ils passent la main.', 'Set what AI agents promise about team availability when they hand over.'],
  set_business_hours: ['Régler les heures d’ouverture de l’espace et son fuseau : celles que les agents IA annoncent hors des heures.', 'Set the workspace’s opening hours and time zone: the ones AI agents announce outside hours.'],
  set_agent_action: ['Créer ou modifier une action d’un agent IA : ce qu’il recueille et envoie à votre application (webhook agent.action) quand le client fait une demande, une fois par jour et par contact.', 'Create or edit an AI agent action: what it collects and sends to your app (agent.action webhook) when the customer makes a request, once a day per contact.'],
  delete_agent_action: ['Supprimer une action d’un agent IA.', 'Delete an AI agent action.'],
  set_default_responder: ['Choisir qui répond au client (à un nouveau contact, et à tout message que personne ne tient) : l’agent de Meta, un agent IA actif, un scénario publié, l’équipe, ou votre application (une adresse de webhooks sortants). Hors du mode agent de Meta, celui-ci reste en veille.', 'Choose who answers the customer (a new contact, and every message nobody handles): Meta’s agent, an active AI agent, a published scenario, the team, or your app (an outgoing webhook address). Outside Meta’s agent mode, it stays on standby.'],
  get_credit: ['Le solde du crédit IA et ses derniers mouvements.', 'The AI credit balance and its latest movements.'],
  buy_credit: ['Ouvrir le paiement d’une recharge, montant hors taxe ; la personne paie elle-même sur la page de Stripe.', 'Open a top-up payment, amount before tax; the person pays on the Stripe page themselves.'],
  subscribe_pro: ['Ouvrir le paiement du Pro, au mois ou à l’année, montant hors taxe ; la personne paie elle-même sur la page de Stripe, et revient sur « Paiement reçu ».', 'Open the Pro plan payment, monthly or yearly, amount before tax; the person pays on Stripe’s page and comes back to “Payment received”.'],
  create_api_key: ['Créer la clé d’API de votre application, montrée une seule fois : elle passe par la conversation, à ranger aussitôt dans le fichier .env.', 'Create your application’s API key, shown only once: it passes through the conversation, to put at once in the .env file.'],
  start_whatsapp_connection: ['Donner le lien qui ouvre la connexion du numéro WhatsApp, sans passer par la console, valable une heure : numéro fourni ou apporté.', 'Give the link that opens the WhatsApp number connection, without the console, valid for one hour: provided or own number.'],
  get_number_subscription: ['L’abonnement du numéro fourni : son statut, la fin de la période payée et le numéro.', 'The provided number’s subscription: its status, the end of the paid period and the number.'],
  resubscribe_number: ['Renouveler l’abonnement du numéro quand il est impayé ou terminé : le portail de Stripe, ou un nouveau paiement qui rend le même numéro.', 'Renew the number subscription when it is overdue or ended: the Stripe portal, or a new payment that restores the same number.'],
  return_number_at_plan_end: ['Choisir de rendre le numéro fourni à la fin du Pro, ou de le garder à 3,50 € HT par mois sur la même carte.', 'Choose to give back the provided number when Pro ends, or keep it at €3.50 excl. VAT a month on the same card.'],
  manage_number_subscription: ['Ouvrir le portail de Stripe pour l’abonnement du numéro : carte, factures, résiliation.', 'Open the Stripe portal for the number subscription: card, invoices, cancellation.'],
  watch_whatsapp_connection: ['Suivre la connexion du numéro jusqu’au bout : numéro attribué, code de vérification à lire à la personne, numéro connecté.', 'Follow the number connection to the end: number assigned, verification code to read out, number connected.'],
  create_webhook_endpoint: ['Inscrire l’adresse HTTPS de l’application qui recevra les événements choisis (webhook sortant, signé) ; le secret de signature est montré une seule fois.', 'Register the HTTPS address of the app that will receive the chosen events (signed outgoing webhook); the signing secret is shown only once.'],
  list_webhook_endpoints: ['Les adresses de webhooks sortants, leurs types d’événements et leur état, et la limite de l’offre.', 'The outgoing webhook endpoints, their event types and status, and the plan limit.'],
  get_webhook_deliveries: ['Le journal d’une adresse : chaque envoi, son statut, la réponse de l’application et le corps envoyé.', 'An endpoint’s log: each delivery, its status, the app’s answer and the body sent.'],
  replay_webhook_delivery: ['Rejouer un envoi terminé : même corps, même identifiant d’événement.', 'Replay a finished delivery: same body, same event id.'],
  update_webhook_endpoint: ['Modifier une adresse : ses types d’événements, sa pause, ou un nouveau secret, montré une fois.', 'Edit an endpoint: its event types, a pause, or a new secret, shown once.'],
  delete_webhook_endpoint: ['Supprimer une adresse et son journal ; pour changer d’URL, la supprimer puis la recréer.', 'Delete an endpoint and its log; to change its URL, delete it and create it again.'],
  send_test_event: ['Envoyer tout de suite un événement d’essai signé à une adresse, et lire ce que l’application a répondu.', 'Send a signed test event to an address right away, and read what the app answered.'],
} satisfies Record<NomOutilMcp, readonly [string, string]>;

export const OUTILS_MCP: OutilDocumente[] = (Object.keys(TEXTES_MCP) as NomOutilMcp[]).map((nom) => {
  const fiche = ficheOutilMcp(nom);
  return {
    nom,
    scope: fiche.scope,
    ...('exigePersonne' in fiche ? { oauth: true as const } : {}),
    quoi: TEXTES_MCP[nom],
  };
});
