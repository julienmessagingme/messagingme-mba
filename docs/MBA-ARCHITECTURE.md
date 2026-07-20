# Ce que MBA implique pour l'architecture de mba.messagingme.app

> Complément de `MBA-API-REFERENCE.md`, qui décrit ce que Meta expose. Ce document-ci décrit ce que **nous**
> devons construire, et dans quel ordre. Écrit le 2026-07-20, après lecture intégrale de la doc v2.0.0.

## Le manque central, et il existe déjà sans MBA

**Notre système n'a aucune notion de qui détient une conversation.**

C'est vérifiable aujourd'hui, sans rapport avec Meta :

- `src/webhooks/workflow-advance.ts` fait avancer le run de workflow sur **tout** message entrant. Aucun
  contrôle sur le fait qu'un humain ait repris la conversation dans l'inbox.
- L'inbox envoie via `sendReply` sans jamais suspendre le workflow en attente sur le même contact.

Conséquence en production : un client répond pendant qu'un humain traite son dossier, et le workflow envoie
sa suite en parallèle. Les deux écrivent au client. C'est un bug réel, visible en démonstration, et il n'a
rien à voir avec MBA.

MBA ne crée donc pas ce problème, il **ajoute un troisième détenteur** à un problème qu'on a déjà à deux.

Côté webhook, la moitié du travail est faite et l'autre pas : `src/webhooks/parse.ts` type déjà `standby` et
`messaging_handovers` (avec le commentaire honnête « Shape peu documentée »), mais **rien ne les consomme en
aval**. Ils sont insérés bruts dans `webhook_events` et ignorés par les traitements métier.

## Le modèle à poser : un détenteur par conversation

Trois détenteurs possibles, exclusifs :

| Détenteur | Qui écrit au client | Comment on y arrive |
|---|---|---|
| `mba` | l'agent de Meta | état par défaut quand MBA est activé et que le contact est dans l'audience |
| `app_workflow` | notre moteur de scénario | notre app envoie un message (l'envoi **prend** le contrôle, il n'existe pas d'action `take`) |
| `app_human` | un opérateur dans l'inbox | un humain envoie depuis l'inbox, ou reprend explicitement la main |

Règles qui découlent directement de la doc Meta et du bug constaté :

1. **Un seul détenteur écrit.** `app_human` gèle l'avance du workflow sur cette conversation. C'est la
   correction du bug actuel, et elle ne dépend de rien chez Meta.
2. **Prendre le contrôle est implicite** : envoyer un message suffit. Il n'y a pas d'action `take` dans
   l'API de contrôle de fil. Donc tout envoi sortant de notre part doit mettre à jour l'état.
3. **Rendre le contrôle est explicite** : `POST .../thread_control` avec `action: "release"`, jamais `pass`
   (voir la contradiction documentée dans la référence).
4. **L'état se recale sur `messaging_handovers`**, qui est la seule source de vérité côté Meta.
5. **Il n'existe aucun release automatique par expiration.** Si personne ne rend la main (opérateur parti,
   crash), la conversation reste bloquée en mode humain et MBA reste muet, indéfiniment. Notre garde-fou
   d'inactivité n'est pas un confort, c'est une obligation.

## Ce qui est constructible aujourd'hui, sans ToS ni éligibilité

Par ordre. Tout ceci a de la valeur **avec ou sans** MBA, ce qui est le critère.

1. **L'état de contrôle et l'exclusion humain / workflow.** Corrige le bug actuel. Testable et démontrable
   immédiatement. C'est la fondation du passage de main, qui est la plus-value centrale du produit.
2. **Consommer `standby` et `messaging_handovers`** au lieu de les laisser inertes : recaler l'état de
   contrôle, afficher les échanges vus en standby dans l'inbox. Sans ça, le jour où MBA s'allume, notre
   production cesse silencieusement de voir les conversations.
3. **Le garde-fou d'inactivité** qui rend la main automatiquement au bout d'un délai configurable.

Ces trois briques ne touchent à aucun endpoint MBA. Elles ne peuvent donc pas être bloquées par les ToS.

## Les questions à trancher AVANT d'écrire le moindre écran de configuration MBA

Elles ne sont pas dans la doc. Elles se répondent en conditions réelles, le jour de l'ouverture.

- **Une campagne sortante prend-elle le contrôle du fil ?** Question de première importance, à
  l'intersection des deux piliers du produit. Si oui, chaque campagne coupe MBA sur tous ses destinataires
  jusqu'à un `release` explicite. Ça changerait la conception de la brique campagnes.
- **Un envoi de template hors fenêtre 24 h a-t-il le même effet qu'un message de session ?**
- **Que fait un `release` quand on ne détient pas le contrôle ?** La précondition est explicite dans la
  spec (« You must currently hold thread control »), la conséquence de sa violation ne l'est pas : erreur,
  no-op, ou 200 trompeur.
- **Quel délai entre le `release` et la reprise effective de MBA ?** Si le client écrit dans l'intervalle,
  qui reçoit le message ?

## Les cinq piliers du produit, face à ce que Meta expose

| Pilier | Ce que Meta expose | Ce qui reste à notre charge |
|---|---|---|
| Onboarder MBA | `agent_eligibility`, `agent_onboarding`, `agent_config/settings` | tout le multi-tenant : Meta pilote **par numéro**, sans partage de config, sans import en masse, sans clonage |
| Contrôle fin de ce à quoi l'agent répond | `ai_audience`, `agent_config/allowlist` | l'interface qui rend ça utilisable, et la protection contre le piège du PUT (voir ci-dessous) |
| Passage de main | `thread_control`, webhooks `standby` / `messaging_handovers`, `handoff` dans les settings | **l'essentiel** : l'état de contrôle, l'inbox, les règles de reprise, le garde-fou d'inactivité |
| Campagnes | rien, MBA ne fait pas de campagne | **tout**, c'est déjà notre brique existante |
| Analyse et remontée HubSpot | rien | **tout**, et ça reste valable quand seul MBA répond |

Les colonnes de droite sont le produit. Meta ne fournit aucune couche multi-tenant, et c'est précisément ce
qu'une agence apporte.

## Deux pièges à câbler dès le premier écran de configuration

**Le PUT des réglages efface l'allowlist.** Il est documenté « remplacement complet » alors qu'aucun champ
n'est requis dans le schéma. Un PUT partiel pour basculer `rollout.enabled` passe la validation et remet
`ai_audience` à son défaut, qui est `EVERYONE`. Notre client HTTP ne doit **jamais** exposer un PUT partiel :
il lit l'état courant, fusionne, et réécrit l'objet complet.

**L'interrupteur n'est pas un kill switch.** Couper l'agent l'arrête sur tous les fils, le rallumer ne le
repart que sur les **nouveaux**. Les conversations ouvertes au moment de la coupure ne sont jamais reprises.
L'interface doit le dire au moment du clic, pas après.

## Ce qu'on ne construit pas

- **Pas de base de connaissance ni de RAG maison.** MBA fournit business info, FAQ, crawl de site et
  fichiers. Le reconstruire serait du code écrit trop tôt dans les deux scénarios : si MBA ouvre, il est
  inutile ; s'il n'ouvre pas, aucun client n'a payé pour ça.
- **Pas de cerveau conversationnel.** C'est ce que MBA apporte, et c'est ce qui justifie de s'appuyer dessus.
- **Pas d'écrans de configuration MBA tant que `agent_eligibility` renvoie 403.** On recevrait une erreur sur
  chaque appel, sans pouvoir tester ni démontrer. Les trois briques de la section précédente, elles, se
  testent aujourd'hui.
