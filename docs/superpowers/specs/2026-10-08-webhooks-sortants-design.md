# Lot 12 : les webhooks sortants, et « mon application répond »

Cadrage du 2026-10-08. La carte de l'existant a été faite par quatre lecteurs parallèles du code, puis par une
synthèse ; les décisions produit ont été posées à Julien en deux rondes, le même jour. Cette spec dit ce qu'on
construit et pourquoi ; le plan dit dans quel ordre.

## Ce qu'on construit

Un espace inscrit une ou plusieurs **adresses HTTPS** de son application et choisit les **événements** qu'elle
reçoit. Chaque événement part en `POST`, **signé** et horodaté, et se **réessaie** pendant 24 heures tant que
l'adresse ne l'accepte pas. Chaque envoi se lit dans un **journal**, se **rejoue**, et un **événement d'essai** se
déclenche d'un bouton. Un cinquième mode du répondeur, **« mon application répond »**, remet chaque message entrant à
l'application du client, qui répond par l'API.

C'est la brique qui manque au client du tunnel (lot 19) : son application, écrite dans Claude Code, apprend ce qui se
passe sur WhatsApp sans interroger l'API en boucle.

## Les décisions

Posées à Julien le 2026-10-08 :

| Sujet | Décision |
|---|---|
| Catalogue | Les huit signaux déjà câblés, plus `message.received` avec le texte, `conversation.needs_reply` et l'événement d'essai. Que des points d'émission uniques déjà en place |
| Données personnelles | Incluses (téléphone, texte, résumé d'analyse) : l'adresse est celle du client, l'envoi est signé et en HTTPS |
| Réponse de l'application | Asynchrone : elle accuse réception (2xx), puis envoie par `POST /v1/messages/whatsapp` |
| Repli si l'application ne répond pas | **Aucun** : l'échec se lit dans le journal, le client WhatsApp reste sans réponse |
| Réessais | Toute réponse hors 2xx et toute panne réseau, pendant 24 h ; l'adresse n'est **jamais** suspendue |
| Quota d'envois de l'API | Les réponses de l'application en mode application n'y comptent pas |
| Entreprise | On acte le code : adresses sans limite, journal de 30 jours (la spec des offres disait « réglable ») |
| Gestion | La console, plus un outil MCP qui crée une adresse et lance l'essai ; le reste de l'API (liste, journal, rejeu) au lot 13 |

Tranchées à l'exécution, sur la recommandation de la carte, parce qu'elles sont techniques :

- **Les noms sont pointés** (`message.received`), pas `em_*` : `em_` est un héritage d'Engage Me et une borne
  propre à Batch. Le dictionnaire des signaux garde ses noms ; la traduction est un tableau, un pour un.
- **La signature suit Standard Webhooks** (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`
  sur `id.timestamp.corps`, HMAC-SHA256, secret `whsec_`) : des bibliothèques existent dans tous les langages, la
  rotation y est prévue, et le chemin n'entre pas dans la préimage (`signRequest` l'y met, ce qui casse derrière un
  proxy qui réécrit le chemin).
- **Un secret par adresse**, montré une seule fois, chiffré au repos ; la rotation garde l'ancien valide 24 h (les
  deux signatures partent, séparées par une espace, comme le standard le prévoit).
- **Les chemins de masse émettent**, sur abonnement par type, comme les signaux aujourd'hui ; les trois statuts de
  livraison sont **décochés par défaut** à la création d'une adresse, et partent en priorité basse.
- **Le rejeu** est unitaire, plus « rejouer les échecs d'une adresse depuis une date », borné et compté dans le
  plafond des opérations coûteuses ; un rejeu porte le même `id` d'événement.
- **La cible du mode application** est une adresse désignée (`on delete set null`), comme les modes agent et
  scénario.

## Le catalogue

Livraison « au moins une fois », un événement par requête, aucun ordre garanti. Chaque événement porte un `id`
stable (le même au réessai et au rejeu, dérivé d'une clé naturelle quand elle existe : c'est ce qui permet au client
de dédoublonner) et la date où il s'est produit.

| Type | D'où il part (point unique existant) | Note |
|---|---|---|
| `message.received` | le message entrant (`em_replied`, `src/webhooks/inbound.ts`) | porte le texte, le type et le bouton ; part aussi pour un message qu'un scénario consomme |
| `message.delivered`, `message.read`, `message.failed` | les accusés de Meta (`src/webhooks/delivery.ts`) | décochés par défaut, priorité basse |
| `link.clicked` | la redirection d'un lien tracé | |
| `contact.opted_out` | la transition unique du consentement | part aussi d'une action en masse |
| `conversation.analyzed` | la fin d'une analyse | porte le résumé ; sa clé passe d'un aléa à `conversation:analyzedAt` |
| `contact.risk_changed` | le balayage de nuit | priorité basse |
| `conversation.needs_reply` | la remise d'un message entrant en mode application | livraison B ; à l'adresse désignée seulement |
| `test` | le bouton « Envoyer un essai » et l'outil MCP | |

**L'enveloppe** est la même pour tous :

```json
{
  "id": "evt_…",
  "type": "message.received",
  "created_at": "2026-10-08T14:03:11.000Z",
  "workspace_id": "…",
  "data": { "contact": { "id": "…", "phone": "+33…", "external_id": null }, "…": "…" }
}
```

Le contenu est **figé à la première tentative** et gardé dans le journal : un réessai renvoie exactement le même
corps, pas l'état de la fiche au moment du réessai.

**Reportés**, faute de point d'émission unique ou de clé stable : `contact.created`, `contact.updated`,
`contact.opted_in`, `flow.completed`, `campaign.completed`, `form.submitted`, `conversation.escalated`. Le RCS
garde ses accusés et son STOP, mais n'a pas de remise, donc pas de `needs_reply`.

## L'envoi

Deux étages, sur le bus existant des signaux (`creerEmetteur`, `src/signaux/emetteur.ts`), branché comme une
destination de plus. Brancher une destination ajoute d'un coup les huit sources déjà câblées ; il faut seulement que
la destination puisse refuser un type (`accepte(nom)`).

1. **La distribution** reçoit les signaux d'un espace, relit les adresses actives qui en veulent, complète et fige
   le contenu, écrit une ligne d'envoi par couple (événement, adresse), et enfile un job d'envoi par ligne.
2. **L'envoi** fait un seul `POST` : HTTPS obligatoire, adresse vérifiée sur son texte, sa résolution et à
   l'ouverture de la connexion (`fetchPublic`), aucune redirection suivie, corps de réponse lu borné, 10 s au plus,
   aucune transaction ouverte pendant l'appel. Une réponse 2xx livre ; toute autre issue programme l'essai suivant.

**Les réessais** se programment par la ligne d'envoi, qui compte ses tentatives (le job ne voit que ses données) :
30 s, 2 min, 10 min, 30 min, puis toutes les heures, jusqu'à 24 h après la première tentative. Un `410 Gone` arrête
les réessais de cet envoi, sans toucher à l'adresse. Une adresse n'est jamais suspendue : elle reste active même si
elle échoue depuis des jours, et l'écran le montre.

**L'équité** : les jobs portent l'espace en `groupId`, avec une concurrence bornée par espace, pour qu'une campagne
d'un client ne retarde pas les événements des autres. Les accusés de livraison partent en priorité basse, derrière les
gestes du contact.

**Un espace verrouillé** (suppression en cours) n'envoie plus rien : le worker le vérifie lui-même avant chaque envoi.

## Le journal et le rejeu

Chaque ligne d'envoi garde : l'adresse, le type, l'`id` de l'événement, le corps envoyé, le statut (en cours, livré,
en échec), le nombre de tentatives, le dernier code HTTP, un extrait borné de la dernière réponse ou de l'erreur, la
date du prochain essai. Le journal se purge selon l'offre (3 jours en Base, 30 en Pro et en Entreprise), en SQL, par
`offre_de_l_espace`. Chaque ligne porte le contact quand il y en a un, et la purge RGPD d'un contact
(`PgContactStore.purgeMany`) l'efface dans la même transaction.

Le rejeu d'un envoi crée une nouvelle tentative avec le même corps et le même `id`. « Rejouer les échecs depuis une
date » est borné en nombre et compté dans le plafond des opérations coûteuses.

## La console

Un écran **« Webhooks sortants »** sous Développeurs (`/developers/evenements`), à côté des clés et du MCP :

- la liste des adresses, avec leur état (dernière livraison, échecs en cours) ;
- créer une adresse : l'URL, une description, les types cochés (statuts de livraison décochés par défaut) ; le
  secret s'affiche une seule fois ;
- par adresse : modifier les types, mettre en pause ou réactiver à la main, faire tourner le secret, supprimer,
  « Envoyer un essai » ;
- le journal de l'adresse, chaque envoi dépliable (corps envoyé, réponse), « Rejouer », et « Rejouer les échecs
  depuis… ».

Réservé aux admins pour les écritures, comme les clés d'API. Le mot « webhook » désigne déjà l'**entrée** dans le
code (table `webhooks`, `src/webhooks/`, routes `/tenants/:id/webhooks`) : le code de ce lot prend un autre nom
(`src/evenements/`, tables `adresses_evenements` et `envois_evenements`), l'écran seul dit « Webhooks sortants ».

## L'offre

Une **limite**, pas une fonction : la Base y a droit. Base 1 adresse et journal de 3 jours, Pro 5 adresses et 30
jours, Entreprise sans limite et 30 jours (déjà dans `src/offres/offres.ts`). Créer ou réactiver une adresse au-delà
rend 402 `plan_limit_reached`. Au retour en Base, les adresses en trop ne sont pas effacées : elles sont gelées au
point d'envoi, les plus anciennes restant actives, comme les automations. La page de l'offre affiche les deux lignes.

## Claude Code

Un outil MCP crée une adresse (URL, types) et rend le secret une seule fois, à ranger dans une variable
d'environnement de l'application ; un second envoie l'événement d'essai et rend son issue. C'est ce qui permet au
client du tunnel de brancher son application sans quitter Claude Code. La liste, le journal et le rejeu passent par
l'API et le MCP au lot 13.

La documentation publique gagne une page : l'enveloppe, chaque type et ses champs, la vérification de la signature
(avec un exemple en Node), les réessais et le dédoublonnage par `id`. Elle est tenue en parité avec le catalogue par
un test, comme le dictionnaire des signaux.

## « Mon application répond » (livraison B)

Un cinquième mode du répondeur, à côté du MBA, de l'agent IA, du scénario et de l'équipe, avec une adresse désignée.

- Quand un message entrant arrive à la remise et que le mode est « application », la plateforme envoie
  `conversation.needs_reply` à l'adresse désignée (les messages mis bout à bout, comme pour l'agent IA), sur une file
  notifiée tout de suite, et le fil est tenu par l'application. Il n'entre pas dans « À traiter ».
- L'application répond par `POST /v1/messages/whatsapp`. 🔴 **Aujourd'hui, une réponse par l'API donne le fil à
  l'équipe** (`takeControl` écrit `app_human`), et l'application ne serait plus jamais sollicitée : sur un fil tenu
  par l'application, une réponse de l'API ne prend pas le fil.
- Ces réponses ne comptent pas dans le quota quotidien d'envois de l'API ; le plafond par minute reste.
- **Aucun repli** : si l'application ne répond pas, rien ne se passe et l'échec se lit dans le journal. Un membre de
  l'équipe peut toujours prendre le fil à la main (Pro et Entreprise).
- Si l'adresse désignée disparaît ou est gelée par l'offre, le mode se lit « équipe », comme quand l'agent désigné
  disparaît.
- L'outil MCP `set_default_responder` hérite du mode (son énumération dérive de la liste) et prend l'adresse.

🔴 **Ordre de déploiement** : un ancien worker lit un mode inconnu comme « agent », ou « MBA » si l'agent de Meta est
allumé. La migration passe, puis l'API et les deux workers dans le même `up`, puis la console, qui seule permet de
choisir le mode.

## Ce que le lot ne fait pas

Pas de repli automatique, pas de suspension automatique d'une adresse, pas d'ordre garanti, pas de filtre par contact
ou par étiquette, pas de transformation du corps, pas de réponse synchrone. Pas d'API de gestion des adresses avant le
lot 13.

## Les contraintes qui tiennent

- Toute table neuve porte `tenant_id` en `on delete cascade` et aucune clé en `restrict` (sinon la suppression d'un
  espace casse), et sa migration passe avant le code qui la lit.
- Toute nouvelle file entre dans `BASE_QUEUES` et ses tableaux exhaustifs (scrutation, notification, rôle).
- Le fichier qui appelle l'adresse d'un client entre dans les deux inventaires de `tests/lib-adresse-privee.test.ts`.
- Le secret n'apparaît ni dans un journal, ni dans l'audit, ni dans une réponse après sa création.
- Les écrans sont en classe `tenant` ; aucune route anonyme ; un outil MCP entre dans `OUTILS_MCP` et sa page dans
  le même commit.
- Toute retouche de `features.md` passe `tests/aide-proposer.test.ts` avant le push.
