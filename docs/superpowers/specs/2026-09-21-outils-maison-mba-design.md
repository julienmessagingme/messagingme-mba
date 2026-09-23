# Les outils maison de l'agent de Meta (design)

**Date** : 2026-09-21. **Statut** : design validé par Julien le 2026-09-21 (approche 1 et les deux points
soulevés), spec à relire.
**S'appuie sur** : le relais, `docs/superpowers/specs/2026-09-21-relais-mba-design.md`, en production et
éprouvé le même jour.

## La demande

> « Je veux donc pouvoir poser un tag sur le contact, dans le mini-CRM ; enregistrer une information sur sa
> fiche ; envoyer un bloc precis d'un scenario ou carrement un scenario (et on rend au mba à la fin du scenario
> ou des que le client n'appuie pas sur les boutons et repond "à coté"). »

**Arbitrages de Julien, 2026-09-21** :
1. « Envoyer un bloc » et « Lancer un scénario » sont **deux outils distincts**.
2. Quand le client répond « à côté », son message est **transmis à l'agent de Meta** pour qu'il y réponde.
3. Le tag est **fixé d'avance** : un outil pose une étiquette précise, l'agent ne décide que du moment.
4. Le tag **déclenche les automations « tag ajouté »**, comme partout ailleurs.
5. Approche 1 (le relais exécute lui-même), avec les deux points proposés : « Envoyer un bloc » n'accepte que
   des blocs qui n'attendent pas de réponse, et la transmission du message « à côté » vaut pour **tout**
   scénario qui rend la main sur une réponse libre, avec la réparation du fil bloqué.
6. **L'onglet « Outils » est refait** d'après son croquis : une liste claire et un gros bouton « Ajouter »
   (§ 9). Maquette validée, sans bandeau d'envoi.

**Hors périmètre** : le sous-scénario qui rend un résultat à l'agent (un bloc de sortie), évoqué par Julien et
reporté ; aucun changement aux outils des agents IA, sauf deux défauts consignés au § 12.

## 1. Ce que l'utilisateur obtient

Dans **Meta Business Agent > Paramètres > Outils**, « Ajouter un outil » propose, à côté de l'appel d'un
connecteur API (existant), quatre outils prêts à l'emploi :

| Outil | Ce que l'administrateur fixe | Ce que l'agent de Meta fournit | Ce qui se passe |
|---|---|---|---|
| **Poser un tag** | l'étiquette | rien | l'étiquette est posée sur la fiche du mini-CRM |
| **Enregistrer une information** | le champ de la fiche, et au besoin la liste des valeurs permises | la valeur, tirée de la conversation | la valeur est écrite dans le champ |
| **Envoyer un bloc** | un bloc d'un scénario | rien | le bloc part chez le client, puis l'agent de Meta reprend la main |
| **Lancer un scénario** | un scénario | rien | le scénario démarre depuis son début ; l'agent de Meta reprend la main à la fin, ou dès que le client répond à côté |

Chacun porte, comme un outil de connecteur, « Quand l'appeler » et « Quand NE PAS l'appeler », pré-remplis
avec une consigne **directive** (leçon mesurée le 2026-09-21 : une description vague perd face aux compétences
de l'agent, cf. `docs/MBA-API-REFERENCE.md`). Enregistrer un outil l'envoie chez Meta dans le même geste (§ 9).

## 2. L'approche : le relais exécute lui-même

Meta appelle déjà `POST /mba/relais/outils/:id` avec la clé « Agent de Meta » et le numéro du client dans
l'en-tête `X-Contact-WhatsApp`. Pour un outil maison, la route **n'appelle aucun système tiers** : elle exécute
le geste avec les fonctions qui le font déjà ailleurs dans le dépôt.

Écartées :
- **Déclarer Engage Me comme un connecteur de lui-même** et passer par l'API publique : elle n'a ni tag ni
  lancement de scénario à la demande, et on s'appellerait par Internet, gardes et plafonds compris.
- **Faire de l'agent de Meta une fausse ligne `agents`** pour réutiliser les écrans des agents IA : il
  apparaîtrait dans des listes où il n'a rien à faire, et son fil ne se gère pas comme celui d'un agent IA
  (l'agent IA tient un parcours, l'agent de Meta tient le fil chez Meta).

## 3. Les quatre outils en détail

Les quatre gestes sont des **handlers d'un catalogue propre à l'agent de Meta** (`tag_fixe`, `champ_fixe`,
`bloc_fixe`, `scenario_fixe`), distincts de ceux des agents IA : un outil de l'agent de Meta qui atteindrait par
erreur un agent IA tomberait sur un handler inconnu et serait refusé, au lieu d'être joué avec une autre forme
de paramètres. Le catalogue et la route ont un test de miroir, comme `OUTILS_MAISON` et `HANDLERS`.

### 3.1 Poser un tag (`tag_fixe`)
- Fixé : `binding.tag`, normalisé comme ailleurs (trim, 64 caractères).
- Exécution : le point de passage des agents IA, `creerPoserTagAgent` (`src/agent/poser-tag`) : pose sur la
  fiche, déclaration dans Contenus > Tags, événement `tag_added` **seulement si l'étiquette est nouvelle**.
- ⚠️ **Une automation « tag ajouté » qui lance un scénario ne démarrera PAS tant que l'agent de Meta tient le
  fil.** C'est la règle existante, pas une décision de ce lot : un démarrage automatique n'écrit jamais dans un
  fil tenu (`runFrom`, garde `mayAct`), et seules les automations nées d'un bouton de chaîne reprennent la main
  (`reprendLaMain`). Pour qu'un scénario parte depuis l'agent de Meta, c'est l'outil « Lancer un scénario ».
  L'écran le dit sous le choix de l'étiquette.

### 3.2 Enregistrer une information (`champ_fixe`)
- Fixé : `binding.champ`, choisi parmi les champs du mini-CRM de l'espace ; en option, la liste des valeurs
  permises.
- Fourni par l'agent : `valeur`, seule variable du corps publié chez Meta (avec sa liste de valeurs écrite dans
  la description quand il y en a une, comme pour les connecteurs).
- Exécution : `mergeFieldsByPhone`, comme le handler `ecrire_variable` des agents IA. Une valeur hors de la
  liste permise est refusée avec la liste dans le message d'erreur.

### 3.3 Envoyer un bloc (`bloc_fixe`)
- Fixé : `binding.workflowId` et `binding.code` (le `nod_…` du bloc, qui survit aux réorganisations du graphe).
- **Le bloc part SEUL**, sans ce qui le suit dans le scénario : c'est ce que « un bloc précis » veut dire.
- **N'est accepté qu'un bloc qui ne demande pas de réponse** : joué seul, il doit finir `done`, jamais
  `waiting` (question, boutons, formulaire), `agent_turn`, `inbox`, `sleeping` ni `rcs_send`. Un bloc qui
  attend une réponse relève de « Lancer un scénario » : sans parcours pour la porter, la réponse du client
  n'irait nulle part. Vérifié **deux fois** : au choix dans l'écran (les autres blocs y sont grisés avec la
  raison) et **à chaque appel**, parce que le scénario peut avoir été modifié ou le bloc supprimé depuis.
- Le graphe lu est celui **publié**.
- Exécution : prendre le fil, envoyer, rendre le fil (§ 4). Les gardes d'envoi sont celles de l'exécuteur, sans
  exception (désabonnement, fenêtre de 24 h pour un message de session ; un modèle part hors fenêtre). Le relais
  ajoute celle des automations : rien ne part vers un contact **bloqué** (`isBlockedByWaId`).

### 3.4 Lancer un scénario (`scenario_fixe`)
- Fixé : `binding.workflowId`, un scénario publié.
- Refusé pour un contact bloqué, comme pour un bloc.
- Exécution : **exactement le lancement du bouton de l'Inbox** (`startWorkflow` de `src/index.ts`) :
  `startInWindow` si la fenêtre est ouverte, sinon `start` (qui refuse d'ouvrir par un message de session),
  avec `ignoreHumanControl` (reprise du fil) et `emitEvents` (démarrage unitaire). Un seul chemin de lancement,
  pas un cinquième.
- Si Meta refuse de nous rendre le fil, le scénario ne démarre pas (règle existante du 2026-09-14) et l'agent
  de Meta reçoit la raison.
- La suite est celle de tout scénario, sans rien de neuf : fin normale, agent de Meta ; réponse libre, agent de
  Meta (et son message lui est transmis, § 5) ; bouton sans suite, un humain ; bloc Inbox, un humain ; délai
  d'une question sans sortie câblée, agent de Meta ; bloc agent IA, l'agent IA.

## 4. Le fil, pour un bloc et pour un scénario

1. **Prendre le fil** (`reprendreLeFilPourLApp` : `take` chez Meta, puis `app_workflow` chez nous). Envoyer
   prendrait de toute façon le fil implicitement chez Meta, mais notre état resterait `mba` et le retour du fil
   (`releaseToMba`, gardé sur `only: ['app_workflow']`) ne partirait jamais.
2. **Jouer** le bloc ou le scénario.
3. **Rendre le fil** par le mécanisme existant (0149) : le fil repart chez l'agent de Meta à l'accusé de notre
   dernier envoi, jamais dans la foulée (un release émis juste après un envoi est repris par cet envoi).
4. **Répondre à Meta**, dans la même requête : l'appel est synchrone, et l'agent de Meta sait donc si le geste
   a eu lieu.

**Inconnue M1, mesurée à l'essai réel** : quand nous avons pris le fil pendant l'appel de l'outil, la réponse
que l'agent de Meta rédige ensuite part-elle chez le client ? Aucun code n'en dépend : la réponse du relais lui
demande de ne rien ajouter (§ 7), ce qui couvre les deux issues. La mesure dira seulement s'il faut, en plus,
le lui répéter dans la description de l'outil.

## 5. La réponse « à côté », transmise à l'agent de Meta

**Quand** : un scénario rend la main parce que le client a écrit au lieu de choisir (branche « il a écrit » de
`advance`, `src/workflow/executor.ts`), et le fil repart effectivement chez l'agent de Meta. Pour **tout**
scénario, qu'il ait été lancé par l'agent de Meta, une campagne, une automation ou l'Inbox.

**Quoi** : `POST https://api.facebook.com/{phone_number_id}/agent_event`, nouvelle méthode `agentEvent` de
`MbaClient`, avec un délai propre (`AbortSignal.timeout`) :
- `to` : le numéro du client ;
- `event.type` : `reponse_hors_parcours` ;
- `event.description` : une consigne en langage naturel (« Le client vient d'écrire en dehors du parcours
  automatique qu'on lui proposait. Réponds à son message. ») ;
- `event.payload` : la chaîne JSON `{"message": "<ce qu'il a écrit>"}`, tronquée pour tenir sous 4 096
  caractères **après** échappement. Pour un média sans légende, le libellé du message (`[audio]`, `[image]`).

**Après le release, jamais avant** : tant que nous tenons le fil, l'agent de Meta n'a pas la parole.

**Pas d'événement** : sur une conversation de TEST (le fil n'y est pas rendu, règle du 2026-09-16), quand
l'agent de Meta n'est pas allumé, et quand le release échoue. Un événement qui échoue est journalisé et
n'arrête rien : l'agent de Meta répondra au message suivant du client, comme aujourd'hui.

**Inconnue M2, mesurée AVANT de coder cette partie** (§ 11) : un `agent_event` fait-il répondre l'agent dans une
conversation en cours, et sous quel format de `to` ? La documentation ne le dit pas. Si la mesure est négative,
cette partie tombe et le reste du design ne bouge pas.

### 5.1 La réparation du fil bloqué

`demanderReleaseMba` pose le marqueur « rendre à l'accusé de ce message » sur **notre dernier envoi**, quel qu'il
soit. Deux cas le posent sur un message **déjà acquitté**, dont l'accusé ne reviendra jamais : le marqueur n'est
jamais consommé, le fil reste en `app_human` jusqu'au balayage (`CONTROL_HUMAN_TIMEOUT_MS`), et le message
« à côté » atterrit dans « À traiter » au lieu d'aller à l'agent de Meta.
- **la réponse « à côté »** : notre question est partie depuis longtemps quand le client répond ;
- **le délai d'une question sans sortie câblée** : même situation, le client s'est tu.

Constaté à la lecture du code ; **à confirmer en base avant la correction** (fils en `app_human` dont le
marqueur désigne un message ancien).

La règle devient : **le marqueur ne se pose que si notre dernier envoi est le dernier message du fil ET qu'il
n'a pas encore été acquitté.** Sinon Meta a fini de le traiter, et on rend tout de suite.
- « Le dernier message du fil » : le client qui a écrit depuis prouve que notre envoi est traité (il y a au
  moins le temps de lire et de taper). C'est ce qui rend la transmission du § 5 toujours immédiate.
- « Pas encore acquitté » : nouvelle colonne `conversation_messages.accuse_le`, posée par le **premier**
  statut reçu pour ce message (`sent`, `delivered`, `read` ou `failed`), dans le traitement des statuts qui
  consomme déjà le marqueur.
- ⚠️ Condition du plan : le message entrant est enregistré **avant** que le parcours ne réagisse. Sinon la
  première règle ne voit pas le message du client.
- Fenêtre résiduelle, assumée et écrite dans le code : un client qui écrit dans la seconde même où part notre
  envoi. Le balayage reste le filet.

## 6. Stockage

Les outils maison de l'agent de Meta vivent dans **`agent_tools`**, comme ses outils de connecteur :
- `origin = 'mba'` (outil maison), `agent_id` **null**, `binding = {handler, …cible}`, `params` pour la seule
  variable de `champ_fixe` ;
- nouvelle colonne **`pour_agent_meta boolean not null default false`** : l'outil appartient à l'agent de Meta
  de l'espace ;
- leur exposition passe par la ligne de consentement `mba:<numéro>`, active, comme un outil de connecteur. Le
  relais et la publication les trouvent donc par la lecture qu'ils font déjà (`listActifsConsommateur`).

Pourquoi cette table plutôt qu'une nouvelle :
- **les noms** : Meta range tous nos outils sous un seul connecteur `EngageMe`, donc deux outils ne doivent pas
  porter le même nom. L'index unique `agent_tools_nom_espace_uidx` (0157) le garantit déjà, connecteurs et
  outils maison confondus ; deux tables demanderaient une unicité tenue par le code ;
- **le journal** : `agent_tool_calls.tool_id` référence `agent_tools`. Les appels des outils maison y entrent
  sous l'appelant `mba`, à côté des appels de connecteur, et l'écran des erreurs les montre sans rien ajouter.

**Migration 0162** (numéro à relire en base juste avant de l'écrire) :
- `agent_tools.pour_agent_meta` ;
- le CHECK de 0159 devient `origin <> 'mba' or agent_id is not null or pour_agent_meta` ;
- un CHECK `not pour_agent_meta or (origin = 'mba' and agent_id is null)` ;
- `conversation_messages.accuse_le timestamptz` nullable, sans défaut ni index (la lecture passe par
  `meta_message_id`, déjà unique).

Elle passe **AVANT le déploiement** : le code écrit les deux colonnes. L'ancien code y survit (un CHECK relâché,
une colonne à défaut `false`, une colonne nullable qu'il ne lit pas). Relue en base juste après `migrate`.

🔴 **Rayon de souffle, à énumérer dans le plan et à tenir par un test** : jusqu'ici, un outil d'espace
(`agent_id` null) était forcément un **connecteur**. Chaque lecteur de ces lignes doit dire s'il veut les outils
de l'agent de Meta ou non : le catalogue proposé aux agents IA, les écrans de Tools > Connecteurs API, le compte
d'outils d'une requête, les routes qui ajoutent un consommateur (un outil de l'agent de Meta ne s'ouvre jamais à
un agent IA), et la publication, qui filtre aujourd'hui sur `origin = 'http'`.

## 7. Ce que l'agent de Meta reçoit en retour

Même enveloppe que pour un connecteur : `200 {succes, reponse}` ou `200 {succes: false, erreur}`.

| Outil | `reponse` en cas de succès |
|---|---|
| Poser un tag | « C'est fait, c'est enregistré sur la fiche du client. Confirme-le-lui sans citer de nom technique. » |
| Enregistrer une information | « C'est enregistré sur la fiche du client. » |
| Envoyer un bloc | « C'est fait : le client vient de recevoir le message prévu. Ne rappelle pas cet outil pour cette demande, et n'en répète pas le contenu. » |
| Lancer un scénario | « C'est fait : le parcours est lancé et le client en reçoit déjà les messages. Ne rappelle pas cet outil, et n'écris rien de plus pour cette demande : la conversation te reviendra à la fin du parcours. » |

Le nom de l'étiquette ou du champ n'est jamais renvoyé : ce sont des noms internes, que l'agent répéterait au
client.

🔴 **CORRIGÉ APRÈS L'ESSAI RÉEL DU 2026-09-22.** Les deux dernières lignes disaient d'abord « Engage Me déroule
maintenant un parcours… N'écris rien pour cette demande » : l'agent de Meta a rappelé « Lancer un scénario » SEPT
fois dans le même tour, et le client a reçu sept fois le premier message. La réponse du tag, qui commence par
« C'est fait », avait conclu le tour du premier coup. D'où le « C'est fait » et le « Ne rappelle pas cet outil », et
surtout un garde qui ne dépend pas du modèle : un envoi ne se rejoue pas pour le même client et le même outil
pendant deux minutes (`src/mba/anti-rejeu.ts`), y compris quand les appels arrivent SIMULTANÉMENT (la clé se
prend d'un seul geste, sans attente). Le rappel reçoit « Cette demande vient déjà d'être traitée pour ce client :
ne rappelle plus cet outil pour elle », et rien de plus : ni « le client a reçu » (faux après une panne ou un
refus), ni « n'écris rien » (le rappel part aussi quand aucun parcours ne tourne, et le client resterait sans
réponse).

🔴 **META COUPE UN OUTIL VERS TROIS SECONDES (essai réel du 2026-09-22, l'après-midi).** Un envoi de bloc bien
parti, mais dont le relais a répondu en 3 005 ms, a été traité comme un échec : l'agent de Meta a annoncé au client
qu'« un membre de l'équipe reprendra la conversation ». Un message d'opérateur envoyé depuis l'Inbox, lui, ne le
déclenche pas (vérifié par Julien) : c'est bien le délai, pas la prise du fil. C'est aussi, très probablement, la
vraie cause des sept rappels du matin, chaque lancement dépassant ce délai. Un envoi fait deux appels à Meta
(prendre le fil, envoyer) : le relais ne l'attend donc que 1,5 s (`DELAI_REPONSE_ENVOI_MS`). S'il a fini, Meta lit
l'issue réelle, refus compris ; sinon il lit « C'est parti : … » (`REPONSE_EN_COURS`), l'envoi continue, et le
journal des appels se clôt sur son issue réelle.
Un envoi qui échoue APRÈS cette réponse (le lancement d'un scénario reprend le fil avant ses autres refus) est dit à
l'agent de Meta par un événement `envoi_echoue` (`src/mba/signaler-echec-tardif.ts`), seulement si le fil est à
lui : sans ça, ayant lu « n'écris rien de plus », il se taisait et le client restait sans réponse.

🔴 **LE DÉLAI N'ÉTAIT PAS LA CAUSE DE L'AVIS, et c'est mesuré (essai du scénario, 15 h 27).** Le relais a répondu en
1,5 s et l'avis « un membre de l'équipe reprendra la conversation » est revenu quand même. Ce n'est pas le message
de passage à un humain réglé sur l'agent (« Je transmets votre demande… ») mais un texte générique de Meta, et il
n'est apparu que lorsque nous prenions le fil PENDANT que l'agent attendait la réponse de l'outil. L'essai de
l'Inbox (aucun avis) prenait le fil HORS de son tour, il ne départageait donc pas les deux causes. **Expérience
décidée par Julien** : le relais répond d'abord et demande à l'agent d'annoncer l'envoi en une phrase ; le geste
attend ensuite son écho (`src/mba/fin-de-tour.ts`, 15 s au plus) et seulement alors prend le fil et envoie. Le
journal du serveur dit `fin-de-tour: reponse|delai|illisible` : c'est ce que l'essai suivant doit lire.

## 8. La publication chez Meta

Un outil maison se publie comme un outil de connecteur, sous le même connecteur `EngageMe` : `POST
/outils/<id>`, l'en-tête du numéro lié à `WHATSAPP_PHONE_NUMBER`, et un corps qui ne porte que ce que l'agent
fournit (`{valeur}` pour `champ_fixe`, rien pour les trois autres). `planifierPublication` et la comparaison avec
ce que Meta détient ne changent pas ; seule la liste des outils à publier s'élargit (§ 6).

## 9. L'écran « Outils », refait

**Demande de Julien, 2026-09-21, croquis à l'appui** : « un premier écran très clair qui liste les outils et le
type d'outil et un gros bouton + rajouter. Et quand on appuie sur +, qu'on choisisse la liste d'outils dispo ».
Maquette validée le même jour, sans le bandeau d'envoi qu'elle proposait : « au pire le user cliquera dans la
liste sur le bouton À envoyer ».

### 9.1 Le premier écran
- Un bouton **« Ajouter un outil »**, bien visible.
- **La liste des outils de l'agent de Meta, et d'eux seuls.** Par ligne : le titre ; ce que l'outil vise
  (l'étiquette, le champ, « bloc X du scénario Y », le scénario, l'appel) ; le type (Tag, Information, Bloc,
  Scénario, Connecteur API) ; l'état chez Meta ; « Modifier » et « Supprimer ».
- **Disparaissent** : la bibliothèque de tous les outils de l'espace, la colonne « Utilisé par », la case
  « Exposé à l'agent de Meta » et le panneau « Envoyer chez Meta ». Les outils de connecteur d'un agent IA se
  gèrent depuis sa fiche.
- Un outil de connecteur **partagé avec un agent IA** porte une ligne « aussi utilisé par … » : la définition est
  unique depuis 0127, donc le modifier ici le modifie pour cet agent aussi. « Supprimer » ne le retire alors
  qu'à l'agent de Meta, et la définition reste à l'agent qui s'en sert.
- **Une ligne rouge quand la cible n'existe plus** : scénario supprimé ou dépublié, bloc supprimé ou devenu un
  bloc qui attend une réponse, appel supprimé dans Connecteurs API. Calculée par le serveur, avec la même
  vérification que celle du relais à l'appel.
- Rien ne s'affiche tant que la lecture n'a pas abouti (règle de l'écran actuel : une liste vide pendant le
  chargement dirait « aucun outil » à un espace qui en a).

### 9.2 L'état chez Meta, et le bouton « À envoyer »
- Par ligne, **« Chez Meta »** ou **« À envoyer »**, calculé par le plan de publication (`planifierPublication`),
  jamais par un drapeau tenu à part : une ligne est « À envoyer » quand le plan porte un geste sur son outil, ou
  sur le connecteur `EngageMe` dont tous dépendent (clé révoquée par le client, adresse du relais changée).
- **« À envoyer » est un bouton, et c'est le seul moyen d'envoyer hors d'un enregistrement.** ⚠️ Il envoie TOUT ce
  qui attend, pas seulement sa ligne : Meta ne reçoit qu'une publication entière, et le bouton le dit au survol.
  Quand elle efface quelque chose chez Meta (un outil ajouté à la main dans WhatsApp Manager), la confirmation
  actuelle, qui nomme ce qui part, est gardée.
- Pendant l'aller-retour (plusieurs secondes), l'attente se voit et les boutons d'envoi sont désactivés, avec la
  garde de réentrée actuelle (`envoiRef`). Le serveur refuse de toute façon une seconde publication simultanée.
- ⚠️ **Ce qui attend sans ligne pour le porter** (un outil ajouté à la main chez Meta, à effacer) part au
  prochain envoi, quel qu'il soit. C'est la conséquence assumée de l'absence de bandeau.

### 9.3 Enregistrer, c'est envoyer
Créer, modifier ou supprimer un outil le porte chez Meta **dans le même geste**. La suppression demande une
confirmation. Un envoi qui échoue ne défait pas l'enregistrement : la ligne reste « À envoyer », et le message dit
que l'outil est enregistré et que c'est le voyage vers Meta qui a échoué.

⚠️ **C'est un changement délibéré de la règle actuelle**, où une correction ne partait pas seule (« les mots
corrigés doivent pouvoir se relire à l'écran avant d'aller chez un tiers ») : le formulaire est ce lieu de
relecture, et le bouton séparé a fait rater le premier essai réel du relais. Le commentaire de l'écran actuel qui
porte l'ancienne règle part avec lui.

### 9.4 Ajouter, modifier
- **« Ajouter un outil »** ouvre le choix du type : Poser un tag, Enregistrer une information, Envoyer un bloc,
  Lancer un scénario, Appeler un connecteur API. Ce dernier est **grisé, avec le lien vers Tools > Connecteurs
  API**, quand l'espace n'a déclaré aucun appel.
- **Un formulaire par type**, pour la cible :
  - l'étiquette, existante ou nouvelle ;
  - le champ, parmi ceux du mini-CRM, et les valeurs permises en option ;
  - le scénario puis le bloc, les blocs qui attendent une réponse étant grisés avec leur raison ;
  - le scénario, parmi les publiés ;
  - l'appel, avec « Engage Me remplit lui-même » et « l'agent de Meta les obtient du client », comme aujourd'hui.
- **Puis commun à tous** : le titre, « Quand l'appeler » et « Quand NE PAS l'appeler », pré-remplis d'une consigne
  directive propre au type.
- **Le nom technique** vu par l'agent de Meta se calcule à partir du titre (minuscules, chiffres, tirets bas,
  64 caractères au plus). Il reste modifiable, et un nom déjà pris se signale à la saisie, pas à l'envoi.
- **« Modifier »** rouvre le même formulaire, cible comprise.

### 9.5 Ce qui part avec l'ancien écran
- `web/components/BibliothequeOutils.tsx` est remplacé par des composants plus petits : la liste, le choix du
  type, un formulaire par type.
- L'adresse `/outils`, gardée pour les liens déjà partagés, renvoie vers cet onglet.
- La route qui lit la bibliothèque reste servie : l'écran des outils d'un agent IA la lit (`AgentOutils.tsx`).
- Les cas de `web/e2e/mba-onglet-outils.spec.ts` sont conservés, ou remplacés nommément, jamais perdus en route
  (dont la garde de l'envoi en cours de la revue finale du 2026-09-21).

## 10. Refus

Tous en `200 {succes: false, erreur}`, dans les mots de l'agent de Meta :

| Cas | Outils |
|---|---|
| outil inconnu, inactif ou d'un autre espace | tous |
| client non identifié ou absent du carnet | tous |
| valeur absente ou hors liste | champ |
| scénario supprimé ou non publié ; bloc supprimé, ou devenu un bloc qui attend une réponse | bloc, scénario |
| client désabonné ou bloqué | bloc, scénario |
| fenêtre de 24 h fermée pour un message de session (bloc) ou un scénario qui ouvre par l'un d'eux | bloc, scénario |
| Meta refuse de nous rendre le fil | bloc, scénario |
| l'envoi échoue chez Meta | bloc, scénario |

Poser un tag ou écrire un champ sur un contact désabonné reste permis : ce n'est pas un message.

## 11. Découpage proposé

1. **Mesure M2, jetable** : un script sur le VPS envoie un `agent_event` dans la conversation de Julien pendant
   que l'agent de Meta tient le fil, et on regarde s'il répond, et avec quel format de `to`. On vérifie aussi que
   la conversation de Julien n'est pas marquée de TEST (`conversations.is_test`), sans quoi le fil ne lui
   reviendrait jamais pendant l'essai réel. Le résultat décide du lot 4.
2. **Base, tag et champ, et le nouvel écran** : migration 0162, catalogue et handlers, branche maison du relais,
   publication, rayon de souffle ; l'onglet refait (§ 9) avec les formulaires tag, information et connecteur API.
3. **Bloc et scénario** : sélection des blocs admissibles, prise et retour du fil, leurs deux formulaires.
4. **La réponse « à côté »** : `agentEvent`, transmission, réparation du marqueur et `accuse_le`.

**Méthode de livraison** (à écrire dans le plan) : implémentation par lot avec revue humaine du diff. La
production emprunte ces chemins (envoi de messages, traitement des statuts, migration) et le marqueur porte un
invariant invisible (0149). Revue finale avant déploiement.

**L'essai réel qui clôt la feature**, par Julien sur son numéro : les quatre outils créés depuis le nouvel
écran, chacun passant de « À envoyer » à « Chez Meta » sans autre geste que l'enregistrement, puis déclenchés en
conversation ;
un scénario lancé par l'agent de Meta et mené à son terme, où l'agent de Meta reprend la parole ; un second où
Julien répond à côté, et où l'agent de Meta répond à ce qu'il a écrit. M1 se lit pendant cet essai.

## 12. Défauts voisins, consignés et non corrigés ici

- L'outil `envoyer_bloc` des **agents IA** accepte n'importe quel bloc quand sa liste est vide, alors que
  l'écran annonce « aucun ».
- Il ne vérifie pas la fenêtre de 24 h avant l'envoi (Meta refuse alors en 131047).

Ils vont dans `todo.md`, avec leur fichier.
