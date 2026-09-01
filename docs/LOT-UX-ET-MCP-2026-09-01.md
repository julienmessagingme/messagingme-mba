# Lot UX + serveur MCP : la liste de Julien du 2026-09-01

> Écrit AVANT le compact, pour que la liste et l'analyse survivent. Rien n'est commencé.
> Les cinq premiers points sont de l'UX et passent par `feature-loop`, un plan par brique.
> Le sixième est une décision d'architecture : mon avis est plus bas, il attend le tien.

---

## 1. Sidebar : sous-menus sous « AI Agent »

Un sous-menu **Other AI agent** et un sous-menu **MBA**, ce dernier portant deux sous-sous-menus :
**MBA guide** et **MBA paramètres**.

⚠️ Les trois écrans existent déjà (`features.md` § Agent IA et § MBA) : c'est une réorganisation de la
navigation, pas de nouvelles pages. Le seul vrai sujet est que la sidebar n'a aujourd'hui **aucun niveau 3**.

## 2. Éditeur de scénario : surligner la flèche cliquée

Sur un scénario chargé en flèches, cliquer une flèche doit la **mettre en évidence** (couleur) pour voir d'un
coup d'œil son point de départ et son point d'arrivée.

⚠️ Les flèches ont déjà un composant à elles (`web/components/WorkflowNode.tsx`, `WFEdge`), donc le
changement est local. À décider : surligner AUSSI les deux blocs reliés, ou seulement la flèche ?

## 3. Analytics QUALI : rendre le tableau actionnable

- Dans **Action suggérée**, cliquer le nombre de conversations ouvre la **liste des conversations concernées**
  (pop-up). Depuis la liste, cliquer une conversation mène à l'Inbox.
- **Export CSV** de cette liste (et PDF, cf. point 5).
- **Filtrer par période** sur tout le quali, comme le quanti le fait déjà.
- **Filtrer sur les sujets fréquents** : cliquer un sujet restreint la sélection de conversations.
- Dans **Détail de conversation**, cliquer une ligne n'envoie plus vers l'Inbox : ça ouvre une **pop-up** qui
  reprend tous les éléments du tableau **plus un résumé** de la conversation, avec un **bouton** pour aller
  dans l'Inbox retrouver la conversation.

✅ **La question de la rétention est DÉJÀ TRANCHÉE et livrée** (programme I, lot 2, le 2026-08-31) :
**conversations et analyses gardées 365 jours**, variable `CONVERSATION_RETENTION_DAYS`. Le plancher RGPD que
tu avais donné était 3 mois, on a pris quatre fois ce plancher. Il n'y a donc rien à décider ici, mais l'écran
doit le DIRE (« au-delà d'un an, les conversations ne sont plus consultables »), sinon un export qui rend
moins de lignes que prévu passera pour un bug.

## 4. Analytics QUANTI : d'où viennent les messages de service

Un tableau qui compte les messages de service en **trois thèmes** : générés par l'**IA**, **scriptés** (venant
d'un scénario), envoyés par un **humain**.

⚠️ À vérifier avant de chiffrer : `conversation_messages` porte `sender_user_id` (humain) et un `type`
(`mba` pour l'agent Meta), et `workflow_node_events` sait quel bloc a envoyé quoi. La distinction est donc
probablement dérivable sans nouvelle colonne, mais **c'est à prouver par une requête** avant de promettre
l'écran.

## 5. Export PDF

Demandé au point 3 pour la liste des conversations. Le dépôt a déjà `web/components/BoutonPdf.tsx` : à
regarder avant d'écrire quoi que ce soit.

---

## 6. Être nous-mêmes un serveur MCP : mon avis

**Oui, et c'est plus intéressant que ça n'en a l'air. Mais pas pour la raison qu'on donne d'habitude.**

L'argument courant (« des agents IA vont piloter les outils ») est vrai mais lointain. L'intérêt CONCRET pour
MessagingMe est plus terre à terre : tes clients ont déjà leurs outils et, de plus en plus, leur assistant.
Un serveur MCP rend la console **atteignable sans intégration** : là où le connecteur HubSpot t'a coûté un
dépôt entier pour UN partenaire, un serveur MCP te rend joignable par tous ceux qui parlent ce protocole, pour
un seul travail. C'est le même pari que le connecteur, en générique.

Et c'est un argument de VENTE face à une DSI : « votre équipe interroge et répond depuis son assistant, sans
qu'on développe quoi que ce soit ».

### Ce que je ferais, et ce que je ne ferais pas

🔴 **Une couche MINCE sur `/v1`, jamais une seconde implémentation.** Un outil MCP = un endpoint `/v1` existant
plus une description. Si la logique se dédouble, elle dérivera, et une dérive sur une surface d'ÉCRITURE veut
dire un agent qui envoie des WhatsApp avec des garde-fous différents de ceux de la console (opt-in, fenêtre de
24 h, template approuvé, débit). C'est la leçon du connecteur, en plus dangereux.

🔴 **Commencer en LECTURE, avec une écriture étroite.** Ma recommandation pour une v1 :
- lecture : `list_conversations`, `get_conversation`, `get_messages`, `get_contact`, `search_contacts`
- écriture bornée : `reply_in_open_window` (refus net hors fenêtre 24 h), `tag_conversation`,
  `assign_conversation`
- **PAS** en v1 : `send_template`, tout ce qui touche aux campagnes, tout ce qui écrit en masse.

La valeur est là de toute façon : un agent qui trie, résume et prépare, un humain qui envoie. Ouvrir l'envoi
de template à un LLM dès la v1, c'est offrir un mégaphone facturé sur un numéro dont la qualité est notée par
Meta.

⚠️ **Le vrai travail n'est PAS le protocole MCP, c'est l'autorisation.** Le serveur en lui-même est petit
(du HTTP sans état qui expose des outils). Ce que ton scénario décrit (`claude mcp add`, une fenêtre de login,
choisir son organisation, approuver l'accès) est un **OAuth 2.1 avec enregistrement dynamique du client**,
c'est-à-dire une TROISIÈME autorité en plus de nos deux actuelles :
- le JWT de session (un humain sur la console),
- les clés d'API `/v1` (une machine, avec des scopes),
- et là : une **délégation** par (utilisateur, client tiers, espace, scopes), révocable, avec un écran qui
  liste ce qui est branché et un bouton pour couper.

C'est ce morceau-là qui coûte, et c'est aussi lui qui décide si une DSI signe. Ne pas le bâcler en réutilisant
une clé d'API : une clé d'API n'est ni révocable par utilisateur, ni limitée à un client, ni traçable.

### Cohérence avec `/v1`

Oui, et dans ce sens : **`/v1` reste la source**, MCP en est une façade. Concrètement, chaque outil MCP doit
citer l'endpoint qu'il appelle, et un test doit vérifier que la liste des outils ne contient rien qui n'ait
pas d'endpoint. Sans cette garde, la façade prendra sa propre vie en six mois.

### Où ça vit

Onglet **Developers** de la sidebar (en bas à gauche), à côté des clés d'API : l'adresse du serveur, la
commande à copier, la liste des outils exposés, et la liste des clients autorisés avec un bouton « révoquer ».

### Mon estimation honnête

- serveur MCP + outils en lecture, sur `/v1` : **S/M**
- OAuth 2.1 délégué, écran de consentement, révocation : **L**, et c'est le gros
- écriture bornée + garde-fous : **M**

⚠️ Et une question à trancher AVANT de coder : **`mcp.mbamessagingme.com` ou un chemin sur
`mba.messagingme.app` ?** Un domaine neuf veut dire un certificat, une entrée NPM, et un nom de plus à
expliquer. Je partirais sur `mba.messagingme.app/mcp`, sauf raison commerciale de séparer.
