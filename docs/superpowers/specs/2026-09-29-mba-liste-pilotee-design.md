# L'agent de Meta en mode liste, tenue par la plateforme : cadrage

Validé par Julien le 2026-09-29, après une mesure en direct sur son numéro et deux rondes de questions. Un seul
lot. Code lu sur `origin/main` à `d8935b6c`.

## Le problème

Un scénario qui commence par un modèle se fait couper par l'agent de Meta : le contact appuie sur un bouton, et
l'agent répond à la place du scénario (vécu le 2026-09-29 avec « clubmed2 »). Un scénario sans modèle, lui,
fonctionne. La règle de Julien : **pendant un scénario, l'agent se tait ; il ne parle que quand le client fait
quelque chose que le scénario n'a pas prévu**, ou quand personne d'autre ne lui répond.

## Ce qui est mesuré

Sur le numéro de l'espace « Messaging Me Tech SANDBOX », le seul espace qui a l'agent allumé (mesuré le
2026-09-29 dans `tenant_settings.mba_enabled`).

**En mode « tout le monde »** (`ai_audience = EVERYONE`, le réglage jusqu'au 2026-09-29 à 18 h 59 UTC) :

- Un **modèle** rend la conversation à l'agent de Meta : la réponse du contact arrive en `standby`, et l'agent y
  répond. Mesuré quatre fois, y compris juste après un message libre d'un opérateur.
- Un **message libre** nous donne la conversation. C'est la règle que Meta documente, et c'est pourquoi un
  scénario sans modèle (démarré par un message du contact, dans les 24 h) n'est jamais coupé.
- L'action `take` de `thread_control` ne nous rend rien : Meta répond 200 sans effet, ou l'agent envoie sa phrase
  de passation (« Merci d'avoir pris contact avec nous. Un membre de l'équipe reprendra la conversation… »). Meta la
  réserve à un « escalation partner » qu'il ne définit nulle part. **Nous ne savons pas reprendre une conversation
  à l'agent.**
- Les deux correctifs du jour n'y changent rien : `b03ee0ef` fait avancer le scénario sur un bouton reçu en
  `standby`, mais l'agent répond aussi ; `a3d67af7` (une prise juste après le modèle) ne sert à rien.

**En mode liste** (`ALLOWLISTED_ONLY`, posé à la main à 18 h 59 UTC, liste vide) :

| Heure (UTC) | Geste | Ce qui s'est passé |
|---|---|---|
| 19:01:08 | Message spontané « Bonjour test a » | Arrive chez nous (`messages`), l'agent se tait |
| 19:01:52 | `release` seul | L'agent se tait (26 s d'observation) |
| 19:02:33 | Ajout du numéro à la liste | L'agent se tait (30 s) |
| 19:03:18 | `agent_event` (`reponse_hors_parcours`, payload « mesure ») | L'agent répond à 19:03:27, en enchaînant sur le mot du payload |
| 19:04:13 | Retrait du numéro de la liste | |
| 19:04:31 | « Test b » | Arrive en `standby` (l'agent tient le fil), l'agent se tait |
| 19:08:50 | Club Med lancé depuis l'Inbox, modèle envoyé | |
| 19:08:56 | Bouton « En savoir plus » | Arrive en `standby`, l'agent se tait, le scénario avance (correctif `b03ee0ef`) et répond à 19:08:59 |

Ce qu'on en tire :

- **La liste est le seul interrupteur par contact que Meta nous donne.** Un contact absent de la liste n'entend
  jamais l'agent, même quand Meta lui a rendu le fil.
- **Confier une conversation à l'agent demande trois gestes** : l'ajout à la liste, le `release`, et un
  `agent_event` pour qu'il réponde au message déjà reçu. Sans l'événement, il attend le message suivant.
- **Le retrait joue tout de suite.**
- 🔴 **En mode liste, Meta continue de ranger des messages en `standby` alors que l'agent se tait.** Aujourd'hui,
  tout le code ignore un `standby` (sauf nos boutons depuis `b03ee0ef`) : sans la pièce 4 ci-dessous, une réponse
  en texte libre après un modèle n'arriverait à personne.
- L'agent répond d'après le texte de l'événement. Ce qu'il sait du modèle envoyé avant n'est pas mesuré.

## Décisions de Julien

| Question | Décision |
|---|---|
| Mode | La plateforme pose **toujours** la liste quand un espace allume l'agent. Le choix « tout le monde » disparaît |
| Liste par défaut | **Vide**. Seuls y sont les contacts que la plateforme vient de confier à l'agent |
| Panneau manuel de la liste | **Retiré** de la console : la plateforme tient la liste seule |
| Sortie de liste | **Seulement quand on reprend la parole** (un modèle, une reprise délibérée). **Jamais par inactivité** |
| « Rendre la main » (bouton de l'Inbox, fin de scénario, balayage) | L'agent parle **au prochain message** du client, sans événement |
| Message que personne ne prend, réponse imprévue dans un scénario | Confié à l'agent, qui y répond **tout de suite** (événement) |
| Pendant ce lot | Le numéro reste en mode liste, liste vide : les scénarios marchent, un contact spontané arrive dans l'Inbox |

## Design

Deux gestes, deux règles, et une pièce à l'arrivée des messages.

### 1. Deux gestes, dans le module de la conversation (`src/inbox/fil.ts`)

Un module neuf, `src/mba/liste.ts`, porte la table (§5) et les deux appels Meta (`addToAllowlist`,
`removeFromAllowlist`). `fil.ts` et la fabrique Meta (§2) s'en servent tous les deux. Il reçoit le client MBA par
une fonction, pour ne pas dépendre de la fabrique qui le reçoit.

**Confier** `(tenantId, waId)` :

1. agent éteint pour l'espace : rien, comme aujourd'hui ;
2. conversation de test, sur un chemin automatique : rien (règle existante de `remiseAutomatique`). Le bouton de
   l'Inbox, geste humain, reste permis ;
3. aucun numéro connecté : rien (`aucun_numero`) ;
4. contact absent de la table : ajout chez Meta (E.164), puis écriture de la ligne avec l'identifiant rendu ;
5. `release` chez Meta.

Il remplace l'acte `releaseThread` de `acteChezMeta`. Tous les chemins qui rendent la conversation en héritent :
le bouton « Rendre la main » (`rendreLaMain`), la fin de scénario (`rendreApresParcours`, `remettreSurAccuse`),
`remettreSiPersonneNeSuit` et le balayage (`rendreApresInactivite`).

**Reprendre** `(tenantId, waId)` :

- contact présent dans la table : retrait chez Meta, avec l'identifiant et le numéro gardés, puis suppression de la
  ligne. Un 404 de Meta vaut retrait ;
- contact absent : aucun appel ;
- un rejeu, jamais deux, sur une erreur rejouable (les constantes `REJEU_*` existantes) ;
- 🔴 **il ne dépend pas de `mbaEnabled`** : une ligne présente se retire même si l'agent a été éteint entre-temps.
  Sans ça, l'agent répondrait à ce contact le jour où on le rallume.

Il remplace `prendreAvecUnRejeu` dans `reprendreLaMain`, `reprendrePourLApp` et `prendrePourLEquipe`. Leur
contrat ne change pas : `false` veut dire que Meta a refusé, et chaque appelant garde son comportement de refus
actuel (409 dans l'Inbox, démarrage de scénario annulé, lead en `reprise_refusee`). `reprendreLaMain` retire
désormais dès que le contact est dans la table, quelle que soit la colonne.

`prisEnEcrivant` ne bouge pas : un opérateur qui écrit envoie un message libre, qui nous donne la conversation.

### 2. Règle 1 : retirer avant tout modèle, dans la fabrique Meta

`MetaClientFactory.clientForTenant` (`src/meta/factory.ts`) est le point de passage de tous les envois. L'arbitre de
débit et la garde du numéro délié y vivent déjà pour cette raison. Trois constructions de client peuvent envoyer un
modèle, et toutes passent par elle :

- le scénario (`src/workflow/wiring.ts`) ;
- la campagne (`src/worker.ts`, `senderForTenant`) ;
- l'Inbox (`src/index.ts`, `sendTemplateMessage`).

Une nouvelle dépendance **requise**, `listeDeLAgent`, fait envelopper par le client rendu `sendTemplate` et
`sendMarketing` : avant l'appel, **reprendre** le destinataire, ramené aux chiffres nus. Requise pour la même raison
que `numerosDelies` : une garde optionnelle oubliée par un câblage compilerait et laisserait partir le modèle. Les
fixtures disent leur hypothèse.

- **Coût** : une lecture par clé primaire par modèle, et un appel à Meta pour les seuls contacts présents dans la
  table. Une campagne de 1 000 contacts, c'est 1 000 lectures et autant d'appels que de contacts sur la liste.
  Aujourd'hui, une campagne à scénario fait un `take` par destinataire : il disparaît.
- **Les deux formes d'un numéro** (relecture du 2026-09-30) : le modèle part vers le numéro de la fiche, la ligne
  porte le `wa_id` du webhook, et les deux diffèrent pour un mobile brésilien d'avant le 9 ou un mobile mexicain
  (`521`). Le retrait lit donc la table sous les deux formes (`formesDuNumero`).
- 🔴 **Retrait refusé : le modèle ne part pas.** L'erreur levée est traitée par chaque appelant comme un refus
  temporaire d'envoi : rejeu pour la campagne, message « réessayez » pour l'Inbox, chemin d'échec d'envoi pour le
  scénario. Le plan vérifie ce comportement appelant par appelant.
- L'envoi à blanc (`DRY_RUN`) ne passe pas par la fabrique : rien n'est envoyé, donc rien n'est retiré.

### 3. Règle 2 : confier, et prévenir l'agent

**Un message que personne ne prend.** `remettreSiPersonneNeSuit` garde ses trois gardes : agent allumé, aucun
parcours en attente, conversation pas tenue par un opérateur. Ensuite :

1. **confier** ;
2. écrire `mba` dans la colonne ;
3. envoyer l'événement `message_sans_suite`, avec le contenu du message.

Elle reçoit donc le message en plus du contact. Ses deux appelants le tiennent : `remise-mba-entrant.ts` et
`rendreLesFilsSansReponse` (routage publicitaire). Si plusieurs messages du même contact arrivent dans le même lot
de webhook, un seul événement part, avec leurs contenus mis bout à bout dans la borne existante de 4 096
caractères.

C'est ce chemin qui sert la campagne de modèle seul dont le devenir est « l'agent de Meta prend la main », ou qui
n'en a pas : sa réponse n'est prise par personne, donc elle est confiée à l'agent.

**Une réponse imprévue dans un scénario.** Le chemin existe : l'exécuteur appelle `rendreLaMainAMba` avec
`transmettre`, puis `transmettreHorsParcours` envoie `reponse_hors_parcours` si la colonne dit `mba`. La réponse du
client est plus récente que notre dernier envoi. `demanderReleaseMba` ne diffère donc pas (règle posée le
2026-09-22), la conversation est confiée tout de suite, et l'événement part. 🔴 **Un test le prouve sur la chaîne
réelle** (`rendreApresParcours` puis `transmettreHorsParcours`), pas sur des fixtures : l'inventaire du 2026-09-29
a relevé que la garde `mba` saute l'événement dès que la remise est différée.

**Les événements** (`src/mba/evenement.ts`) :

- `reponse_hors_parcours` reste, pour la réponse imprévue ;
- `message_sans_suite` s'ajoute. Description : « Le client vient de t'écrire et aucun parcours automatique ne lui
  répond : tu prends la conversation. Réponds-lui maintenant, brièvement et naturellement, à partir de son
  message. »

Le contenu est le corps enregistré (texte, légende, ou libellé du média). Un vocal part comme `[audio]` : sa
transcription ne se fait qu'à la demande d'un opérateur, jamais à l'arrivée du message, donc elle n'existe pas
encore au moment de l'événement.

**Aucun événement quand on rend la main** (bouton de l'Inbox, fin de scénario, balayage) : décision de Julien,
l'agent parle au prochain message.

### 4. À l'arrivée : un contact absent de la liste parle à la plateforme

Dans `handleWebhookJob` (`src/webhooks/handler.ts`), juste après `rattacherLesEntrants` et avant `processInbound`,
une étape réécrit le champ de certains entrants. La condition : l'espace a l'agent allumé, l'entrant est en
`standby`, et le contact est **absent de la table**. L'entrant passe alors en `messages`. Le champ reçu de Meta
reste lisible, pour le journal. Une seule lecture de la table par lot de webhook.

Ce qui en découle, sans toucher aux consommateurs :

- le scénario avance sur un bouton **et** sur du texte ;
- les automations se déclenchent ;
- la règle 2 joue quand personne ne prend le message ;
- le routage publicitaire prend `pub_seule` ;
- `arrivees_pub.en_standby` vaut `false` ;
- `entrantEnStandby` n'écrit plus `mba` pour ces messages.

Contact **présent** dans la table : rien ne change, l'agent parle et le reste du code ignore le message comme
aujourd'hui. Espace **sans** agent allumé : rien ne change. Un `standby` y veut dire qu'une autre application tient
le fil.

Elle rend inutile le cas particulier des boutons de `b03ee0ef` (§8).

### 5. La mémoire de la liste : migration 0195

La table `mba_liste`, une ligne par contact présent sur la liste de l'agent :

- `tenant_id uuid not null`, clé étrangère vers l'espace en `on delete cascade` ;
- `wa_id text not null` (chiffres nus) ;
- `phone_number_id text not null` : le numéro sur lequel l'entrée a été créée, celui du retrait ;
- `entree_id text not null` : l'identifiant rendu par Meta, sans lequel on ne peut pas retirer ;
- `ajoute_le timestamptz not null default now()` ;
- clé primaire `(tenant_id, wa_id)`, et **aucun autre index** : les deux lectures (avant un modèle, à l'arrivée)
  passent par elle.

Numéro **0195** : 0194 est prise par le lot des indicateurs de performance, écrite et pas encore poussée.

Elle **crée** une table que le code neuf lit sur le chemin chaud (chaque modèle, chaque `standby`), donc elle passe
**avant** le `up`. L'ancien code l'ignore. Elle naît vide, ce qui colle à la liste du numéro, vide depuis 19:04:13
(relu en GET avant le déploiement).

⚠️ **Écrire la ligne APRÈS l'ajout chez Meta, et défaire l'ajout si l'écriture échoue.** Sans l'identifiant, on ne
peut plus retirer : un contact sur la liste que la table ignore recevrait nos modèles avec l'agent qui répond.

⚠️ **À mesurer avant d'écrire le code** : ce que Meta rend quand on ajoute un numéro déjà présent (doublon, erreur,
ou l'entrée existante). La route actuelle relit toute la liste avant d'ajouter, ce qui ne tiendra pas quand la liste
grossira.

### 6. Réglages et console

- `modifierSettings` (`src/mba/client.ts`, lecture puis écriture) écrit **toujours**
  `ai_audience: 'ALLOWLISTED_ONLY'`. Tous ses appelants en héritent : l'activation, la route `rollout`, la mise en
  service de l'assistant, le balayage du passage de main, le PATCH des réglages.
- **L'allumage suit l'ordre que Meta prescrit** : l'audience, une relecture en GET, puis `rollout.enabled`. C'est
  l'entrée « Scinder le PUT d'activation » de `todo.md`. Cela concerne `appliquerActivation`, la route `rollout` et
  `mettreEnService`. En mode liste, Meta n'exige pas de moyen de paiement pour allumer.
- Le PATCH `.../mba/settings` refuse `aiAudience` (400, avec un message qui dit pourquoi). Les trois routes de la
  liste (`GET`, `POST`, `DELETE .../allowlist`) disparaissent.
- Console : le choix d'audience (`MbaOverviewPanel`) et `MbaAllowlistPanel` disparaissent, avec leurs fonctions de
  `web/lib/api-mba.ts` ; les e2e qui les couvrent suivent.
- `scripts/mba-activer-restreint.mts` disparaît : il remplit la liste à la main, et la table ne le saurait pas.

### 7. Purge RGPD

`PgContactStore.purgeMany` supprime, dans sa transaction, les lignes de `mba_liste` des contacts purgés, et les
rend. Après la validation, la route les retire chez Meta, en best-effort journalisé : le numéro d'un contact purgé
n'a rien à faire chez Meta.

### 8. Ce qui disparaît

- `MbaClient.takeThread` et l'action `take`.
- `reprendreSurNotreBouton`, `NOTRE_BOUTON`, l'exception `standby` de `workflow-advance.ts`, sa dépendance et la
  fixture `aucuneRepriseSurBouton`. La pièce 4 les rend inutiles.
- `retenirApresNotreModele`, la dépendance `retenirApresModele` de l'exécuteur et la fixture `aucuneRetenue` (le
  correctif `a3d67af7`, mesuré inutile).
- La cause `boutonDuScenario`.
- Les routes de la liste, le panneau, le choix d'audience, le script d'activation restreinte.

### 9. Quand Meta refuse

| Geste | Si Meta refuse | Conséquence |
|---|---|---|
| Ajout (confier) | Journalisé, rien n'est rendu. Sur la règle 2, la conversation passe à l'équipe (`app_human`, cause « l'agent de Meta n'a pas pu prendre la conversation ») | Elle entre dans « À traiter » et l'équipe répond. Laissée `app_workflow`, elle en sortait sans réponse (corrigé le 2026-09-30) |
| Écriture de la ligne après l'ajout | Retrait immédiat chez Meta, puis erreur | Aucune entrée orpheline |
| `release` après l'ajout (ou la présence) sur la liste | Journalisé, **pas une erreur** : le contact est confié, la colonne passe à `mba` | C'est la liste qui décide si l'agent parle. Meta refuse le `release` quand son agent tient déjà le fil, ce qui arrive après tout modèle (vécu à l'essai réel du 2026-09-30). Si nous tenions en fait le fil, le prochain message arrive en `messages`, la règle 2 rejoue le `release` et, accepté, prévient l'agent |
| Retrait avant un modèle | Le modèle ne part pas | Refus temporaire d'envoi, rejoué par l'appelant |
| Retrait (reprise délibérée) | Comme une prise refusée aujourd'hui | 409 dans l'Inbox, démarrage annulé, lead `reprise_refusee` |
| Événement | Journalisé | La colonne dit `mba`, l'agent répondra au prochain message |

## Invariants tenus par des tests

Chacun est vérifié dans les deux sens : le test échoue quand on retire ce qu'il garde.

1. Aucun `sendTemplate` ni `sendMarketing` ne quitte la fabrique vers un contact présent dans la table. Un retrait
   refusé veut dire aucun envoi.
2. **Confier** ordonne : ajout, ligne, `release`. **Reprendre** ordonne : Meta, puis la ligne.
3. Agent allumé : un `standby` d'un contact absent de la table est traité comme `messages` par l'avance (texte et
   bouton), les automations et la règle 2. Contact présent : inchangé. Agent éteint : inchangé.
4. Réponse imprévue dans un scénario : l'événement part vraiment, sur la chaîne réelle du module.
5. Message sans suite : confier, puis `message_sans_suite` avec le contenu. Aucun événement si confier échoue.
6. Toute écriture des réglages porte `ALLOWLISTED_ONLY`. L'allumage suit l'ordre audience, relecture, `rollout`.
7. Plus aucune occurrence de `takeThread` ni de l'action `take` (test d'inventaire).
8. `listeDeLAgent` est requise par la fabrique, et les fixtures la nomment.
9. `mba_liste` (clé primaire, cascade) et la purge, en test d'intégration (job `integration` de la CI).

## Ordre de déploiement

1. **Mesures préalables** : le doublon d'ajout (§5), puis le GET des réglages et de la liste du numéro (attendu :
   `ALLOWLISTED_ONLY`, liste vide).
2. CI lue job par job (`gh run view <id> --json jobs`).
3. VPS, dans cet ordre :
   1. `build` de l'image ;
   2. `ls` des migrations dans l'image ;
   3. lecture de `pg_stat_activity` ;
   4. `migrate` (0195), puis relecture en base (colonnes, clé primaire, cascade, table vide) ;
   5. `up -d --build mba-api mba-worker` ;
   6. rechargement de NPM, puis contrôle public.
4. La console part au `push` et n'appelle aucune route neuve : elle perd le panneau avant que l'API ne perde ses
   routes, sans fenêtre de 404.
5. L'essai réel ci-dessous.
6. Ménage du conteneur : `/app/mesure-mba.mts` et `/app/sonde-liste.cjs`.

## Méthode de livraison

**Un implémenteur, puis une relecture du diff.** Ce lot touche la réception de chaque message et l'envoi de chaque
modèle, et ses invariants ne se voient pas dans le code écrit : l'ordre des écritures chez Meta et en base, la
réécriture du champ à l'arrivée. Déploiement s'il n'y a pas de rouge. Les jaunes se poussent après.

## Essai réel qui clôt le chantier

Sur le numéro de Julien, agent allumé en mode liste :

1. Club Med lancé depuis l'Inbox, bouton « En savoir plus » : l'agent se tait, le scénario avance et assigne.
2. Club Med relancé, du texte libre à la place du bouton : l'agent répond en quelques secondes, et le contact est
   sur la liste (GET).
3. Club Med relancé encore : le contact est retiré de la liste avant le modèle (GET), et au bouton l'agent se tait.
4. Un message spontané, sans scénario : l'agent répond.
5. Une campagne de modèle seul, devenir « l'agent de Meta » : l'agent répond à la réponse. On note s'il connaît le
   contenu du modèle.
6. « Rendre la main » dans l'Inbox, puis le client écrit : l'agent répond.

## Hors périmètre

- Plusieurs numéros par espace : la table garde le numéro, mais la liste suit le numéro de l'espace.
- Une réconciliation périodique entre la table et la liste de Meta.
- La sortie de liste par inactivité (décision de Julien).
- Un contact sur la liste qui envoie STOP : l'agent lui répond comme en mode « tout le monde » aujourd'hui.
- Ce que l'agent sait du modèle envoyé avant la réponse : observé à l'essai 5, pas traité.

## Coordination

Le lot des indicateurs de performance (migration 0194, pas encore poussé) touche le même bloc `CAUSES` de
`fil.ts` : il retire `versLEquipe`, ce lot retire `boutonDuScenario`. Le second à pousser fusionne.
