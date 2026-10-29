# Bilan des cas d'usage MCP et de leur place sur la vitrine (2026-10-28)

Demande de Julien du 2026-10-28 : faire le bilan des cas d'usage que les outils MCP rendent possibles, dire où les
mettre sur la vitrine (page « Boutiques Shopify », page « SaaS et app builders », autres pages), et réfléchir à l'UX.
**Lecture et proposition seulement : aucune page n'a changé.** Les choix se tranchent avec Julien, puis un plan suit.

Sources lues ce jour : `web/public/developers/mcp.md` (le catalogue public, généré), `src/mcp/*.ts` (la porte d'offre de
chaque outil, champ `fonction`), `src/offres/offres.ts` (les limites), `scripts/plugin/familles-outils.ts` (les familles),
`plugin/skills/`, `features.md` (Shopify, garder son application), `src/shopify/` et `web/lib/partage/shopify-messages.ts`
(ce que le connecteur sait vraiment), les générateurs de la vitrine (`scripts/vitrine/boutique*.ts`, `cas*.ts`,
`scripts/plugin/construire.ts`), la conception de la page Shopify (`docs/superpowers/specs/2026-10-23-vitrine-shopify-design.md`).

## 0. En bref

1. **81 outils MCP au 2026-10-28, en 11 familles.** 70 s'ouvrent à toutes les offres, Free comprise ; 10 demandent le
   Pro (campagnes, ciblage, champs en masse, équipe, chiffres des campagnes et de l'IA) ; 1 demande l'Entreprise
   (l'analyse des conversations). Avec le plugin (connexion OAuth), Claude les voit tous ; une clé d'API n'en voit que 31.
2. **Pour une boutique, la Free fait déjà beaucoup plus que les trois messages** : l'agent IA nourri des pages de la
   boutique, les réponses données depuis Claude, un message à un client précis hors de la fenêtre de 24 h, l'état de la
   boutique et ses chiffres, la tenue sous 100 contacts. Le Pro ajoute la campagne aux clients de la boutique.
3. **Une correction urgente, indépendante du reste** : la page Shopify annonce encore « bientôt » pour garder son
   application WhatsApp Business, alors que c'est en production depuis le 2026-10-25 (`features.md`, « Garder son
   application WhatsApp Business »). Six phrases (trois en français, trois en anglais), c'est la seule page du site qui
   dit encore « bientôt ».
4. **Proposition d'UX** : sur la page Shopify, remplacer « Et ensuite » (trois cartes) par une section « Tout ce que
   Claude fait pour votre boutique », en trois besoins de quatre cartes au plus, chaque carte nommant les outils qui la
   prouvent ; puis la liste complète des outils, repliée par famille, avec le lien vers la doc MCP publique. Sur la page
   SaaS, garder la grille des sept cas filmés et ajouter dessous « Et depuis Claude, sans écrire de code ». L'étiquette
   d'offre et la liste des outils se DÉRIVENT du code par un test, jamais à la main.

## 1. Inventaire des outils

**L'offre de chaque outil se lit dans son champ `fonction`** (`src/mcp/*.ts`) : `null` = toutes les offres ; `console`,
`inbox`, `statistiques` = Pro ; `analyse` = Entreprise. Un outil hors offre reste listé et refuse avec le lien de l'offre
(`src/mcp/serveur.ts`). **OAuth** = l'outil agit au nom d'une personne : visible avec le plugin, invisible derrière une
clé d'API. **QR** = l'outil refuse sur un numéro relié par QR code (filière application, `src/application/garde-outils.ts`),
parce qu'il parle de ce que seule l'API officielle porte.

### Les limites qui changent ce qu'un cas promet (`src/offres/offres.ts`)

| | Free | Pro (49 € HT par mois) | Entreprise |
| --- | --- | --- | --- |
| Contacts | 100, de toutes origines (un client qui écrit compte) | 5 000 créés, entrants illimités | sur devis |
| Modèles envoyés | 1 000 par mois, 500 par jour | illimités par mois, 2 000 par jour | sans limite |
| Utilisateurs | 1 | 3 (sièges en plus) | sans limite |
| Adresses de webhook, journal | 1, 3 jours | 5, 30 jours | sans limite, 30 jours |
| Numéro fourni | 3,50 € HT par mois | inclus | inclus |
| Commission sur le crédit IA | 100 % | 20 % | 10 % |
| Bulle | « Propulsé par Messaging Me » | sans badge (`src/http/widget-public.ts`) | sans badge |

### Mise en service et offre

| Outil | Ce qu'il permet vraiment | Offre | OAuth |
| --- | --- | --- | --- |
| `get_setup_state` | Où en est la mise en service (numéro, agent, répondeur, bulle, crédit, offre) et l'étape suivante | Toutes | |
| `get_plan` | L'offre, ses limites et ce qui en est consommé, avec le lien du Pro | Toutes | |
| `subscribe_pro` | Ouvrir le paiement du Pro (mois ou an) sur Stripe, la personne paie elle-même | Toutes | oui |
| `get_credit` | Le solde du crédit IA et ses derniers mouvements | Toutes | |
| `buy_credit` | Ouvrir le paiement d'une recharge (dès 5 € HT) | Toutes | oui |
| `create_api_key` | Créer la clé d'API de l'application, montrée une fois, rangée dans `.env` | Toutes | oui |
| `list_members` | Les membres de l'espace, pour leur confier un fil | Toutes | |

### Numéro WhatsApp

| Outil | Ce qu'il permet vraiment | Offre | OAuth |
| --- | --- | --- | --- |
| `start_whatsapp_connection` | Le lien de connexion du numéro, valable une heure : numéro fourni, numéro apporté, numéro **gardé dans l'application WhatsApp Business** (mode `coexistence`, en production), ou QR code sans compte Meta Business (répond seulement) | Toutes | oui |
| `watch_whatsapp_connection` | Suivre la connexion jusqu'au bout, code de vérification compris | Toutes | oui |
| `get_number_subscription` | L'abonnement du numéro fourni : statut, fin de période | Toutes | |
| `manage_number_subscription` | Le portail Stripe du numéro (carte, factures, résiliation) | Toutes | oui |
| `resubscribe_number` | Renouveler un numéro impayé ou terminé, le même numéro rendu | Toutes | oui |
| `return_number_at_plan_end` | Rendre le numéro à la fin du Pro, ou le garder à 3,50 € HT par mois | Toutes | oui |

### Agent IA et sa connaissance

| Outil | Ce qu'il permet vraiment | Offre | OAuth |
| --- | --- | --- | --- |
| `list_agents`, `get_agent` | Les agents, leur statut, ce qui leur manque, les modèles d'IA proposés et leur prix | Toutes | |
| `create_agent`, `update_agent` | Créer un agent en brouillon, régler sa fiche (objectif, ton, transferts, règles d'arrêt) et son modèle | Toutes | oui |
| `set_agent_limits` | Plafonner une conversation (réponses, actions, crédit) | Toutes | oui |
| `set_agent_tools` | Les quatre outils sûrs : terminer, chercher, lire le contact, passer la main | Toutes | oui |
| `set_agent_action`, `delete_agent_action` | Une action : ce que l'agent recueille et pousse à votre application (webhook `agent.action`), une fois par jour et par contact | Toutes | oui |
| `test_agent` | Essayer l'agent sur une conversation fictive (débité du crédit) | Toutes | oui |
| `activate_agent` | Activer ou désactiver un agent complet | Toutes | oui |
| `set_default_responder` | Qui répond au client : l'agent de Meta, un agent IA, un scénario publié, l'équipe, ou votre application | Toutes | oui |
| `set_transfer_mode`, `set_business_hours` | Ce que l'agent promet de l'équipe quand il passe la main, et les heures d'ouverture qu'il annonce | Toutes | oui |
| `list_knowledge` | Les fiches de connaissance et leur provenance | Toutes | |
| `preview_site`, `import_site` | Lire un site et l'importer en connaissance (une page relue remplace ses fiches) | Toutes | oui |
| `import_document_text` | Importer le texte d'un document (CGV, politique de retour) | Toutes | oui |
| `add_knowledge`, `delete_knowledge` | Ajouter des fiches écrites (50 par appel), en supprimer | Toutes | oui |

### Conversations

| Outil | Ce qu'il permet vraiment | Offre | OAuth |
| --- | --- | --- | --- |
| `list_conversations`, `get_conversation`, `get_messages` | Les fils, le plus actif d'abord, le détail d'un fil et si la fenêtre de 24 h est ouverte, l'historique | Toutes | |
| `reply_in_open_window` | Répondre, seulement dans la fenêtre de 24 h | Toutes | |
| `send_message` | Dans la fenêtre : image, document, lieu, boutons, liste, bouton lien | Toutes | |
| `control_conversation` | Prendre la main sur un fil, ou la rendre au répondeur | Toutes | |
| `tag_conversation`, `assign_conversation` | Étiqueter le contact d'un fil, confier un fil à un membre | **Pro** (`inbox`) | |
| `get_conversation_insights` | Ce que l'analyse a compris : sentiment, intentions, résolution, sujets, satisfaction, urgence | **Entreprise** (`analyse`) | |

### Modèles

| Outil | Ce qu'il permet vraiment | Offre | OAuth | QR |
| --- | --- | --- | --- | --- |
| `list_templates`, `get_template_status` | Les modèles et leur statut chez Meta, avec le motif d'un refus | Toutes | | refuse |
| `create_template`, `update_template`, `delete_template` | Écrire un modèle et le soumettre à Meta, le corriger, le supprimer | Toutes | oui | refuse (création) |
| `send_template_to_contact` | **Écrire en premier à une personne**, hors de la fenêtre, avec les règles d'envoi (STOP, modèles du mois) | Toutes | oui | refuse |
| `get_message_status` | Envoyé, distribué, lu ou en échec, avec le motif de Meta | Toutes | | refuse |

### Contacts, champs et campagnes

| Outil | Ce qu'il permet vraiment | Offre | OAuth | QR |
| --- | --- | --- | --- | --- |
| `search_contacts`, `get_contact` | Chercher un contact par nom ou numéro, sa fiche et sa dernière analyse | Toutes | | |
| `block_contact` | Bloquer ou débloquer un contact | Toutes | oui | |
| `prepare_contacts_deletion`, `delete_contacts` | Supprimer une sélection (étiquettes, consentement, liste, les N plus anciens, 1 000 au plus), conversations comprises, avec un code de confirmation | Toutes | oui | |
| `list_fields`, `create_field` | Les champs personnalisés, en créer un | Toutes | oui (création) | |
| `set_contact_field` | Remplir un champ sur une cible, en masse | **Pro** (`console`) | oui | |
| `find_contacts` | Les contacts d'une cible : étiquettes, consentement, et en Entreprise la dernière analyse | **Pro** (`console`) | | |
| `tag_contacts` | Étiqueter une cible : un segment est une étiquette | **Pro** (`console`) | oui | |
| `prepare_campaign` | Préparer une campagne de modèle sans rien envoyer : récapitulatif (ciblés, partants, écartés et pourquoi, volume facturable) et code | **Pro** (`console`) | oui | refuse |
| `launch_campaign` | Lancer ou programmer avec le code, après le oui de la personne | **Pro** (`console`) | oui | refuse |
| `control_campaign` | Mettre en pause, déprogrammer, préparer la reprise | **Pro** (`console`) | oui | |
| `list_scenarios` | Les scénarios publiés (ceux qu'une bulle peut démarrer) | Toutes | | |

### Bulle WhatsApp

| Outil | Ce qu'il permet vraiment | Offre | OAuth |
| --- | --- | --- | --- |
| `list_widgets`, `create_widget`, `update_widget` | Créer une bulle (cinq au plus), recevoir la balise à coller, la modifier sans changer la balise | Toutes | |

### Boutique Shopify

| Outil | Ce qu'il permet vraiment | Offre | OAuth |
| --- | --- | --- | --- |
| `connect_shopify` | Brancher la boutique avec l'app que la skill `shopify` a créée dans l'organisation du marchand | Toutes | oui |
| `set_shopify_message` | Brancher un des trois messages : commande payée (prénom, numéro, montant, lien de la commande), expédition (transporteur, numéro et lien de suivi), relance de panier (lien du panier, de 15 min à 72 h, une fois) | Toutes | oui |
| `get_shopify_state` | L'état de la boutique : ses messages, le dernier événement, les issues des 30 derniers jours, les paniers des 7 derniers | Toutes | oui |
| `preview_shopify_customers`, `import_shopify_customers` | Compter puis importer les clients abonnés au marketing qui ont un téléphone, étiquetés « Shopify », consentants par la déclaration du marchand | Toutes (dans la limite de contacts) | oui |
| `disconnect_shopify` | Couper la boutique, les demandes RGPD restent traitées | Toutes | oui |

### Webhooks sortants

| Outil | Ce qu'il permet vraiment | Offre | OAuth |
| --- | --- | --- | --- |
| `create_webhook_endpoint`, `update_webhook_endpoint`, `delete_webhook_endpoint`, `list_webhook_endpoints` | Inscrire une adresse HTTPS, choisir ses événements (`message.received`, `.delivered`, `.read`, `.failed`, `agent.action`, `contact.opted_out`, `template.status_changed`, `conversation.needs_reply`, et en Entreprise `conversation.analyzed`, `contact.risk_changed`), la mettre en pause, changer son secret | Toutes (1 adresse en Free) | oui |
| `send_test_event` | Envoyer un événement d'essai signé et lire la réponse de l'application | Toutes | oui |
| `get_webhook_deliveries`, `replay_webhook_delivery` | Le journal d'une adresse, rejouer un envoi | Toutes | oui |

### Statistiques

| Outil | Ce qu'il permet vraiment | Offre | OAuth | QR |
| --- | --- | --- | --- | --- |
| `get_message_stats` | Modèles envoyés, livrés, lus, en échec, en séries, et le coût estimé | Toutes | | |
| `get_campaign_stats` | Les campagnes de la période, leur coût estimé, leurs clics, les erreurs de Meta, l'entonnoir | **Pro** (`statistiques`) | | refuse |
| `get_ai_stats` | Coût des tours d'agent, messages écrits par l'IA, demandes ouvertes pour l'équipe, actions déclenchées | **Pro** (`statistiques`) | | |

### Les skills du plugin (`plugin/skills/`, version 0.3.14)

| Skill | Ce qu'elle fait |
| --- | --- |
| `/messagingme:demarrer` | Lance ou reprend la mise en service (renvoie à `mise-en-service`) |
| `mise-en-service` | Numéro, agent IA construit depuis le site, répondeur, bulle, essai depuis un téléphone |
| `shopify` | Crée l'app dans l'organisation Shopify du marchand par la Shopify CLI, l'installe d'un clic, règle les messages, importe les abonnés |
| `/messagingme:rappels` | Les rappels de rendez-vous la veille (code Next.js, modèle, actions de l'agent, webhook) : la seule commande de cas publiée |
| `regles-whatsapp` | Fenêtre de 24 h, modèles et catégories, consentement et STOP, qualité du numéro |
| `faq` | Les questions fréquentes (générée depuis `scripts/plugin/faq.ts`) |

## 2. Les cas d'usage, avec leur preuve

Statuts : **prêt** (le produit le fait aujourd'hui, l'outil le prouve) ; **à prouver** (le code le permet, aucun essai
réel ne l'a montré) ; **exclu** (le produit ne le fait pas aujourd'hui, à ne pas écrire).

### 2.1 Boutique Shopify, au-delà du panier et du suivi

| # | Cas | Ce que vit le marchand | Preuve | Offre | Statut |
| --- | --- | --- | --- | --- | --- |
| S1 | Confirmation de commande | Le client reçoit le numéro, le montant et le lien de sa commande | `set_shopify_message` (`order_paid`) | Free | prêt (déjà sur la page) |
| S2 | Avis d'expédition | Le transporteur, le numéro et le lien de suivi | `set_shopify_message` (`order_fulfilled`) | Free | prêt (déjà sur la page) |
| S3 | Relance du panier | Une fois, de 15 min à 72 h, rien si une commande en est née | `set_shopify_message` (`checkout_abandoned`) | Free | prêt (déjà sur la page) |
| S4 | **L'agent IA qui connaît la boutique** | Claude lit les pages de livraison, de retours, la FAQ, les produits, et en nourrit l'agent ; les CGV s'ajoutent en texte ; l'agent répond aux questions après chaque message de la boutique | `preview_site`, `import_site`, `import_document_text`, `create_agent`, `test_agent`, `activate_agent`, `set_default_responder` | Free, crédit IA | prêt |
| S5 | **« Où est ma commande ? », honnêtement** | La confirmation porte le lien de la commande, l'expédition le lien de suivi : le client a déjà la réponse. L'agent répond sur les délais d'après vos pages ; pour un colis précis, il passe la main et annonce vos heures | S1, S2, `set_transfer_mode`, `set_business_hours` | Free | prêt (formule de la conception, § 4) |
| S6 | **Vous répondez depuis Claude** | « Qui m'a écrit aujourd'hui ? », puis la réponse, une photo de produit, une liste de tailles, des boutons ; vous prenez la main sur l'agent et la lui rendez | `list_conversations`, `get_conversation`, `reply_in_open_window`, `send_message`, `control_conversation` | Free | prêt |
| S7 | **Un message à un client précis** | Hors de la fenêtre de 24 h : un geste après un retard, un article de retour en stock pour celui qui l'attendait. Claude écrit le modèle, le fait approuver, l'envoie | `create_template`, `get_template_status`, `send_template_to_contact` | Free (un à la fois) | prêt |
| S8 | Import des clients abonnés | Compter, puis importer les plus récents, étiquetés « Shopify » | `preview_shopify_customers`, `import_shopify_customers` | Free (100 contacts), Pro (5 000) | prêt (déjà sur la page) |
| S9 | **Vos promotions en campagne** | Claude cible les clients étiquetés « Shopify » et consentants, prépare la campagne, montre le récapitulatif et le volume facturable, la lance ou la programme à votre oui, puis donne son coût et ses clics | `find_contacts`, `prepare_campaign`, `launch_campaign`, `control_campaign`, `get_campaign_stats` | **Pro** | prêt (la carte actuelle le dit en une phrase) |
| S10 | **La boutique en un coup d'œil** | Les paniers de la semaine, ce qui est parti sur 30 jours (envoyés, STOP, limite atteinte), les messages livrés et lus, le coût estimé | `get_shopify_state`, `get_message_stats` | Free | prêt |
| S11 | **Rester sous la limite, répondre au RGPD** | En Free, chaque nouveau client compte : Claude supprime les plus anciens contacts en masse, conversations comprises, avec un code de confirmation ; bloque un contact abusif | `prepare_contacts_deletion`, `delete_contacts`, `block_contact` | Free | prêt |
| S12 | **Garder l'application WhatsApp Business** | Le numéro de la boutique reste dans l'application du téléphone et envoie aussi la confirmation, l'expédition et la relance | `start_whatsapp_connection` (mode `coexistence`), `watch_whatsapp_connection` | Free | **prêt, et la page dit encore « bientôt »** |
| S13 | Une demande de retour recueillie par l'agent | L'agent note le numéro de commande et le motif, et les pousse à votre outil | `set_agent_action`, `create_webhook_endpoint` (`agent.action`) | Free (1 adresse) | prêt, mais demande une adresse HTTPS qui reçoit : un développeur |
| S14 | Publicité Click-to-WhatsApp | La pub ouvre la conversation, l'agent la reprend | console seulement (aucun outil MCP) | **Entreprise** | prêt (déjà sur la page) |
| S15 | Bulle WhatsApp sur la boutique | Claude crée la bulle, la balise se colle dans le thème | `create_widget` | Free | **à prouver** : l'essai réel « bulle posée sur le thème » de la conception (§ 9) n'a pas eu lieu |

**Exclus (le produit ne le fait pas aujourd'hui) :** un agent qui lit les commandes ou suit un colis précis (aucun outil,
au backlog) ; un ciblage par montant, produit ou date d'achat (le connecteur n'écrit aucune donnée d'achat sur la fiche,
`find_contacts` ne filtre que les étiquettes, le consentement et l'analyse) ; plusieurs relances, la relance de
navigation, le retour en stock automatique, la demande d'avis après livraison (aucun événement ne les déclenche ; à la
main, S7 ou S9 le font) ; les revenus attribués aux messages (conception du 2026-10-28 en cours, pas en production) ; le
catalogue de produits dans WhatsApp ; une campagne en Free (un modèle à la fois seulement) ; une pub créée par Claude.

### 2.2 SaaS et app builders : ce que les nouveaux outils ajoutent aux sept cas filmés

Les sept cas de la page (rendez-vous, rappels, support IA, bulle, accueil, paiement échoué, notifications) restent. Les
outils ajoutés depuis ouvrent ceux-ci, tous **prêts** :

| # | Cas | Preuve | Offre |
| --- | --- | --- | --- |
| D1 | Vos utilisateurs deviennent des contacts, avec leurs champs (offre, date d'essai) | `create_field`, `list_fields`, API `/v1/contacts` ; `set_contact_field` en masse | Free ; masse en Pro |
| D2 | Une annonce à vos utilisateurs, préparée par Claude, lancée à votre oui | `find_contacts`, `prepare_campaign`, `launch_campaign`, `get_campaign_stats` | Pro |
| D3 | Vos webhooks inscrits, testés et rejoués depuis Claude | `create_webhook_endpoint`, `send_test_event`, `get_webhook_deliveries`, `replay_webhook_delivery` | Free (1 adresse, journal 3 jours) |
| D4 | Vos modèles écrits par Claude et soumis à Meta, le motif d'un refus lu et corrigé | `create_template`, `get_template_status`, `update_template` | Free |
| D5 | L'agent IA qui déclenche votre code (résiliation, demande de démo, rappel commercial) | `set_agent_action`, webhook `agent.action` | Free |
| D6 | Le droit à l'effacement en une demande, conversations comprises | `prepare_contacts_deletion`, `delete_contacts` | Free |
| D7 | Vos chiffres dans Claude : livraison, lecture, coût ; puis l'IA et les campagnes ; puis l'analyse | `get_message_stats` ; `get_ai_stats`, `get_campaign_stats` ; `get_conversation_insights` | Free ; Pro ; Entreprise |
| D8 | Votre assistant au choix : Claude Code, Codex, ChatGPT, Cursor, VS Code, Lovable (connexion OAuth au même serveur) | doc MCP publique, « Connecter un autre client » | Free |
| D9 | Les boutiques Shopify de vos clients (agences, freelances) branchées en une demande | skill `shopify` | Free |
| D10 | Le numéro de l'application WhatsApp Business gardé, votre app qui écrit dessus | `start_whatsapp_connection` (`coexistence`) | Free |

### 2.3 Les autres pages qui gagneraient un cas

- **Développeurs** (`/developpeurs/`, bloc « Ce que vous pouvez construire », généré par `scripts/plugin/construire.ts`
  dans les deux pages ET le README du plugin) : il ne cite ni Shopify, ni les modèles écrits par Claude, ni la suppression
  en masse, ni les webhooks testés et rejoués. Trois lignes à ajouter (D3, D4 et Shopify).
- **Intégrations** (`/integrations/`, écrite à la main) : la carte Shopify ne dit que les trois messages ; ajouter
  l'import des abonnés et l'agent IA. La carte Claude Code peut dire « et votre boutique Shopify ».
- **Aide** (`brancher-ma-boutique-shopify`, fiche publique) : rien de faux ; un paragraphe « Ce que vous pouvez demander
  ensuite » est possible, mais une fiche publique retouchée entraîne `vitrine:aide`, la version anglaise et
  `aide:charger` : à garder pour plus tard.
- **Tarifs**, **Solutions**, **Fonctionnalités** : rien à ajouter, les pages restent sur leur sujet.

## 3. Les corrections à faire, indépendamment du bilan

| Où | Ce qui est faux | Correction |
| --- | --- | --- |
| `scripts/vitrine/boutique-textes.ts` l. 179 (et l. 404 en anglais) | « Garder votre application (bientôt) » | « Garder votre application » |
| l. 226 à 229 (et 448 à 451) | L'issue « Gardez votre application » au futur, avec « En attendant, rien à faire » | Au présent, et la fin du parcours dit : Claude ouvre la fenêtre de Meta, vous reliez l'application, les messages de la boutique partent |
| l. 302 (et 524), FAQ « Quel numéro WhatsApp utiliser ? » | « et bientôt le numéro de votre application WhatsApp Business » | « ou le numéro de votre application WhatsApp Business, que vous gardez » |
| l. 10, commentaire | « s'annonce bientôt : elle est en construction » | La date de mise en production |
| `features.md` l. 127 | « (annoncé « bientôt ») » | Retirer, en vérifiant que `tests/aide-proposer.test.ts` reste vert (une fiche peut porter l'empreinte de la section) |

Ce que la correction ne doit PAS promettre : les messages tapés dans l'application qui apparaissent dans Messaging Me
(lot 2, à venir), et un rattachement toujours au premier passage (l'essai 161 a dû relancer la connexion).

## 4. L'UX proposée

### Les principes, pris à ce qui marche déjà

- **Regrouper par besoin, pas par outil** : le bloc « Ce que vous pouvez construire » de la page développeurs (trois
  familles, « Répondre », « Écrire au bon moment », « Brancher à votre app ») se lit en dix secondes. Les outils
  viennent en preuve, pas en titre.
- **Une carte, une phrase, ses outils en petit** : la carte dit ce que vit le marchand ; une ligne « Avec » cite les noms
  d'outils entre `<code>`, comme les pages de cas (`tests/vitrine-cas.test.ts` vérifie que chaque nom existe).
- ~~L'étiquette d'offre seulement hors de la Free~~ : **remplacé par la décision 4 de Julien** (§ 5), une étiquette sur
  chaque carte et un bloc « Ce que le Pro ajoute », pour donner envie de payer. Les maquettes ci-dessous sont celles
  d'avant cette décision ; le plan porte la liste finale des cartes.
- **Le détail se replie** : la liste complète des outils en `<details>` fermés par famille, lisible sans script et par
  les moteurs, sans allonger la page ; un lien vers la doc MCP publique pour le reste.
- **Quatre cartes au plus par besoin** : au téléphone, la grille `bt-cartes` passe à une colonne, et douze cartes à la
  suite deviennent un long défilement. Trois intertitres le coupent.
- **Rien d'écrit à la main qui se dérive** : chaque carte déclare ses outils (`outils: ['prepare_campaign', ...]`), un
  test vérifie qu'ils existent au catalogue et que l'étiquette égale la plus haute offre de ses outils (`fonction` lue
  dans `src/mcp/`) ; la liste repliée se génère depuis `FAMILLES_OUTILS` et le catalogue, déjà tenus exhaustifs par
  `tests/plugin-readme.test.ts`. Un outil ajouté entre dans la liste sans retoucher la page.

### Page « Boutiques Shopify » : l'ordre proposé

1. La une (inchangée, un troisième lien discret « Tout ce que Claude fait » vers `#claude`).
2. Le problème. 3. Le scénario. 4. Ce que vous branchez (inchangés).
5. **Tout ce que Claude fait pour votre boutique** (remplace « Et ensuite »).
6. **Les outils, un par un** (nouvelle, repliée).
7. Votre numéro WhatsApp (le guide, corrigé du « bientôt »). 8. Commencer. 9. Le prix. 10. FAQ (deux questions de plus).
   11. L'appel.

### Maquette textuelle de la section 5

> **Avec Claude Code**
> ## Tout ce que Claude fait pour votre boutique. <span>Vous le demandez, il le fait.</span>
>
> ### Répondre à vos clients
> - **Votre agent IA connaît votre boutique.** Claude lit vos pages de livraison, de retours et vos produits, et en
>   nourrit votre agent, qui répond quand un client écrit. *Avec `import_site`, `create_agent`, `activate_agent`.*
> - **« Où est ma commande ? »** Le lien de suivi est déjà dans l'avis d'expédition. Votre agent répond sur les délais
>   d'après vos pages, et vous passe la main pour un colis précis, en annonçant vos heures. *Avec `set_business_hours`.*
> - **Vous répondez depuis Claude.** « Qui m'a écrit aujourd'hui ? », puis votre réponse, une photo de produit ou des
>   boutons. Vous prenez la main sur l'agent, et la lui rendez. *Avec `list_conversations`, `send_message`,
>   `control_conversation`.*
>
> ### Faire revenir vos clients
> - **Un message à un client précis.** Un geste après un retard, un article de retour pour qui l'attendait : Claude écrit
>   le message, le fait approuver par Meta et l'envoie. *Avec `create_template`, `send_template_to_contact`.*
> - **Vos promotions, à votre oui.** <span class="bt-offre">Offre Pro</span> Claude prépare une campagne à vos clients qui
>   ont accepté WhatsApp, vous montre combien la recevront et ce qu'elle coûtera, puis la lance ou la programme quand vous
>   dites oui. *Avec `prepare_campaign`, `launch_campaign`, `get_campaign_stats`.*
> - **La publicité Click-to-WhatsApp.** <span class="bt-offre">Offre Entreprise</span> Une publicité Facebook ou
>   Instagram qui ouvre la conversation, et votre agent IA qui la reprend. *(Depuis la console.)*
>
> ### Piloter depuis Claude
> - **Votre boutique en un coup d'œil.** Les paniers de la semaine, ce qui est parti sur 30 jours, les messages livrés
>   et lus, le coût estimé. *Avec `get_shopify_state`, `get_message_stats`.*
> - **Vos messages, écrits pour vous.** Claude rédige vos modèles, les soumet à Meta et vous dit pourquoi l'un est
>   refusé. *Avec `create_template`, `get_template_status`.*
> - **Vos contacts en ordre.** Claude supprime en masse les contacts dont vous n'avez plus besoin, conversations
>   comprises, après votre confirmation, et bloque un contact indésirable. *Avec `delete_contacts`, `block_contact`.*
>
> [Tous les outils de Claude, un par un ↓](#outils)

### Maquette textuelle de la section 6

> ## Les outils de Claude, un par un.
> Claude les choisit pour vous, selon ce que vous demandez. Un outil hors de votre offre vous le dit, avec le lien pour
> changer d'offre.
>
> ▸ **Votre boutique** (6 outils) ▸ **Vos conversations** ▸ **Vos messages et modèles** ▸ **Vos contacts et campagnes**
> ▸ **Votre agent IA** ▸ **Sa connaissance** ▸ **Votre numéro** ▸ **La bulle** ▸ **Vos chiffres** ▸ **Webhooks**
> ▸ **Votre offre**
>
> *(chaque famille se déplie en une liste « `nom_de_l_outil` : ce qu'il fait », avec l'étiquette Pro ou Entreprise sur
> les outils concernés ; les phrases viennent du catalogue de la doc MCP, en français et en anglais)*
>
> [La documentation complète du serveur MCP](https://console.messagingme.app/developers/mcp)

### FAQ, deux questions de plus

- **Puis-je envoyer une promotion à mes clients ?** Oui, avec l'offre Pro : Claude prépare la campagne, vous montre à
  qui elle part et ce qu'elle coûte, et ne la lance qu'avec votre oui. Elle ne part qu'à ceux qui ont accepté WhatsApp, et
  un STOP est toujours respecté. En Free, Claude envoie un message à un client à la fois.
- **Puis-je répondre moi-même à mes clients ?** Oui, en le demandant à Claude : il vous montre qui vous a écrit, vous
  répondez, et vous reprenez la main sur l'agent IA quand vous le voulez. En Pro, votre équipe répond aussi depuis
  l'Inbox de la console.

### Page « SaaS et app builders » : l'ordre proposé

1. La une. 2. Les cas d'usage, grille filmée et grand film (inchangés). 3. **Et depuis Claude, sans écrire de code**
   (nouvelle). 4. Comment ça marche (inchangé). 5. Un lien « Tous les outils MCP » vers la doc.

> ## Et depuis Claude, sans écrire de code.
> Ce que vous demandez à Claude Code (ou Codex, ChatGPT, Cursor, Lovable) une fois votre espace relié.
>
> **Vos utilisateurs**
> - Vos utilisateurs deviennent des contacts, avec leurs champs (offre, fin d'essai). *`create_field`, API contacts.*
> - Une annonce à vos utilisateurs, préparée par Claude et lancée à votre oui. <span class="bt-offre">Offre Pro</span>
> - Le droit à l'effacement en une demande, conversations comprises. *`delete_contacts`.*
>
> **Votre app**
> - Vos webhooks inscrits, testés et rejoués depuis Claude. *`create_webhook_endpoint`, `send_test_event`.*
> - L'agent IA qui déclenche votre code quand un client demande une démo ou une résiliation. *`set_agent_action`.*
> - Vos modèles écrits par Claude et soumis à Meta. *`create_template`.*
>
> **Vos clients**
> - Les boutiques Shopify de vos clients, branchées en une demande. → *Boutiques Shopify*
> - Le numéro de leur application WhatsApp Business gardé, votre app qui écrit dessus.
> - Vos chiffres dans Claude : livraison, lecture, coût. *`get_message_stats`.*

Forme : le style `dev-construire` (trois colonnes, icône par famille, déjà au site), pour ne pas inventer un composant ;
le contenu vit dans `cas-textes.ts` (`TEXTES_CARREFOUR`), bilingue, comme le reste de la page.

### Ce que chaque changement entraîne (rayon de souffle)

- Page Shopify : `scripts/vitrine/boutique-textes.ts` (français ET anglais, la page anglaise n'est pas générée par les
  dictionnaires), `boutique.ts` pour les deux sections, `site.css` pour la liste repliée, `npm run vitrine:cas`,
  `tests/vitrine-boutique.test.ts` (QR code, « coexistence » jamais écrit, agent jamais « gratuit »),
  `tests/vitrine-marque-shopify.test.ts` (aucune phrase qui nomme Shopify ne dit « partenaire » ni « officiel »),
  `site/sitemap.xml` inchangé, `llms.txt` si la description change.
- Page SaaS : `cas-textes.ts`, `cas.ts`, `npm run vitrine:cas`, `tests/registre-vitrine.test.ts`.
- Page développeurs : `scripts/plugin/construire.ts` publie aussi `plugin/README.md` : sa version monte et le plugin se
  republie à la main (`plugin.yml`, `DEPLOY.md`), en listant ce que la tête de `main` emporte.
- Aucune route d'API neuve : la vitrine peut partir dès son push.

## 5. Les décisions de Julien (2026-10-28, deux séries de questions)

1. **Le « bientôt »** se corrige **avec le lot de la page**, dans le même commit.
2. **La section Shopify remplace « Et ensuite »** : « Tout ce que Claude fait pour votre boutique », par besoins.
3. **La liste des outils : toutes les familles, repliées**, générées depuis le catalogue, avec le lien vers la doc MCP.
4. **Il faut donner envie de payer** (Julien : certains outils sont dans toutes les offres, d'autres réservés au Pro et
   au-delà, et la page doit le montrer pour faire monter). D'où : **une étiquette d'offre sur CHAQUE carte** (Free, Pro,
   Entreprise), les cartes Pro mises en avant, et sous les besoins **un bloc « Ce que le Pro ajoute »** avec le bouton de
   l'essai de 14 jours. Cette décision remplace la convention « étiquette seulement hors Free » de la § 4.
5. **Page SaaS : une section « Et depuis Claude, sans écrire de code » sous la grille des cas**, en trois colonnes. La
   demande recueillie par l'agent et poussée à votre outil (S13) y va, pas sur la page Shopify.
6. **Page développeurs : les trois lignes de plus** (Shopify, modèles écrits par Claude, webhooks testés et rejoués), et
   la montée de version du plugin qu'elles entraînent.
7. **La bulle sur la boutique (S15) s'affiche sans attendre l'essai réel** sur un thème Shopify. La carte dit ce qui est
   vrai : Claude crée la bulle et donne la balise à coller dans le thème ; elle ne dit pas que Claude la pose.

Plan des changements : [2026-10-28-vitrine-cas-mcp.md](superpowers/plans/2026-10-28-vitrine-cas-mcp.md).

## 6. L'essai réel qui clôt

Un lot de vitrine se clôt par la relecture de Julien en ligne, en français et en anglais, sur ordinateur et téléphone,
listes repliées ouvertes une à une. Chaque carte a son outil au catalogue, mais les combinaisons S4, S6, S7, S10 et S11
n'ont jamais été jouées sur la boutique de test (les essais 144 et 145 du connecteur restent ouverts dans
`docs/prive/ESSAIS-REELS.md`), ni la bulle sur un thème Shopify : le plan les inscrit à la liste des essais, sans en
faire une condition de la mise en ligne.
