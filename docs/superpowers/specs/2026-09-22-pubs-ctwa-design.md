# Les publicités Click-to-WhatsApp : créer la pub depuis Engage Me, et relier chaque lead à un scénario

**Date** : 2026-09-22. **Statut** : design validé par Julien le 2026-09-22 (grill en quatre rondes, puis
quatre sections validées une à une), spec à relire.

## Le problème

Julien veut pousser des publicités Click-to-WhatsApp (CTWA) depuis Engage Me, et relier chaque pub à un
scénario. Le premier client, c'est MessagingMe : son compte pub existe, et ses pubs CTWA vont partir.

**Ce qui existe déjà, et qu'il ne faut pas refaire** (commit `bee7137`, 2026-08-26) :

- Le `referral` que Meta joint au premier message après un clic est capté (`src/webhooks/inbound.ts`,
  `referralOf`) et posé sur la fiche en deux champs, `pub_id` et `pub_titre` (`src/crm/fields.ts`).
- Le déclencheur d'automation `ctwa_ad` (« le contact arrive d'une publicité WhatsApp »,
  `src/automation/match.ts`) route vers un scénario. L'écran demande de COLLER l'identifiant de la pub, et
  une config vide veut dire « toutes les pubs ».

**Ce qui manque, ou ne tient pas :**

1. Rien ne crée une pub : tout se fait dans le Gestionnaire de publicités de Meta.
2. `ctwa_clid`, le seul moyen de renvoyer une conversion à Meta, n'est gardé nulle part, et le corps brut
   des webhooks est purgé à 30 jours.
3. **Aucune automation n'est évaluée sur un message `standby`** (`src/webhooks/triggers.ts`) : sur un numéro
   où l'agent de Meta répond à tout le monde, un lead de pub ne démarre jamais le scénario, sans erreur
   visible. C'est le cas du numéro du pilote.
4. Le plafond global de 200 déclenchements par heure ignore en silence les leads suivants : des clics payés.
5. Le coût des messages compte nos envois (`src/stats/cout-messages.ts`) et ignore la gratuité des 72 h
   qui suivent un clic : il afficherait comme payants des messages que Meta ne facture pas.
6. Cette chaîne n'a jamais vu une vraie pub (au 2026-08-26, aucun `referral` sur 275 webhooks).

## Le principe

La pub est créée sur le compte publicitaire DU CLIENT, depuis un formulaire minimal d'Engage Me. Chaque pub
choisit qui répond à ses leads : l'agent de Meta, ou un scénario. Si c'est un scénario, Engage Me reprend
la conversation à l'agent de Meta à l'arrivée du lead. Chaque pub montre un entonnoir qui part du budget
consommé, pas du coût des messages.

## Les arbitrages

| Question | Décision de Julien |
|---|---|
| Premier client | **MessagingMe**, sur son propre compte pub. Sa première campagne créée depuis Engage Me est l'essai réel. |
| Périmètre | **Création guidée** : un formulaire court crée la pub. Relier une pub créée ailleurs en fait partie (import au lot 4). Pas de second Gestionnaire. |
| Argent | Toujours le **compte pub du client**, facturé par Meta. Engage Me ne porte jamais un euro de dépense pub. |
| Preuve préalable | Pas de pub test séparée, ni de pub lancée à la main après le lot 1 : la première campagne du pilote sert de test. |
| Qui prend le lead | Choisi **pub par pub : l'agent de Meta ou un scénario**. Un agent IA passe par un scénario (bloc `agent`). |
| Bloquer l'agent de Meta si c'est un scénario | **Reprendre la conversation à l'arrivée** (`take`). Plan B décidé d'avance : l'**aiguillage par liste autorisée**, annoncé au client. |
| Seuil du plan B | **Une seule** double réponse pendant le pilote, ou un `referral` absent d'un message `standby`. |
| `ctwa_clid` | Une ligne par arrivée publicitaire, **dès le lot 1**. |
| Garde-fou budget | **Budget total et date de fin obligatoires.** Écran de confirmation avec la dépense maximale. |
| Après création | **Créer, suivre (statut, motif de refus), mettre en pause, relancer.** Toute autre modification se fait dans le Gestionnaire. |
| Formulaire | **Minimal** : une image, texte, titre, message pré-rempli, budget total, dates, zone, âge. |
| Lead qualifié | Un **tag choisi par pub**, **daté par l'événement `tag_added`**, attribué sur **28 jours**. |
| Niveau du lien | **Par campagne.** Une pub créée ici est sa propre campagne. Les copies faites dans le Gestionnaire sont reliées **dès le lot 3**. |
| Plafond horaire | **Aucun** pour les pubs. L'anti-rebond par contact reste. |
| Contact désabonné | **Silence, mais visible** : rien ne part, l'arrivée est signalée et comptée à part. |
| Catégories spéciales | **Hors catégorie seulement**, par une case obligatoire. Sinon, le Gestionnaire. |
| Comptes | **Un compte pub et une Page par espace.** |
| Connexion | **Un bouton « Connecter mes publicités »**, séparé de l'inscription WhatsApp. |
| Renvoi des conversions | **Après une mesure au pilote.** |
| Chiffres d'une pub | **Entonnoir complet** : dépense, clics, leads, qualifiés, coût et taux de passage de chaque étape. |
| Messages des 72 h gratuites | **Exclus du coût des messages**, d'après l'accusé de Meta. |
| Déconnexion avec des pubs actives | **Autorisée, avec avertissement.** |
| Architecture | **La pub possède une automation**, sur le modèle des liens Channels Me. |
| Lots | Capter, Connecter, puis **Router, créer et suivre en un seul lot**, puis l'essai réel. |
| Livraison | **Lot par lot, avec revue humaine du diff.** |

## Ce que dit Meta, et ce qui reste à mesurer

Recherche du 2026-09-22 sur la documentation vivante. [DOC] = écrit par Meta, [TIERS] = source tierce.

- **Création** [DOC] : objectifs `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_SALES`, `OUTCOME_TRAFFIC`.
  L'ensemble de pubs porte `destination_type=WHATSAPP` et `billing_event=IMPRESSIONS`. `OUTCOME_LEADS`
  n'accepte que l'optimisation `CONVERSATIONS` ; `OUTCOME_ENGAGEMENT` accepte `CONVERSATIONS` ou
  `LINK_CLICKS`. `promoted_object.page_id` est requis, le numéro WhatsApp est facultatif. La créa porte
  `object_story_spec.page_id`, un lien `https://api.whatsapp.com/send`, un appel à l'action
  `WHATSAPP_MESSAGE`, et le message pré-rempli dans `link_data.page_welcome_message`
  (`customer_action_type: "autofill_message"`).
  Source : developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp
- **Page Facebook obligatoire** [DOC]. La liaison d'un numéro de l'API Cloud à une Page se fait à la main
  (Page, Paramètres, Comptes liés, WhatsApp) : Meta envoie un code en WhatsApp **sur le numéro lui-même**,
  donc ici dans l'Inbox d'Engage Me. Seule l'inscription WhatsApp en v4 la fait automatiquement.
- **Permissions** [DOC] : pour les comptes des clients, Advanced Access sur `ads_read`, `ads_management`,
  `pages_manage_ads`, `pages_read_engagement` et `pages_show_list`, plus `business_management` pour les
  jetons d'utilisateur système. La vérification d'entreprise est exigée. Niveau d'accès de l'API Marketing :
  « Limited » par défaut, « Full » après revue, avec 500 appels réussis en 15 jours et moins de 15 % d'erreurs.
  Le pilote tourne en « Limited », sur un compte pub pour lequel Julien a un rôle sur l'app.
- **UE** [DOC + TIERS] : pour un annonceur européen, « optimisations, reporting, metrics » peuvent manquer.
  Une agence britannique rapporte que ni `CONVERSATIONS` ni les leads ne passent pour l'Europe. Aucune liste
  officielle n'existe.
- **Fenêtre gratuite** [DOC] : un message venu d'une pub CTWA (depuis un téléphone), auquel on répond sous
  24 h, ouvre 72 h où tout est gratuit, modèles compris. L'accusé porte `pricing.type="free_entry_point"`.
  **Les messages de l'agent de Meta restent facturés au jeton dans cette fenêtre.**
- **Conversions** [DOC] : `POST /{dataset}/events`, `action_source=business_messaging`, `ctwa_clid`, dans les
  7 jours, 14 événements dont `QualifiedLead`. Meta ne dédoublonne pas. Rien n'est écrit sur l'UE.
- **Cycle de vie** [DOC] : revue en général sous 24 h, statuts `effective_status` (`PENDING_REVIEW`,
  `ACTIVE`, `DISAPPROVED`, `WITH_ISSUES`…), dépense rafraîchie toutes les 15 min et figée après 28 jours.
  Les webhooks de compte pub ne signalent pas tous les passages [TIERS] : on lit donc régulièrement.
- **Le « réglage d'attribution à activer »** que `todo.md` et le journal demandent de vérifier ne vient
  que d'un fournisseur d'API non officielle [TIERS]. La doc Cloud API ne le connaît pas.

**Ce que seule une mesure tranche** (section « Essai réel ») : `CONVERSATIONS` pour un annonceur français, la
présence du `referral` dans un message `standby`, la vitesse de l'agent de Meta face à notre reprise, une
conversion acceptée pour un numéro français, et le type de jeton exigé par la créa.

## 1. Les lots

| Lot | Contenu | Ce qu'il permet |
|---|---|---|
| **1. Capter** | Table des arrivées publicitaires, écrite à la réception. Tarif de Meta gardé pour chaque message sortant, et messages `free_entry_point` exclus du coût des messages. Aucun écran. | Tout ce qui se perd si on ne le capte pas à l'arrivée. |
| **2. Connecter** | Bouton « Connecter mes publicités », jeton chiffré, choix du compte pub et de la Page, vérification de la liaison Page et numéro. | Les appels à l'API Marketing. |
| **3. Router, créer, suivre** | Table des pubs, automation possédée, règle de routage, reprise à l'arrivée, copies reliées à leur campagne, formulaire, création, confirmation, suivi régulier, pause, entonnoir, qualification. | L'essai réel. |
| **Essai réel** | Première campagne MessagingMe créée depuis Engage Me. | Clôt la feature, fournit la vidéo de la revue Meta. |
| **4. Ouvrir aux clients** | Revue Meta des permissions pub, niveau « Full », import des campagnes créées ailleurs. | Les comptes des clients. |
| **5. Conditionnels** | Renvoi des conversions si la mesure est bonne. Aiguillage par liste autorisée si le seuil du plan B est atteint. | |

Le lot 3 se livre en **commits séparés** (routage, puis création, puis suivi), pour que la revue du diff
reste lisible. L'écran de création ne doit jamais exister sans le routage derrière : une pub créée dont les
leads n'iraient nulle part serait le « proposé mais inerte » que le produit s'interdit.

## 2. Ce qu'on stocke

Toutes les migrations **ajoutent** : elles passent avant le déploiement, et elles sont relues en base
juste après `migrate`. Les numéros se prennent au moment d'écrire, depuis la ligne « Dernière appliquée » du
`CLAUDE.md` du dépôt, et la base tranche.

### `arrivees_pub` (lot 1, complétée au lot 3)

Une ligne par message entrant qui porte un `referral`.

- Lot 1 : espace, contact (clé étrangère en cascade pour une suppression réelle de la fiche ; ⚠️ la purge
  RGPD, elle, ANONYMISE la fiche sans la supprimer, donc c'est `purgeMany` qui efface `ctwa_clid` et garde la
  ligne pour le compte, relevé en écrivant le plan du lot 1), identifiant Meta du message
  (**unique par espace** : les webhooks arrivent en double), identifiant de la pub (`source_id`),
  `source_type`, titre, lien, `ctwa_clid` (nullable, jamais une condition), **arrivé en `standby` ou
  non**, date de réception.
- Lot 3 : la campagne (nullable : pub inconnue), **l'issue du routage** (`inchange`, `agent_meta`,
  `reprise_reussie`, `reprise_refusee`, `desabonne`, `bloque`, `scenario`), l'heure de la reprise, et
  `qualifie_le`.
- Les champs `pub_id` et `pub_titre` de la fiche restent : ils servent aux filtres et aux variables.

### `tarifs_meta` (lot 1)

Une ligne par message sortant, clé : l'identifiant WhatsApp du message, avec l'espace. Type de tarif,
catégorie et « facturable », tels que l'accusé de réception les écrit. Le premier accusé qui porte un
`pricing` gagne (écriture idempotente). Une table à part plutôt qu'une colonne, parce que nos envois vivent
dans **deux** tables (`conversation_messages` et `campaign_recipients`) et que le coût lit les deux. Pas de
purge propre : un mois passé doit garder le même coût, quel que soit le jour où on le regarde.

### `pub_connexion` (lot 2)

Une ligne par espace : jeton chiffré (`encryptSecret`, le même chiffrement que l'inscription WhatsApp),
compte pub, Page, **devise et fuseau du compte pub**, état de la liaison Page et numéro, qui a connecté et
quand, date où Meta a rejeté le jeton.

### `publicites` (lot 3)

Une ligne par campagne connue d'Engage Me, **unique par (espace, campagne)**.

- Identifiants Meta (campagne, ensemble, créa, pub), origine (`engage_me` ; `importee` au lot 4), nom.
- Statut Meta et motif de refus, budget total, début, fin, **tels que Meta les renvoie au suivi**.
- **Destination** (`scenario` ou `agent_meta`), scénario visé (`on delete set null`), tag de qualification,
  automation possédée (`on delete set null`).
- CHECK sur un seul sens : un scénario n'existe que pour la destination `scenario`. L'inverse (destination
  `scenario` sans scénario) est un état ATTEIGNABLE après une suppression, et le refuser ferait échouer
  cette suppression sur une contrainte (leçon de 0144).
- Dernière dépense, derniers clics, heure de la dernière lecture chez Meta. Qui l'a créée et quand.

### `pubs_connues` (lot 3)

La correspondance « identifiant de pub » vers campagne, par espace. Remplie à la création (notre pub) et
à la résolution d'une copie inconnue (un appel à Meta). C'est ce qui rend le lien « par campagne » vrai
pour les copies. Le routage ne lit que nos tables, jamais Meta, sauf pour une copie encore inconnue.

### Automations

`automations.possede_par` prend la valeur `publicite`, et le déclencheur `ctwa_ad` accepte `campaignId`
dans sa config. Ni l'une ni l'autre ne demande de migration (pas de CHECK sur `possede_par`, config en
jsonb). L'automation d'une pub : `ctwa_ad`, `{campaignId}`, **plafond horaire 0** (sans plafond), anti-rebond
par défaut (une heure par contact), éteinte à la création et allumée à la publication, masquée de l'écran
Automations comme celles des liens de chaîne.

## 3. Les flux

### 3.1 Connexion (lot 2)

- Julien crée chez Meta une seconde configuration Facebook Login for Business, avec les permissions pub et
  un jeton d'utilisateur système. Son identifiant va dans `META_ADS_CONFIG_ID`. **Vide = bouton inactif**,
  avec une phrase qui le dit, comme pour l'inscription WhatsApp.
- Fenêtre Meta, `code`, échange côté serveur (même appel que l'inscription WhatsApp), puis `debug_token`
  pour lire les comptes pub et les Pages accordés. L'admin choisit un compte pub et une Page.
- Lecture de la devise et du fuseau du compte pub.
- Vérification que la Page est liée au numéro WhatsApp de l'espace. Sinon, connexion « incomplète » :
  l'écran explique la liaison (le code arrivera dans l'Inbox), et le bouton Créer reste désactivé.
- Si la créa exige un jeton de Page, il se dérive du jeton stocké au moment de la création, sans être
  stocké. Vérifié au premier appel du lot 2.
- Déconnexion : autorisée. Si une pub est active, l'avertissement dit qu'elle continue de dépenser chez
  Meta et qu'Engage Me ne pourra plus la mettre en pause. Le routage de ses leads continue.

### 3.2 Création (lot 3)

- Formulaire : image, texte principal, titre, message pré-rempli, budget total, début, fin, zone (pays, ou
  ville et rayon), âge minimum et maximum, destination, scénario (si destination scénario), tag de
  qualification (facultatif), case obligatoire « cette pub ne relève d'aucune catégorie spéciale ».
- Choix « agent de Meta » : proposé seulement si l'agent est actif et répond à tout le monde, avec la mention
  « facturé au jeton, même pendant les 72 h gratuites ». Sur un numéro en liste autorisée, il n'est pas
  proposé au lot 3, et l'écran explique pourquoi.
- Choix « scénario » sur un numéro où l'agent de Meta répond à tout le monde : l'écran dit que l'agent sera
  écarté des leads de cette pub.
- Chez Meta, **tout est créé en pause** : image, campagne (`OUTCOME_ENGAGEMENT`, `special_ad_categories`
  vide), ensemble de pubs (destination WhatsApp, budget total dans la devise du compte, dates dans son
  fuseau, ciblage, Page et numéro, optimisation fixée par la mesure du pilote), créa avec le message
  pré-rempli, pub. Chaque identifiant est enregistré dès que Meta le renvoie. Si une étape échoue, on
  supprime la campagne créée (Meta supprime ce qu'elle contient) et on affiche la raison de Meta. Si la
  suppression échoue aussi, la ligne reste visible comme « création échouée » : une campagne en pause ne
  dépense rien.
- Confirmation : « Cette pub peut dépenser jusqu'à X entre le D1 et le D2. » **Publier** allume d'abord
  l'automation possédée, puis active chez Meta : un échec ne laisse jamais une pub active sans routage.

### 3.3 Réception d'un lead (lots 1 et 3)

- Lot 1 : la ligne d'arrivée s'écrit dans le même passage que les champs `pub_id` et `pub_titre`, isolée
  comme lui (un échec n'arrête pas le job webhook).
- Lot 3 : la campagne se retrouve par `pubs_connues`. Pour une pub inconnue d'un espace connecté, un appel à
  Meta (3 s maximum) retrouve sa campagne et la mémorise. Échec ou délai : campagne inconnue, et la raison va
  au journal.
- La règle de routage, **écrite comme une fonction pure**, s'applique avant les déclencheurs :

| Campagne | Contact | Message | Ce qui se passe | Issue |
|---|---|---|---|---|
| Inconnue | | | Comme aujourd'hui (« toutes les pubs », mots-clés, nouveau contact). | `inchange` |
| Destination agent de Meta | | | Aucune automation pour ce message, ni « toutes les pubs », ni « nouveau contact ». | `agent_meta` |
| Destination scénario | Bloqué | | Rien. | `bloque` |
| Destination scénario | Désabonné | | Pas de reprise, rien ne part, l'Inbox le signale. Si l'agent de Meta est actif, il répond comme aujourd'hui. | `desabonne` |
| Destination scénario | | `standby` | Reprise de la conversation (un seul nouvel essai, comme les campagnes). Refus : l'agent de Meta garde le lead. Succès : contrôle local à `app_workflow`, puis **seule** l'automation de la pub est évaluée. | `reprise_refusee` ou `reprise_reussie` |
| Destination scénario | | normal | **Seule** l'automation de la pub est évaluée. | `scenario` |

- **La doctrine « un message `standby` ne déclenche rien » reste vraie pour tout le reste.** L'exception
  est la seule ligne `standby` du tableau, et le commentaire de `triggers.ts` le dira.
- L'automation d'une pub reprend la main comme celle d'un lien de chaîne (`reprendLaMain`) : même chemin,
  pas un second.
- À la fin du scénario, la conversation revient à l'agent de Meta par le mécanisme existant (relâche après
  l'accusé de notre dernier envoi).

### 3.4 Qualification (lot 3)

Sur `tag_added` (job `automation-event`), on cherche l'arrivée **la plus récente** de ce contact, dans les
**28 derniers jours**, dont la pub a ce tag de qualification et qui n'est pas encore qualifiée, et on y
écrit `qualifie_le`. Idempotent. `tag_added` ne part que pour un tag nouveau : un contact qui portait déjà
le tag en arrivant n'est pas compté.

⚠️ L'action en masse, l'import et l'outil MCP n'émettent pas `tag_added` : **ils ne qualifient personne**.
C'est connu et écrit à l'écran de la pub (« qualifié par un scénario, l'Inbox ou un agent IA »).

### 3.5 Suivi (lot 3)

- Un balayage toutes les 15 min (`taches.programmer`), par espace connecté ayant des pubs non terminées :
  un appel pour les statuts et motifs de refus, un appel pour la dépense et les clics. Environ huit appels
  par heure et par compte, loin du plafond du niveau « Limited ».
- Les clics sont les clics sur le lien vers WhatsApp. Le champ Insights est vérifié le premier jour du
  pilote contre le chiffre du Gestionnaire.
- Jeton rejeté par Meta : connexion invalide, bandeau, alerte à l'exploitation. Le routage continue.
- Pause et reprise : sur la campagne, chez Meta. L'automation reste allumée (leads tardifs).
- **Entonnoir** : dépense, clics, leads (contacts distincts arrivés par la campagne), qualifiés (contacts
  distincts dont une arrivée par la campagne porte `qualifie_le`). Pour chaque étape, le coût (dépense
  divisée par le nombre) et le taux de passage vers la suivante, dont la part des clics qui n'écrivent
  jamais. Division par zéro : « non disponible ». À part : les leads non pris en charge (reprise refusée,
  désabonnés, bloqués).

### 3.7 Écrans (lots 2 et 3)

- Une entrée « Publicités » dans le menu (`web/lib/nav.ts`). En haut, la carte de connexion (état, compte
  pub, Page, liaison au numéro, déconnexion). Dessous, la liste des pubs : nom, statut, destination, dates,
  dépense sur budget, leads, qualifiés, coût par lead qualifié. Un bouton Créer, désactivé tant que la
  connexion n'est pas complète, avec la raison.
- La page d'une pub : statut et motif de Meta, entonnoir, leads non pris en charge, pause et reprise, lien
  direct vers le Gestionnaire.
- Textes en français et en anglais, comme le reste de la console.

### 3.6 Coût des messages (lot 1)

- Les accusés de réception (`processStatuses`, file `webhook-status`) lisent leur objet `pricing`, avec un
  `safeParse`, et l'écrivent dans `tarifs_meta`. Isolé : un échec n'annule pas le traitement de l'accusé.
- TOUTE lecture de coût (les deux branches de `envoisTemplateFacturables` et les deux de `envoisDeLaCampagne`
  pour les modèles, `serviceParMois` et `servicesParCampagne` pour le service, `bilanContact` pour le bilan
  d'un contact) exclut les messages marqués `free_entry_point`, par un fragment SQL unique
  (`src/stats/entree-gratuite.ts`). Les appelants de `coutMessages` (l'écran du coût des messages et le coût
  par campagne) en profitent sans changement. ⚠️ Les courbes de VOLUME ne reçoivent PAS l'exclusion : un
  message gratuit reste un message envoyé. (La spec disait « deux requêtes ». `servicesParCampagne` a été
  relevée en écrivant le plan, `envoisDeLaCampagne` à l'exécution, et `bilanContact` par la relecture
  indépendante du lot : trois oublis successifs, d'où la règle écrite dans le fragment, qui ne liste plus ses
  utilisateurs.)

## 4. Cas limites et sécurité

| Cas | Comportement |
|---|---|
| Meta refuse la pub | Statut et motif affichés, lien direct vers le Gestionnaire. |
| `CONVERSATIONS` refusée pour la France | Mesurée une fois au pilote, puis figée dans une constante. Pas de repli silencieux : une création refusée affiche le message de Meta. |
| Page non liée au numéro | Connexion « incomplète », création désactivée avec l'explication. |
| Double clic, ou deuxième arrivée dans l'heure | Deux arrivées notées, un seul démarrage (anti-rebond). |
| Contact déjà dans un scénario | Règle existante : le déclencheur gagne. |
| Scénario supprimé alors qu'une pub active l'utilise | Refus lisible (409) dans la route de suppression ; la clé étrangère reste en `set null`. |
| Budget ou dates modifiés dans le Gestionnaire | L'écran affiche ce que Meta renvoie au suivi. |
| Agent de Meta éteint après coup sur une pub « agent de Meta » | Avertissement sur la pub : ses leads n'arrivent plus qu'à l'Inbox. |
| Fenêtre gratuite non ouverte (clic depuis un ordinateur, réponse après 24 h) | Meta marque le message payant, et on lit son accusé. |
| `referral` d'une publication et non d'une pub, `ctwa_clid` vide | Arrivée notée, jamais une condition. |

**Sécurité** : jeton chiffré au repos, secret de l'app côté serveur seulement (`META_ADS_CONFIG_ID` n'est
pas un secret), `tenant_id = $1` sur chaque requête, routes montées par le registre des modules (donc
couvertes par `scope-tenant`), lecture pour tous les membres, écritures réservées aux admins. Toute réponse
de Meta passe par un `safeParse` Zod, jamais un `as`. La création porte le plafond des routes coûteuses
(`limiteCouteuse`). L'image est vérifiée (type, taille) côté serveur avant d'être envoyée à Meta.

## 5. Tests

- **Unitaires** : le texte exact envoyé à Meta pour la campagne, l'ensemble de pubs, la créa et le message
  pré-rempli, comparé aux exemples de la doc ; la règle de routage, table par table ; l'attribution
  (28 jours, arrivée la plus récente, une seule fois) ; la suppression de la campagne quand une étape de la
  création échoue ; l'entonnoir et ses divisions par zéro ; la lecture de `pricing` (types inconnus gardés
  tels quels).
- **Intégration (CI)** : arrivées écrites une fois malgré un webhook en double ; `tarifs_meta` idempotente ;
  coût des messages sans les 72 h gratuites, **vérifié dans les deux sens** (le test échoue sans
  l'exclusion) ; automation possédée sans plafond ; reprise simulée ; « toutes les pubs » qui ne part plus
  pour une campagne reliée.
- **Front (Playwright)** : états de la connexion, choix de destination selon l'état de l'agent de Meta,
  dépense maximale affichée à la confirmation, entonnoir.
- `npm run auto-attaque` sur les nouvelles routes.

## 6. Essai réel qui clôt la feature

Première campagne MessagingMe créée depuis Engage Me, destination scénario, sur le numéro où l'agent de
Meta répond à tout le monde. Il faut **voir** :

1. La pub passe la revue de Meta et diffuse.
2. Un vrai clic depuis un téléphone produit une arrivée avec son `ctwa_clid`.
3. L'agent de Meta ne répond pas, le scénario si. Délai mesuré entre l'arrivée et la reprise.
4. Le tag de qualification fait avancer l'entonnoir. La dépense affichée égale celle du Gestionnaire.
5. La pause depuis Engage Me arrête la diffusion.
6. Les messages envoyés pendant les 72 h gratuites sortent du coût des messages.

Et **mesurer**, avec la décision attachée à chaque résultat :

| Mesure | Comment | Résultat, et ce qu'on en fait |
|---|---|---|
| `CONVERSATIONS` pour un annonceur français | Un ensemble de pubs créé en pause par l'API, réponse de Meta lue | Accepté : la constante vaut `CONVERSATIONS`. Refusé : `LINK_CLICKS`. |
| `referral` dans un message `standby` | Colonne « arrivé en `standby` » des premiers leads | Présent : le plan A tient. Absent : plan B. |
| Double réponse | Conversation par conversation sur les leads du pilote | Aucune : le plan A tient. **Une seule** : plan B. |
| Clics | Champ Insights comparé au Gestionnaire, premier jour | Égal : on garde. Différent : on change de champ. |
| Conversion acceptée pour un numéro français | Un `QualifiedLead` envoyé à la main | Acceptée et visible : lot « conversions ». Sinon : on s'arrête là. |

## 7. Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Les quatre questions du `CLAUDE.md` global y mènent :
la production emprunte ces chemins (webhook entrant, argent du client, chiffres affichés) ; créer une pub
dépense, donc n'est pas réversible ; une partie des critères demande un œil (revue de Meta, vrai clic) ; et
le code touché porte des règles invisibles (ordre et consommation du job webhook, garde de consentement,
doctrine du `standby` qu'on modifie, index partiels).

## 8. Déploiement

- Migrations avant le `up -d --build`, relues en base juste après `migrate`.
- **Écran poussé après le déploiement de l'API qui porte ses routes** : Vercel publie la console à chaque
  `git push`. Le lot 1 n'a pas d'écran.
- `gh run list` avant chaque déploiement, verdict lu job par job.

## 9. Rayon de souffle déjà repéré

- `src/webhooks/triggers.ts` : la doctrine du `standby` change pour une seule ligne du tableau.
- Le runner d'automations : la valeur `publicite` de `possede_par`, la reprise de main qu'elle hérite, et le
  filtre qui masque les automations possédées de l'écran.
- Le déclencheur « toutes les pubs » existant ne part plus pour une campagne reliée : c'est un changement
  de comportement pour les automations déjà créées, à dire dans la doc et à tenir par un test.
- `processStatuses` gagne une écriture isolée, et le job webhook une étape isolée après l'upsert du contact.
  Les accusés arrivent par DEUX files (`webhook` et `webhook-status`) : le tarif se câble sur les deux.
- `purgeMany` (transactionnelle) efface `ctwa_clid` : la migration doit précéder le déploiement, sans quoi
  toute suppression de contact échoue.
- Toutes les lectures de coût, et les docblocks qui annoncent leur filtre de service « mot pour mot ».
- La route de suppression d'un scénario gagne un refus 409.
- Le job `automation-event` gagne un consommateur (la qualification).
- Une autre session a livré `67b55166` le 2026-09-22 (l'agent de Meta envoie un bloc, lance un scénario et
  reçoit la réponse à côté), dans `index.ts`, `wiring.ts`, `executor.ts` et `inbox/store.pg.ts` : c'est la
  même zone que la règle de routage (qui tient la conversation, entre l'agent de Meta et un scénario). Le
  plan relit ce commit avant d'écrire la reprise à l'arrivée. Toujours commiter avec `git commit --only`.

## 10. Hors périmètre

Vidéo, questions rapides (ice breakers), ciblage avancé, emplacements, catégories spéciales, plusieurs
comptes pub par espace, modification d'une pub depuis Engage Me, agent de Meta sur un numéro en liste
autorisée (lot 3), renvoi des conversions (conditionnel), aiguillage (conditionnel), émission de
`tag_added` par l'outil MCP, migration de l'inscription WhatsApp en v4 (tâche séparée : v2 et v3 sont
annoncées « disponibles jusqu'en octobre 2026 »).

## 11. Prérequis côté Meta (Julien, hors code)

1. Vérifier la vérification d'entreprise de MessagingMe (Centre de sécurité des paramètres de
   l'entreprise). Exigée pour ouvrir aux clients.
2. ✅ **FAIT le 2026-09-23** : le cas d'usage « Create & manage ads with Marketing API » est sur l'app
   `988129420727963`, ses six permissions en « Ready for testing », `pages_manage_ads` comprise. Le
   « Marketing API Access Tier » y est en **Limited**, ce que le pilote attendait.
3. ✅ **FAIT le 2026-09-23** : configuration Facebook Login for Business « pub Meta » créée, en variation
   General, jeton d'utilisateur système sans expiration, actifs Pages et comptes publicitaires tous deux
   requis, tâche ADVERTISE sans MANAGE. Son identifiant et le détail des réglages vivent dans
   `brain/INFRA.md` (hors dépôt, qui est public) ; il ira dans `META_ADS_CONFIG_ID` au lot 2.
4. Lier la Page Facebook MessagingMe au numéro WhatsApp du pilote. Le code arrivera dans l'Inbox.
5. Un moyen de paiement sur le compte pub MessagingMe.

## 12. Ce que la doc du dépôt doit corriger

- `todo.md` (« En attente d'une vérification en vol ») et `docs/JOURNAL-TECHNIQUE.md` (piège n°3) : le
  « réglage d'attribution à activer » n'est attesté que par un fournisseur d'API non officielle.
- `todo.md`, « renvoyer les conversions » : la capture est désormais prévue au lot 1, le renvoi est
  conditionné à la mesure du pilote.
