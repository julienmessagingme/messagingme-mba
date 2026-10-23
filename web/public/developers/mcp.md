<!-- Version Markdown de https://console.messagingme.app/developers/mcp, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/mcp.en.md -->

# Serveur MCP

Brancher un assistant (Claude, ou tout client compatible MCP) sur l’espace, sans intégration à développer.

## Claude Code : le plugin

Le plus simple dans Claude Code : le plugin Messaging Me branche ce serveur sans clé, puis /messagingme:demarrer met l’espace en service pas à pas (numéro, agent IA, bulle, test). Les deux commandes, l’une après l’autre, puis /mcp, plugin:messagingme:messagingme et Authenticate. Avec le plugin, n’ajoutez pas aussi la commande à clé ci-dessous : Claude Code garderait ce serveur-là, qui n’ouvre pas les outils de mise en service.

_Commande 1_

```
/plugin marketplace add julienmessagingme/messagingme-plugin
```

_Commande 2_

```
/plugin install messagingme@messagingme
```

_Puis, dans Claude Code_

```
/messagingme:demarrer
```

## Adresse

_Adresse_

```
https://api.messagingme.app/mcp
```

_Commande à copier_

```
claude mcp add --transport http mba https://api.messagingme.app/mcp --header "Authorization: Bearer VOTRE_CLE"
```

Remplacer VOTRE_CLE par une clé d’API avec un droit MCP. [Créer une clé](https://console.messagingme.app/developers/keys)

## Connecter un autre client (ChatGPT, Cursor, VS Code, Lovable)

- Ajoutez un serveur MCP distant (ou un connecteur) à l’adresse https://api.messagingme.app/mcp, sans clé, avec l’authentification OAuth : le client ouvre notre page d’autorisation, où un administrateur de l’espace se connecte et choisit l’espace.
- La page dit d’où vient le nom du client : vérifié pour Claude, publié par son domaine pour un client qui a une fiche d’identité (ChatGPT), non vérifié pour un client qui s’enregistre (Cursor, VS Code).
- Le client reçoit son code sur une adresse https, ou sur localhost et 127.0.0.1 : un retour par un schéma d’application (cursor://) est refusé.

## Ce que l’assistant peut faire

Une clé en lecture seule ne voit pas les outils qui écrivent.

Les outils marqués « connexion OAuth requise » agissent au nom d’une personne : une clé d’API ne les voit pas. Ils s’ouvrent quand Claude se connecte à l’espace avec l’accord d’un administrateur, qui signe ce qu’ils font.

| Outil | Droit | Ce qu’il fait |
| --- | --- | --- |
| list_conversations | mcp:read | Les conversations, la plus active en premier, sur une période si besoin, avec le contact de chacune. |
| get_conversation | mcp:read | Le détail d’un fil, et surtout si la fenêtre de 24 h est ouverte. |
| send_message | mcp:write | Envoyer dans la fenêtre de 24 h une image, un document, un lieu, des boutons, une liste ou un bouton lien, au format de Meta. |
| list_templates | mcp:read | Les modèles WhatsApp de l’espace, avec leur langue, leur catégorie et leur statut chez Meta. |
| create_template | mcp:write connexion OAuth requise | Créer un modèle au format de Meta et le soumettre à sa validation ; une image d’en-tête se donne par son adresse. |
| update_template | mcp:write connexion OAuth requise | Corriger une langue d’un modèle, au format de Meta, qui repart en validation ; un en-tête média ne se corrige pas. |
| delete_template | mcp:write connexion OAuth requise | Supprimer un modèle, toutes ses langues ; refusé tant qu’une campagne active l’utilise. |
| send_template_to_contact | mcp:write connexion OAuth requise | Envoyer un modèle approuvé à une personne, même hors de la fenêtre de 24 h, avec les règles des envois (consentement, STOP, modèles du mois). |
| get_template_status | mcp:read | Le statut d’un modèle chez Meta, langue par langue, avec le motif d’un refus. |
| get_message_status | mcp:read | Le statut de livraison d’un message envoyé : envoyé, distribué, lu ou en échec, avec le motif de Meta. |
| get_message_stats | mcp:read | Les chiffres des messages en séries pour un graphique : modèles envoyés, livrés, lus, en échec ; avec les statistiques de l’offre, les catégories, les échanges, les contacts et le coût estimé. |
| get_campaign_stats | mcp:read | Les campagnes de la période avec leur coût estimé, leurs clics et les erreurs de Meta, ou l’entonnoir d’une campagne. |
| get_conversation_insights | mcp:read | Ce que l’analyse a compris des conversations : sentiment, intentions, résolution, sujets, et la satisfaction et l’urgence par maille. |
| get_ai_stats | mcp:read | Les chiffres des agents IA : coût des tours d’agent sur le crédit, messages écrits par l’IA, demandes ouvertes pour l’équipe et actions déclenchées. |
| get_messages | mcp:read | Les 50 derniers messages d’un fil, du plus ancien au plus récent, et before pour remonter plus loin. |
| find_contacts | mcp:read | Les contacts d’une cible, comme les filtres de la liste des contacts : étiquettes, consentement et, en Entreprise, la dernière analyse. Le total, et 100 contacts au plus. |
| tag_contacts | mcp:write connexion OAuth requise | Étiqueter les contacts d’une cible ou d’une liste de conversations : un segment est une étiquette. Par l’action en masse de la console, sans déclencher d’automation. |
| prepare_campaign | mcp:write connexion OAuth requise | Préparer une campagne de modèle sans rien envoyer : un brouillon visible dans la console, un récapitulatif (ciblés, partants, écartés et pourquoi, cinq noms, le volume facturable) et un code de confirmation. |
| launch_campaign | mcp:write connexion OAuth requise | Lancer, ou programmer à sa date, une campagne préparée, avec le code de son récapitulatif, une fois que la personne a dit oui ; par le même chemin que le bouton « Lancer » de la console. Reprend aussi une campagne en pause, avec le code de control_campaign. |
| control_campaign | mcp:write connexion OAuth requise | Mettre en pause une campagne qui envoie, déprogrammer une campagne programmée, ou préparer la reprise d’une campagne en pause (un récapitulatif et un code). |
| list_fields | mcp:read | Les champs personnalisés des contacts : clé, libellé, type. Une variable de modèle peut en venir. |
| create_field | mcp:write connexion OAuth requise | Créer un champ personnalisé, comme dans la console : sa clé vient du libellé. |
| set_contact_field | mcp:write connexion OAuth requise | Remplir un champ sur les contacts d’une cible ou d’une liste de conversations, comme l’action en masse de la console, sans déclencher d’automation. |
| connect_shopify | mcp:write connexion OAuth requise | Brancher la boutique Shopify du marchand avec l’app que la skill shopify a créée dans son organisation ; la connexion est vérifiée chez Shopify avant de garder le secret, chiffré. |
| set_shopify_message | mcp:write connexion OAuth requise | Envoyer un modèle approuvé quand une commande est payée ou expédiée, ou relancer une fois un panier abandonné, avec les données Shopify en variables, par les règles des envois (STOP, consentement, modèles du mois, limite de contacts). |
| get_shopify_state | mcp:read connexion OAuth requise | La boutique Shopify branchée : son état, ses messages, le dernier événement reçu, les issues des 30 derniers jours et les paniers des 7 derniers. |
| preview_shopify_customers | mcp:read connexion OAuth requise | Compter, sans rien écrire, les clients Shopify abonnés au marketing (e-mail ou SMS) qui ont un téléphone : déjà dans l’espace, nouveaux, places libres de l’offre, importables. |
| import_shopify_customers | mcp:write connexion OAuth requise | Importer les clients Shopify abonnés que le marchand a choisis, les plus récents d’abord : des fiches étiquetées Shopify, sans consentement WhatsApp, dans la limite de l’offre. |
| disconnect_shopify | mcp:write connexion OAuth requise | Couper la boutique Shopify : plus aucun message ne part, les demandes RGPD de la boutique restent traitées. |
| search_contacts | mcp:read | Chercher un contact par nom ou par numéro, avec sa dernière analyse. |
| get_contact | mcp:read | La fiche d’un contact à partir de son numéro, avec sa dernière analyse et le résumé de celle-ci. |
| block_contact | mcp:write connexion OAuth requise | Bloquer ou débloquer un contact : plus rien ne lui part, ses messages restent enregistrés. |
| list_members | mcp:read | Les membres de l’espace, pour pouvoir leur confier un fil. |
| reply_in_open_window | mcp:write | Répondre, uniquement si la fenêtre de 24 h est ouverte. |
| tag_conversation | mcp:write | Poser des tags sur le contact d’un fil. |
| assign_conversation | mcp:write | Confier un fil à un membre, ou le libérer. |
| control_conversation | mcp:write | Prendre la main sur un fil, ou la rendre au répondeur automatique, qui répondra au message suivant. |
| get_plan | mcp:read | L’offre de l’espace, ses limites et ce qui en est consommé, avec le lien pour passer en Pro. |
| get_setup_state | mcp:read | Où en est la mise en service de l’espace (numéro, agent IA, répondeur, bulle, crédit, offre), et l’étape suivante avec ses outils. À appeler en premier pour mettre un espace en service, ou reprendre. |
| list_widgets | mcp:read | Les widgets WhatsApp de l’espace, avec la balise à coller sur le site. |
| list_scenarios | mcp:read | Les scénarios, et lesquels sont publiés : un widget ne démarre qu’un scénario publié. |
| create_widget | mcp:write | Créer un widget WhatsApp, avec les contrôles de l’écran, et recevoir sa balise. |
| update_widget | mcp:write | Modifier un widget ; sa balise ne change jamais. |
| list_agents | mcp:read | Les agents IA, leur statut, et ce qui manque encore avant de pouvoir les activer. |
| get_agent | mcp:read | Un agent IA : sa fiche, son modèle, ses outils, sa connaissance, ce qui lui manque, et les modèles proposés avec leur prix. |
| create_agent | mcp:write connexion OAuth requise | Créer un agent IA en brouillon. Le premier agent d’un espace demande un peu de crédit. |
| update_agent | mcp:write connexion OAuth requise | Modifier la fiche d’un agent IA (objectif, ton, transferts, règles d’arrêt) et son modèle, journalisé au nom de la personne. |
| set_agent_tools | mcp:write connexion OAuth requise | Ajouter et activer les quatre outils sûrs d’un agent IA (terminer, chercher, lire le contact, passer la main). |
| activate_agent | mcp:write connexion OAuth requise | Activer un agent IA complet, ou le désactiver. Il répond dans un scénario publié, ou s’il est choisi pour répondre au client. |
| test_agent | mcp:write connexion OAuth requise | Essayer un agent IA sur une conversation fictive. Chaque essai est débité du crédit. |
| list_knowledge | mcp:read | Les fiches de connaissance d’un agent IA, avec leur provenance. |
| add_knowledge | mcp:write connexion OAuth requise | Ajouter des fiches de connaissance écrites, 50 au plus par appel. |
| delete_knowledge | mcp:write connexion OAuth requise | Supprimer des fiches de connaissance ; leur contenu reste dans l’historique. |
| preview_site | mcp:read connexion OAuth requise | Lire un site depuis le serveur et voir ce qu’un import en ferait, sans rien écrire. |
| import_site | mcp:write connexion OAuth requise | Importer les pages d’un site en connaissance ; une page relue remplace ses fiches. |
| import_document_text | mcp:write connexion OAuth requise | Importer le texte d’un document sous son nom, rangé comme un document déposé. |
| set_transfer_mode | mcp:write connexion OAuth requise | Régler ce que les agents IA promettent de la disponibilité de l’équipe quand ils passent la main. |
| set_business_hours | mcp:write connexion OAuth requise | Régler les heures d’ouverture de l’espace et son fuseau : celles que les agents IA annoncent hors des heures. |
| set_agent_action | mcp:write connexion OAuth requise | Créer ou modifier une action d’un agent IA : ce qu’il recueille et envoie à votre application (webhook agent.action) quand le client fait une demande, une fois par jour et par contact. |
| delete_agent_action | mcp:write connexion OAuth requise | Supprimer une action d’un agent IA. |
| set_default_responder | mcp:write connexion OAuth requise | Choisir qui répond au client (à un nouveau contact, et à tout message que personne ne tient) : l’agent de Meta, un agent IA actif, un scénario publié, l’équipe, ou votre application (une adresse de webhooks sortants). Hors du mode agent de Meta, celui-ci reste en veille. |
| get_credit | mcp:read | Le solde du crédit IA et ses derniers mouvements. |
| buy_credit | mcp:write connexion OAuth requise | Ouvrir le paiement d’une recharge, montant hors taxe ; la personne paie elle-même sur la page de Stripe. |
| subscribe_pro | mcp:write connexion OAuth requise | Ouvrir le paiement du Pro, au mois ou à l’année, montant hors taxe ; la personne paie elle-même sur la page de Stripe, et revient sur « Paiement reçu ». |
| create_api_key | mcp:write connexion OAuth requise | Créer la clé d’API de votre application, montrée une seule fois : elle passe par la conversation, à ranger aussitôt dans le fichier .env. |
| start_whatsapp_connection | mcp:write connexion OAuth requise | Donner le lien qui ouvre la connexion du numéro WhatsApp, sans passer par la console, valable une heure : numéro fourni ou apporté. Sans compte Meta Business, l’application WhatsApp Business du téléphone se relie par un QR code : elle passe par WhatsApp comme un appareil lié, ce n’est pas l’API officielle, et WhatsApp peut couper un numéro. |
| get_number_subscription | mcp:read | L’abonnement du numéro fourni : son statut, la fin de la période payée et le numéro. |
| resubscribe_number | mcp:write connexion OAuth requise | Renouveler l’abonnement du numéro quand il est impayé ou terminé : le portail de Stripe, ou un nouveau paiement qui rend le même numéro. |
| return_number_at_plan_end | mcp:write connexion OAuth requise | Choisir de rendre le numéro fourni à la fin du Pro, ou de le garder à 3,50 € HT par mois sur la même carte. |
| manage_number_subscription | mcp:write connexion OAuth requise | Ouvrir le portail de Stripe pour l’abonnement du numéro : carte, factures, résiliation. |
| watch_whatsapp_connection | mcp:write connexion OAuth requise | Suivre la connexion du numéro jusqu’au bout : numéro attribué, code de vérification à lire à la personne, numéro connecté. |
| create_webhook_endpoint | mcp:write connexion OAuth requise | Inscrire l’adresse HTTPS de l’application qui recevra les événements choisis (webhook sortant, signé) ; le secret de signature est montré une seule fois. |
| list_webhook_endpoints | mcp:read connexion OAuth requise | Les adresses de webhooks sortants, leurs types d’événements et leur état, et la limite de l’offre. |
| get_webhook_deliveries | mcp:read connexion OAuth requise | Le journal d’une adresse : chaque envoi, son statut, la réponse de l’application et le corps envoyé. |
| replay_webhook_delivery | mcp:write connexion OAuth requise | Rejouer un envoi terminé : même corps, même identifiant d’événement. |
| update_webhook_endpoint | mcp:write connexion OAuth requise | Modifier une adresse : ses types d’événements, sa pause, ou un nouveau secret, montré une fois. |
| delete_webhook_endpoint | mcp:write connexion OAuth requise | Supprimer une adresse et son journal ; pour changer d’URL, la supprimer puis la recréer. |
| send_test_event | mcp:write connexion OAuth requise | Envoyer tout de suite un événement d’essai signé à une adresse, et lire ce que l’application a répondu. |

## Ce qu’il ne fait pas

- **Pas de campagne sans votre oui.** En Pro, il prépare une campagne et vous en montre le récapitulatif ; il ne la lance qu’avec le code de ce récapitulatif, après votre oui. Hors du Pro, il envoie un modèle à une personne à la fois.
- **Hors de la fenêtre de 24 h, seul un modèle approuvé part.** Un message libre est refusé, avec la raison ; un modèle approuvé part par send_template_to_contact.
- **Numéro WhatsApp délié, rien ne part.** L’outil refuse, avec la raison, jusqu’à ce qu’un administrateur relie le numéro depuis l’Accueil.
- **Les automations ne se déclenchent pas.** Un tag posé par l’assistant classe le contact, sans réveiller les automations qui écoutent ce tag.
- **Activer un agent IA ne le fait pas répondre.** Créé et activé par l’assistant, il parle aux clients dans un scénario publié qui le contient, ou une fois choisi pour répondre au client (set_default_responder, mode « agent ») : il répond alors à tout message que personne ne tient, et l’agent de Meta, s’il est allumé, reste en veille.
- **L’accès passe par une clé ou par une connexion OAuth.** L’une comme l’autre porte l’espace et les droits. Couper un assistant : révoquer sa clé ou son autorisation dans « Clés d’API ».
