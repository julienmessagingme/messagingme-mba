# Journal technique : l'archive

> **Ce fichier ne fait JAMAIS autorité sur l'état actuel du système.**
> Il décrit l'état **au moment de chaque livraison**. Le manuel courant est
> [documentation.md](../documentation.md) ; en cas de contradiction, c'est lui, le code, ou la base qui
> tranchent, jamais ce fichier.

## 2026-10-09 : la connexion OAuth ouverte aux autres clients MCP (lot 15), en production

`2d17b2cd`, CI verte job par job, migration 0227 appliquée à 15 h 48 UTC avant le `up`, et APRÈS la publication de la
console. Décisions de Julien du même jour : fiches d'identité de tout client (récupérées avec nos gardes) et
enregistrement dynamique en repli ; retour https ou boucle locale ; nom déclaré marqué comme tel ; toutes les offres,
admins seulement. La spec MCP du 2026-07-28 déprécie l'enregistrement dynamique au profit des fiches, mais Cursor et
VS Code ne pratiquent sûrement que lui. Une base jetable a trouvé AVANT le push le défaut le plus grave du lot : un
CHECK `{1,2000}` passe à l'application de la migration, mais Postgres refuse toute répétition au-delà de 255 à
CHAQUE évaluation, donc toute autorisation, Claude compris, aurait échoué. La relecture a trouvé un rouge d'ordre de
déploiement, pas de code : une API neuve devant l'ancienne page de consentement aurait montré un client enregistré
nommé « Claude » avec la phrase sur Anthropic ; A et B sont parties dans le même push, la page publiée avant le `up`.
Ses jaunes corrigés avant le push : les plafonds étaient globaux (`req.ip` est le proxy, d'où `CF-Connecting-IP` et un
plafond global de secours), Cursor était refusé en entier pour son `cursor://` (le serveur remplace désormais ce qu'il
ne fait pas, RFC 7591 § 2), les noms invisibles ou « Claude » sont refusés. Vingt défauts remis au total, tous vus.

## 2026-10-09 : un contact désabonné le reste, même effacé (lot 13, domaine 5, livraison B), en production

`a421ba13`, CI verte job par job, migration 0226 appliquée à 13 h 43 UTC avant le `up` (relue en base, puis les six
requêtes neuves planifiées par Postgres contre la production, sans rien exécuter). Décisions de Julien du même jour :
pas de route d'import (le lot reste à 50, une recette dans la doc), et une liste de refus de trois ans. Une première
recommandation de relever le lot à 1 000 a été retirée avant tout code : elle ignorait que le lot tient la place lourde
unique du processus, celle des envois de tous les clients ; la règle est de lire l'invariant écrit au-dessus d'une
borne avant de proposer de la bouger. Les tests d'intégration ont tourné AVANT le push sur une Postgres jetable du VPS
(accord de Julien), vérifiés dans les deux sens (onze défauts remis, tous vus, dont un premier essai faussé par un
paramètre SQL laissé sans usage, que Postgres refusait pour une autre raison que le défaut). Relecture : aucun rouge,
sept jaunes, poussés ensuite : la purge lit ses fiches sous verrou (un STOP concurrent était perdu), la recette cite
les plafonds horaire et quotidien, « non réversible » devient « illisible sans notre clé », la source est dite en
français dans Sécurité > Consentement, la demande d'origine devient obligatoire dans `affectationsDUpsert`, et deux
commentaires faux sont corrigés. Reste au backlog : une fiche créée pendant la purge de la même personne.

## 2026-10-09 : l'application Meta abonnée aux statuts de modèles

Julien a abonné l'application au champ `message_template_status_update` depuis le tableau de bord (WhatsApp >
Configuration > champs de webhook). Relu en lecture seule juste après (`GET /{app-id}/subscriptions`) : quatre champs,
`message_template_status_update` en v26.0, `messages`, `messaging_handovers` et `standby` en v25.0, rappel inchangé.
La version plus récente ne gêne pas : la lecture n'exige que `event`, l'identifiant, le nom et la langue du modèle.
`template.status_changed` peut donc partir ; il n'a pas encore été vu sur une vraie validation.

## 2026-10-09 : les champs et l'effacement par l'API (lot 13, domaine 5, livraison A), en production

`5e768c39`, CI verte job par job, aucune migration. `GET /v1/fields` (`contacts:read`), `POST /v1/fields` et
`DELETE /v1/contacts/{contactId}` (droit neuf `contacts:admin`), sans logique propre : la création de champ de l'écran
Contenu sortie en `creerChamp`, la purge du mini-CRM sortie en `effacerContacts`, que la console appelle désormais
aussi, avec la MÊME instance de limite du jour. Décisions prises par Claude en l'absence de Julien (spec § 7), à
relire ; l'import d'un fichier attend sa décision. Relecture : aucun rouge, cinq jaunes, dont quatre poussés ensuite :
un second DELETE sur une fiche déjà effacée rendait 200 et entamait la limite du jour (`contactIdsForTarget` rend aussi
les fiches effacées, la route lit désormais la fiche vivante) ; l'effacement passe sous le plafond des opérations
lourdes, comme la purge de la console ; le test « la réponse n'attend pas Meta » ne prouvait pas l'ordre, il reprend le
montage de la purge ; la spec dit ce que la liste rend. Le cinquième attend Julien : effacer puis recréer une fiche
efface aussi son STOP.

## 2026-10-09 : les webhooks sortants par l'API et par Claude (lot 13, domaine 4), en production

`f7a75586`, CI verte job par job, aucune migration. Dix routes `/v1/webhooks` sous le droit neuf `webhooks:write`
(lire compris : le journal porte des données de contacts) et trois outils MCP réservés à une personne, sur les
fonctions de gestion de la console. Décisions prises par Claude en l'absence de Julien (spec § 6), à relire. Relecture :
un rouge, corrigé avant le push et vérifié dans les deux sens : les routes n'étaient câblées nulle part dans
`src/index.ts`, donc absentes de la production (tenu par `tests/v1-cablage.test.ts`). Et un jaune corrigé dans le même
commit : l'audit d'un appel par clé échouait, l'identifiant `apikey:<id>` n'étant pas un uuid ; `journalDeLApi` laisse
l'acteur vide et met la clé dans le détail. Le plafond des opérations lourdes sur l'essai et le rejeu est parti avec le
domaine 5 ; la pagination du journal par la date seule est au backlog.

## 2026-10-09 : la validation d'un modèle devient un événement (lot 13, domaine 3, livraison C), en production

`cbaa9933`, CI verte job par job, aucune migration. `template.status_changed` naît du champ
`message_template_status_update` de Meta, au niveau du compte WhatsApp : l'espace se retrouve par `waba.id`, et la
distribution d'un événement d'espace partage avec les signaux les adresses servies et le gel par l'offre. L'application
Meta n'y est pas encore abonnée (lu le même jour) : Julien s'y abonnera, et rien n'arrive d'ici là. Relecture : aucun
rouge, trois jaunes, poussés ensuite : un lot mixte « accusés plus statut de modèle » partait sur la file des accusés,
qui n'a pas l'étape ; une panne sur un payload de modèles seul se rejoue désormais au lieu d'être perdue ; le câblage
du worker est tenu par un test.

## 2026-10-09 : Claude envoie un modèle à une personne (lot 13, domaine 3, livraison B), en production

`3e0f2f39`, CI verte job par job, aucune migration, `up` de l'API, des deux workers et de `mba-web` ; cinq portes à
200. Le cœur de `POST /v1/sends` est sorti de sa route en une fonction (`lancerEnvoi`) qui rend `{ statut, corps }` ;
la relecture l'a comparé ligne à ligne à l'ancien handler : mêmes refus, même ordre, même comptage, même idempotence.
`send_template_to_contact` est réservé à une personne, comme `create_template` (décision de Julien du même jour).
Relecture : aucun rouge, sept jaunes, poussés ensuite : le quota d'envois du jour appliqué à Claude (sans lui, dix
modèles par minute toute la journée), les valeurs que Meta refuse à l'envoi refusées avant, la clé consommée dite
dans le refus, la trace de la personne dans le journal, et la page MCP qui disait encore « hors de la fenêtre, rien ne
part ». Lecture des abonnements de l'application Meta, avec l'accord de Julien : le champ des statuts de modèles
n'y est pas ; il s'y abonnera.

## 2026-10-09 : les modèles par l'API et par Claude (lot 13, domaine 3, livraison A), en production

`0ef5ebad`, CI verte job par job, aucune migration, `up` de l'API, des deux workers et de `mba-web` ; cinq portes à
200, les deux routes neuves à 401. Ronde de questions : le format de Meta, utility et marketing, la lecture du statut
plus un événement, l'en-tête par adresse avec nos gardes. La création de l'écran Modèles est sortie de sa route en une
fonction (`creerUnModele`) que l'API et Claude appellent ; la seule chose propre à l'API est le dépôt de l'en-tête.
Un ancien test interdisait tout outil MCP « template » : assoupli par la décision du lot, il interdit toujours les
campagnes et n'admet que les trois outils décidés. Relecture : aucun rouge, douze jaunes, poussés ensuite (gardes des
liens avant le téléchargement, place tenue jusqu'au dépôt, erreurs de Meta traduites, `Retry-After`, marque MP4, corps
d'échec rendu, pagination du statut, câblage tenu par un test) ; le délai du dépôt chez Meta reste dans `todo.md`. Le
dernier jaune était une décision : `create_template` est réservé à une personne connectée (Julien, le même jour), une
clé d'API ne le voit plus, l'API restant aux clés `templates:write`.

## 2026-10-09 : l'envoi au format de Meta (lot 13, domaine 2), en production

`8f237a41`, CI verte job par job, aucune migration. La relecture avait un rouge : la position écrite en chaînes,
comme dans l'exemple de Meta, était refusée ; acceptée depuis, et envoyée en nombres.

Ronde de questions du matin : les types courants, le corps de Meta tel quel (`to` ou nos identifiants), les médias par
URL, rien de plus. La route réutilise les étapes et les gardes du message simple : elles sont sorties de la route
existante en deux fonctions partagées, et `repondreDansLaFenetre` passe désormais par le même `repondreAvec` que
l'envoi générique. L'ancienne adresse `POST /v1/messages` (le premier message simple, renommé `/v1/messages/whatsapp`)
renaît au format de Meta : un ancien appel `{ contactId, text }` y reçoit un 400 qui nomme `type`, rien ne part.

## 2026-10-09 : le film d'accueil de la vitrine passe lui aussi en vertical au téléphone, en production

À la demande de Julien, le film d'accueil (WhatsApp, 1 min 12) a sa version 9:16, recomposée scène par scène dans la
même source de l'atelier que le 16:9 (`~/engageme-motion/engageme-accueil/accueil.src.html`), même minutage et même
musique. Le 16:9 est resté identique à l'image près : 35 captures de référence sur 36 identiques au bit près avant et
après la retouche, la 36e (en pleine plongée de l'ouverture) variant déjà d'une capture à l'autre de la même page.
Sa vidéo porte `data-vertical` et `data-affiche-verticale`, comme le film RCS à côté (`f61970a1`). Vérifié en ligne :
fichiers servis identiques à l'octet près, et au téléphone, source et affiche 9:16, cadre vertical, lecture
automatique. Les huit films de la vitrine ont désormais tous leur version verticale.

## 2026-10-08 : le statut d'un message (lot 13, domaine 1, livraison B), en production le 2026-10-09

`c21dc3b0`, migration 0225 appliquée à 6 h 29 UTC et relue avant le `up`. La relecture : aucun rouge ; l'échec est
devenu définitif, le motif d'un modèle de campagne est relu dans la campagne, et le CHECK est posé NOT VALID (colonne
neuve, rien à balayer). Dans la même livraison, décision de Julien : Claude répond en Free (`reply_in_open_window`).

Migration 0225 (`conversation_messages.statut` et `statut_le`). Plutôt qu'un puits d'accusés de plus, à recâbler dans
trente doubles de tests et dans deux files, l'écriture vit dans la requête qui pose déjà la livraison d'un destinataire
de campagne : un CTE de plus, la même règle de rang, et toute file qui applique des accusés la pose. Ce qui l'a décidé :
le chemin des accusés est le plus fréquenté du worker (des milliers par campagne), un aller-retour de plus par accusé
aurait coûté plus que le CTE.

## 2026-10-08 : les films de la vitrine passent en Messaging Me, et le RCS a le sien, en production

À la demande de Julien, six pushs sur `site/` dans la journée, tous en plomberie sur l'origin du moment (d'autres
sessions poussaient la refonte des pages en même temps), aucun ne lançant de CI (`ci.yml` ignore `site/**`).

- **L'accueil** (`03fc9879`, `617b438f`) : sous le schéma « Deux canaux, une seule conversation », le film d'accueil
  (WhatsApp, 1 min 12) et le film RCS (1 min 03, « passer au RCS, c'est passer de la télé noir et blanc à la télé
  couleur ») côte à côte, l'un sous l'autre sous 760 px, chacun avec sa légende et sa fiche VideoObject.
- **Les quatre films des pages Fonctionnalités**, repassés en Messaging Me sous le même nom (`03fc9879`). Julien
  voyait encore Engage Me : `/films/` se garde un jour dans le navigateur, plus une semaine de
  `stale-while-revalidate` (`site/vercel.json`). Le `?v=2` de leur `src` change la clé du cache sans changer le
  fichier (`739b782c`) ; la règle est dans le `CLAUDE.md` du dépôt.
- **Les deux pages neuves** (Campagnes et scénarios, Pilotage des coûts) reçoivent leur short de 36 s, dans une
  section film sous l'en-tête comme les autres pages (`8d81567e`). L'affiche du pilotage montre la synthèse et sa
  mention « Exemple, chiffres indicatifs », pas un compteur arrêté en plein défilement.
- **Le 9:16 au téléphone** (`4f3865e6`, `a987136e`, puis chaque film neuf) : sous 640 px, `site.js` met dans le
  lecteur la version désignée par `data-vertical` et son affiche `data-affiche-verticale`, et `site.css` donne au
  cadre la forme 9:16 dès le premier affichage, jamais plus haut que 80 % de l'écran. Le film d'accueil n'en avait
  pas encore à la fin de la journée.

Encodage commun : H.264 `crf 28`, 60 i/s, AAC 96k, `faststart`, 2 à 6 Mo par film. Chaque push vérifié en ligne
(fichiers servis identiques à l'octet près aux fichiers poussés), puis en émulation de téléphone (lecture
automatique, source 9:16 choisie).

## 2026-10-08 : l'API lit les fils (lot 13, domaine 1, livraison A), en production

Deux pushs (`ee479c01`, puis `cfedc5ff` pour la page « Démarrer » une fois l'API déployée) : la relecture avait vu que
la page demanderait un droit que l'API en production refusait encore (400), dans la fenêtre que Vercel ouvre au push.
Et un curseur au 30 février passait la forme et faisait lever Postgres (500) : refusé en 400 depuis.

Deux rondes de questions avec Julien ont cadré tout le lot 13 (spec `2026-10-08-api-complete-design.md`) : la lecture
des fils d'abord, l'envoi au format de Meta, un droit neuf par domaine sans reprise des clés, les webhooks aussi par
l'API, et la lecture ouverte en Free. La livraison A pose cinq routes GET sous `conversations:read`, un magasin à part
en lecture seule (la liste de l'Inbox, rafraîchie toutes les 4 s, n'a pas été touchée), et ouvre en Free les trois
outils MCP qui LISENT un fil. Trois choses vues en écrivant : l'identifiant public d'un message est celui de Meta (le
même que rendent l'envoi et les événements, sinon chacun aurait deux identifiants) ; la lecture d'un fichier reçu
devait rester UNE définition (`tests/media-cablage.test.ts` l'exige), devenue une constante partagée ; et
l'auto-attaque rendait 429 au lieu de 401 dès trente routes `/v1`, le pré-filtre des fausses clés étant un budget
GLOBAL de trente par minute : coupé sur le serveur des sondes, comme les autres plafonds.

## 2026-10-08 : l'offre gratuite s'appelle « Free », écrit

Décision de Julien du jour, valeur de l'API comprise : `GET /offre` et `get_plan` rendent `offre: "free"` et une grille
`free`, `pro`, `entreprise`. La base et le code serveur gardent `base` ; la traduction tient en UN point, la vue de
l'offre (`offrePublique`). Le piège était dans l'ordre de publication : Vercel publie la console au push, avant le `up`
de l'API, donc une console qui n'aurait connu que `free` aurait lu l'ancienne réponse comme illisible pendant la
fenêtre (rien de grisé, mais la page de l'offre muette). Elle accepte les deux et ramène `base` à `free`. Les fiches
d'aide qui citent une section touchée ont été relues : deux nommaient l'offre, quatre n'avaient que leur empreinte à
reprendre.

## 2026-10-08 : « mon application répond » (lot 12, livraison B), en production

Poussée (`97235386`), CI verte job par job, 0224 appliquée à 16 h 45 UTC et relue en base avant le `up` de l'API, des
deux workers et de `mba-web` ; portes publiques à 200, la route du répondeur à 401, le mode des 9 espaces inchangé par
le vrai code. La relecture : aucun rouge, douze jaunes. Le premier aurait rendu la CI d'intégration rouge (la fixture
`settingsShape` sans `repondeurAdresseId`, le piège que son commentaire décrit) : corrigé avant le push. Les jaunes de
code ont suivi dans le lot suivant : le lead d'une publicité passait par DEUX chemins de remise, donc deux
`needs_reply` (le faux du test rendait `[]` là où le vrai dépôt rendait la ligne déjà écrite) ; la fin de parcours
envoyait un texte vide ; une réponse API ne coupait plus un parcours en attente ; un fil resté à l'agent de Meta ;
les réessais sans leur priorité.


Le cinquième mode du répondeur, `application` (migration 0224 : `repondeur_adresse_id` en `on delete set null` vers
`adresses_evenements`, CHECK à sens unique comme ceux de 0217). La remise d'un entrant que personne ne tient écrit une
ligne `conversation.needs_reply` vers l'adresse désignée, enfilée en priorité 2 ; l'application répond par
`POST /v1/messages/whatsapp`, hors du quota quotidien. Décisions de Julien du jour : aucun repli si l'application se
tait.

Trois choses trouvées en écrivant, qu'aucun compilateur ne signalait. Le `switch` de la remise (`src/inbox/fil.ts`)
n'avait pas de `default` : le mode neuf y tombait dans le chemin de l'agent de Meta, sans erreur ; il porte désormais
un cas explicite et un `default` en `never`. La réponse de l'application prenait le fil (`takeControl` de
`repondreDansLaFenetre`) : la conversation serait passée à l'équipe au premier message, ce qui sortait cette
conversation du mode dès la première réponse ; une réponse API sur un fil tenu par l'application ne le prend plus. Et l'ensemble
FERMÉ des opérations du compteur d'usage (`usage-guard.compteur.ts`) cachait la nouvelle opération : comptée, mais
invisible des chiffres. Enfin, le choix d'une adresse suit le gel par l'offre, dans le même ordre (`cree_le, id`) que
l'envoi : désigner une adresse gelée aurait passé chaque message à l'équipe en silence.

## 2026-10-08 : les webhooks sortants (lot 12, livraison A), écrits

Spec et plan du jour (`docs/superpowers/specs/2026-10-08-webhooks-sortants-design.md`), décisions de Julien en deux
rondes : les huit signaux en noms pointés, plus `message.received` avec le texte et l'événement d'essai ; données
personnelles incluses ; réessais 24 h sur toute erreur, adresse jamais suspendue ; console plus deux outils MCP.

Ce que la lecture de l'existant a décidé : le bus des signaux (`creerEmetteur`) existait et branchait déjà huit
sources ; les webhooks y sont une destination de plus, avec un filtre par type (`accepte`) pour que les accusés d'une
campagne, décochés par défaut, n'entrent même pas dans la file. Trois pièges évités en écrivant : le corps figé en
`text` et pas en `jsonb` (qui réordonne les clés sous la signature), l'essai suivant enfilé AVANT d'être écrit (sinon
un arrêt laisse un envoi en cours que rien ne relance), et `fetchPublic` câblé dans le module d'envoi lui-même plutôt
que passé par l'appelant (inventaire de `lib-adresse-privee` à six). Le mot « webhook » désigne déjà l'entrée dans le
code : tout s'appelle « événements », seul l'écran dit « Webhooks sortants ». La signature reproduit le vecteur de test
publié par Standard Webhooks.

## 2026-10-08 : le tunnel de la Base (lot 19), écrit

Un espace qui naît (mot de passe ou Google) ne tombe plus sur l'accueil : la page du numéro, sautable (« Plus tard »),
puis `/demarrer`, qui donne la commande `claude mcp add --transport http messagingme <API>/mcp` SANS clé (décision de
Julien : la connexion OAuth se valide par `/mcp` dans Claude Code, rien de secret ne passe par le terminal ; la relecture
a rappelé que Claude Code ne l'ouvre pas tout seul), la clé de l'application
créée sur place (droits par défaut, montrée une fois en ligne de `.env` sous `MESSAGINGME_API_KEY`) et le premier
message à coller. L'adresse dérive de `BASE`, jamais du domaine de la console (où `/mcp` rend 404).

Un écart au plan, tranché à l'exécution : il envoyait l'inscription droit sur `/demarrer`, contre son propre objectif
(le numéro d'abord). Et un trou qu'il ne voyait pas : le retour de Stripe après le paiement d'un numéro fourni arrive
sur `/connecter-whatsapp?abonnement=recu` (`src/stripe/abonnement.ts`), sans la suite, donc l'espace aurait perdu la
page finale. La suite se garde dans la mémoire de l'onglet, et la page finale l'efface.

## 2026-10-08 : C en production, et les jaunes de sa relecture

**Déployée** (`6f1bd0d5`, puis `e4aeecae` : un test d'intégration attendait encore 1 € pour Claude Code contre 5 € pour
la console, rouge en CI, corrigé dans la foulée). 0221 et 0222 appliquées à 11 h 35 UTC AVANT le `up` de l'API et des
deux workers. Rien n'a bougé pour les clients existants, mesuré par le code déployé : les 9 espaces sont en Entreprise,
donc à 10 % de commission comme avant, à 90 jours de conservation, et aucun n'a été daté par la reprise ; les 2 agents
sont passés à 0,07 € de budget. La machine locale était saturée par d'autres sessions : plusieurs tests expiraient à
5 s, tous verts avec un délai d'une minute.

**Les jaunes, corrigés dans le commit suivant** : un espace en échec n'arrête plus la vectorisation des autres, ni celle
des fiches d'aide (J2) ; les coûts de la synthèse lisent la même durée de conservation que la purge, un seul texte SQL
(J3) ; deux transcriptions simultanées ne débitent qu'une fois (J4) ; un réglage de conservation plus court que 30 jours
reste respecté en Base (J5) ; la purge matérialise la durée de chaque espace au lieu de la recalculer par conversation
(J6) ; la fiche d'un contact dit « analysée au prochain message » une fois l'espace passé en Pro (J8) ; la réclamation
de l'analyse lit dans la grille les offres qui ne l'ouvrent pas (J9) ; les textes « 5 € » restants, la description de
`get_credit` et un commentaire doublé (J10) ; un test de bout en bout du débit unique d'un tour avec recherche (J11). Le
J7 (le cache de l'offre de 30 s) est accepté tel quel.

## 2026-10-08 : un outil de connecteur suit enfin sa requête, en production

**Le constat** (Groupama PJ) : la variable `age_mois` de la requête « tarif » est renommée `age` à 9 h 43 UTC dans
Tools > Connecteurs API. L'agent IA qui s'en sert (`obtenir_tarif`) continue de remplir `age_mois`, et chaque appel
est refusé (« information manquante pour interroger le système du client »), sans rien à l'écran. Le défaut était au
backlog depuis la relecture de `099fd6c1` (2026-10-05).

**La mesure** (production en lecture seule, `begin read only` sur un client dédié, aucun SET, base à 0220) : les 3
outils de connecteur de la base divergeaient de leur requête. `obtenir_tarif` et `demande_un_devis` (Groupama PJ)
voyaient `[espece, race, age_mois]` au lieu de `[espece, race, age]` ; `add_tag` (Messaging Me Tech SANDBOX) voyait
`[user]`, sa requête n'ayant plus aucune variable « décidée par l'agent ». Le vrai code du catalogue
(`listToutesConsommateur` puis `outilExpose`) exposait et exigeait `age_mois`.

**La cause** : la création d'un outil recopiait les variables `modele` de la requête dans `agent_tools.params` (la
même dérivation écrite deux fois, `agent-tools.ts` et `mba-outils.ts`). L'exposition au modèle et la validation des
arguments lisaient la copie, le résolveur la requête. Rien ne rafraîchissait la copie. L'agent de Meta y échappait :
sa publication et son relais lisent la requête.

**La parade** : plus de copie. Le catalogue ramène les variables de la requête avec l'outil (sous-requête filtrée sur
l'espace de l'outil, dans `COLONNES`), `versOutil` en dérive les paramètres (`paramsDuConnecteur`) par la relecture
du résolveur (`lireVariables`, déplacée dans `requetes.ts`). La création n'écrit plus rien dans la colonne. Écartées :
la resynchronisation dans la transaction du PATCH (la piste du backlog), qui garde une copie que chaque écrivain futur
devra rafraîchir et demande une reprise des 3 outils faux ; et le refus ou l'avertissement (« N outils à recréer »),
qui fait refaire à la main, consentement compris, ce que le serveur sait faire seul. Les paramètres d'un connecteur
n'ont aucun réglage par outil (le PATCH refuse toute énumération hors catalogue maison) : la copie ne portait rien que
la requête n'ait déjà. Les outils maison et MCP gardent leur colonne. Plan :
`docs/superpowers/plans/2026-10-08-parametres-du-connecteur.md`.

**Les preuves.** `tests/agent-connecteur-params.test.ts` fait traverser une ligne lue (sa colonne périmée, sa requête
modifiée) jusqu'à l'appel réseau, par `executeTool` et le vrai résolveur : vérifié dans les deux sens et borné, la
lecture de la colonne remise rend rouge le seul cas du renommage (`['espece','race','age_mois']`), la garde
anti-IDOR retirée rend rouges les deux cas qui la portent. `tests/integration/connecteur-suit-sa-requete.integration.test.ts`
joue le même parcours sur les vrais magasins, plus les outils maison et MCP et l'isolation de la sous-requête. Le
nouveau code du catalogue, joué en lecture seule sur la production, expose `[espece, race, age]` pour
`obtenir_tarif` : l'ancien `age_mois`, le nouveau `age`, sur les mêmes lignes. Le test d'intégration a aussi été vu
dans les deux sens, sur un Postgres jetable du VPS (accord de Julien) : la lecture de la colonne remise rougit le seul
cas du renommage, le filtre d'espace retiré de la sous-requête rougit le seul cas d'isolation.

**En production** le 2026-10-08 à 11 h 54 UTC (`d7460e34`, au-dessus de la livraison C du lot 6 et de `3a4414cd`),
sans migration, après une relecture indépendante sans rouge (six jaunes, corrigés dans `d7460e34`) et la CI verte sur
ses trois jobs : `merge --ff-only`, l'API et le worker principal, puis le worker d'analyse, le correctif lu dans les
trois conteneurs, la fumée publique et les fiches OAuth conformes, aucune erreur aux journaux.

**L'essai réel** (`test_agent` sur l'agent de Groupama PJ, « un labrador de 3 ans ») : l'agent appelle
`obtenir_tarif` avec `age`, et l'appel part chez Groupama, qui répond ; avant, il était refusé avant de partir. Mais
il envoie `age: 36`. Les MOTS de l'outil, propres à l'outil et écrits le 2026-10-05, disent encore « l'âge en mois
(3 ans = 36) », et la variable `age` de la requête n'a pas de description ; le système de Groupama répond qu'il lui
manque l'âge (« en années, ou en mois s'il a moins d'un an »). C'est un réglage de l'espace, pas un défaut du code :
l'outil de l'agent de Meta, réécrit le matin même, ne demande plus de convertir. Depuis ce lot, une description posée
sur la variable atteint l'agent au tour suivant.

## 2026-10-08 : la liste de l'agent de Meta tourne (plafond de 20), écrit, pas encore déployé

Julien relève que Meta plafonne la liste de l'agent à 20 contacts par numéro (page agent-allowlist, documenté au
changelog du 2026-09-18, 400 au-delà, 1 000 requêtes par heure par app pour l'ajout, la lecture et le retrait). Le
mode liste du 2026-09-29 n'en sortait personne par inactivité : au 21e contact confié, l'agent ne prenait plus
personne et tout partait à l'équipe.

**Ce qu'on a trouvé en cherchant à repasser en EVERYONE.** La cause du « modèle rend le fil à l'agent » du
2026-09-29 est documentée dans la section Conversation Routing de la doc WhatsApp Cloud API, que ni le dépôt ni la
veille ne connaissaient : allumer l'agent le rend seul primaire des portes d'entrée, et un appui sur un bouton d'un
modèle marketing ou utility remet le fil à zéro et le re-route vers ce primaire. Le réglage (primaire par porte,
« Route to Sender », partenaire d'escalade, visibilité standby) se fait UNIQUEMENT dans Meta Business Suite, par
l'entreprise, sans API ; nous ne le trouvons même pas dans notre propre compte. Julien a donc tranché : la liste
reste, et elle tourne, le temps d'obtenir de Meta le routage (ticket Direct Support rédigé).

**La rotation** (`src/mba/liste.ts`, `PLAFOND_LISTE`, `PgListeStore.moinsActive`, sans migration) : liste du numéro
pleine, le contact dont la conversation est la moins récemment active sort avant l'ajout ; Meta la disant pleine
quand notre table ne l'était pas, un autre sort et l'ajout est retenté une fois. Le droit de faire sortir quelqu'un
est requis à chaque ajout : le balayage d'inactivité ne l'a pas (relevé par la relecture : il confiait en rafale des
fils endormis et aurait fait sortir les contacts actifs), ni un identifiant qui n'est pas un numéro.

Relecture indépendante : aucun rouge. Jaunes traités dans le lot : le balayage, les BSUID, trois cas de test
(retrait du sortant refusé, `greatest` contre `coalesce`, prédicat d'espace de la jointure). Jaunes laissés : une
réaction seule en mode MBA fait encore entrer un contact (`fil.ts`, garde `reactionsSeules` absente du cas `mba`) ;
deux rotations concurrentes choisissent le même sortant ; un contact confié par le bloc « Envoyer au MBA » qui sort
perd sa délégation sans trace ; la colonne d'un contact sorti reste `mba` (état déjà produit par le retrait avant
un modèle). Chaque garde neuve vérifiée dans les deux sens par mutation.

## 2026-10-08 : les coûts selon l'offre (lot 6, livraison C), écrit

**Mesuré avant d'écrire** (tâche 16) : la facturation de Vercel n'est pas lisible par l'API (404 sur ce plan), et le
reranker n'a pas de prix publié. Un appel de chaque sur notre clé (moins d'un centime) a montré que les DEUX réponses
portent leur coût exact : la vectorisation sous `providerMetadata.gateway.cost` (0,00000168 $ pour 14 jetons), le
reranker sous `provider_metadata.gateway.cost`, en snake_case (0,002 $ par recherche). Lire une seule forme aurait
rendu chaque recherche gratuite. Le reranker coûte souvent plus que le tour lui-même. `.env.prod` ne surchargeait ni
la commission, ni le crédit offert, ni la conservation : les défauts du code s'appliquent.

**Ce qui a été arbitré** : la recherche, la vectorisation et la transcription partent sur notre clé et leur coût est
débité (aucune clé d'espace à ouvrir pour une recherche) ; la commission vient de la grille (la variable
`COMMISSION_MODELE_PCT` disparaît) ; une offre illisible rend l'Entreprise, donc la commission la plus basse ; le
journal du crédit garde une ligne de consommation par jour, renommée « consommation IA du jour ».

**Correction de l'entrée de B2b** : la clé restreinte de Stripe écrivait DÉJÀ les abonnements (« Billing >
Subscriptions » en écriture depuis longtemps, confirmé par Julien) ; rien n'attendait cette permission.

**Relecture** : un rouge, corrigé avant le push sur décision de Julien. La recherche dans la connaissance entrait dans le
coût du tour, donc dans le budget par conversation de l'agent (0,03 €) : avec douze recherches permises, un agent qui
cherche beaucoup se taisait bien plus tôt, surtout en Base. Le budget passe à 0,07 € (migration 0222, qui relève les
deux agents existants). Le jaune 1 aussi, parce qu'il change une migration pas encore appliquée : la reprise de 0221
date la sortie des espaces sortis de l'Entreprise avant elle (aucun en production, mesuré). Dix autres jaunes au commit
suivant.

**La décision de Julien sur la purge** : sans date, passer un espace d'Entreprise à Base dans `/ops` aurait effacé tout
de suite ses conversations de plus de 30 jours. Une migration (0221) date la sortie de l'Entreprise ; les 30 jours de
grâce valent pour toute entrée en Base. Le plan annonçait C sans migration : la décision l'emporte.

## 2026-10-08 : l'assistant du MBA envoyait ses consignes sous des noms que Meta ne connaît pas

**Le défaut**, trouvé à la lecture du code le 2026-10-07 : l'assistant appliquait `competence.ajouter` et
`competence.modifier` en envoyant `{ name, instruction }` à `createSkill` et `updateSkill`, quand Meta attend
`title` (slug), `description` (le QUAND) et `skill` (le corps). L'onglet Consignes, lui, envoyait les bons champs.

**La mesure** (numéro de test, sonde effacée, quatre consignes avant et après) : la création à l'ancienne forme
rend **400** (`title, description, and instruction content are required`) ; la modification rend **200 et ne change
RIEN**. La seconde est la pire : l'écran aurait dit « Fait » et l'historique aurait gardé une modification qui n'a
jamais eu lieu. En production, **zéro** ligne d'historique `origine = 'assistant'`, `element = 'competence'` : aucune
consigne n'a été posée ni faussement modifiée par l'assistant, et rien d'autre ne garde d'opération (le fil ne
stocke que du texte, la proposition vit dans le navigateur).

**Le même défaut à la lecture** : l'inventaire lisait `name`, donc le modèle voyait « Consignes (4) » et quatre lignes
vides, sans identifiant. `competence.modifier` et `.supprimer` ne pouvaient viser aucune consigne réelle.

**Ce qui a été changé** (décisions de Julien) : les deux opérations portent `titre` (le slug des messages
interactifs, `titreSlug`), `quand` (1 024 au plus) et `instruction` ; le corps part en `{ title, description, skill }`
et il est typé `Skill` dans `ClientMbaEcriture` comme dans `ClientMbaLecture`, au lieu de `unknown`. L'inventaire lit
`title` et donne la cible de chaque consigne. Une proposition à l'ancienne forme, restée dans un onglet ouvert
pendant le déploiement, est refusée (422) au lieu d'atteindre Meta.

**Pourquoi rien ne l'avait vu** : le faux client des tests ignorait le corps (`createSkill: async () => {...}`), et
le type `unknown` taisait l'écart au compilateur. Les deux sont fermés : les tests lisent le corps envoyé, vérifiés
dans les deux sens (l'ancien corps remis : les deux cas tombent sur `name` au lieu de `title`), et l'ancien corps ne
compile plus (TS2353).

**La relecture** (une, à la fin du lot) : aucun rouge, cinq jaunes, poussés à part. La modification par l'assistant
garde désormais dans l'historique la consigne qu'elle remplace (elle était un no-op, elle est devenue destructive) ;
la cible d'une consigne passe le garde des messages interactifs avant d'entrer dans le chemin de Meta (`..` y
remontait d'un cran) ; une consigne sans titre s'affiche « (sans titre) » et plus « undefined » ; la borne du quand
est tenue égale à celle de l'onglet ; et les tests couvrent la modification. Le reste est dans `todo.md`.

**Déployée** (`88d0feaf`, l'API seule, `mba-api` recréé à 10 h 06 UTC) après la CI verte job par job, avec
`00f351f4` d'une session voisine (un déplacement de fonction dans `src/webhooks/`, CI verte) et `3acbc1e8` (une
spec) ; contrôle de fumée public et fiches OAuth conformes. Les jaunes ci-dessus sont poussés ensuite, NON déployés :
le prochain déploiement de l'API les emporte. **Essai réel** dans l'image déployée, sur le numéro de test, par le
vrai `appliquer` et le même Zod que la route : création relue chez Meta avec `title`, `description` et `skill` ;
modification relue et VRAIMENT changée ; suppression ; quatre consignes avant comme après. Reste à voir un vrai tour
du modèle produire `titre`, `quand` et `instruction` depuis l'onglet Assistant.

## 2026-10-08 : `webhook_events` enfin rattaché à son espace, cinq semaines après 0093, écrit

**Le constat** (2026-10-07, lecture seule en production, `begin read only` sur un client dédié) : sur 24 h, 147
événements, TOUS à `phone_number_id` null. La table portait 1 732 lignes, la plus ancienne du 2026-09-07 : la
rétention de 30 jours tournait, rien d'autre ne l'effaçait.

**La cause** : 0093 (`5456d143`, 2026-08-31) avait posé les deux bouts, `parseWebhook` qui pose le numéro sur chaque
événement et `PgEventStore.insertEvent` qui l'écrit, chacun testé seul. `handleWebhookJob`, entre les deux, recopiait
l'événement champ par champ (`{ source, dedupKey, data }`), sans lui : ce commit n'a jamais touché `handler.ts`. Le
journal du 2026-08-31 annonçait pourtant que le numéro « suit l'événement depuis `parseWebhook` jusqu'à l'insertion »,
et le test d'intégration de la purge insérait ses lignes à la main, colonne remplie : il prouvait la purge, pas le
chemin. 🔴 **Conséquence : la purge RGPD par contact n'a effacé AUCUNE ligne de `webhook_events` depuis sa
livraison.** Ce que la personne avait écrit restait jusqu'au terme de la rétention.

**Le correctif** : `insertEvent(ev)`, l'événement ENTIER. Et le parseur lit le numéro par `numeroBusinessDuChange`,
qui couvre la bascule de contrôle (`recipient.phone_number_id`, sans `metadata`), qu'il ne lisait pas. Un payload qui
nomme plusieurs numéros n'a rien à trancher : chaque ligne est un événement et garde le numéro de SON `change`, ce que
le parseur faisait déjà. Test dans `tests/handler.test.ts`, vérifié dans les deux sens et borné : la recopie remise
rend les trois cas rouges sur `undefined`, l'ancien parseur remis seul ne rend rouge que le cas de la bascule.

**Les lecteurs, relus.**
- `PgContactStore.purgeMany` : son hypothèse tient désormais pour les entrants (`from`) et les statuts
  (`recipient_id`). Elle avait deux trous que la relecture a montrés : un ÉCHO n'a pas de `from` (la personne est
  dans `message.to`, avec le texte de l'agent de Meta) et une BASCULE porte la personne dans `sender.phone_number`.
  Tous deux sont désormais attribuables, mais pas visés ; le commentaire, qui disait l'écho visé, est corrigé,
  l'extension de la requête est laissée à un lot suivant.
- La suppression d'un espace (RC8) ne lit pas la colonne et garde la table pour sa rétention : inchangée.
- `evenementsWebhookDepuis` (alerte des webhooks muets) compte tout : inchangé.
- Les tarifs et signaux des accusés lisent `ev.phoneNumberId` sur les seuls statuts, qui portent toujours
  `metadata` : inchangés.

**Les lignes d'avant ne se reprennent pas** : la ligne garde l'événement, pas le `change`, donc le numéro n'est pas
dans le payload stocké (sauf pour une bascule). Elles partent par la rétention, au plus tard 30 jours après le
déploiement du correctif.

**La leçon** : un champ qui traverse trois maillons se teste sur le chemin ENTIER. Deux tests unitaires verts et un
test d'intégration qui insère à la main faisaient trois preuves, et aucune du câblage. Et un objet recopié champ par
champ pour être retransmis est la forme qui perd le champ ajouté plus tard, même famille que le `Pick` recopié
(CLAUDE.md).

## 2026-10-08 : B2b en production, et les jaunes de sa relecture

**Déployée** (`be063d14`, avec `7f23f10b` d'une session voisine, console et docs seulement) : 0220 appliquée à 8 h 30 UTC
AVANT le `up`, puis l'API, les deux workers et `mba-web` relancés. Julien a choisi de ne pas attendre la permission
« Abonnements : écriture » de la clé restreinte : les écritures refusées le préviennent. La CI de `be063d14` avait été
annulée par le push voisin (même groupe de concurrence) ; celle de `7f23f10b`, qui la contient, était verte, job par
job. **J3 de la relecture mesuré sans objet** : en lecture seule, aucun espace n'avait à la fois un Pro vivant et un
abonnement du numéro seul vivant (un seul Pro en base, fini, celui de l'essai de B1).

**Les jaunes, corrigés dans le commit suivant** : J1, une vieille ligne de numéro LIBÉRÉE n'empêche plus la ligne
portée par le Pro (sinon le numéro neuf d'un Pro n'était jamais suspendu ni libéré) ; J2, un 409
`idempotency_key_in_use` (la même écriture déjà en cours, deux événements traités ensemble) n'est plus pris pour un
refus ; J4, Claude ne dit plus « payer 3,50 » à un espace en Pro ; J5, la fin d'un Pro ne touche à rien quand un autre
Pro vit, et un numéro seul recréé que l'enregistrement ne prend pas alerte au lieu de dire « reprend » ; J6, un Pro qui
prend un numéro neuf ne prend pas celui d'un abonné qui a payé et attend ; J7, un numéro seul en retard de paiement
s'arrête sans avoir ; J8, un espace qui envoie par son propre numéro ne fait pas recréer le numéro fourni.

## 2026-10-08 : le numéro fourni inclus dans le Pro (lot 6, livraison B2b), écrit

**Les décisions de Julien** (7 et 8 octobre) : le numéro attribué sans payer à un Pro ; l'abonnement du numéro seul
arrêté avec un avoir au passage en Pro ; à la fin prévue du Pro, la suite annoncée par la console, Claude et un e-mail ;
« rendre le numéro » vaut à la FIN du Pro (une colonne, migration 0220), et un numéro rendu est gardé 7 jours puis
libéré ; à la fin d'un Pro résilié, le numéro seul recréé sur la même carte ; une création qui échoue se traite comme un
impayé. Pas de planning d'abonnement chez Stripe (ruling de B1 : il heurterait la résiliation en fin de période).

**Mesuré avant d'écrire, en lecture seule chez Stripe** : Checkout range la carte sur l'ABONNEMENT
(`default_payment_method`), pas sur le client, y compris pour l'essai payé avec un code à 100 %. Le numéro seul recréé
prend donc la carte de l'abonnement Pro qui finit ; la créer sans elle aurait échoué faute de carte par défaut.

**Le trou que la conception a fermé** : un numéro attribué pendant le Pro n'a aucune ligne d'abonnement du numéro, donc
le lot 4 n'aurait rien eu à suspendre ni à libérer à la fin d'un Pro impayé ou d'un numéro rendu. La fin du Pro lui en
écrit une, finie à la fin du Pro et au nom du Pro, que le lot 4 traite comme un abonnement fini.

**Les jaunes J2, J5, J6 de B1** : un verrou d'espace commun à la libération et à l'enregistrement d'un Pro ; les avis de
suspension oubliés au passage en Pro ; les pauses `numero_suspendu` levées au paiement du Pro.

**Relecture** : un rouge, corrigé avant le push. Un Pro arrêté TOUT DE SUITE (Julien qui résilie à la main avant de
supprimer un espace depuis `/ops`, ou à la demande d'un client) recréait le numéro seul et le prélevait sur la carte
d'un client qui part, sans que rien ne l'ait annoncé. Seule une fin à la fin PRÉVUE (à 24 h près) le recrée désormais ;
une fin immédiate suit le chemin d'un impayé, et Julien est prévenu. Huit jaunes, reportés au commit suivant.

## 2026-10-07 : les jaunes de la relecture de B2a (lot 6)

**Ce qui part** : `d9517a45` (51 fichiers, aucune migration), poussé le 7 au soir par-dessus deux commits voisins, l'arbre
fusionné revérifié (typage, suite, auto-attaque, console, e2e de l'offre). CI verte job par job, déployé le 8 au matin
sur décision de Julien : l'API, le worker principal et `mba-web` relancés, le worker d'analyse ensuite, le proxy
rechargé après le `healthy`. Portes publiques à 200, `/mcp` à 401, journaux propres. Le correctif voisin `75c896ae` (le
bac à sable de Meta) est parti avec.

**Trois décisions de Julien** : un widget au devenir « scénario » est gelé en Base comme tout démarrage d'un scénario
du client ; « Envoyer un bloc » d'un agent IA est gelé comme celui de l'agent de Meta ; la suspension des membres ne
vaut qu'en Base et en Pro (en Entreprise, une limite tapée dans `/ops` ne coupe personne).

**Ce qui contournait le gel, fermé** : le routage d'une publicité reprenait le fil chez Meta avant que le déclencheur
ne se taise (la pub se lit désormais absente sans `publicites`) ; les outils d'envoi de l'agent de Meta refusaient
APRÈS l'attente de fin de tour (jusqu'à 15 s, quand Meta coupe un outil vers 3 s), et les deux agents pouvaient redire
au contact une phrase qui parlait d'offre (une phrase neutre, `INDISPONIBLE_POUR_LE_MODELE`) ; `/v1/sends` et la
campagne de la console acceptaient un scénario puis échouaient destinataire par destinataire (402 à la création) ; le
lien de connexion du numéro et le changement d'espace ignoraient la suspension ; l'ancienne forme du réglage du
répondeur rendait un 402 « mba » à un espace qui voulait seulement retirer son agent IA. Plus : l'état du compte et le
gel lus en parallèle, les instructions du serveur MCP valables pour toute offre, le 402 du jeton de Claude au corps
commun, le journal du gel en une ligne par événement, et « Réessayer » sur la page suspendue.

**Chaque correctif a son test, vu rouge puis vert.** Ces jaunes ne se font pas relire seuls : ils le seront avec le lot
suivant.

## 2026-10-07 : au retour en Base, on gèle sans rien effacer (lot 6, livraison B2a)

**Ce qui part** : `ac36a394` (80 fichiers, aucune migration), construit par-dessus la livraison A des messages
interactifs d'une session voisine (`282a7a6b`, déployée juste avant à son SHA précis), l'arbre fusionné revérifié
(typage, suite, auto-attaque). CI verte job par job, puis l'API, le worker principal et `mba-web` relancés, le worker
d'analyse ensuite, le proxy rechargé après le `healthy`. Portes publiques à 200, `/mcp` à 401, journaux propres. B2 a
été découpé par Julien en deux : B2a le gel, B2b le numéro inclus dans le Pro (qui, lui, demande une migration).

**Essai réel, le même soir** : une sonde en lecture seule a d'abord montré que « Espace de dumas family » n'a ni
automation, ni scénario, ni réglage de réponse, et un seul membre. Passé en Base : dans « Qui répond », « Agent de
Meta » et « Scénario » grisés, vu par Julien dans la console. Remis en Entreprise. Le gel des démarrages et celui des
membres n'ont pas pu y être vus en vrai (rien à geler) : ils restent prouvés par les tests et l'intégration.

**Les décisions de Julien** : en Base, les scénarios lancés par les 10 automations les plus anciennes du client
continuent, tout autre démarrage d'un scénario du client s'arrête (Inbox, agent de Meta, outil d'un agent IA,
campagne à scénario, lien de test, scénario répondeur) ; le répondeur agent IA et les parcours en cours continuent.
L'agent de Meta ne reçoit plus aucun contact neuf, ceux qu'il tient finissent avec lui, rien n'est écrit chez Meta.

**Un point de passage par gel, et rien d'écrit** : les démarrages (`creerLancements`), les automations
(`runAutomations` et `plusAnciennes`), qui répond (`sousLOffre`, appliqué au fil, à `mbaActifPour` et à
`modesParTenant`), les membres en trop (`requireAuth` et la garde des jetons de Claude, 402 avec l'accès suspendu,
les administrateurs les plus anciens d'abord), les outils MCP (chacun déclare sa fonction, celle-ci est requise). Une
offre illisible se lit Entreprise. Les fixtures disent leur hypothèse (`offresToutOuvert`, et `plusAnciennesJamaisLues`
qui lève si on la lit).

**Rayon de souffle mesuré avant la relecture** : deux tests seulement lisaient la vraie offre, et l'offre par défaut
d'un espace neuf est Base. Le test d'intégration du répondeur a été posé en Entreprise (cas Base ajouté), et la base
factice du socle répond Entreprise. Suite serveur, auto-attaque (1555 sondes), console et e2e complet (1433) verts.

**Relecture** : aucun rouge. Les 9 espaces sont en Entreprise sans limite de membres, donc rien ne gèle au
déploiement, et une panne de lecture laisse tout passer. Un jaune certain corrigé avant le push : le test
d'intégration du rang créait un 4e membre sous la limite de 3 de son propre magasin, la CI aurait été rouge sans
jamais exécuter le SQL du rang. Onze autres jaunes, reportés au lot suivant, dont trois à trancher par Julien (les
widgets à scénario créés en Base, « Envoyer un bloc » de l'agent IA non gelé, une limite de membres posée en
Entreprise qui suspend tout de suite).

## 2026-10-07 : RC7 et RC8 en production, et la fin du chantier « Retours console du 6 octobre »

**RC7, le champ du contact dans le lien d'un bouton** : serveur `b92c63dd` (API et deux workers, aucune migration),
console `37450e44` poussée après le `up`, CI verte job par job sur les deux. Mesuré avant le déploiement, en lecture
seule : 0 destination sur 22 dans `tracked_links` ne porte d'accolade, donc aucun lien déjà envoyé ne change de
comportement ; deux liens réels (`/r/<code>` et `/r/<code>/anon`) relus depuis l'extérieur avant et après le `up`,
identiques. Et, par le vrai code dans le conteneur, les boutons des 33 modèles chez Meta comparés aux 18 liens
confirmés : UN écart, `lancement_napo_date_finale`, que l'ancien PATCH avait renvoyé à Meta avec l'adresse brute
pendant que `tracked_links` le disait tracé à jeton. Campagnes et scénarios l'envoyaient déjà avec un composant en
trop ; l'Inbox, corrigée, fera de même. Laissé tel quel (le déconfirmer cacherait ses clics passés), à rééditer par
Julien (`todo.md`). Relecture : aucun rouge ; un jaune corrigé avant de pousser (un remplissage de champ qui lève sur
un demi-substitut isolé rendait 500 sur la route publique, test vérifié dans les deux sens).

**RC8, supprimer un espace depuis /ops** : serveur et migration `2e082268`, posés sur la livraison B1 du lot 6
(`4220dc42`, une autre session) qui touchait six des mêmes fichiers, dont le webhook Stripe ; le chemin du Pro y a
reçu la même garde que le numéro (23503 sur `pro.enregistrer` : 200 et alerte). 0219 appliquée à 14 h 08 UTC AVANT le
`up`, relue en base, puis le bilan exécuté par le vrai code déployé, en lecture seule, sur l'espace d'essai « nouveau
test » (un compte, son adresse gardée parce qu'elle a d'autres espaces). Console `2cd0d9a4`. Mesuré avant d'écrire le
plan : aucun compte WhatsApp croisé entre espaces, deux espaces sur le jeton global (pour eux, les étapes chez Meta
seront sautées). Relecture : aucun rouge ; un jaune corrigé (la prise du verrou de suppression hors du `try`, un 500
illisible si la base ne répond pas).

**Coordination** : les deux sessions ont alterné sur le VPS (B1 déployé entre le push de RC8 et son `up`, RC8 poussé
seulement après le « fini et contrôlé » de l'autre, faute de quoi son build aurait embarqué un code dont la migration
n'était pas appliquée). La CI de la console RC8 a été annulée par le push suivant (`d8cf836d`) : son verdict se lit
sur ce descendant, qui la contient.

## 2026-10-07 : supprimer un espace depuis /ops (RC8), écrit, pas encore déployé

**Ce qui est écrit** (plan `docs/superpowers/plans/2026-10-06-rc8-supprimer-un-espace.md`, migration 0219
`espaces_supprimes`) : un bilan (`GET /ops/espaces/:tenantId/suppression`) puis la suppression définitive
(`DELETE /ops/espaces/:tenantId`, le nom tapé à l'identique). Le verrou, puis la clé Vercel (son échec arrête tout),
puis au mieux l'agent de Meta, sa liste, l'abonnement du compte WhatsApp à notre app, Salesforce, HubSpot et le numéro
fourni, puis la purge en une transaction avec sa ligne de trace. Le détail : `documentation.md` § 10.

**Ce que la lecture du code a ajouté au plan :**
- la révocation lisait la clé DÉCHIFFRÉE : une clé illisible passait pour « pas de clé », la purge l'aurait laissée
  facturer à vie. Elle lit désormais l'identifiant en clair (`PgCleGatewayStore.idDe`) ;
- le verrou n'empêchait pas d'OUVRIR une clé : une traduction lue par une session d'observation, ou une création
  d'agent en vol, la rouvrait derrière la révocation. `assurerCleGateway` et `creerAssureurDeCle` refusent désormais un
  espace verrouillé, et la purge refuse si une clé est réapparue ;
- un objet Meta partagé avec un autre espace, ou le jeton global de notre compte, font SAUTER les étapes chez Meta ;
- le schéma `salesforce` ne se nomme que dans `src/salesforce/` (`tests/salesforce-isolation.test.ts`) : la purge ne
  le touche pas, l'étape `salesforce` délie l'org par son propre magasin ; le schéma `mmhs` du connecteur HubSpot ne
  se touche que par `/service/unlink` (supprimer `tenant_portals` à la main laisserait un jeton HubSpot vivant) ;
- les jobs en file d'un espace supprimé s'abandonnent en silence sur la pierre tombale (`PgBossQueue.abandonnerSi`) au
  lieu de remplir la file des morts ;
- le webhook Stripe rendait 500 en boucle sur la facture d'un espace disparu (23503) : 200, et Julien est prévenu avec
  le lien de l'abonnement.

## 2026-10-07 : un champ du contact dans l'adresse d'un bouton « Lien » (RC7), et deux envois cassés réparés

**Ce qui est écrit** (plan `docs/superpowers/plans/2026-10-06-rc7-lien-dynamique.md`, aucune migration) : une
destination peut porter `{cle}` (`https://site.fr/commande/{numero_commande}`), stockée telle quelle ; Meta reçoit
toujours notre lien à jeton, et la redirection remplit le champ au clic avec la fiche lue dans l'espace du lien. Un
champ avant le chemin est refusé à la création (une valeur écrite par le contact ferait de `/r/` un redirecteur
ouvert), et l'adresse remplie est revalidée avant le 302. Console : un bouton « Variable » sur l'adresse, un exemple
dessous.

**Les deux constats de lecture du plan, confirmés par un test qui échoue sans le correctif :**
1. L'envoi manuel d'un template depuis l'Inbox partait sans le composant `url` d'un bouton tracé (131008 chez Meta) :
   il passe désormais par `suffixesPourUnEnvoi`, partagé avec le bloc de scénario.
2. Le PATCH d'un template renvoyait à Meta l'adresse SAISIE (celle que la console réaffiche) au lieu de notre lien,
   alors que `tracked_links` la disait toujours confirmée à jeton. Il repasse par le traçage.

**Ce que le correctif du PATCH a fait apparaître** : `allocate` remet la confirmation à zéro sur chaque position qu'il
touche. Une édition refusée par Meta (quota d'éditions) aurait donc laissé un template APPROUVÉ sans liens confirmés,
et chaque envoi sans son jeton ; une création refusée parce que le nom existe déjà faisait déjà la même chose au
template en service. La création et l'édition remettent désormais les liens d'avant en l'état sur un refus, et
déconfirment ceux qui ne sont plus dans le template sur un succès (`soumettreAvecLiens`).

## 2026-10-07 : le Pro payable chez Stripe (lot 6, livraison B1)

**Ce qui part** : `4220dc42` (42 fichiers, aucune migration), CI verte job par job, puis l'API, le worker principal et
`mba-web` relancés, le worker d'analyse ensuite, le proxy rechargé après le `healthy`. Portes publiques à 200,
`/offre/paiement` et `/offre/portail` à 401 sans session. Le Pro n'est pas en vente tant que les deux prix Stripe ne
sont pas posés dans `.env.prod`.

**Le trou trouvé en écrivant le manuel** : la couverture du numéro par le Pro vivait dans `etatDeLEspace`, que le
balayage lit AVANT la transaction de libération ; la transaction, elle, relisait le réabonnement du numéro et pas le
Pro. Un Pro payé entre les deux laissait résilier le numéro chez DIDWW. Elle relit désormais le Pro, avec la même
grâce de 7 jours (test unitaire rouge puis vert, cas ajouté à l'intégration).

**Sonde SQL en lecture seule avant le push** : les quatre écritures du magasin du Pro expliquées (`EXPLAIN` sans
exécution), les trois lectures exécutées sur les 9 espaces ; aucun Pro en base, donc la couverture ne change rien.

**Relecture** : aucun rouge de code. Un rouge CONDITIONNEL chez Stripe, vérifié en lecture seule : quatre codes promo
actifs sans plafond d'utilisation, dont ENGAGE100 (100 %, restreint aux deux recharges, nommé dans le dépôt public),
GMC100 (100 % pour toujours) et VERIF100 (100 %), ces deux-là sans restriction de produit. Or la recharge crédite le
montant AVANT remise : n'importe quel compte pouvait se créditer 100 € par code, sur le plafond d'équipe Vercel qui
coupe tous les bots clients. Personne ne l'a fait (ENGAGE100 n'a servi qu'à l'essai du 29 septembre). Signalé à
Julien. Onze jaunes : sept corrigés dans le lot qui suit, trois reportés à B2 (le numéro y devient inclus), le réglage
du portail chez Julien.

**Mise en vente et essai réel, le même jour** : Julien a créé « Messaging Me Pro » (deux prix, taxe en sus, lus en
lecture seule avant d'être posés), les deux identifiants posés dans `.env.prod`, API et workers recréés. Le portail
client était déjà réglé sans changement de formule (aucun basculement vers un autre produit, mais pas de passage du
mensuel à l'annuel non plus : les textes qui le promettaient sont corrigés). Essai sur « Espace de dumas family » mis
en Base : « Mensuel » payé avec un code à 100 %, abonnement enregistré et espace en Pro dans la minute, puis annulé
immédiatement chez Stripe, fin datée et espace revenu en Base, remis en Entreprise. ⚠️ Cet espace est aussi celui de
l'essai du lot 4 : le Pro a couvert son numéro résilié, et sa fin est devenue celle du numéro, ce qui décale la
première libération réelle au 14 octobre vers 15 h 50 UTC.

## 2026-10-07 : les offres et leurs limites (lot 6, livraison A)

**Ce qui part** : la migration 0218 seule (`45ad6976`, appliquée à 10 h 34 UTC avant le code, relue en base : les 9
espaces en Entreprise), puis le serveur et la console ensemble (`07d0170b`, 108 fichiers). API et deux workers
relancés en deux temps à 10 h 50 UTC, `mba-web` non touché, 28 fiches d'aide chargées, portes publiques à 200, les
deux routes neuves à 401. La vue de l'offre, calculée par le code déployé, rend Entreprise sans limite pour chaque
espace.

**Pourquoi le serveur et la console dans le même commit** : des tests de la racine lisent `web/lib` (la carte de
l'aide, la parité des noms de l'offre, les exemples d'API) ; un commit serveur seul aurait mis la CI au rouge. Publier
la console avant l'API était sans risque : elle lit l'offre et la tient pour inconnue (donc tout ouvert) sur un 404,
ce que tient un e2e.

**Ce que la construction a trouvé** :
- Le partage des statistiques de la tâche 3 fermait à la Base l'accueil et la page Campagnes (elles lisent `/stats`,
  `/stats/templates`, `/stats/cost`, `/stats/cost/campaigns`), et rangeait `/stats/performance` (Quantitatif >
  Performance) en Entreprise en le prenant pour la Synthèse. Refait route par route d'après l'écran qui la lit.
- Un inventaire des écrans ouverts à la Base a trouvé 13 lectures de fond vers des modules gardés (canal RCS, chaîne,
  publicités, état de l'agent de Meta, Batch, Salesforce, assistant de construction, pastille des non-lus toutes les
  30 s) : elles attendent désormais l'offre et disent « Inclus dans l'offre » ; le bandeau d'un refus ne part que sur
  un geste.
- L'e2e a montré que le bandeau d'un refus restait SOUS la fenêtre d'où partait le geste : il est devenu un avis fixe
  au-dessus des fenêtres.

**La relecture indépendante** (un relecteur, 0 rouge, 13 jaunes) : corrigés avant de pousser, la lecture des modèles
du mois (comparée au `now()` de la base, elle rendait 0 dès que la base était en avance d'une milliseconde sur la
copie), `/v1/sends` qui créait les fiches avant de refuser un mois épuisé, une offre illisible qui rendait 500
partout, la conservation affichée d'une Entreprise, et `PUT /ops/offre` qui réécrivait la conservation à chaque
changement d'offre (une purge irréversible à la clé). Les autres jaunes sont dans `todo.md`.

**Mesures** : racine 10 744 tests verts (deux inventaires `git grep` rouges hors dépôt, verts en CI), console 929
unitaires et 1 421 e2e, auto-attaque 1 537 sondes sans trouvaille, CI verte job par job sur les deux commits.

**Essai réel** (11 h 49 à 11 h 51 UTC) : « Espace de dumas family » ramené en Base par l'écriture de `/ops`
(conservation inchangée, trace `ops_offre`), relu par le code (Base, aucune fonction, 1 fiche sur 100, 1 membre sur
1) ; Julien a vu dans la console l'Inbox, le Performance Lab et les menus payants grisés ; l'espace est remis en
Entreprise juste après. ⚠️ La bascule par script depuis cette session a d'abord été refusée par le mode automatique
(écriture distante en production) : elle est passée une fois Julien en mode « accepter les modifications ».

## 2026-10-06 : le numéro fourni libéré à J+7, « Abandonner » et les e-mails (lot 4, livraison B)

**Ce qui part** (`40f8322e`, test `a2bf45c7`, console `7fe7c7e7`, aucune migration) : 7 jours après la fin d'un
abonnement, le balayage libère le numéro fourni. Vu de Meta (relié, ou un code capté), il quitte l'espace et il est
résilié chez DIDWW (`terminated: true`, attribut mesuré sur le compte réel avant d'écrire le client) ; jamais vu, il
retourne `libre`. Une seule transaction, appel DIDWW compris : un refus de DIDWW annule tout et se rejoue. Les admins
reçoivent un e-mail à la suspension, 2 jours avant la libération et à la libération ; chaque avis se note APRÈS un envoi
réussi. « Abandonner » d'un abonné programme la fin chez Stripe (`cancel_at_period_end`), ce qui a demandé le droit
d'écrire les abonnements sur la clé restreinte, vérifié sans rien modifier (une demande sur un abonnement inexistant
rend 404 et non 403).

**Relue : deux rouges, et ils disent la même chose : une règle juste vue d'ici, fausse vue d'ailleurs.**
1. La spec disait « délié chez nous ». Délié mais gardé, le numéro occupait l'unique place de numéro de l'espace
   (`linkTenant`, `lierCompteSansNumero`, la route du paiement) : l'espace n'aurait plus jamais pu en connecter un
   autre, alors que l'e-mail l'y invitait. La ligne est désormais SUPPRIMÉE (aucune clé étrangère ne la référence).
2. La preuve « un code de Meta a été capté » devait éviter de remettre en réserve un numéro que Meta a vu. Mais la
   purge des codes, réglée à 7 jours pour une autre raison, l'effaçait toujours avant la libération (au plus tôt 7
   jours après la fin). Elle épargne désormais les codes d'un numéro attribué.
Leçon : **une preuve qu'on lit à J+7 doit vivre plus de 7 jours, et la durée de vie d'une donnée se relit chaque fois
qu'un nouveau lecteur s'y appuie.**

**La CI a trouvé ce que la relecture ne pouvait pas voir** : le test d'intégration de la libération insérait des
abonnements `sub_lib_a`, refusés par `abonnements_numero_id_chk` (`^sub_[A-Za-z0-9]+$`) ; il n'exerçait donc rien. Le
déploiement a attendu son correctif (`a2bf45c7`) et sa CI verte. Le sens rouge des deux correctifs n'a pas pu être vu en
CI (le commit jetable a été refusé par le garde-fou) ; la condition du rouge 2 de A a été évaluée dans Postgres en
lecture seule.

## 2026-10-06 : ce que devient un numéro fourni dont l'abonnement tombe (lot 4, livraison A, la suspension)

**Le cadrage** (spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`, plan
`docs/superpowers/plans/2026-10-06-numero-impaye.md`) : sept jours de grâce après le premier échec de paiement, puis
suspension ; un abonnement fini suspend tout de suite, et le numéro est gardé sept jours avant d'être libéré
(livraison B). Tous les envois sont coupés ; rien ne change chez Meta.

**Le choix qui porte le lot : l'état se calcule, il ne s'écrit pas.** Le webhook ne pose que des DATES
(`premier_echec_le`, `fin_prevue_le`, `fini_le`, migration 0215, poussée seule en `149db406` et appliquée à 16 h 57
UTC) ; `etatAbonnement` en déduit l'état à la lecture. Un balayage qui aurait écrit `suspendu` à heure fixe aurait
laissé une fenêtre où le paiement et le statut se contredisent, et aurait demandé un second balayage pour défaire.
Le balayage qui existe (toutes les 15 minutes) ne fait que deux choses que le calcul ne peut pas faire : envoyer
l'alerte une fois, et lever les pauses de campagne d'un espace redevenu sain.

**La garde** vit au point d'envoi unique, à côté du délié, avec une erreur mère (`NumeroBloqueError`) que tous les
appelants attrapent : un test d'inventaire l'exige, et chaque surface (API publique, MCP, automations, campagnes,
tour d'agent, remise du fil) a été vérifiée dans les deux sens en remettant le code fautif. Elle ne vise que le
numéro FOURNI (mêmes chiffres que le numéro attribué) : un client qui apporte son numéro ne peut pas être coupé par
notre abonnement. Le tour d'un agent IA vérifie le numéro AVANT le modèle, sans quoi un espace suspendu payait des
réponses que personne ne recevrait.

**Côté client** : le bandeau de la console sur toutes les pages, le rappel MCP en second bloc de chaque réponse
d'outil, `resubscribe_number`, `get_number_subscription` qui dit l'état et ses dates, et le réabonnement au MÊME
numéro (la route du paiement accepte un espace dont le numéro connecté est celui qu'on lui avait fourni). Stripe
renvoie le client de Claude sur une page publique, `/paiement-recu`, qui n'affirme rien du paiement : c'est le
webhook qui le confirme.

**Vérifié avant la relecture** : tests unitaires, suite e2e complète (1 390 verts, le bandeau étant monté sur toutes
les pages), typecheck des deux paquets, auto-attaque. L'extraction a été recalée sur RC2 (`1edb12e3`, le statut
urgent) avant ces essais, quatre fichiers étant communs.

**Relue : deux rouges, corrigés avant le déploiement, chacun avec son test vu rouge puis vert.**
1. Seul le démarrage d'un parcours vérifiait le numéro avant tout effet. Une REPRISE (réveil d'une attente, réponse
   du contact, bloc poussé par un agent) faisait ses effets puis butait sur l'envoi : le bail de 15 minutes rejouait
   « attente, e-mail, modèle » toutes les quinze minutes, soit 96 e-mails par jour pendant toute une suspension.
   Le défaut existait pour le délié, mais un délié est un geste rare dont les entrants sont écartés à la porte ; la
   suspension dure au moins sept jours et garde ses entrants. Leçon : **étendre un mécanisme à un cas neuf, c'est
   relire ce que ses voisins supposaient du cas ancien.**
2. Un échec de paiement rejoué APRÈS le paiement de la même facture repassait l'abonnement en retard avec une
   nouvelle date de premier échec, et coupait sept jours plus tard un client qui avait payé. L'échec porte désormais
   la fin de la période facturée, et le magasin l'ignore quand la période payée la couvre. Le câblage de
   `src/index.ts` enveloppait `majStatut` dans une flèche à trois paramètres qui aurait avalé le quatrième sans
   erreur : `tests/credit-cablage.test.ts` le tient.
Les neuf jaunes sont dans `todo.md`.

**En production** : API et deux workers sur `fca3d285` (VPS avancé par `merge --ff-only` sur ce SHA exact, pour ne
pas emporter RC3 déjà poussé), console `bef80514`. La condition SQL du second rouge n'a pas pu être vue rouge en CI
(le commit jetable a été refusé par le garde-fou) : elle a été évaluée dans Postgres en lecture seule sur des valeurs
littérales, puis jouée verte sur une vraie table par le job `integration`. Essai réel le soir même par Julien :
alerte unique, bandeau, refus dans l'Inbox, état et rappel dans Claude Code.

## 2026-10-06 : les retours console du 6 octobre, cadrés en huit lots ; RC1, le ménage de l'éditeur

**Le cadrage** : douze demandes de Julien, passées au grill le même jour, regroupées en huit lots (RC1 à RC8), chacun
avec son plan (`docs/superpowers/plans/2026-10-06-rc*.md`, `9b2ede4e`). Deux mesures ont changé la forme des plans : le
bloc Condition combinait déjà plusieurs conditions en ET/OU et lisait déjà étiquettes et champs déclarés (seules
manquaient les familles et trois champs système) ; aucun agent IA ne porte d'outil « tag », « information » ou « bloc »
en production (lu en lecture seule), donc les aligner sur le MBA ne demande aucune reprise.

**RC1, console seule** : les textes d'aide listés par Julien retirés des blocs Message rapide, Question, Condition,
Attente (mode délai) et Assigner ; un compteur `n/max` dans les champs de réponse (`ChampCompte`, 20 et 24) ; « Widget
WhatsApp » rangé sous Tools (la carte de l'aide régénérée, le titre de sa section de `features.md` et le
`source_section` de sa fiche suivent). Relu : zéro rouge ; le jaune « pas de test du compteur » corrigé dans le lot
(l'e2e de la Question vérifie `9/24` et l'alerte à `24/24`). Un e2e sans lien, celui des boîtes du Centre de sécurité,
a échoué une fois sur quatre passages sous charge et passé trois fois seul : signalé à part.

**RC2, le statut urgent** (serveur `1edb12e3`, migration 0216 appliquée à 17 h 56 UTC avant le `up`, console
ensuite) : écrit par un implémenteur, relu à part (zéro rouge). Deux jaunes corrigés avant la production : le texte
que l'outil donne au modèle promettait « en tête de la liste de l'équipe », or un fil que l'agent tient encore est
`app_workflow`, que « À traiter » exclut (il n'apparaît que dans « Urgent ») ; et la console proposait « Marquer
urgent » sur une conversation « Traité », ce qui fabriquait l'état que la règle interdit. ⚠️ Le découpage serveur /
console a été typé et testé moitié par moitié dans une extraction de l'arbre serveur : un test de PARITÉ des types
d'événements lit `web/lib/inbox-detail.ts`, qui est donc parti avec le serveur. Mesuré : le tri « urgentes en tête »
ne s'appuie plus sur l'index récent, sans coût aujourd'hui (17 conversations au plus gros espace), noté dans
`todo.md`.

**RC3, changer d'espace** (serveur `f739de42`, déployé après le lot 4 du numéro fourni, sans migration ; console
ensuite) : deux routes montées avec `/me`, une bascule qui garde l'échéance du jeton présenté. Relu : zéro rouge. Le
test « l'observation ne bascule pas » ne prouvait rien de la route (la garde refuse avant elle) : un test qui monte la
route derrière une garde qui laisse passer l'emprunt, vérifié dans les deux sens. Laissé ouvert par décision de Julien :
une bascule vers un compte admin sans second facteur, cohérente avec la connexion Google (`todo.md`). Écrit dans
`documentation.md` : un jeton volé ouvre désormais tous les espaces de son adresse, jusqu'à son échéance.

**RC4, les outils de l'agent IA** (serveur `8ea06c8e`, déployé après le lot 4 B du numéro fourni, sans migration ;
console ensuite) : cibles fixes dans `binding`, « Lancer un scénario » terminal, écran façon MBA. Mesuré avant :
zéro outil à aligner en production ; après le déploiement, par le vrai code, les deux agents réels exposent les mêmes
outils qu'avant. Relu : zéro rouge, deux jaunes corrigés avant la production car ils envoyaient de vrais messages par
erreur : un lancement plus long que le délai de l'outil (8 s) laissait le modèle relancer (messages envoyés deux fois)
ou écrire par-dessus, il est désormais terminal ; et le lancement reprenait le fil à un opérateur qui l'avait pris
pendant le tour, il est passé en `sauf_operateur`. ⚠️ Incident de session, sans dégât : un `node -e` entre guillemets
doubles contenant des accents graves a fait exécuter trois fichiers du dépôt comme scripts shell ; vérifié (rien de
créé ni de tronqué, `.env` intact), la leçon est dans la mémoire du projet.

**RC5 A, la Condition à familles et les champs système** (serveur `344e8c4d`, sans migration ; console ensuite) :
jusqu'à dix familles nommées, la première vraie gagne ; un bloc sans familles se lit comme avant (le moteur neuf a
été comparé à l'ancien sur 98 640 graphes tirés au hasard, zéro écart). Mesuré avant : aucun bloc Condition en
production (131 blocs, onze types) ; après le déploiement, les 34 graphes réels passent le moteur neuf sans erreur.
Relu : zéro rouge ; une cible de langue vide retenait tous les contacts sans langue apprise, elle ne contraint plus
rien. Laissés documentés par décision de Julien : le dernier message reçu vaut « maintenant » quand un message lance
le scénario, et les départements d'outre-mer ont leur propre indicatif.

**RC5 B, le bloc « Aller à » et le bouton « copier le code »** (un seul commit, serveur et console, sans migration) :
saut dans le même scénario par le `walk`, vers un autre par un parcours démarré sur le bloc visé (types `aller_a` et
`aller_a_masse`, départ `saut` qui porte la preuve de fenêtre et le compteur de sauts, 20 au plus sans pause) ; la
publication refuse une cible absente et un saut après une attente longue vers un message de session. Relu : zéro
rouge ; un jaune corrigé avant la production, l'entrée d'un scénario (un bloc visé seulement par un « Aller à », créé
avant le vrai premier bloc, devenait l'entrée de la campagne), vérifié dans les deux sens côté serveur et console.
⚠️ Un seul commit et non deux : le test de parité des types de blocs lit la palette de la console, qui part donc avec
le serveur, et la CI ne tourne que sur `main`. La fenêtre où la console connaît « Aller à » avant l'API (un
enregistrement de scénario qui en contient un serait refusé) a été dite et réduite : déploiement de l'API dans la
foulée de la CI.

**RC6, qui répond au client** (serveur `035ebf83` et son correctif de test `5227d20c`, migration 0217 à 9 h 11 UTC
avant le `up` ; console ensuite) : quatre modes (MBA, agent IA, scénario, équipe), le MBA allumé n'est répondeur qu'en
mode MBA et sinon en veille, le bloc « Envoyer au MBA ». Mesuré avant : `tenant_settings` n'avait que deux lignes (un
agent IA, un MBA), et 7 espaces sans ligne passent en Équipe, dont 5 avec des conversations sur 30 jours : leurs
messages sans suite entrent désormais dans « À traiter ». Relu : zéro rouge ; trois jaunes corrigés avant la
production (le bloc vers un MBA éteint ne mettait pas la conversation dans « À traiter », une conversation de test y
entrait en mode Équipe, la colonne de `contacts` verrouillait la table plus longtemps que nécessaire), vérifiés dans
les deux sens. ⚠️ Le job `integration` de `035ebf83` était ROUGE sur deux assertions du test lui-même (un mode inconnu
posé avec un agent viole aussi le CHECK de l'agent, que Postgres signale en premier ; un scénario de test qui survivait
et polluait le test suivant) : corrigé dans `5227d20c`, aucun code de production touché, et la migration n'a été
appliquée qu'après la CI verte. ⚠️ Incident de session, sans dégât : une commande de vérification a lancé le test
d'intégration en local ; il s'est sauté tout seul (`DATABASE_URL` absent de l'environnement du shell, `vitest` ne
charge pas `.env`), et aucun espace `itest-` n'existe en production.

## 2026-10-06 : le numéro branché depuis Claude Code, et son abonnement (lot 3c, livraisons A et B)

**A, le lien et l'attente** (`d20dea6b`, jaunes `f8708b65`, console `b4f81ec4`) : `start_whatsapp_connection` donne
`console.messagingme.app/brancher#<jeton>`, un JWT `lien_numero` d'une heure que `verifySession` refuse ; la garde
`adminOuLien` ne l'accepte que sur les routes de la page (le test d'isolation appelle chaque route d'espace avec ce
jeton) ; `watch_whatsapp_connection` attend 25 s au plus, parce que le proxy de `api.messagingme.app` coupe une réponse
à 45 (`proxy_read_timeout 45s`, mesuré dans NPM). Relue : zéro rouge.

**B, l'abonnement** (`c9973f44`, migration 0214, console `7c1ede29`) : 3,50 € HT par mois, prix
`price_1UNUMXF67GfPqM0XcYpVkdhS` relu chez Stripe (taxe en sus, décision de Julien). La forme des factures pour la
version d'API `2025-11-17.clover` a été lue dans la documentation de Stripe avant d'écrire le webhook : l'abonnement est
sous `parent.subscription_details`, plus à la racine. Relue : un rouge, « Remplacer » attribuait un numéro sans
abonnement, corrigé avant le déploiement. Le compte Stripe sert aussi `verifiermondevis.fr` (un second webhook, ses
propres abonnements) : nos événements d'abonnement reçoivent ses factures, et le code ignore tout ce qui ne porte pas
`produit: numero`.

**Les jaunes de B** (serveur `e0f51c43` et `6050fdb7`, console `fbae4608`, tous en production le même jour) : le
portail de Stripe dans la console (`POST .../numero-fourni/portail`, à la session d'admin seule, le test d'isolation
refuse qu'il s'ouvre au lien), les numéros libres dus d'abord aux abonnés en attente, un numéro rendu qui les sert,
les deux fausses alertes du webhook, la course de « Remplacer » côté console (vue rouge par un e2e qui retarde la
lecture), le retour de Stripe. ⚠️ `e0f51c43` a rendu le job `integration` rouge : le test de 0214 affirmait l'ancien
retour d'`enregistrer` pour un abonnement résilié. Les tests d'intégration ne tournent qu'en CI ; changer ce que rend un
store, c'est chercher l'ancien littéral dans `tests/integration/` avant de pousser.

**L'essai réel commun A et B** (Julien, l'après-midi) : un numéro acheté chez DIDWW et déclaré dans /ops, un espace
neuf né de la connexion de Claude Code, un vrai paiement (l'abonnement et le numéro écrits dans la même transaction),
le code affiché dans le terminal, le numéro `CONNECTED` et `VERIFIED` chez Meta, puis une résiliation. Trois
constats : la résiliation du portail est programmée en fin de période et Stripe ne la signale que par
`customer.subscription.updated`, que nous n'écoutons pas, d'où un abonnement lu « actif » sans sa fin ; l'annulation
immédiate, elle, rend `resilie` et l'alerte ; et la fenêtre de Meta n'a pas laissé choisir la vérification : elle a
envoyé le code par SMS, qu'une ligne fixe britannique ne reçoit pas, et l'opérateur l'a lu à voix haute par un appel
(« You have a new message from WhatsApp… press 1 to replay »), le tiret du code prononcé « to » (« ### to ### ») : la
lecture prudente ne l'a pas retenu. Julien a redemandé le code, Meta a appelé, et cet appel a donné un code neuf.
Corrigé le même jour (Julien : « le mieux, ce serait d'écouter dès le premier ») : `extraireCodeOtp` lit les centaines
anglaises et recolle trois chiffres, « to », trois chiffres, juste après « code ». C'est la seule exception à la règle
des homophones, et elle ne peut pas fabriquer de faux code : un « two » dicté et mal lu ferait sept chiffres. Le test
part de la vraie transcription, chiffres remplacés, et les deux garde-fous (après « code », trois et trois) ont été
retirés tour à tour pour voir le test rougir. La clé restreinte de l'API ne lit pas
les abonnements chez Stripe (`subscription_read` absent) : voulu, rien n'en a besoin.

**Le ménage avant l'essai commun** : l'espace de l'essai du 3b a été supprimé à la demande de Julien, par un script relu
à blanc puis lancé par lui (une suppression définitive en production) et vérifié en base. Les clés étrangères vers
`tenants` étaient toutes en cascade sauf `numeros_fournis` (`set null`) : le numéro a été passé en `bloque` AVANT la
suppression, sinon il serait resté `attribue` sans espace. `credits_offerts`, sans clé étrangère, garde la trace du
crédit offert sur ce numéro. L'identité Google survit : une nouvelle connexion avec la même adresse crée un espace neuf.

**Appris** : Meta met un numéro libéré en quarantaine (Julien) : un numéro fourni ne revient jamais dans la réserve, et
le lot 4 devra résilier chez DIDWW. L'essai réel de A est reporté à celui de B, pour ne brûler qu'un numéro.

## 2026-10-06 : Engage Me redevient Messaging Me, vitrine sur `app.messagingme.fr`, console sur `console.messagingme.app`

**Le nom et le logo.** `4224fe36` renomme le produit partout où un client le lit : console, API (prompts de
l'aide, émetteur TOTP, titre du serveur MCP, badge et script inerte du widget, messages Salesforce), vitrine, doc
courante. Le motif est borné au mot (`engage ?me` attrapait « engagement ») et traite les élisions (« d'Engage Me »
devient « de Messaging Me »). L'icône est redessinée en SVG d'après le PNG de la marque (1 % d'écart mesuré) ;
`eeb2b803` pose le logo COMPLET en PNG (`LogoComplet`, `site/messagingme-logo-blanc.png`), Julien ayant refusé
l'icône suivie du nom composé dans la police de la console. Ce commit a rendu le job front rouge
(`nav-rangement.spec.ts` cherchait le nom en texte), réparé par `6bcefa3d`.

**Restent `engageme` à dessein** : le connecteur `EngageMe` chez Meta (le renommer forcerait chaque espace à
republier, décision de Julien), le namespace Salesforce `engagemeapp`, le projet Vercel `engageme-site`, les
archives datées et les migrations. Le tuto Salesforce dit déjà « Messaging Me », le package reste à renommer.
Les quatre films de la vitrine montrent encore l'ancien nom.

**Les domaines.** La vitrine passe sur `app.messagingme.fr` (CNAME OVH vers Vercel) ; `engageme.messagingme.fr`
y redirige par une règle d'hôte de `site/vercel.json`, et `VITRINE` suit. La console passe sur
`console.messagingme.app` (`07a2a7cd`, CNAME Cloudflare en « DNS only ») : Google Sign-In (client « MBA Web »)
et Meta Embedded Signup (app « Messaging Me MBA ») déclarent le nouveau nom, `APP_URL` le prend sur le VPS et
`CORS_ORIGINS` accepte les deux (copie d'avant : `.env.prod.avant-console-202610060822`), l'API et les deux
workers recréés, contrôlés de l'extérieur. `engageme.messagingme.app` redirige en 308 par Vercel.
`mba.messagingme.app` sert toujours l'ancienne console, inchangé.

## 2026-10-06 : le numéro fourni côté client (lot 3b), essai réel fait

Livraison A `a1bb1c63`, livraison B `790accb8` puis `cc884ae6` (serveur, migration 0212) et `477ab86c` (console, page
`/connecter-whatsapp`). Essai réel par Julien le jour même, mesuré en base et chez Meta en lecture seule :

- espace créé à 8 h 42 UTC par la connexion OAuth de Claude Code (Gmail neuf), `tenants.origine = 'claude_code'` ;
- « Fournissez-moi un numéro » à 8 h 49 : le seul numéro de la réserve (`+44 1235 619343`) passe `attribue` ;
- code de Meta capté par l'Asterisk à 8 h 53, APRÈS l'attribution, et affiché sur la page (le code reçu la veille
  pendant l'essai du 3a, plus ancien que l'attribution, n'a pas été montré) ;
- numéro relié à 8 h 54, `CONNECTED` et `VERIFIED` chez Meta, nom affiché en relecture ;
- crédit offert de **1 €** (et non 5 €) à 8 h 55, une ligne `offert` au journal du crédit ;
- verrou `numeros.reserve-vide` posé à 8 h 49 : il n'est gardé que si l'alerte Telegram est partie.

Première fenêtre de Meta ouverte depuis `console.messagingme.app`, le nom déclaré le matin même : elle s'est ouverte.
Ce que l'essai a appris : le client ne doit jamais passer par la console (Julien). Le lien signé qui ouvre la page
sans connexion rejoint le lot 3c, avec l'outil d'attente. La réserve est vide après l'essai.

## 2026-10-06 : `tool_name` NOT NULL (0213), et l'assistant ne propose plus un outil dont l'agent porte le nom

Lot 2 du plan `docs/superpowers/plans/2026-10-06-nom-unique-par-consommateur.md` (`3cb96ab7`) : la copie `tool_name`
devient NOT NULL, après un contrôle qui refuse en nommant un éventuel doublon ; l'offre porte `nomPris`, calculé par le
catalogue, et l'assistant de construction écarte une offre marquée (il branche APRÈS avoir écrit la fiche) ; les
fixtures nomment l'outil. Relu sans rouge. Vérifié dans les deux sens en CI sur étiquettes jetables : drapeau forcé à
`false`, seul le cas de l'offre tombe ; une insertion sans `tool_name`, la base refuse en 23502 sur cinq cas.

**Renumérotée en route.** Écrite sous 0212, que la session « numéro fourni » a poussée entre-temps : renommée 0213
avant tout push, le dossier tranchant sur ce qui est pris. ⚠️ Et un quasi-accident : après un rebase sur un
`origin/main` donné, un `git reset --soft origin/main` a pris un `origin/main` qu'une AUTRE session venait d'avancer
(les références distantes sont communes à tous les worktrees). L'index portait alors l'ancienne version d'un test du
pair, et le commit aurait défait son correctif. Vu au contrôle d'intrus sur `git diff --cached --name-status`, avant
tout commit ; la parade est de figer le SHA une fois et de ne plus jamais nommer `origin/main` dans la plomberie.

**Déployé le 2026-10-06** : 0213 appliquée à 8 h 01 UTC, APRÈS le `up` du lot 1 et AVANT celui de ce lot, après avoir
lu `pg_stat_activity` (aucune transaction de plus de 5 s, aucun verrou sur les deux tables) et vérifié dans l'image
qu'elle seule serait appliquée ; relue en base juste après (`tool_name` en `text` NOT NULL sans défaut, 14 liaisons
nommées et justes, aucun doublon). API, deux workers et `mba-web` recréés vers 8 h 03 UTC ; les deux portes publiques
et `mba.messagingme.app/logo.png` à 200, journaux propres. Le `up` a embarqué, avec l'accord de Julien, le rebranding
« Messaging Me » (`4224fe36`, relu, CI serveur verte, sans migration) et la console du lot 3b (`477ab86c`).

**Reste** : les deux essais d'écran, que Julien fait (le plan les décrit), et trois jaunes de conception au backlog.

## 2026-10-06 : un agent ne voit jamais deux outils du même nom (0211)

Relevé par la relecture du lot « Modifier un appel de connecteur » (2026-10-05) : une action (unique par agent) et
un appel de connecteur (unique par espace) pouvaient porter le même nom, parce que les deux index partiels de 0157 ne
se recoupent pas. Un agent qui utilisait les deux recevait deux fonctions homonymes.

**Mesuré avant d'écrire.** En production (lecture seule, 2026-10-05 à 21 h 18 UTC) : 26 outils, 14 liaisons, aucun
consommateur ne voyait deux outils du même nom, donc le défaut était latent. Sur le Gateway, avec le corps de
`chat-client.ts` envoyé depuis le conteneur `mba-api` (la clé ne quitte pas le serveur) : `zai/glm-4.7-flash` (servi
par bedrock), `anthropic/claude-haiku-4.5` et `google/gemini-2.5-flash` (servi par vertex) refusent deux fonctions
homonymes en 400 non rejouable, dans les deux ordres, quand le témoin à noms distincts rend 200. Aucun repli vers un
autre fournisseur : chaque tour de cet agent aurait fini en échec technique.

**Livré** (`2a6c2046`, ses jaunes textuels en `e37cc43d`) : 0211 recopie le nom sur la liaison (`tool_name`), tenu
par une clé étrangère composite en `on update cascade`, sous un index unique `(tenant_id, consommateur, tool_name)` ;
le catalogue écrit la copie et rend un 409. Le test d'intégration a été vérifié dans les deux sens sur étiquettes
jetables : le commit muté, sans l'index, rougit sur les sept cas de refus et eux seuls, avec le symptôme attendu
(aucun refus, un rattachement accepté, deux créations simultanées acceptées).

**Déployé le 2026-10-06** : 0211 appliquée à 7 h 05 UTC, AVANT le `up` de l'API et des deux workers, après avoir lu
`pg_stat_activity` (aucune transaction de plus de 5 s, aucun verrou sur les deux tables) et vérifié dans l'image
qu'elle seule serait appliquée ; relue en base juste après (colonne `text` nullable sans défaut, clé étrangère en
`confupdtype = 'c'` et MATCH SIMPLE, index unique valide, 14 liaisons toutes nommées et justes, aucun doublon). Les
deux portes publiques ont rendu 200 sans recharger NPM. Le déploiement a embarqué `8b1060ba` (entrée suivante), relu
et vert de son côté.

⚠️ **La leçon** : deux index partiels complémentaires tiennent l'unicité dans chacun de leurs régimes, pas chez celui
qui consomme les deux. Une unicité qui traverse deux tables se tient par une copie que maintient une clé étrangère
composite en cascade, et un index sur la table qui porte le consommateur ; jamais par une vérification lue puis
écrite.

**Reste** : le lot 2 du plan (reprise puis `not null` après le `up`, et l'assistant de construction qui ne doit plus
proposer un outil dont l'agent porte déjà le nom), et l'essai d'écran, que Julien fait lui-même.

## 2026-10-06 : la méthode d'une requête change, le risque de ses outils suit (vers le haut seulement)

Relevé par la relecture de `099fd6c1` : le risque d'un outil de connecteur se dérivait de la méthode de sa requête à
la CRÉATION de l'outil, puis plus jamais. Une requête passée de GET à DELETE gardait des outils `read` : en
production, l'exécuteur (étape 2) ne leur appliquait ni la garde d'autonomie des actions irréversibles, ni le refus
`lecture_seule` face à un contact inconnu. Le bac à sable, lui, relisait la méthode à chaque appel.

Mesuré d'abord en base de production, en lecture seule (client dédié, `begin read only` puis `rollback`, aucun SET de
session) : deux outils branchés sur une requête au total, un GET en `read` et un POST en `write`, aucun sous le
plancher de sa méthode, aucun dont la requête serait d'un autre espace. Le défaut était armé et n'avait jamais servi :
aucune reprise de données.

Correctif : `PgRequeteStore.patch` écrit la requête puis monte au plancher de la méthode écrite (`risqueSelonMethode`)
les outils branchés qui sont en dessous (`risquesSous`), dans la même transaction, après les avoir verrouillés par
identifiant (`verrouillerDefinitions`). Jamais redescendu : rien ne distingue un risque dérivé d'un risque monté par
le client à la création. Conséquence assumée au bac à sable : un outil dont la requête repasse en GET reste simulé.

Prouvé par la CI sur des étiquettes jetables, lue job par job. Le test seul
(`tests/integration/requete-methode-risque.integration.test.ts`, sans correctif) rend exactement cinq échecs, tous
dans ce fichier, chacun avec son symptôme (`read` au lieu de `irreversible` ou de `write`, `write` au lieu de
`irreversible`), les 1256 autres tests d'intégration passant. Le commit passe en entier (1261, dont les cinq). Un
correctif FAUX, qui ramène au plancher tous les outils de l'espace, fait tomber les trois gardes qu'il viole :
l'aller-retour GET, DELETE, GET redescendu à `read`, l'outil déjà irréversible ramené à `write`, et l'outil d'une
autre requête monté. `risquesSous` a aussi son test unitaire, vérifié dans les deux sens en local.

Relecture indépendante : aucun rouge. Appliqués avant de pousser : le verrouillage par identifiant (un `update` nu
prenait les définitions dans l'ordre physique et pouvait interbloquer avec `PgAgentStore.remove`, donc un 500), le
cas POST vers DELETE, et le test « ne redescend jamais » ancré sur un aller-retour qui part de `read`, pour ne pas
attendre l'état de départ.

Laissé au backlog (`todo.md`) : la ligne d'un connecteur n'offre pas la case d'autonomie, donc un connecteur
irréversible, né sur un DELETE ou monté par ce correctif, est refusé à chaque appel d'un agent IA ; les paramètres
d'un outil ne suivent pas non plus les variables de sa requête (même racine) ; et une fenêtre de l'ordre de la
milliseconde entre la lecture de la méthode à la création d'un outil et son insertion.

Déployé : `8b1060ba`, sans migration (seule l'API emprunte ce chemin, la route `PATCH` des requêtes), parti avec le
lot 0211 d'une session voisine, qui a mené le déploiement avec l'accord de Julien : VPS sur `e37cc43d`, API et deux
workers recréés vers 7 h 05 UTC, après l'application de 0211. Le code a été relu DANS le conteneur de l'API
(`risquesSous` présent), les deux portes publiques rendent 200, et aucune erreur dans les journaux depuis le `up`.
Aucune donnée n'a bougé au déploiement : le risque ne monte qu'au prochain changement de méthode d'une requête.

## 2026-10-05 : un champ imbriqué d'un connecteur atteint enfin le modèle, et le bac à sable appelle pour de vrai un connecteur qui lit

Lu dans le code avant d'être prouvé : `creerAppelConnecteur` filtrait la réponse d'un connecteur par les champs
cochés et rendait des clés À PLAT (`tarifs.integrale`), puis l'exécuteur refiltrait par les mêmes champs en
DESCENDANT dans l'objet, cherchait `contenu.tarifs` et jetait le champ. Mesuré en base de production, en lecture
seule : un seul outil au monde coche des champs, `obtenir_tarif` de Groupama PJ, dont trois imbriqués
(`tarifs.essentielle`, `tarifs.confort`, `tarifs.integrale`). Son seul appel réel, à 17 h 21 UTC, a rendu
288 octets au modèle : les quatre champs du premier niveau, aucun tarif. Le même refiltre vidait en `{}`
l'enveloppe d'échec de tout outil qui intègre (le modèle ne savait pas que le système du client n'avait pas
répondu), et celle du bac à sable : c'est le `contenu: {}` constaté le matin même avec `test_agent`, note « Test
hors ligne » et marque « simulé » comprises.

Pourquoi aucun test ne l'a vu : ceux du résolveur l'interrogeaient seul, et les deux tests de l'exécuteur qui
« prouvaient » son filtre lui faisaient rendre, par un faux résolveur, une réponse BRUTE que le vrai ne rend
jamais. Le test qui l'attrape fait traverser la sortie réelle du résolveur dans l'exécuteur
(`tests/agent-resolveur-http-nature.test.ts`). Correctif : l'étape 7 ne fait plus que borner. Vérifié dans les
deux sens : l'exécuteur d'origine remis, huit tests tombent, chacun avec son symptôme.

Décision de Julien, posée en une question : au bac à sable, un connecteur en lecture part pour de vrai
(`connecteurEssai`), par le résolveur de production ; le reste est simulé. La relecture indépendante (aucun rouge)
a précisé ce que « lire » veut dire, et ses jaunes sont partis avec le lot : un GET qui POUSSE reste simulé (un
webhook appelé en GET aurait créé un faux lead depuis un essai), comme un GET qui a besoin du contact (`wa_id` y
vaudrait `bac-a-sable`) ; la note simulée nomme l'appel par son libellé et plus par son chemin, qui part chez le
fournisseur du modèle et porte parfois le jeton d'un webhook ; un essai n'écrit plus l'épreuve de la source ; et
`test_agent` passe en monde ouvert. La note disait aussi « l'appel ? ? » pour tout connecteur : le `binding` d'un
connecteur est vide (mesuré, deux outils HTTP sur deux). Neuf mutations au total, chacune attrapée par son test.

Déployé : `099fd6c1`. Sa CI de `main` a été annulée par le push suivant d'un pair (`cancel-in-progress`) : le
verdict a été lu sur le commit EXACT, rejoué sur une étiquette jetable, job par job (unit, intégration, sécurité,
puis le front). `merge --ff-only` sur le VPS, `up` de l'API, du worker principal et de l'ancienne console à 18 h 50
UTC, puis du worker d'analyse après « démarré » ; le changement relu DANS chaque conteneur, les fiches d'aide
rechargées, la santé à 200 en interne et sur les trois portes publiques, aucune erreur dans les journaux. Le
déploiement a emporté `e34d8433` (les jaunes de la mention d'IA), relu comme intervalle, avec le feu vert de son
auteur.

Essai réel dans la foulée, par `test_agent` sur « Groupama santé animale » : « un devis pour mon chien, un
labrador de 3 ans ». `obtenir_tarif` est parti pour de vrai (`{espece: chien, race: labrador, age_mois: 36}`), a
rendu ses sept champs, dont les trois `tarifs.*` (15,65 €, 26,15 €, 41,90 €), et l'agent a donné les trois
formules. Coût de l'essai : 0,01 €.

⚠️ Laissé à une tâche à part, relevé par la même relecture et antérieur au lot : changer la MÉTHODE d'une requête
ne recalcule pas le risque des outils branchés dessus (un GET passé en DELETE garde `read`).

## 2026-10-05 : la mention d'IA posée par le code, et le Markdown ramené à WhatsApp

La mesure de Julien (`test_agent`, agent « Groupama santé animale » sur Claude Haiku 4.5, cinq conversations neuves
d'un message) : la phrase d'annonce n'est partie que dans la réponse sans appel d'outil. La consigne la demandait au
modèle ; dès qu'il cherchait dans sa base, il répondait sans elle. Julien a choisi le préfixe dans le même message
plutôt qu'une bulle à part. `penserTrace` n'a plus qu'une sortie pour le texte (`pourLeContact`) : Markdown converti,
puis la phrase devant quand elle est due, et la consigne dit seulement que la plateforme l'ajoute.

La relecture indépendante a trouvé un rouge que nos tests ne voyaient pas : la détection « déjà là » cherchait une
sous-chaîne, et prenait « IA » dans « spécialiste » pour l'annonce. Corrigé en tête et en mots entiers
(`commencePar`). Elle a aussi trouvé un trou plus ancien : `dejaParle` comptait tout sortant en rôle `agent`, donc un
bloc envoyé par `mba_envoyer_bloc` taisait l'annonce pour toute la session. Remplacé par `dejaAnnonce`, qui exige un
message commençant par la phrase. Déployé en `6d6e47dc` (API et deux workers, sans migration) : fumée publique verte,
fiches OAuth conformes.

L'essai réel, juste après, a rejoué la même mesure : cinq conversations neuves, cinq réponses ouvertes par la phrase,
dont les trois qui avaient d'abord appelé `mba_chercher_connaissance`, et le gras à une étoile. Une recherche y a
expiré (cinq essais lancés en parallèle), sans rapport avec le lot. Les jaunes de la relecture (`e34d8433`) sont
poussés, à déployer avec le prochain lot relu : le texte borné à 4 096 caractères (la phrase entière, la réponse
coupée), l'essai borné pareil, les liens Markdown réécrits, les sauts de ligne visibles dans le Tester.

⚠️ Le worktree de la session était extrait en CRLF sur un millier de fichiers. Un test qui lit un fichier texte y
échoue (`migration-directives`), et un fichier édité garde ses CRLF, si bien que le diff le montre modifié en entier :
le repasser en LF avant de commiter.

## 2026-10-05 : le pont du code éprouvé par un vrai appel, et l'Asterisk fermé à tout ce qui n'est pas DIDWW

Julien appelle `+44 1235 619343` depuis son portable et dicte un code. À 17 h 09, l'appel arrive sur l'Asterisk par
le trunk que le serveur a branché lors de la déclaration dans /ops ; huit secondes d'enregistrement, puis l'extension
`h` lance le script. À 17 h 10 min 01 s, deux secondes après le raccroché, l'API a transcrit « Here is the code
345679, 345679. », écrit 345679, et le fichier son est effacé. Julien voit le code dans /ops : le lot 3a est clos.
Le vrai appel de Meta sur ce numéro n'a pas été fait : la voix de Meta était prouvée le matin même, et le portefeuille
de test était plein (deux numéros, la limite d'un portefeuille non vérifié). Il viendra avec le parcours du lot 3b.

Ce que l'appel a montré en plus. Un inconnu (`179.43.134.194`) envoyait des INVITE au 5080 toutes les quatre minutes,
tous rejetés par `identify_by = ip` (« No matching endpoint found »). La session RSSI relève ensuite l'IAX2, chargé
par défaut, qui ouvrait 4569/udp : `modules.conf` monté sans lui (`cb41a7f5`). Puis le pare-feu (`5a9b5812`) : des
règles ciblées sur le 5080 et la plage RTP, aux plages MESURÉES pendant l'appel (SIP de `185.238.173.49`, son de
`46.19.210.39`, et les deux adresses de `sip.didww.com` dans les mêmes plages). Julien l'a posé, avec la ligne
`@reboot` : le garde-fou m'a refusé de poser une persistance système, qui revient à l'humain.

## 2026-10-05 : le pont du code en production (lot 3a), et sa signature prouvée sans attendre Meta

`2ecd261b` déployé : CI verte job par job, 0210 appliquée à 16 h 49 UTC avant le `up` de l'API et des deux workers,
relue en base. Puis l'Asterisk du VPS mis au montage du dépôt, avec le correctif du rouge de la relecture appliqué aussi
à sa configuration privée (`identify_by = ip` dans `pjsip.conf`, qui n'est pas versionné), relu par
`pjsip show endpoint didww`.

Deux mesures à garder. **La signature se prouve avant le premier appel** : le vrai script, lancé depuis le conteneur
sur un faux fichier et un numéro hors réserve, a reçu 404. La route ne répond « hors réserve » qu'après avoir accepté
la signature, donc le secret monté, l'adresse et le format sont justes, sans rien écrire et sans attendre que Meta
appelle. **`command -v a b` sous `sh` (dash) ne regarde que `a`** : le contrôle des prérequis du README annonçait
`openssl` absent alors qu'il est là. Corrigé en un `command -v` par commande.

## 2026-10-05 : l'essai réel du répondeur, trois défauts, et ce que la mesure a corrigé de mes correctifs

Sur l'espace « Messaging Me Tech SANDBOX », Julien désigne Gan PrevMCP depuis la console (15 h 29) et écrit depuis son
téléphone. Rien ne répond. Deux causes, lues en base : un scénario de test de la veille attendait encore sa réponse
(priorité aux scénarios, voulu), et la conversation restait marquée `mba` (rendue par le délai de reprise à 14 h 42).
L'agent de Meta étant éteint, plus personne ne la tenait : le parcours gelait, la remise refusait l'agent IA. Après
deux écritures sur cette seule conversation (accord de Julien, collées par lui, l'écriture en production m'étant
refusée par le garde-fou), le répondeur démarre et répond en contexte.

La demande d'un conseiller : l'agent répond « un conseiller va prendre le relais » et sort par sa règle d'arrêt
`transfert_humain`, qui mène à une fin muette dans le répondeur. Règle retirée de la fiche : l'escalade passe, la
conversation arrive dans « À traiter », mais le contact ne reçoit rien, parce que le tour JETTE la phrase de
l'escalade quand l'équipe est joignable (dans un scénario, la branche `humain` parle à sa place). Le retour de
l'équipe fonctionne une fois qu'un humain a vraiment répondu (sans réponse, l'agent relit la demande d'humain dans sa
mémoire et repasse la main, ce que Julien a gardé tel quel). Une réaction ne déclenche rien.

Les mesures (Gateway, même conversation rejouée, clé maison, rien écrit) ont corrigé deux fois mes correctifs. Sur
Gemini 2.5 Flash, 31 escalades sur 31 portaient leur phrase : j'ai retiré le `message` imposé que je venais d'ajouter.
Sur les autres modèles proposés, Mistral Small escaladait sans un mot 10 fois sur 10 et Claude Sonnet 4.5 9 sur 10 : je
l'ai remis. La phrase de consigne qui devait empêcher la sortie par une règle de transfert, elle, faisait inventer des
noms d'outil à Flash Lite (7 sur 20 avec les deux changements) pour un défaut rare (1 sur 48) : abandonnée. Et la même
entrée, rejouée sur le même modèle, a donné 0 sur 8 puis 6 sur 10 « sans appel d'outil » : une passe ne prouve rien,
seules les passes alternées avec la référence comparent.

## 2026-10-05 : les quotas quotidiens de l'API publique

Le dernier trou de l'audit du 2026-10-02 sur l'API publique : le plafond d'appels (0181) protège l'infrastructure,
pas les destinataires. Sous lui, une boucle chez un intégrateur pouvait viser 50 000 destinataires par heure. Valeurs
décidées par Julien le 2026-10-04 (`ARCHITECTURE-CIBLE.md` § 13.1).

- **Deux familles, par espace et par jour civil de Paris** : 2 000 envois (destinataires de `/v1/sends`, messages
  libres WhatsApp et RCS) et 20 000 fiches écrites (`/v1/contacts`, une par une ou par lot). Lectures, catalogues, MCP
  et campagnes de la console n'y entrent pas. Réglables par espace (migration 0208, la même route
  `/ops/plafond-api`) ; 0 dans la configuration désactive le défaut sans déployer.
- **Mesuré avant de fixer** : au plus 4 destinataires par jour sur `/v1/sends` et 2 messages libres par jour au plus ;
  aucun espace ne porte de plafond d'appels propre. Personne n'est bloqué par ces valeurs.
- **Le compteur partagé gagne une origine de fenêtre.** `compteurs_debit` découpait le temps en fenêtres alignées
  sur l'époque Unix : un « jour » y finissait à 1 h ou 2 h du matin à Paris. `origineMs` (minuit de Paris) et la date
  dans la clé : un jour de 23 ou 25 heures, au changement d'heure, reste un jour.
- **Compté dans la même opération atomique que l'usage de la minute** : refusé, l'appel n'est compté nulle part, et
  un lot qui dépasserait le quota est refusé en entier (`429 quota_exceeded`, `retry-after` jusqu'à minuit de Paris).
- **Relecture : aucun rouge.** Les jaunes traités avant de pousser. Un réglage illisible (base en panne, cache vide)
  retombait au défaut : un espace relevé à 50 000 envois aurait été bloqué à 2 000 pendant la panne. Le cache rend
  désormais un réglage INCONNU, et le quota laisse passer, comme sur un compteur muet. Les en-têtes `x-ratelimit-*`
  de la minute contredisaient le refus du jour : retirés de ce refus. Une alerte Telegram à la première butée d'un
  espace dans la journée. `lock_timeout` de 5 s sur 0208, `tenant_settings` étant sur le chemin chaud.
- **Restent** (`todo.md`) : compter un envoi après le `claim` d'idempotence (un rejeu consomme aujourd'hui), le 429
  de bout en bout sur `/v1/sends` et `/v1/messages/*`, la consommation du jour dans `/ops`.
- **En production en `fb070954`** : CI verte job par job (unit, intégration, sécurité, console). 0208 appliquée à 8 h 56 UTC
  AVANT le `up`, après `pg_stat_activity` (aucune transaction de plus de 5 s, aucun verrou sur `tenant_settings`) et la
  liste des migrations de l'image ; relue en base (deux `integer` nullables sans défaut, les deux CHECK sous leur nom,
  aucun espace avec un quota propre). `mba-api` seul relancé : les workers utilisent le compteur partagé, mais la requête
  modifiée leur rend le même résultat (origine 0). Les deux portes publiques à 200 du premier coup.
- **Essai réel** dans un conteneur de l'image déployée, le vrai garde sur le vrai compteur, un espace FICTIF à 2 envois et
  5 fiches : deux envois acceptés, le troisième refusé avec une attente de 46 989 s, exactement jusqu'à minuit de Paris
  calculé à part ; un lot de 6 fiches refusé en entier, un lot de 5 accepté, la fiche suivante refusée ; une alerte par
  famille ; en base, la fenêtre du quota part de 22 h UTC la veille et expire à 22 h UTC, et les refus ne sont comptés que
  dans `refusees`. Les huit lignes de l'essai effacées ensuite. La page de référence publique affiche les quotas.
- **Deux e2e instables sous charge, sans lien** : `workflow-sorties-multiples.spec.ts:148` (deux échecs sur quatre passages,
  8 sur 8 seul) et `agents-connaissance.spec.ts:127` (un sur quatre) ; aucun de ces écrans n'importe un module du lot.

## 2026-10-04 : l'observabilité qui manquait à l'audit (alerte des workers, tâches de fond, stockage)

Les deux critères de sortie de l'audit du 2026-10-02 que rien ne tenait : « chaque rôle a son heartbeat ET son
alerte », et « le stockage RCS ne grossit plus sans métrique ». Décidé par Julien le même jour.

- **Ce qu'on croyait couvert ne l'était pas.** Le worker affirmait qu'un worker mort était « couvert par l'âge du
  heartbeat, lu par /ops et le cron watcher (qui déduplique) ». Vérifié : aucun surveillant ne lisait le battement.
  La sonde `vps-watch` (messagingme-pilot) ne voit qu'un conteneur ARRÊTÉ, toutes les quinze minutes, et seulement
  sur le VPS ; les workers n'ont pas de contrôle de santé Docker. Un worker figé ou en boucle n'était vu de personne.
- **La surveillance vit dans l'API**, seul processus indépendant des workers, et portable vers Scaleway. Silence
  (180 s) ou boucle (5 démarrages en 15 min). La relecture a trouvé le second signe manquant : un worker qui plante
  APRÈS son premier battement le rafraîchit à chaque redémarrage, donc le silence n'arrive jamais.
- **La clé d'alerte porte l'épisode** (`alerte-worker:<rôle>:<dernier battement>`) : la première version relâchait
  le verrou au retour, depuis la mémoire de la copie qui avait alerté, et une API redémarrée pendant la panne aurait
  laissé un second silence sans alerte pendant une heure (relevé par la relecture).
- **Les tâches de fond sont mesurées par le registre**, pas une à une : durée, lignes rendues, échecs, tours sautés.
  La relecture a trouvé que la tâche que vise le seuil de l'audit (les statistiques d'analyse) n'aurait presque jamais
  été vue : sa passe utile est celle du démarrage, hors registre, et la périodique tombe six heures plus tard. Elle
  est mesurée à la main.
- **Mesuré en production avant d'écrire la carte du stockage** : base entière de 45 Mo, dont 10 Mo pour 28 images RCS
  (la plus grosse table, 22 % de la base), rien pour les brouillons de pub, 0,2 Mo pour les Flows. La mesure coûte une
  demi-seconde (le catalogue entier) : sa propre route, jamais avec la vue d'ensemble.
- Les six passages « deux copies au plus » d'`ARCHITECTURE-CIBLE.md` corrigés (l'audit en comptait quatre).
- **`origin/main` a bougé pendant la construction du commit en plomberie** (`8f2a8569`, le lot d'un pair) : l'index
  temporaire était parti de l'état d'avant, et le diff contre `origin/main` montrait six fichiers de trop. Commiter
  là-dessus aurait DÉFAIT le commit du pair. Parade : figer le SHA d'`origin` une fois (`rev-parse`), faire partir
  `read-tree`, la fusion du journal et `commit-tree -p` de ce SHA, et vérifier que le diff contre lui contient
  exactement ses propres fichiers avant de pousser. Typecheck de l'arbre fusionné réel, aussi, avant le push.
- **En production en `e6711818`** (avec `8f2a8569` dessous, d'accord avec son auteur) : 0207 appliquée à 16 h 50 UTC
  avant le `up` et relue en base ; principal, analyse, puis API. Dès la première minute, les deux workers écrivent
  leurs mesures : les statistiques d'analyse du démarrage (262 ms, 10 lignes), la rétention générale (137 lignes), et
  une découverte, le suivi du statut des numéros à 10 s.
- **Essai réel** : `mba-worker-analyse` arrêté à 16 h 53 min 20 s (dernier battement 16 h 53 min 08 s), alerte à
  16 h 56 min 37 s, worker relancé à 16 h 57, retour annoncé à 16 h 57 min 40 s avec « redémarré 16:56 UTC ». Les deux
  messages acceptés par Telegram, prouvé par leurs verrous tenus en base (un envoi refusé relâche le sien).

## 2026-10-04 : le bail anti-double-envoi de l'exécuteur, requis (piste 8 de l'audit)

Fait en direct, puis relu (décision de Julien : seulement les trois fonctions du bail, pas de déploiement dédié).
`reserverAvance`, `prolongerAvance` et `libererAvance` étaient optionnelles « pour les fixtures » : un câblage qui
les oubliait compilait et l'avance d'un parcours partait sans réservation. Elles sont requises ; les fixtures
reçoivent un bail inerte par `avecGardesDEtatInertes`, et `tests/workflow-bail-requis.test.ts` fait échouer le
typecheck si l'UNE redevient optionnelle (une directive `@ts-expect-error` par fonction, vérifiée une à une dans les
deux sens). Aucun changement en production : `PgWorkflowRunStore` les portait toutes.

**Relecture : 0 rouge, 4 jaunes, corrigés avant de pousser** (rien ne se déployait). Le plus utile : un test intitulé
« un store SANS réservation garde le comportement d'avant » était resté vert alors que son sens avait changé (le
jeton inerte arrivait à une écriture gardée qui le refusait, le parcours n'avançait plus, et le test n'assurait que
les envois) ; il est retiré, le cas étant devenu impossible au typecheck. Plus deux restes du battement optionnel
dans `advance`, un nom de classe faux dans la doc, et des commentaires.

## 2026-10-04 : un seul geste pour poser une étiquette (piste 6 de l'audit)

**Cadrage.** Deux rondes de questions fermées, décisions de Julien : cinq portes passent par le module (l'agent, le bloc
de scénario, le widget, l'outil MCP `tag_conversation` ET la fiche contact de la console) ; l'outil MCP pose et
ajoute à la liste de l'espace, sans déclencher d'automatisme ; production avant la démo du 7 ; un défaut se corrige
sur place.

**Livré, `93e321b5`.**
- `src/crm/poser-etiquette.ts` remplace `src/agent/poser-tag.ts` : nettoyage commun, pose, déclaration au mieux dans
  le référentiel, publication `tag_added` seulement si l'appelant la demande (option requise, aucun défaut).
- Changements voulus : l'outil MCP coupe à 64 caractères (borne annoncée dans son schéma) et déclare ; la fiche
  déclare ses étiquettes. Tout le reste à l'identique, publication comprise (agent oui, scénario selon la politique
  du lancement, fiche oui sur les nouvelles, widget et MCP non).
- Les chemins de masse (import, API publique, action en masse) importent le nettoyage, sans changement.
- Mutations vérifiées dans les deux sens (MCP qui publierait, fiche qui ne déclarerait pas, campagne qui publierait,
  MCP sans la borne) ; une table par type de lancement lit la vraie file et prouve qu'une campagne ne publie rien.
- **Relecture : 0 rouge, 7 jaunes.** Corrigés juste après : la fiche ne déclare plus une étiquette ajoutée puis
  retirée dans le même envoi (le faux d'`applyEdits` rend désormais l'état final, comme le dépôt), et les deux
  bornes recopiées en dur prennent la constante. Au backlog : la création d'un contact à la main ne déclare pas,
  une déclaration coûte deux requêtes, la borne compte en unités UTF-16, deux tests lisent un champ privé.

**Déploiement.** API puis deux workers, à 14 h 15 UTC, avec le lot des clés d'API d'une session voisine (`92652e5c`,
déjà en production sur l'API).

**Essai réel, le 4 vers 16 h 35 (Paris), relu en base.**
- Claude, par le connecteur : `essai-claude` sur la fiche et dans le référentiel, AUCUNE publication.
- La fiche contact : `essai-fiche` sur la fiche et dans le référentiel, une publication `tag_added`.
- Un scénario lancé depuis l'Inbox : `essai-scenario` posé et publié (lancement unitaire) ; il était déjà au
  référentiel, déclaré à l'enregistrement du scénario.

## 2026-10-04 : au plus dix clés d'API actives par espace (point 3 de l'audit)

Décidé par Julien à dix (l'audit du 2026-10-02 proposait cinq). La onzième création est refusée en 409 avec un
message qui dit de révoquer une clé ; la console grise le bouton et le dit avant. Ne comptent pas : les clés
révoquées, et la clé du relais de l'agent de Meta (posée par la publication, sinon publier un agent prendrait la
place d'une clé du client, ou serait refusé par elle). Les clés déjà au-delà ne sont pas révoquées.

- **Mesuré en production avant d'écrire** (lecture seule) : un seul espace a des clés, 2 actives créées depuis la
  console, 1 du relais, 6 révoquées. La borne ne gêne personne aujourd'hui.
- **La raison n'est PAS le débit**, et le commentaire écrit d'abord le prétendait : « sans plafond, un espace
  multiplie son débit en multipliant les clés » était vrai le 2026-09-14 et faux depuis le 2026-09-25, quand le
  plafond de l'API est devenu commun à toutes les clés d'un espace. Relevé en relisant `features.md` avant de
  commiter, corrigé : la borne limite l'exposition (moins de secrets oubliés), comme le disait l'audit.
- **Le compte et l'insertion sont atomiques** (`PgApiKeyStore.creerSousPlafond`, verrou consultatif
  `api_keys:<espace>`, préfixé pour ne pas sérialiser avec les bascules HubSpot verrouillées sur l'identifiant nu).
  Prouvé dans les deux sens sur un Postgres jetable du VPS (accord de Julien) : verrou retiré, douze créations
  simultanées passent TOUTES et le test du verrou tombe ; relais compté, la dixième clé du client est refusée.
  Version correcte : vert trois fois de suite, avec le test d'intégration du relais.
- **La route n'a plus accès à la création sans plafond** : `ClesApiDep` porte `creerSousPlafond` à la place de
  `create`, qui reste réservé à la clé du relais. Le compilateur a trouvé une fixture que le grep avait manquée
  (`tests/audit-acces.test.ts`).
- **Relu par un relecteur indépendant, aucun rouge.** Ses jaunes, réglés dans le même lot avant le premier push :
  le message dit que la clé « Agent de Meta » ne compte pas (l'en-tête de la liste, lui, la compte, et lisait
  « 11 actives » à côté de « 10 au maximum ») ; le droit du relais, recopié en dur dans la console dont la règle
  d'exclusion dépend désormais, passe sous un test de parité ; deux commentaires précisés ; et l'e2e de l'écran
  (`web/e2e/cles-api-plafond.spec.ts` : bouton grisé à dix, actif à neuf plus le relais, 409 affiché tel quel).
- **En production en `92652e5c`** : CI verte job par job, `mba-api` SEUL recréé à 13 h 38 UTC (sans migration ; entre
  la production et `main`, seuls les deux fichiers serveur du lot changeaient), les workers intacts, fumée verte.
- **Essai réel sans écriture** : dans le conteneur, le vrai `creerSousPlafond` sur le seul espace qui a des clés,
  plafonné à ses 2 clés actives, rend `null` en 46 ms à travers le pooler, et le nombre de lignes ne bouge pas (9
  avant, 9 après). Créer de vraies clés aurait laissé des lignes visibles dans la liste du client ; ce qui distingue
  la clé du relais est prouvé par le test d'intégration.

## 2026-10-04 : un point d'entrée par type de lancement de scénario (piste 4 de l'audit)

**Cadrage.** Deux rondes de questions fermées, décisions de Julien : les sept lancements (le rapport en comptait cinq,
l'agent de Meta et la campagne en ont chacun deux), réglages de l'exécuteur fermés, comportement IDENTIQUE, une table
à la place des lectures de texte, production avant la démo du 7, un défaut en production se corrige sur place.

**Livré, `b6e674ac`.**
- `src/workflow/lancements.ts` : un type fermé (neuf valeurs), une table `POLITIQUE_DE_LANCEMENT` (reprise du fil,
  publication des étiquettes, graphe joué, garde de fenêtre), une entrée `lancer` dont la demande est typée par type.
- L'exécuteur n'a plus que `demarrer(type, ...)` : `start`, `startInWindow`, `startFromNode` et leurs réglages bruts
  ont disparu. Le runner d'automations construit la demande entière, type compris (`typeDeLancementDe`).
- `tests/workflow-lancements.test.ts` exécute la table sur le vrai module, le vrai exécuteur et le vrai contrôle du
  fil ; les tests qui lisaient le texte des câblages sont retirés, leurs cas repris. Quatre mutations vérifiées dans
  les deux sens (mot-clé qui prendrait le fil, publicité qui le prendrait à un opérateur, campagne qui publierait,
  lien de test qui jouerait le publié).
- **Relecture : 0 rouge, 4 jaunes.** Le plus utile : en retirant les lectures de texte, plus rien ne voyait un
  câblage d'automation qui forcerait le type (`{ ...demande, type: 'automatisme_chaine' }` compilait et laissait tout
  vert) ; une garde le relit de nouveau, vérifiée par cette mutation. Les autres : deux passages de doc devenus faux,
  et un écart ancien mis au backlog (une automation qui démarre à un bloc ne vérifie pas la fenêtre).

**Déploiement en deux temps.** L'API seule d'abord, puis les deux workers à 12 h 31 UTC, une fois que Julien a donné
son accord : leur image emportait aussi les jaunes de supervision pg-boss d'une session voisine (`59ec71e2`), qui
attendaient ce feu vert. La session voisine a relu ensuite en base le moniteur et le battement des dix files.

**Essai réel, le 4 entre 14 h 42 et 14 h 45 (Paris), sur la conversation de Julien, relu en base.**
- Inbox : parcours créé et relié à la fiche, graphe non figé, reprise du fil tracée (`prise_mba`).
- Lien de test : parcours au graphe FIGÉ (le brouillon), conversation non marquée.
- Mot-clé « Choucroute » : tir de l'automation, puis parcours, graphe non figé.
- Campagne vers un seul numéro : destinataire `sent`, modèle parti, parcours en attente de réponse ; le parcours
  précédent a été clos par ce démarrage, comme avant.

## 2026-10-04 : les outils MCP de l'agent IA et du crédit (lot 8a), livraisons A et B

**Livraison A en production en `00863361`** (migration 0206 appliquée avant le `up`, API et workers) : la logique de
l'agent, de sa connaissance, du bac à sable, du paiement et des réglages sortie des routes vers des fonctions
communes (`src/agent/gestion.ts`, `connaissance.ts`, `essai.ts`, `reglages.ts`, `src/stripe/paiement.ts`). Deux
changements voulus : modifier un agent actif refuse les manques que la modification INTRODUIT (la règle littérale
aurait bloqué toute retouche d'un agent dont la connaissance a été vidée après coup), et chaque modification de la
fiche laisse une ligne `fiche_agent`, réduite aux champs qui ont changé (la console renvoie toujours la fiche
entière). Vérifiée par un commit faussé : 0206 sans `mcp` fait échouer exactement les deux tests visés.

**Livraison B en production en `5b6f4a1f`** (`mba-api` seul) : les seize outils, le drapeau `exigePersonne` (les
outils de configuration et d'argent n'existent pas pour une clé d'API), le plafond coûteux de la console partagé
par le serveur MCP. L'implémenteur a été coupé par une panne réseau après l'essentiel du travail : un second l'a
repris sans repartir de zéro, puis la relecture. Le jaune le plus utile de cette relecture : notre propre refus
(« désactivez l'agent avant de le remanier ») pouvait pousser Claude à couper un agent en production ; les
descriptions disent désormais que désactiver coupe l'agent dans ses scénarios et ne se fait que sur demande.

## 2026-10-05 : le répondeur par défaut, livraison B (la console) en production

`8e907531`, API et deux workers relancés, aucune migration. Le bloc « Répondeur de l'espace » sur la page des agents,
les libellés « le répondeur automatique » des campagnes, du widget et des publicités, et le correctif des réactions : un
pouce du contact ne démarre plus le répondeur et ne réveille plus un agent en cours. La relecture a trouvé que ce
correctif lui-même effaçait l'échéance d'inactivité du bloc agent (une réaction écrivait l'état sans `resume_at`, et
aucun tour ne la reposait) : corrigé avant le commit en ne rien écrivant du tout, avec son test. La leçon tient en une
phrase : une branche qui sort d'un chemin AVANT le tour qui répare l'état ne doit pas écrire cet état.

## 2026-10-05 : le répondeur par défaut, livraison A (le serveur) en production

Un agent IA désigné par l'espace répond à tout message que personne ne tient, comme l'agent de Meta (`1f28aee7`,
migration 0209 appliquée à 10 h 41 UTC avant le `up`). Un implémenteur, une relecture sans rouge (douze jaunes), puis
quatorze mutations des tests d'intégration jouées en CI sur deux commits jetables : chaque test visé tombe.

Ce que le plan ne voyait pas et que l'implémenteur a ajouté, chaque fois sur un cas mesurable : le message déclencheur
naît reçu dans le parcours (sinon une redélivrance de Meta lançait un second tour) ; la réponse « à côté » d'une campagne
va au répondeur IA (sans agent de Meta, personne n'y répondait) ; un `standby` arrivé après la bascule est requalifié
(sinon perdu) ; l'annonce d'IA ne compte que la session (la mémoire de 30 jours la faisait taire).

Deux faits mesurés ont simplifié le plan : aucune session d'agent IA n'avait jamais existé en production, donc tous les
agents lisent la même mémoire ; et avec l'agent de Meta éteint, trois des quatre gestes du fil faisaient déjà ce qu'il
fallait. La migration a dû être renumérotée au commit (0208 prise entre-temps par les quotas de l'API) : le dossier
tranche sur ce qui est pris, et la ligne du compteur s'écrit dans le commit qui prend le numéro.

## 2026-10-04 : une sortie d'agent part avec son dernier message, et GPT-5 mini quitte la liste

Le défaut trouvé par l'essai du lot 8a (sous GPT-5 mini, l'agent appelait l'outil qui termine sans écrire, et le contact
ne recevait rien) est corrigé en `2674276b` : `terminer` porte un paramètre `message` imposé par le catalogue, jamais
stocké (les outils déjà posés gardent leur copie de paramètres en base), annoncé requis et toléré absent, lu par
l'exposition ET par la validation (sans la seconde, Zod l'aurait retiré en silence). Un implémenteur, une relecture sans
rouge, quatorze mutations.

Le premier essai réel a montré que ça ne suffisait pas : 2 sorties sur 3 avec leur message, mais le lead qualifié parti
avec un message VIDE, parce que la description disait « sinon vide ». Reformulée (« toujours rempli », `866aae5c`), puis
3 sur 3. La leçon : une description d'outil est une consigne, et un modèle de raisonnement prend au mot l'exception
qu'on lui offre. Puis GPT-5 mini a quitté la liste (`1351821d`) : 2,5 fois le coût de Gemini 2.5 Flash à l'essai, sa
réflexion invisible étant facturée, et le moins bon à comprendre l'implicite. Aucun agent ne l'utilisait.

## 2026-10-04 : l'essai réel du lot 8a, un agent IA monté de bout en bout depuis Claude Code

Julien a demandé à Claude, dans une session neuve connectée par OAuth, de créer un agent de qualification pour Gan
Prévoyance. Claude a posé ses questions une par une, créé « Gan PrevMCP », lu puis importé le site (150 fiches sur
22 pages), réglé sa fiche et ses quatre outils, l'a essayé douze fois, puis l'a activé sur l'accord de Julien. Tout
relu en base juste après, en lecture seule : historique d'origine `mcp` avec l'auteur, outils signés par l'admin,
provenance des fiches, et un débit par essai égal à son coût (2,9 centimes au total).

L'essai a trouvé un défaut qui n'est pas celui du lot : sous GPT-5 mini, l'agent termine sans écrire (5 sorties sur 5
sans texte, même avec une consigne explicite), parce que le moteur arrête le tour sur l'appel de `mba_terminer` et ne
garde que le texte de cette réponse-là. Gemini 2.5 Flash écrit son message dans la même réponse (2 sur 2). Claude a
basculé l'agent sur Gemini, l'a dit à Julien avant d'activer, et le choix du correctif est ouvert dans `wip.md`.

## 2026-10-04 : les messages entrants ne restent plus en file, ni en rafale ni après un crash du worker

Le correctif des deux défauts trouvés la veille par le banc des trente espaces, demandé par Julien (« lance le
correctif maintenant », puis « mets en prod quand la CI est verte »). Déployé à 11 h 01 UTC (`933557b7`), avec
les jaunes de la transition de consentement d'une session voisine (`87931675`, CI verte), puis ses propres jaunes.

**La cause de la rafale, trouvée en reproduisant à volonté.** Une épreuve `rafale` ajoutée au banc (120 messages de
contacts différents d'un coup, puis plus rien) rendait 114 messages au-delà de 30 s, le pire à 67 s, à chaque fois.
Lu dans la source de pg-boss 12 : une notification ne réveille chaque boucle que pour UNE lecture (le drapeau
`beenNotified`), une boucle qui a traité un message repart dormir son filet de 60 s, et la rafale ne s'engage que sur
un compte en cache. Un premier remède (filet de 5 s, seuil de rafale à 1, cache à 10 s) ne descendait qu'à 37 s ; le
remède retenu vide `webhook` en continu : enregistrée boucle par boucle, chaque message traité les réveille toutes
(`notifyWorker`). Même rafale : **8,6 s au pire**. Écartés : `burstWhenBatchFull` (lots de deux, donc une tâche en
échec ferait rejouer sa voisine réussie) et un seuil de rafale à zéro (pg-boss refuse moins de 1 au démarrage).

**Le crash.** Un battement de cœur de 20 s sur chaque file, la supervision à 10 s : le message en cours lors d'un
`docker kill` repart en **29 s** (contre 932). L'arrêt propre reste propre (9,6 s au pire, rien d'abandonné).
Vérifié en production juste après le `up` : les dix files portent `heartbeat_seconds = 20`, le moniteur passe à la
nouvelle cadence, les portes publiques répondent.

**La relecture, aucun rouge** (le plafond d'un message à la fois par contact tient, pg-boss le suivant par nom de
file), et des jaunes introduits par le correctif lui-même, corrigés juste après : un message en échec était relu
aussitôt et ses six tentatives partaient en file d'échec en une seconde (délai de rejeu de 10 s sur la file vidée) ;
la surveillance à 10 s sur les deux workers et le cache à 10 s coûtaient de l'ordre de 150 Mo d'egress par jour
(supervision sur le seul principal, cache rendu à 60 s, moniteur à 9 s parce que pg-boss compare strictement) ; et le
plafond par contact est désormais prouvé sur le vrai pg-boss, dans les deux sens, contre la base jetable du banc.

**Mesuré en passant.** Les 830 attentes du pool de l'API vues sur le banc venaient du démarrage à froid : juste après un
redémarrage, chaque premier enfilement d'une file refait sa création et ses réglages en parallèle (845 prises pour
120 messages, contre 121 une fois l'API chaude). Au backlog. Un test d'intégration existant (file d'échec) a échoué
une fois pendant un lancement muté, et passé dix fois sur dix ailleurs, avec le correctif comme sans : non attribué.

## 2026-10-04 : une seule transition de consentement dans la fiche contact (piste 1 restante de l'audit)

**Cadrage.** Trois rondes de questions fermées le 3 au soir, décisions de Julien :
- une règle unique, avec les écarts corrigés ;
- production avant la démo, table de cas sur vraie base, retrait si l'essai réel échoue.

Qui lève un STOP : la fiche, l'import CSV case cochée, la personne (formulaire) et le bloc « Action » d'un scénario
(gardé, à sa demande). Qui ne le lève plus : l'action en masse.

**Livré.**
- **Serveur, `1c4df5ec`** :
  - la règle dans `src/crm/transition-consentement.ts`, dépliée en SQL, jamais un `case` écrit à la main ;
  - l'autorité de chaque appelant, un type fermé et requis ;
  - rien de réécrit ni d'annoncé quand le statut ne change pas ;
  - l'annonce seulement pour les vrais passages à `opted_out` ;
  - une table d'intégration (courses de deux STOP comprises) à la place des tests par expressions régulières.
- **Relecture** : 0 rouge, 6 jaunes.
- **CI verte job par job** : premier passage du nouveau SQL sur une vraie base.
- **Déploiement** : API et deux workers, l'un après l'autre, à 8 h 45 UTC.
- **Console, `a34c88c3`**, poussée APRÈS le `up` : sinon l'écran aurait annoncé « les STOP sont gardés » pendant que
  l'ancienne API les levait encore.

**Changements hors de la liste initiale, assumés.**
- Un upsert qui redit `opted_in` ne remplace plus la source.
- `affected` compte désormais les fiches changées.

**Essai réel, le 4 vers 10 h 52 (Paris), sur la fiche de Julien.**
- Désabonnement par la fiche.
- Deux actions en masse « opt-in » : `affected 0, stopsGardes 1`, date du refus inchangée, message affiché.
- Réabonnement par la fiche : passé.

Décision finale sur l'API : un refus qu'elle envoie reste annoncé au client. Aucun chemin ne crée directement une
fiche désabonnée, c'est mesuré.

## 2026-10-03 : le banc des trente espaces (Inbox, pic de messages, worker tué)

Point 2 de ce qui restait de l'audit de performance du 2026-10-02, recadré par Julien : le cas réel n'est pas un
client à 30 agents, c'est **30 espaces de 2 personnes et 10 conversations**, plus un pic où les 30 reçoivent des
messages dans la même minute. Plan : `docs/superpowers/plans/2026-10-03-banc-trente-espaces.md` ; script :
`scripts/banc-trente-espaces.mts` (sa recette de montage est en tête).

**Le montage.** Sur le VPS, dossier, image, réseau et conteneurs dédiés (`banc=inbox30`), le code de production
(`70833a75`, que de la documentation de plus que `f7e9acd0`), les tailles de pool de la production, `DRY_RUN`.
Les 30 espaces naissent par `db/seed.ts`, les 300 conversations par de vrais webhooks signés. 🔴 Le délai réseau de
la production vers Supabase, **10,2 ms** mesurés depuis `mba-api`, est imposé au Postgres jetable (`tc netem`, relu
à 10,9 ms) : sans lui, une connexion du pool se libérerait cinquante fois plus vite et le banc conclurait que le pool
tient pour une raison qui n'existe pas en production. Ce que le banc ne reproduit pas (Supavisor, le calcul et le
volume de la base, les campagnes, analyses et agents) borne ses conclusions à l'API et aux workers.

**`charge`** (60 onglets aux cadences de la console, 5 min, environ 15 requêtes/s, et 600 messages en une minute) :
p95 de l'Inbox **54 ms** sur tout le banc comme pendant le pic (seuil de l'audit : 800), zéro erreur, **zéro attente
du pool de l'API** sur 25 640 prises, webhooks acquittés en 22 ms (p95), messages du pic écrits en 94 ms (p50),
217 ms (p95), 366 ms au pire, l'espace le moins bien servi à 366 ms. L'API du banc tenait à 12 % d'un cœur. La carte
de latence livrée le même jour a rendu les mêmes ordres de grandeur que le client : première lecture réelle de la mesure.

**`crash`** (worker principal tué en plein pic, une tâche en cours, relancé 6 s après) : aucune perte, aucun doublon,
file d'échec vide, mais le message dont la tâche était en cours a attendu **932 s** : pg-boss ne rejoue une tâche
active qu'à son expiration (15 min), vérifié en base (reprise après `expire_seconds`). Les messages arrivés pendant la
coupure : 8,6 s au p95.

**`arret`** (`docker stop -t 30`, le geste d'un déploiement) : le worker finit ses tâches en cours en une seconde,
rien n'est rejoué ni abandonné. Premier passage : pire message à 8,9 s. Second passage : **22 messages arrivés en fin
de pic, 17 s après la relance, pris 61,7 s plus tard** au filet de sondage de 60 s ; l'écoute était pourtant en place.
Les deux défauts et leurs remèdes sont dans `todo.md`.

**La relecture du script a trouvé deux rouges, corrigés le soir même** : un verdict `arret` ou `crash` pouvait être
vert sans que le geste ait eu lieu au bon moment, et le plan affirmait que la base « répondait comme la production ».
Le geste se cale désormais sur un repère que le script écrit, il est prouvé par l'heure de démarrage du worker
(`worker_heartbeat.booted_at`), seule une reprise après expiration prouve un crash, et une tâche restée active est un
échec. Les résultats ci-dessus ont été revérifiés en base avec ces critères ; le script corrigé a rejoué `arret`.

## 2026-10-03 : l'OAuth devant `/mcp`, livraison 2b (la console) et essai réel

**Publié en `332d9f6c`** (Vercel, console seule ; la fiche d'aide rechargée sur le VPS par `aide:charger`, avec
l'image en place et le dossier des fiches monté en lecture seule, pour ne pas construire une image qui aurait
emporté le code non déployé d'une autre session). La page `/autoriser` et « Applications autorisées ». Relecture :
aucun rouge ; un jaune corrigé avant le push (une réponse sans la liste faisait tomber toute la page des clés).

**Essai réel par Julien, le soir même** : depuis Claude Code en terminal (`api.messagingme.app/mcp` sans clé,
Authenticate, « Autoriser », lecture des conversations, révocation, nouvelle connexion exigée), puis depuis l'app
de bureau. Trois frictions, toutes du poste et pas du serveur, pour la FAQ du plugin : PowerShell refuse
`claude.ps1` quand l'exécution de scripts est désactivée (`claude.cmd` passe) ; Claude Code n'a pas ouvert le
navigateur (lien à copier) ; dans l'app de bureau, un serveur ajouté en cours de session n'apparaît qu'à la
suivante, et `/mcp` s'utilise seul. Mesuré au passage : l'app de bureau et le terminal partagent le jeton.

## 2026-10-03 : la latence HTTP par route, dans `/ops`

Point 1 de ce qui restait de l'audit de performance du 2026-10-02 (§ 11) : `/ops` mesurait les files, rien des
routes, alors que deux seuils de l'audit sont des latences de routes. Plan :
`docs/superpowers/plans/2026-10-03-latence-http-par-route.md`.
- **Livré en deux commits** : le lot (`22d01fe4`, migration 0205), puis les jaunes de sa relecture (`b1d3bc8a`).
  Une relecture indépendante, aucun rouge ; quinze mutations à la main, quinze échecs.
- **Déployé à 20 h 33 UTC** : 0205 appliquée avant le `up` de l'API et des deux workers, relue en base ; les six
  chemins publics à 200 ou 403 comme attendu (`scripts/fumee.mjs`), démarrages sans erreur.
- **L'essai réel** : au premier vidage, dix lignes écrites par le vrai trafic (la console qui sonde l'Inbox,
  `/health`, `/live`, le webhook de Meta, `/mcp` et sa découverte OAuth), toutes sous un motif de route, aucune
  ne portant d'identifiant, et zéro erreur d'écriture dans les journaux de l'API.
- **Les jaunes déployés à 20 h 47 UTC** (aucune migration) : CI verte job par job, chemins publics vérifiés, et
  l'écriture a continué à travers le redémarrage (trois fenêtres de cinq minutes, 46 lignes, une seule forme de
  tranches, aucune adresse réelle, zéro erreur). Le pire cas mesuré : 295 ms, le compteur de non-lus de l'Inbox.

**Ce que la construction a appris.**
- **Un p95 ne s'additionne pas**, ni entre copies ni entre fenêtres : la table garde des compteurs par tranche de
  durée, qui s'additionnent, et le centile s'en tire à la lecture (un majorant, plafonné par le maximum mesuré).
- **`onResponse` ne voit pas une requête abandonnée par le client**, et ce sont les plus lentes (relevé par la
  relecture, mesuré). Un premier correctif partageait les requêtes sur `writableFinished` : vert sur une vraie
  connexion, il comptait TOUTES les requêtes de `inject` en abandon, parce que la réponse simulée ne pose pas ce
  drapeau. Le crochet officiel `onRequestAbort` (qui ne se déclenche que sur un vrai abandon), avec une marque
  contre le double compte, tient dans les deux cas : un test sur une vraie connexion le prouve.
- **Le rouge ne vise que ce qui doit être rapide** (webhooks entrants, lectures de l'Inbox, dès 20 requêtes) : la
  traduction, la transcription ou un envoi chez Meta sont dans l'Inbox et lents par nature.
- **La mesure ne suspend plus celle du pool** : `sansSeMesurer` vaut pour tout le processus, et un vidage qui
  attend un pool saturé aurait rendu la saturation invisible au moment exact où elle a lieu.

## 2026-10-03 : plus de 502 durable après un `up` de l'API, et le document de bascule Scaleway remis à jour

**Le 502 après chaque `up`, corrigé à la source.** Le diagnostic, lu dans les fichiers que NPM génère : l'hôte
`api.` (24) nommait déjà `mba-api` par une variable (`set $server`), relue par le résolveur de Docker toutes les
10 s ; l'hôte `mba.` (21), lui, écrivait `proxy_pass http://mba-api:8095` EN DUR dans ses quatre routes
personnalisées (`/api/backend/`, `/r/`, `/m/`, `/mcp`), donc nginx figeait l'adresse au chargement, et c'est le
chemin des webhooks de Meta. Les quatre routes passent par `set $mba_api mba-api`, et `/api/backend/` retire son
préfixe par un `rewrite` (un `proxy_pass` par variable ne le retire pas).
- **Éprouvé avant d'être appliqué**, sur un nginx jetable lancé dans le conteneur NPM (port 8099) : chaque route
  atteint l'API, préfixe retiré, paramètres gardés.
- **Appliqué par l'API de NPM**, configuration d'avant sauvegardée sur le VPS (`npm-backup-21-…`, `npm-backup-24-…`).
- **L'essai réel** : `mba-api` recréé SANS recharger NPM, les deux portes relevées chaque seconde. 502 pendant les
  4 à 5 s du redémarrage lui-même, puis 200 sur les deux dès que l'API est saine. Avant, `mba.` restait en 502
  jusqu'au rechargement manuel. (Un premier essai n'avait rien prouvé : le `cd` était parti avec la boucle en
  arrière-plan, et le conteneur n'avait pas été recréé. Le second compare l'identifiant du conteneur avant et après.)

**Le document de bascule Scaleway** (`docs/ARCHITECTURE-CIBLE.md`) dit maintenant ce qui est prouvé (les deux bancs,
les chantiers §3.1 et §3.3 éprouvés, le §3.5 trouvé et corrigé, les deux workers en production), ce que Julien a
tranché (l'autoscaling à Scaleway, pas sur le VPS), et ce que le jour J doit refaire : le budget de connexions
sur la vraie base (mesuré, puis inscrit dans le test), le nom de chaque copie dans `/ops`, la vérification de la
migration 0060, et le second banc rejoué sur la cible.


## 2026-10-03 : « Tester le scénario » ne marque plus la conversation, et ce que les essais ont appris de l'agent

**Le constat.** Après l'essai des envois de bloc, Julien a voulu que l'agent de Meta réponde quand il répond en
texte libre à un scénario de test. Le worker journalisait « remise à l'agent de Meta ignorée : conversation de
TEST ». Le jeton de test marquait la conversation `is_test` à sens unique, et la règle 5 du contrôle du fil
interdisait pour toujours toute remise automatique à l'agent, même hors de tout test.

**Livré.**
- **Sa conversation, démarquée à la main** (une ligne, sur son accord).
- **`0c4e2099`** : le jeton ne marque plus rien (décision de Julien, « ne plus marquer du tout »), avec une garde
  qui refuse toute affectation de `is_test` dans `src/`. Relecture : 0 rouge, 9 jaunes. Workers déployés à 15 h 33
  UTC, l'un après l'autre.
- **Jaunes `70613288`**. Le n°1 est un vrai défaut, que la règle 5 masquait pour les tests :
  - un accusé attendu en fin de parcours, arrivé après qu'un test relancé avait repris le fil, mettait le contact
    sur la liste et rendait le fil à l'agent en plein parcours ;
  - `rendreMaintenant` relit désormais le détenteur avant de confier, vérifié dans les deux sens ;
  - workers redéployés à 15 h 50 UTC.

**Essais réels, le soir (heures de Paris), et ce qu'ils ont mesuré.**
- **Message rapide, puis texte libre : l'agent répond** (19 h 40 à 19 h 41, `agent_event` accepté, réponse en 23 s).
- **Modèle, puis texte libre : l'agent se tait.** Meta refuse l'`agent_event` (« Event request was not
  accepted ») :
  - en fin de parcours à 19 h 25 ;
  - puis renvoyé à la main un quart d'heure plus tard, le contact sur la liste et l'agent tenant le fil.

  Le `release` est refusé aussi, l'agent tenant déjà le fil depuis le modèle. Les statistiques de Meta montrent
  quatre « réponse hors parcours » traitées du 21 au 29/09, avant le mode liste, puis aucune jusqu'à celle de 19 h 40.
  Hypothèse, non prouvée (`todo.md`) : l'agent reçoit la réponse au modèle alors que le contact est hors de sa liste,
  l'écarte, et Meta refuse ensuite de le relancer dessus.
- **Enchaîner les tests : l'agent lit le jeton suivant.** À 19 h 38, il a répondu au mot du lien par son message de
  passage : un essai fini chez lui avait remis le contact sur sa liste.
- **Faux soupçon écarté** : l'état « passé à l'équipe » chez Meta (deux conversations au compteur) n'empêche pas
  l'agent de répondre à un message neuf (vérifié à 19 h 34).

⚠️ **Correction du même soir : la conclusion « modèle, puis texte libre : l'agent se tait » était fausse.** À
23 h 01, après « Reprendre la main » dans l'Inbox, un test ouvert par un MODÈLE puis une réponse en texte libre :
`release` refusé comme à 19 h 25, mais `agent_event` ACCEPTÉ, et l'agent a répondu en 18 s. Les deux refus de la
soirée restent inexpliqués (`todo.md`). Seule différence repérée : ils tombaient pendant que l'agent n'avait pas
reparlé depuis son message de passage de 16 h 38. La leçon tient en une ligne : deux mesures dans le même état ne
font pas une règle sur le modèle, il fallait faire varier l'état avant de conclure.

## 2026-10-03 : l'OAuth devant `/mcp`, livraison 2a (l'API)

**Déployé en `0a399f9a`** (migration 0204 appliquée à 16 h 27 UTC, `mba-api` et les deux workers reconstruits,
portes à 200). Lot 2 du plan « Engage Me pour Claude Code », cadré le même jour avec Julien : Claude Code et
claude.ai seulement, fiches d'identité épinglées, seuls les admins autorisent, appels dans le plafond de l'espace.

**Méthode** : deux implémenteurs à la suite dans une extraction d'origin, puis une relecture indépendante (aucun
rouge, neuf jaunes). Quatre jaunes corrigés avant le commit, dont un de rayon de souffle : la personne qui signe
désormais une réponse de Claude remplit `sender_user_id`, et deux lecteurs en déduisaient « humain » (l'analyse) ou
« pas une sollicitation » (le bilan du contact). Ils lisent maintenant l'origine `mcp`. Les tests d'intégration de
ces lecteurs et du rejeu, qui ne tournent qu'en CI, ont été vus rouges sur un commit faussé jetable.

**Mesuré après le déploiement** : métadonnées servies par l'API, `www-authenticate` sur le 401 de `api.` et pas de
`mba.`, `/oauth/token` atteint depuis un client en ligne de commande. Et une surprise : le proxy NPM rend 403 à une
adresse `http://` écrite en clair dans la requête (protection contre les exploits courants). Claude encode ses
paramètres, l'essai réel le confirmera.

## 2026-10-03 : le pool du pooler Supabase monté à 30, et chaque copie dimensionnée

**Déployé en `f4eec9f2`** (`mba-api` seul, à 15 h 49 UTC, `DB_POOL_MAX=10` relu dans le conteneur, portes à 200).

**Demandé par Julien** (« fais le redimensionnement du pool par copie maintenant »), après le second banc. Ce qui
devait être un partage des 16 connexions entre copies a été renversé par la MESURE, et c'est la leçon du lot.
- **Le pool du pooler, mesuré** : une sonde de N `select pg_sleep(1)` simultanés par `APP_DATABASE_URL` voyait 16
  requêtes dans la première vague. Ce n'est pas une limite de Supabase, c'est le réglage « Pool Size » (15 ; la
  sonde voit le réglage plus un), qui vaut par utilisateur, base et MODE : le même borne les sessions de pg-boss.
- **Nos pools le dépassaient déjà, et le payaient** : API 8 + principal 8 + analyse 3 = 19, et sur sept jours de
  `pool_attentes`, le pool de l'API saturait 6 % de ses prises de connexion (3 558 sur 56 235, au pire 246 ms), le
  principal dix fois en cinq heures. « Redimensionner par copie » dans 16 aurait aggravé une saturation mesurée.
- **Le levier était le réglage** : Supabase autorise jusqu'à 80 % des 60 connexions de la base au pooler. Julien
  l'a monté à 30, la sonde voit 31 juste après. L'API passe à 10, le principal reste à 8, l'analyse à 3 (21), et
  9 restent pour une seconde copie d'API.
- **Le budget est tenu par un test**, `tests/budget-pooler.test.ts`, qui lit le compose : une taille par service,
  la somme sous le pool, les sessions sous le pool, le pire cas sous les 80 %, et chaque copie d'API plus grande
  que ce que prennent ses opérations lourdes. Vérifié dans les deux sens (une seconde copie d'API à 10 ajoutée
  sans redimensionner, et une API sans taille déclarée, le font tomber).
- ⚠️ **Appliquer le réglage coupe les connexions en cours** : à l'enregistrement, Supabase a terminé les connexions
  du pooler (« terminating connection due to administrator command »), et l'alerte Telegram de pg-boss est partie.
  Rien n'a redémarré ni n'est resté bloqué : les pools ont rouvert, et la supervision de pg-boss a réécrit deux
  minutes plus tard. À prévoir à chaque changement de ce réglage : le faire à une heure creuse, et s'attendre à
  cette alerte.

## 2026-10-03 : les envois d'un bloc de scénario sortent du câblage (piste 2 du rapport d'architecture)

**Cadrage.** Deux rondes de questions fermées. Julien a retenu :
- les quatre envois seulement (modèle, message rapide, question, formulaire) ;
- pas de point d'envoi unique ;
- un comportement strictement identique ;
- le cache des modèles laissé dans le câblage ;
- des gardes qui exécutent au lieu de relire le texte ;
- une mise en production avant la démo, avec un essai réel avant le lundi 5 au soir, sans quoi le lot était retiré.

Plan : `docs/superpowers/plans/2026-10-03-envois-de-bloc.md`. ⚠️ Le rapport annonçait « 20 commits dont 8 correctifs » : le
chiffre portait sur tout `wiring.ts`, pas sur ces quatre fonctions, qui n'avaient bougé que par des nettoyages.

**Livré.**
- **`cdcbde3e`** : `src/workflow/envois-bloc.ts` (`creerEnvoisDeBloc`), avec les corps déplacés octet pour octet.
- **Les tests** : 60 tests qui exécutent le vrai module, dont des passages par le vrai câblage. Ils remplacent
  `workflow-cablage-categorie` et le describe textuel du bouton de lien.
- **La relecture indépendante** : 0 rouge, 4 jaunes, dix défauts remis tous détectés.
- **La CI** : le run de `cdcbde3e` a été annulé par un push voisin, donc le premier run qui a testé le lot est celui de
  `0c476865`, vert job par job.
- **Le déploiement** : fait par la session RSSI à 11 h 46 UTC, avec son correctif d'idempotence (API et deux workers).
- **Les jaunes** : `e253e4a5`, après le déploiement. Il ajoute les deux visuels sans test (carousel et en-tête VIDÉO,
  dans les deux branches, vérifiés dans les deux sens). Il retire aussi un `satisfies` qui ne contrôlait rien et
  corrige des commentaires périmés.

**Essai réel, le 3 à 16 h 38 (Paris), avec le scénario « test0310 » lancé par « Tester le scénario ».**
- Le modèle `test_0310` est parti, journalisé avec sa catégorie `marketing`.
- Puis le message rapide, la question en liste et le formulaire : tous journalisés en `origine = 'scenario'`.
- Chaque réponse (bouton du modèle, bouton du message rapide, ligne de la liste) est routée sur son bloc.

Le premier formulaire désignait un formulaire inexistant : Meta a refusé (#131009) et le parcours est resté en
attente, avec pour seule trace `processWorkflowAdvance: message ignoré`. Ce comportement existait avant le lot. Avec
un vrai formulaire, l'envoi est passé.

**Constat à côté, non lié au lot : l'agent de Meta a parlé à un contact absent de sa liste.**
- **Le message** : à 16 h 38 min 48 s, il a envoyé son message de passage (le texte `CUSTOM`, « Je transmets votre
  demande… »), juste après notre modèle.
- **Lu chez Meta, en lecture seule** : `ai_audience = ALLOWLISTED_ONLY`, une liste vide chez Meta comme chez nous, un
  `handoff` en `enabled: true` avec `message_selection: CUSTOM`.
- **Ce que disent les journaux du worker** : la réponse « Génial ! » au bouton du modèle est arrivée en `standby` (un
  modèle rend le fil à l'agent, mesuré le 2026-09-29). Elle a été requalifiée (`standby_hors_liste`), puis l'écho du
  message de passage est arrivé, sans aucun `messaging_handovers`.

L'agent n'a donc pas répondu en tant qu'IA : il a annoncé un passage à l'équipe. Sur dix jours, c'est le seul message
de passage parti vers un contact hors liste ; les deux autres suivaient une vraie demande. Une occurrence ne dit pas
la règle : la mesure (réponse au modèle par un bouton, puis par du texte) reste à faire.

## 2026-09-30 au 2026-10-03 : la vitrine, du formulaire de contact au widget

Demandes de Julien, livrées en direct (plan `docs/superpowers/plans/2026-09-28-vitrine-fonctionnalites.md`).

- **Formulaire de contact** : `POST /vitrine/contact` (`2894b215`), formulaire HTML natif et redirection 303, donc
  sans CORS ; e-mail Resend à `SUPPORT_TO`. Déployé AVANT la page (`529f2300`), qui sinon aurait posté vers un 404.
  La CI a été rouge sur l'auto-attaque, que `npm test` ne lance pas : le module public n'avait pas sa fausse
  autorité (`54f36f1b`). Après le `up`, le 502 public habituel, levé par un rechargement de NPM ; contrôle sans
  aucun envoi (corps vide, pot de miel). Les boutons « Demander une démo » mènent au formulaire, message
  pré-rempli (`6cfe5cb7`).
- **Pages** : « Analyse de conversations », « fallback », page Publicités à deux messages (la pub ouvre une
  conversation, et tout se pilote du même endroit), bandeau « Ils nous font confiance » (huit logos, celui de
  Picoty téléchargé avec l'accord de Julien).
- **SEO** : bilan à 56/100 (ni sitemap ni robots.txt, adresses en double, titre de l'accueil sans mot cherché,
  aucune donnée structurée), corrigé en `b326a5fc`. Le domaine technique `engageme-site.vercel.app` rendait
  encore 200 sur `/` : le motif `/:chemin*` ne capte ni le chemin vide ni la barre finale, `/:chemin(.*)` si
  (`a66aae1f`). PageSpeed Insights refusait les appels sans clé (429) : les Core Web Vitals restent à lire dans la
  Search Console.
- **Widget en essai sur l'accueil** (`c535d62b`). En chemin : Cloudflare servait son script avec 4 h de cache
  navigateur au lieu des 60 s de l'API (son Browser Cache TTL par défaut sur les `.js`). Julien a posé une Cache
  Rule « Respect origin TTL » sur `/widget/*`, vérifiée juste après (`max-age=60`) et écrite dans
  `documentation.md` (`5dc88377`).

## 2026-10-03 : le second banc à deux copies d'API, et la clé d'idempotence qui reste coincée

**Décidé par Julien le jour même**, avant tout autoscaling (plan `docs/superpowers/plans/2026-10-03-second-banc-deux-api.md`).
Monté sur le VPS selon la recette du premier banc, avec deux copies nommées (`API_COPIE=a` et `b`, poussé en
`b44fd32f`), un pool réduit à 3 connexions par copie, un worker et un Postgres jetable ; démonté ensuite, la
production n'a pas bougé.

**Ce qui est prouvé, chaque verdict lu en base :**
- **Une clé, un envoi, entre deux copies** : dix clés tirées EN MÊME TEMPS sur A et B, neuf vraies courses (une
  409 « en cours » pour le perdant), dix envois en base, aucune clé à deux envois.
- **Arrêt propre** (`docker stop`) en plein tir : 909 tirs, 904 acquittés et tous en base avec leur clé, AUCUNE
  requête coupée (l'arrêt laisse finir ce qui est en vol), l'autre copie n'a rien vu.
- **Webhooks sous pression de pool** : 12 209 lectures en rafale sur A (24 en parallèle sur 3 connexions, 6 282
  attentes de pool versées sous `api-a`), et pourtant les 73 webhooks signés sont acquittés ET enfilés, accusé à
  19 ms au médian, 45 ms au 95e centile, 196 ms au pire.
- **Connexions par copie** : au plus 3 chacune sous charge, pour un pool de 3, et aucune connexion en `LISTEN`
  côté API : seul le worker écoute.

🔴 **Ce qui casse : l'arrêt BRUTAL** (`docker kill`). Toute requête acquittée est bien en base et l'autre copie
ne voit rien, mais sur cinq arrêts, TROIS ont coupé un envoi entre la pose de sa clé et son scellement : la clé
reste « en cours », sans campagne (ni fantôme, ni double), et chaque rejeu rend 409 pendant 24 h. Rien ne libère
une clé abandonnée. Le premier tir avait réussi par hasard (la coupure était tombée avant la pose) : **un
échantillon ne prouve pas l'absence d'une fenêtre**, il a fallu répéter l'arrêt pour la voir.

**Corrigé et déployé le jour même** (`0c476865`, à 11 h 46 UTC), à la demande de Julien (plan
`docs/superpowers/plans/2026-10-03-cle-idempotence-coincee.md`).
Une clé en cours EST un verrou sur l'envoi, et il lui manquait deux des trois pièces de `run-lock.ts` : un **bail**
(`DUREE_CLE_EN_COURS_MAX_MS`, 5 min : au-delà, `claim` retire la pose abandonnée) et un **jeton de garde**
(`api_idempotency.jeton`, migration 0203 poussée SEULE et appliquée avant le code : `possede`, `complete` et
`release` ne touchent que la ligne de leur jeton). La route demande `possede` avant de créer la campagne, et ne
lance jamais celle dont le scellement est refusé. 🔴 **C'est le jeton, pas la durée du bail, qui empêche le double
envoi** : sans lui, un traitement lent qui dépasse le bail scellerait ou libérerait la pose de celui qui l'a reprise.
Une relecture indépendante, sans rouge (sept jaunes : cinq de texte intégrés, deux de comportement au backlog).
Les tests vérifiés dans les deux sens, y compris le test d'intégration du magasin, joué contre le Postgres jetable
du banc avec deux mutations (sans jeton, sans bail) qui le font tomber exactement à l'assertion attendue.
**L'essai réel**, le banc remonté avec le correctif : au premier arrêt brutal, un envoi coupé entre pose et
scellement, sa clé en 409 sans envoi, puis 201 avec son envoi une fois le bail passé (285 s d'attente, à l'heure
de la base), et aucune campagne orpheline lancée.

**Ses deux jaunes de comportement, le même après-midi**, déployés en `f74ebb59` à 14 h 59 UTC (`mba-api` seul ; plan
`docs/superpowers/plans/2026-10-03-cle-idempotence-jaunes.md`).
La relecture proposait de supprimer après coup la campagne d'une clé reprise, et de repérer par un ménage celles
des copies tuées. 🔴 **Écarté, parce que rien ne distingue de façon fiable un envoi d'API d'un brouillon de la
console** : le préfixe `[API] ` se tape à la main, et un ménage fondé dessus pourrait effacer le brouillon de
quelqu'un. À la place, la cause : la campagne et le scellement de sa clé naissent dans UNE transaction
(`createWithRecipientsSiConfirme`, `complete` sur le client de cette transaction). Il n'y a plus d'orpheline à
supprimer ni à repérer, sans migration ni balayage. Et le bail ne libère plus qu'une pose du même corps : « même
clé, autre corps » reste un 422 toute la vie de la clé. Relu sans rouge (sept jaunes, tous intégrés : aucun ne
change rien pour un client). Prouvé en base sur le Postgres du banc, y compris l'atomicité : un scellement réussi
puis annulé ne laisse ni campagne ni clé scellée, et le même test tombe si `complete` repasse par le pool. Rejoué
au banc : idempotence entre copies, et trois arrêts brutaux, dont un coupé au pire moment (409 puis 201 après le
bail), avec ZÉRO campagne orpheline.

**Trois pièges du montage**, pour le prochain : l'image ne contient pas `scripts/`, il faut monter le dossier du
clone dans le conteneur du script ; les files d'analyse n'existent pas sur le banc (aucun modèle configuré), le
worker n'en annonce que six ; et l'image de production n'embarque pas `vitest` (`--omit=dev`) : un test
d'intégration se joue dans un conteneur `node:22` à part, avec `npm ci --include=dev`, parce que le
`NODE_ENV=production` du `.env.banc` ferait sauter les dépendances de développement.

## 2026-10-02 et 03 : le double worker en production, et le banc à deux copies d'API vert

**Déployé le 2026-10-03 à 8 h 17 UTC**, décidé par Julien après l'audit de performance du 2026-10-02 : un second
worker pour isoler l'analyse du chemin que la production emprunte, et un crash test à deux copies d'API avant tout
autoscaling.

**Le banc a tourné sur un Postgres jetable monté sur le VPS** (199 migrations depuis zéro), avec deux vraies copies
de l'image et un worker. Trois verdicts verts : une clé créée est acceptée des deux côtés, une clé révoquée est
refusée immédiatement par les DEUX, et le plafond par espace est GLOBAL (54 acceptés contre 76 refusés sur 130 tirs
alternés, plafond 60 ; à compteur par copie on aurait passé ~120). Démonté ensuite ; sa recette est dans le script.

**Trois défauts trouvés en chemin, sans rapport avec le lot.** `npm run seed` était cassé DEUX fois : un
`on conflict (lower(email))` sur un index global que la migration 0073 avait supprimé (42P10), puis, réparé, un
compte incapable de se connecter, le mot de passe vivant sur l'identité depuis 0072. Et 0060 est appliquée en
production alors que son fichier a disparu du dépôt : une base neuve n'a jamais 0060.

**Deux révisions sur donnée mesurée.** Le filtre des files a d'abord été posé en renommant l'appel `queue.work` :
cinq gardes du dépôt sont tombées d'un coup, celles qui dérivent les files consommées du texte de `worker.ts`. Il
vit donc dans la file (`neTravailleQue`). Et le battement, ligne unique `id = 'worker'`, aurait laissé le survivant
masquer la mort de l'autre : il passe à une ligne par rôle, SANS changement de schéma, `id` étant déjà une clé.

🔴 **Ce que la relecture a corrigé chez moi** : j'avais écrit « mesuré » que tous les enfilements du worker visaient
une file du même rôle. C'était incomplet, l'analyse enfile indirectement vers le principal. La conclusion tenait
pour une autre raison (`enqueue` crée sa file). **Une mesure qui ne couvre que les appels DIRECTS ne dit rien des
chemins qui traversent le câblage** ; c'est la même famille que « un test unitaire monte un faux câblage ».

**Déployé en deux temps**, principal puis analyse, à cause du plafond de 15 sessions du pooler, et 0202 APRÈS le
`up`. Partition parfaite en production (7 files contre 3), deux battements de deux conteneurs, portes publiques à
200. L'essai réel reste dû : aucun trafic ce samedi matin.

**Les cinq jaunes de la relecture, corrigés le jour même** (`8b37a1ba`, déployés à 10 h 18 UTC sur les deux
workers, relus par le lot suivant) : le
commentaire faux de `work()` réécrit sur sa vraie raison ; le balayage d'agrégats du DÉMARRAGE, qui tourne hors du
registre, gardé par `minuterieDuRole` (le rôle `analyse` le jouait à chaque `up`) ; un nom de processus par rôle
(`nomDuProcessus`) pour les attentes de pool et les alertes Telegram ; les commentaires de budget recalés sur le
plafond qui mord, les sessions du pooler, et sur les 19 clients du mode transaction. Les deux gardes de câblage ont
été vérifiées par mutation.

## 2026-10-02 et 03 : le widget WhatsApp, lots 3b à 5 et revue finale, tout en production

**D'où ça vient.** Une bulle WhatsApp à poser sur le site d'un client, voulue par Julien pour TOUS les clients de la
console et pas seulement pour « Engage Me pour Claude Code ». Spec `docs/superpowers/specs/2026-10-02-widget-whatsapp-design.md`,
plan `docs/superpowers/plans/2026-10-02-widget-whatsapp.md`. Lots 1 à 3 le 2 octobre (table, route publique, arrivée).

**Ce qui est livré, dans l'ordre des déploiements.**
- **Lot 3b, `97cdb65a`** : le scénario d'un widget reprend le fil à l'agent de Meta et le laisse à un opérateur
  (`POSSESSEUR_WIDGET`), et un `standby` démarre. Sans lui, le devenir `scenario` ne partait jamais sur un espace où
  l'agent de Meta tient le fil. Déployé avec le lot 3 : le conteneur portait déjà tout jusqu'au dernier commit d'un
  pair (vérifié à l'octet), donc le `up` n'a embarqué que ces deux lots.
- **Lot 4, en deux poussées** : l'API (`81f258b7`, routes et `gestion.ts`) déployée AVANT l'écran (`4d5acbb8`), pour
  que Vercel ne publie jamais une console qui appelle une route absente. Décisions de Julien : cinq widgets par
  espace, un scénario supprimé rend le widget inerte, l'API avant l'écran.
- **Lot 5, `4551324c`** : quatre outils MCP sur les mêmes fonctions, plus deux jaunes du lot 4 (scénario publié
  exigé ; arrivées du widget hors du comptage des messages reçus). `list_scenarios` a été ajouté en cours de route :
  sans lui, `create_widget` en devenir scénario était inutilisable par un modèle.
- **Revue finale complète des lots 1 à 5 : aucun rouge.** Trois jaunes corrigés dans `e5a66e58` : le mot d'arrêt en
  tête de phrase (il aurait désabonné chaque visiteur), la purge de `widget_tirs` par la fiche, le cache de 30 s de
  la route publique.

**Mesures.**
- Le droit `mcp:write` gagne la création et la modification des widgets : les 3 clés actives qui le portaient au
  déploiement étaient toutes dans l'espace interne SANDBOX (lecture en base), aucun client n'était concerné.
- Chaque lot : une relecture indépendante (aucun rouge sur les lots 3b, 4 et 5), l'arbre exact de chaque commit
  revérifié hors du dépôt (typechecks, suite complète, auto-attaque), la CI lue job par job, le contrôle public après
  chaque `up`, les fiches d'aide rechargées (`aide:charger`).
- Le test d'intégration de la purge, qui ne tourne pas en local, a été vérifié dans les deux sens par un commit MUTÉ
  poussé sur une étiquette jetable : rouge exactement sur ce test, le vrai commit vert.
- Coordination : deux sessions voisines (catalogue d'outils de l'agent de Meta, fiche unique) ont déployé entre mes
  lots ; chaque `up` a été annoncé et n'a embarqué un commit voisin qu'avec l'accord de son auteur.

**Ce qui reste.** L'essai réel et trois décisions de Julien (`wip.md`), les jaunes (plan, « Ce qui reste »), et un
trou RGPD antérieur au widget sur `workflow_runs` et `automation_fires` (`todo.md`).

## 2026-10-02 et 03 : la règle unique du catalogue d'outils (offrable, appelable, publiable)

**D'où ça vient.** Une revue d'architecture du 2026-10-02 au soir a classé neuf frictions ; Julien a retenu la
première et l'a cadrée en quatre rondes de questions fermées. La règle « peut-on donner cet outil à cet agent, et
peut-il l'appeler ? » s'écrivait à cinq endroits, en trois versions qui se contredisaient :
- un outil MCP mort était écarté pour l'agent de Meta, mais proposé à un agent IA et à l'assistant ;
- un outil d'un serveur éteint était proposé partout.

Sur ces fichiers, 41 commits en deux semaines, dont 46 % de correctifs ; la migration 0199 avait oublié
l'assistant, rattrapé deux heures plus tard (590ef8e5). Plan : `docs/superpowers/plans/2026-10-02-catalogue-regle-unique.md`.
Prévu après la démo du 7, lancé le soir même sur décision de Julien, avec une date butoir (en production et essai
réel faits le lundi 5 au soir, sinon retiré).

**Ce qui est livré.**
- **Serveur, `880b624d`, déployé dans la nuit.** Les fragments SQL `CAUSE_INAPPELABLE`, `ENREGISTRE` et
  `DE_LA_BIBLIOTHEQUE` dans `src/agent/catalog.pg.ts`. Ils servent à :
  - `offrablesPour` ;
  - la porte `rattacherConsommateur`, qui rend sa raison au lieu d'un booléen ;
  - l'activation, qui refuse un outil inappelable ;
  - `listActifs`, qui ne montre plus d'outil mort au modèle ;
  - la cause `inappelable`, portée sur chaque ligne.
  Les listes de l'agent de Meta et de l'assistant, et la publication, ne filtrent plus rien. Route
  `GET …/agents/:agentId/tools/offrables`. Un connecteur de l'agent de Meta sur une source éteinte est refusé
  avant d'être créé.
- **Console, `b8760b6b`, poussée après le `up`.** La section MCP d'un agent IA affiche la liste du serveur, et le
  bandeau d'un outil mort lit la cause du serveur.
- **Les jaunes de la relecture, `d101358e`.** Relecture : 0 rouge, 9 jaunes. Le lot ajoute :
  - le type de la source exigé par la règle ;
  - la ligne rouge d'un connecteur au système éteint sur la page d'un agent IA, devenue muette sinon ;
  - les tests de la course « désenregistrer pendant un rattachement » et d'un outil de bibliothèque d'un autre
    espace.

**Mesures.**
- **Avant le `up`, en lecture seule.** Sur les 6 consentements actifs de la production, aucun ne tombait sous la
  règle : la mise en ligne n'a rien retiré à aucun agent.
- **Après le `up`, par le vrai code et en lecture seule.**
  - `tag_conversation` (non activable) n'est plus offert, ni à l'agent de Meta ni à l'agent IA. Avant, l'agent IA
    se le voyait proposer.
  - `get_contact` reste actif et appelable pour l'agent de Meta.
- **Contre-épreuves.**
  - La table de cas tombe en CI sur ses six cas inappelables quand on retire la condition « appelable ».
  - Le test e2e de la liste tombe sur l'écran muté.
  - Le test de course tombe sans le `for key share`.

**Ce que la nuit a appris.** La CI d'intégration du premier commit est tombée sur un test que le lot ne touchait pas.
Ce test d'interblocage supposait un ordre PHYSIQUE des lignes (`order by ctid`), or la nouvelle table de cas, jouée
avant lui, crée puis efface des outils, et l'espace libéré a inversé l'ordre des insertions. La précondition retente
désormais au lieu de supposer (`brain/LEARNINGS.md`, 2026-10-03).

**Reste : l'essai réel (Julien).** `tag_conversation` absent des trois listes « ajouter » (page d'un agent IA,
assistant, « Appeler un outil MCP » de l'agent de Meta), et `get_contact` toujours appelé avec succès par l'agent
de Meta (`agent_tool_calls`).

**Essai réel fait le 2026-10-03, et pas tout à fait celui prévu.** Avant l'essai, Julien a supprimé l'ancien
connecteur du serveur Messaging ME puis l'a rebranché, avec une clé de LECTURE. Le serveur ne montrant à une telle
clé que ses huit outils de lecture, `tag_conversation` n'est plus importé du tout. L'écran ne pouvait donc plus
montrer son refus : ce point reste établi par la mesure faite par le vrai code après le `up`. En échange, le second
point a parcouru toute la règle :
- `get_contact` proposé dans « Quel outil MCP ajouter ? » ;
- réglé, avec le téléphone pris dans `wa_id` ;
- activé, puis publié chez Meta ;
- appelé par l'agent de Meta à 12 h 26 (heure de Paris) : `agent_tool_calls` rend `ok` en 557 ms, pour 1 525
  octets, et la réponse de l'agent cite la fiche.

## 2026-10-02 : tout sur la fiche, lot 3, « la dernière analyse change », essai réel fait

**Serveur (`6ae0a144`), déployé vers 17 h 28 (heure de Paris), puis console (`c5d438c1`).** Nouveau déclencheur
d'automation `analyse_devient` : un filtre de dernière analyse (`{cle, op, valeur}`, la règle des filtres de
contacts) qui part quand la NOUVELLE copie sur la fiche le satisfait et l'ANCIENNE non. La copie vient de `save`
(lot 1) par un type à part, `AnalyseTerminee`, pour ne pas toucher le contrat de la poussée HubSpot ; le worker
la met dans l'événement `analysis` avec toutes les valeurs. « Conversation analysée » gagne des `filtres` sur
tous les champs d'analyse. Anti-rebond par défaut de 7 jours, même garde anti-boucle que « conversation
analysée ». Le délai de relance se règle désormais à l'écran pour toutes les automations. Aucune migration.

⚠️ **Relecture indépendante : aucun rouge, quatre jaunes, trois corrigés avant le commit.** Un `filtres` qui
n'est pas un tableau (écrit hors de la route) faisait partir l'automation sur toutes les analyses : il bloque.
Le commentaire « 7 jours par contact » était faux, l'anti-rebond compte par identité WhatsApp du fil (`waId` de
l'événement, celui du fil analysé, gardé délibérément pour ne rien changer aux automations existantes).
Le manuel dit d'éteindre les « conversation analysée » filtrées avant un retour arrière de l'API (une image
ancienne lit leurs filtres comme absents). Le quatrième est une limite assumée, écrite dans `features.md` et
la fiche d'aide : une transition manquée (fil tenu, anti-rebond, condition) ne se rejoue pas.

🔴 **Deux défauts trouvés par Julien pendant l'essai, corrigés le jour même.** Dans l'éditeur des choix
d'analyse, la première valeur (Positif) était cochée d'office, et cliquer « Négatif » l'AJOUTAIT : l'automation
enregistrée valait « positif ou négatif » et ne serait jamais partie dans son essai (`0d74e71a` : le premier clic
remplace la valeur proposée). Et une automation ne se modifiait pas, elle se supprimait et se recréait
(`54bcf702` : « Modifier » rouvre le formulaire prérempli, PATCH, l'état allumé ou éteint ne bouge pas). Les deux
e2e ont été vérifiés dans les deux sens en les jouant contre la console construite juste avant la correction,
sans reconstruire.

**Essai réel, Messaging me Brevo, automation « devient mecontent » (sentiment devient négatif) vers le scénario
« signaler à Brevo »**, relevé en base à chaque analyse : à 18 h 55, trois messages lus ensemble, négatif sur une
fiche déjà négative, AUCUN déclenchement ; à 19 h 25, un message content lu positif, aucun déclenchement ; à
20 h 00 min 52 s, un message mécontent lu négatif, la fiche passe de positif à négatif, l'automation se déclenche
dans la même seconde et l'appel `signaler` part chez Brevo en 204. ⚠️ Une première tentative avait échoué pour
deux raisons de mise en place, pas de code : l'automation n'était pas allumée, et le message mécontent était
arrivé trois minutes avant l'analyse des messages contents (25 minutes de silence exigées), donc les trois
avaient été lus ensemble.

Le déploiement a emporté `2ae67ba6` (correction MCP d'une session voisine, sans migration) et appliqué la
migration 0200 du widget avant le `up`, relue en base ; les deux sessions ont été prévenues.

## 2026-10-02 : l'agent de Meta pour une démo, passage en français, plafond, tableau et outils MCP

Julien a reçu sa facture de l'agent de Meta (« hyper cher ») et prépare une démonstration le 7 octobre avec un
interlocuteur de Meta. Exploration de la documentation de l'API du Meta Business Agent, puis quatre chantiers, tous
choisis par lui. La récolte détaillée vit dans `messagingme-pilot/docs/META-BUSINESS-AGENT-API.md` (« RÉCOLTE DU
2026-10-02 »).

**Mesuré avant d'écrire.** Aucune API ne rend le coût ni les jetons de l'agent : il n'est pas dans
`pricing_analytics`, et ses statuts de message ne portent aucun objet de prix. On compte donc nous-mêmes les messages
qu'il a écrits, au prix public. `agent_budget` se pose sur l'identifiant du BUSINESS MANAGER : sur le numéro, Meta
rend 404 « Business not found ». Un `POST` remplace TOUS les plafonds. Et Meta le dit mot pour mot : « Token budgets
apply across the Business Manager », « AI-turn budgets apply to each conversation ». Le texte anglais du passage à un
humain venait de `handoff.message_selection` laissé à `DEFAULT`, que le `GET` des réglages ne rend même pas.

**Lot 1, le message de passage (`608a63cf`, console seule).** Trois choix dans « Vue d'ensemble » : rédigé par
l'agent, notre texte, ou le texte standard de Meta. L'état part de `null` quand Meta ne le dit pas.

**Lot 2, le plafond et la carte de Performance Lab (`e0551f27`).** Routes `GET|PUT /tenants/:tenantId/mba-budget` (le
Business Manager se résout par la WABA de l'espace) et `GET /tenants/:tenantId/mba-insights` (conversations,
outils, événements, sur trente jours en jours du Pacifique). 🔴 **La relecture a trouvé UN rouge, corrigé dans
`6d0ca755`** : l'écran proposait par défaut le plafond « en réponses », présenté avec un montant en dollars qui se
lisait comme un total, alors qu'il borne CHAQUE conversation. Un client se serait cru protégé après une facture trop
chère, et ne l'était pas. L'unité par défaut est devenue le jeton, et l'écran dit la portée de chacune. Son test a
été vu tomber avec le défaut remis. Les jaunes ont suivi dans `e2ab6d78` après le déploiement : écriture relue chez
Meta, nom du Business Manager à l'écran, refus 403 en 409 français, délai de 8 s sur les statistiques, jours du
Pacifique, `safeParse` du propriétaire, parité des prix.

**Lot 3, les outils MCP jusqu'à l'agent de Meta par la route A (`8f47e605`).** Julien a tranché que les paramètres
sont remplis par l'agent ; mais la console savait déjà régler, paramètre par paramètre, d'où vient une valeur, et
c'est la garde d'identité des agents IA. Le relais la respecte donc : seuls les paramètres `modele` partent chez Meta,
les autres sont posés par nous depuis la fiche du contact (`completerArguments`, sortie de l'exécuteur pour être le
point de passage des deux). Garde vérifiée dans les deux sens. L'onglet Outils propose les outils MCP de la
bibliothèque, refuse un outil non appelable AVANT de le rattacher, et l'écran tolère une API d'avant la route.
Relecture : **0 rouge, 10 jaunes**. Mesuré avant le `up` comme elle le demandait : la production ne porte AUCUN outil
MCP, donc aucun consentement dormant ne pouvait partir chez Meta. Le plus important des jaunes : le relais n'était pas
borné sous les trois secondes de Meta (pire cas : deux fois le délai de l'outil plus la vérification d'adresse). Il
l'est désormais par une course à 2,5 s (`DELAI_REPONSE_MCP_MS`), la session MCP puisant dans le même délai et sa
fermeture n'étant plus attendue. Les trois tests neufs ont été vus tomber sous mutation.

⚠️ **Une mesure de l'e2e a été faite sur un export dont un fichier était MUTÉ, et le patch du lot a été fabriqué à ce
moment-là.** Vu avant l'envoi : fichier restauré, patch refait, relecteur prévenu. La leçon tient en une ligne :
une mutation vit le temps d'UNE mesure, puis on restaure AVANT tout autre geste.

⚠️ **Dans un export en CRLF, le test de parité de l'onglet Outils rend des listes absurdes** : il découpe le source
sur une ligne vide (`'\n\n'`), qu'un fichier en CRLF n'a pas. Le dépôt stocke en LF ; converti en LF, il passe.

Déploiements sans migration, contrôle public à chaque fois, fiches d'aide rechargées après le lot 3. Essais réels
dus (plafond, carte, outils MCP), voir `wip.md`.

⚠️ **Correction du même jour, après mesure : Meta RELIT bien `message_selection`.** Le `GET` des réglages de notre
numéro rend `"message_selection": "CUSTOM"` ; la mesure du matin avait été faite sur un numéro où rien n'était encore
choisi (le bloc est alors absent). La phrase ci-dessus et le commentaire de l'écran disaient le contraire. Conséquence
heureuse : la fusion des réglages (`ecrireReglages`) repasse le choix tel que Meta le rend, aucune écriture ne
l'efface. Mesuré dans la foulée :
- le bac à sable (`agent_test`) ne joue PAS le message de passage : avec `CUSTOM` posé, il rend une phrase rédigée
  par l'agent. C'est ce qui donnait à Julien l'impression que « rédigé par l'agent » était le défaut ;
- en conversation réelle, deux textes sont sortis de l'agent : le texte standard anglais (« Thanks for reaching out!
  I'll ask a representative to respond. Someone will be with you shortly! », une fois, le 30/09) et « Merci d'avoir
  pris contact avec nous. Un membre de l'équipe reprendra la conversation… » (onze fois, du 22 au 30/09), qui n'est
  PAS le message de passage mais l'avis de Meta quand nous prenons le fil pendant le tour de l'agent ;
- le texte `CUSTOM` posé sur notre numéro (« Je transmets votre demande a un membre de l equipe… », sans accents)
  n'a encore servi à aucun passage réel.

À la demande de Julien, la vue d'ensemble a changé le même soir : « Notre texte » ouvre une vraie zone de rédaction
(cocher n'envoie plus rien, « Enregistrer ce texte » écrit chez Meta et dit « Enregistré chez Meta » sur le texte
relu), la carte d'allumage n'est plus que l'interrupteur et « Activé » / « Désactivé », comme sur l'Accueil, et
l'identifiant de l'agent passe à la ligne dans son cadre. ⚠️ Le premier test de cet identifiant comparait des
BOÎTES et restait vert sur le défaut (un texte qui déborde laisse sa boîte dans le cadre) ; il mesure désormais
l'étendue du texte, et tombe de 513 px sur l'écran muté.

**Le soir, l'essai réel des outils MCP, et quatre lots écrits en le faisant.** Julien a branché Microsoft Learn,
puis notre propre serveur MCP, et chaque étape a buté sur quelque chose que les tests ne voyaient pas :

- **Aucun serveur MCP n'était jamais actif** (`27f70b02`). Une source naît `draft`, aucun écran ne l'activait, et
  le résolveur refuse une source inactive : aucun outil MCP n'avait donc jamais pu tourner, ni pour un agent IA ni
  pour l'agent de Meta. Les fixtures créaient leurs sources actives, ce qui cachait tout. L'import active
  désormais le serveur. Test vu rouge sans le correctif en CI, sur une étiquette jetable.
- **Deux étages de choix** (`1b62b2fe`, migration 0199), décidés par Julien : on enregistre sur Connecteurs MCP les
  outils proposés aux agents, puis on choisit sur chaque agent. Un outil importé est enregistré d'office ;
  désenregistrer un outil qu'un agent a est refusé en nommant les agents. Relecture : 0 rouge, 8 jaunes.
- **Trois retouches d'écran demandées pendant l'essai**, console seule : « Connecter » à la place de trois boutons
  (`95f62099`, « Voir ce qui va changer » n'était pas clair), chaque outil en ligne repliée avec une coche et des
  actions groupées (`3dfa1f3b`), et « Appeler un outil MCP » en sixième case de « Ajouter un outil » (`b816dc12`).
- **La lecture d'une réponse MCP était bornée par `max_bytes`** (`9dae3551`) : l'agent de Meta a bien appelé
  `microsoft_code_sample_search` à 16 h 50, et l'appel a échoué en « réponse trop grosse » (Microsoft rend 50 à
  70 Ko, la borne était 16). L'agent a répondu de mémoire, avec du code Azure. Le transport lit jusqu'à 1 Mo, la
  borne s'applique après. Second essai à 17 h 08 : `ok`, 15 Ko.
- **`get_contact` ne trouvait jamais la fiche** (`2ae67ba6`) : il cherchait le texte tel quel, et le relais pose
  l'identifiant WhatsApp sans « + ». `e164DepuisSaisie` ramène les trois formes au E.164 de la fiche. Déployé avec
  le lot 3 « Tout sur la fiche » d'une autre session, qui avait tiré la tête d'origin sur le VPS : on ne lance pas
  `up` sur le lot d'un autre, on se coordonne.

L'essai qui clôt : à 17 h 47, `get_contact` lit la fiche de Julien, mais le journal porte `phone` dans les
arguments du MODÈLE, donc la garde d'identité n'était pas réglée (le réglage n'avait pas été enregistré). Réglé
(`contact` / `wa_id`) et republié : chez Meta, l'outil ne déclare plus aucun paramètre. À 18 h 05, une question sur
un autre numéro est refusée par l'agent lui-même, sans appel. ⚠️ Changer la source d'un paramètre ne republie pas
tout seul : c'est noté au `todo.md`.

## 2026-10-01 : l'aperçu et l'import d'un site ont une échéance par requête

Décidé par Julien le jour même, sur le point que la relecture du lot des pages web avait laissé au `todo.md` : un
parcours de site n'avait AUCUNE durée maximale. Une page écartée ne comptait pas dans les cinquante, et une page
pouvait attendre une cinquantaine de secondes (10 s par saut, quatre sauts, plus la résolution DNS) : un accueil de
mille liens lents faisait durer un aperçu des heures, pages lues gardées en mémoire. Mesuré avant d'écrire : NPM ne
pose aucun `proxy_read_timeout` (configuration de `api.` et de `mba.` lue sur le VPS), c'est donc le défaut de nginx,
60 s sans réponse, qui coupe en premier, avant les 100 s de Cloudflare ; la console n'a aucun délai de son côté. Tout
aperçu ou import plus long finissait déjà en 504 pour le client, pendant que le serveur continuait.

Une échéance de 30 s de réseau par requête (`ECHEANCE_PARCOURS_MS`, `src/http/agent-knowledge.ts`), portée par un
signal d'abandon : `fetchUrlBorne` arrête la lecture en cours à la première des deux échéances (la sienne, 10 s par
saut, ou celle de la requête) et ne lance plus rien après ; `visiter` s'arrête et le dit (`tempsAtteint`), comme son
plafond. 30 s de réseau, 3 s de résolution DNS (qui ne se laisse pas interrompre) et les 20 s de lecture tiennent sous
les 60 s de NPM. L'aperçu rend `tempsAtteint` ; l'import lit tant qu'il a le temps, écrit ce qu'il a lu, et rend les
pages qu'il n'a pas eu le temps de lire (`restantes`), que la console propose d'un clic ; si l'échéance n'en a laissé
lire aucune, un 422 dit que le temps a manqué. Chaque coupure est journalisée (`parcours_coupe`) : c'est ce qui dira si
de vrais sites sont trop lents, et si lire les pages quatre à la fois devient utile (au `todo.md`). Les deux champs
sont facultatifs pour la console : une console en avance sur l'API, ou l'inverse, ne casse rien.

⚠️ **Le typecheck a attrapé ce qu'aucun test n'aurait vu au premier passage** : la route a sa propre fonction
`journaliser` (l'historique des fiches supprimées), qui masquait l'import du journal. Les deux appels de
`parcours_coupe` auraient appelé l'historique avec de mauvais arguments ; le journal s'importe désormais sous un autre
nom. Et deux défauts de mes propres tests, vus avant de conclure : un faux site dont la page d'accueil, déjà répondue,
gardait son écouteur d'abandon et se comptait comme coupée ; et un espion de `console.warn` lu après `mockRestore`,
qui efface les appels enregistrés.

`features.md` décrit désormais la lecture d'un site entier (elle n'y était pas) avec sa limite, et la fiche d'aide
« Construire un agent IA » suit, empreinte comprise.

**La relecture du lot (`bf53929a`) : aucun rouge, dix jaunes, corrigés dans la foulée** et relus avec le lot
suivant. Elle a MESURÉ ce que les tests ne disaient pas : la lecture en cours est bien coupée à l'échéance, y compris
quand le corps de la page arrive au compte-gouttes (1 013 ms pour une échéance d'une seconde, connexion fermée), et la
FAQ de l'agent de Meta, qui lit sans signal, coupe toujours à 10 s comme avant. Les jaunes qui changent le
comportement : une échéance qui coupe la DERNIÈRE page de la file n'était pas dite (l'aperçu annonçait un site
complet, sans journal) ; les pages restantes disparaissaient au premier autre geste (corriger une fiche obligeait à
refaire l'aperçu et l'import d'un site lent) ; et un défaut antérieur au lot, sur lequel il accrochait son message :
l'écran comparait le TOTAL écrit par un import de site au plafond de fiches PAR PAGE, et quarante fiches réparties
sur plusieurs pages annonçaient une page tronquée qui ne l'était pas. L'import nomme désormais ces pages
(`tronquees`). La somme des délais n'était tenue que par un commentaire, qui oubliait les écritures de l'import
(une transaction par page, après les lectures) : un test la tient, réseau, résolution, lecture et écritures sous les
60 s de NPM. Et trois mutations survivaient : le délai de chaque saut retiré, la résolution DNS lancée après
l'échéance, l'import qui ignorait l'échéance (le 422 disait « temps » par la raison de la page coupée) ; un test pour
chacune. ⚠️ Le plan de déploiement oubliait `aide:charger` : la fiche modifiée ne serait jamais arrivée au bot d'aide.

**En production depuis le 2026-10-02 à 7 h UTC** (`2f5ef261`, le lot et ses jaunes). Le VPS était sur `23159e8f`, que
la session voisine venait de déployer : entre les deux, `main` n'ajoutait que des documents. CI lue job par job
(serveur et console), `merge --ff-only` du commit exact, `up -d --build`, NPM rechargé après `healthy`,
`aide:charger` (26 fiches, dont la mienne et quatre fiches de sessions voisines, déjà relues), fumée publique verte,
aucune erreur au journal de l'API. L'essai réel, par une sonde dans `mba-api` effacée ensuite, avec le vrai code de
lecture et le vrai parcours sur le vrai réseau : une adresse publique qui répond en 8 s, sous une échéance de 2 s, est
coupée net à 2,02 s ; un vrai parcours sous une échéance de 1,5 s lit trois pages, s'arrête et le dit
(`tempsAtteint`) ; la vitrine, sous l'échéance de production, est lue entière (dix pages, rien d'écarté) en 1,5 s.

## 2026-10-01 : essai réel du « Traité », et la réouverture devient une escalade (`23159e8f`)

Sur la conversation de Julien (espace MessagingMe), délai de reprise réglé à 1 minute le temps de l'essai puis remis
à vide, chaque étape relue en base par une sonde en lecture seule.

- **Ce qui marche** : « Traité » relance le délai depuis le clic ; un message dans la minute reste à l'équipe, sans
  réponse de l'agent, rouvre la conversation et ouvre une demande (`escaladee`, cause réouverture) ; un message
  après le délai repart à l'agent (`rendue_mba`, « le contact réécrit après le délai de reprise »), qui répond en
  13 s, sans demande ; « Rendre la main » sans erreur.
- **Le trou** : la demande ouverte par la réouverture ne posait pas `escaladee_le`. Le délai courait donc toujours
  depuis « Traité », et le balayage (toutes les 5 min) a rendu la conversation à l'agent, le « Ok » du client sans
  réponse de personne. Avec le délai réel de 2 h, un client qui réécrit 1 h 50 après « Traité » ne laissait que
  10 min à l'équipe.
- **Décision de Julien** : la réouverture est une escalade. `ouvrirUneDemande` pose `escaladee_le` dans la même
  requête que l'événement, comme `setControlOwner` le faisait déjà pour une demande ouverte par une bascule. Test
  vérifié dans les deux sens, déployé, puis rejoué en réel : le balayage suivant, délai échu, a laissé la
  conversation à l'équipe.
- **Le point de départ, qui était la règle** : une escalade de l'agent de Meta de la veille restait à l'équipe 12 h
  plus tard, sans réponse (une escalade sans réponse n'est jamais rendue). Le message de passation de l'agent est en
  anglais (`todo.md`).
- **Incident de doc** : la mise à jour de `features.md` qui a suivi a périmé une seconde fiche d'aide
  (`repondre-dans-l-inbox`), poussée sans que le push soit conditionné au test ; réparée dix minutes plus tard
  (`08cf7b8a`), avant tout commit de code d'un pair. La règle est dans `CLAUDE.md`.

## 2026-09-29 et 30 : l'agent de Meta en mode liste, le KPI Performance, le délai de reprise, et les publicités dans les coûts

- **Mode liste de l'agent de Meta** (`3b006402`, spec `caf45bf6`, plan `3202c5fe`, migration 0195) : demande de
  Julien, l'agent se tait pendant un scénario et ne parle que quand le client fait quelque chose d'imprévu.
  `ai_audience: ALLOWLISTED_ONLY` toujours posé, la plateforme tient la liste (`mba_liste`). Règle 1 : un modèle
  retire le contact avant de partir (`retirerAvantUnModele`, câblé dans `clientForTenant`). Règle 2 : un message
  que personne ne prend est confié (ajout, `release`, `agent_event`, événement `message_sans_suite`). Le correctif
  `a3d67af7` et la fausse action `take` sont retirés. Essai réel en quatre étapes réussi.
- **Les mesures Meta qui ont décidé du lot** : un modèle rend le fil à l'agent, un message libre le prend ; `take`
  ne sert à rien ; un `release` est refusé quand l'agent tient déjà le fil ; un ajout en double à la liste rend 400
  sans code distinctif (d'où notre table, et la relecture de la liste sur un 400) ; un `standby` d'un contact absent
  de la liste est requalifié en `messages`.
- **KPI Quantitatif > Performance** (`d8d481bd`, 0194 ; correctif `6aff2337`) : demandes calculées à la lecture
  depuis `conversation_evenements`. Arbitrages de Julien : le chrono part au message du client, la fin automatique
  arrête la résolution à la dernière réponse de l'équipe. Essai réel : une demande, 2 min 1 s de réponse, 2 min 4 s
  de résolution.
- **« Traité » et le délai de reprise** (`53c112e8`) : « Traité » relance le délai depuis le clic ; après le délai,
  un client qui écrit dans une conversation de l'équipe part à l'agent tout de suite, même après 24 h ; avant, une
  réouverture d'une conversation « Traité » ou archivée ouvre une demande. La relecture a trouvé deux rouges,
  corrigés : un message reçu par un parcours était rejoué par la remise, et la réponse à une campagne au devenir
  Inbox, sur un fil de l'équipe au délai échu, partait à l'agent. Essai réel le 2026-10-01 (entrée précédente).
- **La miniature du modèle dans le bloc « Envoi template »** (`fc979f27`).
- **Impressions et couverture des publicités** (`3be8e309`, 0197) : `impressions` et `reach` lus dans le même appel
  que dépense et clics, `entierOuRien` sur les trois comptes. Premières valeurs réelles : 230 impressions,
  217 personnes, 1,30 €, 5 clics.
- **Coût par engagement des publicités CTWA** (`7ace4c9b`, puis `c6255bd4` et `5c740c73` ; 0198) : arbitrages de
  Julien en quatre questions (deux accordéons, chiffre du haut tout confondu, dépense par jour pour suivre la
  période, et une campagne sans engagé qui garde sa dépense au numérateur). Mesuré avant d'écrire, sur la vraie
  campagne : `time_increment(1)` rend une ligne par jour de diffusion dont la somme égale le cumul, et l'alias
  `.as(jours)` fait passer les deux lectures dans le même appel. Relecture indépendante : 0 rouge, 14 jaunes, 8
  corrigés et déployés, le reste dans `todo.md`. Les 47 e2e de la carte Coûts lancés à la main (ils ne tournent pas
  en CI). Vu à l'écran par Julien, dépense recoupée avec le Gestionnaire de Meta.
- **Incidents** :
  - `8190c1ea`, un commit de doc seule (donc sans CI), a périmé la fiche d'aide `creer-une-publicite` ; le job
    `unit` d'un pair (`ed9aa451`) est devenu rouge, réparé par lui (`9f942d18`).
  - L'embarquement de Groupama PJ ne montrait que le portefeuille Aux'R'M dans la fenêtre de Meta. Plusieurs
    hypothèses de configuration ont été explorées (intégrations, `business_management`, MM Lite, cas d'usage
    publicitaire) : la cause était une erreur de manipulation côté Facebook, aucun code n'était en cause. Le numéro
    est branché depuis.
- **App Review des publicités** : un texte et une vidéo PAR permission (doc Meta), inutile tant qu'un admin de l'app
  branche le compte d'un client (accès standard, mesuré sur Groupama PJ).

## 2026-10-01 : tout sur la fiche, lot 2b, filtrer et conditionner sur la dernière analyse

**Serveur (`8b9e92fc`), déployé le 2026-10-01 vers 1 h 40 (heure de Paris), puis console (`76485b62`).** Les
filtres de la liste des contacts et du ciblage d'une campagne acceptent les champs de la dernière analyse, et le
bloc Condition d'un scénario les évalue avec la MÊME sémantique (`src/crm/filtre-fiche.ts`, un seul module pur
pour le SQL et l'évaluation en mémoire). Route `GET /tenants/:t/champs-fiche`. Aucune migration : mesuré avant
d'écrire, 22 fiches actives en production, 17 au plus par espace, aucun index justifié.

🔴 **Le piège qui aurait élargi une audience : un refus avalé par un `catch`.** `parseFilters` normalisait les
filtres de champ DANS le `try` qui décode leur JSON. Un filtre d'analyse invalide y lève `FiltreContactInvalide`,
que le `catch` aurait transformé en « aucun filtre », donc en tout l'espace pour une campagne. La normalisation
est sortie du `try`, et un test vérifié par mutation le tient. Même famille, deux autres gardes : un filtre qui
n'a pas traversé la validation pose `false` (personne), jamais l'absence de clause ; un opérateur inconnu sur une
clé d'analyse est refusé, jamais ramené à `eq` (« urgence au moins 7 » serait devenu « égale à 7 »).

⚠️ **La parité SQL et évaluateur est tenue contre une VRAIE base** (`tests/integration/filtre-fiche.integration.test.ts`,
job `integration`, vert) : pour chaque filtre, les fiches que retient la requête sont exactement celles que
retient le bloc Condition, `null`, 0 et `false` compris.

⚠️ **Relecture indépendante : aucun rouge, un jaune corrigé avant le commit** : le bloc Condition pouvait lire le
SUJET de l'analyse par les opérateurs texte génériques, alors que la décision 12 le déclare non filtrable. La
garde de `attributeOrField` (qui protégeait déjà les clés filtrables contre un champ perso homonyme) rend
désormais `null` pour le sujet.

⚠️ **Deux défauts évités en écrivant, que le compilateur ne voyait pas** : React n'est pas résoluble depuis la
suite racine en CI (le job `unit` n'installe pas `web/`), d'où le hook sorti dans `web/lib/use-champs-filtrables.ts`
pour que `web/lib/champs-fiche.ts` reste testable ; et une garde des formulaires Flow sur `nom` aurait bloqué la
question la plus courante (vu au lot 2a, même raisonnement ici : le panneau n'exige rien sur les clés de base).

**Vérifié en production par le vrai code, en lecture seule, sur l'espace d'essai** : la copie d'analyse de la
fiche de Julien est dans l'état du bloc Condition et absente des champs perso ; « sentiment neutre » compte 1
fiche, « négatif » 0, « jamais analysée » 16 sur 17 ; un seuil de 42 est refusé en 400 ; la condition tranche
comme le filtre. Contrôle public complet après le `up`, fiches d'aide rechargées (`aide:charger`, 26).

Le déploiement a emporté `92a67808` et `3eb27889`, le lot des pages web d'une session voisine (relu, CI verte,
sans migration), prévenue ; son essai réel lui reste. **Reste l'essai réel du lot 2**, à faire par Julien : un
message mécontent sur l'espace d'essai, puis « sentiment négatif, urgence au moins 7 » dans la liste et dans le
ciblage d'une campagne.

## 2026-10-01 : les pages d'un site se lisent hors de la boucle, après le déploiement de `5e8bc5b5`

**`5e8bc5b5` est en production depuis le 2026-09-30 à 21 h 22 UTC**, par un `checkout` détaché de ce commit
(`main` portait déjà le travail d'autres sessions), CI lue job par job, `up -d --build`, fumée publique verte.
L'essai réel, par une sonde dans `mba-api` effacée ensuite : un CSV « guillemets et espaces » de 330 Ko est refusé en
400 à 10,0 s, et la boucle n'a pas pris plus de 15 ms de retard pendant ce temps ; un document CSV déposé dans la
connaissance d'un agent rend sa fiche ; le plus gros vrai fichier (762 600 numéros) se lit en 5,9 s, mais bloque
encore la boucle 1,2 s au RETOUR (relire le JSON, reconstruire les rangées). Le `todo.md` annonçait 0,18 s : c'était
la seule relecture, mesurée sur le poste. Corrigé là-bas, et laissé hors de ce lot : y remédier demande de faire
arriver les rangées par morceaux.

**Les pages d'un site** (aperçu et import de la connaissance d'un agent) étaient le dernier chemin de lecture resté
dans le fil principal : `pageEnFiches` coûtait 2,2 s pour 40 Ko de `<`, `liensDeLaPage` 1,2 s pour 90 Ko de `<a `
suivis d'un seul `>`, en temps quadratique, sur des pages qui peuvent faire 2 Mo. Un site en compte jusqu'à cinquante,
à deux lectures chacune : un worker par lecture aurait ajouté 50 s de démarrages à un aperçu. D'où le LECTEUR
(`avecLecteur`, `src/lib/hors-boucle.ts`) : un worker gardé le temps d'une requête, qui lit une chose à la fois et
meurt avec le travail qu'on lui confie. `horsBoucle` en devient la lecture unique, et le worker passe d'un appel
unique à une boucle de messages. Trois choix, chacun tenu par un test : l'échéance est CUMULÉE sur les lectures d'un
lecteur (20 s pour les pages d'une requête ; par lecture, une page hostile tiendrait un worker jusqu'à l'échéance,
cinquante fois de suite) ; une place du plafond de quatre se prend PAR LECTURE, pas pour la vie du lecteur (un aperçu
attend surtout le réseau) ; et l'import lit et découpe toutes ses pages AVANT d'en écrire une, pour qu'un refus en
cours de route n'en laisse pas la moitié derrière une réponse d'erreur. `visiter` reçoit l'extraction des liens en
paramètre, sans défaut.

Tests : le lecteur (même worker d'une lecture à l'autre ; worker tué à la fin du travail comme à l'échéance, vu à
l'arrêt d'un compteur partagé qu'il faisait battre ; échéance cumulée ; lecteur au repos sans place ; une lecture à la
fois ; refus qui parle de pages) ; la propriété de boucle sur l'aperçu, avec une page qui ne ralentit QUE les liens et
une autre QUE les fiches, pour que l'oubli de l'une ne se cache pas derrière l'autre, et sur l'import ; l'ordre
lectures puis écritures ; l'inventaire étendu à `pageEnFiches` et `liensDeLaPage`. Mutations attrapées : les liens,
puis les fiches de l'aperçu, puis celles de l'import ramenés dans le fil principal ; l'import réécrit page par page ;
l'échéance remise par lecture ; la place gardée toute la vie du lecteur ; la fin du travail, puis l'échéance, qui ne
tuent plus le worker ; la garde d'une lecture à la fois retirée ; un refus qui parle toujours de fichier ; `visiter`
qui rappelle `liensDeLaPage` en direct ; un worker qui ne répond qu'à un message ; la place prise avant que la lecture
parte. ⚠️ Le premier jet de la mutation « place gardée toute la vie du lecteur » est passé : son compte devenait
négatif sur un test antérieur du même fichier, ce qui ouvrait le plafond. C'est la mutation qui était fausse, pas le
test ; refaite avec un compte juste, elle tombe. Une mutation qui passe se relit avant de conclure que le test est
faible.

**La relecture du lot (`92a67808`) : aucun rouge, huit jaunes, corrigés dans la foulée** et relus avec le lot
suivant, comme le veut la règle des jaunes. Le plus lourd : le plafond de quatre bornait les lectures, plus les
workers vivants. Un worker au repos pèse 15 à 25 Mo, un aperçu attend surtout le réseau, et un parcours n'a pas de
durée maximale (une page écartée ne compte pas dans les cinquante) : quelques centaines d'aperçus en vol sur un site
aux liens lents auraient fait tomber `mba-api`, qui n'a pas de limite de mémoire. Un lecteur rend désormais son
worker après 5 s de repos (`REPOS_MS`), et sa lecture suivante en démarre un autre. La durée du parcours elle-même
reste sans borne, antérieure au lot : au `todo.md`, avec le 429 qui peut tomber en cours de parcours. Corrigés
aussi : une lecture que son travail n'attend pas ne peut plus faire tomber le process (un rejet sans gestionnaire) ;
l'inventaire refuse le passage en référence, plus seulement l'appel ; le test de l'échéance enchaîne quatre échéances,
parce qu'une place perdue en laissait trois et passait inaperçue ; un 429 ne démarre aucun worker, et c'est compté ;
le 404 de l'import sur l'agent d'un autre espace est tenu par un test ; et les textes (la marge de 1,7 du plus gros
vrai CSV sous l'échéance en production, les 50 s de démarrages évités, les 3,3 places qu'un seul espace tient en
continu). Chaque correctif est vérifié dans les deux sens, par mutation.

**En production depuis le 2026-09-30 à 23 h 35 UTC**, par le déploiement d'une session voisine (`8b9e92fc`, son lot
2b, qui contient `92a67808` et `3eb27889`, CI verte job par job) : rien n'a été redéployé de ce côté, ce qui aurait
retiré son lot. L'essai réel, par une sonde dans `mba-api` (un processus à part) effacée ensuite : la vraie page de la
vitrine (60 Ko) rend par le worker les mêmes quatre fiches et les mêmes six liens qu'en lecture directe, en 549 ms,
la boucle retardée de 14 ms ; une page hostile de 100 Ko est refusée en 400 à 20,0 s, la boucle retardée de 18 ms ;
et un lecteur rend bien son worker après 5 s de repos (le même fil à 1 s d'écart, un autre après 6 s). Fumée
publique verte. ⚠️ Le premier passage de la sonde est tombé sur SON propre fichier : un module TypeScript posé dans
`/tmp`, sans `package.json` en mode module, est lu en CommonJS par tsx, et un import dynamique n'y voit plus ses
exports nommés (« f is not a function »). Les modules de l'application, sous `/app`, ne sont pas concernés.

## 2026-09-30 : tout sur la fiche, lots 1 et 2a, et la fiche contact en onglets

**Lot 1 (`187b36bb`, `4938172b`, jaunes `657fad5a`).** La dernière analyse d'une conversation est recopiée sur la
fiche du contact, dans la transaction même de `save`, et survit à l'effacement de la conversation. Migration 0196
appliquée le 2026-09-30 à 16 h 30 UTC, AVANT le code : onze colonnes nullables sans défaut, un CHECK de cohérence
(la copie est entière ou absente), un index partiel construit `CONCURRENTLY` sous un `lock_timeout` de 5 s. Règle de
la plus récente : une analyse n'écrase la copie que si sa borne de fenêtre est postérieure ou égale, l'ancienne
copie étant lue `for update`, donc deux conversations d'un même contact analysées en parallèle ne s'écrasent pas à
rebours. Aucune reprise de l'historique (décision de Julien : « au fil de l'eau »).

⚠️ **Le risque de départ lisait déjà les analyses des 90 derniers jours, et le brancher sur la seule copie aurait
effacé ce passé au déploiement**, puisqu'aucune fiche n'en portait encore. Il lit la copie quand elle existe et
retombe sur les conversations pour une fiche sans copie. Trouvé en relisant avant la revue, pas par un test.

Premier essai réel : un message de Julien, analysé dans l'espace SANDBOX, a posé la copie sur sa fiche.

**Les onglets de la fiche (`18dce92d`, `324fdac6`)** : Fiche, Tags, Champs, Analyse, Historique. 🔴 **Le premier
commit a rendu la CI front rouge** : les onglets portaient `role="tab"`, et `contact-bilan.spec.ts` trouve le bouton
Historique par `getByRole('button')`. Un rôle ARIA change la façon dont les tests trouvent l'élément : avant de
changer le rôle ou le libellé d'un élément, on cherche dans tout `web/e2e` qui s'y appuie. Les onglets sont
redevenus des boutons, et 21 cas e2e ont été rejoués en local.

**Lot 2a (`5e2af1b1` serveur, `4b29bb53` console, jaunes `ec6832d5`).** Une liste unique des champs de la fiche
(`src/crm/champs-fiche.ts`), que les connecteurs lisent : l'origine `fiche` remplace `contact:*` et
`systeme:analyse_*`, qui sont RELUES (réécrites à la lecture comme à l'enregistrement), jamais refusées.
`ficheDuContact` est une dépendance REQUISE du résolveur. Les clés de la liste sont réservées : ni la bibliothèque
de champs, ni l'import CSV, ni l'API, ni un formulaire Flow ne peuvent en faire un champ perso.

🔴 **Le cas par défaut de `resoudreVariable` rendait l'origine ELLE-MÊME** : une forme non réécrite partait comme
valeur, l'objet entier dans le corps envoyé au client. Trouvé par un test de poussée d'opt-out qui envoyait
`{"phone":{"type":"contact",...}}`. Il rend `null`, et le test est vérifié dans les deux sens.

⚠️ **L'ordre de déploiement : le serveur, PUIS la console**, parce qu'une API d'avant refuse `fiche:*` à
l'enregistrement. Le serveur est parti après le `5e8bc5b5` d'une session voisine, et il a été vérifié par le vrai
code dans le conteneur : `ficheDuContact` sur la fiche SANDBOX rend la dernière analyse, et la requête `signaler`
est relue en `fiche:wa_id`.

⚠️ **La garde des formulaires Flow exempte `nom` et `wa_id`** (jaunes) : la garde complète cassait la création
d'un formulaire avec une question « Nom », mesuré par mutation (quatre tests existants rouges). Les jaunes ne sont
pas encore sur le VPS : ils partent avec le prochain déploiement serveur.

## 2026-09-30 : un fichier déposé se lit hors de la boucle d'événements

Décidé par Julien le jour même, après la relecture du plafond de lignes : sous toutes les bornes de forme posées sur
un CSV, des fichiers de quelques centaines de Ko tenaient encore la boucle de `mba-api` des secondes à des minutes
(guillemets mal placés suivis d'espaces, N x K dans papaparse ; doublons d'en-tête ; puis, dans la connaissance d'un
agent, un .docx de 227 octets et un texte de lignes courtes). Chaque borne fermait une forme, chaque relecture en
trouvait d'autres : on borne désormais le TEMPS.

`src/lib/hors-boucle.ts` lance un worker par lecture (tsx s'y enregistre lui-même : sous Node 22, celui dont il hérite
n'enregistre pas ses hooks hors du fil principal), avec une échéance (10 s ; 30 s pour un document, pour ne pas
refuser un vrai gros PDF que la boucle supportait en la bloquant), 1 Go de tas, et quatre lectures à la fois (429
au-delà : la FAQ et les pièces jointes de l'assistant n'ont pas le plafond coûteux, et le VPS a huit cœurs pour tous
ses services). Chaque refus est journalisé. Les lectures restent des fonctions pures (synchrones, sauf
`extraireTexte`) ; chaque module expose sa version `...HorsBoucle`, que les routes appellent : import de contacts et
son aperçu, FAQ de l'agent de Meta (corps, URL en CSV ou en HTML), connaissance d'un agent, pièces jointes de
l'assistant. `pageEnFiches` (import d'une page ou d'un site) reste dans le fil principal : lot suivant, en rouge au
`todo.md`.

La relecture du lot a trouvé ce que le worker ne borne pas : son RETOUR. Un CSV forgé de 7,9 Mo (16 384 noms de 200
caractères, 140 rangées pleines) rendait 473 Mo de JSON, les noms répétés à chaque rangée, et le fil principal payait
1,8 s et 1,4 Go pour les relire. D'où trois choix : les rangées d'un import voyagent indexées par numéro de colonne
(0,8 s et 228 Mo de tas sur le même fichier, reconstruites par nom sur le fil principal) ; l'aperçu ne rapporte que
quatre rangées (0,12 s) ; et un document se lit en UN seul worker, de sa nature à ses fiches, dont seules les fiches
reviennent (trois workers par dépôt, premier jet, dépassaient les 5 s des tests sous la suite complète). Elle a aussi
trouvé que le compteur montait avant `new Worker` : quatre workers qui ne démarrent pas auraient rendu 429 à tout le
monde jusqu'au redémarrage.

Éprouvé dans un conteneur jetable lancé depuis l'image de production (Node 22.23.2, tsx, sans les dépendances de dev)
: démarrage et résultat en 0,5 s, refus à 400 conservé, une lecture de 3,7 s ne retarde la boucle que de 12 ms,
l'échéance coupe en 400. Tests : le helper (résultat, erreur à `statusCode`, échéance, boucle libre, 429, worker qui
ne démarre pas) ; une propriété par route, la boucle jamais bloquée plus du quart de la durée d'une lecture lente,
rouge sur le code d'avant (2,5 à 3,1 s de blocage) ; et un inventaire qui refuse tout appel direct de ces lectures
hors de leurs modules. ⚠️ Le premier jet du test de boucle ne voyait rien : la promesse de la requête se résolvait
juste après le blocage, avant que le minuteur en retard ne l'ait constaté (17 ms mesurés pour 1,7 s de blocage réel) ;
`tests/boucle.ts` laisse désormais passer un tour de minuteur avant de lire le retard. Mutations attrapées : chaque
enveloppe rendue synchrone, plafond retiré, échéance retirée, compteur remonté avant `new Worker`, décodage des
rangées décalé, aperçu vidé de ses exemples, une route ramenée à l'appel direct.

## 2026-09-30 : la normalisation d'un document texte redevient linéaire

Vu en passant par la relecture du plafond de lignes des CSV : `normaliser` (`src/agent/setup/piece-jointe.ts`), qui
coupe les bords de tout document texte de la connaissance d'un agent (8 Mo au plus), coupait la fin par
`[^\S\t]+$`. L'expression repartait de chaque espace d'une série qui n'est pas en fin de texte : coût quadratique,
100 000 espaces au milieu d'un texte tenaient la boucle d'événements 5,6 s. Le début garde son expression, ancrée
donc linéaire ; la fin se coupe par `trimEnd`, en gardant la dernière tabulation quand elle est dans la fin (une
boucle caractère par caractère, premier jet, coûtait 0,4 à 0,8 s sur 8 Mo de blancs ; `trimEnd` 35 à 70 ms, mesuré
par la relecture). Les bords ne bougent pas : le BOM et les espaces partent, les tabulations restent (la case d'angle
d'un TSV), et la relecture n'a trouvé aucun écart avec l'ancienne expression sur 2,4 millions de comparaisons. Test
rouge sur le code d'avant (5,6 s), vert après ; mutations attrapées : tabulation de fin coupée, fin non coupée,
ancienne expression remise.

La même relecture a trouvé deux défauts de même gravité dans ce fichier, antérieurs, consignés en rouge dans
`todo.md` : les expressions de `texteDocx` (quadratiques sur un `document.xml` de chevrons, 8,2 s pour un .docx de
227 octets) et le découpage de `texteEnFiches` (quadratique sur une suite de lignes courtes, 10 s pour 120 Ko).

## 2026-09-30 : une purge pendant un run de campagne n'envoie plus rien à la personne effacée

**`5ef5b33f` déployé** le 2026-09-30 à 17 h 36 UTC, après sa CI verte job par job (`unit`, `securite`,
`integration`) : `mba-api` et `mba-worker` reconstruits, API saine, worker sur ses dix files, NPM rechargé,
`fumee.mjs` vert sur les six chemins. Le correctif est lu dans les deux conteneurs.

Le moteur lit la liste d'un run UNE fois, vrai numéro compris, et un run étalé dure des heures. Juste avant
chaque envoi, `claim` relisait la fiche, mais n'écartait que le STOP et le blocage. Une purge tombée pendant le
run sur une fiche ni désabonnée ni bloquée laissait donc partir le message vers le vrai numéro, APRÈS
l'effacement demandé. Relu après la purge, le destinataire portait `to_e164 = 'anonyme'` et partait chez Meta
sous ce « numéro », ou démarrait un parcours sur ce wa_id. Voisin : les balayages de relance reprenaient la
ligne purgée en échec, et le second 131026 envoyait `anonyme` à HubSpot. Sans migration, l'API seule change.

**Un seul point de passage, et c'est pour ça qu'il suffit.** `claim` écarte d'abord une fiche purgée
(`anonymized_at`, écart `efface`, marqué `skipped` avec son motif), avant le STOP et le blocage. Tout chemin qui
remet un destinataire en attente (relance, bascule, renvoi manuel `resetRecipientForRetry`, relevé le même jour
par la relecture de `PATCH /contacts/:id`) repasse par elle. Les listes de relance et de bascule excluent en plus
les lignes purgées (`NON_PURGE_SQL`) : elles gardent leur statut, donc les totaux, et plus rien ne part vers
HubSpot. La purge garde toujours opt-in, dates de STOP et de blocage ; seule la raison écrite a changé.

**Vérifié dans les deux sens** sur un Postgres jetable du VPS : trois mutations (la ligne de `claim`, le filtre
de `listAutoRetry`, celui de `listCandidatsBascule`), chacune fait tomber le test neuf sur sa propre assertion.
Reste ouvert, hors de ce lot : une purge validée entre `claim` et l'appel à Meta, ou pendant la boucle du second
131026 (le numéro part vers HubSpot tel que lu au `select`). La fenêtre n'est plus un run entier, mais un appel.

## 2026-09-30 : `PATCH /contacts/:id` rend 404 sur une fiche purgée, et ne la réécrit plus

`applyEdits`, l'écriture de la fiche depuis la console, ne filtrait `deleted_at is null` nulle part : ni son
`select ... for update`, ni ses `update`, ni sa relecture. Sur une fiche purgée, un admin recevait 200, voyait
consentement, blocage et risque dans la réponse, et pouvait réécrire nom, champs, étiquettes et consentement sur
la ligne anonymisée, dont l'identifiant survit dans `campaign_recipients.contact_id` et le journal d'audit. Le
pire cas : repasser en `opted_in` une fiche purgée après un STOP, alors que ce refus est précisément ce que la
purge garde pour `claim`. Aucune automation ne partait (`waIdOfContact` filtre déjà). Le défaut violait
l'invariant écrit dans `documentation.md` (§ Contacts, « un écrivain qui vise une fiche par son identifiant
filtre `deleted_at is null` »). Sans migration, l'API seule change.

**Déployé** le 2026-09-30 à 17 h 35 UTC (`ed9aa451`, avec la fiche d'aide `9f942d18`), après la CI verte job par
job : `mba-api` et `mba-worker` reconstruits, NPM rechargé, `scripts/fumee.mjs` vert sur ses six chemins. Sonde
exécutée PAR LE VRAI CODE dans `mba-api` sur la dernière fiche purgée de la production, avec des éditions VIDES
(aucune écriture possible, même sans le correctif) : `applyEdits` et `getById` rendent null, `updated_at`
inchangé, et une fiche active reste lue. Effacée ensuite. ⚠️ La CI de `ed9aa451` était rouge sur `unit`, pour
une cause étrangère : `8190c1ea`, un commit de `.md` seul donc sans CI, avait changé la section des publicités
de `features.md` sans la fiche d'aide qui la cite (`tests/aide-proposer.test.ts`). Réparée par `9f942d18`. Et la
CI relancée sur `main` a été ANNULÉE par le push d'une autre session (même groupe de concurrence) : elle a été
rejouée sur une étiquette jetable, que ce push ne pouvait pas annuler.

**Le filtre est posé au verrou, pas seulement à la relecture.** Les `update` qui suivent n'ont que `id` et
`tenant_id` : ne filtrer que la relecture aurait rendu 404 APRÈS avoir écrit, ce qu'aucune réponse HTTP ne
montre. `SELECT_ONE` filtre aussi, donc `getById` (que seuls des tests lisent) rend null sur une fiche
supprimée. La route traitait déjà null en 404. Face à une purge concurrente : validée avant, la ligne est
invisible ; écrite mais pas validée, le verrou l'attend puis Postgres réévalue le `where` et ne la rend pas ;
verrouillée d'abord par l'édition, c'est la purge qui attend, puis efface par-dessus. Le seul appel de l'écran
qui y menait encore est le renvoi du détail de campagne (`contactId` tiré de `campaign_recipients`) : il répond
désormais « contact inconnu ».

**Vérifié dans les deux sens** sur un Postgres jetable du VPS (cf. « Vérifier un test d'INTÉGRATION sans
attendre la CI ») : code d'origine, filtre du verrou seul retiré, filtre de la relecture seul retiré. Chacune
fait tomber le test neuf sur son symptôme ; sans le filtre du verrou, la fiche purgée repasse en `opted_in` sous
le nom « Intrus » alors que la route aurait répondu 404.

Deux points voisins relevés par la relecture, hors de ce lot et sans personne atteinte : les lectures de
`contact-history.pg.ts` (historique, résumé, bilan, export) rendent encore 200 sur une fiche purgée, avec les
seuls compteurs que la purge garde ; et `resetRecipientForRetry` peut remettre en attente un destinataire purgé,
dont l'envoi part vers `anonyme` et échoue.

## 2026-09-30 : un CSV de plus de 1 048 576 lignes est refusé, et `e09d210a` est déployé

**`e09d210a` déployé** le 2026-09-30 vers 15 h 40 UTC, après sa CI verte job par job : `mba-api` et `mba-worker`
recréés, NPM rechargé, le contrôle de fumée public vert sur ses six chemins, aucune migration. Sonde exécutée PAR LE
VRAI CODE dans le conteneur (Node 22, processus à part, effacée ensuite) : un en-tête de 16 385 colonnes refusé en
24 ms, une rangée de séparateurs puis un en-tête refusés en 8 ms, 16 384 colonnes et 1 000 rangées courtes lues en
66 ms, une ligne unique de 8 Mo refusée en 1,4 s (6,2 s avant, mesuré par la relecture).

**Le plafond de lignes** ferme la forme qui restait au même coût, décidé par Julien le jour même : 8 Mo de lignes d'un
caractère (près de 3 millions de rangées dans le corps JSON, où un saut de ligne pèse deux octets ; papaparse fait un
objet et une erreur « Too few fields » par rangée) coûtaient 4 à 6 s et plus d'un Go de tas. `parseCsv` compte
désormais les fins de ligne avant tout et refuse au-delà de 1 048 576, le maximum d'Excel, lignes vides comprises ;
`\n` et `\r` se comptent à part et le plus grand l'emporte (papaparse accepte l'un, l'autre ou les deux, et `\r\n`
n'en fait qu'une). Le premier jet s'arrêtait à un million : la relecture a montré deux vrais fichiers refusés à tort,
un export Excel dont la plage descend au bas de la feuille et un fichier en `\r\r\n` (le `csv.writer` de Python sous
Windows, deux fins par ligne). La classe du refus devient `CsvTropGros`, pour ses deux causes.

Mesuré sur le poste de dev chargé : les 4 millions de rangées refusées en 50 à 60 ms au lieu de 4 à 6 s ; un million
de lignes d'un caractère encore accepté, 1,9 à 2,7 s, autant qu'un vrai fichier de 8 Mo de numéros seuls. Le
comptage coûte 20 à 71 ms sur 8 Mo (`indexOf`, plus rapide qu'une boucle sur `charCodeAt`). Test rouge sur le code
d'avant (aucun refus), vert après ; les fins de ligne du test vivent dans un champ entre guillemets, que papaparse lit
en une rangée : instantané, et il tient la borne exacte. Mutations attrapées : `\n` seul compté, somme au lieu du
maximum, `>=` au lieu de `>`, contrôle retiré.

🔴 **La relecture de ce lot a trouvé plus grave, antérieur aux deux bornes**, reproduit ensuite et consigné dans
`todo.md` : des guillemets mal placés suivis d'une traîne d'espaces coûtent N x K dans papaparse (101 Ko : 1,5 s ;
330 Ko : 123 s selon la relecture), des doublons d'en-tête coûtent un renommage quadratique, et l'expression régulière
de `normaliser` (`src/agent/setup/piece-jointe.ts`) est quadratique sur une longue série d'espaces. Les bornes de ces
deux lots ne bornent donc pas le temps de lecture ; le remède proposé est un worker thread avec une échéance.

## 2026-09-30 : la purge RGPD vide aussi ce qui décrit la personne, et garde ce qui dit non

`purgeMany` anonymisait le numéro, le nom, les champs, le jeton public et l'identifiant externe, mais laissait
sur la fiche les étiquettes, le risque de désengagement, la langue détectée, la joignabilité WhatsApp, la source
du consentement et l'auteur du blocage. Commit `e215919e`, déployé le jour même (API et worker, sans migration).

**Ce qui part, et pourquoi.** Les étiquettes sont du texte libre (équipe, import, scénario, agent) et restaient
comptées sur la page des étiquettes, pour une liste vide au clic. Le risque est un jugement calculé sur des
faits que la purge efface, et le balayage de nuit ignore les fiches supprimées : il restait figé. La langue vient
des messages effacés, la joignabilité décrit un numéro disparu, la source du consentement peut être un texte
libre de l'intégrateur, et `blocked_by` n'a aucun lecteur.

**Ce qui reste, décidé par Julien.** `opt_in_status`, `opt_out_at`, `blocked_at`, `rcs_optout_at`. Mesuré avant
de décider : aucune recherche par identité ne retrouve une fiche purgée, donc ces refus ne protègent pas un retour
de la personne. Leur seul lecteur est `claim`, pour un run de campagne déjà en cours qui tient le vrai numéro en
mémoire ; les remettre à zéro aurait fait écrire à quelqu'un qui a dit STOP puis demandé l'effacement.

**L'écrivain de joignabilité** (`creerNoteurJoignabilite`) filtre désormais `deleted_at is null` : le balayage
131026 et un envoi en cours réécrivaient sinon la joignabilité d'une fiche purgée, par son identifiant.

**Vérifié dans les deux sens en CI, sans branche**, les tests d'intégration ne tournant pas sur le poste : un
commit portant le test SANS le correctif, poussé sous une ÉTIQUETTE jetable (`git push origin <sha>:refs/tags/x`)
et joué par `gh workflow run ci.yml --ref x`. Sans le correctif, les deux cas neufs échouent ; avec la purge
corrigée mais sans le filtre de l'écrivain, seul le cas de la joignabilité échoue ; au complet, vert. Les
étiquettes ont été supprimées ensuite.

**Les fiches déjà purgées ont été nettoyées une fois**, sur décision de Julien, par le même `set` que la purge,
dans une transaction gardée (compte avant, lignes touchées égales à ce compte, recompte à zéro, sinon
`rollback`) : 6 fiches sur les 7 purgées portaient un résidu, toutes dans un seul espace. `updated_at` n'a pas
été touché, il garde la date de la purge. Relu ensuite : zéro résidu, et le seul désabonné purgé l'est resté.

Deux défauts voisins, hors de ce lot, confiés à des sessions séparées : une campagne en cours envoie encore au
vrai numéro d'un contact purgé qui n'était ni désabonné ni bloqué, et `PATCH /contacts/:id` répond 200 sur une
fiche purgée et peut la réécrire.

## 2026-09-30 : l'en-tête d'un CSV importé est borné à 16 384 colonnes, et une rangée courte n'est plus complétée

Relevé par la relecture du correctif du séparateur : une ligne unique de 8 Mo (`a;a;a...`, 4 millions de champs)
tenait la boucle d'événements de `mba-api` plusieurs secondes, papaparse traitant chaque en-tête, doublons renommés
compris. Un administrateur de n'importe quel espace pouvait le déclencher par `/contacts/import` (8 Mo), son aperçu
(2 Mo) ou l'import de FAQ de l'agent de Meta (1 Mo par le corps, 2 Mo par une URL), et ralentir la console et la
réception des webhooks de tous les espaces.

`parseCsv` (`src/crm/csv.ts`) compte désormais l'en-tête avant la lecture et refuse au-delà de 16 384 colonnes, le
maximum d'Excel : `CsvTropDeColonnes` porte `statusCode = 400`, et le gestionnaire d'erreurs de `src/server.ts` rend
le message en français sur chaque route qui lit un CSV, sans rien écrire ni rien appeler chez Meta.

La relecture du lot a trouvé deux rouges, corrigés avant le premier envoi. **Le contournement** : le contrôle comptait
la première rangée NON VIDE, or papaparse renomme les doublons de la première rangée physique (`''`, `_1`, `_2`...)
AVANT de sauter les vides, si bien qu'une rangée de séparateurs seuls devient l'en-tête. Le contrôle prend donc la
plus large des rangées jusqu'à la première non vide. **L'effet de levier antérieur** : `parseCsv` complétait chaque
rangée jusqu'à la largeur de l'en-tête, soit en-têtes x rangées ; une cellule absente reste désormais absente, ses
trois lecteurs (import de contacts, FAQ, écran d'aperçu) la lisaient déjà comme vide. Le séparateur se fixe une seule fois, avec les réglages de la lecture :
faute de séparateur trouvé, la devinette de papaparse coûte 1,7 à 2,9 s sur 8 Mo et n'est plus refaite.

Mesuré sur le poste de dev (Node 24), un processus neuf par mesure, avant puis après. D'autres sessions chargeaient
le poste et le même code variait du simple au triple : seuls les écarts nets comptent.
- Ligne unique de 8 Mo : 9 à 13 s, puis refusée en 0,9 s.
- Rangée de séparateurs puis un en-tête : 4,0 s sur 1 Mo (76 s sur 8 Mo selon la relecture), puis refusée en 0,1 s
  sur 1 Mo et en 0,9 s sur 8 Mo.
- En-tête de 16 384 colonnes puis 1 000 rangées d'un caractère, une centaine de Ko : 8,1 s et 1,1 Go de tas, puis
  33 ms et 22 Mo (la relecture : 9,9 s et 893 Mo pour 34 Ko, avec des noms d'une lettre).
- Fichier réaliste de 8 Mo : 0,4 s avant comme après.

Reste ouvert dans `todo.md` : 8 Mo de rangées d'un caractère coûtent toujours 4 à 6 s (le coût suit maintenant la
taille du corps, sans effet de levier). Et une première ligne faite de séparateurs seuls reste lue comme en-tête,
défaut fonctionnel antérieur vu en chemin. Tests rouges sur le code d'avant (aucun refus, aperçu en 200, FAQ en 422,
rangées complétées), verts après ; mutations attrapées : borne décalée d'un cran, première ligne physique seule,
maximum retiré, complément par `''` remis, filtre des colonnes retiré, `statusCode` retiré (les routes tombent en 500).

## 2026-09-30 : un connecteur pousse depuis un scénario, et reçoit les valeurs de la dernière analyse

Deux lots nés de l'essai Brevo (renvoyer nos signaux dans leur API d'événements, `POST /v3/events`, 204 sans corps).

**`4882059d`, le bloc « Appel HTTP » d'un scénario sait POUSSER.** Il exigeait un champ cible et lisait la réponse en
`integre` : un appel qui ne rend rien d'utile était refusé. Sans champ cible, il lit désormais en `pousse` et ne range
rien (`src/workflow/appel-http.ts`, `executor.ts`, `engine.ts`) ; la console dit « facultatif ». Relu, déployé.

**`b4a62d3b`, les valeurs de la dernière analyse comme source d'une donnée de connecteur.** Six clés s'ajoutent aux
valeurs système (`CLES_ANALYSE` : intention, sentiment, satisfaction, urgence, résolue, risque de départ), sous les
mêmes codes que ce qui part vers Batch. Lecture PARESSEUSE : `PgSignauxStore.analyseDuContact` ne tourne que si l'appel
déclare une de ces clés, une seule fois par appel, et les quatre appelants de `creerAppelConnecteur` la reçoivent par
`src/socle.ts`. Aucune migration (colonnes de 0027, 0121, 0178). CI verte job par job, relecture sans rouge, déployé
le 2026-09-30 vers 8 h 45 UTC ; la lecture exécutée par le vrai code en production sur l'espace d'essai rend
l'analyse réelle (réclamation, négatif, 2, 8, non résolue), sonde effacée ensuite.

⚠️ **Retour arrière de `b4a62d3b`, à savoir avant de le faire** (relevé par la relecture) : une fois qu'une requête
porte une clé d'analyse, l'ancien code rend `derniereSaisie` pour toute clé autre que `maintenant`, donc le dernier
message du contact partirait dans le champ « intention » si la requête déclare aussi `derniere_saisie` ; et son
`z.enum` à deux valeurs refuse toute édition de cette requête (400). Les jaunes de la relecture (`ae65a599`) : une clé
système inconnue rend désormais `null` au lieu de partir comme valeur, et le commentaire de `analyseDuContact` suit le
schéma (un seul fil par contact).

## 2026-09-30 : le séparateur d'un CSV est essayé, plus deviné (contacts et FAQ de l'agent de Meta)

**Le défaut**, relevé par la relecture de `25f5af1b` : `parseCsv` (`src/crm/csv.ts`) laissait papaparse deviner le
séparateur. Sa devinette part de la virgule et ne cède qu'à un candidat qui a à la fois moins d'écart ET plus de
colonnes en moyenne : un fichier en point-virgule dont les cellules portent assez de virgules est lu en virgule.
L'import de FAQ de l'agent de Meta rendait zéro paire sur `Question;Réponse` dès que les réponses en portaient deux.

**La mesure sur l'import de contacts**, avant de toucher `parseCsv` qu'il partage : vrai `parseCsv` puis vrai
`importContacts` sur un dépôt en mémoire. `Nom;Téléphone;Adresse` avec des adresses à trois virgules donnait un
en-tête d'une seule colonne, zéro contact créé, chaque ligne rejetée « numéro invalide » ; à une ou deux virgules,
ou avec cinq colonnes et des notes à cinq virgules, le fichier passait. Même défaut à un seuil plus haut, donc
`parseCsv` est corrigé pour les deux.

**Livré** (`feb03cf0`) : `separateurCsv`, écrite la veille pour la connaissance d'un agent, quitte
`src/agent/setup/piece-jointe.ts` pour `src/crm/csv.ts` et sert `parseCsv` ; sans tableau régulier, la devinette
de papaparse reste le repli. Quatre tests, vérifiés dans les deux sens : sans le correctif, les trois tests du
défaut retombent sur ses symptômes ; avec un repli imposé sur la virgule, le test du repli tombe. La détection
coûte une dizaine de millisecondes sur un CSV de 15 Mo.

**Relecture indépendante** : aucun rouge, cinq jaunes traités dans le même commit (la limite de l'aperçu d'import,
qui ne reçoit que la tête du fichier, écrite dans `src/http/import.ts` ; le manuel et le commentaire précisés ;
`features.md` daté, avec l'empreinte des deux fiches d'aide qui citent ces sections ; un test de FAQ en TSV). Deux
restes vont à `todo.md` : un fichier aux rangées inégales retombe encore sur la devinette, et une ligne unique de
8 Mo occupe l'API environ six secondes (antérieur au lot, mesuré par la relecture).

**CI** verte sur ses trois jobs (`securite`, `integration`, `unit`), lue job par job.

**Déploiement** à 8 h 07 UTC, sans migration : `feb03cf0` était le seul commit que la production n'avait pas.
`nginx -s reload` une fois `mba-api` sain, puis `fumee.mjs` : les six chemins publics comme attendus.
`aide:charger` : 26 fiches chargées. Le code DÉPLOYÉ a été exécuté dans `mba-api` sur les deux fichiers mesurés,
sans toucher à la base : la FAQ rend ses deux paires, le fichier de contacts ses trois colonnes.

## 2026-09-30 : l'essai réel des bornes de `/v1/contacts`, fait

Six appels en production avec une clé de test de l'espace démo, aucun n'écrit : un lot de 51 fiches rend 400 ;
une fiche à 11 champs dans un lot est refusée à son index ; un champ inconnu est refusé, et rejoué, refusé encore
(donc jamais créé) ; une étiquette inconnue est refusée ; une fiche seule à 21 champs rend 400. Chaque réponse
porte le message attendu et `created: 0`. La clé, passée dans la conversation, est à révoquer.

## 2026-09-29 soir : la connaissance d'un agent, l'agent reçoit ce que la recherche trouve (2 000 caractères)

**Le défaut**, relevé en réparant le CSV (`25f5af1b`). Le plein texte, le rappel vectoriel et le reclassement
lisaient une fiche entière ; l'agent n'en recevait que les 2 000 premiers caractères (`CORPS_MAX`), alors que
l'import d'une page, d'un PDF, d'un Word ou d'un texte faisait des fiches jusqu'à 4 000 (`MAX_CORPS`). Une fiche
pouvait être retenue pour une phrase de sa seconde moitié, et l'agent répondait sans elle. Une section de page
était en plus tronquée à 4 000, sa fin perdue.

**La mesure, en lecture seule sur la production** (transaction `READ ONLY`) : `agent_knowledge` portait ZÉRO
fiche (un agent, cinq espaces), donc la reprise des fiches déjà en base ne se posait pas. La même mesure a trouvé
le défaut chez le bot d'aide, où il vit : 20 fiches sur 26 de `aide_fiches` dépassent 2 000 caractères (la plus
longue 10 008, « créer une publicité »). Noté dans `todo.md`, traité à part sur décision de Julien.

**La décision de Julien** : 2 000 partout plutôt que la fiche entière à l'agent (jusqu'à 6 000 caractères de
contexte de plus à chaque aller-retour qui suit une recherche, et une règle « deux mots en commun » plus facile à
passer), et le plafond de 40 fiches gardé (un document est lu jusqu'à environ 80 000 caractères, l'écran le dit
quand il mord).

**Livré** (`2f63d523`, `d8935b6c`) : `MAX_CORPS` dérive de `CORPS_MAX` ; page et document partagent
`empilerEnFiches` ; la fiche écrite à la main est bornée par la route et par l'écran ; le CSV n'est pas touché.
Relecture indépendante : aucun rouge, un jaune (un titre de près de 200 caractères perdait son « (suite N) »),
corrigé dans le second commit, non relu.

**CI** : le job `unit` est rouge sur UN test, `plan-methode` (le plan `2026-09-28-vitrine-fonctionnalites.md`
d'une autre session), à l'identique sur `a3d67af7`, alors en production ; `integration`, `securite` et la CI de
la console sont verts. Le lot est parti malgré ce rouge, qui lui est étranger.

**Déploiement** à 22 h 26 UTC, sans migration. Le 502 public est revenu (interne 200, `api.` et le chemin
`/api/backend/` de `mba.` à 502) ; `nginx -s reload` l'a levé en une trentaine de secondes, le chemin du webhook
Meta répondant ensuite 403 (vérification sans jeton). `aide:charger` : 26 fiches chargées. Le découpage a été
exécuté PAR LE CODE DÉPLOYÉ dans `mba-api`, sur une page d'essai et sans toucher à la base : une section de
2 840 caractères devient deux fiches de 1 994 et 845, la phrase de fin dans la seconde.

**L'essai réel, qui revient à Julien** : importer une vraie page longue dans l'onglet Connaissance d'un agent,
puis poser au bac à sable une question dont la réponse est à la fin d'une section.

## 2026-09-28 soir au 29 : publicités archivées et programmées, recharge Stripe, panneau Détail de l'Inbox

**Publicités.** Archiver une publicité qui ne diffuse pas (0189, `publicites.archivee_le`, refus 409 côté serveur
sur ce qui peut diffuser) ; puis la liste range « Programmées » les publicités publiées dont le début est à venir,
parce que Meta les dit `ACTIVE` dès la publication et que l'écran affichait « Diffuse » et « Mettre en pause » sur
une campagne qui démarrait le lendemain. Les fixtures e2e portaient un début en octobre 2026 : elles auraient
basculé avec le calendrier.

**Recharge Stripe, en quatre temps.**
- Lot 1 (0190) : un prix client en un seul point (coût brut x 1,10, la commission affichée devient la commission
  débitée), la traduction gardée par le solde, débitée et agrégée en une ligne par jour ; la clé Vercel s'ouvre à
  la première traduction. 🔴 **La relecture a trouvé un rouge** : 5 € offerts à CHAQUE espace créé, sans preuve
  d'identité, se récoltaient par script ; une vingtaine d'espaces atteignaient le plafond d'équipe Vercel
  (100 $/mois), qui coupe les bots de TOUS les clients. Parti éteint (défaut 0).
- Lot 2 (0191) : Stripe Checkout (TVA automatique, numéro de TVA, facture), webhook signé et idempotent par la
  session dans une seule transaction avec le crédit, menu « Paramètres > Crédit IA », 5 € à la liaison du premier
  numéro. Fusionné avec le panneau Détail, écrit en parallèle sur une autre copie (quatre fichiers en commun, un
  conflit sur le compteur, deux causes de traduction du lot 2 branchées dans l'Inbox du panneau). Déployé avec
  l'offre coupée par un override d'environnement : la relecture avait vu qu'elle partait aussi pour un numéro
  NON vérifié.
- Code promo : `allow_promotion_codes`, et le webhook crédite aussi `no_payment_required`. `amount_subtotal` étant
  le prix AVANT remise, le crédit reste plein (décision de Julien).
- Lot des jaunes des deux relectures (0193) : 5 € seulement pour un numéro que Meta dit vérifié, jamais deux fois
  pour un numéro affiché E.164 ; plafond Vercel recalculé et sérialisé ; prix relu avant chaque session ; Adaptive
  Pricing coupé ; mode de l'événement recoupé ; paire de secrets exigée au démarrage ; lien « Facture » par achat.
  Offre rallumée au déploiement.

**Essais réels, tous faits le 2026-09-29.** Refill 50 € avec le code ENGAGE100 à 100 % : une ligne de paiement
live, un mouvement `achat` de +50 €, facture Stripe, plafond de la clé à 60 € (9,98 + 50). Webhook renvoyé depuis
Stripe à 11 h 48 : `"credite": false`, toujours un seul paiement. Traductions de Julien dans l'Inbox : une ligne
« traductions du 29/09 » qui grossit, le solde baisse d'autant au micro-euro près.

**Panneau Détail de l'Inbox (0192).** Journal `conversation_evenements` écrit dans la même requête que chaque
changement, seulement s'il y a eu changement ; amorcé d'une ligne en production. Relecture : 0 rouge. Essai réel
dû (`wip.md`).

## 2026-09-27 soir au 28 : la racine de composition approfondie, cinq lots d'une nuit

- **Revue d'architecture** (`/improve-codebase-architecture`) : `src/index.ts` faisait 3 043 lignes, touché par 137
  commits en 17 jours. Six candidats, les cinq premiers validés par Julien. Plan :
  `docs/superpowers/plans/2026-09-27-approfondir-la-racine.md`.
- **Lot 1** (4d262717) : 317 relais purs `x: (a) => store.x(a)` dans `index.ts` et 92 dans `worker.ts` remplacés par
  des tranches de store déclarées par chaque module consommateur. La classe de défaut du 2026-09-15 (un relais qui
  avale un argument) disparaît par construction.
- **Lot 2** (99440337) : le chiffrage sort dans `src/stats/chiffrage.ts` (classification RCS et liens tracés écrits
  une fois, testés en exécution au lieu d'expressions régulières sur la source), la connexion publicitaire dans
  `src/pubs/connexion.ts`. Exécuté sur les données de production après déploiement, sans erreur.
- **Lot 3** (c472b98e) : `src/socle.ts` construit ce que l'API et le worker construisaient chacun (dépôts, dépôt de
  contacts décoré, pile Meta, runtime). Écart réel trouvé et corrigé : le worker lisait la clé de modèle par espace
  sans signaler un déchiffrement raté, donc la dépense retombait sur notre clé sans trace.
- **Lot 5** (3ddbbe13) : la réception lit l'espace d'un numéro une fois par webhook (jusqu'à 8 lectures avant),
  l'écriture du STOP devient requise.
- **Lot 4** (0bfdca25) : « qui tient le fil » vit dans `src/inbox/fil.ts`, seul appelant de `setControlOwner` et des
  gestes Meta. Cinq décisions de Julien : l'escalade s'efface quand un robot reprend ; une réponse de campagne
  « Inbox » arrive dans « À traiter » (elle était rendue à l'agent de Meta dans le même traitement, défaut réel en
  production, aucune campagne « Inbox » n'existait encore) ; « Reprendre la main » rejoue une fois ; sans numéro
  connecté la colonne ne bouge pas ; un lead publicitaire ne reprend pas une conversation d'opérateur.
  La relecture a trouvé le seul rouge de la nuit : sans borne de temps, chaque message suivant d'un contact
  reprenait le fil pour l'équipe et figeait tout scénario lancé plus tard. Corrigé avant déploiement : seule la
  première réponse à la campagne la plus récente prend le fil.
- **Mesures** : `index.ts` 3 043 -> 2 142 lignes, `worker.ts` 1 770 -> 1 555, `workflow/wiring.ts` 819 -> 688.
  Aucune migration. CI verte et fumée à chaque lot.
- **Méthode** : un implémenteur par lot, chacun parti d'une copie du candidat précédent pendant que la relecture de
  celui-ci tournait ; une relecture par lot ; déploiement séquentiel (1, 2, 3, 5, puis 4, qui s'appuie sur 5) ;
  les jaunes d'un lot partent avec le suivant. Julien dormait pendant les lots 3 à 5.

## 2026-09-26 au 27 : l'app Salesforce, du cadrage au socle serveur déployé

- **Cadrage** (a2594010, 8c3a3be3, puis les amendements du 26) : le pendant de HubSpot pour le Salesforce « core »,
  en offre de prospection. Spec `docs/superpowers/specs/2026-09-26-app-salesforce-design.md`, plan L0 à L5
  `docs/superpowers/plans/2026-09-26-app-salesforce.md`. Décisions structurantes de Julien : package géré 2GP
  (namespace `engagemeapp`, `engageme` était pris), utilisateur d'intégration en client credentials, schéma
  `salesforce` extractible, et c'est Salesforce qui appelle notre API pour l'envoi depuis la fiche.
- **L0, mesures sur de vraies orgs** (18c5de23) : Dev Hub en Developer Edition, org cliente en scratch org
  Enterprise (valable jusqu'au 2026-10-26). Résultats dans `docs/salesforce-mesures-2026-09.md` : la recherche
  par téléphone est résolue par une requête combinée, l'upsert par External ID est idempotent (aucune table
  d'idempotence), la signature calculée en Apex égale notre vecteur d'or, l'API applique la règle d'attribution
  par défaut, et `Lead.MobilePhone` n'est visible par aucun profil dans une org neuve.
- **Le blocage** : Salesforce refuse de relier le namespace au Dev Hub (son application de liaison exige PKCE,
  réglage verrouillé, et sa fenêtre ne l'envoie pas). Sans liaison, aucun package géré : quatre mesures et toute
  la partie package des lots attendent. Le message pour Salesforce est dans le document des mesures.
- **L1, partie serveur** (0771cde7, 60bff7bc) : migration 0183 (schéma `salesforce`, `salesforce.orgs`,
  `tenant_settings.salesforce_actif`), client REST, store, connexion, routes admin, carte de réglage, page de
  connexion et guide public. Relecture indépendante sans rouge, quatre jaunes : la carte de l'Accueil reportée en
  L2, l'interrupteur sous la route de l'intégration plutôt que `/settings`, la traduction des adresses d'org
  (mesurée depuis sur les deux orgs), le contrat Apex figé avant que le package existe. CI verte job par job.
- **Déploiement** le 27 : 0183 appliquée à 10 h 35 UTC avant le `up`, relue en base point par point (dont
  `anon` et `authenticated` sans aucun droit sur le schéma), fumée publique verte. Invisible tant que
  `SALESFORCE_CLIENT_ID` n'est pas posé : la route rend 404, la carte se cache.

## 2026-09-25 au 27 : console sans « slop », audit ponytail, double authentification, commentaires allégés

- **Console, passes 2 et 3 anti-slop** (6a58de04, 61dbc509, a01e1961) : formes, icônes Phosphor, une modale, des
  confirmations dans la page, puis le texte (vouvoiement, phrases courtes, statuts traduits, dates). Une relecture
  unique par passe, zéro rouge. « Mon compte » ajouté au menu du compte (4b9ae3d0).
- **Audit ponytail, lots 2 et 3** (e7b4aeb4, 91c3216f) : factorisations (`enTransaction`, gabarit de balayage), puis
  le contrôle d'espace posé au montage (259 copies remplacées, preuve dynamique sur chaque route), 49
  `forbidNonAdmin` redondants retirés, dépendances rendues requises. Essai réel du lot 3 en conteneur : une session
  d'un espace A reçoit 403 sur une route de B, 200 sur la sienne. Bilan honnête, donné à Julien : le code a peu
  maigri (−1,4 % de `src/`), le gain est structurel (isolation et câblage par construction).
- **Faille de prise de compte par l'inscription fermée** (47616cee), trouvée par l'implémenteur du MFA en câblant
  l'inscription : `/auth/signup` rattachait l'adresse d'un autre à son identité, puis `change-password` vérifiait
  l'ancien mot de passe sur la copie du compte et écrivait sur l'identité. Mesuré en base : la seule identité
  multi-espaces était celle de Julien (« Messaging me Bis », créé par lui), aucun changement de mot de passe tracé.
- **Double authentification des administrateurs** (08c502dc, migration 0182) puis ses correctifs (8186711c, 0184 :
  blocage persistant des codes, mot de passe pour l'enrôlement volontaire, jetons d'étape sans noms d'espaces).
  Ordre de déploiement : la console d'abord (elle accepte l'ancienne API), l'API ensuite, jamais l'inverse (une
  API neuve devant l'ancienne console bloquait tous les admins). **Essai réel fait par Julien le 2026-09-27.**
- **Défaut managers** (8347c537) : les cinq lectures de conformité de Contacts empilaient la garde
  d'encadrement derrière `g.admin`, donc refusaient le manager malgré la décision du 2026-09-14.
- **Commentaires de `src/`** (a203eced, d2a0a1b2) : d'environ 45 700 à 28 700 lignes (−37 %), récits datés et
  redites retirés. Preuve mécanique fichier par fichier : le code réimprimé sans commentaires (printer TypeScript,
  types compris) est identique, directives conservées.
- **Coût** : le lot 3 en workflow multi-agents (cartographes, implémenteurs, relecteurs par angle, vérificateurs) a
  consommé plus de 3,6 M de tokens et aucune relecture n'y a trouvé de rouge ; Julien a arrêté la pratique. Une
  coupure du poste en pleine implémentation a été reprise sans perte (cartographie en cache, implémenteur relancé
  sur l'état de l'arbre). Les déploiements en ERREUR du projet Vercel de la vitrine venaient de son Ignored Build
  Step (commit de référence sorti du clone de profondeur 10), corrigé par sa session.

## 2026-09-26 : `/v1/contacts` borne ses appels, et ne crée plus ni champ ni étiquette

Demande de Julien : « protéger mieux notre API ». Le lot de `POST /v1/contacts/batch` acceptait 500 fiches,
chacune jusqu'à 50 champs (variable `API_MAX_CHAMPS_PAR_CONTACT`) et 200 étiquettes dans le corps (50 gardées,
le reste coupé sans rien dire), et un champ inconnu était créé en texte (200 par espace au plus).

Décisions, prises en cadrage (quatre questions) : **50 fiches par lot**, **10 champs et 10 étiquettes par fiche
dans un lot, 20 à l'unité et en `PATCH`** (Julien a gardé l'asymétrie, contre ma recommandation d'une borne
unique : elle pousse une fiche de 11 à 20 champs vers l'appel unitaire, plus cher), **plus aucun champ créé par
l'API**, **une étiquette doit être déclarée ou déjà portée par une fiche**, et coupe nette (aucun intégrateur
branché). Ce qui a pesé dans l'analyse : seule la taille du lot charge la base, parce qu'un lot tient
l'UNIQUE place d'opération lourde du process ; le nombre de champs ne coûte presque rien (une fiche = une
écriture jsonb). Contrepartie mesurée : 50 000 fiches par heure au plus pour un espace au lieu de 500 000.

Livré en direct, tests d'abord (10 nouveaux, vus ROUGES avant le code), relecture unique sans rouge (trois
jaunes, des commentaires encore en « 500 », corrigés dans le même commit), `0033d541`. Le webhook entrant et la
création à la main gardent l'auto-création : `preparateurDeChamps` prend une option REQUISE `champInconnu`.
La recherche des étiquettes inconnues est UNE requête par lot (`etiquettesInconnues`, servie par
`contacts_tags_gin`), et son isolation par espace est tenue par un test d'intégration.

⚠️ **Le commit a failli défaire le correctif STOP d'un pair.** Poussé depuis un worktree (738a7c3d), il était
absent de l'arbre partagé : `features.md` et `contact-store.pg.ts` y étaient EN RETARD sur origin. Le commit a
donc été construit en appliquant MON patch sur origin (`git apply --cached --3way` dans un index temporaire),
et non en recopiant les fichiers de l'arbre. La règle est dans `CLAUDE.md` (plomberie).

Déployé le jour même : pas de migration, pas de fiche d'aide à recharger, `.env.prod` ne portait pas la
variable retirée. La connexion SSH a coupé pendant le `up -d --build` ; les conteneurs avaient pourtant été
recréés sur le bon code (vérifié par `.Created` et un `grep` dans le conteneur), le `nginx -s reload` a été
refait à la main, et le contrôle de fumée a rendu les six chemins publics justes. Essai réel dû (`wip.md`).

## 2026-09-24 et 25 (nuit) : l'API publique cohérente, lots 1 à 6 d'un seul trait

Six lots de la spec `docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md`, codés par des
agents, un lot à la fois ou deux en parallèle sur des fichiers disjoints, et TOUS en production au matin :
identité par fiche (`contactId`, `externalId`, `phone`, `bsuid`), envois refondus, RCS dans l'API et
variables par destinataire, catalogues et page de doc, trois intentions de commerce, signaux sortants vers
l'outil du client. Migrations 0172 à 0177, chacune appliquée AVANT le `up` de son code et relue en base.

🔴 **LE PROCESSUS A CHANGÉ EN COURS DE ROUTE, sur décision de Julien.** Une journée de relectures de
relectures (dont un rouge pour une ligne mal placée) a fixé la règle : UNE relecture indépendante par lot,
en fin de lot ; 🔴 = uniquement ce qui casse la production, scénario à l'appui ; le correctif d'un rouge
n'est pas relu, son test vérifié dans les deux sens suffit ; les jaunes partent après le déploiement et la
relecture suivante les couvre. Résultat mesuré sur la nuit : sept relectures, ZÉRO rouge, et chaque vague de
jaunes corrigée et poussée dans la foulée.

🔴 **LA GARDE DE DÉPLOIEMENT N'AVAIT JAMAIS ÉTÉ BRANCHÉE.** `hooks/deploiement-garde.js` n'est déclaré dans
aucun `settings.json` ; ce qui bloquait était le classificateur du mode automatique. Des heures ont été
perdues à « attendre une attestation » qu'aucune machine n'exigeait. Julien a décidé de la laisser
débranchée ; `CLAUDE.md`, la skill et la mémoire le disent maintenant. Leçon : vérifier qu'un hook est
BRANCHÉ avant d'affirmer qu'il bloque.

⚠️ **UN COMMIT VIDE EST SUR `main` (`42782e69`), DE MON FAIT.** Le hook `rayon-de-souffle` a refusé une
commande qui créait aussi la liste des fichiers ; relancée sans elle, la boucle n'a rien ajouté, et
`commit-tree` a publié un arbre identique à son parent. Le `git reset HEAD -- <liste vide>` qui suivait a
réaligné TOUT l'index partagé : il n'a effacé que des entrées périmées d'une autre session (vérifié : ses
fichiers étaient identiques à leur dernier commit), mais par chance. Parade appliquée ensuite à chaque commit :
la liste s'écrit dans une commande À PART, et la commande de commit refuse (`test`) si la liste ou l'index
temporaire n'ont pas le nombre de fichiers attendu.

⚠️ **UN TEST INSTABLE, QUANTIFIÉ AVANT D'ÊTRE CORRIGÉ** : `api-usage-observation` lisait le compteur de la
première minute seulement ; sous la charge de la suite complète, ses trente appels chevauchaient une limite
de minute (13 500 au lieu de 15 000). Il passait seul cinq fois sur cinq ; il somme désormais les minutes.

**Reste dû** : les essais réels de chaque lot (une vraie clé d'API, le numéro d'essai, un RCS sur un appareil
sans RCS, trois conversations d'intention, un outil branché), et les décisions listées dans `wip.md`.

## 2026-09-23 (nuit) : les quinze fiches d'aide, puis les deux écrans d'agent

Deux chantiers dans la même session, et le second a été mené par sous-agents, une tâche à la fois, avec une
relecture entre chaque.

**Les quinze fiches d'aide manquantes.** Le bot d'aide couvrait 8 des 31 sections de `features.md` ; les
quinze qui manquaient décrivaient des écrans qu'un client ouvre. Elles sont écrites et chargées.
🔴 **La garde a changé de nature** : le compte des sections sans fiche ne se décrémente plus, il vaut ZÉRO
et le test NOMME toute section laissée sans réponse. Le motif reste dans le type exprès, sinon le prochain
manque devrait se déguiser en décision.

**Le refactor des deux écrans d'agent.** En-tête identitaire, menu en colonne, logos de fournisseurs, deux
routes de comptage, aucune migration. Neuf tâches, relues une par une, puis une revue finale sur l'ensemble,
puis une vague de correctifs, puis une re-revue de cette vague.

🔴 **LES QUATRE DÉFAUTS TROUVÉS ÉTAIENT TOUS INVISIBLES DU COMPILATEUR**, et c'est le résultat le plus utile
du lot. Rendre DEUX copies de la liste d'onglets aurait fait exister chaque `data-testid` en double et
cassé cinq suites e2e. `AgentResume` ne portait pas le modèle, donc le logo de la liste exigeait un
changement serveur que le plan n'avait pas vu. `logoDuModele(undefined)` faisait tomber la LISTE ENTIÈRE
pendant la fenêtre où Vercel publie la console avant le déploiement de l'API. Et sur l'écran bloqué
« Meta n'a pas ouvert l'agent », l'en-tête affichait des étapes CLIQUABLES qui ne menaient nulle part, le
motif « offert-et-inerte » que ce produit s'interdit.

🔴 **ET LA REVUE FINALE A TROUVÉ CE QU'AUCUNE REVUE DE TÂCHE NE POUVAIT VOIR : une capacité avait disparu.**
La ligne « moyen de paiement », que l'ancien composant affichait à part parce qu'elle n'est pas vérifiable,
n'était plus rendue nulle part, et CINQ textes du dépôt continuaient d'affirmer qu'elle y était. Aucun test
ne la couvrait, donc la perte était muette. C'est l'argument entier en faveur d'une revue qui regarde
l'ensemble après des revues qui regardent chaque pièce.

⚠️ **DEUX TESTS NE GARDAIENT RIEN, ET LE SECOND ÉTAIT LE PIRE.** Retirer la fenêtre de 30 jours, ou le
filtre par agent, les laissait verts. Sans ce dernier, le chiffre serait devenu par ESPACE au lieu de par
AGENT, c'est-à-dire le même nombre sous deux noms d'agents, sans qu'aucun test ne bouge.

🔴 **INCIDENT : UN COMMIT CROISÉ A LAISSÉ `main` SANS COMPILER.** Une session voisine a emporté une ligne de
câblage `src/index.ts` alors que la méthode qu'elle appelle n'existait pas encore. La cause exacte, trouvée
par cette session : **le hook `rayon-de-souffle` ajoute un aller-retour entre la vérification du diff et le
commit**, et l'arbre partagé change entre les deux. Les deux sessions commitent désormais ce fichier en
plomberie. C'est le deuxième incident du même arbre dans la journée, et la première parade (trois annonces)
n'y suffisait pas.

⚠️ **UNE RELECTURE QUI EXCLUT LES COMMITS D'UN PAIR REND L'ATTESTATION PLUS ÉTROITE QUE LE DÉPLOIEMENT.** La
session voisine avait écrit à son relecteur « ne relis QUE tel commit, les autres appartiennent à une
session parallèle » : mon code serait parti en production sans relecture à froid. Trouvé en le lui
demandant, corrigé par une relecture dédiée avant son déploiement.

## 2026-09-23 (soir) : deux commits qui ne se révoquent plus séparément, et cinq relectures

🔴 **`a2e0baed` ET `33ce31fe` SE RÉVOQUENT ENSEMBLE OU PAS DU TOUT.** Le premier est un correctif de
l'écran Publicités ; il a emporté, sous un message qui n'en parle pas, une ligne de câblage du lot
voisin (`messagesTenus:` dans le bloc `mba:` de `src/index.ts`). Les deux moitiés de cette ligne, la
déclaration sur `MbaRouteDeps` et la méthode sur `PgStatsStore`, étaient encore non commitées : le
commit ne compilait donc pas seul, et `main` est resté rouge de 17 h 25 à 17 h 31 UTC, jusqu'à
`33ce31fe` qui a apporté les deux moitiés.

⚠️ **CE QUI RESTE VIVANT, ET QU'IL FAUT SAVOIR AVANT DE TOUCHER À CES COMMITS** : un
`git revert a2e0baed` retirerait la ligne de câblage en laissant la dépendance OPTIONNELLE en place.
La route répondrait alors 200 avec `messages: null`, donc le compteur de messages de l'agent de Meta
s'éteindrait EN SILENCE, sans erreur, au moment précis où l'on croit ne défaire qu'un correctif
publicitaire. L'histoire est poussée, donc on ne la réécrit pas : on écrit la dépendance ici.

🔴 **LA CAUSE N'EST PAS `--only`, C'EST LE MOMENT OÙ L'ON RELIT LE DIFF.** Le diff de `src/index.ts`
avait été relu et ne portait que les deux lignes attendues. Puis `hooks/rayon-de-souffle.js` a refusé
le commit pour faire relire sa liste, et la même commande a été relancée SANS relire le diff : la ligne
du voisin est arrivée entre les deux. **Le hook agrandit la fenêtre qu'il est censé aider à
surveiller.** Et le contrôle d'intrus qui tournait ne regardait que les NOMS DE FICHIERS : il rendait
zéro, puisque `src/index.ts` était légitimement sur la liste. Ce qui était étranger était une ligne
DEDANS. La parade qui ne dépend d'aucun timing avait été utilisée une heure plus tôt, sur le même
fichier et avec succès : fabriquer le blob soi-même (arbre MOINS les lignes du pair) et commiter par
`GIT_INDEX_FILE` temporaire.

⚠️ **CINQ RELECTURES À FROID POUR UN SEUL LOT, ET CHACUNE A TROUVÉ QUELQUE CHOSE QUE LA PRÉCÉDENTE
AVAIT CRÉÉ.** La première a trouvé un accès Meta rendu irrévocable ; le correctif révoquait à
l'aveugle et aurait désarmé le jeton NEUF, ce que la deuxième a vu ; la troisième a montré que le
correctif suivant avait réécrit un bandeau qu'une décision produit avait fait retirer le jour même ;
la quatrième, qu'en retirant ce bandeau on avait emporté le rechargement de l'écran ; la cinquième,
que la garde censée protéger tout cela laissait passer trois orthographes du bug d'origine. **C'est en
corrigeant qu'on casse**, et le seul remède qui ait fonctionné est d'arrêter de garder une décision
par un test qui lit du TEXTE : elle vit désormais dans `retirerAncienAcces`, exécutée contre un faux
client, où chaque mutation fait tomber un cas.

## 2026-09-23 (après-midi) : trois lots de plus, et trois relectures pour un seul module

**Déployé le 2026-09-23 vers 12 h 40**, par la session des publicités, après une revue finale qui a demandé
TROIS passes. Contenu : l'API publique « envoyer un simple message » (`POST /v1/messages`), la grille de prix
unique dans `/ops`, le masquage des fonctions HubSpot sans portail lié, et le lot 2 des publicités
Click-to-WhatsApp. **Migrations 0166, 0167 et 0168 appliquées à 11 h 36, toutes AVANT le `up`**, ce qui
n'était arrivé ni en 0141 ni en 0159 : aucune n'a eu besoin d'être mise de côté pendant le build.

🔴 **CE QUE LES TROIS RELECTURES ONT TROUVÉ, ET POURQUOI IL EN A FALLU TROIS.** La première a rendu 2 rouges
sur le module des publicités. Le correctif en a fermé deux et en a ouvert trois autres, dont un que le
correctif lui-même rendait atteignable (un bandeau « votre compte est détaché » qui survivait à une
reconnexion réussie, donc un écran affichant simultanément « connecté » et « détaché »). La troisième passe a
fermé le reste. **La règle du dépôt, « c'est en corrigeant qu'on casse ailleurs », a été démontrée deux fois
de suite dans la même après-midi**, sur le même module.

🔴 **LE MÊME MOTIF EST APPARU TROIS FOIS SOUS TROIS FORMES : un accès qu'on abandonne sans pouvoir le
fermer.** C'est le piège de la clé Vercel (0124), déjà écrit dans ce dépôt. Ses trois visages ici : une
révocation qui désautorisait l'application Meta EN ENTIER, partagée avec l'inscription WhatsApp (donc un
bouton « Déconnecter » des publicités pouvait couper le numéro du client) ; un « Reconnecter » qui écrasait
le jeton sans le révoquer ; et, après correction, une insertion-seule qui orphelinait le jeton FRAIS au lieu
de l'ancien. ⚠️ **Le correctif évident du troisième était un piège** : révoquer le jeton frais aurait détruit
la connexion qui marche, la révocation portant sur l'ENTITÉ et non sur le jeton.

⚠️ **ARBITRAGE DE JULIEN, ET IL RECADRE TOUT CE QUI PRÉCÈDE** : sur le jeton qui survit chez Meta, « on s'en
fout, personne ne l'utilisera ». Il a raison, le secret n'est publié nulle part et n'a jamais fuité ; ce qui
restait vrai était l'incapacité à répondre « tout est coupé » à une DSI, ce qui est un enjeu de conformité et
non une faille. Ce qu'il a retenu comme important : le message d'écran qui, suivi par un client, coupait son
WhatsApp.

🔴 **INCIDENT : DEUX SESSIONS SE SONT ÉCRASÉES DANS `src/index.ts`, ET `main` A ÉTÉ ROUGE DIX MINUTES.** Le
mécanisme, parce qu'il vaut plus que l'incident : un `git checkout origin/main -- <fichier>` a réaligné
l'index d'une session APRÈS son push, écrivant par-dessus le travail non commité de l'autre. Le
`git commit --only <ce fichier>` de celle-ci a ensuite commité le travail d'en face et perdu le sien.
**`--only` ne protège que si le CONTENU du fichier est encore le sien**, et un `checkout` est une ÉCRITURE
qui n'a l'air de rien. Parade convenue : trois annonces (fichier de câblage partagé, `checkout` dessus,
suite e2e), inscrites dans le `CLAUDE.md` du dépôt.

⚠️ **ET LA FICHE D'AIDE DES AUTOMATIONS ANNONÇAIT QUATRE DÉCLENCHEURS SUR SEPT**, depuis des semaines, sans
rapport avec ces lots. `features.md` les listait bien tous les sept : la garde de dérive compare une fiche à
la SECTION dont elle dérive, donc elle voit une section qui change, jamais une fiche qui ne suit pas un ajout
fait par quelqu'un d'autre. Corrigée et rechargée dans l'index du bot. ⚠️ `la-fenetre-de-24-heures` a un
frontmatter VIDE : elle n'est rattachée à aucun écran ni section, donc rien ne la surveillera jamais.

## 2026-09-23 : trois lots partis d'un bloc, et le compteur qui a failli coûter cher

**Déployé le 2026-09-23 vers 9 h 15** : les 21 commits que la production n'avait pas, écrits par TROIS sessions
(les publicités Click-to-WhatsApp « Capter » ; l'activation d'un numéro que l'Embedded Signup v4 laisse non
vérifié ; les jaunes de coûts et d'Inbox), relus et déployés par une QUATRIÈME qui n'en avait écrit aucun.
Revue finale attestée sur `9c29257a`, 0 rouge, 4 jaunes.

🔴 **LE MOMENT OÙ CE DÉPLOIEMENT A RESSEMBLÉ À UN INCIDENT.** Un message inter-session annonçait « trois
migrations en attente, la production est à 0162 », en recopiant `CLAUDE.md`. Or le diff entre le commit déployé
et `HEAD` ne contenait que 0163 : 0164 et 0165 vivaient DÉJÀ dans l'arbre du commit en production. Et le code
déployé les NOMMAIT, `escaladee_le` dans `A_TRAITER_SQL` (le prédicat du dossier « À traiter », lu par la liste
ET les compteurs de l'Inbox, plus le balayage du worker) et `reessai_par_campagne` dans `insertCampaignRow`.
Lu ainsi, la production était cassée depuis dix heures, exactement comme le 2026-08-17.

**Elle ne l'était pas, et c'est la base qui l'a dit** : les deux colonnes existaient, appliquées la veille à
20 h 49, trois heures AVANT que leur code ne sorte. La session qui les avait écrites avait respecté l'ordre ;
ce qui avait dérivé, c'est seulement la ligne du compteur. **Neuvième dérive, et la première propagée par un
pair.** Ce que cette fois ajoute aux huit précédentes : plusieurs sessions écrivent des migrations dans le même
dépôt, donc cette ligne peut être périmée sans que celui qui la lit ait rien fait, et **un pair qui la recopie
propage l'erreur au lieu de la corriger**. Les HORODATAGES de `schema_migrations` sont ce qui a tranché : ils
disent qui a appliqué quoi, et quand, là où le compteur ne dit qu'un chiffre.

⚠️ **LA LEÇON GÉNÉRALE, ET ELLE NE PORTE PAS SUR LE COMPTEUR.** Du code déployé qui nomme une colonne absente
est une panne MUETTE : aucun conteneur ne le signale, `healthy` reste vert, et le symptôme n'apparaît que sur
l'écran d'un client. La seule façon de savoir si un déploiement a laissé ce trou est de comparer **le code
déployé** aux **objets réellement présents en base**, jamais un fichier de doc à un autre.

**L'ordre de 0163 ne se discutait pas.** Le code neuf nomme `arrivees_pub` ou `tarifs_meta` en quatre endroits,
dont la transaction de purge RGPD (`PgContactStore.purgeMany`, qui aurait échoué en entier, donc plus aucune
suppression de contact) et toute lecture de coût (`horsEntreeGratuite`, posé dans cinq requêtes). Séquence tenue :
`git pull`, `compose build mba-api`, `ls` DANS L'IMAGE pour voir que 0163 y était, `migrate` (une seule appliquée),
relecture en base point par point, PUIS `up -d --build`.

**Éprouvé après coup par le VRAI CODE, sur les vraies données** : `PgStatsStore.getVolumeParCampagne` puis
`servicesParCampagne` sur les deux espaces réels rendent leurs lignes, avec `horsRetention` à `false` et non
`undefined`. Sonde effacée ensuite. Et les deux routes neuves répondent **401, pas 404** : c'est ce qui prouve
qu'elles sont montées et gardées, donc que la fenêtre où la console de Vercel appelle une route absente est
fermée.

**Aucun 502 public cette fois**, pour la première fois depuis plusieurs déploiements : `nginx -s reload` a été
posé APRÈS l'attente de `healthy`, dans une commande SÉPARÉE du `up` (leçon du 2026-09-08). Les cinq portes
publiques répondent 200, le chemin du webhook Meta compris.

## 2026-09-22 : les suites du lot 2 des outils maison, et un seul ordre de verrous

**Déployé en deux temps le 2026-09-22** : au matin avec les suites du lot 1 de sécurité (par la session
sécurité), puis vers 10 h l'ordre unique des verrous, avec les raisons lisibles en 422 d'une autre session.
Le lot des jaunes de la relecture de cet ordre suit. Ce qui suit est le récit.

**Deux rouges trouvés APRÈS leur publication chez Vercel**, dans le lot des jaunes du lot 2 : le bandeau des
retraits effaçait chez Meta, sans confirmation, un outil ajouté à la main (la publication efface tout ce qui
n'est pas à nous, et le bandeau le disait « supprimé ici ») ; une lecture ratée des champs se disait « champ
supprimé ». Aucune exposition constatée : aucun outil étranger n'était listé chez Meta. La console part à chaque
push : un défaut d'écran est en production avant sa relecture, pas après.

**Le verrou de la suppression d'un agent a changé d'ordre TROIS fois**, et chaque ordre interbloquait avec un
chemin voisin : les définitions avant les sessions (le journal d'un appel prend la session puis l'outil), le
retrait avant le verrou (`detacher`), la cascade avant le verrou (un `detacher` qui EFFACE le connecteur, par
`on delete set null` des appels que la cascade venait de supprimer). Aucun des trois n'était visible d'un test
unitaire ni du compilateur. Faute de Postgres sur le poste, chaque interblocage a été REJOUÉ contre un Postgres
jetable monté sur le VPS, isolé de la base de production : chaque ancien ordre y tombe en « deadlock detected »
sur son test, le nouveau passe. Puis un rattachement a appris à verrouiller son agent : sans lui, il posait un
consentement qui survivait à l'agent supprimé, et le connecteur n'était plus jamais effacé.

**Le second essai réel** (Julien, le matin) : un outil information renommé, un outil maison supprimé depuis
l'onglet, et « rajoute une étiquette » sur le connecteur `add_tag`, en HTTP 200, ce qui éprouve en conditions
réelles la vérification d'adresse à la connexion du lot 1 de sécurité.

**La garde de déploiement ne couvrait pas ce dépôt** (aucun `.claude/deploy.json`) : elle est déclarée, et le
hook global garde désormais aussi la MIGRATION lancée par `ssh` (décision de Julien).

**Puis les chemins VOISINS** : la relecture du lot suivant a trouvé trois autres chemins qui prenaient les mêmes
lignes dans un autre ordre, et que les textes nommaient comme « exceptions » sans que rien ne les suive : l'import
d'un serveur MCP (qui ne triait que ses outils modifiés), la suppression d'un serveur MCP (sa cascade suivait le
parcours de table) et la relecture d'une source de connaissance (qui prenait l'agent en fin d'instruction, après
ses fiches). Chacun s'aligne désormais sur l'ordre de `remove`, et chacun a son test d'interblocage, rouge sur son
mutant contre le Postgres jetable. Une exception nommée dans un commentaire n'est pas une dette suivie.

**La leçon** (`brain/LEARNINGS.md`) : dans un domaine où plusieurs chemins verrouillent les mêmes lignes, l'ordre
se DÉCLARE une fois et chaque chemin s'y aligne ; le corriger chemin par chemin, relecture après relecture, a
produit trois ordres faux d'affilée. Et un interblocage se prouve en le REJOUANT, jamais en le raisonnant seul.

## 2026-09-21 au soir : les outils maison de l'agent de Meta, lot 2 (déployé, éprouvé en conversation réelle)

**Livré, déployé et éprouvé le 2026-09-21 au soir** (migration 0162). Fonctionnel dans
[features.md](../features.md), invariants dans [documentation.md](../documentation.md), spec et plan dans
`docs/superpowers/`. Ce qui suit est le récit.

**Ce que c'est** : l'agent de Meta pose une étiquette fixée d'avance et remplit un champ de la fiche du
mini-CRM, gestes que le relais exécute lui-même au lieu d'appeler un système tiers ; et l'onglet « Outils » est
refait d'après le croquis de Julien (une liste, un gros bouton « Ajouter », l'état chez Meta ligne par ligne).
Un outil de connecteur que plus personne n'utilise part désormais de l'espace (décision de Julien), un outil
MCP reste.

**Trois relectures à froid** : 4 rouges et 16 jaunes, puis celle de la session sécurité, puis 1 rouge et
11 jaunes. Les rouges : un test d'intégration que la règle des orphelins rendait faux (vu par la CI), l'IP
d'origine du VPS recopiée dans le plan d'un dépôt public, une note d'écran qui renvoyait vers un outil du
lot 3, et `.env.example` resté sur l'ancienne valeur d'un plafond (sans effet : `.env.prod` ne la porte pas).
Un jaune a mené à un vrai défaut de concurrence : les trois chemins qui effacent une définition au dernier
détachement avaient perdu le verrou de l'ancien `supprimerDefinition`. Le test de course a été poussé SEUL
d'abord, rouge en CI, puis le verrou.

**L'incident : l'onglet cassé en production pendant plus d'une heure.** Vercel publie la console à chaque
push ; l'API attendait sa revue finale. Le nouvel écran appelait donc une route absente (404), et disait
« Aucun outil » à un espace qui en avait. Réparé par le déploiement ; la règle est dans `CLAUDE.md`
§ Déploiement. En le cherchant, un second trou est apparu : la garde de déploiement ne couvrait PAS ce dépôt,
faute de `.claude/deploy.json`. Elle bloque maintenant un `compose up` sans attestation.

**Le déploiement** : build, 0162 vue dans l'image, `migrate`, relecture en base point par point, `up -d
--build`, puis le 502 public habituel, réglé par un rechargement de NPM. Pendant ce chantier, la décision de
Julien sur l'API publique : une seule opération lourde à la fois, globale au process (voir `src/config.ts` et
le `/sync` de la session sécurité).

**L'essai réel** : deux outils créés depuis l'onglet, déclenchés sur WhatsApp, trois appels `ok` au journal,
la fiche modifiée 26 ms après l'appel. Aucun échec, contrairement au relais le matin même : la consigne
pré-remplie, directive, a fait appeler l'outil du premier coup.

## 2026-09-21 : l'auto-attaque dérive ses modules du registre, et attaque chaque route selon sa classe

**Le constat.** `scripts/auto-attaque.mts` (qui tourne dans le job `unit` de la CI) montait ses modules depuis une liste
écrite à la main, sous un commentaire qui affirmait « jamais écrit à la main ». Comparée au registre
`modulesDeRoutes` : **huit modules jamais montés, 27 routes jamais attaquées** (218 inventoriées, 245
depuis), dont toute l'entrée `v1` (`/v1/*`, `/mcp`, le relais du Meta Business Agent), la gestion des
utilisateurs (l'entrée s'appelle `admin`, la liste disait `users`, qui ne montait rien), l'assistant MBA,
l'historique, les connecteurs MCP, le bot d'aide, le rappel RCS et le connecteur HubSpot.

**Ce qui a changé.** Les clés de dépendances sont lues en EXÉCUTANT le registre (un espion note ce que
`modulesDeRoutes` lit en construisant sa liste), chaque clé est rattachée à son entrée en rejouant le registre
avec elle seule, et chaque module est monté seul sur une instance jetable pour donner à ses routes la classe
d'accès que son entrée déclare. Les sondes se choisissent par classe, plus par préfixe : `code-url` reçoit des
codes inconnus bien formés (sonde 11), `signature-service` une signature absente puis fausse (12), `cle-api`
une session de console puis une clé inventée (13), `signature-meta` généralise la sonde 6. Les modules hors
`tenant` exigent une fausse autorité déclarée (`FAUSSES_AUTORITES`) : sans elle, le script refuse de tourner,
parce que `bidon()` répondrait « trouvé » à une clé inventée. Les sondes 11 et 13 vérifient en outre qu'elles
ont ATTEINT le magasin, et pas seulement buté sur un contrôle de format.

**Vérifié dans les deux sens, faille par faille** (plantée, détectée, restaurée) : un module sans garde, le
relais monté sans clé d'API, une clé inconnue acceptée, un lien inconnu qui redirige, un format de code que
plus aucun candidat n'atteint, la signature HubSpot non vérifiée puis non comparée, la signature Meta
acceptée, une fausse autorité manquante ou périmée. Résultat sur le code actuel : **aucune trouvaille** ;
les modules qui manquaient étaient bien gardés.

**Ce que la mesure a révélé en plus.** La sonde 6 ne prouvait rien de la comparaison de signature Meta : le
receveur lisait `META_APP_SECRET`, vide en CI comme sur ce poste, et refusait tout avant de comparer. Une
vérification plantée qui accepte toute signature bien formée passait l'ancienne version sans trouvaille. Le
script pose désormais un secret tiré au hasard.

**La leçon** : une liste d'inventaire ne se recopie pas depuis sa source, elle se DÉRIVE en exécutant la
source. Et une sonde qui refuse ne prouve rien tant qu'on n'a pas vérifié QUI a refusé : un format, un secret
vide ou un 403 d'une autre garde donnent le même verdict qu'une vraie vérification.

## 2026-09-21 : le carrousel RCS, et les rappels smsmode perdus depuis la bascule Vercel

**Livré le 2026-09-21** : le composeur de carrousel dans Contenu > Messages RCS (lot 1) et le choix d'un
carrousel dans l'assistant de campagne, en copie figée (lot 2). Spec et plan :
`docs/superpowers/specs/2026-09-21-carrousel-rcs-design.md`, `docs/superpowers/plans/2026-09-21-carrousel-rcs.md`.
Fonctionnel dans [features.md](../features.md) ; le lot 3 (le carrousel dans un bloc de scénario) est cadré
dans [todo.md](../todo.md) ; l'essai réel restant est dans [wip.md](../wip.md). Ce qui suit est le récit.

**Le premier envoi réel « n'a pas fonctionné », et ce n'était pas le carrousel.** smsmode l'avait accepté et
remis. Ce qui était cassé, ce sont deux adresses que le RCS distribue, câblées dans `src/workflow/wiring.ts`
sur `config.APP_URL` :
- l'adresse de rappel posée sur chaque envoi (rapports de livraison ET réponses des contacts, STOP compris) ;
- la base des liens tracés des boutons.

Depuis la bascule du 2026-09-03, `APP_URL` est le nom du front, servi par Vercel, qui ne relaie rien vers
l'API (`404 DNS_HOSTNAME_RESOLVED_PRIVATE`). Les boutons ouvraient une page d'erreur, et **aucun rappel
n'était arrivé depuis le 26 août** (`rcs_agents.last_callback_at`) : un STOP reçu par RCS pendant ces trois
semaines aurait été perdu. Impact réel faible : le canal est en mode TEST (« Messaging Me (TEST) »), et le
diagnostic comptait quatre envois depuis la bascule. Les visuels s'affichaient, eux : `/m/` avait été
rebranché sur l'API à la bascule, dans `src/index.ts`. C'est le même rebranchement qui avait sauté le câblage
du RCS.

**Le correctif (`96eebb5a`)** fait passer les deux adresses par `adressesPubliques`, le point de passage qui
existait depuis la bascule (`avecPrefixe` pour le rappel, `racine` pour les liens).
`tests/rcs-adresses-cablage.test.ts` lit le câblage et y refuse `APP_URL` ; sa mutation le fait tomber.
Déployé le jour même par l'autre session, avec la migration 0161.

**L'essai, mesuré de bout en bout.** Julien a renvoyé le carrousel à 12:46:38 UTC, trois minutes après le
redémarrage des conteneurs. Relu chez smsmode (`GET /rcs/v1/messages/<id>`, depuis `mba-api`) :
`callbackUrlStatus` et `callbackUrlMo` sur `api.messagingme.app/rcs/callback/`, les trois boutons sur
`api.messagingme.app/r/`. Puis l'appui sur « En savoir plus » : clic compté et attribué à 12:46:52.253,
rappel reçu à .594, message entrant enregistré à .638.

**Ce que l'essai a appris sur smsmode.** L'appui sur un bouton LIEN revient en rappel `SUGGESTION`, avec son
`postbackData`, exactement comme un bouton Réponse. Il entre donc dans le fil comme une réponse du contact et
range la conversation dans « À traiter ». Sur WhatsApp, un bouton lien ne produit aucun message entrant.

**La leçon** (`brain/LEARNINGS.md`, 2026-09-21) : une adresse DISTRIBUÉE se vérifie chez le TIERS qui la
reçoit, pas dans nos tests. En local, le front et l'API répondent tous les deux, donc aucun test ne pouvait
voir qu'une adresse portait le mauvais nom. C'est la relecture chez smsmode qui l'a montré, et c'est elle qui
a clos le correctif.

## 2026-09-21 : le relais du Meta Business Agent (trois lots, trois revues, éprouvé en conversation réelle)

**Livré, déployé et éprouvé le 2026-09-21.** Fonctionnel dans [features.md](../features.md), invariants dans
[documentation.md](../documentation.md), spec et plan dans `docs/superpowers/`. Ce qui suit est le récit.

**Le point de départ** : l'outil `add_tag` de Julien ne se déclenchait pas, l'agent de Meta passait la main.
Deux causes superposées. La publication n'envoyait chez Meta que `{method, path}`, donc l'outil y existait sans
corps ; et Meta appelle le système du client en direct, sans pouvoir lire le mini-CRM, où vivent `user_ns` et
`tag_ns`. Un correctif du matin (`e5b660b`, déployé SANS revue finale sur décision de Julien) a empêché les
outils creux de partir ; Julien a ensuite arbitré le principe du relais : un seul endroit pour déclarer un
appel (Tools > Connecteurs API), et Meta qui appelle Engage Me au lieu du système du client.

**Le relais** : `POST /mba/relais/outils/:id`, derrière une clé d'API de l'espace au droit `mba:relais` (que
seule la publication attribue) ; le contact désigné par un en-tête que Meta remplit avec la macro
`WHATSAPP_PHONE_NUMBER` ; les variables du mini-CRM remplies par `creerAppelConnecteur`, comme pour un agent
IA ; la réponse entière rendue à Meta (arbitrage de Julien). La publication pose un connecteur `EngageMe` par
espace : le secret UChat de Julien, posé chez Meta dans `testUCHAT`, n'y est plus.

**Trois relectures à froid : 4, 2 puis 1 rouges.** Celui qui comptait le plus avait été INTRODUIT par un
correctif : révoquer « toutes les autres clés » au succès d'une pose faisait que deux « Envoyer » simultanés se
révoquaient mutuellement la clé chez Meta. Les publications sont désormais sérialisées par espace. La troisième
passe a trouvé une garde de la console qui lisait un état React figé au clic. Julien a arrêté la boucle après
la troisième (même arbitrage que pour l'Inbox).

**Deux incidents de méthode, tous deux consignés dans `brain/LEARNINGS.md`.** Un commit du lot 3 a emporté la
documentation non commitée de la session voisine (`git commit --only` prend le fichier entier). Et une commande
de mutation interrompue a laissé sa mutation dans l'arbre, commitée ensuite : la CI l'a trouvée.

**Le déploiement** a embarqué, à la demande de la session voisine, son correctif RCS (`96eebb5a`, rappels
smsmode perdus depuis le 26 août), sorti en `HOTFIX_SANS_REVUE` parce que la revue du relais ne l'avait pas lu.

**L'essai réel a échoué deux fois avant de réussir, et aucune des deux fois à cause du relais.** La première,
« Envoyer » n'avait pas été cliqué : Meta ne détenait aucun connecteur. La seconde, tout était en place chez
Meta, mais l'agent n'a jamais appelé l'outil : sa description (« Le client demande à rajouter une etiquette »)
a perdu face à sa compétence de transfert. Réécrite en consigne, elle l'a fait appeler au premier essai : ligne
de journal `add_tag` `ok` appelant `mba`, HTTP 200 de UChat, étiquette posée. La macro du numéro, dernière
inconnue, vaut le numéro international sans « + ».

## 2026-09-19 : l'Inbox, « Traité », les pièces jointes et « Je m'en occupe » (12 commits, trois revues)

**Livré et déployé le 2026-09-19 après-midi**, migration 0160 comprise. Fonctionnel dans
[features.md](../features.md), invariants dans [documentation.md](../documentation.md), essai réel dû dans
[wip.md](../wip.md). Ce qui suit est le récit.

**Quatre demandes de Julien le matin**, dont trois arbitrées par questions avant d'écrire une ligne : un statut
« Traité » DISTINCT d'Archivé (alors qu'Archivé faisait déjà le retour en « À traiter » au message du
contact, ce qui a été montré, puis tranché autrement) ; les photos et fichiers reçus SANS copie chez nous ;
et, pour la « réaffectation » demandée, la précision décisive : « un agent ne peut pas réaffecter [...] en
revanche il peut prendre parmi celles du pot commun ». La quatrième (deux phrases des connecteurs) a été
faite en premier, seule.

**Ce que la lecture et la mesure ont appris avant de coder.**
- Meta ne garde un média REÇU que SEPT jours. La doc de référence porte deux durées sur la même page (30
  jours pour ce qu'on téléverse, 7 pour les identifiants reçus par webhook) et le dépôt affirmait 30 à trois
  endroits. Mesuré depuis le conteneur de production : nos deux seuls vocaux, reçus 7,9 et 8,9 jours plus
  tôt, rendaient `100/33`. Le jeton local ne marchait pas : la sonde a tourné DANS `mba-api`, en lecture.
- Un manager ne pouvait affecter à personne : le sélecteur lisait `GET /users`, réservé aux admins. Invisible
  parce que les quatre comptes existants sont admin, et parce que le faux du test d'écran servait `/users`
  à tout le monde. Le faux refuse désormais comme le vrai.

**La CI de la console était rouge depuis cinq commits de l'autre session** (le test de navigation n'avait
pas suivi le retrait de Tools > Outils). Réparée à part, en premier, parce qu'une CI rouge masque tout autre
échec sur son job.

**Un fichier TypeScript a été vu comme BINAIRE par git.** L'expression qui nettoie un nom de fichier
contenait des octets de contrôle littéraux au lieu de leurs séquences d'échappement : l'outil d'écriture avait
converti les séquences. Le code marchait, les tests passaient ; seul `Bin 0 -> 5344 bytes` dans un
`git diff --stat` l'a trahi, juste avant la relecture.

**Trois passes à froid : 3 rouges et 13 jaunes, puis 1 et 7, puis 1 et 7.** Les deux rouges qui comptaient :
la console déployée par Vercel au `git push` avant que l'API ne le soit (le menu d'affectation était vide,
même pour un admin, pendant quelques heures, jusqu'au déploiement) ; et un message « N conversations
traitées laissées de côté » qui comptait par différence, donc pouvait affirmer un statut faux. Les autres
constats de valeur : la lecture des pièces jointes n'était câblée QUE si la transcription l'était ; et le
test de câblage écrit pour le garder, par recherche de texte, restait vert avec le câblage remis dedans (un
conditionnel IMBRIQUÉ portait le même motif de fin) : réécrit avec le compilateur, sa mutation vue.

**Un second arbitrage en cours de route** : une réaction emoji ne rouvre pas une conversation traitée, puis,
sur la troisième passe, ne change pas non plus « qui a parlé en dernier », sans quoi notre « bonne journée »
suivie d'un 👍 remettait la conversation dans « À traiter ».

**Julien a arrêté la boucle** après la troisième passe : corriger ses points, pas de quatrième, publier.
L'attestation le dit, et elle dit aussi que le VPS tournait sur un commit de l'autre session déployé sans
attestation enregistrée ici.

**Déploiement** : attestation, image construite, 0160 vérifiée DANS l'image, `migrate`, relecture en base
(trois colonnes conformes, aucun index sur `traitee_le`, rien de changé pour personne), `up -d --build`,
conteneurs sains puis rechargement de NPM, contrôle public 6/6, et les deux routes neuves en 401 au lieu de
404.

## 2026-09-18 : le Performance Lab, les coûts et l'analyse (33 commits, huit revues)

**Livré et déployé le 2026-09-18 au matin**, migrations 0154 et 0155 comprises. Le fonctionnel vu
utilisateur vit dans [features.md](../features.md), ce qui reste dû dans [wip.md](../wip.md), le compteur
de migrations dans [CLAUDE.md](../CLAUDE.md). Ce qui suit est le RÉCIT, et il n'a d'intérêt que pour ce
qu'il a coûté.

### Ce qui a été livré

Refonte de l'onglet Synthèse : une carte « Coûts » à trois lignes dépliables, les conversations par
intention, l'écran d'analyse en une ligne par jour avec « qui a répondu », le résumé de conversation en
champ de base du mini-CRM, la rétention abaissée à 90 jours et réglable par espace, et une grille de prix
par espace. Spec et plan dans `docs/superpowers/`.

### 🔴 CE QUE HUIT REVUES À FROID ONT TROUVÉ, ET CE QUE ÇA DIT DE LA MÉTHODE

Verdicts successifs : **6, 5, 5, 4, 3, 1, 0 puis 1 rouge**. La majorité des rouges des passes 2, 3 et 4
étaient des défauts **introduits en corrigeant les précédents**. Le motif, quatre fois : un correctif ferme
le cas qu'on regarde et laisse ouverts ses voisins.

Les quatre défauts qui valaient le prix de la méthode :

1. **L'agrégat enregistrait le résidu de la purge au lieu de la mémoire de la journée.** Le balayage
   recalcule chaque journée depuis les analyses encore présentes ; la purge est bornée à 500 par passage et
   son seuil est un INSTANT, pas une frontière de journée. Toute journée traversait donc un état partiel
   pendant lequel le bon compte était écrasé, puis figé quand la journée disparaissait. La table censée
   garder ce qu'on efface enregistrait l'effacement. Éprouvé dans les deux sens : sans la garde, 4 devient
   2 puis reste 2.
2. **Le même prix affiché différemment sur deux écrans.** Corrigé trois fois, déplacé deux fois. La cause
   n'était pas l'inattention : l'inventaire avait été fait sur « qui appelle la fonction qui lit les
   tarifs » au lieu de « qui affiche un prix à un client ». La fonction s'appelait `tarifsMeta` et rendait
   des prix de vente ; le nom fabriquait l'inventaire faux.
3. **Une garde qu'aucun test ne voyait.** En remettant le défaut exact qu'un commit venait de corriger,
   **5683 tests restaient verts**. Les cas appelaient les fonctions en direct : ils prouvaient qu'elles
   calculent juste, jamais qu'on les appelle.
4. **Une garde numérique qui refusait 2,47.** `Math.round(v * 100) === v * 100` : 1146 refus sur les 10001
   valeurs à deux décimales. Invisible parce que les quatre valeurs par défaut tombent du bon côté du
   flottant.

⚠️ **ET DEUX DÉFAUTS ONT ÉTÉ TROUVÉS PAR UNE SONDE, PAS PAR UN TEST** : une date reculée d'un jour
(`2026-11-01` écrit, `2026-10-31` relu, node-postgres rendant une colonne `date` à minuit LOCAL), et une
imputation de coût non bornée par la période. Les deux naissaient de la frontière entre le code et le
pilote, là où une fonction pure est juste et le tout faux.

### La technique qui a rendu ces sondes possibles

Les requêtes à éprouver nommaient des colonnes que la migration n'avait pas encore créées. Un `alter table`
dans une transaction annulée aurait pris un verrou ACCESS EXCLUSIVE sur une table lue par les chemins
chauds. La parade : **`create temporary table <le même nom>`**, `pg_temp` passant avant `public` dans le
`search_path`, avec un pool à `max: 1`. La requête du vrai code s'exécute telle quelle, les autres tables
restent les vraies en lecture seule, et rien ne survit à la déconnexion.

### Le déploiement

Séquence tenue dans l'ordre : `git pull`, build de l'image, **vérification que 0154 et 0155 y sont**,
`migrate`, relecture en base point par point, `up -d --build` des deux images, conteneurs sains PUIS
rechargement de NPM, 9 fiches d'aide chargées, contrôle public vert sur les six chemins.

🔴 **LE MÉCANISME CENTRAL A ÉTÉ VU, PAS SUPPOSÉ** : au démarrage du worker, `agregats-analyse: 6 journee(s)
ecrite(s)`, avant toute purge. Puis vérifié en base par le vrai code : sur les deux espaces, lecture
directe et table d'agrégats rendent des journées IDENTIQUES.

⚠️ **ET LA PURGE N'A RIEN EFFACÉ PARCE QU'ELLE NE LE POUVAIT PAS** : zéro conversation n'a plus de 90 jours
(la plus ancienne date du 2026-08-18). La seule opération irréversible du dépôt a été allumée au moment où
elle ne peut rien détruire, ce qui était le bon moment et pas une chance.

### Ce qui reste dû

L'essai réel, dans ses deux moitiés, dont celle qui pose une marge : le défaut « un écran affiche encore le
tarif brut » est **invisible tant que la marge vaut 100**, ce qui explique qu'il ait échappé à trois revues.

## Ce que c'est

Le contenu intégral de `documentation.md` **tel qu'il était le 2026-09-09**, avant sa réécriture en manuel
technique. Rien n'a été retouché : ni les phrases devenues fausses, ni les compteurs périmés, ni les
« prochaines étapes » d'un lot livré depuis. C'est un instantané, pas une référence.

## Pourquoi il existe

L'audit du 2026-09-08 a mesuré que **61,6 % du manuel était un journal** : livraisons, incidents, mesures,
restes à faire. Le fichier reconnaissait lui-même le problème à propos de `wip.md` (« un point d'entrée qui
devient une archive cesse d'être un point d'entrée ») ; la même dérive s'était simplement déplacée.

La matière, elle, est bonne : les raisons des choix sont expliquées, les conséquences d'une erreur sont
décrites, les comportements difficiles sont reliés à des observations de production. On ne la jette donc pas,
on la SORT du chemin de lecture. Le déplacement s'est fait **verbatim**, sans réécrire une ligne : réécrire
en déplaçant est le meilleur moyen de perdre une information sans s'en apercevoir.

## Comment le lire

- **par date** : les sections de la seconde moitié portent leur date de livraison dans leur titre ;
- **par migration** : le § « LES MIGRATIONS, UNE PAR UNE » raconte 0093 à 0113, une par une ;
- **par incident** : chercher le symptôme, pas le module. La plupart des sections partent d'une panne réelle ;
- **par commit** : plusieurs sections nomment le commit qui les a produites.

⚠️ **Les « reste à faire » qu'on trouve ici ne sont PAS un backlog.** Le backlog vit dans
[todo.md](../todo.md), et lui seul. Un item lu ici peut avoir été fait il y a des semaines.

⚠️ **LES LIENS RELATIFS DE CE FICHIER PARTENT DE LA RACINE DU DÉPÔT**, pas de `docs/`. Ils ont été écrits
quand ce contenu vivait dans `documentation.md`, à la racine, et le déplacement ne les a pas réécrits : la
règle du transfert était « verbatim », et réécrire en déplaçant est le meilleur moyen de perdre une
information sans s'en apercevoir. Un lien `AGENT-IA-PLAN-L2.md` lu ici désigne donc `../AGENT-IA-PLAN-L2.md`.

⚠️ **La recherche textuelle favorise ce fichier**, parce qu'il est long et détaillé : une phrase historique
très précise sort avant une phrase courante plus courte. C'est la raison principale de la séparation
physique. Avant de croire une phrase trouvée ici, vérifier qu'elle existe encore dans le manuel courant.

---

## 2026-09-16 : tester un scénario À PARTIR D'UN BLOC, et le défaut que ça a fait sortir

**Ce qui a été livré.** Un bouton lecture en haut à gauche de chaque bloc du constructeur, qui ouvre le
panneau de test existant avec un lien `wa.me` et un QR démarrant le scénario à CE bloc. Le jeton du scénario
gagne un suffixe facultatif, `test-xxxxxxxx.<identifiant du bloc>` ; le secret reste celui du scénario, le
suffixe n'est qu'un pointeur. Trois commits, plus deux passes de revue : `f4f70d2`, `7f31dd6`, `ab898e8`,
`638156f`, et les correctifs de la revue finale.

**🔴 LE VRAI SUJET N'ÉTAIT PAS LA FONCTIONNALITÉ, C'ÉTAIT UN DÉFAUT EXISTANT.** En cartographiant le code
avant d'écrire le plan, on a trouvé qu'un test DÉMARRAIT sur le brouillon (`startTestRun` passe
`grapheEditable(wf)`) mais REPRENAIT sur le publié : les trois points de reprise de l'exécuteur (`resume`,
`runEnAttenteSur`, `advance`) demandaient le graphe à `getGraph`, que le câblage résout en `row.graph`. Un
test qui atteignait un bloc d'attente et recevait une réponse changeait donc de version EN SILENCE, et si son
bloc courant n'existait pas dans le publié, le parcours se figeait sans un mot. Le défaut vivait là depuis la
séparation brouillon / publié (lot 7, 2026-09-01). Réparé par la migration 0151 (`workflow_runs.graphe_fige`)
et un point de passage unique, `grapheDuRun`.

**Ce que la revue de chaque lot n'a pas pu voir.** Les trois lots ont chacun eu leur revue avant commit. Une
revue GLOBALE, passée ensuite sur les trois ensemble, a trouvé six défauts de plus, dont deux réels : la
couture navigateur / serveur n'était testée nulle part (l'E2E utilisait `n1` et `n2` comme identifiants de
bloc, jamais un UUID), et l'invariant « un contact réel ne tombe jamais dans un brouillon » était vrai mais
gardé nulle part. **La leçon : sur un plan à plusieurs commits, la revue par lot ne remplace pas la revue
d'ensemble, parce que ce qui vit ENTRE les lots n'appartient à aucun d'eux.**

**Et ce que la revue FINALE, faite par un relecteur séparé, a trouvé de plus.** Quatre rouges, dont deux que
l'auteur du code ne pouvait pas voir :
- **Une décision produit inversée en silence.** Julien avait tranché « pas d'avertissement sur les étapes
  sautées, le panneau reste le QR et le lien ». Un bandeau avait été ajouté, et même vendu dans `features.md`
  et dans la fiche du bot d'aide. Retiré le jour même, sur sa confirmation.
- **Une classe de caractères supposée sur une valeur que le schéma ne contraint pas.** Le suffixe de bloc
  était borné à `[0-9a-z_-]{1,64}`, sur une MESURE d'un jour (« les 64 blocs de production portent tous un
  UUID minuscule »). Or `parseGraph` accepte n'importe quelle chaîne non vide comme `node.id`. Un identifiant
  hors de cette classe faisait rendre `null` à la lecture du jeton, donc **le message n'était pas consommé**
  et descendait jusqu'à l'agent de Meta, qui répondait au testeur. Une supposition qui échoue doit donner un
  refus LISIBLE, jamais une fuite silencieuse : le suffixe n'a plus de forme imposée, et sa casse est
  préservée (le texte entier était mis en minuscules, ce qui faisait échouer l'égalité sur un identifiant
  portant une majuscule).

**⚠️ ET UNE FENÊTRE DE DÉSYNCHRONISATION QUI N'APPARTIENT À AUCUN LOT.** `engageme.messagingme.app` part sur
Vercel à chaque `git push`, `api.messagingme.app` demande un déploiement manuel. Le bouton lecture a donc été
VISIBLE en production pendant que le serveur ne savait pas lire le suffixe. Conséquence exacte, pire qu'une
panne visible : l'ancien filtre refuse le point, le mot n'est pas reconnu comme un jeton, il n'est pas
consommé, et il descend jusqu'à l'agent de Meta. La conversation n'est pas non plus marquée « test », donc
elle compte dans les statistiques. **Règle pour la prochaine feature qui traverse cette frontière : ordonner
les lots pour que le front parte EN DERNIER.**

---

# documentation.md : technique

## Où tourne quoi (depuis la bascule du 2026-09-03)

Trois noms, deux hébergeurs. Journal d'exécution complet et raisons de chaque choix :
[docs/PLAN-BASCULE-VERCEL-2026-09-03.md](docs/PLAN-BASCULE-VERCEL-2026-09-03.md).

```
   navigateur, Meta, contacts, opérateur télécom
                      |
                  Cloudflare
            /                        engageme.messagingme.app     api.messagingme.app        mba.messagingme.app
      (Vercel, la console)     (un NOM, pas une machine)   (ancienne console + legacy)
                                        |                          |
                                  VPS OVH aujourd'hui        mba-web + routage NPM
                                  (mba-api + mba-worker)
                                        |
                                    Supabase
```

🔴 **`api.messagingme.app` est un NOM, pas une machine, et c'est tout l'intérêt.** Le front, les contacts qui
cliquent et l'opérateur télécom ne connaissent que cette étiquette. Le jour du déménagement vers Scaleway :
monter l'API et le worker là-bas, changer l'enregistrement DNS de `api.`. Le front ne bouge pas, les liens
DÉJÀ ENVOYÉS qui pointent sur `api.` continuent d'ouvrir, rien à redéployer.

🔴 **MAIS ÉTEINDRE OVH NE SE RÉSUME PAS À CE CHANGEMENT DE DNS, et cette page a affirmé le contraire.** Elle
écrivait « changer UN enregistrement DNS, éteindre OVH... le webhook Meta ne bouge pas ». C'est faux, et la
raison est deux paragraphes plus bas : **Meta appelle toujours `mba.messagingme.app/api/backend/webhooks/meta`**,
et `mba.` est le VPS. Les anciens `/r/`, `/m/` et `/mcp` y vivent aussi. Éteindre OVH après avoir seulement
repointé `api.` couperait donc le webhook entrant et toutes les adresses historiques déjà distribuées.

⚠️ **C'est le même angle mort que celui du changement de nom du front** (§ sécurité de `CLAUDE.md`) : on
pense à ce qu'on a DONNÉ comme adresse, on oublie ce qui pointe encore sur l'ANCIENNE. Ici c'est le routage
par chemin de `mba.` qui a rendu la bascule Vercel indolore, et c'est exactement lui qui retient le VPS.

**Ce qu'il faut faire AVANT d'éteindre OVH**, et dans cet ordre : déplacer le routage de compatibilité de
`mba.` vers un point d'entrée indépendant du VPS (règle Cloudflare ou équivalent) qui retire le préfixe
`/api/backend/` vers `api.`, y route `/r/`, `/m/` et `/mcp`, et redirige le reste vers `engageme.`. Cette
voie a un RETOUR ARRIÈRE et ne demande aucun geste chez Meta. Reconfigurer le webhook chez Meta est possible
mais se fait sans filet : le temps que Meta reprenne l'adresse, les messages entrants tombent.

**Le worker n'a aucune adresse et personne ne l'appelle** : il lit la base et travaille. Il voyage avec l'API.

**Le routage par chemin de `mba.messagingme.app`** (`advanced_config` du proxy host NPM 21) :
`/api/backend/*` → `mba-api` avec le préfixe RETIRÉ par nginx (`proxy_pass` à barre finale), `/r/`, `/m/` et
`/mcp` → `mba-api` directement, tout le reste → `mba-web`. C'est ce qui a permis de faire cette migration
**sans jamais toucher à la configuration du webhook chez Meta**, et ce qui a retiré un conteneur de front du
chemin critique de réception des messages clients.

**Comment le navigateur trouve l'API** : `web/lib/http.ts` lit `NEXT_PUBLIC_API_URL`, avec repli sur
`/api/backend` (le proxy de même origine, donc zéro CORS). Côté API, `CORS_ORIGINS` est une liste blanche,
sans `credentials`, vide par défaut. La session voyage en `Authorization`, jamais en cookie : c'est ce qui
rend ce cross-origine sans piège et ce qui interdit d'activer les credentials.

## Architecture (async découplé, 3 étages)

Le traitement synchrone est exclu (timeout Meta au moindre pic). Flux entrant :

1. **Webhook Receiver (bouclier)** : Fastify. Valide la signature `X-Hub-Signature-256`,
   pousse le payload brut en file, répond `200` immédiatement (cible < 50 ms). Zéro logique
   métier. Route `POST /webhooks/meta` (+ handshake `GET /webhooks/meta` avec `hub.challenge`).
2. **File durable** : `pg-boss` sur Postgres (PAS en RAM : une file mémoire perd les jobs au
   crash). Transactionnelle avec nos données. Interface abstraite pour basculer BullMQ+Redis
   si l'échelle Phase 3 le justifie.
3. **Workers** : dépilent à rythme maîtrisé. Réconciliation contacts (E.164/BSUID, merge CTA),
   mises à jour DB, notifications.

File OUTBOUND critique (campagnes) : pacing (plafond Meta), lissage, ralentissement auto sur
dégradation du quality rating, fréquence max par contact. C'est là que vivent les garde-fous.

## Stack

- **Runtime** : Node.js >= 22 (`engines` de `package.json`, images `node:22-alpine` des deux Dockerfile),
  TypeScript (ESM), `tsx` en dev **et en production** (le conteneur lance `npx tsx`, jamais `node dist` :
  ESM `moduleResolution: Bundler` sans extensions). `npm run build` (tsc) n'est pas le chemin de déploiement.
- **API/Receiver** : Fastify 5.
- **Validation** : zod.
- **File** : pg-boss (Loop 1).
- **DB** : Postgres = **Supabase** (projet `messagingme-MBA`, ref `npdqnrirxhqsyyvtvtjz`,
  org distincte de leadgen/EDH → invisible au MCP Supabase, connexion directe uniquement).
  Migrations SQL versionnées dans `db/migrations/`, appliquées via `npm run migrate`
  (`db/migrate.ts`, suivi `schema_migrations`). Connexion directe `db.<ref>` en IPv6-only ;
  fallback pooler IPv4 (session mode) documenté dans `.env`. Un Postgres local (Docker) peut
  servir pour des tests isolés si on veut éviter de taper la prod.
- **Frontend** : **Next.js 15 App Router** (`web/`), Tailwind PUR (pas de shadcn), tokens MM
  (brand/ink/mint/coral/gold/navy). Auth JWT (jose HS256), session côté client. **3 statuts de membre** admin / manager / agent (`ROLES` dans
  `src/http/users.ts`, migration 0065) ; tout ce qui est réservé l’est à `admin`, un manager a aujourd’hui les
  accès d’un agent (cf « Rôle `manager` »).
  Le front proxifie `/api/backend/*` vers `mba-api` (pas de CORS).
- **Auth** : login JWT (jose HS256, scrypt async, rate-limit + hash leurre anti-énumération), isolation
  tenant sur toutes les routes, **RBAC** (`adminOnly = active !== 'inbox'` ; écritures admin-only).
- **Tests** : vitest. 240 fichiers dans `tests/` (3009 cas unitaires, sans base) et 27 fichiers dans
  `tests/integration/` (265 cas, Postgres requis), au 2026-08-29. ⚠️ Les tests d'intégration ne se lancent
  PAS en local : le `DATABASE_URL` du `.env` pointe la base de PRODUCTION. La CI monte un Postgres jetable
  (job `integration`), donc c'est le run GitHub qui fait foi, pas un `npm test` vert en local.
- **Hosting** : VPS OVH + Docker. 3 conteneurs (`mba-api` Fastify :8095, `mba-worker` (7 files pg-boss + une quinzaine de balayeurs, cf « Files et balayeurs »),
  `mba-web` Next :3000) sur le réseau `mcp-robot_default`, NPM `mba.messagingme.app`. Cf `DEPLOY.md`.
- **Email** : deux chemins qui n'ont rien à voir. (1) **Resend** pour les mails du produit (formulaire de
  support, invitation, réinitialisation), destinataire et expéditeur fixés côté serveur. (2) **nodemailer /
  SMTP par workspace** pour le CANAL email du builder (bloc « Envoi de mail », migration 0062, `src/email/`) :
  la boîte est déclarée par le client, son mot de passe est chiffré au repos (AES-256-GCM, `src/crypto/secretbox.ts`).

## Schéma DB

Migrations SQL versionnées `db/migrations/`, suivi `schema_migrations` **par NOM de fichier** (les numéros non
contigus sont donc sans conséquence : 0060 n'existe pas, cf. l'en-tête de 0062), appliquées via `npm run migrate`.

**Dernière migration du repo : 0088** (`agent_tool_sources`, lot L2). **Prochaine libre : 0089.** Le compteur
vivant est tenu dans `CLAUDE.md` et dans `DEPLOY.md`, pas ici : ce paragraphe a annoncé « dernière : 0025 »
pendant que le repo en comptait 63 de plus.

🔴 **Migrations NON auto-appliquées.** Une migration qui AJOUTE une colonne écrite par le code passe AVANT le
déploiement ; une migration qui RETIRE une colonne encore lue par l'ancien code passe APRÈS (cf `DEPLOY.md`).
🔴 **Les migrations vivent DANS L'IMAGE** (`COPY db ./db` du Dockerfile), pas sur le disque du VPS : un
`git pull` suivi de `compose run ... npm run migrate` rejoue les ANCIENNES sans rien signaler. La séquence
commence donc par `sudo docker compose build mba-api`.

Tables :
- `tenants` / `users` (`role` ∈ admin|agent, `name` nullable 0013, `disabled` 0014) / `waba` / `phone_numbers`.
- `contacts` : identité BSUID-native (`phone_e164` OU `bsuid`), opt-in tracé, `fields jsonb` (user fields),
  `tags text[]`. Merge jsonb qui n'écrase jamais une clé absente.
- `campaigns` (0003) : `template_name`/`template_language` (**nullable** depuis 0024, couplage par CHAÎNE,
  pas de FK), `category`, `status` ∈ draft|running|paused|completed|failed, + **`workflow_id`** (0024, FK
  `workflows` on delete set null) = campagne déclencheur de workflow (XOR template),
  + **`webhook_id`** (0084, FK `webhooks` on delete set null) = campagne AU FIL DE L'EAU : elle naît sans
  destinataire, chaque arrivant du webhook en devient un, et elle ne passe jamais `completed` toute seule.
- `campaign_recipients` (0003+) : `status` interne ∈ pending|sending|sent|failed|skipped, `sent_at`, +
  **`delivery_status`** (0007) ∈ null|sent|delivered|read|failed (cycle Meta, écrit MONOTONE par message_id).
- `conversation_messages` (0009) / `conversations` : inbox. `template_category`/`template_name` (0012),
  **`sender_user_id`** (0017, FK users, on delete set null) = auteur d'une bulle sortante (pastille).
- `flows` (0015) : id = id Meta, `status` ∈ DRAFT|PUBLISHED, `fields jsonb` (DÉRIVÉ), + **`elements jsonb`,
  `ref text` (unique), `mapping jsonb`** (0016, modèle riche), + **`cta text`** (0021, libellé du bouton final).
- `workflows` (0022) : `name`, `status` ∈ draft|active, **`graph jsonb`** `{nodes[], edges[]}` (scope tenant).
- `workflow_runs` (0023) : état d'exécution PAR contact : `workflow_id`, `contact_id`, `wa_id`, `current_node`,
  `status` ∈ waiting|inbox|done, `last_message_id` (dédup d'avance). Index partiel sur les runs `waiting`.
- `webhooks` (0074) : webhooks ENTRANTS (menu Tools). `code` (26 car. base32, unique GLOBAL, c'est la clé
  d'accès publique), `secret_hash` nullable, `mapping jsonb` (`[{chemin, cible}]`), `create_contact`,
  **`automation_id`** (FK `automations` on delete set null) = la ligne compagnon qui porte le scénario,
  `last_payload`/`last_received_at` (le DERNIER appel seulement), `contacts_created`.
- `webhook_events` : log brut, `meta_message_id` unique (idempotence). pg-boss = schéma `pgboss` séparé.

## Flows (modèle riche, migration 0016)

`src/meta/flow-json.ts` : un flow = des **écrans** (`FlowScreenDef {title?, cta?, elements}`, Lot 7) dont les
éléments sont ordonnés (`heading|subheading|body|caption|image|field`). `buildFlowScreens(name, screens,
version, ref, cta)` rend le flow_json : ids d'écrans `FORM`/`FORM_B`/… (**lettres+underscores UNIQUEMENT**,
sondé live : un chiffre est rejeté ; l'écran 1 reste `FORM`, baké en `navigate_screen` des templates approuvés
ET dans `sendFlowMessage`), PAS de `routing_model` (facultatif sans endpoint, sondé 7.2/7.3), Footers
intermédiaires `navigate` (payload `{}`), Footer terminal `complete` dont le payload **agrège TOUS les champs**
: refs globales `${screen.<ID>.form.<clé>}` (écrans précédents) + `${form.<clé>}` (dernier) + la **constante
`_ref`** (discriminant du retour `nfm_reply`). ⚠️ Refs globales : payloads d'action SEULEMENT, PAS dans les
textes affichés (non résolues, sondé). Clés de champ GLOBALEMENT uniques (`deriveScreens`, collision inter-
écrans -> 400). Un Flow mono-écran est un multi-écran à un seul élément : pas de chemin de code séparé.
**Conditions** : `visibleIf` (input `{field: LIBELLÉ source, op eq|neq, value}` -> stocké `{fieldKey}`) ->
propriété `visible` backticks ; sources dropdown/radio/optin du MÊME écran situées AVANT ; valeur ∈ options
(sans apostrophe/backtick, refusées) ou booléen. Sondé live : champ masqué/vide **OMIS** du payload complete
(-> `hasOwnProperty` du mapping suffit, aucun écrasement) ; un `required` caché ne bloque NI navigate NI
complete. Stockage : colonne jsonb `flows.elements` **POLYMORPHE sans migration**, normalisée par `screensOf`
à la lecture (null legacy / tableau plat historique = 1 écran / `{screens}` nouveau). `fields` reste DÉRIVÉ
(`fieldsOfScreens`). Image = **base64 BRUT** embarqué. `bodyLimit` 7 Mo. Édition d'un DRAFT = `POST
/{flow_id}/assets` en **multipart** (create en JSON inline : vérifié live) ; PUBLISHED immuable (409) ->
duplication (ref régénéré). **Sonde committée** : `scripts/sonde-flow-live.mts` (fixture via le code produit
POSTée en draft sur le WABA réel, exige `validation_errors == []`, delete) : à rejouer à chaque évolution
du générateur.

**Mapping webhook (défensif)** : à la réception d'un `nfm_reply`, `webhooks/flow-mapping.processFlowCompletions`
retrouve le flow par `_ref` (`findByRef`), itère sur NOTRE mapping (clé champ -> clé user field, jamais les
valeurs brutes -> `_ref`/`flow_token` jamais écrits) et fait un MERGE jsonb sur le contact
(`mergeFieldsByPhone`, même matching que l'inbox). **Isolé en try/catch, ne throw JAMAIS** : partage le job
webhook des statuts de livraison, un mapping cassé ne doit pas rejouer/DLQ les statuts.

## Builder de formulaires (A) + Workflow builder (B) : lot 3

**Dépendance front** : **`@xyflow/react`** (React Flow, ^12, MIT) pour l'éditeur de graphe de blocs.
Seule lib ajoutée du lot ; tout le reste reste Tailwind pur. (État au 2026-08-29 : le front n’a que DEUX
  dépendances de production hors React/Next, `@xyflow/react` et `qrcode`. Toujours aucune lib de charts,
  aucun shadcn.)

**(A) Formulaires WhatsApp** (`web/components/FlowBuilder.tsx`) : builder visuel de TOUS les composants d'un
écran Flow : textes (heading/subheading/body/caption), image, saisies (`text|email|phone|number|passcode`,
textarea, date), **choix à options** (`Dropdown`/`RadioButtonsGroup`/`CheckboxGroup`, data-source `id=title`),
**OptIn** (consentement -> **champ booléen dédié**), **Footer = bouton final au libellé personnalisable** (`cta`).
Aperçu en direct (`FlowScreenPreview`). ⚠️ RGPD : un champ basculé en `optin` **réinitialise son `saveTo`**
(front `changeType`/submit + back `parseFlowBody`) pour qu'un booléen de consentement ne puisse jamais écraser
un autre user field.

**(B) Workflow builder** (`src/workflow/`, menu gauche « Flow ») :
- **Modèle** `graph.ts` : `parseGraph` PUR (sanitise, intégrité référentielle arête->node, caps 200 nodes /
  400 edges). **15 types de bloc** (`WORKFLOW_NODE_TYPES`, source unique) : `template`, `quick_message`,
  `inbox`, `flow`, `question`, `tag`, `field`, `condition`, `action`, `wait`, `mba_handoff`, `mba_disable`,
  `rcs_message`, `email`, `agent`. Cette liste est la SEULE : un type ajouté sans y passer n'existe pas pour
  le moteur.
- **Moteur** `engine.ts` : `walk(graph, startNodeId)` LINÉAIRE : blocs `tag`/`field` = action synchrone puis on
  continue ; `template`/`flow` = envoi puis **attente** ; `inbox` = terminal (conversation remontée à l'humain) ;
  anti-cycle. `executor.ts` : `start` applique les actions + persiste le run ; `advance` quand le contact répond,
  **dédup par `last_message_id`**.
- **Avance** branchée sur le webhook inbound (`webhooks/workflow-advance.processWorkflowAdvance`), **ISOLÉ en
  try/catch par message** (comme le flow-mapping : ne throw jamais, partage le job webhook des statuts).
  ⚠️ V1 : avance sur **n'importe quelle** réponse inbound (pas de branche par bouton quick-reply -> réservé).
- **Déclencheur = campagne** (`campaign/engine.ts`) : si `campaign.workflow_id`, le run de campagne appelle
  `startWorkflow` (executor.start) par destinataire **au lieu d'un envoi template**, en réutilisant l'infra
  campagne (claim atomique anti double-envoi, quality gate, fréquence marketing) : **pas de nouvelle file ni
  rate gate**. message_id synthétique `wf-<id>` (la livraison/lecture Meta n'est donc PAS suivie pour ces
  campagnes -> funnel delivered/read=0, limitation V1 assumée). Route create = **Template XOR Workflow**
  (`workflowBelongsToTenant` valide l'appartenance). `getTemplateBreakdown` exclut les campagnes workflow
  (`template_name is not null`).

## Identité contact (numéro OU BSUID)

`src/crm/identity.ts` expose `waIdOf(phone, bsuid)` (clé de routage WhatsApp) et `classifyWaId(waId)` :
7-15 chiffres -> `{phoneE164:'+'+waId}`, sinon `{bsuid}` (heuristique, aucun trafic BSUID en prod aujourd'hui
-> à confirmer au 1er BSUID réel).

⚠️ **La règle d'AFFICHAGE « numéro sinon BSUID » n'est PAS factorisée.** Corrigé le 2026-07-18 : ce paragraphe
annonçait `src/crm/identity.ts` comme « source unique de la règle » alors que le `contactIdentity` serveur
n'avait aucun appelant (supprimé depuis). La règle est réécrite à la main à trois endroits :
`web/lib/api.ts` (`contactIdentity`, le seul vivant, utilisé par les pages Contacts et Campagne),
`src/api/sends-build.ts` et `src/campaign/build.ts`. Les factoriser est un chantier ouvert, pas un acquis.
- `contacts` porte `phone_e164` + `bsuid` (0001, contrainte « au moins un », 2 index uniques partiels).
  `ContactRow.bsuid` exposé partout (tous les selects). Front : colonne « Identifiant », fiche « Compte
  WhatsApp », sélection/label campagne via le `contactIdentity` DU FRONT (`web/lib/api.ts`).
- **Auto-création depuis l'inbound** : `PgContactStore.upsertFromInbound` (upsert par l'index unique phone OU
  bsuid, opt-in 'unknown' à la CRÉATION seulement, `opt_in_source='inbound'`, coalesce du profile_name).
  Câblée dans `processInbound(payload, store, upsertContact?)` AVANT `recordInbound`, **isolée** (un échec ne
  casse pas l'inbox). 7e param `inboundContactUpsert?` de `handleWebhookJob`, branché dans `worker.ts`.
- **Matching étendu au BSUID** : `mergeFieldsByPhone`/`addTagsByPhone` + le lien conversation->contact
  (`recordInbound`) matchent `or bsuid = $2` (flow-mapping, blocs tag/champ de workflow atteignent un BSUID).
- **Envoi identity-aware** : `messagingTarget(identity)` (`src/meta/types.ts`) = numéro (`+…` ou chiffres nus
  <= 15) -> `{to}`, sinon -> `{recipient}`. Utilisé par `MetaClient.sendTemplate` (route inbox + workflow +
  campagne utility) et l'engine marketing (`sendMarketing({...messagingTarget, template})`). `buildRecipients`
  cible `phone_e164 ?? bsuid`, dédup par identité. Branche workflow de l'engine : `waId` = chiffres nus pour un
  numéro, BSUID intact (jamais dénaturé par un strip de non-chiffres).

## Formulaires : suppression (Meta)

`MetaFlowClient.delete` (DRAFT -> `DELETE /{flow}`) / `deprecate` (PUBLISHED immuable -> `POST /{flow}/deprecate`).
Route `DELETE /flows/:id` : getFlow (404) -> Meta (deprecate si PUBLISHED sinon delete) -> `PgFlowStore.remove`.
**Meta AVANT store** : un refus Meta (flow rattaché à un template) remonte en 422 et conserve la ligne locale
(pas d'orphelin). Front : retrait optimiste + rollback sur erreur.

## Lot 5 : sélecteur de variable (hints) + branche par bouton

**Variable picker + propagation (hints)** : à la création de template, le front (`web/app/templates/page.tsx`)
insère `{{n}}` via un sélecteur de champ et pose des `paramHints` (`{position, source}`, source = `ParamSource`).
Persistés dans **`template_param_hints`** (migration 0025, PK tenant+name+language+position) via
`PgTemplateHintStore` (`save` = REMPLACE transactionnel). `src/http/templates.ts` : `parseParamHints` (sparse,
pas de 1..N contigu), 400 si malformé AVANT Meta, `saveHintsSafe` best-effort ; ⚠️ **clé `paramHints` ABSENTE =
on NE touche PAS aux indices** (un PATCH hors-variables ne les efface pas ; seul un tableau explicite remplace).
Route `GET /templates/:name/param-hints?language=`. La campagne (`chooseTemplate`) lit les hints pour
pré-remplir son mapping (anti-course `chooseSeq`). `WhatsAppPreview` : `renderBody` rend un chip `[Label]` si
`varLabels` fourni, sinon substitution par exemple. Exemples déterministes = **front** (`deterministicExample`,
par clé connue puis par type), jamais vide (garde serveur).

**Branche par bouton (workflow)** : le node `template` dénormalise ses boutons (`node.data.templateButtons`, via
`TemplateSummary.buttons`). L'éditeur (`WorkflowBuilder.tsx`) expose un handle source `id="btn:<index>"` par
bouton quick-reply (URL/flow grisés non-reliables) ; sans quick-reply -> une seule sortie bas (repli).
`onConnect` dédup par (source, sourceHandle). Moteur : `engine.nextNodeByHandle(graph, node, handle)` ;
`executor.advance(tenant, waId, msgId, buttonPayload)` = `(buttonPayload ? nextNodeByHandle : null) ?? nextNode`
(repli 1re arête sur texte / bouton non câblé) ; `workflow-advance` relaie `m.buttonPayload`. **Envoi
déterministe** : `worker.ts` pose un payload CONTRÔLÉ sur chaque quick-reply (`components` :
`{type:'button', sub_type:'quick_reply', index:String(i), parameters:[{type:'payload', payload:'btn:'+i}]}`) ->
le webhook renvoie `btn:<index>`, la branche est sûre (pas de pari sur le défaut Meta). Aucune migration
(sourceHandle déjà dans le modèle/jsonb). ⚠️ V2 (todo) : snapshot des boutons figé + arêtes orphelines à la
re-sélection de template.

## Campagne : une-page 2 étapes, sources, débit, planification (Lot 8, 2026-07-17, mig 0032-0034)

Écran `web/app/campaigns/page.tsx` (`AppShell fullBleed`, conteneur scrollable interne). CreateForm en 2 étapes ;
le lancement est RAPATRIÉ (createCampaign -> runCampaign + polling inline, gardes `mountedRef`/`onBusyChange`).

- **Filtres CRM requêtables** (`src/crm/contact-store.pg.ts`) : `buildWhere` construit un WHERE 100 % PARAMÉTRÉ
  (y compris la CLÉ jsonb `fields ->> $key`, liée ; `tenant_id=$1` TOUJOURS). `ContactFilters` : tags AND(@>)/OR(&&),
  optIn, phonePrefix (ancré), phoneContains (chiffres nus), nameSearch (ilike), fieldFilters eq/contains.
  `query`/`count`/`idsForFilters`. Route GET /contacts étendue (+ /count, /ids) dans `src/http/import.ts`
  (`parseFilters` défensif ; `hasFilters` route query vs listContacts). Index mig **0032** (pg_trgm nom + GIN jsonb).
  Front : source-picker + panneau de filtres + compteur live (debounce 350ms, anti-course).
- **Import comme source** : composant partagé `web/components/CsvImport.tsx` (extrait de contacts/page, `requireTag`
  pour la campagne) ; après import, pivot sur la source CRM filtrée par le(s) tag(s).
- **Débit par campagne** (mig **0033** `campaigns.rate_per_minute` CHECK 1..80, null=pas de throttle) : `run-job`
  construit un `RateLimiter(ceil(60000/rate))` PAR RUN (factory `makeRateLimiter` injectable). ⚠️ **Timeout de job
  DIMENSIONNÉ** (`src/campaign/pacing.ts` `campaignJobExpireSeconds(n, rate)`) passé PAR JOB à l'enqueue (`/run`
  via `getRunSizing`) : un timeout FIXE ne couvre pas un run throttlé long -> pg-boss le rejoue en parallèle
  (débit x2). `Queue.enqueue` accepte `expireInSeconds`. Cf `brain/LEARNINGS.md` 2026-07-17.
  ⚠️ **Plafonné à 23 h** depuis le 2026-08-25 : pg-boss REFUSE toute expiration atteignant 24 h (assert strict),
  donc au-delà d'environ 954 destinataires à 1/min ou 4767 à 5/min l'enfilement levait et la campagne ne partait
  JAMAIS (500 opaque en immédiat, blocage silencieux et perpétuel en programmé). Contrepartie : au-delà d'environ
  1380 x débit destinataires, le run expire en cours d'envoi et est rejoué en parallèle ; le claim atomique par
  destinataire empêche le double envoi, mais le débit double pendant le chevauchement.
- **Planification** (mig **0034** `scheduled_at` + statut `scheduled` + index partiel ; Path B) : route `/run`
  accepte `scheduledAt` FUTUR (409 non programmable, 400 passé) -> statut `scheduled` ; `/cancel-schedule`.
  Sweeper `src/campaign/schedule-sweep.ts` (worker, 60s) : `listDueScheduled` -> enqueue (expire dimensionné) PUIS
  `markScheduledRunning` (pas de 'running' orphelin ; idempotent singletonKey + garde). `CampaignStatus += scheduled`
  propagé (STATUS front, garde D1 template, counts sans filtre). `scheduled_at` en timestamptz UTC ; front convertit
  `datetime-local -> ISO UTC` au clic.

## Conversations (analyse) : lecture des agrégats Pièce 1 (Lot 9, 2026-07-17, 0 migration, 0 LLM)

Surface l'analyse de conversation (moteur Pièce 1 `src/analysis/*`, table `conversation_analysis` mig 0027,
ACTIF en prod `CONVERSATION_ANALYSIS_ENABLED=true`) qui n'avait AUCUN lecteur. Le Lot 9 est une couche de
LECTURE pure, séparée du moteur d'écriture.
- `src/stats/conversation-stats.pg.ts` `PgConversationStatsStore(pool, enabled)` : `getSummary(tenantId, range)`
  = UNE passe `count(*) FILTER` sur tous les enums (sentiment/intent/handled_by/action) + `avg`/`percentile_cont`
  exchanges + buckets confidence ; `group by lower(btrim(topic))` séparé (top 10). `listAnalyzed(tenantId, range,
  {sentiment?,intent?,action?,limit?})` = join `conversations` (wa_id) + left join `contacts` (profile_name,
  contact_id nullable), `inboxHref='/inbox?c=<id>'`. **`tenant_id=$1` sur CHAQUE requête** (double barrière avec
  scopeTenant). Bornes CTE Europe/Paris identiques à PgStatsStore.
- Routes `src/http/stats.ts` (admin-only) : `GET /stats/conversations` (summary + `enabled`) et
  `/stats/conversations/list` (filtres validés contre un SET d'enum -> valeur hors enum IGNORÉE, pas d'injection ;
  limit borné). `api.ts` : `getConversationAnalysisSummary` / `listAnalyzedConversations`.
- Front : `web/components/ConversationAnalysisCard.tsx` (self-fetch isolé, donut SVG maison **pas de lib de
  charts**, barres, empty-state différencié `enabled` vs `total=0`). Deep-link inbox : `web/app/inbox/page.tsx`
  lit `?c=<conversationId>` (useSearchParams sous Suspense, pré-sélection une fois via ref).
- ⚠️ **Sémantique** : `conversation_analysis.created_at` est réécrit à `now()` à chaque ré-analyse (upsert) ->
  date de DERNIÈRE analyse, pas de la conversation ; agrégat = instantané « à date de dernière analyse », pas un
  registre (cf `brain/LEARNINGS.md`). Champs LLM = INDICATIFS ; `handled_by`/`exchanges` déterministes ; bucket
  `mba` inatteignable (MBA fermé). **1 seul enrichissement en base au 2026-07-17** (peu de trafic) -> empty-state
  vu jusqu'à montée en charge.

## Analytics (stats, plage de dates)

`src/stats/range.ts` : `DateRange {from,to}` (YYYY-MM-DD, Europe/Paris), `parseRange` (repli `?days=`,
400 si from>to / to futur / span>366), `rangeToUnix` (epoch minuit Paris de from..to+1, **DST-aware**, pas
de `date*86400`). `PgStatsStore` : bornes SQL EXCLUSIVES (`(to+1)@TZ`), `IS DISTINCT FROM 'failed'`
obligatoire (delivery_status null souvent). Routes (admin-only) : `/stats`, `/stats/templates`,
`/stats/campaign-funnel?campaignId` (sent/delivered/read/**replied**/failed ; « replied » = inbound après
sent_at attribué au dernier envoi, join `to_e164`↔`wa_id`), `/stats/errors?templateName` (group by
`(error_code, template_name, campaign_id)` depuis le 2026-09-07 : la CAMPAGNE voyage avec la ligne, ce qui
permet à l'écran de filtrer par campagne OU par template sans redemander au serveur, axes exclusifs ; filtre
template optionnel côté serveur, l'UI agrège par code), `/stats/errors/:code/contacts?from&to&campaignIds&templateNames`
(**QUI** a été touché, plafonné à 200 et le dit quand il tronque), `/stats/cost?campaignId&templateName`
(coût/jour estimé).
🔴 **Les contacts touchés sont servis par `PgErreursLivraisonStore.lister`, le journal de `/parametres`, pas
par une requête propre à Analytics.** Une seconde requête a été écrite puis SUPPRIMÉE le 2026-09-07 : elle
comptait une population voisine, et les deux écrans portent le même titre. Population et date vivent depuis
dans **`src/campaign/echecs-sql.ts`** (`RECIPIENT_FAILED_SQL`, `INSTANT_ECHEC_SQL`), importés par les quatre
lecteurs (compteurs de campagne, auto-relance, journal, statistiques).
🔴 **`claimed_at` dans l'ancrage n'est pas une précaution** : mesuré en production, **24 échecs sur 25** n'ont
ni `sent_at` ni `delivery_updated_at` (un refus à l'envoi n'envoie rien). Le journal s'arrêtait à
`coalesce(delivery_updated_at, sent_at)` et affichait donc une date vide pour la quasi-totalité de ses lignes.
⚠️ **Deux trous que l'écran d'Analytics DIT** : la portée est celle des campagnes (aucune colonne d'erreur sur
`conversation_messages`, un envoi de scénario ne journalise que son succès), et un tableau PAR CODE n'a pas de
ligne pour un échec sans code Meta (2 sur 25 en production : template inenvoyable, panne réseau). `error_code` (0020) alimenté par `extractDelivery` (webhook) + `markResult` (échec d'envoi,
`MetaApiError.code`). **Coût = backend** : `getCostVolume` (volume/jour/catégorie, filtrable) × tarif Meta
(`getPricing`), combinés par `estimateCostSeries` (pur, `src/stats/cost.ts`, jamais de coût sans tarif).
🔴 **Depuis le lot E (2026-09-08), un SECOND écran lit les mêmes tarifs** : le tableau « ce que coûte un
engagement » de la page de synthèse (`getVolumeParCampagne` + `estimateCoutParCampagne`). Les tarifs
passent par le lecteur unique des TARIFS de template (`tarifsMeta` à l'époque, renommé `prixFactures` le
2026-09-18 quand il s'est mis à rendre des prix de VENTE ; `getPricing` lit le même endpoint pour son
propre résumé), parce que
deux lectures écrites séparément divergent (l'une qui lit la devise, l'autre non) et que le client
comparerait deux totaux qui devraient être le même. Le comptage des clics suit la même règle :
`clicsParCampagne` sert le funnel d'une campagne ET le tableau de toutes. Le tableau est PLAFONNÉ
(`PLAFOND_CAMPAGNES_SYNTHESE`, 50) : le SQL en garde une de plus pour savoir qu'il tronque, et l'écran
le dit. La plage acceptant 366 jours, une liste sans borne aurait rendu des centaines de lignes.
⚠️ **Ce tableau est la page d'ACCUEIL de l'onglet**, et il fait tourner la requête d'envois facturables, dont la sous-requête d'attribution est corrélée et sans index (voir `envoisTemplateFacturables`). Aucun cache n'a été posé : la production compte quelques campagnes, et un cache spéculatif serait une invalidation de plus à tenir. Le jour où l'écran traîne, la brique existe déjà (`src/lib/cache-court.ts`), et c'est elle qu'il faut utiliser, pas un second mécanisme. 🔴 Depuis le 2026-09-07, ce qui n'est pas chiffrable est **compté** (`nonChiffrables`) au lieu de disparaître du calcul : un envoi sans catégorie connue produisait un coût nul que l'écran affichait sans rien dire, et 22 envois de scénario du tenant Demo étaient dans ce cas.

## Accueil + statut compte

`src/account/service.ts` (`computeAccountStatus` PUR, « jamais de faux vert »), `src/account/pull.ts`
(`pullFromInfo`/`pullFromError`, pur), `src/meta/phone-number.ts` (`GET /{phone_number_id}`),
`src/account/store.pg.ts` (persiste status/quality/tier, migration 0019). Routes `GET /tenants/:t/account-status`
(admin, ne throw jamais) + `GET /tenants/:t/me` (tout authentifié, « Bonjour {prénom} »). Front `/accueil`.

## Exploitation cross-tenant `/ops` (interne)

Autorité SÉPARÉE du JWT tenant : secret d'env `OPS_TOKEN` comparé constant-time (`makeRequireOps`,
`timingSafeEqualStr`). Vide -> 401 (désactivé). Fail-fast prod si défini et < 32 octets. `PgOpsStore`
(`src/ops/store.pg.ts`, LECTURE SEULE) : `getTenantOverview` (rollup par tenant), `getGlobalDaily`,
`getQueueLoad` (SQL brut `${PGBOSS_SCHEMA}.job` group by state, `safeSchema` valide l'identifiant, tolère
42P01). Route unique `GET /ops/overview` (`src/http/ops.ts`). Front `web/app/ops/page.tsx` (hors AppShell,
token en localStorage `mba.ops`, fetch dédié qui ne touche pas la session console). 🔴 **Ce n’est PLUS une surface en lecture seule.** `src/http/ops.ts` porte quatre routes, dont deux POST :
`POST /ops/observe` (ouvrir un espace client en observation) et surtout `POST /ops/credits/:tenantId`, qui
recharge le solde prépayé d’un workspace. C’est la seule écriture d’argent du produit, et elle est ici
précisément pour qu’un client ne puisse pas créditer son propre compte.

## Support (Resend)

`src/support/resend.ts` (`ResendClient.send` -> POST `/emails`) + `src/http/support.ts` (POST
`/tenants/:id/support`, auth requise, 503 si non configuré, 502 sur erreur d'envoi, destinataire FIXE
serveur). Env : `RESEND_API_KEY`, `SUPPORT_FROM` (défaut `onboarding@resend.dev` = mode test), `SUPPORT_TO`.

## Décisions actées (lot MBA, D1-D10)

D1 édition template = autoriser + **bloquer si campagne active** (409). D2 clé user field **verrouillée**.
D3 tags **dérivés** des contacts. D4 mapping flow -> user field (défaut = slug du champ + ensureField, ou cible
choisie ; merge-si-contact-existe). D5 Analytics = `/dashboard` relabellé ; read receipts **campagnes-only**.
D6 coût = réutiliser `/stats/templates` (zéro backend). D7 largeur cap `max-w-7xl`. D8 support = form phase 1,
Resend phase 7. D9 Abonnement/Billing désactivés. ⚠️ Depuis 0087, il existe malgré tout un **solde prépayé par workspace**
pour l’agent IA (consommation en micro-euros, recharge par `POST /ops/credits/:tenantId`, affichage client) :
ce n’est pas un abonnement, mais ce n’est plus « le produit ne connaît pas d’argent ». D10 flow publié = **dupliquer pour modifier**.

## Variables d'environnement

Voir `.env.example` / `.env.prod.example`. Clés : `PORT`, `META_APP_SECRET` (signature webhook),
`META_VERIFY_TOKEN` (handshake), `META_ACCESS_TOKEN` (System User, envoi), `META_GRAPH_VERSION`,
`META_FLOW_JSON_VERSION`, `META_APP_ID` (=`988129420727963`, sert au FB.init + à l'échange de code ES),
`AUTH_SECRET` (fail-fast en prod, >= 32 octets), `DATABASE_URL`, `DRY_RUN`, `RESEND_API_KEY` / `SUPPORT_FROM` /
`SUPPORT_TO` (support), **`META_ES_CONFIG_ID`** (Embedded Signup ; vide → feature OFF, route 503), **`ENCRYPTION_KEY`**
(64 hex ; chiffre les tokens business ES ; fail-fast prod si `META_ES_CONFIG_ID` posé),
**`WEBHOOK_IN_RATE_LIMIT_MAX`** / **`WEBHOOK_IN_RATE_LIMIT_WINDOW_MS`** (débit d'UN webhook entrant, défaut
120 par minute) et **`WEBHOOK_PAYLOAD_RETENTION_DAYS`** (défaut 7, purge du dernier payload).
Côté agent IA : **`AI_GATEWAY_API_KEY`** (vide -> la file `agent-turn` n'est pas consommée, l'assistant de
construction et le bac à sable répondent 503), **`AGENT_SETUP_MODEL`**, **`AGENT_MODEL`**,
**`AGENT_VISION_MODEL`** et **`EUR_PER_USD`**.
🔴 **`AGENT_VISION_MODEL` est SÉPARÉ de `AGENT_SETUP_MODEL`, et ce n'est pas de la précaution : c'est mesuré.**
Sonde de la Gateway avec la clé de production le 2026-08-31 : `zai/glm-4.7`, le modèle d'entretien, REFUSE une
part `image_url` avec un **400 au corps vide**. Les réutiliser aurait livré une pièce jointe image morte, avec
une erreur que personne n'aurait su relier à sa cause. `google/gemini-2.5-flash` la lit (vérifié : il a décrit
le pixel de test), c'est la valeur posée en production. Vide → les images sont refusées explicitement, sans
aucun appel ; les documents texte, PDF et Word passent quand même, ils n'ont besoin d'aucun modèle.
⚠️ Poser la clé SANS les deux modèles est refusé au boot : le code retomberait sur `LLM_MODEL`, qui est
l'identifiant de l'ANALYSE de conversation servie EN DIRECT par Anthropic, là où le Gateway attend un
identifiant préfixé par son fournisseur. Rien ne le signalerait à la création d'un agent, et chaque tour
échouerait en pleine conversation. ⚠️ Cette dernière
est un **paramètre commercial** et non un cours : le Gateway facture en dollars, tous nos compteurs sont en
micro-euros, et la changer change ce qu'on facture au client. ⚠️ Un changement de `.env.prod`
exige `docker compose up -d --force-recreate` (env_file rechargé seulement à la recréation).

## Publicités Click-to-WhatsApp (CTWA) : identifier d'où vient un lead

Quand quelqu'un clique une publicité « Click to WhatsApp », Meta joint un objet **`referral`** au message
entrant, dans `messages[]` :

```json
"referral": {
  "source_url": "https://fb.me/XXXX",
  "source_id": "120212345678901234",
  "source_type": "ad",
  "headline": "Offre de rentrée",
  "body": "Parlez-nous sur WhatsApp",
  "media_type": "image",
  "image_url": "...",
  "ctwa_clid": ""
}
```

`source_id` est l'identifiant de la PUB : c'est la clé de routage.

**🔴 Trois pièges, tous vérifiés avant de coder :**

1. **Le referral n'arrive que sur le PREMIER message** après le clic. Les suivants ne le portent plus. Ne pas
   le capter à l'arrivée, c'est perdre l'origine du lead définitivement. D'où l'écriture immédiate sur la
   fiche contact, dans le même passage que l'auto-création (`src/worker.ts`).
2. **`ctwa_clid` peut arriver VIDE.** Vu dans un corps réellement capté. N'en jamais faire une condition.
3. **Une bascule d'attribution doit être active côté WhatsApp Business**, sinon Meta n'envoie pas le referral
   du tout. Information de source tierce, à vérifier dans les réglages du WABA le jour du premier test réel.

**Où ça atterrit.** Deux champs de contact aux clés stables (`src/crm/fields.ts`) : `pub_id` (« Pub
(identifiant) ») et `pub_titre` (« Pub (titre) »), créés à la volée au premier lead publicitaire. Des CHAMPS
plutôt qu'une colonne dédiée, et ce n'est pas un raccourci : l'origine devient filtrable dans le mini-CRM,
utilisable comme variable dans un message, et segmentable en campagne, sans migration ni écran de plus.

**Le déclencheur d'automation** `ctwa_ad` route ces leads vers un scénario. Sa config vide veut dire
« n'importe quelle pub », à l'INVERSE de « tag ajouté » et « étape de deal » où une config vide n'attrape
rien : ici le montage courant est « tout lead publicitaire part dans le scénario d'accueil », et la portée
reste bornée aux messages venus d'une pub. Un message ordinaire ne déclenche jamais.

**La fenêtre 24 h est ouverte** sur ce premier message (le contact vient d'écrire à Meta), donc le scénario
déclenché peut ouvrir par un message rapide, sans template à faire approuver.

**Ce qui n'est pas fait** : renvoyer les conversions à Meta via `ctwa_clid` (Automatic Events / Conversions
API) pour que l'algorithme optimise la diffusion. Le `ctwa_clid` n'est pas recopié sur la fiche, mais il n'est
pas perdu pour autant : le corps brut de chaque webhook est conservé intégralement dans `webhook_events.payload`
(aucune purge), donc ce chantier pourra repartir de là.

**⚠️ Rien de tout cela n'a encore été vu en vol.** Au 2026-08-26, sur 275 corps de webhook conservés depuis
juillet, AUCUN ne contient `referral` ni `ctwa_clid` : personne n'a encore pointé de pub sur ce numéro. Le
code suit la doc et un corps réel capté par un tiers, il n'est pas prouvé par notre propre trafic.

⚠️ **Note du 2026-09-22.** Le piège n°3 (la bascule d'attribution) n'est attesté que par un fournisseur d'API
non officielle ; la doc Cloud API ne le connaît pas. Et `ctwa_clid` n'est plus perdu : le lot 1 des pubs le
garde dans `arrivees_pub` (migration 0163).

## Patterns

- **Idempotence** : dédup par `meta_message_id` avant traitement (les webhooks arrivent en
  double).
- **ACK d'abord** : le receiver ne fait jamais de travail lourd en synchrone.
- **BSUID-native** : toute identité = E.164 OU BSUID ; ne jamais supposer un numéro présent
  (usernames : `from`/`wa_id` peuvent être omis, cf. cadrage §5bis).
- **Mocks des contrats Meta** : les wrappers API se testent contre des réponses mockées
  tirées de la spec (`META-BUSINESS-AGENT-API.md`), pas contre le live.

## Auth (lot 6)

- **Jetons** : `auth_tokens` (mig 0026), `purpose` invite|reset, `token_hash` sha256, consommation ATOMIQUE
  (`used_at is null` dans le UPDATE RETURNING), TTL (invite 7 j / reset 1 h). `PgAuthTokenStore.create/consume`.
- **Inscription libre** : `createTenantWithAdmin(name, {email, name, passwordHash})` TRANSACTIONNEL (jamais de
  tenant orphelin). `passwordHash` **null** = compte Google-only (login mot de passe impossible, Google OK).
- **Google** : `src/auth/google.ts verifyGoogleIdToken` via **jose** `createRemoteJWKSet` (JWKS
  `https://www.googleapis.com/oauth2/v3/certs`, issuer `accounts.google.com`, audience `GOOGLE_CLIENT_ID`,
  `email_verified` exigé, jamais de throw -> null). Injecté en dep dans `registerAuth` (testable avec un fake).
  Liaison par email : `PgUserStore.getByEmail` renvoie un compte TOUT statut (y compris pending) pour connecter un
  invité via Google. Front : bouton GIS (`web/components/GoogleButton.tsx`), `GET /auth/config` expose le client_id.
- **Anti-énumération** : forgot-password toujours 200 + `DUMMY_HASH` (timing constant) + envoi fire-and-forget.
  `hashPassword` **async** (scrypt threadpool) sur les routes publiques (sync bloquerait l'event-loop du webhook).
- **Crochet paiement** : `tenants.status` (`trial|active|locked`) ; `makeRequireAuth` bloque `locked` (403, inerte).

## Résolution des variables de template (lot 5-7)

- **Design** : `template_param_hints` (mig 0025) mappe `{{position}} -> champ` (sparse). `PgTemplateHintStore`.
- **Campagne template directe** : l'UI construit un `paramMapping` CONTIGU 1..N, `resolveTemplateParams` (exige
  1..N, throw sinon) résout par destinataire -> `resolvedParams` persistés -> `buildTemplateComponents` à l'envoi.
  ⚠️ **`meta/template-components.ts` est le SEUL constructeur de composants d'envoi** (2026-08-11). Il en existait
  un second dans `campaign/guardrails.ts` (`buildComponents`, supprimé) : ce doublon est la raison pour laquelle
  le carousel n'avait aucun « bon endroit » unique où se brancher, et n'est jamais parti côté campagne.
  L'envoi CAROUSEL vit ici : `MetaTemplateClient.list` relit les cartes (`carouselOf`, l'URL vient de
  `example.header_handle[0]` et n'est retenue que si c'en est une, un handle `4::` étant écarté),
  `carouselSendBlocker` refuse ce qui n'est pas envoyable (0 carte, carte sans image, variable de carte), et
  `getTemplateCarousel` (dep optionnelle d'`EngineDeps`) est appelée **une fois par run**, jamais par destinataire.
  ⚠️ Les URL de carte portent une expiration (`oe=`) : cache 5 min côté worker, mais le moteur de campagne prend
  un instantané pour tout le run (à surveiller sur une campagne longue à faible débit).
- **Campagne via WORKFLOW** (lot 7) : chemin distinct. La closure `sendTemplate` de `worker.ts` obtient N (corps
  live via `MetaTemplateClient.list`, caché 5 min par WABA|nom|langue), lit les hints, résout le contact
  (`getResolvableByPhone`, matching phone exact/chiffres nus/bsuid), et appelle `resolveHintParams(hints, N,
  contact, examples)` (SPARSE, garantit N valeurs, repli exemple) -> `buildWorkflowTemplateComponents` (fonction
  PURE, `src/workflow/template-send.ts`, testée directement : pas un fake d'executor). Corrige Meta #132000.
- **Éditeur du corps** : `web/components/VariableBodyEditor.tsx` (contentEditable, chips `[Label]` <-> `{{n}}`).
  Numérotation MAX+1 à l'insertion ; canonicalisation 1..N au submit (`page.tsx`).
- **Sources de variable (2026-07-16)** : `ParamSource` attribut = `name|phone|bsuid|wa_id` ; `valueOf` (switch
  exhaustif) résout via le contact ; `bsuid` ajouté à `ResolvableContact` + `getResolvableByPhone`. **Champs
  système** = constante code (`src/crm/fields.ts SYSTEM_FIELD_KEYS` + `web/lib/fields.ts SYSTEM_FIELDS`), SANS
  migration ; le sélecteur front (`selForSource`) coerce un champ perso inconnu → `sys:name` (garde anti-fantôme).
- **Bouton FLOW à l'envoi** : `buildWorkflowTemplateComponents` génère, par bouton FLOW du template, un composant
  `{type:'button', sub_type:'flow', index, parameters:[{type:'action', action:{flow_token}}]}` (`flow_token` non
  vide, `${waId}-${Date.now()}`). Corrige Meta #131009. Corrélation de la réponse par `_ref` baké (flow_json).

## Embedded Signup (Tech Provider, 2026-07-16)

Onboarding self-service du numéro WhatsApp d'un client. **OFF par défaut** (`META_ES_CONFIG_ID` vide → route 503,
bouton placeholder). Flux :
- **Front** (`web/app/accueil/page.tsx ConnectNumberZone`) : `GET /tenants/:id/embedded-signup/config` (appId+configId
  publics) → `FB.login({config_id, response_type:'code', override_default_response_type:true})` (SDK FB chargé à la
  demande). Le `code` arrive par le callback `FB.login` (TTL 30 s) ; `waba_id`/`phone_number_id` par `postMessage`
  `WA_EMBEDDED_SIGNUP` (origine ANCRÉE `^https://([a-z0-9-]+\.)*facebook\.com$`, ids string OU number).
- **Back** (`src/http/embedded-signup.ts` + `src/meta/embedded-signup.ts` + `src/account/es-store.pg.ts`) :
  `POST /complete {code, wabaId, phoneNumberId}` → échange code→business token (`GET /oauth/access_token`) →
  **`verifyWaba` + `getPhone` BLOQUANTS** avec le business token (garde anti-hijack cross-tenant : ne pas croire les
  ids du client) → `link` (rattache waba+numéro au tenant, réaffecte si besoin) → `subscribeApp` (webhooks, best-effort
  warning) → `register` si `status != CONNECTED` (pin CSPRNG) → `saveCredentials` (token+pin **chiffrés AES-256-GCM**
  via `src/crypto/secretbox.ts`, mig **0029** `waba_credentials`). Config Meta = template « WhatsApp Embedded Signup
  60-day » (cf `brain/LEARNINGS.md` 2026-07-16 pour la chaîne de prérequis Meta).

### 🔴 Le second passage : la popup ne dit RIEN (mesuré et corrigé le 2026-08-17)

Meta n'émet `WA_EMBEDDED_SIGNUP` que lorsque la popup exécute VRAIMENT les étapes de configuration. Un client
qui rouvre le parcours après un premier passage abouti obtient un code... et rien d'autre. Mesuré toutes traces
ouvertes : le seul message reçu de `facebook.com` était le canal interne du SDK portant le code. La doc de Meta
est muette sur ce cas. Tant qu'on exigeait les identifiants, ce client était bloqué DÉFINITIVEMENT.

`wabaId`/`phoneNumberId` sont donc désormais **facultatifs**. Absents, le serveur les retrouve : `wabasForToken`
(`GET /debug_token` -> `granular_scopes[].target_ids`) puis `listPhones`. ⚠️ `debug_token` prend DEUX tokens de
rôles DIFFÉRENTS : `input_token` est le token inspecté (celui du client), et l'autorisation doit être un token
d'APPLICATION (`{appId}|{appSecret}`). S'authentifier avec celui du client rend « #100 You must provide an app
access token ». Un token non scopé (notre System User) rend `target_ids: null`, ce n'est pas une erreur.

Sûreté inchangée : les identifiants viennent du token du CLIENT, ils ne peuvent donc pas désigner les biens d'un
autre, et `verifyWaba`/`getPhone` restent joués sur l'identifiant retrouvé (test dédié). L'ambiguïté (plusieurs
comptes ou plusieurs numéros) est REFUSÉE en 409, jamais tranchée au hasard.

### 🔴 Statuts HTTP : aucun message utilisateur dans un 5xx (Cloudflare le détruit)

Mesuré le 2026-08-17 : par l'URL publique, un `502 {"error":"..."}` revient en `text/html` de 6 429 octets,
page « 502: Bad gateway » de Cloudflare, notre corps disparu. L'utilisateur lisait « Erreur 502 » sans jamais
connaître le motif de Meta. Les refus lisibles sortent donc en **422** (409 pour une ambiguïté), et chaque refus
est **journalisé côté serveur** : le corps peut être détruit en route, le log reste. Un test verrouille la règle.
Astuce de diagnostic : comparer l'appel INTERNE et l'appel PUBLIC isole la couche coupable en une mesure.

## i18n FR/EN (2026-07-16)

`web/lib/i18n.tsx` : `LocaleProvider` (langue dans un contexte, persistée localStorage, défaut FR, appliquée après
montage → pas de mismatch d'hydratation ; l'effet de montage resynchronise AUSSI `document.documentElement.lang`) +
`useT()` → `t('texte FR', 'EN text')` **co-localisé** au point d'appel (pas de dictionnaire central). Provider dans
`app/layout.tsx`, toggle dans `AccountMenu` + `LocaleToggle` (pill FR/EN) sur les 5 pages pré-login. Règle : NE JAMAIS
wrapper une valeur backend/clé/comparaison dans `t()` ; chaînes au niveau module → déplacer dans le composant ou passer `t`.

**Lot 6 (2026-07-16), dates/nombres/libellés localisés** : le type `Locale` vit dans `web/lib/locale.ts` (**.ts pur** :
le tsc racine n'a pas `--jsx`, importer un type depuis `i18n.tsx` casse le build → TS6142 ; i18n.tsx le ré-exporte).
`day.ts` (`dayLabel`/`hourMin`/`formatDate`) et `format.ts` (`fmtNum`/`fmtPct`/`sendingLimitLabel`/`tierLabel`) prennent
un `locale` **REQUIS** (pas de défaut : tsc LISTE tous les appelants, aucun oubli possible). Les tags BCP47 (`fr-FR`/
`en-GB`) sont CONFINÉS à ces 2 libs : grep `fr-FR` = 0 ailleurs dans `web/`. `dayKey` (en-CA = clé ISO de tri) et
`fmtCost` restent indépendants de la langue.

⚠️ **`Intl.NumberFormat` en français insère une espace INSÉCABLE ÉTROITE (U+202F) devant l'unité**, pas une
espace ordinaire. Un test qui compare « 1,01 € » à ce qui sort de `fmtCost` échoue en affichant un attendu et
un reçu VISUELLEMENT IDENTIQUES, ce qui coûte un moment (vécu le 2026-09-09 sur la liste des modèles). La
parade tient en une ligne : normaliser `[  ]` en espace avant d'asserter.

**Rattrapage du 2026-08-21 : le trou était sous les composants.** Le chantier de 2026-07-16 avait traduit les
`.tsx`, où une chaîne non enveloppée dans `t()` se repère à l'oeil. Les lots d'août ont ensuite extrait la
logique de présentation vers des modules `.ts` PURS, testables par vitest, où `useT()` est **inappelable**
(c'est un hook). 79 chaînes s'y sont accumulées et sortaient en français sur une console en anglais, sans que
build, tsc ni tests ne bronchent : `i18n.tsx` retombe **silencieusement** sur le français quand l'argument
anglais manque. Corrigés : `mesures-scenario.ts` (tout l'écran Mes tableaux), `meta-errors.ts` (22 messages
d'erreur Meta), `fields.ts` (libellés des champs système, désormais en paires `[fr, en]`, ce qui a permis de
supprimer la copie qu'en portait `ConditionBuilder`), `timezones.ts` (exonymes), `http.ts` (messages jetés,
qui lit la langue directement dans `localStorage` faute de contexte React), plus les guillemets `« »` restés
dans des phrases anglaises.

🔴 **Deux pièges vérifiés à cette occasion.** (1) `ScenarioCanvas` comparait `d.titre !== t(...meta.label)`,
soit une chaîne jamais traduite contre une chaîne traduite : en anglais l'égalité n'arrivait jamais et le
sous-titre redondant réapparaissait sur tous les blocs. Remplacé par un booléen calculé à la source
(`titrePropre`). C'était la seule occurrence du grep de sûreté `=== t(`. (2) Le libellé d'une mesure est
**persisté** dans un tableau enregistré : `groupesDuTableau` le RE-DÉRIVE à l'affichage au lieu de relire
celui du JSON, sinon un tableau enregistré en français ressort en français dans une console en anglais.

⚠️ **Règle** : un module `.ts` qui produit du texte destiné à l'écran prend un paramètre `locale` **REQUIS**
(tsc liste alors les appelants), ou porte ses libellés en paires `[fr, en]` résolues au rendu par `t(...paire)`.
Attention, TypeScript ne protège PAS le rendu : `{f.label}` où `label` est une paire compile sans broncher et
React affiche « NomName ».

## Identifiants publics « schéma A » (Lot 4a, 2026-07-16, migration 0031)

Socle d'une future API : chaque entité porte un **code public** `<type>_<code-client>_<ULID>` (ex.
`scn_by5p57_01KXNVZD0NP4WY7WAEHA4765G5`). **ADDITIF strict** : colonnes `tenants.public_code` + `code`
(workflows/users/user_fields/tags) nullables + index uniques PARTIELS ; AUCUNE PK/FK/slug/clé (tenant,name)
touchée, les uuid internes restent la source de vérité des relations.

- `src/ids/code.ts` (PUR, testé) : `newUlid()` 26 car. Crockford (48 bits temps triable + 80 bits aléa),
  `makeCode(type, tenantCode)`, `deriveTenantCode(seed)` (6 car. base32 minuscules, déterministe depuis
  l'uuid tenant → immuable, collision barrée par l'index unique).
- `src/ids/tenant-code.ts` : `resolveTenantCode(pool, tenantId)` lit `public_code`, le dérive + persiste
  si absent (**self-heal idempotent**, pose concurrente absorbée).
- Génération à l'INSERT dans les 4 stores (`scn`/`usr`/`fld`/`tag`) ; `createTenantWithAdmin` pose la racine
  dans SA transaction. `on conflict do nothing` (champ/tag) = la ligne existante GARDE son code.
- Backfill one-shot des lignes antérieures : `db/backfill-codes.ts` (idempotent, `where code is null`),
  lancé APRÈS migrate. Types front : `code?: string | null` sur WorkflowSummary/AdminUser/UserFieldDef/TagCount,
  affiché discrètement (scénarios/champs/tags). Tags : le code vit sur la table des tags DÉCLARÉS (null pour un
  tag utilisé mais jamais déclaré).
- **Lot 4b (FAIT 2026-07-16)** : codes des NODES mintés **côté serveur** au save du graphe (`src/workflow/node-codes.ts`,
  POST/PATCH après parseGraph ; regex anti-forge `^nod_<tenantCode>_[ULID]$` : un code valide du même tenant est
  PRÉSERVÉ par référence, tout le reste est re-minté ; la réponse renvoie le graphe enrichi). Champs SYSTÈME : code
  **déterministe sans stockage** `fld_<client>_sys_<key>` (`systemFieldCode`), calculé côté front via le `tenantCode`
  exposé par GET /fields. Restent : endpoints API publics (chantier dédié).

## Workflow : auto-save + node « message rapide » (Lot C, 2026-07-16, migration 0030)

- **Auto-save** (`WorkflowBuilder.tsx`) : debounce ~1,2 s sur `[nodes, edges]` (skip du rendu initial), flush au
  démontage + `beforeunload` en **keepalive** (`updateWorkflow(..., {keepalive:true})`), planification via
  `doSaveRef` (changement de langue ≠ save), **saves sérialisés** (un PATCH à la fois, re-save si édité pendant).
  Indicateur passif « Enregistré à HH:MM » / retry sur échec. Colonne `workflows.status` **droppée** (mig 0030,
  elle était 100 % cosmétique) : ⚠️ 1re migration DROP du repo : deploy AVANT migrate (cf DEPLOY.md).
- **Node `quick_message`** : bloquant (attend la réponse) comme template ; `actionOf` → `{kind:'sendQuickMessage',
  body, buttons}` (null si corps vide ou aucune réponse non vide → no-op, comme un template sans nom) ;
  `executor.apply` → dep `sendQuickMessage` → `MetaClient.sendInteractive` (interactive/button, filtre les titres
  vides en PRÉSERVANT l'index `btn:<slot>` → la branche par bouton reste stable, cap Meta 3 boutons/20 car.) ;
  worker : câblage type sendTemplate (texte littéral V1, log inbox best-effort). Fenêtre 24 h garantie par l'archi
  (jamais node d'entrée).
- **Node `flow` (Lot 7, fini le no-op)** : `actionOf` -> `{kind:'sendFlow', flowId, flowName, body, cta}`
  (flowId vide -> null+waiting, contrat template vide ; accroche défaut « Formulaire : <nom> », cta défaut =
  cta du flow) -> dep executor `sendFlow` -> worker -> `MetaClient.sendFlowMessage` (interactive/flow,
  `flow_message_version:'3'`, `flow_token` jetable jamais vide `${waId}-${Date.now()}` (corrélation par `_ref`,
  pas le token), `flow_action_payload.screen = FORM`, `mode:'draft'` dispo pour tester un brouillon).
  **Garde fenêtre 24 h** (mise à jour 2026-08-15) : `scanOpening` (engine, PUR) fait UNE traversée en largeur
  depuis l'entrée et rend 5 faits sur l'OUVERTURE : message de session avant tout template, 1er template
  atteignable, ambiguïté (deux templates différents selon la branche), attente avant le 1er template, template
  d'ouverture sans nom. `opensOutsideServiceWindow` n'en est plus qu'un appelant.
  L'enregistrement du graphe reste VOLONTAIREMENT permissif (le builder sauve en continu) ; les gardes sont
  `POST /campaigns` (400 en nommant la cause) et le runtime (`executor.runFrom`). Côté front, le miroir vit
  dans `web/lib/campaign-eligibility.ts` (frontière de build : aucun module partagé) et
  `tests/web-campaign-eligibility.test.ts` compare les DEUX implémentations sur les mêmes graphes.

  **Bloc « Attente » (2026-08-15, migration 0054)** : un parcours peut dormir jusqu'à une échéance.
  - moteur PUR : `waitDurationMs` (minutes/heures/jours, plafond 30 j, durée absente = passe-plat) ; `walk`
    rend `{ status: 'sleeping', nodeId, resumeInMs }`.
  - **TROIS modes depuis le 2026-09-08** (`waitMode` : `delai` par défaut, `date`, `heures_ouvrees`), et
    TROIS fonctions qui ne répondent pas à la même question, ce qui est le point à ne pas confondre :
    `waitDurationMs` = le délai configuré (0 hors mode `delai`) ; `waitResumeInMs(node, ctx)` = ce que
    l'EXÉCUTION lit, calculé depuis `ctx.now` ; `waitEstimationMs` = ce que l'ANALYSE DE GRAPHE prête au bloc
    à la publication, soit la fenêtre ENTIÈRE pour les deux modes datés, dont la durée n'est pas connue
    d'avance. 🔴 Rendre 0 dans ce dernier cas laisserait publier « attendre jusqu'à demain 9 h puis message
    rapide », un montage dont le message ne partirait jamais. Le miroir front porte la même règle, et le
    test de parité l'a immédiatement gagnée : un mode INCONNU doit retomber sur `delai` des deux côtés.
  - 🔴 les modes datés EXIGENT le contexte d'évaluation, et c'est `buildCtx` (executor) qui décide de le
    construire. L'oublier ne casse rien de visible : le bloc redevient un passe-plat et « attendre les heures
    ouvrées » envoie à 1 h du matin. Tenu par `tests/workflow-executor.test.ts`, vérifié par mutation.
  - ⚠️ la date est saisie DANS le bloc (elle vaut pour tous les contacts), lue comme une heure MURALE du
    fuseau de l'espace. Un champ du contact aurait recouvert l'automation « un délai avant ou après une date
    enregistrée ». Une échéance déjà passée ne retient personne.
  - ⚠️ le réveil part au bloc SUIVANT : un bloc Attente ne se réévalue pas. Si le balayage prend du retard
    (worker arrêté plusieurs heures), un « jusqu'aux heures ouvrées » repart à l'heure du réveil, pas à
    l'ouverture. C'est la limite commune à toutes les échéances de ce dépôt, pas une propriété de ce mode.
  - base : `workflow_runs.resume_at` + statut `sleeping` (CHECK élargi) + index partiel `(resume_at)`.
  - réveil : `wake-sweep.ts` (miroir de `campaign/schedule-sweep`) toutes les
    `WORKFLOW_WAKE_SWEEP_INTERVAL_MS` (60 s = la précision réelle d'un délai).
  - ⚠️ **le claim est un BAIL** : `resume_at = now() + 5 min`, statut INCHANGÉ à `sleeping`. Passer à `waiting`
    exposerait le run à `advance` (un message du contact pendant la reprise rejouerait le même bloc = double
    envoi) et un worker tué laisserait un run figé, ressuscitable par n'importe quel message. Avec le bail, un
    worker tué rend simplement le parcours dû 5 minutes plus tard.
  - 🔴 un run endormi est CLOS par le démarrage suivant, pas préservé (`closeActiveByWaId` couvre `waiting`
    ET `sleeping`, et efface `resume_at`). Sans les deux, une automation lancerait un 2e parcours en parallèle
    et les deux écriraient au réveil. ⚠️ Jusqu'au 2026-09-07, un run endormi BLOQUAIT le déclenchement
    (`hasRecentWaitingRun`) : la garde a été retirée, elle bloquait au lieu de trancher, et un lien de chaîne
    cliqué pendant une attente n'ouvrait jamais son scénario, sept jours durant.
  - 🔴 `resume` écrit son état par `setStateSiVivant`, pas par `setState` : entre le claim et l'écriture, un
    autre chemin peut avoir clos le parcours, et une écriture inconditionnelle le RESSUSCITERAIT avec son
    échéance. Course quasi inatteignable avant que la fermeture ne devienne un appel par destinataire de
    campagne.
  - `executor.resume` : gardes `mayAct`, bloc suivant existant, puis fenêtre 24 h RELUE en base
    (`getWindowOpenByWaIds`) si la suite envoie un message de session -> sinon on n'envoie pas et on remonte en
    inbox. Un template, lui, part hors fenêtre.
  - chaîne d'attentes cyclique : bornée par l'âge du run (90 j) dans le claim + `closeStaleSleeping`.
  - `waitBeforeSessionMessage` (pur, + miroir front) détecte « attente >= 24 h puis message de session » pour
    l'afficher dans le builder ; cumul plafonné à 24 h, ce qui garantit la terminaison sur graphe cyclique.

## Canal RCS (smsmode) : envoi, rappels, composeur (2026-08-24, migrations 0056-0058, 0077-0079)

Deuxième canal du produit, à côté de WhatsApp. Ce qui signe les messages n'est pas un numéro mais un **agent
de marque** déposé chez un fournisseur et approuvé par Google et les opérateurs. Fournisseur en production :
**smsmode** (API REST RCS v1.8).

### Ce qui isole les workspaces

Le mapping `rcs_agents` (tenant -> agent) est le SEUL contrôle : toute résolution d'agent, toute clé, tout
rappel passe par lui, scopé tenant. Depuis 0078 chaque workspace a **sa** clé d'API, chiffrée en base
(`api_key_enc`, `src/crypto/secretbox.ts`) ; la variable d'environnement `SMSMODE_RCS_API_KEY` n'est plus
qu'un repli. Le canal est **allumé par déduction** : `hasAgent(tenant)`, pas de drapeau à basculer à la main.

### Ce que smsmode fait, et ne fait pas (mesuré, pas supposé)

- Une clé d'API est rattachée à **UN canal**. Une clé de canal SMS s'authentifie et répond `403 Channel type
  mismatch` sur l'API RCS. D'où la vérification à l'activation (`src/rcs/channel-info.ts`), en **422**.
- **Aucun endpoint de joignabilité.** Leur `lookup` est l'opérateur du destinataire renvoyé AVEC le rapport de
  livraison, donc après coup. `SmsmodeRcsProvider.canCheckReachability = false` : le sender saute la
  vérification préalable au lieu de payer un aller-retour pour une constante.
- **Reporting différé** : juste après un 201, la fiche du message répond 404. Rien ne se conclut d'un statut
  lu immédiatement.
- Le statut `READ` **existe** et n'est pas dans leur énumération documentée. Tout mapping tolère l'inconnu.
- Destinataire en **chiffres nus**, sans `+`. `refClient` borné à 140 caractères.
- **Aucune signature** sur les rappels : voir ci-dessous.

### Rappels entrants (`POST /rcs/callback/:code`)

URL publique `https://mba.messagingme.app/api/backend/rcs/callback/<code>`, posée sur CHAQUE envoi
(`callbackUrlFor`), et non configurée à la main chez le fournisseur. Une seule adresse pour les deux flux : le
corps porte `direction` (MT = rapport de livraison, MO = message entrant).

🔴 **Ce qui autorise l'appel**, faute de signature : (1) le `webhook_code` de l'URL, 128 bits, propre au
workspace, qui porte le tenant, jamais le corps ; (2) le `channel.channelId` du corps, qui doit être l'agent
de ce workspace. La migration 0079 fait tourner les codes courts émis avant.

Effets d'un rapport de livraison (`src/index.ts`, deps `rcsCallback`) :

| Rapport | Effet |
| --- | --- |
| tout statut connu | statut de livraison du destinataire de campagne (même échelle que Meta) |
| `DELIVERED` | reprend la sortie **« envoyé »** du bloc, **seulement** si le bloc n'offre aucun bouton réponse |
| `UNDELIVERABLE` / `UNDELIVERED` | reprend la sortie **« non joignable »** : c'est la cascade RCS vers WhatsApp |
| statut inconnu | **ignoré**, jamais traité comme un échec |

Le garde-fou du `DELIVERED` est le point délicat : l'accusé arrive en quelques secondes, le contact répond bien
plus tard. Avancer alors qu'un bouton est proposé enverrait son clic dans le vide.

Effets d'un message entrant : opt-out si le texte commence par STOP (avant tout le reste), enregistrement dans
le fil d'inbox avec `channel='rcs'`, puis avance du scénario.

smsmode **rejoue** six fois (30 s, 2 min, 10 min, 1 h, 5 h, 24 h) tant qu'il n'a pas reçu un 2xx. D'où : 200
sur un corps illisible (le rejouer ne le rendra pas lisible), 404 sur un code inconnu, et une panne interne
qu'on LAISSE remonter en 5xx pour qu'ils rejouent.

### Charge utile des boutons

`normaliserPostbacks` (`src/rcs/schema.ts`) réécrit le `postbackData` de chaque bouton RÉPONSE en `btn:<i>`,
i étant son rang **parmi les réponses**, c'est-à-dire le nom que le builder donne à la sortie correspondante.
Appliqué au point de passage unique (`RcsSender.sendTo`), donc à l'envoi et non à l'enregistrement : les
messages déjà en bibliothèque se réparent seuls. Sans cette réécriture, un clic ne retrouve aucune arête et le
parcours s'arrête en silence.

### Les six formes de bouton

Les six du provider sont exposées, aucune de plus. Trois ramènent le contact dans la conversation ou l'en
sortent, trois agissent sur son téléphone :

| Forme | Ce qu'elle fait | Sortie de scénario |
| --- | --- | --- |
| `reply` | réponse en un tap | **oui**, `btn:<i>` |
| `openUrl` | ouvre une page web | non |
| `dial` | compose un numéro | non |
| `calendar` | ajoute un rendez-vous à l'agenda | non |
| `showLocation` | ouvre un lieu sur la carte | non |
| `requestLocation` | demande sa position au contact | non |

🔴 **Pourquoi une seule ouvre une branche.** Seul un `reply` renvoie une charge utile (`postbackData`) que
l'exécuteur puisse relier à une arête. Une position partagée revient dans un corps `LOCATION` **sans texte et
sans `postbackData`** (vérifié sur leur spec) : impossible d'en déduire quel bouton l'a déclenchée. Le builder
n'affiche donc de sortie reliable que pour les boutons réponse, règle tenue par `ouvreUneSortie` et partagée
entre le rendu du bloc et son panneau de configuration.

**Le bouton Agenda et la date de CHAQUE contact.** `startAt`/`endAt` acceptent une date-heure locale
(`2026-09-01T10:00`) ou une variable `{{champ}}`. Un message de bibliothèque étant réutilisable, une date en
dur y serait vraie une fois et fausse ensuite ; l'écran ne propose que les champs de type **date et heure**
(un champ `date` seul ne porte pas d'heure et produirait une valeur refusée). Une date qui ne se résout pas
fait tomber **le bouton** (`elaguerBoutonsInvalides`, appliqué au point de passage unique de l'envoi et
journalisé), jamais le message : sans cette garde, un contact sans rendez-vous ne recevrait plus rien du tout.

**Ce que le contact renvoie.** Une position (`latitude`/`longitude`) et un fichier (`fileUrl`, `filename`)
sont conservés et rendus lisibles dans le fil d'inbox par `apercuMo`. Sans cela, la réponse ne serait qu'une
bulle vide et l'information demandée serait perdue.

### 🔴 Le canal est porté par le PARCOURS, pas par le bloc (migration 0082)

Le multicanal, tel que Julien l'a formulé le 2026-08-24 : « le RCS part en premier, l'utilisateur clique, la
suite doit partir en RCS ; s'il clique l'autre bouton, on bascule sur WhatsApp ».

Un « message rapide » est un texte avec des réponses en un tap : WhatsApp sait le faire, le RCS aussi. Le bloc
dit donc l'INTENTION, pas le tuyau. `workflow_runs.channel` porte le canal courant, et les envois le font
évoluer :

| Ce qui part | Effet sur le canal du parcours |
| --- | --- |
| bloc RCS **réellement envoyé** | passe à `rcs` |
| **template** WhatsApp | revient à `whatsapp` (c'est ainsi qu'on bascule volontairement) |
| **message rapide** | suit le canal courant, ne le change pas |
| bloc RCS **sauté** (opt-out, agent absent) | inchangé : le repli « non joignable » est WhatsApp |

Un message rapide envoyé en RCS devient un TEXTE + boutons `reply`, dans le même ordre : le clic revient donc
sur la même sortie `btn:<i>` que côté WhatsApp, et le reste du moteur ne voit aucune différence.

⚠️ Le canal suit ce que le contact a REÇU, jamais une intention : un bloc RCS sauté ne bascule rien, sinon la
branche de repli partirait elle aussi en RCS, chez un contact qu'on vient justement de constater injoignable.

⚠️ Seul le **formulaire** (WhatsApp Flow) reste impossible derrière un RCS : il n'a aucun équivalent RCS, part
donc forcément par WhatsApp, et se fait refuser hors fenêtre. Le builder le signale (`sessionMessageAfterRcs`).

### 🔴 Ce qui peut OUVRIR un scénario, et ce qui peut le SUIVRE

Deux règles distinctes, longtemps confondues parce que WhatsApp était le seul canal.

**Ouvrir.** Une campagne, comme un lancement depuis l'Inbox hors fenêtre, part sur un contact qui n'a rien
écrit récemment. Peuvent donc ouvrir : un **template** WhatsApp configuré, ou un **bloc RCS** configuré
(`scanOpening.rcsOpen`). Le RCS n'a aucune fenêtre : la contrainte des 24 h appartient à WhatsApp.

⚠️ Vécu le 2026-08-24 : un scénario commençant par un bloc RCS n'apparaissait PAS dans le sélecteur de
l'Inbox quand la fenêtre était fermée, c'est-à-dire précisément quand il servait. La règle « seul un template
peut ouvrir à froid » datait d'avant le canal RCS. Les DEUX miroirs (`src/workflow/engine.ts` et
`web/lib/campaign-eligibility.ts`) portent maintenant `rcsOpen`, et le test de parité compare les deux sur des
graphes RCS.

**Suivre.** Après un bloc RCS, mesuré :

| Bloc branché derrière | Résultat |
| --- | --- |
| **template** WhatsApp | part (aucune fenêtre requise) |
| **autre bloc RCS** | part |
| **message rapide** | part **en RCS** : le canal est porté par le parcours (voir la section ci-dessus) |
| **formulaire** (WhatsApp Flow) | **refusé par Meta** si le contact n'a pas écrit SUR WHATSAPP depuis 24 h |

Répondre à un message RCS ne rouvre pas la fenêtre WhatsApp : ce sont deux tuyaux distincts. C'est pourquoi
un message rapide suit désormais le canal du parcours au lieu de partir en WhatsApp par principe. Le
formulaire, lui, n'a pas d'équivalent RCS : le parcours ne fait pas semblant, il clôt le run et remonte la
conversation à un humain, avec la raison en journal, et le builder signale le montage sans l'interdire.

### L'écran d'envoi de template de l'Inbox

Deux corvées supprimées le 2026-08-24, toutes deux du même genre : redemander ce que le produit sait déjà.

- **Les variables sont PRÉ-REMPLIES** sur la fiche du contact ouvert, via les indices posés à la création du
  template (`template_param_hints`), et le libellé du champ s'affiche à côté. L'écran demandait `{{1}}`,
  `{{2}}` en texte libre, sans dire ce qu'ils attendaient. Route :
  `GET /tenants/:id/conversations/:cid/template-params?name=&language=&count=`, MÊME résolution que l'envoi
  réel, donc l'écran montre exactement ce qui partira. Les valeurs restent modifiables.
- **L'en-tête média du template est repris automatiquement** (`headerMediaUrl`, lu chez Meta dans
  `example.header_handle`). Meta exige le fichier à CHAQUE envoi, mais l'opérateur n'a aucun moyen de
  retrouver l'URL de ce qu'il a choisi en créant le template. Le champ de saisie ne réapparaît que si le
  template n'en porte aucune (lien expiré chez Meta), et il le DIT alors.

### Un envoi RCS apparaît dans le fil, quel que soit son déclencheur

Les trois chemins écrivent la bulle dans la conversation, avec `channel = 'rcs'` (l'Inbox la dessine alors
aux couleurs du canal) :

| Déclencheur | Qui journalise |
| --- | --- |
| campagne RCS | `campaign/engine.ts` (`recordOutboundByWaId`) |
| Inbox (bouton 📱) | la route `send-rcs` |
| **bloc de scénario** | `rcs.recordOutbound`, câblé dans `wiring.ts` |

⚠️ Le troisième manquait jusqu'au 2026-08-24 : un message RCS parti par un scénario n'apparaissait NULLE PART
dans l'Inbox. L'opérateur voyait la réponse du contact sans jamais voir la question, ce qui rend une
conversation illisible pour qui la reprend. Best-effort strict : le message est déjà parti chez l'opérateur
télécom quand on journalise, un incident de journal ne doit pas le faire passer pour un échec. Un envoi SAUTÉ
(opt-out, agent absent) n'écrit rien : il n'a rien montré au contact.

### Envoyer un RCS depuis l'Inbox

`POST /tenants/:id/conversations/:cid/send-rcs`, avec l'identifiant d'un message de la bibliothèque.

🔴 **Volontairement SANS garde de fenêtre 24 h**, à la différence de `reply`. Cette fenêtre est une règle de
WhatsApp, pas une règle du monde : le RCS n'en a pas, et c'est précisément quand la fenêtre WhatsApp est
fermée qu'il devient le moyen de reprendre contact sans template à faire approuver. L'écran propose donc le
bouton dans les DEUX états de la barre de réponse.

Le message vient de la bibliothèque (comme un template vient de Meta) : un opérateur d'inbox n'a pas à
composer une carte, un visuel et des boutons dans une barre de réponse. Ses variables sont résolues sur la
fiche du contact par le MÊME chemin d'envoi que les campagnes (`rcsStack.sender`), donc avec les mêmes
garde-fous (opt-out, élagage des boutons, normalisation des charges utiles) sans en réécrire un seul.

Chaque refus porte sa RAISON, en **422** : « le canal n'est pas activé » et « ce contact s'est désabonné »
demandent deux gestes différents, et un 5xx verrait son corps remplacé par la page d'erreur de Cloudflare.
Comme la réponse texte, l'envoi fait PRENDRE le fil à l'opérateur, et la bulle est enregistrée avec
`channel = 'rcs'`.

### Le champ variable, comme un template Meta

`ChampCorpsVariables` (ex-`RcsBodyField`, renommé le 2026-08-25) : on écrit, on clique « + Variable », on
choisit un champ du contact, et un chip `[Prénom]` s'insère au curseur. La chaîne stockée reste
`Bonjour {{prenom}}` ; c'est l'AFFICHAGE qui change. Quatre appelants : messages RCS, bloc RCS du builder,
campagne RCS, et le corps en format Texte d'un modèle d'email.

⚠️ Le bouton et sa liste de champs vivent à part, dans `SelecteurVariable` : trois surfaces doivent l'ouvrir
(le sujet d'un modèle d'email, son corps en Texte, son corps en HTML) et seule la première passe par l'éditeur
à chips. Un `contenteditable` resérialise le DOM, donc il abîmerait un HTML collé depuis un outil externe.

⚠️ La liste proposée vient de `emailVariableFields` et NON de `emailResolvableFields` : la première ajoute les
variables de base réellement fournies par `contactVars` (`profile_name` pour le nom, `phone`), que
`GET /user-fields` ne renvoie jamais puisqu'il ne sert que les champs perso. La seconde sert à choisir un champ
qui CONTIENT une adresse (destinataire du bloc email), où proposer « Téléphone » serait un piège.

L'éditeur à chips (`VariableBodyEditor`) est désormais partagé avec le corps d'un template Meta. Il prend un
`varPattern` (positions `{{1}}` par défaut, motif NOMMÉ pour le RCS) et un `labelOf(nom)`. Les deux contrats
restent distincts, et c'est voulu : les variables Meta sont POSITIONNELLES (exemple obligatoire,
renumérotation à l'envoi, parce que Meta valide un gabarit), celles du RCS sont NOMMÉES et résolues sur la
fiche. Un seul éditeur en dessous, deux vocabulaires au-dessus.

### Héberger le visuel (migration 0081)

Un message RCS ne transporte pas l'image, il transporte son **adresse**, que l'opérateur télécom va chercher
lui-même. Sans hébergement, un client doit poser son visuel ailleurs et coller un lien, ce qui suffit à rendre
la fonctionnalité inutilisable pour celui à qui elle sert. La console héberge donc les visuels.

- **Téléversement** : `POST /tenants/:id/rcs/media` (admin), data URL base64, et rend directement l'URL
  publique. `GET` liste la médiathèque, `DELETE` retire un visuel (suppression DURE : ce qui compte est qu'il
  cesse d'être servi, ce qu'une suppression douce ne ferait pas).
- **Lecture** : `GET /m/<code>.<ext>`, **publique et non authentifiée**, exposée par un rewrite dédié du front
  (`/m/:fichier`), comme `/r/:code` pour les liens tracés. C'est l'opérateur qui télécharge, il n'a aucune
  session ; le `code` (130 bits) tient donc l'accès à lui seul.
- **Stockage** : les octets en base (`rcs_media.bytes`). Un volume Docker ne survit pas à une recréation de
  conteneur sans déclaration explicite et n'est sauvegardé nulle part ; un bucket ajoute un service, des clés
  et un mode de panne. Le volume est minuscule (2 Mo maximum par visuel, quelques visuels par client) et suit
  la base dans toute restauration. Déplacer le stockage un jour ne changerait que `media-store.pg.ts` :
  l'URL publique, elle, ne bougerait pas.

🔴 **Ce qui est servi est décidé par la SIGNATURE du fichier**, jamais par le type déclaré au téléversement
(`src/rcs/image.ts`). Servir un fichier pour ce qu'il prétend être est la façon classique de transformer un
hébergeur d'images en hébergeur de pages ; un PDF renommé en `.png` est refusé en **415**. Trois formats
seulement (JPEG, PNG, GIF, ceux que l'opérateur accepte), pas de SVG (XML exécutable). La réponse porte
`nosniff` et le type réel.

⚠️ **Cache d'UN JOUR, pas d'un an.** Le contenu d'un code ne changeant jamais, `immutable` sur un an semblait
évident. Mesuré sur la production le 2026-08-24 : Cloudflare met ces images en cache au bord
(`cf-cache-status: HIT`) et continuait de servir un visuel **supprimé** alors que l'origine répondait déjà
404. Une suppression qui ne supprime pas est une promesse intenable. Un jour couvre entièrement la rafale de
lectures d'une campagne (elle part en quelques minutes, et chaque destinataire déclenche un téléchargement) et
borne l'exposition après suppression. Pour rendre une suppression immédiate, il faudrait purger le cache
Cloudflare par API, ce qui suppose un jeton que ce projet n'a pas.

⚠️ L'extension de l'URL n'est pas décorative : le fournisseur exige une adresse qui finit par `.jpg`, `.jpeg`,
`.png` ou `.gif`. Elle doit CORRESPONDRE au fichier stocké, sinon on servirait un PNG sous une adresse en
`.jpg` (404 dans ce cas).

### 🔴 Où les boutons sont accrochés décide de leur apparence

Ce n'est pas nous qui dessinons les boutons : c'est l'application Messages du destinataire. Le seul levier est
l'endroit où on les accroche, et il change tout (documentation RBM de Google, lue le 2026-08-24) :

| Accrochés à | Apparence | Nombre | Durée |
| --- | --- | --- | --- |
| la **carte** (`card.suggestions`) | boutons **pleine largeur empilés**, dans la carte | 4 | ils restent |
| le **message** (`suggestions`) | petites **pastilles en ligne**, sous la bulle | 11 | elles disparaissent quand la conversation avance |

C'est la première forme qu'on reconnaît des grandes campagnes RCS. L'écran met donc les boutons DANS la carte
dès qu'il y a un visuel (et laisse retomber le surplus en pastilles plutôt que de le perdre), plafonne à 4
dans ce cas, et son aperçu dessine les deux formes différemment : afficher des pastilles pour un message qui
partira en liste ferait croire à un choix qu'on ne fait pas.

⚠️ Conséquence pour `normaliserPostbacks` : la numérotation `btn:<i>` parcourt les boutons **de la carte
d'abord**, les pastilles ensuite. C'est l'ordre dans lequel l'écran les écrit et celui dans lequel le builder
numérote les sorties du bloc ; l'inverser enverrait le clic du premier bouton sur la branche d'un autre.

**Non exposé** : `webviewSize` sur un bouton lien (ouvrir la page dans une vue intégrée plutôt que dans le
navigateur), et le carrousel.

### Composeur : texte, visuel, variables

Le format se **déduit** de la saisie, dans un seul endroit (`web/lib/rcs.ts`, miroir serveur dans
`rcsOutboundOf`) : TEXTE sans visuel, **CARTE** dès qu'il y en a un (image au-dessus du texte, hauteur `TALL`).
Le texte tombe alors de 3072 à 2000 caractères, borne de leur champ `description`.

⚠️ Le mapping carte/carrousel a longtemps été FAUX (`card`/`cards` et `media.url` au lieu de `content`/
`contents` et `media.fileUrl`). Aucun envoi ne l'exerçait ; la première image serait partie en 400. Corrigé
contre leur spec le 2026-08-24, figé par un test.

Variables `{{champ}}` : **même** contrat et **même** table de substitution que les modèles d'email
(`contactVars`). Substituées dans le corps uniquement, jamais dans les libellés de boutons (25 caractères) ni
dans les URL, où une valeur vide ou trop longue ferait refuser le message entier. La fiche du contact n'est lue
QUE si le message porte des variables.

### Reste à faire

Le carrousel n'a pas de composeur, et `webviewSize` (ouvrir un lien dans une vue intégrée plutôt que dans le
navigateur du téléphone) n'est pas exposé.

## Lot « inbox, comptes, modération » (2026-08-21, migrations 0068-0073)

### Affectation d'une conversation (0070)

🔴 **`assigned_to` et `control_owner` sont ORTHOGONAUX.** `control_owner` dit QU'EST-CE QUI parle (scénario,
humain, agent Meta) ; `assigned_to` dit QUEL HUMAIN s'en occupe. Une conversation peut être affectée ET tenue
par le scénario. Les mélanger casserait le gel de scénario d'août.

La règle d'accès vit dans `src/inbox/assignment.ts`, fonction PURE, appelée par les TROIS routes qui écrivent
au client (réponse, template, lancement de scénario). Elle ne reçoit même pas `control_owner` : si quelqu'un
le lui passait, le code ne compilerait plus. Griser un bouton ne protège rien, le refus vient du serveur.

`on delete set null` sur l'affectataire : supprimer un membre LIBÈRE ses conversations au lieu de les
emporter. Une conversation que plus personne ne peut prendre serait invisible et sans réponse.

### Pagination et filtres de l'inbox (0069)

Le filtrage est en SQL, curseur sur `(last_message_at, id)` comparé en TUPLE. `id` départage les ex æquo :
sans lui, la pagination saute ou répète une ligne à la frontière de deux pages. Pas de drapeau `hasMore` :
une page pleine le dit déjà, un drapeau coûterait un décompte complet.

⚠️ Avant, l'écran filtrait EN MÉMOIRE les 100 conversations chargées : au-delà, le filtre ignorait le reste
sans rien signaler, et le compteur plafonnait à la taille de la page.

### Modération (0071)

Deux choses SÉPARÉES : `conversation_analysis.abusive` est un CONSTAT posé par l'analyse (qui ne déclenche
rien), `contacts.blocked_at` est une DÉCISION humaine (qui a des effets). Les mélanger laisserait un modèle
bloquer des clients tout seul.

Bloqué = plus aucun envoi (campagnes filtrées à la SOURCE dans `campaign/store.pg.ts`, automations coupées à
leur unique point d'entrée `runAutomations`) ET conversation masquée. 🔴 Les messages restent ENREGISTRÉS :
filtrer à la réception ferait disparaître une résiliation ou une menace juridique sans que personne le sache.

L'écran des contacts bloqués (Paramètres) est la SEULE porte de sortie : sans lui, un contact bloqué est
introuvable, donc perdu.

### Observation d'un espace depuis /ops

🔴 La LECTURE SEULE est une garde GLOBALE dans `makeRequireAuth`, fondée sur la MÉTHODE HTTP : `GET`/`HEAD`
passent, tout le reste est refusé. Une garde route par route aurait laissé passer celle qu'on oublie, et
surtout toute route d'écriture AJOUTÉE DEMAIN est couverte sans que personne y pense. Effet heureux : le
marquage « lu » est un POST, donc refusé : regarder une conversation ne fait pas disparaître les non-lus du
client.

La session d'emprunt (`Session.impersonated`) ne relit AUCUN état en base : son porteur n'a pas de compte
dans l'espace visité, le loader le révoquerait. Sa légitimité vient de sa signature, émise par `/ops/observe`
que protège le jeton d'exploitation (autorité SÉPARÉE du JWT client). `impersonated` est lu STRICTEMENT
(`=== true`).

### Une adresse, plusieurs espaces (0072/0073)

Le mot de passe vit sur l'ADRESSE (`identities`), plus sur le compte. Une table plutôt qu'un hash dupliqué :
l'invariant « une adresse = UN mot de passe » est EXPRIMÉ par la structure, pas simulé.

Connexion en deux temps. Un seul espace -> session directe (aucun écran de plus, c'est le cas courant).
Plusieurs -> le serveur rend la LISTE et un jeton de CHOIX, jamais une session.

🔴 Le jeton de choix ne peut pas tenir lieu de session : pas de `tenantId`/`role` à la racine (donc
`verifySession` le rejette), `kind` vérifié explicitement, et il PORTE la liste signée des espaces autorisés.
Sans cette liste, présenter un jeton légitime avec l'identifiant d'un espace quelconque suffirait à y entrer.

`setPassword` écrit sur l'IDENTITÉ (et en miroir sur `users.password_hash`, le temps de la transition) : une
réinitialisation vaut donc pour TOUS les espaces de l'adresse.

⚠️ **0073 est la seule migration IRRÉVERSIBLE du lot** : recréer `users_email_lower_unique` n'est possible
que TANT QU'AUCUN doublon n'existe. `users_tenant_email_unique` reste : deux comptes de la même adresse dans
le MÊME espace n'auraient aucun sens.

## Passage de main MBA et écran Activation (2026-08-21, migration 0067)

### Quand l'agent passe-t-il la main ? (mesuré au bac à sable le 2026-08-21)

Mesures faites via `POST /{phone_number_id}/agent_test` sur le numéro de test, `handoff` non configuré. Meta
écrit que les jetons consommés par cet endpoint ne sont pas facturés.

| Message envoyé | Réponse de l'agent | `handoff_reason` |
|---|---|---|
| « Je veux parler à un conseiller humain » | annonce le transfert | `customer_request` |
| « Le bus de 8h ne s'est pas arrêté ce matin. » | compatit, demande des précisions | `null` |
| « Comment obtenir un remboursement de mon abonnement ? » | répond depuis la base de connaissance | `null` |
| « Quel est le montant de ma dernière facture ? » | renvoie vers le service client | `null` |
| **« Le bus ne s'est pas arrêté ce matin. Comment obtenir un remboursement ? »** | **VIDE** | **`integrity_violation`** |

🔴 **Quand l'agent ne SAIT pas, il ne passe PAS la main.** Il renvoie vers les coordonnées de la base de
connaissance. L'intuition « s'il ne sait pas, il transfère » est fausse : c'est mesuré, deux fois.

🔴 **Un incident vécu PLUS une demande de réparation produit `integrity_violation` et une réponse VIDE.** Ni
l'incident seul, ni le mot « remboursement » seul ne le déclenchent : c'est bien la combinaison. Le client
reçoit alors le silence. Sans détection de notre côté, il reste sans réponse et personne n'est prévenu, ce qui
est le pire cas possible et l'argument le plus fort en faveur de la pastille « quelqu'un a besoin d'aide ».

**Troisième valeur de `handoff_reason` désormais connue** : `customer_request` (mesurée), `integrity_violation`
(mesurée le 2026-08-21), `complex_request` (exemple de la doc Meta, jamais observé chez nous).

⚠️ **Ces mesures viennent du BAC À SABLE, pas d'une conversation WhatsApp réelle.** Tant qu'aucun moyen de
paiement n'est rattaché au compte, aucun message WhatsApp n'atteint l'agent : l'onglet « Tester » est le seul
canal. La forme du payload `messaging_handovers` reste donc inconnue, et le restera jusque-là.


**Le point à ne pas confondre.** L'agent de Meta décide SEUL de transférer à un humain (« je veux parler à un
conseiller » produit `handoff_reason: customer_request`, mesuré sur le numéro de test le 2026-08-18). Le champ
`handoff.enabled` ne décide donc PAS du transfert : il décide si l'agent **lâche le fil** après l'avoir annoncé.
Le mettre à `false` en croyant « désactiver le transfert » livre le pire cas : le client lit « un conseiller
arrive » et personne n'est prévenu.

**Les trois champs** de `handoff` (`agent_config/settings`) : `enabled`, `message`, `message_selection`
(`DEFAULT` / `AGENT` / `CUSTOM`). Nous n'écrivons aujourd'hui que `enabled` ; le texte lu par le client reste
celui de Meta tant que le comportement réel des deux autres n'a pas été mesuré en conversation réelle.

**Chemin d'écriture.** `PATCH /tenants/:t/settings/mba-handoff` (admin) enregistre `mba_handoff_mode` en base : c'est la source de vérité : puis applique `handoff.enabled` chez Meta en best-effort. Un échec côté Meta ne
fait pas échouer l'enregistrement (le balayage rattrape) et la réponse porte `appliqueChezMeta: false`, que
l'écran affiche. `PATCH /mba/:pn/settings` accepte par ailleurs `handoffEnabled`, `handoffMessage` et
`handoffMessageSelection` pour piloter les trois champs directement.

🔴 **`modifierSettings` fusionne `handoff` par sous-objet**, comme `rollout` et `followup`. Sans cette ligne,
le balayage horaire : qui n'envoie que `enabled` : effacerait `message` et `message_selection` à chaque
bascule. C'est le même piège que le remplacement complet du PUT, une couche plus bas.

**Balayage horaire** (`src/mba/handoff-sweep.ts`, intervalle `CONTROL_SWEEP_INTERVAL_MS`, 5 min). Meta n'a
aucune notion d'horaires : c'est la seule façon de faire varier ce que le client perçoit selon l'heure. Il ne
traite QUE les tenants en mode `business_hours` (les deux autres modes sont écrits une fois, au choix), et
n'écrit que si l'état lu diffère de l'état voulu, sinon il réécrirait la configuration toutes les 5 minutes.

🔴 **`lireHandoffEnabled` rend trois états, pas deux** (`EtatHandoff`) : `true`/`false` lus chez Meta,
`'absent'` quand les réglages sont lisibles mais que `handoff` n'a jamais été configuré (Meta : « Null if not
configured »), et `null` quand il n'y a rien à lire. Confondre `'absent'` avec `false` empêcherait
d'initialiser un agent neuf : le balayage croirait l'état déjà conforme.

**Routage d'une réponse hors boutons** (`advance`, `src/workflow/executor.ts`). Trois cas : arête partant du
handle du bouton tapé ; sinon arête LIBRE (`nextNodeSansHandle`, aucune `sourceHandle`) ; sinon fin du run et
release vers l'agent. `nextNode` prenait la 1re arête venue, donc la branche du 1er bouton. Le builder expose
la sortie libre sur les blocs à boutons, sans quoi le 2e cas serait inatteignable.

⚠️ **`control_changed_at` ne se rafraîchit pas** quand un opérateur répond une 2e fois : `setControlOwner`
porte `control_owner is distinct from $3` dans son WHERE, donc reposer le même détenteur ne met à jour aucune
ligne. Le compte à rebours de reprise part donc de la PREMIÈRE intervention. L'ancien texte de l'Accueil
disait « dernière » : c'était faux, et le nouvel écran le dit correctement.

## Traçage des clics sur les liens de templates (2026-08-20, migration 0066)

**Le principe.** L'utilisateur saisit son lien. À la **soumission à Meta**, le serveur le remplace par
`https://<APP_URL>/r/<code>` et garde la destination d'origine en base. Au clic : on compte, puis on redirige
en **302**. Personne d'autre ne garde la destination : Meta ne connaît plus que la nôtre.

**La maille est le BOUTON**, pas le template : un template peut porter deux boutons URL, un carousel en porte
par carte. Clé unique `(tenant, template_name, template_language, coalesce(card_index,-1), button_index)`.

**Deux tables** (`db/migrations/0066_tracked_links.sql`) :
- `tracked_links` : `code` (12 car. base32 minuscules, `newTrackingCode()` dans `src/ids/code.ts`), la cible,
  la `destination`, et `confirmed_at`.
- `tracked_link_clicks` : une LIGNE par clic (pas un compteur : l'écran filtre sur une période).

🔴 **`confirmed_at` n'est pas décoratif.** Il est posé seulement quand **Meta a accepté** le template. Les
mesures et le ré-habillage d'affichage ne lisent QUE les lignes confirmées, sans quoi une réservation suivie
d'un refus ferait apparaître dans Analytics une case qui reste à zéro pour toujours. En revanche la
**redirection ne filtre PAS** dessus : si Meta a accepté mais que notre confirmation a échoué, le lien circule
déjà et doit fonctionner. Un lien qui marche sans être mesuré vaut mieux qu'un lien mort bien comptabilisé.

🔴 **Ordre d'écriture imposé** : destination en base **AVANT** l'appel à Meta. L'inverse laisserait, sur une
panne entre les deux, un template approuvé pointant un code inexistant, donc un lien mort irréparable dans des
messages déjà livrés. Une panne du traçage soumet le template avec le lien **saisi** (`preparerLiens` dans
`src/http/templates.ts`) : un template non mesuré vaut mieux qu'un template refusé.

**Ré-habillage à la relecture** : `rehabillerTemplates` (`src/http/templates.ts`) remplace notre adresse par la
destination d'origine **sur la route de liste**, donc pour les quatre écrans qui affichent un template (page
Templates, création de campagne, éditeur de scénario, inbox). Appariement **sur l'URL**, jamais sur la position :
un template édité hors console peut avoir vu ses boutons réordonnés.

**Route publique** `GET /r/:code` (`src/http/links.ts`), montée avec le webhook et `/ops`, **avant** les gardes
d'auth. Trois points non négociables :
- `scopeTenant` est **inutilisable** ici : sans `req.auth`, elle rend le tenant de l'URL sans le vérifier. Le
  tenant vient du **code** retrouvé en base.
- **Open redirect** : la destination est revalidée par `isSendableButtonUrl` **à la lecture**, pas seulement à
  l'écriture.
- **302 et non 301** : un 301 est mis en cache par le navigateur, qui n'appellerait plus jamais la route. On
  perdrait tous les clics suivants et on ne pourrait plus changer la destination.

⚠️ **Exposition publique** : NPM ne route que `mba-web`, et `mba-api` n'a aucun port hôte publié. Le seul
chemin est le rewrite `/r/:code` de `web/next.config.mjs`, **gelé au build de l'image web**.

**Mesures.** Les clics ne peuvent PAS vivre dans `workflow_node_events` : elle exige `tenant_id`,
`workflow_id`, `node_id` et `wa_id` tous NOT NULL, or un clic sur un lien statique n'identifie personne. Ils
sont donc **fusionnés à la lecture** (`src/links/mesures.ts`, `getWorkflowNodeCounts` dans `src/index.ts`) sous
une nature `url_click` qui n'existe QUE dans la réponse de l'API et dans le front. Rien n'a été ajouté au CHECK
de 0063, ce qui évite la panne silencieuse d'un insert refusé (`record()` est best-effort partout).
`NodeEventCount.contacts` devient `number | null` : `null` = « on ne sait pas distinguer les personnes ».

**Lecture par CAMPAGNE** : `getCampaignFunnel` (`src/stats/store.pg.ts`) rend `urlClicks` (clics des liens
tracés du template de la campagne, **depuis son premier envoi**) et `buttonReplies` (taps de réponse rapide,
sous-ensemble de `replied`, discriminés par `conversation_messages.type = 'button'` et surtout PAS par
`button_payload is not null`, que remplissent aussi `interactive` et `reaction`). `urlClicks` vaut **`null`**
quand le template ne porte aucun lien tracé confirmé : l'écran masque alors l'étape au lieu d'afficher un zéro
trompeur. La route `GET /tenants/:t/stats/links` et `listAvecClics` (lecture « tous envois confondus ») ont été
RETIRÉES le 2026-08-21 avec la carte de Mes tableaux qu'elles alimentaient.

🔴 **Ne comptez pas les clics de Meta.** Mesuré le 2026-08-21 sur le premier lien de la production : 70 requêtes
sur le lien d'un template JAMAIS envoyé, dont 59 de l'agent `facebookexternalhit` et 11 de vrais navigateurs
arrivant de Facebook (référent `*.facebook.com`, paramètre `fbclid`), soit l'équipe de revue de Meta. Tout
template à bouton URL est donc exploré ET cliqué avant son premier envoi. Deux garde-fous, complémentaires :
`estClicAutomatique` (`src/links/clic-automatique.ts`) écarte ces requêtes **à l'écriture** tout en redirigeant
toujours, et le seuil « depuis le premier envoi » du funnel écarte **à la lecture** tout ce qui a été
enregistré avant que ce filtre n'existe. Aucun user-agent ni IP n'est stocké pour autant (migration 0066).

**Faits Meta MESURÉS le 2026-08-20** (deux templates d'essai, tous deux approuvés) : le domaine du bouton
**n'a pas besoin d'appartenir à l'entreprise**, et Meta **ne vérifie pas l'accessibilité** de l'URL à la revue
(un lien en 404 est passé). Détail : `brain/LEARNINGS.md`.

## Export PDF d'une carte (2026-08-20, aucune dépendance)

`web/lib/impression.ts` marque la carte visée d'une classe, marque le `body`, et appelle `window.print()`. Le
CSS de `web/app/globals.css` masque tout le reste **sous `@media print` uniquement** : à l'écran, une zone
restée marquée ne change rien. `visibility` et non `display`, sinon retirer les ancêtres du flux casserait la
grille qui porte la carte. Pas de `jspdf`/`html2canvas` : quelques centaines de kilo-octets pour rendre une
image au lieu d'un document, alors que « Enregistrer au format PDF » est dans la boîte d'impression de tous les
systèmes. ⚠️ La zone précédente est **démarquée** avant chaque impression : `afterprint` n'est pas garanti, et
une zone restée marquée s'imprimerait avec la suivante.

## Rôle `manager` (2026-08-20, migration 0065)

Troisième statut de membre. La contrainte de 0001 n'admettait que deux rôles : sans la migration, attribuer
« manager » remonte une 23514 depuis la base.

⚠️ **Un statut, pas des droits.** Tout ce qui est réservé l'est à `admin` (`makeRequireRole(['admin'])` sur les
groupes, `forbidNonAdmin` dans les handlers) : un manager a donc les accès d'un agent. Ce qu'il aura le droit de
faire se décidera écriture par écriture.

Corrigé au passage : le prédicat de `setRole` était écrit en dur sur `role = 'agent'`, il refusait donc de
rétrograder un manager dès qu'il ne restait qu'un seul admin. C'est `role <> 'admin'` : le compte visé n'étant
pas admin, le changer ne peut pas faire tomber le nombre d'admins. `pageDArrivee(role)` (`web/lib/session.ts`)
centralise la redirection après connexion : seul l'admin va sur `/accueil`, tout le reste sur `/inbox`.

## RGPD : journal d'audit et suppression (2026-08-19, migration 0061)

**Une seule destruction.** Il en a existé deux : `softDeleteMany` (douce, `deleted_at`, réversible, qui gardait
la conversation) et la purge. Les distinguer à l'écran ne servait personne : on supprime un contact pour qu'il
disparaisse, pas à moitié, et le fil restait dans l'Inbox après coup. « Supprimer » appelle donc
`POST /tenants/:t/contacts/purge`, qui exige `confirm: 'SUPPRIMER'` dans le corps, et l'écran fait TAPER le mot
(le serveur le demande déjà, mais c'est le client qui l'envoie : cette garde ne protège que d'une erreur d'API).
La colonne `deleted_at` reste : la purge la pose en même temps que `anonymized_at`, pour que la fiche vidée
quitte le CRM, et l'upsert par numéro la remet à null (résurrection).

**Ce que `purgeMany` efface, et ce qu'il garde.** EFFACÉ (contenu identifiant) : la conversation, ses messages,
son analyse qualitative (`topic` et `justification` en texte libre produits par un modèle), plus les traces
techniques portant le numéro (parcours de scénario, déclenchements d'automation, cache de joignabilité RCS).
ANONYMISÉ (pour que le quantitatif survive) : la ligne de contact (`phone_e164` remplacé par `anon:<uuid>`
ALÉATOIRE, pas une empreinte, qui serait réversible sur un espace de numéros français) et les lignes de
campagne (`to_e164`, `resolved_params`). Les totaux d'envoi et de livraison restent donc justes.

⚠️ **Trois pièges de format dans cette fonction, tous vus en production le 2026-08-18.** (1) Le fil porte un
`wa_id` SANS `+` (`33612345678`), la fiche un E.164 (`+33612345678`) : la correspondance passe par le prédicat
partagé `matchWaIdPredicat`, jamais par une égalité directe. (2) `rcs_capabilities_cache` a pour clé
`(agent_id, phone_e164)`, donc E.164 et non wa_id. (3) `automation_fires` a pour clé `(automation_id, wa_id)`
et **ne porte PAS de `tenant_id`** : son cloisonnement passe par un `using automations`. Un filtre sur une
colonne absente ne renvoie pas « rien », il LÈVE et annule toute la transaction.

**Le journal d'audit** (`src/audit/store.pg.ts`, table `audit_log`, migration 0061) est en AJOUT SEUL : ni
update ni delete, sinon il ne prouve rien. Il ne porte JAMAIS de donnée personnelle, seulement l'identifiant
interne du contact : y écrire le numéro au moment d'une suppression annulerait la suppression. `actor_email`
est DÉNORMALISÉ pour que l'historique reste lisible après le départ d'un collaborateur ; acteur `null` = le
système (webhook, script serveur). Écriture BEST-EFFORT partout (`src/audit/journal.ts`) : une panne de log ne
doit pas empêcher un client d'exercer son droit à l'effacement. Actions consignées : `contact.created`,
`contact.imported` (UNE ligne par LOT, sinon un import de 50 000 lignes noie l'historique), `contact.purged`,
`contact.optin`, `contact.optout`. Lecture : `GET /tenants/:t/audit`, affichée dans Paramètres.

**Consentement.** ⚠️ Tout part d'un fait à garder en tête : `optInAllows` (`src/campaign/guardrails.ts`) exige
un opt-in **EXPLICITE** pour une campagne marketing. Un contact `unknown` est donc écarté des envois **en
silence** ; seul `utility` passe. Chaque défaut d'opt-in ci-dessous se lit à cette lumière.

`opted_out` était lu par les filtres et le garde-fou mais **aucun chemin ne l'écrivait** : l'upsert d'import et
d'API ne fait jamais régresser un statut, donc un client demandant à ne plus rien recevoir n'était
enregistrable nulle part. Trois chemins l'écrivent maintenant, tous journalisés :

- **En masse** depuis le mini-CRM : action `set_optin` (`BulkEdits.setOptIn`, source `crm`).
- **Sur la fiche** : `PATCH /tenants/:t/contacts/:id` accepte `optInStatus`. DEUX valeurs seulement, jamais un
  retour à `unknown` : ce statut signifie « rien n'a jamais été enregistré », le repeindre falsifierait le
  registre au lieu de le corriger. L'écran ne propose pas non plus le statut courant.
- **Par WhatsApp Flow** (composant OptIn coché), la preuve de consentement la plus forte : `markOptedIn`,
  source `flow`, acteur `null` au journal puisque c'est le contact lui-même qui a agi.

**Opt-in PAR DÉFAUT** sur les deux chemins de création manuelle : la saisie à la main (case pré-cochée) et
l'import CSV (idem, et le défaut de la route est aligné dessus). Les saisir suppose qu'on tient le numéro de la
personne, et les créer muets en ferait des contacts que les campagnes ignorent sans rien dire. L'**API publique
`/v1/contacts` et l'import HubSpot gardent l'exigence inverse** (opt-in explicite) : leur appelant charge une
liste dont il ne connaît pas chaque ligne. ⚠️ Conséquence à connaître : les contacts venus de HubSpot arrivent
`unknown`, donc hors marketing tant qu'on ne les bascule pas (fiche ou action en masse).

⚠️ **Une promesse d'effacement ne se teste pas avec un faux.** Les tests unitaires à faux store prouvaient que
la route appelle `purgeMany`, jamais que `purgeMany` efface quelque chose : c'est ainsi que les trois pièges
ci-dessus sont partis en production. `tests/integration/purge-rgpd.integration.test.ts` écrit un contact, son
fil, ses messages, son analyse, un parcours et un déclenchement, purge, et RELIT ce qui reste.

## Lot UX 6 clusters (2026-07-28, migration 0049)

- **Mini-CRM : filtres + actions en masse** (`src/crm/contact-store.pg.ts`) : `buildContactWhere` et
  `buildBulkSelector` extraits en **fonctions PURES exportées** (testables sans DB), avec `deleted_at is null`
  TOUJOURS dans le WHERE. Opérateurs de champ étendus (`ContactFieldOp` : eq/contains/not_contains/empty/not_empty)
  + `tagsExclude` (« ne possède pas »), whitelist partagée `CONTACT_FIELD_OPS`/`isContactFieldOp` (miroir du parse
  serveur `parseFilters` et du corps `normalizeContactFilters`). Méthodes ensemblistes `applyEditsMany` (une seule
  clause `tags=` add+remove, MERGE jsonb pour set_field). Cible = ids OU `{filters, excludeIds}`
  (jamais un payload de 100k UUID). Route `POST /tenants/:t/contacts/bulk` (admin-only). ⚠️ `softDeleteMany` et
  `/bulk-delete` ont été RETIRÉS le 2026-08-19 : voir « Une seule destruction » plus bas.
  Migration **0049** : colonne `deleted_at` + index partiel `idx_contacts_active`. ⚠️ Soft-delete propagé à
  `listContactsForBuild`/`listContactsForBuildByIds` (campaign/store.pg.ts) + `findByPhone` ; l'upsert par numéro
  remet `deleted_at=null` (résurrection). Front : `web/lib/contact-filters.ts` (types + `filtersToQuery`, PUR).
- **Scénarios** : `autoLayoutHorizontal` (`web/lib/workflow-layout.ts`, PUR) = disposition en couches gauche->droite
  (relaxation « plus long chemin » bornée à N itérations, sûre sur cycles). Route duplicate `POST /workflows/:id/
  duplicate` au niveau route (réutilise getWorkflow/listWorkflows/createWorkflow/tenantCode) : nom « (copie) »
  unique + **codes de node RE-MINTÉS** (strip `data.code` avant `mintNodeCodes`, sinon conservés = doublons).
  Colonne date via `formatDate` (`web/lib/day.ts`).
- **Contenu > Blocs** : `web/lib/node-search.ts` (`filterNodes<T>`, `normalizeSearch`, PUR) : filtrage client
  cumulable type + texte (haystack : type/summary/workflowName/code, insensible accents/casse). La page charge tous
  les blocs une fois (dataset borné).
- **Flow field mapping** : `web/lib/flow-mapping.ts` (`BASE_SAVE_FIELDS`, `suggestBaseField`, PUR). Cible du champ
  de base « Nom » = **sentinelle `PROFILE_NAME_SAVE_KEY = '@profile_name'`** (impossible à produire par `slugify`,
  qui n'émet que `[a-z0-9_]`) -> `processFlowCompletions` (webhook report) route `@profile_name` vers
  `setProfileNameByPhone` (nouvelle méthode du writer = `PgContactStore`), le reste dans `contacts.fields`. Test
  anti-drift : `PROFILE_NAME_SAVE_KEY` (web) === `PROFILE_NAME_TARGET` (serveur).
- **Guide MBA** : page de CONTENU `web/app/mba/page.tsx` (nav `web/components/AppShell.tsx`, tab `mba`), aucune
  logique. Ton client, zéro mention d'infra. Config live parquée (ToS Meta Business AI + gating vertical).

## Webhooks entrants (2026-08-23, migration 0074)

Un outil tiers poste du JSON sur `POST /w/:code` ; on en extrait des valeurs vers la fiche contact, et on
publie l'événement qui déclenchera le scénario configuré.

### La décision structurante : le webhook POSSÈDE une automation

La tentation était de poser `workflow_id` / `start_node_id` / `cooldown_seconds` sur la table `webhooks`,
comme sur `automations`. On aurait alors DUPLIQUÉ la sémantique du déclenchement à deux endroits, avec deux
jeux de garde-fous à maintenir.

À la place, un webhook qui doit lancer un scénario possède une ligne `automations` de type `webhook`
(`webhooks.automation_id`), et la route publique se contente de publier un événement dans la file
`automation-event`. Le déclenchement passe donc par `runAutomations` et hérite **gratuitement** de ses six
filtres : contact bloqué, correspondance, anti-rebond par contact, condition, plafond horaire, un seul
parcours actif. Zéro logique de déclenchement nouvelle, une seule source de vérité.

Cette ligne compagnon est POSSÉDÉE par son webhook :
- créée, modifiée et supprimée par `PgWebhookStore`, dans une transaction (le lien est un invariant) ;
- **exclue** de `PgAutomationStore.list`, donc invisible dans l'écran Automation (l'y montrer donnerait une
  ligne que l'utilisateur n'a pas créée, et un second endroit pour la modifier, donc une désynchronisation) ;
- **refusée** à la création depuis la route `/automations` (`validateTriggerConfig`), sinon on obtiendrait une
  automation active que son propre écran ne montre pas et qu'aucun webhook ne détient.

⚠️ `trigger_kind` n'a **aucune contrainte CHECK en base** (migration 0052) : ajouter le type `webhook` n'a
demandé AUCUNE migration sur `automations`, exactement comme `hubspot_deal_stage` avant lui.

### La route publique

`POST /w/:code`, montée dans `buildServer` **avant** les gardes d'auth, aux côtés de `/r/:code`. Servie par le
rewrite `/api/backend/:path*` du front, déjà en place : pas de rewrite dédié dans `next.config.mjs`, qui serait
GELÉ au build de l'image web et casserait au premier `up -d` sans `--build`.

1. Forme du code vérifiée AVANT toute requête SQL (26 car. base32).
2. Code inconnu **ou webhook désactivé** rendent le MÊME 404. Secret exigé et absent, faux, ou d'un autre
   webhook rendent le MÊME 401.
3. Plafond de débit par WEBHOOK, pas par IP : l'IP d'un Zapier n'a aucune stabilité.
4. ⚠️ **Le parseur JSON global transforme un corps invalide en `{}` sans lever** (il est écrit pour le webhook
   Meta, où la signature tranche ensuite). On ne peut donc PAS conclure d'un objet vide qu'on a reçu du JSON
   valide : la route relit le `rawBody` pour trancher, et rend 400.
5. Le mapping est appliqué **en itérant sur NOTRE mapping, jamais sur les clés reçues** (même doctrine que
   `web/lib/flow-mapping.ts`) : sinon un tiers écrirait où il veut en nommant ses clés comme nos champs.
6. L'écriture du contact passe par `upsertContactsFromApi`, le chemin PARTAGÉ avec l'API publique et l'import.
7. Le payload est enregistré dans `last_payload` **quoi qu'il arrive** : c'est ce qui alimente l'arbre de
   mapping, et le seul moyen de déboguer « pourquoi rien ne se passe ».

🔴 **Toujours 200 sur un appel bien formé, même si rien n'a été fait.** Un tiers qui reçoit une erreur
réessaie en boucle, et beaucoup désactivent le webhook après quelques échecs. Le détail passe dans le corps :
`{ ok, contact, champs, scenario, raison?, ignores? }`. Toute erreur destinée au tiers sort en **4xx**, jamais
en 5xx (Cloudflare remplace le corps des 5xx par sa page).

### Les chemins JSON, dupliqués des deux côtés

`src/webhook-entrant/chemin.ts` LIT les chemins (`client.tel`, `lignes[0].prix`), `web/lib/chemin-json.ts` les
FABRIQUE depuis l'arbre affiché. Les deux ne partagent aucun paquet (le front a son propre tsconfig), donc la
grammaire est **dupliquée**, comme `lib/signature.ts` l'est avec mm-hubspot. Deux filets :
- un **jeu de chemins d'or identique**, figé dans les tests des deux côtés ;
- la route de configuration **REFUSE** un chemin qu'elle ne sait pas lire, donc une divergence sort en 4xx
  visible au lieu de produire un mapping muet.

Une clé contenant un point ou un crochet est **inadressable** : inventer une syntaxe d'échappement que
personne ne saurait relire dans l'écran serait pire. L'arbre l'affiche mais la signale comme telle.

### Deux refus qu'il faut comprendre

🔴 **Une valeur non scalaire est refusée À LA CONFIGURATION.** Les valeurs de champ sont stockées en chaîne, et
`contactVars` transforme en `null` toute valeur non primitive : un objet écrit dans un champ rendrait la
variable **vide** dans un template, sans la moindre erreur. Le seul moment où l'utilisateur peut comprendre le
problème, c'est quand il configure. La validation se fait contre `last_payload` ; un chemin qui ne résout pas
est en revanche accepté, parce qu'un tiers n'envoie pas toujours ses champs facultatifs.

🔴 **La LONGUEUR est filtrée en amont, le TYPE non.** `upsertContactsFromApi` refuse l'enregistrement ENTIER
dès qu'une valeur est invalide : un téléphone parfaitement bon serait perdu parce qu'un tiers a envoyé une
description de 3000 caractères dans un champ voisin. Ce cas-là n'est pas une erreur de mapping, donc
`valeurTexte` écarte la seule valeur fautive et la RAPPORTE dans `ignores`. Une valeur invalide pour le TYPE
du champ reste, elle, un refus complet avec sa raison : c'est une erreur de configuration, et la faire
disparaître en silence empêcherait l'opérateur de la corriger.

### Dates venues d'un tiers (2026-08-23, aucune migration)

`src/crm/date-iso.ts` normalise vers l'ISO 8601, et sert `validateFieldValue` + `canonicalizeFieldValue`,
donc TOUS les chemins d'écriture d'un champ (webhook, API publique, import CSV, fiche contact, formulaire).

**La règle : on normalise ce qui est NON AMBIGU, on refuse le reste EN LE DISANT.**

| Reçu | Résultat |
|---|---|
| `2026-08-23T15:40:00Z`, `...+02:00`, sans secondes | conservé tel quel |
| `2026-08-23 15:40:00` (espace) | -> `2026-08-23T15:40:00` |
| epoch 10 ou 13 chiffres | -> ISO UTC |
| `2026-08-23` dans un champ `date` | conservé |
| `2026-08-23` dans un champ `datetime` | **refusé** (`sans_heure`) |
| `03/04/2026`, `23/08/2026`, `3.4.26` | **refusé** (`ambigu`) |
| `2026-02-30`, `2026-08-23T25:00` | **refusé** (`illisible`) |

🔴 **Pourquoi refuser plutôt que deviner.** Une date mal devinée ne ressemble pas à un bug, elle ressemble à
une date. Elle ne se voit qu'au moment où un rappel part un mois trop tôt, chez le client. `23/08/2026` serait
déchiffrable (23 ne peut pas être un mois), mais l'accepter pendant qu'on refuse `03/04/2026` rendrait la
MÊME intégration tantôt bonne tantôt cassée selon le jour du mois : on refuse uniformément.

🔴 **Pourquoi ne pas inventer minuit** sur un jour seul. C'était déjà le contrat (« date nue = pas datetime »,
verrouillé par un test antérieur), et ça compte encore plus depuis qu'un déclencheur peut partir « X heures
avant » cette valeur : un rappel réglé sur 2 h avant partirait à 22 h la VEILLE.

⚠️ Une valeur SANS fuseau reste SANS fuseau : c'est une heure murale, interprétée dans le fuseau de l'espace
à l'évaluation. Lui coller un `Z` la décalerait de plusieurs heures, silencieusement.

⚠️ Une première version du motif « ambigu » acceptait 1 à 4 chiffres en tête, si bien que `2026-07-17` y
tombait : toutes les dates ISO auraient été refusées. Attrapé par la suite existante, pas par un test neuf.

Chaque refus remonte jusqu'à l'appelant (`raisonDateLisible`), donc un intégrateur de webhook lit
« il manque l'heure » plutôt que « valeur invalide (datetime) ».

### Sécurité et RGPD

- **Le tenant vient du CODE, jamais du corps.** `/hubspot/deal-stage` accepte un `tenantId` dans son payload :
  tolérable pour un connecteur maison à secret unique, inacceptable pour une URL remise à Zapier.
- Code de 26 caractères base32 (130 bits) : c'est une clé d'accès, pas un identifiant. `newTrackingCode` se
  contente de 60 bits parce qu'il doit tenir dans une URL de bouton WhatsApp ; nous n'avons pas cette contrainte.
- Secret d'en-tête **optionnel** (`X-Webhook-Secret`), stocké haché, comparé en temps constant.
- Le CRUD de gestion est **admin only** (`requireAdmin` + `forbidNonAdmin`).
- `last_payload` : le **dernier seulement**, jamais d'historique. Purge automatique à
  `WEBHOOK_PAYLOAD_RETENTION_DAYS` jours sans appel (balayage du worker, toutes les 6 h) + bouton « oublier ».
- ⚠️ `windowOpen = false` pour un événement webhook : le contact n'a pas forcément écrit, donc le scénario doit
  ouvrir par un template approuvé, sinon la garde de l'exécuteur le refuse.

## Campagne AU FIL DE L'EAU, alimentée par un webhook (2026-08-26, migration 0084)

Une campagne ordinaire fige ses destinataires à la création. Celle-ci n'en a AUCUN au départ : elle reste
ouverte, et chaque contact qui arrive par le webhook désigné devient un destinataire de plus.

### La décision structurante : aucun chemin d'envoi nouveau

L'alimentation INSCRIT un destinataire et enfile un `campaign-run`. C'est `runCampaign` qui envoie, avec sa
cadence, son quality gate, son claim atomique, son journal de conversation et ses statistiques. Un arrivant
part donc exactement comme un destinataire choisi à la main, et aucune règle d'envoi n'existe en double.

Même doctrine pour l'éligibilité : `alimenterCampagnesWebhook` appelle `buildRecipients` TEL QUEL sur UN
contact (opt-in marketing, identité requise, résolution des variables). Rien n'est réécrit, donc rien ne peut
diverger de la voie ordinaire.

### Une colonne, pas un type de campagne

`campaigns.webhook_id is not null` DIT déjà tout : c'est la source, et c'est le drapeau. Un `source text` en
plus décrirait deux fois la même chose, avec le risque classique que les deux divergent.

### Les cinq pièges, et ce qui les tient

1. **Une campagne au fil de l'eau ne se TERMINE pas.** `runCampaign` sort en `running` au lieu de `completed`
   quand `campaign.webhookId` est posé. La marquer terminée la couperait de son webhook (le feed ne nourrit
   que les campagnes `running`) et plus aucun lead ne serait contacté, sans le moindre signal. Le quality gate
   garde le dernier mot : une pause reste une pause.
2. **La route publique ne publiait RIEN sans scénario.** `POST /w/:code` ne publiait l'événement que si
   `automation_id` était posé. `getByCode` rend désormais `alimenteCampagne`, calculé par un `exists` sur les
   campagnes `running` DANS la requête qui a lieu de toute façon. Un compteur sur la table se
   désynchroniserait au premier arrêt ou archivage oublié ; l'état des campagnes, lui, fait foi.
3. **`singletonKey` peut avaler l'enfilement.** Un arrivant pendant un run en vol verrait son job coalescé et
   resterait `pending` jusqu'à l'arrivant SUIVANT, qui peut ne jamais venir. Un balayage de 60 s
   (`listWebhookCampaignsWithPending`) relance les campagnes qui ont vraiment quelqu'un en attente.
4. **Un écart doit s'INSCRIRE.** Un arrivant sans consentement (marketing) ou dont une variable manque est
   enregistré `skipped` AVEC son motif. Sinon l'opérateur voit une campagne à zéro destinataire alors que des
   gens sont bien arrivés. L'écran prévient en amont quand l'adresse choisie n'affirme pas le consentement.
5. **Supprimer l'adresse tuerait la campagne en silence.** La route `DELETE /tenants/:t/webhooks/:id` refuse en
   **409** tant qu'une campagne vivante s'en nourrit, en la NOMMANT (409 et pas 5xx : Cloudflare remplace le
   corps de toute réponse 5xx). La FK reste `on delete set null` pour ne pas emporter l'historique d'une
   campagne terminée.

### Chemin complet

```
POST /w/:code  (route publique, tenant déduit du code)
  -> écriture du contact (chemin partagé upsertContactsFromApi)
  -> publish { kind: 'webhook', waId, webhookId }   si scénario OU campagne au fil de l'eau
        file automation-event
  -> worker : runAutomations(...)                    (scénario, inchangé)
  -> worker : alimenterCampagnesWebhook(...)         (campagnes, isolé dans son propre try)
        listRunningByWebhook -> contactForBuildByWaId -> buildRecipients
        -> insertWebhookRecipient (on conflict do nothing) -> enqueueCampaignRun
  -> job campaign-run -> runCampaign  (envoi réel, cadence, garde-fous)
```

L'alimentation est isolée dans son propre `try` : un souci de campagne ne doit pas faire échouer l'événement,
donc rejouer un scénario DÉJÀ démarré. Une campagne perdue se rattrape au balayage, un scénario démarré deux
fois ne se rattrape pas.

### Anti-doublon

La contrainte `campaign_recipients (campaign_id, contact_id)` fait tout le travail : la même personne qui
repasse par l'adresse ne reçoit pas le message une seconde fois. `insertWebhookRecipient` rend `false` dans ce
cas, et AUCUN run n'est enfilé (sinon la campagne repartirait pour rien à chaque repassage).

### Arrêt

`POST /tenants/:t/campaigns/:id/stop` passe la campagne en `completed` : c'est son seul point final. `completed`
et pas `paused`, parce que la liste propose « Reprendre » sur une campagne en pause, ce qui n'aurait ici aucun
sens (rien ne reste à envoyer). 404 sur une campagne ordinaire ou déjà arrêtée.

## Bloc QUESTION : menu WhatsApp, réponse attendue, et échéance (2026-08-26, migration 0085)

Un bloc qui pose une question au contact, avec un MENU déroulant de réponses (liste interactive WhatsApp) ou
sans menu, et qui ROUTE la réponse. Trois familles de sorties : `row:<i>` par ligne du menu, l'arête LIBRE
(le contact écrit au lieu de choisir), et `timeout` à l'échéance.

### La décision structurante : il attend la réponse ET le temps

C'est le seul bloc du produit dans ce cas, et c'est ce qui a demandé le plus de soin.

Le moteur n'avait que deux repos : `waiting` (une réponse du contact le reprend, via `findWaitingByWaId`) et
`sleeping` (le balayeur le reprend à l'échéance). Ils s'excluent : un run `sleeping` est INVISIBLE de
`advance`, c'est écrit et voulu.

Le bloc Question reste donc **`waiting`** et porte EN PLUS un `resume_at`. Le choix se lit à l'envers : mettre
le run en `sleeping` pour obtenir l'échéance ferait perdre la réponse du contact, ce qui est exactement ce
qu'un bloc Question ne peut pas se permettre.

- `WalkRest` gagne `timeoutInMs` sur la variante `waiting` ; `restToState` le traduit en `resume_at`.
- `claimDueQuestions` (nouveau) réclame les runs `waiting` à échéance due. Migration 0085 : un index partiel
  `(resume_at) where status = 'waiting' and resume_at is not null`, sans quoi un balayage par minute
  scannerait toute la table des runs en attente. AUCUNE colonne neuve, `resume_at` existe depuis 0054.
- `resume(run)` reçoit désormais `status` : `sleeping` reprend au bloc SUIVANT (bloc Attente, inchangé),
  `waiting` sort par la poignée `timeout`. Prendre le successeur enverrait un contact silencieux dans la
  branche du premier câblage venu.

### Réclamation : un BAIL, jamais une consommation

Première version : `resume_at = null` à la réclamation, pour qu'une expiration ne soit prise qu'une fois.
Elle garantissait surtout de la PERDRE définitivement au premier refus de Meta ou redéploiement du worker :
le run restait `waiting` sans échéance, le fil tenu par un parcours mort, et `closeStaleSleeping` ne le voit
pas (il ne regarde que les dormants).

C'est donc le MÊME bail que `claimDueSleeping` (`resume_at = now() + 15 minutes`). Ce qui efface l'échéance
pour de bon, c'est la reprise elle-même : toutes les sorties de `resume` passent par `setState`, qui écrit
`resume_at` SANS coalesce. Différence assumée avec le sommeil : le run reste joignable par une réponse
pendant la reprise, parce qu'avaler une réponse de client serait pire qu'un doublon.

### L'index d'une ligne EST sa sortie

`row:<i>` suit la ligne AFFICHÉE dans l'éditeur. Trois conséquences, chacune apprise à ses dépens ailleurs :

1. `sendList` filtre les libellés vides **après** numérotation (miroir exact de `sendInteractive` pour
   `btn:<i>`). Filtrer avant renuméroterait, et le contact partirait dans la mauvaise branche.
2. Supprimer une ligne depuis le panneau passe par un événement `wf-row-delete` que le BUILDER traite :
   il retire l'arête de la ligne et **décale les `row:<j>` suivants**. Le panneau seul ne voit pas les arêtes ;
   renuméroter les données sans elles repointait silencieusement des branches déjà reliées.
3. Une ligne au libellé vide n'expose AUCUNE poignée : elle n'est jamais envoyée, la relier promettrait une
   branche que le contact ne peut pas prendre.

### Ce qu'il fallait toucher ailleurs, et pourquoi

- **Canal.** Une question réussie ramène le parcours sur WhatsApp, comme un template ou un formulaire. La
  liste interactive n'existe QUE sur WhatsApp : sans cette bascule, un run venu d'un bloc RCS restait marqué
  `rcs`, et la garde d'étanchéité de `advance` JETAIT la réponse WhatsApp du contact.
- **Fenêtre de 24 h.** C'est un message de session : `besoinsFenetre` (reprise), la garde de `runFrom`
  (ouverture à froid) et `exigeFenetre24h` (API publique `/v1/sends`) le connaissent tous les trois.
- **Variables `{{champ}}`.** Le panneau offre le composant d'insertion partagé, donc `wiring.sendQuestion` les
  RÉSOUT (corps, libellés et descriptions) avant l'envoi. La fiche n'est lue que si le texte en porte. Sans
  ça, l'éditeur promettait une substitution que personne ne faisait et le contact lisait `{{prenom}}`.
- **Bouton mort.** `row:` rejoint `btn:|card:` dans la règle d'escalade : une ligne tapée qui ne mène nulle
  part remonte la conversation à un humain, au lieu de rendre la main en silence.
- **Analytics.** `timeout` est exclu des choix (personne ne CLIQUE une absence de réponse), les lignes
  portent leur libellé et non `row:0`, et chaque bloc porte SA question comme titre.
- **Ouverture de campagne.** `scanOpening` le compte comme `sessionOpen`, et une question NON configurée est
  un PASSE-PLAT (dans `walk` comme dans les deux miroirs d'analyse) : figer un parcours sur une question
  jamais posée serait invisible, le laisser continuer se voit.

## Automation : déclencher un scénario sur un événement (Lots E / E.2, 2026-08-03, migrations 0052-0053)

**Modèle.** Table `automations` (tenant, nom, `enabled`, `trigger_kind`, `trigger_config` jsonb,
`condition_group` jsonb réutilisant le ConditionGroup du bloc « Si », scénario cible, bloc de départ
optionnel, `cooldown_seconds`) + `automation_fires` (une ligne par couple automation/contact, écrasée à chaque
tir) qui sert à la fois l'anti-rebond et le plafond horaire.

**Découpage.** `automation/match.ts` est PUR (correspondance déclencheur/événement, anti-rebond) donc testable
sans base. `automation/runner.ts` compose les filtres avec l'IO injectée. `automation/store.pg.ts` est le seul
à toucher Postgres. Le runner réutilise `WorkflowExecutor` tel quel, il hérite donc de ses gardes.

**Les filtres, dans l'ordre (du moins cher au plus cher).** Correspondance pure (aucune requête) → anti-rebond
par contact → plafond horaire par automation → `conditionGroup` (contexte contact chargé une seule fois, et
seulement s'il sert) → gardes de l'exécuteur (fil détenu, fenêtre 24 h). ⚠️ Le maillon « un seul parcours actif »
a disparu le 2026-09-07 : il ne BLOQUAIT plus rien, il est remplacé par une fermeture du parcours en cours dans
`runFrom`, et par la consommation du message côté webhook (le déclencheur gagne sur l'avance).

**Deux voies d'entrée.** Les événements issus d'un message entrant sont traités DANS le job webhook
(`webhooks/triggers.ts`, isolé comme ses voisins pour ne jamais mettre le job partagé en échec). Les autres
passent par la file `automation-event` : l'API pose un tag mais ne sait pas démarrer un scénario, c'est le
worker qui tient l'exécuteur. L'analyse de conversation, elle, émet en direct depuis le worker.

**Fenêtre de service.** Un déclencheur issu d'un message PROUVE que la fenêtre est ouverte : le scénario peut
alors ouvrir par un message de session. Un déclencheur à froid (tag, analyse) ne la prouve pas et garde la
protection : le scénario doit ouvrir par un template.

**Priorité du jeton de test.** `webhooks/test-token.ts` s'exécute AVANT l'avance de scénario et les
automations, et signale les messages qu'il a consommés pour qu'un seul message ne déclenche jamais deux choses.

**Ce qui borne les envois** : anti-rebond par contact (1 h par défaut), plafond par automation (200/h), un seul
parcours actif par contact, et l'émission gouvernée par le chemin (les campagnes n'émettent pas). Voir
`CLAUDE.md` pour les règles à ne pas casser.

**Déclencheur `hubspot_deal_stage` (2026-08-16, déployé).** Le connecteur mm-hubspot reçoit le webhook
`deal.propertyChange` de HubSpot, remonte deal -> contact -> téléphone, et pousse vers mba sur
`POST /hubspot/deal-stage` (signature v1 partagée). mba fait correspondre l'étape à une automation. La
correspondance porte sur l'IDENTIFIANT d'étape, jamais sur le libellé (un renommage côté HubSpot casserait
sinon l'automation en silence) ; le libellé n'est stocké que pour l'affichage. Le pipeline ne restreint que si
les DEUX côtés le portent : le webhook ne transporte pas le pipeline, et une étape appartient déjà à un seul
pipeline chez HubSpot.

`GET /tenants/:t/hubspot/deal-stages` (admin) rend les pipelines du portail avec les libellés de leurs étapes,
via le canal service signé (`POST /service/deal-stages` côté connecteur). Volontairement NON gardée par le
réglage « Campagnes via données HubSpot », qui gouverne l'import de contacts, un tout autre pouvoir. Portail
non lié -> `200 {connected:false}` ; une panne reste un 500. L'écran Automation la consomme dans un menu groupé
par pipeline, chargé PARESSEUSEMENT (à la sélection du déclencheur, une seule fois). ⚠️ Le garde-fou « déjà
demandé » y est une `useRef` et NON l'état de chargement : mettre ce dernier dans les dépendances de l'effet
le relançait, son nettoyage annulait la requête en vol, et l'écran restait figé sur « Lecture des étapes… ».
Trouvé par le test de bout en bout, invisible à la lecture.

## Visuels d'un template à l'envoi (en-tête média et cartes de carousel, 2026-08-17)

**La règle Meta.** Un template approuvé avec un en-tête IMAGE / VIDEO / DOCUMENT, ou avec un carousel, EXIGE son
média à CHAQUE envoi. Le visuel déposé à la création ne sert qu'à la validation. Sans lui : refus `132012` sur
TOUS les destinataires.

**D'où vient le visuel.** Du template lui-même (`example.header_handle[0]`, relu chez Meta), pas d'un champ
saisi. Donc aucune migration, aucun écran, aucune donnée par campagne, et ça marche sur les templates existants.

🔴 **Pourquoi un `media id` et jamais un `link`.** Mesuré le 2026-08-15 : envoyer l'URL du CDN de Meta est
ACCEPTÉ (200 + id de message) puis échoue 2 s plus tard en `131053`, son téléchargeur se prenant un 403 sur son
propre CDN. L'URL est pourtant lisible depuis n'importe où ailleurs, ce qui rend le piège invisible à une sonde
qui se contente de la lire. On re-téléverse donc le visuel sur le numéro d'envoi et on envoie son identifiant.
Vérifié en réel le 2026-08-17 : les deux destinataires de la campagne « Test Napo » sont passés en `delivered`,
sans erreur de livraison différée.

**Les briques, et il n'y en a qu'une de chaque.** `meta/template-media.ts` (`TemplateMediaPreparer`) prépare les
visuels, pour les cartes comme pour l'en-tête : `prepareOne` pour une URL, `prepare` pour un lot de cartes.
⚠️ La clé de son cache porte le NUMÉRO d'envoi, pas seulement l'URL : un `media id` est scopé au numéro qui l'a
téléversé, et un numéro reconnecté dans les 7 jours réutiliserait sinon l'identifiant de l'ancien. Le numéro est
résolu une fois par lot, pas une fois par carte. `meta/template-components.ts` reste le SEUL constructeur de
composants (`headerMediaId` prioritaire sur `headerMediaUrl`, `headerMediaSendBlocker` pour le refus lisible).

🔴 **Le piège de câblage, vécu DEUX fois.** `sendTemplate` (`workflow/wiring.ts`) a deux branches : variables
déjà résolues (campagne scénario) et résolution par hints (réponse webhook). Le carousel n'avait été branché que
sur l'une (incident du 2026-08-15), puis l'en-tête média a répété l'erreur sur l'autre (rattrapé en revue le
2026-08-17, avant déploiement). Les deux branches partagent désormais UN helper unique, `visuelsPourEnvoi` : la
divergence n'est plus possible. Ne pas la réintroduire en « optimisant » une branche.

**Le refus est AVANT la boucle** (`campaign/engine.ts`) : visuel impossible à préparer -> aucun destinataire ne
part, tous en `failed` avec la raison, campagne `completed`. Y passer dans la boucle ferait voir 100 % d'échecs
au quality gate, qui mettrait la campagne en pause avec un diagnostic trompeur.

**L'inbox reste en `link`** : le visuel y est une URL saisie par l'opérateur, elle se télécharge normalement.

## Capture automatique de l'OTP d'embarquement (Zadarma, 2026-08-16, précâblage)

**Le problème.** Pour embarquer son numéro WhatsApp, le client doit fournir un numéro puis saisir un code que
Meta lui dicte. On veut fournir le numéro ET capter le code. La popup d'Embedded Signup est un iframe d'un
autre domaine : la remplir automatiquement est IMPOSSIBLE. On ne la pilote donc pas, on la contourne, en
ajoutant et vérifiant le numéro par API (`MetaPhoneRegisterClient` : `phone_numbers` -> `request_code` en
VOICE et en français -> `verify_code`). L'activation Cloud API (`/register` + PIN) n'est PAS dupliquée ici,
elle vit dans `MetaEmbeddedSignupClient.register`.

**Les modules** (`src/zadarma/`, inertes tant que `ZADARMA_API_KEY`/`SECRET` sont vides ; la config refuse au
démarrage qu'une seule des deux moitiés soit posée) : `client.ts` (signature + transport), `api.ts` (numéros,
appels entrants, transcription), `otp-extract.ts` (le code depuis la transcription), `otp-capture.ts`
(orchestration). Tous testables sans réseau : l'IO est injectée.

**Partis pris à ne pas défaire.** `otp-extract` comprend le français PARLÉ (« douze trente-quatre
cinquante-six » = 123456), parce qu'un moteur français regroupe spontanément les chiffres par deux ; le
réduire aux chiffres écrits n'attraperait qu'un cas sur trois. Il applique l'unanimité ou rien : deux codes
différents dans la transcription rendent `null`, car Meta plafonne à 10 tentatives par numéro sur 72 h et un
code deviné en brûle une. `otp-capture` identifie l'appel par DIFFÉRENCE avec un instantané pris avant de
déclencher, jamais par l'heure (le fuseau du compte Zadarma n'est pas garanti), absorbe les erreurs passagères
(la tentative Meta est déjà consommée, la boucle EST le rejeu) et rend une cause distincte par maillon.

**Verdict d'architecture (sondage du 2026-08-16).** Le ROUTAGE est pilotable par API :
`PUT /v1/direct_numbers/set_sip_id/` accepte une adresse SIP EXTERNE, donc un client se provisionne en un
appel, sans clic. Le DÉCROCHÉ, non : Zadarma n'expose aucune commande « décroche », la machine qui répond doit
donc être à nous (ou son répondeur, dont on n'a pas confirmé qu'il produise un enregistrement exploitable).
⚠️ L'appel de Meta arrive quasi immédiatement après `request_code` : le routage doit être armé AVANT.

**Gotchas Zadarma mesurés en direct** (détail et suite dans le §Journal des lots livrés, plus bas) : signature = base64 du HMAC-SHA1
HEXADÉCIMAL (56 caractères) ; en écriture les paramètres vont dans le CORPS, URL nue. Les deux erreurs
produisent le même « 401 Not authorized » qui fait accuser des clés pourtant bonnes.

## Filtrage des clics automatiques (2026-08-21)

`src/links/clic-automatique.ts` décide si un appel sur `/r/:code` COMPTE. Il ne décide jamais de la
redirection, qui reste inconditionnelle : un lien déjà livré doit fonctionner pour tout le monde.

🔴 **Chaque marqueur d'agent porte son délimiteur** (`googlebot`, `curl/`, `okhttp/`, `java/`). Un marqueur
nu testé en sous-chaîne libre attrape de vrais appareils : « bot » seul écarte tous les téléphones **CUBOT**,
une marque Android vendue en Europe dont le modèle figure dans le user-agent. Le faux positif est le défaut
le plus grave ici, parce qu'il efface le clic d'un vrai client en silence et sans recours ; laisser passer un
robot exotique se voit et se corrige.

Un user-agent ABSENT ne disqualifie pas, pour la même raison. Trois signaux écartent : agent déclaré robot,
référent `*.facebook.com`, paramètre `fbclid`. Les deux derniers visent la revue de template, pendant
laquelle des humains de chez Meta ouvrent le bouton depuis Facebook avec un navigateur ordinaire.

## Pièges d'écriture des requêtes SQL

🔴 **Jamais de `backtick` dans un commentaire SQL.** Nos requetes vivent dans des gabarits JS delimites par
des backticks : un seul dans un commentaire `--` FERME la chaine, et tsc rend une cascade d erreurs de syntaxe
qui ne pointent pas sur la vraie ligne. Vu deux fois le 2026-08-21. Ecrire le mot sans le citer.

🔴 **Un `count` d agregat SANS `group by` rend TOUJOURS une ligne**, meme quand aucune ligne n entre. Une
requete censee distinguer « rien a mesurer » (aucune ligne) de « zero » rend donc zero dans les deux cas, et
l ecran affiche une etape qui ment. Ajouter un `group by` sur une colonne de la source : zero ligne en entree
donne alors zero ligne en sortie. C est exactement ce qui distingue `urlClicks: null` de `urlClicks: 0` dans
le funnel par campagne.

## Le lien de chaîne WhatsApp : la PHRASE route, plus le jeton (2026-09-07)

Le texte pré-rempli d'un bouton de post passe de `phrase (cm-ab12cd34)` à `phrase`. Demande de Julien (« on
garde juste le message »), qui répond du même coup à la longueur de l'URL `wa.me` : ce qui l'allongeait était
le suffixe, pas le domaine, et **c'est le domaine `wa.me` que WhatsApp reconnaît pour dessiner le bouton
« Discuter »**. Un raccourcisseur tiers l'aurait fait disparaître.

🔴 **CE QUI REND LA BASCULE POSSIBLE, et qui devait être vérifié avant d'écrire une ligne** : un post publié
ne peut plus être modifié, et il envoie `phrase (cm-xxxx)`. Le mode de comparaison de l'automation compagnon
est `contains`, donc ce vieux texte CONTIENT la phrase et son bouton continue de déclencher. En `equals`,
tous les posts en circulation auraient un bouton mort, sans recours. La preuve inverse est dans le test, pas
dans un commentaire (`tests/channels-me-jeton.test.ts`).

🔴 **LE PIÈGE DU MODE `contains`, trouvé en revue** : la collision n'est pas l'égalité des phrases, c'est
leur INCLUSION. « Je veux le guide » et « Je veux le guide 2026 » sont distinctes, et pourtant un appui sur
le second bouton déclenche LES DEUX scénarios, dont l'un clôt l'autre depuis le lot « le déclencheur gagne ».
La garde de création teste donc l'inclusion dans les deux sens. Ce cas n'existait pas avec le jeton : deux
jetons tirés ne s'incluent jamais.

⚠️ **Deux contrôles, deux portées, et c'est voulu.** L'index unique de la 0116 porte sur
`lower(btrim(phrase))` : il ignore la casse et les espaces, pas les accents (`unaccent` n'est pas installé et
n'est pas immuable, donc inutilisable dans une expression d'index). Il est donc plus PERMISSIF que la garde
applicative, qui emploie `normalizeText`, celle-là même qui décide de la correspondance. Il n'existe aucune
fenêtre où l'index refuserait ce que l'application accepte : c'est un filet de course, pas la définition.

**Contre une phrase trop banale, on COMPTE au lieu de deviner** : les messages entrants récents qui la
contiennent déjà, en écartant ceux qui portent un jeton (ce sont des clics, pas de la conversation). Aucun
seuil de longueur n'a été inventé ; le danger n'est pas d'être courte, c'est d'apparaître dans la
conversation ordinaire. ⚠️ La comparaison SQL est un `strpos`, pas un `like` : un `like` prend `%` et `_`
pour des jokers, et « Je veux mes -20% » aurait fait refuser la phrase d'un client sur un compte faux.

⚠️ **Le champ `token` existe toujours** : identifiant unique du lien, et il vit dans les posts publiés. Il ne
déclenche plus rien. Le commentaire de `db/migrations/0114_channelsme.sql` qui le décrit comme « ce que
l'automation cherche en `contains` » est donc devenu faux ; on ne réédite pas une migration appliquée, c'est
cette entrée-ci qui fait foi.

## 🔴 Changer la NATURE d'une entrée de nav casse ses appelants, comme un changement de signature (2026-09-08)

« Other AI agent » est passé d'une ENTRÉE-LIEN à un GROUPE dépliable (il porte désormais Agents et Crédit).
Aucune adresse n'a changé, le menu s'affiche, le typecheck passe, les trois specs de navigation passent. Et
pourtant `agents-fiche.spec.ts` est tombé en CI : il cliquait `getByRole('link', { name: 'Other AI agent' })`,
qui n'existe plus, parce qu'un groupe est un BOUTON.

**La règle :** dans `NavEntree`, `href` et `children` s'excluent, donc passer de l'un à l'autre change le
RÔLE ARIA rendu. Tout ce qui visait l'entrée par son rôle vise désormais le mauvais. Avant de regrouper une
entrée, chercher son libellé dans `web/e2e/` : c'est le seul endroit où l'ancien rôle est écrit en toutes
lettres, et rien dans le type ne relie les deux fichiers.

⚠️ Le correctif garde le CAS, jamais seulement l'assertion : le test vérifiait « la nav mène à l'écran », il
le vérifie toujours, avec un cran de plus dans le chemin.

⚠️ **`inbox-envoi-scenario.spec.ts` est INSTABLE SOUS CHARGE, et il a été quantifié plutôt que soupçonné**
(2026-09-08). Il est tombé deux fois dans une suite complète à 4 workers pendant que d'autres travaux
tournaient sur la même machine, toujours sur l'ouverture du panneau (`inbox-open-scenario` ->
`scenario-select`). Mesure : **15 exécutions isolées, 15 succès** (trois passes de cinq). Le fichier n'est
donc pas en cause, la contention l'est, et le `workers: 4` de la configuration porte déjà ce commentaire.
La CI, elle, a `retries: 1` et des ressources dédiées. **À ne pas affaiblir** : le jour où il tombe en CI,
c'est un vrai défaut.

## Modules partagés (audit anti-slop du 2026-08-18)

Points de passage OBLIGÉS. Chacun existe parce que la même chose était écrite plusieurs fois et avait commencé
à diverger : le rapport complet est dans `AUDIT-ANTI-SLOP-2026-08-18.md`. Avant d'écrire un helper, chercher ici.

**Backend**

| Module | Ce qu'il porte | Ce qu'il remplaçait |
|---|---|---|
| `src/http/scope.ts` | `scopeTenant` (contrôle d'accès tenant) et `nonEmpty` | 22 et 12 copies dans `src/http/` |
| `src/crm/contact-store.pg.ts` -> `MATCH_BY_WAID_SQL` | Résolution d'un contact par `wa_id` (E.164 exact, chiffres nus, BSUID) | 9 copies + 1 dans `inbox/store.pg` |
| `src/stats/range.ts` -> `BOUNDS_CTE` | CTE des bornes de date, robuste au changement d'heure | 9 copies dans les 2 stores de stats |
| `src/stats/store.pg.ts` -> `envoisTemplateFacturables()` | Les envois de template facturables d'une période (campagnes + hors campagne), et l'attribution d'un envoi de scénario à sa campagne | 2 requêtes qui comptaient deux populations DIFFÉRENTES : le coût estimé ratait les envois de scénario, le détail par template les comptait. Un template réellement envoyé rendait un graphe vide (mesuré le 2026-09-07). L'attribution est un PARAMÈTRE : elle est corrélée et sans index, le détail par template ne doit pas la payer pour une colonne qu'il jette. |
| `src/campaign/store.pg.ts` -> `insertCampaignRow`, `summarySelect()` | L'INSERT d'une campagne et la projection des résumés | 2 INSERT, 2 projections |
| `src/campaign/echecs-sql.ts` -> `RECIPIENT_FAILED_SQL`, `INSTANT_ECHEC_SQL` | 🔴 La POPULATION d'un échec d'envoi (`status` OU `delivery_status`) et sa DATE. Quatre requêtes répondent à « qu'est-ce qui a échoué ? » : compteurs de campagne, auto-relance, journal d'exploitation, statistiques | le prédicat était écrit dans `campaign/store.pg.ts` et RECOPIÉ dans `ops/erreurs-livraison.pg.ts` ; l'ancrage existait en deux versions, et la plus courte rendait une date nulle pour 24 échecs sur 25 (mesuré en production le 2026-09-07). Écrit une fois, les quatre lecteurs l'importent |
| `src/crm/contact-filters.ts` | Règles de filtrage des contacts (bornes, opérateurs, plafonds) | query params et corps JSON, alignés à la main |
| `src/webhooks/json.ts` | `asArray`, `asRecord` (lecture défensive d'un payload Meta) | 3 copies. ⚠️ `str` reste LOCAL (null vs undefined selon le lecteur) |
| `src/crm/identity.ts` -> `waIdOfTarget` | La règle wa_id pour une cible d'envoi | redérivée dans le moteur de campagne |
| `src/account/types.ts` | Types de persistance du compte | ils vivaient dans la couche HTTP, que le store importait |
| `src/agent/llm/tool-schema.ts` -> `paramsOutil` | 🔴 La lecture de `agent_tools.params` et la séparation des sources (`modele` vs `contact`/`fixe`). Source UNIQUE : l'exposition au modèle, la validation des arguments et l'injection du runtime en dérivent toutes | posé en tâche 16. Deux lectures divergentes rendraient la cible au modèle, donc un IDOR. Les résolveurs `http` et `mcp` doivent l'importer, jamais relire `params` |
| `src/lib/page-distante.ts` | 🔴 `urlRecuperable` (garde SSRF) et `fetchUrlBorne` (redirections revalidées saut par saut, plafond de taille vérifié APRÈS lecture). Deux surfaces font lire au serveur une adresse SAISIE PAR UN CLIENT (import de FAQ de l'agent Meta, import de connaissance d'un agent IA), et le serveur voit l'admin NPM, les autres conteneurs et le service de métadonnées du VPS | vivait dans `src/http/mba.ts` ; une seconde copie qui divergerait ouvrirait un lecteur de l'intérieur du réseau au premier oubli |
| `src/http/scope.ts` -> `estUuid` | La forme d'un identifiant de chemin. Une valeur mal formée ne rend pas zéro ligne dans un `where` sur une colonne `uuid` : elle fait LEVER Postgres (22P02), donc un 500 dont Cloudflare remplace le corps | posé en tâche 19b, sur les routes d'agents et de connaissance |
| `src/agent/fiche.ts` -> `ficheAgentSchema` / `fichePatchSchema` | 🔴 Les DEUX schémas de la fiche, construits sur des champs communs. Le premier LIT (défauts appliqués), le second PATCHE (optionnel SANS défaut) | posé en tâche 19d. `ficheAgentSchema.partial()` NE rend PAS un objet partiel : le `.default()` survit au `.partial()`, la fusion jsonb n'a alors plus aucune clé absente à protéger, et enregistrer l'objectif efface le ton et toutes les règles d'arrêt. Un patch de fiche importe TOUJOURS `fichePatchSchema` |
| `src/agent/setup/proposition.ts` | 🔴 Ce que l'IA de construction a le DROIT de proposer, et le diff. Frontière de sécurité : la fiche et les mots des outils, jamais la mention légale d'IA, les plafonds, le modèle, le risque d'un outil ni son activation | posé en tâche 19d. L'assistant lit du contenu tiers (le site du client) : ce qu'il peut écrire est énuméré là et nulle part ailleurs |
| `src/agent/poser-tag.ts` | 🔴 Les TROIS effets de « poser un tag » depuis un agent : le contact, le référentiel Tags, et la file d'automations, cette dernière SEULEMENT si le tag était nouveau | posé en tâche 20, après que l'outil eut menti : il posait le tag et s'arrêtait là, alors que sa description promet au client de pouvoir déclencher une automation |
| `src/agent/contexte.ts` -> `lireContexteAgent` | Ce que le cerveau doit savoir d'un agent (fiche, règles d'arrêt, outils actifs, politique de contact inconnu) | posé en tâche 20. Le tour de production et le bac à sable de la console le construisaient chacun le leur : un champ ajouté d'un seul côté ferait diverger ce que le modèle voit selon qu'on teste ou qu'on est en production |
| `src/lib/http-get.ts` -> `HttpGet`, `fetchGet` | Une lecture HTTP GET injectable, testable sans réseau. `HttpTransport` (`src/meta/http.ts`) ne fait que du POST | née dans `src/rcs/channel-info.ts` ; remontée ici le 2026-09-09 quand le catalogue de modèles du Gateway en a eu besoin. La recopier aurait donné deux GET qui traitent différemment un corps non-JSON. ⚠️ Aucune échéance par défaut : l'appelant qui sert une requête d'un utilisateur DOIT passer un `signal` |
| `src/agent/modeles.ts` -> `MODELES_CHOISIS`, `prixParMillion`, `modelesProposables` | 🔴 Les dix modèles proposables et leur tarif client. Le MENU de la console et la GARDE d'écriture de la route lisent le même ensemble : deux listes proposeraient un modèle que le serveur refuserait d'enregistrer. `prixParMillion` porte les trois multiplications (dollars/jeton -> par million -> euros -> commission) | posé le 2026-09-09. Le champ était une saisie libre : un identifiant mal tapé s'enregistrait et ne se voyait qu'au premier message d'un client. ⚠️ Un prix inconnu rend `null`, jamais 0 : « gratuit » est une affirmation, et elle serait fausse |
| `src/agent/brain.gateway.ts` -> `penserTrace` | 🔴 LA boucle de raisonnement d'un agent : appel du modèle, exécution des outils, arrêt. Elle est l'APPELANT d'`executeTool`, et porte les trois responsabilités que sa JSDoc lui assignait (alerte sur `fatal`, plafonds recalculés À CHAQUE appel, résultat encadré en bloc délimité) | posée en tâche 19e, ferme la dette D3. Le bac à sable et le futur tour de production partagent cette boucle : un bac à sable qui n'exercerait pas le vrai chemin ne testerait rien |
| `src/agent/prompt.ts` | 🔴 Le prompt système d'un agent (mention légale d'IA EN TÊTE, jamais absente) et `blocResultatOutil`, qui encadre ce qu'un outil rend avant de le remettre au modèle | posé en tâche 19e. Un résultat d'outil concaténé au prompt est une injection indirecte : le contenu vient d'une base de connaissance qu'un site tiers a remplie |
| `src/agent/outils-maison.ts` | 🔴 Le CATALOGUE des outils maison (handler, mots, paramètres, risque) et `outilExpose`, qui construit ce que le modèle voit. C'est ici, et nulle part ailleurs, que l'énumération du paramètre `sortie` de `terminer` est posée, DÉRIVÉE de `agents.fiche.sorties` | posé en tâche 19c. La console ne peut pas inventer un `handler` (l'outil serait actif et refuserait à chaque appel), et recopier les codes de sortie dans `agent_tools.params` créerait une seconde vérité qui divergerait au premier ajout de règle |
| `src/agent/http-cible.ts` -> `construireCible` | 🔴 L'URL FINALE d'un appel de connecteur (lot L2), et le risque qu'une méthode porte. Quatre gardes : adresse de base publique et HTTPS, valeurs de paramètres ENCODÉES, cible qui reste SOUS l'adresse de base (segment par segment), paramètre manquant = refus. Le serveur vit dans le réseau Docker du VPS : une adresse mal contrôlée fait d'un connecteur un lecteur de l'intérieur, et une valeur mal encodée fait d'un gabarit un IDOR | posé en tâche L2-3. La MÊME fonction sert la validation À L'ÉCRITURE d'une source (`src/http/agent-sources.ts`) : deux définitions de « adresse acceptable » finiraient par accepter à l'écriture ce que l'appel refuse |
| `src/agent/champs-contact.ts` -> `CHAMPS_CONTACT_AUTORISES` | 🔴 Les seuls champs du contact dont un paramètre d'outil peut dériver. Liste FERMÉE : la projection du contact peut s'élargir, la surface offerte à un connecteur ne doit pas suivre toute seule | posé en tâche L2-4bis. `wa_id` y est mais ne vient PAS de la projection (qui ne le porte pas, exprès) : il vient du contexte du TOUR, authentifié par la signature du webhook Meta |
| `src/agent/devise.ts` -> `microEurosDepuisDollars` / `eurosDepuisMicro` | 🔴 La conversion du coût d'un appel de modèle, en UN endroit. Le Gateway facture en DOLLARS, tous nos compteurs et tous nos plafonds sont en micro-euros. Le taux est un paramètre COMMERCIAL (`EUR_PER_USD`), pas un cours | posé en tâche 21, ferme la dette D1. Un taux absent ou aberrant retombe sur 1, JAMAIS sur zéro : un zéro rendrait toute consommation gratuite, donc désarmerait tous les plafonds en silence. `web/lib/agent-solde.ts` en porte le miroir d'affichage, dont `tests/agent-devise.test.ts` ancre la parité |
| `src/agent/brain.ts` -> `TourInterrompu` | 🔴 Le contrat « un cerveau qui lève APRÈS avoir dépensé porte sa consommation dans l'erreur ». Ses deux appelants (le tour de production, le bac à sable) l'enregistrent avant de traiter l'échec | posé en tâche 21. Un tour fait plusieurs allers-retours facturés séparément : le cumul vivait DANS la boucle, donc une exception au deuxième appel emportait ce que le premier avait déjà coûté. **Un compteur de dépense ne vit jamais dans la portée qui peut lever** |
| `src/workflow/executor.ts` -> `runEnAttenteSur` | « Le run en attente d'un contact ET le bloc qui l'attend, s'il est du type demandé » | 3 copies (reprises RCS, sortie d'agent, outil d'agent) |
| `src/lib/cache-court.ts` -> `cacheCourt` | Le micro-cache mémoire à durée de vie courte : durée de vie ET mutualisation des appels EN VOL, plus la garde d'identité qui empêche une valeur périmée de se ranger en cache après une invalidation. Posé en R7 pour les compteurs de l'inbox | posé le 2026-08-31. Un cache de compteur écrit à la main oublie l'un des trois, et devient le bug qu'il évitait |
| `src/crm/import.ts` -> `ContactStore.upsertManyByPhone` | L'écriture d'un LOT de contacts (import CSV, listes HubSpot). L'upsert unitaire n'est plus le chemin d'import : une requête par ligne dépassait le timeout de Cloudflare | posé en R9. La déduplication du lot est DANS le store, pas chez l'appelant : c'est Postgres qui l'exige |
| `src/lib/wa-me.ts` -> `lienWaMe` | Le lien `wa.me` pré-rempli : chiffres seuls dans le numéro, texte encodé, null quand aucun numéro n'est connecté | vivait dans `src/workflow/test-token.ts` (`waMeTestLink`), qui n'a rien à voir avec la chaîne WhatsApp mais en portait la seule copie. Une seconde copie enverrait des abonnés sur un lien mort depuis un post DÉJÀ publié |
| `src/lib/jeton-aleatoire.ts` -> `chaineAleatoire` | 🔴 Le tirage aléatoire commun à `nouveauJeton` (`src/channels-me/jeton.ts`) et `newTestToken` (`src/workflow/test-token.ts`) : un octet tiré par caractère (`randomBytes`), modulo la taille de l'alphabet. Sans biais SEULEMENT parce que 256 (les valeurs d'un octet) est un multiple exact de la taille de l'alphabet Crockford des deux appelants (32) ; `tests/lib-jeton-aleatoire.test.ts` fige cette précondition | les deux générateurs de jeton copiaient le même alphabet et la même boucle avant cette extraction (2026-09-04). Deux copies identiques finissent toujours par diverger |

**Front**

| Module | Ce qu'il porte |
|---|---|
| `web/lib/ui.ts` | `inputCls` et `inputClsAuto` (sans `w-full`). Une variante s'écrit `${inputCls} py-1.5`, ne se recopie pas |
| `web/lib/normalize.ts` | `normalizeText` (minuscules, sans accents, espaces resserrés) |
| `web/lib/fields.ts` | `fieldValue` (champ perso, casse insensible) et `varCountOf` (variables `{{n}}` distinctes) |
| `web/components/Toggle.tsx` | L'interrupteur on/off de l'Accueil |
| `web/lib/poll.ts` | `repeterAvecGigue` : la répétition périodique DÉSYNCHRONISÉE (±20 %). Tout nouveau polling passe par là, jamais par `setInterval` : sinon les onglets d'un même client rebattent ensemble |
| `web/lib/csv.ts` -> `teteCsv` | La TÊTE d'un fichier envoyée à l'aperçu d'import (coupée sur une fin de ligne). Un aperçu qui transmet le fichier entier fait tomber le mur du volume au choix du fichier |
| `web/components/PhoneFrame.tsx` | Le chrome « fenêtre WhatsApp » des aperçus |
| `web/components/CampaignCreateForm.tsx` | L'assistant de création de campagne (extrait de la page, qui passait de 1637 à 486 lignes) |
| `web/lib/workflow-sorties.ts` | 🔴 La SORTIE LIBRE d'un bloc (« toute autre réponse ») : nommée `libre` dans le canevas, et RIEN dans le graphe enregistré (contrat du moteur, `nextNodeSansHandle`). Traduction aux deux bords, plus `uneAreteParSortie`. Sans nom de poignée, React Flow ancrait cette flèche sur la PREMIÈRE sortie du bloc : elle se dessinait sur la ligne de la première réponse rapide, où une autre flèche part déjà (mesuré le 2026-08-28). Un patch d'arête du canevas passe TOUJOURS par ces deux fonctions |
| `web/components/SelecteurEmojis.tsx` | 🔴 LA grille d'emojis des composeurs de message (liste `lib/emojis.ts`, panneau `Flottant`), et elle se FERME après un choix. La liste était déjà partagée ; la grille, elle, était recopiée dans `TemplateBodyField` et `ChampCorpsVariables`, et les deux copies avaient déjà divergé sur la fermeture, chacune documentant l'autre comme fautive. Le composeur de chaîne allait être la troisième |
| `web/components/ListeManques.tsx` | 🔴 « Voilà ce qui manque » : pourquoi un bouton de validation reste grisé, À L'ÉCRAN et pas dans une infobulle `title` qu'il faut survoler à la souris. Il ne débloque RIEN, il rend la raison visible. Écrit d'abord pour `FlowBuilder` seul, alors que `TemplateForm` et `CarouselForm` avaient le même cul-de-sac muet |
| `web/components/ChampImageHebergee.tsx` | 🔴 Une image que la console HÉBERGE, et dont elle rend l'adresse publique (bouton fichier + champ URL conservé pour qui a déjà son CDN). Ni un message RCS ni un post de chaîne ne TRANSPORTENT l'image : ils transportent son adresse, que l'opérateur ou le fournisseur va chercher. Il s'appelait `RcsImageField` ; le reste du chemin garde son nom RCS (`uploadRcsMedia`, `POST /rcs/media`, table `rcs_media`, service public `GET /m/`), parce que `/m/` sert des adresses déjà parties dans des messages livrés, donc c'est une porte à SENS UNIQUE |
| `web/lib/chaine-apercu.ts` -> `corpsDuPost` | 🔴 Le CORPS d'un post déjà publié, sans l'adresse `wa.me` que le serveur lui a collée (`corps` + deux sauts de ligne + adresse). L'aperçu ne met en forme que le corps, qu'il reçoit séparément : donner le texte STOCKÉ entier au formateur n'est donc pas « le même rendu », c'est un autre traitement sur une autre entrée, et la longueur de l'adresse entre alors dans le plafond d'analyse |
| `web/components/TexteMisEnForme.tsx` | 🔴 LE rendu du balisage WhatsApp (`*gras*`, `_italique_`, `~barré~`, et le monospace en option), découpage dans le module pur `lib/chaine-mise-en-forme.ts`. Il sert l'aperçu de la chaîne, sa liste de publications ET l'aperçu des templates. Deux divergences fermées : la liste montrait les marqueurs bruts sous un aperçu qui les rendait ; et `WhatsAppPreview` portait son PROPRE analyseur, une expression régulière sans règle de bordure de mot, qui italisait le souligné du milieu d'une adresse dans l'aperçu d'un corps de template partant chez Meta. ⚠️ `mono` n'est activé que sur les templates, qui le rendaient déjà : la syntaxe monospace de WhatsApp est le TRIPLE accent grave, pas le simple, donc l'activer partout promettrait un style que le téléphone n'appliquera peut-être pas |

🔴 **REMPLACER UN BLOC PAR UN COMPOSANT PARTAGÉ CHANGE SA CONDITION D'AFFICHAGE, et c'est invisible du
compilateur** (2026-09-07). `FlowBuilder` affichait ses manques sur `!canSubmit && !busy` : le bloc
apparaissait dès que le bouton était grisé, quelle que soit la cause. `ListeManques` s'affiche sur
`manques.length > 0`. Porter quatre des SEPT conditions de `canSubmit` dans la nouvelle liste a donc rendu
le bouton MUET sur les trois autres, dans le composant même où le remède avait été écrit, et aucun test de
comportement ne pouvait le voir (le bloc s'affichait toujours pour les quatre cas couverts).
`web/lib/manques-cablage.test.ts` lit la source et compare les identifiants de `canSubmit` à ceux du bloc :
c'est le seul angle d'où le trou est visible. **Toute condition ajoutée à un `canSubmit` doit gagner sa
ligne dans les manques**, sinon elle ramène le cul-de-sac que ces écrans existent pour fermer.

⚠️ **Un composant React se déclare au niveau MODULE, jamais dans le corps d'un autre composant.** Sa fonction
change alors d'identité à chaque rendu, donc React démonte et remonte le sous-arbre : une modale ouverte perd
son état. Vu en prod sur le panneau « lancer un scénario » de l'inbox, où l'arrivée d'un message effaçait la
sélection en cours (corrigé le 2026-08-18, test E2E `inbox-envoi-scenario.spec.ts`).

⚠️ **Deux styles de fin de ligne cohabitent dans ce repo** (LF et CRLF selon les fichiers). Un script de
refactor par expression régulière qui n'attend que `
` rate silencieusement les fichiers CRLF : toujours
`
?
`, et vérifier le compte de remplacements.

## Channels Me : `media_url` est ENVOYÉ mais N'EST PAS SIGNÉ (mesuré le 2026-09-08)

🔴 **Toute publication de chaîne AVEC IMAGE échouait, depuis toujours.** Le fournisseur rendait
`401 Bad Authorization or X-Signature header`, et la console répondait « Channels Me a refusé la publication,
vérifie le texte et l'image » : on envoyait donc le client chercher un défaut inexistant dans SON contenu,
alors que le refus portait sur NOTRE signature.

**Ce qui a tranché, ce sont trois sondes**, avec le vrai `kind` et sur des brouillons (invisibles des
abonnés, et rien n'a été créé), en exploitant la propriété que la spec documente : l'authentification passe
AVANT la validation, donc une signature fausse rend 401 et une signature juste rend autre chose.

| corps envoyé | signature calculée sur | verdict |
|---|---|---|
| texte seul | tout | authentification OK |
| texte + `media_url` | tout | **401** |
| texte + `media_url` | tout SAUF `media_url` | authentification OK |

Une sonde de contrôle a montré qu'une clé **inconnue quelconque** casse aussi la signature : leur
vérification porte sur les paramètres qu'ils RETIENNENT, pas sur le corps brut. Leur documentation ne l'écrit
que pour le multipart (« the signature should be computed with the `media_checksum` and the `media`
parameter should be ommited ») ; `media_url` suit la même règle sans que rien ne le dise.

**Le remède** vit dans `CHAMPS_HORS_SIGNATURE` et `corpsASigner` (`src/channels-me/signature.ts`), en UN
endroit : le corps part entier, la signature porte sur ce corps privé de ces champs. ⚠️ `media_checksum`
n'y est PAS, leur spec disant explicitement de signer AVEC lui.

🔴 **LA LEÇON, ET ELLE EST PLUS CHÈRE QUE LE BUG : un test vert verrouillait le défaut.**
`tests/channels-me-client.test.ts` exigeait `signer(corps_envoyé) === X-Signature` pour le cas de l'image.
Il recopiait l'invariant du module (« ce qu'on signe EST ce qu'on transmet »), invariant juste partout
ailleurs et jamais MESURÉ pour ce cas-là. Un test qui recopie l'hypothèse du code ne la vérifie pas, il
l'immunise, et il donne la confiance qui empêche d'aller mesurer.

⚠️ **Autre chose apprise au passage : leur serveur VA CHERCHER `media_url` pendant l'appel.** Une adresse
qu'il ne peut pas récupérer rend `500 Down::NotFound`. Nos images sont servies par `GET /m/:fichier`, et ce
chemin doit rester joignable publiquement, sans authentification : vérifié le 2026-09-08 sur les deux hôtes.

## Le connecteur API d'un client (lot L2, livré le 2026-08-28)

Une **source** (`agent_tool_sources`, migration 0088) porte l'adresse de base du système d'un client, son mode
d'authentification et son secret chiffré. Elle appartient au **workspace** (`tenant_id`, jamais `agent_id`) et
se déclare dans **Tools > Connecteurs API** (`/connecteurs`) : plusieurs agents tapent dans la même
bibliothèque. La placer dans un agent ferait croire qu'elle lui appartient, et on la supprimerait en cassant
les autres ; l'écran affiche donc combien d'agents s'en servent. Un **outil de connecteur** (`agent_tools` avec `origin = 'http'` et
`source_id`) est un gabarit de chemin sur cette source. Le résolveur `http` fait l'appel ; tout le reste (la
validation des arguments, l'injection des paramètres non confiés au modèle, le budget de temps, le journal, la
troncature) reste le tronc commun, exactement comme pour un outil maison.

🔴 **Quatre gardes, et chacune répond à une façon précise de perdre.**

1. **Le modèle ne choisit jamais une cible.** L'adresse est figée sur la source, le gabarit est écrit par un
   administrateur, et `construireCible` vérifie que l'URL finale reste SOUS l'adresse de base, segment par
   segment, après encodage des valeurs. Une valeur contenant `/` ou `..` ne change donc pas de chemin.
2. **Le `wa_id` vient du TOUR, pas de la projection du contact.** C'est ce qui permet de brancher une API par
   contact (« où en est MA commande ») sans que le modèle puisse désigner quelqu'un d'autre. La projection est
   bornée exprès et ne porte pas le numéro : elle part chez le fournisseur de modèle.
3. **Le risque est DÉRIVÉ de la méthode HTTP** (`GET` -> read, `POST`/`PUT`/`PATCH` -> write, `DELETE` ->
   irréversible) et ne peut être que MONTÉ. Un client qui déclarerait `read` un `DELETE` désarmerait la garde
   d'autonomie sur une action irréversible.
4. **Le filtre de sortie est obligatoire.** La réponse appartient au client et part chez le fournisseur de
   modèle : `outputPaths` dit ce que l'agent a le droit de lire, et rien d'autre ne traverse. Sur un outil
   maison, c'est nous qui écrivons la réponse ; ici, non.

⚠️ **CE QUE LA GARDE D'ADRESSE NE COUVRE PAS : le DNS rebinding.** `urlRecuperable` valide le NOM D'HÔTE, pas
l'adresse IP finalement résolue. Un administrateur de tenant peut donc déclarer un domaine à lui, passer la
validation à l'écriture, puis repointer son DNS vers `172.18.0.1` ou `169.254.169.254` : l'appel suivant
résoudrait la nouvelle adresse. La différence avec le scraper de connaissance, qui porte le même trou, est la
CONSÉQUENCE : ici la réponse peut repartir vers un contact WhatsApp par `outputPaths`. Le pare-feu de l'hôte
ne protège pas ce chemin (le trafic reste dans le réseau Docker, il ne traverse jamais `ens3`). La fermeture
demande de revalider l'IP résolue juste avant l'appel (dispatcher undici) : c'est dans `todo.md`, et c'est un
risque d'ADMINISTRATEUR, pas de contact.

⚠️ **`redirect: 'error'`, contrairement au scraper de connaissance.** Une page publique redirige légitimement,
une API de connecteur non : suivre la redirection rouvrirait la porte que la garde d'URL vient de fermer, le
premier saut étant validé et le second pas.

⚠️ **Le bac à sable SIMULE un connecteur.** Un essai depuis la console ne doit pas taper sur le système de
production d'un client, même en lecture : il consommerait son quota, apparaîtrait dans ses journaux, et un
connecteur mal déclaré (un `DELETE` là où le client voulait un `GET`) ferait un dégât réel pendant qu'on croit
essayer.

⚠️ **L'assistant de construction peut réécrire les MOTS d'un connecteur, jamais en créer un.** Déclarer une
source, c'est écrire une adresse réseau et un secret : cela reste un geste d'administrateur, et le serveur
filtre les noms inconnus avant même que la proposition n'atteigne l'écran.

## Banc de tool calling : le choix des deux modèles de l'agent (mesuré le 2026-08-28)

🔴 **DEUX MÉTIERS, DEUX MODÈLES, et les confondre coûte cher.** L'assistant de CONSTRUCTION tourne rarement
(réglage d'un agent) et fait le travail le plus dur : une sortie structurée imbriquée (objet + tableau d'objets
+ enum), en français, en appel d'outil FORCÉ. Le modèle d'un AGENT tourne à CHAQUE message d'un contact : il
lui faut un appel d'outil fiable en boucle, la reprise fidèle de ce que l'outil a rendu, et le prix au tour.

Banc joué contre le Gateway avec **notre propre schéma** (`SCHEMA_PROPOSITION` pour la construction, la vraie
boucle `chercher_connaissance` -> résultat d'outil -> réponse pour le runtime), 5 répétitions par modèle sur le
runtime, 4 sur la construction.

| Modèle | Construction (conforme) | Boucle d'outil | Reprend le fait | N'invente rien sans source | $/tour | ms |
|---|---|---|---|---|---|---|
| `zai/glm-4.7` | **4/4**, avec sorties ET outils | - | - | 0,00097 | 2865 |
| `deepseek/deepseek-v4-pro` | 4/4, jamais d'outil proposé | 5/5 | 5/5 | 5/5 | 0,000425 | 4563 |
| `zai/glm-4.7-flash` | 0/1 (aucune sortie) | **5/5** | **5/5** | **5/5** | **0,000084** | **2177** |
| `alibaba/qwen3.7-flash` | 1/4 | 5/5 | 5/5 | 5/5 | 0,000104 | 4477 |
| `deepseek/deepseek-v4-flash` | 2/4 | 5/5 | 5/5 | 5/5 | 0,000161 | 3409 |
| `minimax/minimax-m3` | 4/4 | 5/5 | **4/5** | 5/5 | 0,000283 | 2620 |
| `moonshotai/kimi-k2.5` | 0/1 (aucune sortie) | 5/5 | **3/5** | 5/5 | 0,000697 | 4834 |

**Retenu : `zai/glm-4.7` pour la construction, `zai/glm-4.7-flash` pour le runtime.** Le second est le moins
cher ET le plus rapide du banc, sans une seule faute sur 15 épreuves. Les deux modes d'échec qui écartent les
autres sont exactement ceux qui abîment une conversation client : **kimi-k2.5 perd le fait qu'il vient de lire
2 fois sur 5** (une fois en rendant un texte VIDE), et **minimax-m3 répond « je ne trouve pas les horaires »
alors que l'outil venait de les lui rendre**. Un modèle qui contredit sa propre source est pire qu'un modèle
lent.

⚠️ **Ce banc se rejoue.** Le catalogue du Gateway bouge toutes les semaines, et un modèle qu'on ajoute doit
passer ces deux épreuves AVANT d'entrer dans le catalogue de la console. C'est le « banc » annoncé au §
« Ce qui reste ouvert » du document produit.

## Agent IA (migrations 0086 à 0088)

Un **agent** est un bloc de scénario qui tient une conversation seul, avec des outils, jusqu'à une SORTIE
nommée qui rend la main au parcours. Il n'a rien à voir avec le rôle utilisateur « agent », ni avec le
Meta Business Agent (`src/mba/`), qui est un produit de Meta.

### Le schéma (0086)

- `agents` : la **fiche** (`fiche jsonb` : objectif, nom, ton, personnalité, règles de transfert et d'arrêt,
  écrite par l'IA de construction et validée par `ficheAgentSchema`) et, HORS du jsonb parce qu'aucune IA ne
  doit y toucher : `mention_ia` (la mention légale), `max_tours`, `max_appels_outils`, `budget_micro_eur`,
  `inactivite_minutes`, `contact_inconnu` (`aucun_outil` | `lecture_seule` | `tous`), `modele`, `status`
  (draft | active | disabled). Unique sur `(tenant_id, lower(label))`.
- `agent_tools` : le catalogue par agent. `origin` ∈ `mba` (outil maison) | `http` (connecteur) | `mcp`
  (déclaré, non servi). `name` contraint au charset commun OpenAI/Gemini, `params jsonb`, `output_paths`,
  `risk` ∈ read | write | irreversible, `timeout_ms`, `max_bytes`.
  🔴 **Deux CHECK portent le consentement humain EN BASE** : `actif = false or active_par is not null`, et
  `autonome = false or autonome_par is not null`. La spec MCP exige un consentement humain avant invocation ;
  notre agent n'a aucun humain au runtime, donc le consentement est déplacé du runtime vers la CONFIGURATION,
  et rendu incontournable par la base plutôt que par une convention.
- `agent_sessions` : l'état multi-tours d'une conversation (`transcript jsonb`, `tours`, `appels_outils`,
  `tokens_in`/`out`, `cout_micro_eur`, `status` ∈ en_cours | sortie | inactivite | plafond | erreur, `sortie`).
  **Un index unique partiel `(run_id) where status = 'en_cours'`** : une seule session vivante par parcours,
  l'invariant est en base.
- `agent_tool_calls` : le journal d'appels (`args_rediges`, `status` ∈ ok | erreur_outil | refuse | timeout |
  erreur_protocole | budget, `http_status`, `duree_ms`, `taille_reponse`).
- `agent_knowledge` : la base de connaissance par agent. Recherche **plein texte native** (`corps_tsv`
  générée, `to_tsvector('french'::regconfig, ...)`, GIN) plus pg_trgm sur le titre. **Pas de pgvector.**
  ⚠️ Le cast `::regconfig` est obligatoire : la surcharge à config texte de `to_tsvector` n'est que STABLE et
  serait refusée dans une colonne générée. Un btree `(tenant_id, agent_id)` vient EN TÊTE de chaque recherche,
  sans quoi le planificateur n'a que les GIN et remonte puis jette les lignes des autres clients.
- `agent_credits` / `agent_credit_mouvements` (0087) : le **solde prépayé par workspace**, en micro-euros,
  `bigint` SIGNÉ : un solde peut finir légèrement négatif, et c'est voulu, un tour déjà joué a déjà coûté.
  La garde est à l'ENTRÉE du tour (solde épuisé -> on ne démarre pas), jamais à l'écriture. Le journal porte
  `delta_micro_eur` (négatif = conso, positif = recharge), `raison`, `session_id` en `set null` (la trace
  comptable survit à la purge RGPD des conversations à 30 jours) et une `note` obligatoire sur les recharges.
- `agent_tool_sources` (0088) : cf « Le connecteur API d'un client ».

### La chaîne d'exécution

`src/agent/` : `brain.gateway.ts` (`penserTrace`, LA boucle de raisonnement, partagée par le tour de
production et le bac à sable), `prompt.ts` (mention légale d'IA EN TÊTE, `blocResultatOutil` qui encadre un
résultat d'outil, parce qu'un résultat concaténé au prompt est une injection indirecte), `executor.ts` (tronc
commun d'exécution : validation des arguments, injection des paramètres non confiés au modèle, budget de
temps, journal, troncature), `resolvers/` (`mba` maison, `http` connecteur, `simulation` pour le bac à sable),
`outils-maison.ts` (le catalogue), `contexte.ts`, `credits.ts`, `devise.ts`, `escalade.ts`, `run-turn.ts`,
`turn-job.ts`, `setup/` (l'assistant de construction et son lint).

**La file `agent-turn`** (`src/queue/names.ts`, polling 2 s comme `webhook` : un tour répond à un message d'un
contact, c'est un chemin conversationnel). ⚠️ Elle n'est **consommée que si `AI_GATEWAY_API_KEY` est posée** ;
sinon le worker journalise « agent-turn : file NON consommée » et les blocs agent restent muets.

**Deux modèles, deux métiers** : `AGENT_SETUP_MODEL` (construction, sortie structurée imbriquée, tourne
rarement) et `AGENT_MODEL` (runtime, à chaque message). Le boot REFUSE la clé du Gateway sans les deux, parce
que le repli sur `LLM_MODEL` donnerait à un agent l'identifiant de l'ANALYSE de conversation, servie en direct
par Anthropic, que le Gateway ne connaît pas. Cf « Banc de tool calling » pour le choix mesuré.

## Deux pools Postgres, et pourquoi

- **`DATABASE_URL`** = pooler Supabase en mode **SESSION** (port 5432). Sert **pg-boss** (API et worker) et
  **tous les scripts CLI** (`db/migrate.ts`, `db/seed.ts`, `db/backfill-codes.ts`), qui lisent cette variable
  en direct : DDL et seed toujours en session mode, c'est voulu.
- **`APP_DATABASE_URL`** = pooler en mode **TRANSACTION** (port 6543), pour le pool APPLICATIF (toutes les
  requêtes des stores). Vide -> repli sur `DATABASE_URL`, dégradation SÛRE en cas d'oubli.
  🔴 pg-boss ne peut PAS y aller : il maintient des connexions longues et une maintenance qui ne survivent pas
  au transaction pooling (le pooler réassigne le backend entre transactions).
- **`DB_POOL_MAX` = 8**, mais le pool est instancié **PAR PROCESS** (l'API et le worker importent le même
  module), donc 16 clients simultanés vers le pooler, exactement la capacité observée en production le
  2026-08-25 : au-delà de 16, la latence double sans qu'aucune erreur ne remonte. Monter plus haut déplacerait
  la file d'attente de NOTRE pool vers celle de Supavisor, où elle est MUETTE, et `DB_CONN_TIMEOUT_MS` ne
  protégerait plus de rien.
- **`PGBOSS_MAX` = 2** : c'est LUI qui vit dans le budget d'environ 15 sessions partagé avec mm-hubspot
  (2 process x 2 ici, 2 x 2 chez lui). Ne pas le relever sans refaire cette arithmétique.
- **`DB_CONN_TIMEOUT_MS` = 8000** : le défaut `pg` est une attente ILLIMITÉE, donc un pool saturé rend une
  requête HTTP qui ne répond jamais, sans erreur ni trace.
- **TLS** : `DB_SSL`, `DB_SSL_CA_FILE`, `DB_SSL_INSECURE` sont lues par `src/db/ssl.ts`, PAS par `config.ts`.
- ⚠️ Sûr parce que mba est **search_path-agnostique** (tables en `public` par défaut, `mmhs` TOUJOURS
  qualifié) et que toutes ses transactions passent par un client dédié.

## Files et balayeurs

**Sept files** (`src/queue/names.ts`, `BASE_QUEUES`, source UNIQUE) plus leur DLQ (`dlqName`), soit 14 files
réelles côté `/ops`. La cadence de polling se règle **par file**, sur la latence réellement utile :

| File | Polling | Pourquoi |
| --- | --- | --- |
| `webhook` | 2 s | messages entrants, latence conversationnelle |
| `agent-turn` | 2 s | un tour d'agent IA répond à un message, même chemin |
| `campaign-run` | 5 s | l'utilisateur vient de cliquer « lancer » et regarde l'écran |
| `automation-event` | 5 s | démarre un scénario sur mot-clé, tag, webhook |
| `analyze-conversation`, `push-analysis`, `hubspot-catchup` | 30 s | traitements de fond |
| toute DLQ | 60 s | dépôt inspecté par `/ops`, consommé par personne |

🔴 **Pourquoi ce n'est pas le défaut de pg-boss (2 s partout)** : mesuré le 2026-08-17, le polling à vide des
4 process (mba api + worker, mm-hubspot api + worker) produisait 663 000 requêtes et 249 Mo d'egress par jour
pour 157 jobs en table, soit 7,5 Go/mois contre 5 Go inclus. L'egress d'un poll est du pur overhead.

🔴 **Toute nouvelle file entre dans `BASE_QUEUES`**, sinon elle est invisible de `/ops` et sa DLQ n'est
surveillée par personne. `tests/queue-names.test.ts` dérive la liste des `queue.work(...)` du worker et casse
si on l'oublie ; `QUEUE_POLLING_SECONDS` doit aussi porter une entrée.

**Les balayeurs du worker** (`src/worker.ts`), tous `unref()`, avec leur variable de cadence :

| Balayeur | Cadence | Ce qu'il fait |
| --- | --- | --- |
| reclaim | `RECLAIM_INTERVAL_MS` | ramène à `pending` un destinataire `sending` plus vieux que `STALE_SENDING_MS` |
| `campaign/schedule-sweep` | 60 s | enfile les campagnes programmées dues, puis marque `running` |
| campagne au fil de l'eau | 60 s | relance les campagnes webhook qui ont un destinataire `pending` avalé par un `singletonKey` |
| `workflow/wake-sweep` | `WORKFLOW_WAKE_SWEEP_INTERVAL_MS` | réveille les parcours endormis (bloc Attente) et réclame les blocs Question à échéance |
| `campaign/retry-sweep` | `AUTO_RETRY_SWEEP_INTERVAL_MS` | auto-relance des échecs (fenêtre matinale des 131049) |
| `inbox/control-sweep` | `CONTROL_SWEEP_INTERVAL_MS` | rend la main au scénario après `CONTROL_HUMAN_TIMEOUT_MS` / `CONTROL_MBA_TIMEOUT_MS` |
| `mba/handoff-sweep` | `CONTROL_SWEEP_INTERVAL_MS` | applique le mode `business_hours` du passage de main Meta |
| `analysis/sweep` | `CONVERSATION_ANALYSIS_SWEEP_INTERVAL_MS` | réclame les conversations closes à analyser |
| rattrapage HubSpot | `HUBSPOT_CATCHUP_SWEEP_INTERVAL_MS` | relance les marques restées sur un numéro reconnecté |
| `automation/date-sweep` | `AUTOMATION_DATE_SWEEP_INTERVAL_MS` | déclencheur « X avant la date d'un champ » |
| `account/status-sweep` | `PHONE_STATUS_SWEEP_INTERVAL_MS` | statut et qualité des numéros Meta |
| purge des payloads webhook | 6 h | `WEBHOOK_PAYLOAD_RETENTION_DAYS` |
| `ops/dlq-sweep` | | alerte Telegram sur les DLQ non vides |
| heartbeat | `HEARTBEAT_INTERVAL_MS` | écrit `worker_heartbeat` (0044), lu par `/ops` pour voir un worker mort |

## API publique v1 (migration 0035)

Deux surfaces : `POST /v1/contacts` et `/v1/contacts/batch` (`src/http/v1-contacts.ts`), `POST /v1/sends` et
`GET /v1/sends/:sendId` (`src/http/v1-sends.ts`). Gestion des clés dans `src/http/api-keys.ts`, écran
`/developers`.

- **Clés** (`api_keys`) : jamais stockées en clair, seulement leur `sha256` (même doctrine que `auth_tokens`).
  `scopes text[]`, validés contre `VALID_API_SCOPES = ['contacts:write', 'sends:create']` ; au moins un scope
  est exigé à la création. `revoked_at` plutôt qu'un DELETE. La clé n'est rendue QU'UNE FOIS, à la création.
- **Idempotence** (`api_idempotency`) : `Idempotency-Key` OBLIGATOIRE sur `POST /v1/sends`. Claim atomique par
  la PK `(tenant_id, idempotency_key)` : `send_id` null = calcul en cours, donc un rejeu concurrent rend 409 ;
  renseigné = on renvoie le rapport caché. Purge après 24 h.
- **Débit** : `API_KEY_RATE_LIMIT_MAX` / `_WINDOW_MS` (60 par minute), **en mémoire et par process**, donc
  effectivement doublé entre l'API et le worker si un jour le worker montait ces routes.
- **Consentement** : `/v1/contacts` exige un **opt-in EXPLICITE**, à l'inverse de la saisie manuelle et de
  l'import CSV (cf « RGPD »). Un appelant d'API charge une liste dont il ne connaît pas chaque ligne.
- **Fenêtre 24 h** : `exigeFenetre24h` sur `/v1/sends`, troisième détenteur de cette règle avec `besoinsFenetre`
  et la garde de `runFrom`.

## Canal email (migration 0062)

Troisième canal, servi par le bloc « Envoi de mail » du builder. `src/email/` : `account-store.pg.ts`,
`template-store.pg.ts`, `resolver.ts`, `smtp.ts` (nodemailer).

- `email_accounts` : une boîte SMTP par workspace : `host`, `port`, `secure`, `username`, **`password_enc`**
  (AES-256-GCM via `src/crypto/secretbox.ts`, même patron que `waba_credentials` et `agent_tool_sources`),
  `from_address`, `from_name`, `reply_to`, `verified_at`. Le mot de passe en clair ne transite que dans
  `buildTransport`, jamais journalisé ni renvoyé par une route.
- `email_templates` : `format` ∈ `basic` | `html`, `subject`, `body`. Écran `/email-templates`.
- **Suppression DOUCE** (`deleted_at`) sur les deux tables, avec des index uniques partiels : un bloc qui
  référence une boîte ou un modèle retiré devient inerte, le graphe reste valide. Une suppression dure
  casserait un scénario en silence.
- **Variables** : même contrat `{{champ}}` et même table de substitution que le RCS (`contactVars`). Le
  sélecteur propose `emailVariableFields` (qui ajoute `profile_name` et `phone`, que `GET /user-fields` ne
  rend jamais) ; `emailResolvableFields` sert au choix du champ qui CONTIENT l'adresse du destinataire, où
  proposer « Téléphone » serait un piège.
- **Destinataires en copie cachée** (`bcc`) : aucun en-tête n'est posé si la liste est vide.

## Réglages d'espace (`tenant_settings`, `src/settings/store.pg.ts`)

Une ligne par tenant (PK = `tenant_id`), enrichie migration après migration. Chaque colonne est un
interrupteur produit, et aucune n'a de défaut « allumé » :

| Colonne | Migration | Ce qu'elle gouverne |
| --- | --- | --- |
| `mba_enabled` | 0012 | l'agent Meta Business Agent est actif sur cet espace |
| `hubspot_lists_enabled` | 0036 | « Campagnes via données HubSpot » (import de contacts, pas les étapes de deal) |
| `campaigns_paused` | 0047 | coupe-circuit d'envoi de campagnes pour tout l'espace |
| `auto_retry_enabled` | 0048 | auto-relance des échecs |
| `timezone` / `business_hours` | 0050 | le fuseau de l'espace (une heure murale sans fuseau est interprétée là) et les horaires |
| `mba_handoff_mode` | 0067 | `always` \| `business_hours` \| `never`, source de vérité du passage de main (cf sa section) |
| `return_behavior` | 0051, **droppée en 0059** | ne plus chercher cette colonne |

## Gotchas et décisions (journal, déplacé de CLAUDE.md)

Vue chronologique par lot. La vue thématique correspondante est dans les sections ci-dessus.

### Gotchas Meta du lot (2026-07-12)
- **Édition d'un template Meta REMPLACE tous les components** (pas de patch) : un HEADER/FOOTER/CAROUSEL
  serait supprimé s'il n'est pas re-fourni -> on **bloque l'édition** de ces templates (flag `editable`).
- **En-tête template TEXTE à variable interdit en V1** : aucun chemin d'envoi (campagne/inbox) ne fournit un
  paramètre de header -> Meta #132000 à l'envoi. `parseHeader` rejette `{{n}}` dans le header texte.
- **Éditer le flow_json d'un DRAFT = `POST /{flow_id}/assets` en MULTIPART** (le create est du JSON inline) ;
  un flow PUBLISHED est immuable -> « dupliquer pour modifier ».
- **Funnel read receipts** : `delivery_status IS DISTINCT FROM 'failed'` (PAS `<> 'failed'` : la colonne est
  souvent NULL, `NULL <> x` = NULL = faux -> sortirait les null du dénominateur).

### Gotchas lot 2 (2026-07-12)
- **Statut compte « jamais de faux vert »** (`src/account/service.ts`, PUR) : le vert exige numéro `CONNECTED`
  + qualité `GREEN` confirmée ; tout inconnu -> gris. Une qualité `UNKNOWN` fraîche doit ÉCRASER un vieux
  `GREEN` en base (`pullFromInfo` persiste toujours la qualité, sinon staleness = faux vert).
- **Funnel « répondu » attribué au DERNIER envoi** : `getCampaignFunnel` borne la réponse par un `not exists`
  d'un envoi ultérieur au même numéro avant la réponse -> pas de double-comptage sur plusieurs campagnes.
- **`/ops` = surface cross-tenant, majoritairement en lecture MAIS avec DEUX POST** (observation d’un espace, et recharge du solde prépayé : la seule écriture d’argent du produit), autorité SÉPARÉE du JWT : header `x-ops-token` == `OPS_TOKEN`
  (env, compare constant-time). Vide -> 401 (désactivé). `OPS_TOKEN` vit dans `.env.prod` du VPS, jamais commité.
- **Nom de schéma pgboss interpolé en SQL** (`${schema}.job`) : validé par regex (`safeSchema`), source = env
  seule. Toute VALEUR reste bindée `$n`. Un `$n` non typé dans un CASE défaut à `text` -> caster `$n::type`.

### Gotchas lot 7 (2026-07-13)
- **Résolution des variables d'un template envoyé via WORKFLOW = dans la closure `sendTemplate` de `worker.ts`**,
  PAS dans l'executor (qui ne porte que waId). Elle lit N (nb de variables du corps live via `list()` Meta, caché
  5 min par WABA|nom|langue), les `template_param_hints`, le contact (`getResolvableByPhone`) et fournit TOUJOURS N
  params (`buildWorkflowTemplateComponents`, pure + testée). Sans ça : envoi à 0 variable -> Meta #132000. Le vrai
  chemin étant une closure inline, on teste la **fonction pure** extraite, pas un fake d'executor (cf LEARNINGS).
- **Numérotation d'une nouvelle variable de template = MAX des positions présentes + 1**, jamais le simple compte :
  après suppression d'une variable, réutiliser le compte crée une collision `{{n}}`. Le corps est **canonicalisé**
  (renumérote 1..N par ordre d'apparition + réaligne sources/exemples) **au submit** -> Meta exige 1..N contigu.
- **Éditeur du corps = `contentEditable` (VariableBodyEditor)** affichant des chips `[Prénom]` tout en sérialisant
  `{{n}}`. Quasi non-contrôlé : ne réécrit l'innerHTML que si `serialize(DOM) !== value` (sinon le caret saute à
  chaque frappe). Labels mis à jour EN PLACE dans les chips (n'affecte pas le caret).
- **Fiche contact : téléphone + BSUID en LECTURE SEULE** (identités qui routent les messages / clés uniques). Seuls
  Nom (`profile_name`), Prénom et les user fields sont éditables ; suppression de champ via `fields - text[]` (accepte
  une clé orpheline sans définition).
- **Tag d'un bloc « ajout de tag » déclaré dans le référentiel** à la sauvegarde du workflow (`declareTags`,
  best-effort) ET au runtime (`applyTag` upsert), même normalisation (trim + slice 64) que la route Tags. Aussi
  persisté **au blur** du champ dans le bot builder (`createTag`) -> visible tout de suite dans Contenu > Tags.

### Gotchas / décisions (2026-07-15)
- **Campagne WORKFLOW : « statut envoyé ≠ livré ».** La branche workflow de l'engine marque le destinataire `sent`
  avec un **message_id synthétique `wf-<id>`** (fire-and-forget `startWorkflow`) -> le funnel delivered/read reste à 0
  ET un envoi réel sauté en aval ne se voit pas. Parade câblée : on **associe + résout les variables du 1er template
  À LA CRÉATION** (buildRecipients -> `resolvedParams` passés jusqu'à l'envoi via `startWorkflow`/`executor.start`/
  `sendTemplate explicitParams`) et on **saute + avertit** (« X contacts sautés ») au lieu d'un skip runtime silencieux.
  Détail transversal : `brain/LEARNINGS.md` 2026-07-15. **Reste à faire** : le vrai tracking de livraison (todo).
- **Campagne workflow : le 1er nœud DOIT être un template** (validé côté route via `getWorkflowGraph` + `entryNode`,
  400 sinon). Le mapping du 1er template est stocké sur la campagne (`param_mapping`), pas sur le template global.
- **Cap d'envoi Meta : `messaging_limit_tier`** = **cap de clients uniques par 24 h** (TIER_250/1K/10K/100K/UNLIMITED),
  affiché via `web/lib/format.ts` `sendingLimitLabel` (repli honnête si Meta n'a pas évalué, jamais un faux chiffre).
  Le débit brut `throughput_level` (STANDARD 80 msg/s, identique pour tous) N'EST PLUS affiché ni mappé (décision
  produit F2 : sans valeur pour l'utilisateur). Le champ reste pull/persisté côté backend, juste non rendu.
- **État HubSpot d'un numéro = lecture CROSS-SCHEMA** : mba lit `mmhs.tenant_portals`/`mmhs.portals` (schéma du
  connecteur mm-hubspot, même Supabase) via `getHubspotPortal` (best-effort, catch -> non connecté, jamais de 500).
  Le toggle par-numéro (`phone_numbers.hubspot_connected`) gate le push d'analyse. Bouton « Connecter HubSpot » =
  lien d'installation **SIGNÉ**, obtenu par `POST /tenants/:tenantId/hubspot/install-link` (route admin, JWT ;
  le tenant vient du jeton, jamais de l'URL) et consommé par le connecteur en `/oauth/install?t=<jeton>`.
  ⚠️ **La forme `?tenant=<tenantId>` documentée ici jusqu'au 2026-08-29 NE MARCHE PLUS**, et c'est voulu :
  elle acceptait n'importe quel identifiant sans authentification, donc n'importe qui pouvait relier SON
  portail HubSpot au workspace d'un client (faille 1.1 de `PLAN.md`, fermée). Le jeton est un HMAC à durée de
  vie de 10 minutes ; l'ancienne forme ne survit que derrière `HUBSPOT_INSTALL_ALLOW_LEGACY_TENANT`, à
  `false` en production, et la reposer à `true` rouvrirait la faille à l'identique.

### Gotchas / décisions (2026-07-16)
- **Campagne workflow : 3 pannes SILENCIEUSES fermées** (le « envoyé mais rien reçu » persistant). (a) **Cap fréquence 24h RETIRÉ** : `DEFAULT_THRESHOLDS.frequencyWindowMs=0` + garde `t.frequencyWindowMs > 0` (court-circuit, aucune requête). Un garde-fou qui laissait un destinataire `pending` en silence pendant que la campagne se marquait `completed` = panne invisible ; plomberie fréquence conservée + testée (fenêtre >0 la réactive). (b) **Indice de template périmé → 0 destinataire** : un hint `{field, nom}` fantôme mappait `{{1}}` sur un champ inexistant ; le `<select>` affichait « Nom » mais gardait le sel fantôme -> tous sautés. Fix front `selForSource` (coerce un champ inconnu → `sys:name`) + option de garde + campagne 0 destinataire = avertissement ROUGE. (c) **Bouton FLOW à l'envoi (#131009)** : un template à bouton **FLOW** (NAVIGATE) part rejeté sans son composant bouton ; Meta exige `{type:'button', sub_type:'flow', index, parameters:[{type:'action', action:{flow_token}}]}` avec `flow_token` NON vide. mba corrèle la réponse par `_ref` baké dans le flow_json, donc le flow_token peut être n'importe quelle valeur unique (`worker` passe `${waId}-${Date.now()}`). **Vérifié empiriquement contre la Cloud API** avant de coder. Détail transversal : `brain/LEARNINGS.md` 2026-07-16.
- **Champs SYSTÈME (Nom/Prénom/Téléphone/BSUID/WhatsApp ID/Email) = constante de CODE, SANS migration** : `src/crm/fields.ts` SYSTEM_FIELD_KEYS (garde PATCH/DELETE/POST 403/409) + `web/lib/fields.ts` SYSTEM_FIELDS (miroir, source par champ). Résolus via les attributs existants + 2 nouveaux (`bsuid`, `wa_id` dans `ParamSource`/`valueOf` switch + `getResolvableByPhone` remonte bsuid). Sélecteur de variable de campagne = **dropdown** (base + vrais champs perso + texte fixe), fini la clé tapée à la main.
- **Embedded Signup (Tech Provider) : LIVE mais OFF par défaut.** Bouton « Connecter mon compte WhatsApp » (accueil, espace sans numéro). Env : `META_ES_CONFIG_ID` (vide → route 503 + bouton placeholder), `ENCRYPTION_KEY` (64 hex, fail-fast prod si config_id posé), `META_APP_ID=988129420727963`. Backend `src/http/embedded-signup.ts` + `src/meta/embedded-signup.ts` + `src/account/es-store.pg.ts` + `src/crypto/secretbox.ts` (AES-256-GCM). **Anti-hijack** : `verifyWaba`+`getPhone` BLOQUANTS avec le business token avant tout rattachement (sinon un tenant relie les assets d'un autre). Token+pin **chiffrés** (mig **0029** `waba_credentials`, col `pin_enc`). Config Meta via template « WhatsApp Embedded Signup 60-day » (cf `brain/LEARNINGS.md`). ⚠️ Marche seulement quand Meta a validé Access Verification (Tech Provider) + App Review : **soumises le 2026-07-16, en review**.
- **Compte de test reviewer** : `meta-review@messagingme.app` / `MetaReview2026!` (admin sur le workspace Demo `4169c753-…`, scrypt). Créé pour l'App Review Meta. **À SUPPRIMER après approbation.**
- **Landing admin = `/accueil`** (Home), plus `/dashboard` (Analytics) : login/racine/Google/invite redirigent l'admin sur Home (montre le numéro + statut, cohérent avec les reviewer instructions Meta). Le lien Analytics du menu reste.
- **i18n FR/EN** : moteur léger `web/lib/i18n.tsx` (`useT()` → `t('fr','en')` co-localisé, contexte persisté localStorage, défaut FR), toggle dans le menu Compte. Toute l'app traduite. Règle : NE JAMAIS wrapper une valeur backend/clé/comparaison dans `t()` (grep de sûreté `value={t(`, `=== t(`).

### Gotchas / décisions (2026-07-16, suite : programme 16 features, lots A-E)
- **⚠️ Ordre migration/deploy selon le TYPE** : ADD colonne = migrate AVANT le deploy (habituel) ; **DROP colonne = deploy AVANT le migrate** (l'ancien code la lit encore → 500 pendant le rebuild sinon). Exception documentée dans `DEPLOY.md` + règle générale dans `brain/LEARNINGS.md`. 1er cas réel : `0030_drop_workflow_status.sql`.
- **Codes publics « schéma A » (socle API, Lot 4a)** : `<type>_<code-client>_<ULID>` (scn/usr/fld/tag ; nod = Lot 4b). **ADDITIFS** : colonnes `tenants.public_code` + `code` (mig 0031, nullables + index uniques partiels), AUCUNE PK/FK/slug touchée. Génération à l'INSERT (`src/ids/code.ts` : newUlid/makeCode/deriveTenantCode ; `src/ids/tenant-code.ts` : resolveTenantCode self-heal). Racine client = 6 car. base32 **immuable**, dérivée de l'uuid tenant (PAS le numéro : PII + inexistant au signup). Backfill one-shot : `db/backfill-codes.ts` (idempotent, après migrate).
- **Scénario : AUTO-SAVE, plus de statut** : debounce ~1,2s sur [nodes,edges], **flush au démontage + beforeunload en `keepalive`** (sinon perte des dernières modifs), skip du rendu initial, planification via `doSaveRef` (le changement de langue ne déclenche pas de save), **saves sérialisés** (un PATCH à la fois, re-save si édité pendant). Colonne `status` droppée (elle était 100 % cosmétique, rien ne la lisait).
- **Node « message rapide » (quick_message)** : bloquant comme template, action `sendQuickMessage` → `MetaClient.sendInteractive` (interactive/button, cap 3 boutons / 20 car.). **Index de branche préservé** : `reply.id = btn:<slot>` même après filtrage des titres vides (sinon mauvaise branche). Fenêtre 24h garantie par l'archi (jamais node d'entrée : campagne exige entry=template). ⚠️ Le node `flow` reste un no-op silencieux (n'envoie rien, run bloqué) → fix différé au lot Flow avancé (envoi interactif flow = sonde Meta).
- **⚠️ Closure de wiring et arité TS** : `index.ts` câblait `(tenant, range) => store.getErrorBreakdown(tenant, range)` alors que la route passait un 3e arg → filtre `?templateName=` MORT en prod, tsc muet (arité non vérifiée), test masqué par le fake. À CHAQUE ajout de param à une interface de deps : grep toutes les implémentations (prod + fakes). Cf `brain/LEARNINGS.md`.
- **Erreurs Meta par template** : `getErrorBreakdown(range, templateName?)` groupe par (code, template_name) ; l'UI agrège CÔTÉ CLIENT (un fetch, dropdown « Tous les templates »). Portée = campagnes (aucune colonne d'erreur sur `conversation_messages` → envois Inbox/Workflow non couverts, cf todo). ⚠️ **Entrée du 2026-07-16, dépassée depuis le 2026-09-07** : la ligne porte désormais aussi la CAMPAGNE, et un second axe de filtre existe. État à jour : § « Stats & analytics » plus haut. On ne réécrit pas un journal, on y pose le pointeur.
- **Import HubSpot (#14) parké en todo** (multi-repo : scope `crm.lists.read` + re-consentement portail + client lists mm-hubspot + proxy mba).

### Gotchas / décisions (2026-07-17, Lot 7 : Flow avancé)
- **⚠️ Id d'écran Flow JSON = lettres + underscores UNIQUEMENT** (`ETAPE_2` rejeté à cause du chiffre, sondé live). Nos ids : `FORM`, `FORM_B`, `FORM_C`… L'écran 1 s'appelle `FORM` POUR TOUJOURS (baké en `navigate_screen` des templates FLOW approuvés + `flow_action_payload.screen` de `sendFlowMessage`).
- **Champ masqué (visible/If) ou vide = OMIS du payload `complete`** (sondé) : le mapping webhook (`hasOwnProperty`) suffit tel quel, AUCUN risque d'écrasement de champ contact par du vide. Un `required` caché ne bloque ni navigate ni complete. Refs globales `${screen.<ID>.form.<clé>}` : payloads d'action SEULEMENT (non résolues dans les textes affichés).
- **`flows.elements` = jsonb POLYMORPHE sans migration** : null legacy / tableau plat (mono-écran historique) / `{screens:[...]}` (Lot 7), normalisé par `screensOf` à la LECTURE. Toute nouvelle lecture de la colonne passe par `screensOf`, jamais un cast direct.
- **Garde fenêtre 24 h** : un scénario ne peut pas OUVRIR sur un node flow/quick_message (`opensOutsideServiceWindow` -> 400 au save + skip défensif `start()` + badge UI sur le node d'ouverture réel, calculé en traversant les blocs synchrones tag/field). ⚠️ Contrat de test CHANGÉ sciemment : « quick_message en entrée envoyé par start » assertait la faille -> réécrit.
- **Sonde LIVE committée** : `MBA_TOKEN=$(ssh ubuntu@$VPS "grep '^META_ACCESS_TOKEN=' /home/ubuntu/mba/.env.prod | cut -d= -f2-") WABA_ID=1695646181671929 npx tsx scripts/sonde-flow-live.mts` : à rejouer à CHAQUE évolution du générateur flow_json (crée un draft sur le vrai WABA, exige `validation_errors == []`, se nettoie).
- **Preview interactive Meta** = banc de test runtime sans device : `GET /{flow_id}?fields=preview.invalidate(false)` puis `?interactive=true&debug=true&flow_action=navigate&flow_action_payload={"screen":"FORM"}` (les 2 derniers params REQUIS ensemble) ; le panneau debug affiche le payload exact de chaque action.

### Gotchas / décisions (2026-07-17, Lot 9 : ConvAnalyzer light)
- **⚠️ `conversation_analysis.created_at` = date de DERNIÈRE analyse, pas de la conversation** : la table est upsertée (`on conflict do update set created_at=now()`). Tout agrégat temporel dessus compte des ré-analyses, pas des conversations nouvelles ; une ligne ré-analysée saute de fenêtre. Assumé et LIBELLÉ « à date de dernière analyse ». Pour une vraie timeline, joindre `conversations.created_at` (stable). Cf `brain/LEARNINGS.md`.
- **Couche de LECTURE séparée du moteur d'écriture** : `src/stats/conversation-stats.pg.ts` (lecture, 1er lecteur de la table) ≠ `src/analysis/store.pg.ts` (écriture). Ne pas mélanger. `tenant_id=$1` sur CHAQUE requête (IDOR = leçon convanalyzer). Filtres quali validés contre un SET d'enum (valeur hors enum ignorée, pas d'injection).
- **Champs LLM = indicatifs** (sentiment/intent/topic/resolved/action/confidence) ; `handled_by`/`exchanges_count` sont DÉTERMINISTES (code). Bucket `handled_by='mba'` inatteignable (MBA fermé ToS) -> 2 valeurs réelles, ne pas dessiner 3 catégories égales.
- **Repo web SANS lib de charts** (règle no-ai-slop) : donut = SVG maison (`pathLength=100` + `stroke-dasharray`), barres = patron inline existant. Ne JAMAIS ajouter recharts/tremor/d3.
- **Analyse ACTIVE en prod** : `CONVERSATION_ANALYSIS_ENABLED=true`, `LLM_MODEL=claude-haiku-4-5`. La table se remplit ; empty-state (`total=0`) couvre « inactif » (via `enabled`) ET « aucune donnée sur la période ».

### Gotchas / décisions (2026-07-17, Lot 8 : campagne une-page)
- **⚠️ Timeout d'un job de file THROTTLÉ = dimensionné PAR JOB, pas une constante** : un run de campagne à débit bas tourne des heures ; un `expireInSeconds` fixe (pg-boss défaut 900s) le fait EXPIRER -> **rejeu parallèle** (l'original n'est pas tué) -> débit réel x2 + statut `completed` prématuré. Fix : `src/campaign/pacing.ts campaignJobExpireSeconds(n, rate)` passé PAR JOB à l'enqueue (`Queue.enqueue({expireInSeconds})`, route `/run` via `getRunSizing`). ⚠️ `pg-boss createQueue` est `ON CONFLICT DO NOTHING` (ne met PAS à jour une file existante) : pour une policy de file, `updateQueue` ; pour une valeur qui varie, l'option par job. Cf `brain/LEARNINGS.md`.
- **Filtres CRM = WHERE 100 % paramétré, clé jsonb LIÉE** : `contact-store.buildWhere` : `fields ->> $key` (la clé vient de l'utilisateur, JAMAIS interpolée), `tenant_id=$1` toujours. Route GET /contacts (+/count, +/ids) dans `src/http/import.ts` (PAS http/contacts.ts, piège de localisation) ; `parseFilters` défensif (JSON de `fields` illisible -> ignoré). Le submit campagne reste `contactIds` (buildRecipients = dernier garde opt-in).
- **Statut campagne `scheduled` à propager PARTOUT** : `CampaignStatus` + CHECK `campaigns_status_check` (mig 0034, DROP+ADD, nom vérifié) + `STATUS` map front + garde D1 `listActiveCampaignsForTemplate` (édition template) + counts (listCampaignSummaries n'a AUCUN filtre de statut, OK). Sweeper `schedule-sweep.ts` : enqueue PUIS markRunning (jamais de 'running' orphelin), idempotent (singletonKey + garde `status='scheduled'`).
- **Import réutilisable** : `web/components/CsvImport.tsx` extrait (Contacts + campagne, prop `requireTag`), zéro dupe. Contacts NE navigue plus après import (le rapport + erreurs par ligne sont enfin visibles).

### Gotchas / décisions (2026-07-16, fin de programme : lots 4b + 6)
- **Codes de NODES (Lot 4b) = mint SERVEUR, jamais confiance au client** : `src/workflow/node-codes.ts` au POST/PATCH workflows (après parseGraph). Regex anti-forge `^nod_<tenantCode>_[ULID]$` : code valide du MÊME tenant → préservé par référence (stabilité des codes existants) ; absent/forgé/autre tenant → re-minté. La réponse renvoie le graphe ENRICHI (le front réaffiche les codes sans re-fetch). Champs système : code **déterministe sans stockage** `fld_<client>_sys_<key>` (`systemFieldCode`), le front le calcule via `tenantCode` exposé par GET /fields (dep OPTIONNELLE côté fields, REQUISE côté workflows).
- **⚠️ Type partagé front : `Locale` vit dans `web/lib/locale.ts` (.ts PUR)** : le tsc RACINE (qui type-check `tests/`) n'a pas `--jsx` → importer même un simple type depuis un `.tsx` casse le build (TS6142). Tout type consommé par du code non-JSX doit vivre dans un `.ts` ; `i18n.tsx` le ré-exporte pour les composants.
- **Helpers localisés = paramètre `locale` REQUIS, pas de défaut** (`day.ts`, `format.ts`) : tsc LISTE alors tous les appelants à mettre à jour, zéro oubli possible (l'inverse du piège d'arité des closures). Tags BCP47 confinés aux 2 libs, grep `fr-FR` = 0 ailleurs dans `web/`.
- **⚠️ GATES : jamais de pipe sur une commande gate** : `npm run build 2>&1 | tail` renvoie l'exit du TAIL → un build cassé passe « vert ». Toujours `cmd > log 2>&1; echo EXIT=$?`. Et **vitest ne type-check PAS** (esbuild) : 707 tests verts ≠ tsc vert. Cf `brain/LEARNINGS.md` 2026-07-16.

## Journal des lots livrés (déplacé de `wip.md` le 2026-08-29)

🔴 **POURQUOI CES SECTIONS ONT DÉMÉNAGÉ.** `wip.md` avait atteint 1341 lignes et remontait à juillet : les lots
finis n’en sortaient jamais. Un fichier censé dire « ce sur quoi je travaille MAINTENANT » était devenu une
archive, donc illisible pour son seul usage. Les trente-huit sections ci-dessous sont des lots LIVRÉS ET
DÉPLOYÉS, gardées telles quelles parce qu’elles portent des GOTCHAS et des DÉCISIONS (pourquoi tel ordre, quel
piège évité) qu’aucun autre document ne consigne. Elles se lisent à la demande, jamais en entier.

⚠️ Elles sont datées et figées : ce qu’elles décrivent était vrai le jour du déploiement. En cas de
contradiction avec le reste de ce fichier ou avec `features.md`, c’est le reste qui fait foi.

---
## LES MIGRATIONS, UNE PAR UNE : ce que chacune a coûté et ce qu'elle a appris (0093 à 0113)

🔴 **CE BLOC VIENT DU `CLAUDE.md`, ET IL EN EST SORTI LE 2026-09-04.** Il y avait grossi jusqu'à 120 lignes,
soit un quart d'un fichier chargé à CHAQUE session, pour raconter des migrations dont la plupart sont
appliquées depuis des semaines. C'est le même glissement que `wip.md` a subi deux fois : un point d'entrée qui
devient une archive cesse d'être un point d'entrée.

⚠️ **LE COMPTEUR N'EST PAS ICI, ET IL NE DOIT JAMAIS Y ÊTRE.** `CLAUDE.md` se déclare sa source unique, et
trois documents qui l'avaient recopié étaient tous faux (de 43, de 15 et de 5 migrations). Ce qui suit ne
contient aucun numéro « dernière appliquée » ni « prochaine libre » : c'est vérifié par assertion au moment du
déplacement, et ça doit le rester.

Ce qui est RESTÉ dans `CLAUDE.md` parce que ça se décide à chaque déploiement : le compteur, la règle qui dit
si une migration est bloquante ou non (donc l'ordre migrer/déployer), la directive hors-transaction, le verrou
d'exécution unique, et le fait que les migrations vivent dans l'IMAGE et pas sur le disque du VPS.

Ce qui suit se lit à la demande, quand on se demande pourquoi une migration précise a été écrite comme ça.

✅ **0113 APPLIQUÉE le 2026-09-03 au soir** (index), et elle N'ÉTAIT PAS BLOQUANTE : aucun code ne l'écrit ni ne la lit, le
balayage rend les mêmes lignes sans elle, un peu plus lentement. Elle rattrape un index PARTIEL de la 0112
(`where status = 'en_cours'`) devenu inutilisable le 2026-09-03, quand la requête du balayage a perdu sa
condition de statut. **Un index partiel est un CONTRAT avec une requête précise** : élargir le domaine de la
requête la fait sortir du contrat, et rien ne le signale, ni le compilateur, ni les tests, ni une erreur au
démarrage. Le seul symptôme est un plan d'exécution qui change. 🔴 Elle est HORS TRANSACTION
(`CREATE INDEX CONCURRENTLY`), donc sans filet.

🔴 **0112 est BLOQUANTE** : `prendreLeTour` écrit `tour_commence_le` à chaque tour, et c'est le chemin chaud du
bloc agent. Déployer sans migrer ferait échouer TOUS les tours. Appliquée AVANT, colonne et index vérifiés en
base, et le SQL du balayage joué à blanc contre la vraie table (0 ligne). ⚠️ Vérifié EN BASE le 2026-09-03
(`select name from public.schema_migrations order by name desc`) parce que cette ligne annonçait encore 0107 :
un compteur tenu à la main dérive dès qu'un déploiement se fait sans repasser par ici. **En cas de doute, la
base tranche, jamais ce fichier.** Et `schema_migrations` existe dans PLUSIEURS schémas de cette base : la
requête doit être qualifiée `public.`, sinon elle lit la table d'un autre outil et rend des colonnes inconnues.
⚠️ 0110 posait `create extension vector`, la première du dépôt à ajouter une EXTENSION, donc le seul point qui
pouvait échouer pour une raison de droits : il est passé sans incident.
⚠️ **Ce compteur a dérivé DEUX fois le 2026-09-03**, et dans les deux sens : il a annoncé 0107 quand la base
était à 0111, puis « prochaine libre = 0112 » alors que 0112 était le fichier déjà appliqué, ce qui aurait fait
écrire par-dessus. Il porte maintenant UNE seule ligne « dernière appliquée » et UN seul « prochaine libre » :
deux lignes qui disent la même chose finissent toujours par se contredire. En pratique on applique aussi via
`npm run migrate` en local (même Supabase prod).

⚠️ **Le correctif de la transition terminale du 2026-09-03 n'a demandé AUCUNE migration**, et ça valait d'être
vérifié plutôt que supposé : il ne change que le MOMENT où `tour_commence_le` est effacée, pas le schéma. Une
colonne dont on change le sens sans changer le type ne se voit pas dans `db/migrations/`, elle se voit dans le
contrat, et c'est là qu'elle est documentée (`src/agent/session-store.ts`).

🔴 **0107 est BLOQUANTE, et elle CORRIGE la moitié RCS de la 0106, qui s'était trompée de clé.** La 0106
rattachait un lien RCS à la BIBLIOTHÈQUE de messages (`rcs_messages`). Or une campagne porte son message
EMBARQUÉ, un bloc de scénario aussi, et la réponse rapide convertie en RCS le fabrique à la volée : seul
l'envoi manuel depuis l'inbox passe par la bibliothèque. Cette clé aurait donc tracé le cas le moins utile et
laissé sans mesure les deux qui comptent. **La leçon vaut au-delà du RCS : une clé étrangère choisie sur le
schéma, sans avoir suivi les appelants réels, désigne la table qu'on a sous les yeux, pas celle qui produit la
donnée.** Corrigée pendant que la colonne était encore vide (0 ligne, vérifié en base) ; une semaine plus tard
il aurait fallu la migrer au lieu de la retirer.

⚠️ **0107 se relit comme une règle de canal.** La clé d'un lien WhatsApp (template, langue, carte, bouton) sert
l'IDEMPOTENCE DE LA RÉSERVATION, parce qu'un template est soumis puis figé. Un message RCS n'est soumis à
personne, il est composé à l'envoi : il ne reste qu'à ne pas créer une ligne par destinataire, qu'un lien
d'hier résolve encore, et que les clics s'accumulent. `(tenant_id, destination)` fait les trois. Deux
conséquences heureuses : aucun `{{1}}`, donc **aucun risque de 132000 ni de « tout ou rien »** côté RCS ; et le
message STOCKÉ garde l'adresse saisie, donc **rien à ré-habiller à l'affichage**, contrairement aux templates.

⚠️ **0105 n'était PAS bloquante**, et c'est ce qui a permis de l'écrire trois commits avant de l'appliquer :
aucun code ne l'écrivait tant que les routes n'étaient pas livrées, et sa forme pouvait encore bouger en les
construisant. L'appliquer tôt aurait obligé à une 0106 corrective au premier ajustement. La règle « migrer
avant de déployer » vaut pour les migrations que le code ÉCRIT, pas pour celles qu'il ignore encore.

🔴 **0096 et 0097 sont jouées HORS TRANSACTION** (0096 est la première du dépôt à l'être), via la directive
`-- migrate: no-transaction` en tête de fichier, parce que `CREATE INDEX CONCURRENTLY` est interdit dans un
bloc de transaction. Deux conséquences à connaître avant d'en écrire une autre : elle n'a **aucun filet** (un échec à mi-parcours n'annule rien et la
migration est rejouée depuis le début, donc chaque instruction doit être idempotente), et le runner l'envoie
**instruction par instruction**, parce qu'une requête simple multi-instructions est exécutée par Postgres dans
une transaction implicite, ce qui rendrait la directive inopérante. `tests/migration-directives.test.ts` garde
les deux sens de la règle sur les fichiers réels.

🔴 **0104 est BLOQUANTE, et elle ferme le trou le plus cher du produit.** Deux avances concurrentes
(l'API traite un retour RCS pendant que le worker traite un webhook du même contact) ENVOYAIENT toutes les deux :
`setStateSiEncoreSur` protège l'état, mais elle arrive APRÈS les envois. Le contact recevait donc un message
qu'il ne devait jamais voir. Le tour est désormais RÉSERVÉ avant tout envoi, avec les trois pièces d'un vrai
verrou (bail, jeton de garde, libération explicite) et **sans drapeau de relance** : le perdant ne doit RIEN
rejouer, son message a été traité par le gagnant qui lisait le même bloc.
⚠️ **Et « réservé avant tout envoi » ne fermait QUE la course courte**, celle de deux avances qui démarrent
ensemble. La course LONGUE, le porteur pas mort mais seulement LENT, est restée ouverte jusqu'au lot 1 du plan
post-audit (2026-09-02) : un envoi Meta peut durer ~154 s en rejouant ses tentatives et une avance peut en
enchaîner plusieurs, donc le bail expirait pendant qu'on travaillait, un autre prenait le tour, et les deux
envoyaient. Aucune valeur de bail ne pouvait fermer ça, le nombre d'envois d'une avance n'étant pas borné :
seul un signe de vie PÉRIODIQUE distingue un porteur mort d'un porteur lent (`src/workflow/bail-avance.ts`,
cadence à un tiers du bail). Même lot, même famille : l'écriture d'état est désormais clôturée par le JETON,
un porteur périmé ne pouvant plus écrire par-dessus celui qui a repris le tour. Aucune migration, les deux
colonnes de la 0104 suffisaient.
⚠️ **Et battre ne suffisait pas non plus : ça rendait la perte VISIBLE sans rien ARRÊTER** (lot A2 de l'audit
externe, 2026-09-03). Le jeton clôture l'écriture d'ÉTAT ; il n'a jamais rien pu contre un message déjà remis
à Meta. Un porteur déchu finissait donc sa liste d'envois pendant que le nouveau faisait la sienne. Le
battement expose désormais `perduPourquoi()`, **consulté avant CHAQUE effet** (`apply`), avant l'envoi RCS de
`walkResolved` et avant l'enfilement d'un tour d'agent, qui est un appel modèle facturé. **La règle générale :
une garde de concurrence posée à l'ENTRÉE d'une liste d'effets ne prouve rien sur le dixième ; elle se pose
ENTRE les effets.** Même lot : une durée totale maximale de dix minutes (`DUREE_MAX_AVANCE_MS`) abandonne une
avance PENDUE, le seul mode de panne qu'un battement ne distingue pas d'un travail lent, puisqu'un minuteur
renouvelle un bail aussi fidèlement pour une promesse morte que pour un envoi en cours.
⚠️ **L'`AbortSignal` du battement n'est écouté par AUCUN transport, et c'est un choix, pas un oubli.** Un
envoi Meta ne porte pas de clé d'idempotence : couper la connexion en vol échangerait « un message de trop »
contre « un message parti que nous n'avons pas enregistré », donc invisible dans le fil. On laisse finir
l'effet en vol, on ne lance pas le suivant.
🔴 **Un tour d'agent tué par un crash était perdu POUR TOUJOURS** (lot A1, 2026-09-03). `prendreLeTour`
incrémente `tours` AVANT le travail, ce qui est ce qui rend le verrou optimiste atomique : un worker qui meurt
entre les deux fait rejouer le job par pg-boss avec l'ANCIEN numéro, la réservation rend `null`, le rejeu est
classé « doublon », la session reste `en_cours` et le run reste en attente SANS échéance (elle se pose à la fin
du tour, qui n'est jamais arrivée). Un balayage minute (`src/agent/tour-bloque-sweep.ts`) réclame les tours en
vol depuis plus de QUINZE minutes (l'écart avec `DUREE_MAX_AVANCE_MS` est délibéré, cf. la constante), les
clôt et fait sortir le parcours par la sortie RÉELLEMENT DUE, portée par la ligne réclamée.
⚠️ **On ne REJOUE PAS le tour, on le clôt**, et c'est tranché : le worker a pu mourir APRÈS avoir envoyé le
message au contact, et rien en base ne permet de le savoir. Rejouer risquerait un doublon chez le contact ;
clore fait au pire emprunter une branche que le client a rédigée.
⚠️ **Et il fallait une COLONNE, pas une déduction.** « Session `en_cours` + run en attente + aucune échéance »
semble reconnaître un tour mort : c'est EXACTEMENT l'état d'un tour qui vient d'être enfilé et attend son
passage dans la file, et `derniere_activite` ne les départage pas (elle porte l'instant du tour PRÉCÉDENT,
qui peut remonter à des heures). Un balayage bâti sur cette déduction aurait tué des conversations vivantes.
Le pendant : `tour_commence_le` DOIT être effacé sur les deux sorties qui laissent la session vivante
(l'agent a répondu, un humain a pris la main) ; `clore` s'en charge pour toutes les autres.
🔴 **0103 est BLOQUANTE, et sa règle vaut d'être connue : les deux raisons de pause ne se reprennent PAS
pareil.** Un plafond de DÉBIT (130429, ou un HTTP 429 sans code connu) est une limite de cadence : elle retombe
seule, donc la campagne repart automatiquement après un délai borné. Un plafond de QUALITÉ (131048) est un
jugement de Meta sur le numéro : relancer sans rien changer aggrave le problème et peut coûter le numéro, donc
`paused_until` reste NUL et **aucune machine ne lève cette pause**. `paused_until` nul veut dire « pas de
reprise automatique », et c'est le défaut : une pause dont on ne sait pas quoi penser ne repart pas toute seule.
⚠️ **0102 est bloquante, mais elle DÉGRADE PROPREMENT** : sans la table, chaque envoi retombe sur le frein
LOCAL du process et le signale dans les logs, c'est-à-dire exactement le comportement d'avant. C'est voulu :
un frein de débit protège la qualité d'un numéro, il n'AUTORISE pas l'envoi, donc son indisponibilité ne doit
jamais faire échouer un message. La migrer avant reste la règle, mais l'oublier ne casse rien.
🔴 **0101 est BLOQUANTE, et sa leçon vaut plus que sa ligne de SQL.** `recordOutbound` DÉDUISAIT l'origine de
l'expéditeur (« pas d'expéditeur, donc un scénario »), ce qui était vrai tant que ses seuls appelants étaient les
routes de la console. Le serveur MCP en a ajouté un sans expéditeur humain : chaque réponse d'agent tiers est
partie marquée « scenario ». Le pire n'était pas l'erreur mais son INVISIBILITÉ, la valeur fausse étant écrite
explicitement, donc le repli « indéterminée » ne pouvait pas se déclencher. **Une valeur déduite d'un autre champ
n'est une garde que tant que la liste des appelants ne bouge pas, et une liste d'appelants bouge toujours.** Le
paramètre est désormais obligatoire, comme sur `recordOutboundByWaId`.
⚠️ **0100 est BLOQUANTE** (chaque analyse écrit `summary`), donc migrée AVANT le déploiement. Sa colonne
reste vide pour les analyses d'avant, et elle le restera : reconstruire un résumé voudrait dire rappeler le
LLM sur tout l'historique. La fiche de conversation le DIT au lieu d'afficher `justification` à la place,
qui explique le classement et pas le contenu.
⚠️ **0099 est BLOQUANTE** (les quatre chemins d'envoi écrivent `origin` à chaque message sortant), donc migrée
AVANT le déploiement. Sa colonne est volontairement NULLABLE : un `not null` aurait fait échouer une insertion
sur le chemin chaud le jour d'un oubli d'appelant. La garde contre l'oubli est ailleurs, là où elle ne coûte
rien en production : le paramètre `origine` est OBLIGATOIRE dans la signature TypeScript, donc un chemin
d'écriture oublié ne compile pas. La lecture de l'historique est bornée dans le temps (`src/inbox/origine.ts`) :
après la bascule, une origine absente ressort en « indéterminée » À L'ÉCRAN plutôt que d'être versée en silence
dans le scripté.
⚠️ **0098 était BLOQUANTE** (`saveStatus` écrit `status_checked_at` à chaque relevé), donc migrée AVANT le
déploiement. **0095 l'était aussi** (le code écrit `draft_graph` à chaque enregistrement de l'éditeur), donc migrée
AVANT le déploiement. **0094 n'était qu'un INDEX, donc non bloquante. 0093, elle, l'ÉTAIT** : son code écrit
`phone_number_id` à chaque webhook entrant, et déployer avant de migrer aurait fait échouer TOUS les entrants,
exactement l'incident du 2026-08-17. C'est le cas d'école de la règle ci-dessus : le type de la migration
décide de l'ordre, et il faut se poser la question à chaque fois plutôt que d'appliquer une routine.

---
## DÉPLOYÉ le 2026-09-03 au soir : le contre-CONTRE-rapport, et ce qu'il dit de mes propres correctifs (migration 0113)

Quatre constats, trois confirmés. Mais l'intérêt du lot n'est pas là : **quatre des six défauts fermés ce
soir avaient été introduits le matin même**, par les correctifs du lot précédent. Ce qui suit est la
généralisation, parce qu'elle vaut plus que les lignes.

**ÉLARGIR LE DOMAINE D'UNE RÉPARATION SANS ÉLARGIR CE QU'ELLE TRANSPORTE.** Le balayage des tours bloqués
sortait le parcours par `sortie:echec` en dur. C'était exact tant qu'il ne réclamait que des sessions
`en_cours`, qui n'ont par construction aucune sortie enregistrée : `echec` était alors le seul code possible.
Le matin, on lui a fait ramasser aussi les sessions closes dont la sortie est restée due. La valeur en dur est
devenue fausse **le jour même**, et rien ne l'a signalé, ni le compilateur, ni les tests, ni la production.
Même famille, même jour : l'index PARTIEL de la 0112 portait `where status = 'en_cours'`, condition que la
requête venait de perdre. **Un index partiel est un contrat avec une requête précise**, et en sortir ne
produit aucune erreur, seulement un plan d'exécution qui change.

**LE SOUS-ENVOI SILENCIEUX, REFERMÉ TROIS LIGNES PLUS BAS.** En corrigeant le filtre d'exclusion des cibles de
campagne, j'avais écrit `Math.min(100_000, limite ?? 100_000)`. Il écrase en silence une limite plus grande.
Le plafond de campagne vit en configuration précisément pour se relever le jour d'un gros client : **le geste
que le produit a prévu était exactement celui qui armait le défaut**, et aucun schéma ne le refuse au
chargement. C'est le défaut que le commentaire d'à côté décrivait, transposé du filtre d'exclusion au filtre
de taille.

**DEUX CONSTANTES QUI DOIVENT ÊTRE ORDONNÉES SE RÈGLENT PAR UNE VALEUR.** `AGE_TOUR_MORT_S` valait
exactement `DUREE_MAX_AVANCE_MS`, dix minutes chacune. Lu séparément, chaque fichier a raison ; ensemble, la
marge est nulle et une avance qui va au bout de son temps rend sa ligne réclamable à l'instant où elle
abandonne. Le passage à quinze minutes rend aussi **inatteignable** une course réelle : `sortieAppliquee` n'a
pas de jeton de garde, donc un porteur en retard pouvait effacer le bail du balayage qui avait repris sa
session. Le jeton coûterait deux signatures ; la constante coûte cinq minutes de détection.

**UN INVENTAIRE DE CHEMINS SENSIBLES ÉCRIT À LA MAIN DÉRIVE.** Le `CLAUDE.md` affirmait qu'il y avait trois
chemins où une URL saisie par un client finit dans un `fetch`. Il y en avait quatre : l'épreuve d'une source
appelait `construireCible` puis `fetch`, sans résoudre. Ce qui l'a fait rater est instructif : les deux
boutons « Test » se ressemblent beaucoup, et **l'autre appelait bien la garde**. L'inventaire est passé d'un
paragraphe à un test. ⚠️ Dont la première version était creuse : elle cherchait l'identifiant sans retirer les
lignes d'`import`, donc elle passait alors même que l'appel avait été supprimé. Trouvé par mutation.

**ET DEUX TESTS QUI NE PROUVAIENT PAS CE QU'ILS ANNONÇAIENT.** Le pire du lot, parce que c'est la faute que ce
dépôt interdit nommément. Le premier n'assertait que « un signal est passé », ce qui vaut pour un plafond de
dix minutes comme de dix secondes ; le second passait AUSSI sans la garde qu'il prétendait tenir. Ce qui rend
le piège facile : **les faux minuteurs de vitest ne pilotent pas `AbortSignal.timeout`** (mesuré : onze
secondes de faux temps, signal toujours pas abandonné), donc sans durée injectable, le seul test possible
était le test creux.

**CE QU'ON A REFUSÉ, ET POURQUOI ÇA COMPTE AUTANT.** L'escalade humaine est le seul couple « clore puis
sortir » qui ne préserve pas la marque. Les faits du constat sont vrais. On ne l'aligne pas : le rattrapage
existant (au message suivant du contact, `advance` remonte le fil en inbox ET escalade) produit un MEILLEUR
état final que le balayage, et le contact qui vient de réclamer un humain face à un silence total réécrit
presque toujours. **Une reprise automatique ne vaut mieux qu'une reprise existante que si elle produit le même
état final** ; ici l'uniformité aurait été une régression déguisée en cohérence.

---
## COMMITÉ le 2026-09-03 (déployé le jour même) : le contre-rapport de ChatGPT, huit constats vérifiés

Cinq confirmés, trois à moitié. Le tri complet est dans `todo.md` ; ce qui suit est ce qu'aucun autre document
ne consignerait, c'est-à-dire les gotchas et les raisons.

**Le correctif évident de la transition terminale était FAUX, et c'est le détour le plus instructif du lot.**
Une sortie terminale de tour d'agent est deux écritures : clore la session, faire sortir le parcours du bloc.
Un crash entre les deux tuait le parcours pour toujours. Le réflexe est d'inverser l'ordre, pour qu'une panne
laisse une session vivante plutôt qu'un parcours orphelin. Ça ne marche pas ici : `sortirDuBlocAgent` fait
AVANCER le parcours, qui peut retomber sur un autre bloc agent DANS LE MÊME APPEL, et `demarrerTourAgent`
réutilise alors la session encore vivante (`byRun ?? open`) avec ses tours et son budget déjà consommés, donc
le nouvel agent serait muet dès son premier tour. La fenêtre n'est pas de quelques millisecondes comme on
l'imagine, elle couvre tout l'appel. **La réparation passe par la marque, pas par l'ordre** : on clôt d'abord,
la clôture LAISSE `tour_commence_le` tant que la sortie reste due, et `sortieAppliquee` l'efface après coup.

**Et le réparateur portait le même défaut que ce qu'il réparait.** `reclamerToursBloques` posait
`status = 'erreur'` ET `tour_commence_le = null` dans la même requête, alors que son propre prédicat exigeait
les deux inverses : la ligne devenait inatteignable pour DEUX raisons indépendantes, donc un échec de SA
seconde écriture condamnait aussi le parcours. Son commentaire le concédait à demi-mot (« récupérable à la
main »). La réclamation POSE désormais un bail (`tour_commence_le = now()`) au lieu d'effacer, et son prédicat
a perdu sa condition de statut pour ramasser aussi les sessions closes dont la sortie est restée due.

**Deux gardes MIROIR pour un seul marqueur.** `finirLeTour` (`status = 'en_cours'`) sert le chemin qui laisse
la session vivante, `sortieAppliquee` (`status <> 'en_cours'`) celui qui l'a close. Réutiliser la première
pour les deux aurait été tentant et aurait retiré son fencing : un porteur de tour périmé aurait pu effacer la
marque posée par le balayage qui venait de reprendre sa session.

**La classification IPv6 : cinq cas sur huit ratés, mesurés.** `startsWith('fe80:')` ne décrit pas
`fe80::/10`, qui fait dix bits et va jusqu'à `febf`. Et `::ffff:ac12:1` EST `172.18.0.1`, la passerelle du
réseau Docker du VPS : la regex d'IPv4 mappée n'acceptait que la notation décimale. **Une plage d'adresses se
compare en arithmétique, jamais en préfixe de chaîne** : un préfixe de texte décrit ce qu'on a en tête, pas ce
que la norme définit, et l'écart ne se voit sur aucun exemple qu'on pense à écrire.

**Un filtre en mémoire ne rattrape jamais ce qu'un filtre en base a coupé.** La résolution d'une cible de
campagne tranchait à `limite` en SQL puis retirait les exclus ensuite : elle sous-envoyait, en silence, le
nombre affiché à l'opérateur étant celui qu'on venait de calculer.

**Ce qui a été mesuré plutôt que supposé, et qui a changé la réponse :** le bouton « Test » sans `signal`
n'était pas illimité mais borné au défaut d'undici, **309 s** contre un serveur qui accepte et ne répond
jamais ; et il n'immobilisait PAS une connexion du pool, les lectures en base étant terminées avant l'appel.
Le constat restait vrai (trente fois le plafond du bouton jumeau, sur un hôte que le client choisit), mais
deux de ses trois arguments étaient faux.

**Et un réglage peut trancher une question avant tout banc de charge.** `attente = N × T / C − T` : avec une
tranche de 2 min et 4 runs simultanés, le SLO d'équité tient jusqu'à environ 13 campagnes longues
simultanées, pas 25. Aucun banc n'aurait pu faire mieux que constater l'échec. **Rien n'a été touché en
production pour autant** : les deux leviers ont un coût non mesuré (un `listPending` non borné d'un côté, un
pool de 8 connexions de l'autre) et la charge d'aujourd'hui est de six jobs sur sept jours.

---
## DEPLOYE le 2026-09-02 au soir : la recherche de connaissance apprend le SENS (migrations 0110-0111)

Julien : « en bornant à 3 fiches sur 500, tu renvoies potentiellement 1 % du contenu... faut vectoriser ! ».
Il avait raison, et mon objection (« le coût est déjà borné ») était l'argument INVERSE du bon : plafonner à
trois fiches rend la qualité du tri PLUS critique, pas moins.

**Le défaut que le code documentait déjà.** `ficheEstPertinente` n'accepte une fiche que sur des motifs
LEXICAUX, et son commentaire disait : « une question sans le moindre mot commun ne fait remonter AUCUNE fiche,
donc la sortie tombe de toute façon ». Présenté comme une garantie de sûreté, et c'en est une. Mais « c'est
combien pour résilier » et « Conditions de sortie de contrat » n'ont aucun mot en commun.

🔴 **CE QUE LA MESURE A INTERDIT, et ce n'est pas ce que j'allais écrire.** J'allais ajouter une quatrième
règle « similarité >= X ». Impossible : une question HORS SUJET remonte une fiche à **0,361** quand une vraie
question descend à **0,299**. Les deux populations se chevauchent, aucun seuil n'est posable, et en écrire un
aurait fait sauter la garde anti-hallucination, qui est la propriété la plus importante du produit.

**La raison est structurelle.** Un embedding est un **bi-encodeur** : il encode la question et la fiche
SÉPARÉMENT puis compare. Son cosinus répond à « ces deux textes se ressemblent », pas à « cette fiche RÉPOND à
cette question ». Et il rend TOUJOURS un classement : il y a toujours une fiche « la moins loin ».

**Un reranker, lui, sépare.** Cross-encodeur : il lit la question ET la fiche ensemble, et rend un score
calibré. `cohere/rerank-v3.5` place les vraies questions au-dessus de **0,0817** et le hors-sujet sous
**0,0409**. ⚠️ Et le modèle le plus RÉCENT est le moins bon pour notre usage : `rerank-v4-fast` laisse le
hors-sujet monter au-dessus des vraies questions. Prendre la dernière version par réflexe aurait reproduit le
défaut qu'on corrigeait.

**L'architecture, trois étages, chacun faisant ce qu'il sait faire :**

1. **RAPPEL** large et pas cher : l'union du plein texte + trigramme (imbattable sur une référence produit ou
   un numéro de contrat) et du vectoriel (imbattable sur l'intention). On ne cherche pas la précision ici, on
   cherche à ne rien manquer. `AGENT_RAPPEL_CANDIDATS = 12`.
2. **VERDICT** calibré : le reranker note, le seuil décide (`AGENT_RERANK_SEUIL = 0,06`, milieu de
   l'intervalle mesuré). C'est LUI qui porte la garde anti-hallucination désormais.
3. **BORNE** inchangée : les 3 meilleures, tronquées à 2 000 caractères. **Le contexte envoyé au modèle ne
   bouge pas d'un octet** ; ce qui change, c'est LESQUELLES.

🔴 **LE BALAYAGE EST LE SEUL ENDROIT QUI CALCULE UN VECTEUR**, et c'est délibéré. Il y a TROIS chemins
d'écriture de fiche, donc trois occasions d'oublier ; le dépôt a payé ce prix le jour même avec le 131008. Ici,
un quatrième chemin est vectorisé sans que personne y pense. Deux bénéfices de plus : une panne du Gateway
n'empêche pas d'enregistrer une fiche, et le rattrapage des fiches existantes est gratuit (même cas que « pas
encore vectorisée »). Le prix, assumé : une fiche créée il y a dix secondes n'est trouvable que par les MOTS.

⚠️ **L'édition d'une fiche EFFACE son vecteur.** Un vecteur qui décrit l'ANCIEN texte est pire qu'une absence
de vecteur : il fait remonter la fiche sur des questions qu'elle ne traite plus.

**Les replis perdent le gain, jamais la garde.** Vectoriseur en panne -> plein texte seul. Reranker en panne ->
retour à la règle lexicale, et une fiche venue du seul rappel vectoriel (couverture zéro) est alors écartée.

⚠️ **La dimension 1536 est figée par le modèle** (`cohere/embed-v4.0`, choisi parce qu'il place la bonne fiche
en premier 6 fois sur 6 en FRANÇAIS, là où deux concurrents la placent deuxième à 0,009 près). En changer
oblige à recalculer les vecteurs de tous les clients : c'est un balayage, pas un drame, mais ça se décide une
fois. `embedding_modele` existe pour le faire progressivement plutôt que de vider la colonne d'un coup.

Bancs reproductibles : `scripts/mesure-embedding.mts` (choix du modèle, épreuve hors-sujet, reranker) et
`scripts/mesure-tour-agent.mts` (tour réel, concurrence). Détail des mesures :
`docs/MESURE-RECHERCHE-CONNAISSANCE-2026-09-02.md` et `docs/MESURE-TOUR-AGENT-2026-09-02.md`.

### ⚠️ Deux défauts de MESURE trouvés par l'audit externe, et corrigés le soir même (migration 0111)

Ils ne cassaient rien, ils **mentaient**, ce qui est pire pour un écran d'exploitation.

1. **La carte du pool colorait sur le mauvais chiffre.** Rouge dès `max_ms >= 50`, or `max_ms` inclut
   l'ouverture normale d'une connexion neuve (TCP + TLS), parfaitement normale et massive au démarrage. Une
   barre rouge pouvait donc s'afficher avec ZÉRO attente sur pool saturé. Le seau retient désormais DEUX
   maximums (`max_ms` et `max_attente_ms`), et **seul le second colore**.
2. **La télémétrie se mesurait elle-même.** Le vidage écrit son seau PAR LE POOL INSTRUMENTÉ : cette écriture
   devenait le premier échantillon de la minute suivante, la télémétrie s'auto-alimentait, et la promesse
   « aucune ligne sur un process au repos » était fausse dès la première activité. `sansSeMesurer` suspend la
   mesure pendant l'écriture, avec un COMPTEUR (deux suspensions imbriquées ne se désactivent pas) et un
   `finally` (une panne de base ne doit pas rendre la mesure sourde à vie).

---
## DEPLOYE le 2026-09-02 : tracer et attribuer les liens des messages RCS (migration 0107)

Julien : « il faut aussi que ça marche si j'envoie un RCS hein ? ». Le pendant RCS de l'attribution des clics
livrée le même jour pour WhatsApp (0106).

🔴 **LA 0106 S'ÉTAIT TROMPÉE DE CLÉ, et c'est le vrai enseignement du lot.** Elle avait posé
`tracked_links.rcs_message_id`, une référence vers `rcs_messages`, la BIBLIOTHÈQUE. La reconnaissance faite en
écrivant le code a montré que cette clé ne couvrait presque rien : une campagne RCS porte son message
EMBARQUÉ (`campaigns.rcs_message`), un bloc de scénario aussi (dans le graphe), la réponse rapide convertie en
RCS le fabrique à la volée, et SEUL l'envoi manuel depuis l'inbox lit la bibliothèque par identifiant. La clé
aurait donc tracé le cas le moins utile et laissé sans mesure les deux qui comptent.

**La règle à en tirer** : une clé étrangère choisie sur le SCHÉMA, sans avoir suivi les appelants réels,
désigne la table qu'on a sous les yeux, pas celle qui produit la donnée. Ici l'erreur a coûté une migration
corrective écrite le jour même (colonne encore vide, 0 ligne vérifiée en base) ; une semaine plus tard il
aurait fallu migrer des données au lieu de retirer une colonne.

**La clé retenue : `(tenant_id, destination)`.** Elle se déduit de la nature du canal, pas d'un goût. La clé
WhatsApp (template, langue, carte, bouton) sert l'IDEMPOTENCE DE LA RÉSERVATION : un template est soumis puis
figé, et le resoumettre doit retrouver le MÊME code sinon les messages déjà livrés pointent une ligne
orpheline. Un message RCS n'est soumis à personne : il ne reste qu'à ne pas créer une ligne par destinataire,
qu'un lien d'hier résolve encore, et que les clics s'accumulent. La destination fait les trois, et c'est la
clé la plus simple qui le fasse.

**Ce qui a emporté la décision : le point de passage unique.** Les quatre chemins d'envoi RCS convergent DÉJÀ
sur `RcsSender.sendTo`, dont le commentaire dit pourquoi les mises en forme vivent là (« y penser dans chaque
appelant serait exactement le genre d'oubli qui se voit six mois plus tard »). À cet endroit, la seule
identité disponible est l'URL. Toute autre clé obligeait à réécrire les liens dans quatre appelants.

**Deux conséquences heureuses de réécrire À L'ENVOI :**
- aucun `{{1}}`, donc **aucun risque de 132000** et **aucune garde « tout ou rien »** comme côté WhatsApp : sans
  jeton, on envoie simplement `/r/<code>`, que la route sert comme un lien anonyme ;
- le message STOCKÉ garde l'adresse saisie par l'utilisateur, donc **rien à ré-habiller à l'affichage**,
  contrairement aux templates (`rehabillerBoutons`). Un item du plan initial est mort de lui-même.

**Le cache est structurel, pas une optimisation.** `TraceurLiensRcs` mémorise `tenant\0adresse -> code` pour la
durée du process : sans lui, une campagne de 5 000 destinataires ferait 5 000 allocations de la même adresse
sur le chemin le plus chaud du produit. Il est sûr POUR TOUJOURS parce que l'association est immuable (index
unique de la 0107, aucun code jamais réattribué). Éviction FIFO bornée à 1000 entrées.

**Le jeton : batch côté masse, unitaire côté scénario.** Une campagne charge les jetons de tous ses
destinataires en UN énoncé (`jetonsPourContacts`), et seulement si le message porte un lien traçable
(`CampaignSender.aBesoinDeJeton`, calculé une fois sur le message figé). Un scénario ou l'inbox, qui écrivent à
une personne à la fois, lisent par numéro (`jetonPourE164`), et seulement si le message porte un lien : on ne
fabrique pas d'identifiant public pour quelqu'un à qui on n'envoie rien à cliquer.

**Ce qui rend enfin l'attribution VISIBLE : « Engagé » compte le clic.** La 0106 ÉCRIVAIT `contact_id` sur
chaque clic mais rien ne le LISAIT nulle part. Et l'indicateur « engagé » du mini-CRM ne regardait que les
messages entrants, or un bouton URL fait SORTIR le contact de la conversation : la personne la plus engagée de
la campagne s'affichait comme n'ayant pas réagi. Les deux trous se ferment l'un l'autre. Seuls les clics
ATTRIBUÉS créditent quelqu'un ; un clic anonyme (template d'avant le 2026-09-02) ne crédite personne, ce qui
vaut mieux que d'attribuer un geste à la mauvaise personne.

**Mesures : un espace de noms de handle à part (`lien:<i>`), et c'était le piège.** Les sorties d'un bloc RCS
s'appellent déjà `btn:0`, `btn:1`… mais elles ne comptent QUE les boutons RÉPONSE (`normaliserPostbacks`), un
bouton lien ne revenant jamais dans la conversation. Numéroter les liens dans ce même espace aurait fait porter
« a cliqué sur le lien » et « a cliqué Oui » par la MÊME clé sur un même bloc, y compris dans les tableaux
DÉJÀ enregistrés par un opérateur. L'index est celui de la liste plate `data.suggestions`, que le serveur
numérote et que l'écran relit pour nommer le bouton : les deux ne peuvent pas diverger sur l'ordre.

⚠️ Un lien RCS sans code alloué vaut **zéro** au lieu de disparaître de l'écran. Ce n'est pas une anomalie
comme côté WhatsApp : le code naît au PREMIER ENVOI, pas à la soumission. Zéro est alors la vérité exacte
(rien n'est parti, personne n'a cliqué), et c'est ce qui rend la mesure cochable avant que le scénario n'ait
tourné.

**Une adresse démesurée n'est PAS tracée** (`URL_TRACABLE_MAX = 1000`) : la clé d'unicité porte sur
`destination`, et un index btree refuse une valeur trop longue, ce qui ferait échouer l'allocation donc
l'envoi. Un lien non mesuré est un défaut de mesure ; un message qui ne part pas est un défaut de produit.

🔴 **UN DÉFAUT PARTI EN PRODUCTION LE MATIN MÊME, ET TROUVÉ APRÈS DÉPLOIEMENT.** L'API monte
`GET /r/:code/:jeton` et les templates partaient chez Meta avec `/r/<code>/{{1}}`, mais le rewrite de
`web/next.config.mjs` ne déclarait que `/r/:code`. **Un rewrite Next ne capture QU'UN segment** : la forme
attribuée n'atteignait jamais le backend, Next rendait une 404. Tout était vert (3454 unitaires, 417 e2e, CI
complète) parce que l'e2e MOCKE le backend et ne traverse jamais le proxy réel.

Ce que ça aurait coûté : en base, le template `tarifs` était DÉJÀ approuvé par Meta avec cette forme, et un
template approuvé porte son URL POUR TOUJOURS. Au premier envoi, chaque destinataire aurait reçu un lien mort,
irréparable autrement qu'en resoumettant un template. Personne ne l'a subi (aucune campagne ne l'utilisait,
zéro message envoyé, vérifié en base).

**La règle qui en sort** : la route et sa règle de proxy sont deux moitiés dans deux dépôts de configuration
différents, et rien dans le langage ne les relie. Une route publique neuve n'est pas livrée tant que son
rewrite ne l'est pas. Le garde-fou est `tests/web-rewrites-liens.test.ts`, qui DÉRIVE la liste des routes de
`src/http/links.ts` et casse si l'une d'elles n'a pas sa règle ; la mutation qui retire la ligne reproduit
exactement le défaut. Et la vérification post-déploiement se fait sur le chemin **PUBLIC** : un appel interne
au conteneur aurait réussi, précisément là où le proxy était le coupable.

⚠️ **Erreur de méthode à ne pas refaire** : un `git checkout <fichier>` pour annuler une mutation de test a
effacé les modifications NON COMMITÉES du même fichier. Sur du travail non commité, on restaure depuis une
copie, jamais depuis l'index.

### 🔴 L'incident 131008 du soir même : QUATRE défauts d'une seule famille (44a720f, 8943736)

Julien lance « Test Ciné 4 » en fin de journée : chaque destinataire échoue en **131008 « Required parameter
is missing »**, sans rien d'anormal dans le scénario. La cause est dans la base de production et dans la
définition du template chez Meta : ses deux boutons URL ont été soumis le matin même sous la forme
`/r/<code>/{{1}}`. **Un `{{1}}` dans une URL de bouton EXIGE son composant `sub_type: url` à chaque envoi.**
Aucun n'était produit, par quatre chemins indépendants, chacun suffisant à tout casser :

1. **Le passe-plat perdu** (campagnes directes). `boutonsTraces` et `jetonsPourContacts` étaient câblées dans
   le worker, mais absentes du `Pick` de `RunJobDeps` et de la construction d'`optionsMoteur`. Elles
   arrivaient dans un **spread**, qui échappe au contrôle des propriétés en trop : `tsc` vert, tests du moteur
   verts (ils appellent `runCampaign` en direct, pas `campaignRunJob`), et plus aucun template tracé ne
   partait.
2. **Le chemin scénario** ne produisait aucun composant de bouton URL par construction :
   `buildWorkflowTemplateComponents` ne connaissait que `quick_reply` et `flow`. Il aurait continué d'échouer
   après le correctif 1. Le calcul est désormais fait dans `wiring.ts` en RÉUTILISANT la règle des campagnes,
   pas en écrivant une seconde qui divergerait.
3. **Le repli était à l'envers.** Sans jeton, le code ne produisait aucun composant, en annonçant « on perd la
   mesure, on ne perd pas le message ». C'est l'inverse : le template étant déjà approuvé avec `{{1}}`, l'appel
   est refusé et RIEN ne part. **Ce qui décide, c'est le TEMPLATE, jamais l'état du jeton d'un contact.** Sans
   jeton on envoie donc un suffixe anonyme : le lien redirige (302, vérifié en production), le clic est compté,
   il n'est rattaché à personne.
4. **Le bouton de CARTE de carousel** (trouvé en vérifiant que les trois autres étaient bien tous les trous).
   `boutonsTracables` traçait aussi les boutons portés par les cartes, mais `buildTemplateComponents` ne sait
   produire que `{ type: 'button', index }`, qui adresse un bouton DU TEMPLATE : un bouton de carte se désigne
   autrement, et rien ne sait le faire. Un carousel à bouton URL soumis après le 2026-09-02 aurait échoué à
   chaque envoi, **définitivement**, l'URL étant figée chez Meta une fois le template approuvé. Zéro occurrence
   en base au moment du correctif : le piège était armé, il n'avait pas encore servi. La règle vit désormais à
   UN seul endroit (`estAttribuable`, `src/http/templates.ts`) et `avec_jeton` n'est plus codé en dur à `true`
   dans `allocate`, c'est l'appelant qui décide.

**La leçon qui vaut au-delà du 131008 : un `Pick` utilisé comme passe-plat est un FILTRE SILENCIEUX.** Les
propriétés qui arrivent par un spread échappent au contrôle des propriétés en trop, donc le compilateur accepte
ce qu'il va jeter. Une dépendance ajoutée d'un côté et oubliée de l'autre ne produit aucune erreur, seulement
une fonctionnalité qui disparaît. Partout où une liste de dépendances est recopiée, la recopie est le point
faible, et le commentaire d'avertissement est posé dessus (`src/campaign/run-job.ts`).

**Deuxième leçon, de méthode : un test qui n'entre pas par la même porte que la production ne garde rien.** Les
tests du moteur appelaient `runCampaign` directement et étaient tous verts pendant que la production échouait à
100 %. Les tests de garde partent maintenant de `campaignRunJob`, le point d'entrée réel, et la mutation qui
remet le défaut fait tomber le test sur le symptôme exact (une liste de composants vide).

**Troisième leçon, sur Meta : 131008 et 132000 sont symétriques et tous deux fatals.** Un composant manquant
pour une URL à `{{1}}` rend 131008 ; un composant fourni pour une URL SANS variable rend 132000. Il n'y a pas
de « au cas où » possible : le composant se produit si et seulement si le template porte la variable. C'est
aussi ce qui rend le **RCS immunisé** (aucun `{{1}}`, message composé à l'envoi, cf. la note de la 0107).

---
## DEPLOYE le 2026-09-02 : le connecteur API digne de ce nom (migration 0105)

Constat de Julien : « selon les doc API que le user aura pour setuper ce connecteur tool, il ne pourra pas
faire grand chose avec ce qu'on lui propose là ». Vérifié dans le code, il avait raison sur toute la ligne :
`fetch(url, { method, headers })` **sans corps**, des paramètres qui ne remplissaient qu'un gabarit de CHEMIN,
et des variables limitées à `wa_id` et `nom` alors que dix champs personnalisés sont déclarés en production.

**Migration 0105** : `connector_requests` + `agent_tools.request_id`. Un appel est désormais décrit UNE fois
dans la bibliothèque du workspace, puis ouvert aux agents, au lieu d'être redécrit dans chaque agent. Même
raison que pour la source elle-même : ce qui appartient au client ne se range pas dans un agent.

**Les deux modes de corps compilent vers le MÊME arbre**, puis passent par UNE seule substitution. C'était la
demande de Julien (« il faut qu'on puisse avoir les 2, du JSON brut pour les mecs habitués et une liste de
champs ») et c'est aussi ce qui rend la sécurité tenable : la substitution est **STRUCTURELLE**, jamais
textuelle. Une valeur ne peut donc pas refermer une chaîne JSON et injecter des clés. Deux moteurs séparés
auraient divergé au premier ajustement, et le mode « JSON brut » aurait été le maillon faible.

Autres gardes du lot : `EN_TETES_RESERVES` (`authorization`, `content-type`, `content-length`, `host`) qu'un
utilisateur ne peut pas écraser ; `cheminsDeLaReponse` ne propose QUE les chemins que l'extracteur sait
résoudre, les tableaux étant proposés entiers, pour qu'aucune case cochée ne rende systématiquement du vide.

🔴 **TROIS DÉFAUTS TROUVÉS EN CONSTRUISANT, DONT DEUX PAR DES TESTS QUI VISAIENT AUTRE CHOSE.**

1. **`.partial()` de zod ne retire PAS les `.default()`.** Un `patch` construit avec `.partial()` renvoyait donc
   les valeurs par défaut pour toute clé absente : **renommer une requête aurait effacé toutes ses variables,
   ses paramètres, ses en-têtes et son corps, EN SILENCE**. Corrigé à la racine (les défauts ne vivent plus que
   sur le schéma de création), gardé par un test qui vérifie que le store ne reçoit QUE les clés changées.
   La règle : un schéma de mise à jour partielle ne se dérive pas d'un schéma de création qui porte des défauts.
2. **Une réponse mal formée BLANCHISSAIT tout l'onglet Outils d'un agent** (un `.map` sur `undefined`), y
   compris la liste des outils maison qui n'a rien à voir. Trouvé par huit tests e2e PRÉ-EXISTANTS qui
   échouaient : la leçon est qu'un composant qui affiche une liste venue du réseau doit se défendre seul.
3. **`requis` ne servait à rien** : une variable dont la valeur était inconnue partait en `null` sans
   distinction. La garde manquait dans le résolveur, pas dans l'écran.

⚠️ **0105 n'était PAS bloquante**, et c'est ce qui a permis de l'écrire trois commits avant de l'appliquer :
aucun code ne l'écrivait tant que les routes n'étaient pas livrées, et sa forme pouvait encore bouger en les
construisant. La règle « migrer avant de déployer » vaut pour les migrations que le code ÉCRIT.

⚠️ **Erreur de méthode à ne pas refaire** : `deb71ed` a été poussé après n'avoir lancé QUE le spec e2e des
connecteurs, alors que le lot touchait un onglet PARTAGÉ. La CI est restée rouge une heure et quart sur huit
tests que la suite complète aurait montrés tout de suite. Toucher un composant partagé impose la suite entière.

---
## DEPLOYE le 2026-09-02 : voir et rejouer les jobs MORTS

Le dépôt ALERTAIT déjà quand une file d'échec se remplissait, mais la seule reprise possible était de renvoyer
le message à la main, ce qui ne passe pas l'échelle. Un job qui épuise ses rejeux part en file d'échec, que
**rien ne consomme** : il y reste pour toujours.

🔴 **Pour un `webhook`, un job mort est un MESSAGE DE CLIENT jamais traité.** C'est le pire cas du dépôt parce
qu'il est silencieux : le client a écrit, le scénario n'a pas avancé, et personne ne le sait.

### Deuxième écriture métier de `/ops`, et pourquoi elle y a sa place

Le CLAUDE.md exige qu'aucune écriture ne rejoigne cette surface sans la même justification que le rechargement
de solde. Elle tient : rejouer un traitement mort est un geste d'EXPLOITATION par nature. Il est cross-espace,
il suppose qu'on ait corrigé la cause de l'échec, et il ne doit jamais être accessible depuis un compte de la
console, sans quoi un client rejouerait des traitements sans savoir pourquoi ils avaient échoué.

### Trois décisions qui portent le reste

🔴 **Enfiler PUIS oublier, jamais l'inverse.** L'ordre décide du mode de panne : un crash entre les deux
produit un DOUBLON, l'ordre inverse produirait une PERTE. Le doublon est rattrapé partout où ça compte
(déduplication du message entrant, réclamation atomique d'un destinataire, verrou de run) ; la perte n'est
rattrapée nulle part. Un test le prouve dans les deux sens.

🔴 **La file est OBLIGATOIRE, il n'y a pas de « tout rejouer ».** Un rejeu global relancerait campagnes et
webhooks ensemble, sur des causes d'échec différentes qu'on n'a pas toutes corrigées. Le lot est borné à 100,
pour forcer à regarder entre deux passes.

⚠️ **La lecture d'abord.** `GET /ops/dlq` montre les plus anciens avec leur erreur tronquée. Rejouer sans
regarder, c'est relancer en masse des traitements qui ont échoué pour une raison qu'on n'a pas corrigée.

---
## DEPLOYE le 2026-09-01 : le tour d'avance est RÉSERVÉ avant les envois (migration 0104)

Le trou le plus cher du produit, documenté dans `executor.ts` depuis des semaines sous la forme « cette garde
protège l'ÉTAT, pas les effets ». Il est fermé.

**Ce qui se passait.** Deux avances peuvent se chevaucher DÈS AUJOURD'HUI, avec un seul worker : l'API traite
un retour RCS pendant que le worker traite un webhook du même contact. Les deux lisaient le run sur le bloc N,
calculaient chacune leur suite, **envoyaient toutes les deux**, et seule la seconde écriture était refusée. Le
contact recevait donc deux messages, dont un qu'il ne devait jamais voir.

**Le seul correctif possible** est de réserver le tour AVANT les effets, pas après. `setStateSiEncoreSur` reste
en place : elle devient la ceinture, la réservation étant la bretelle. Deux gardes qui se recouvrent valent
mieux qu'une seule sur un chemin qui envoie de l'argent.

### Les trois pièces, et la quatrième qu'on n'a PAS mise

Mêmes pièces que le verrou de run de campagne (`src/campaign/run-lock.ts`), parce que ce sont elles qui font la
différence entre un verrou et un drapeau :

- un **bail** (`avance_jusqu_a`) : un worker tué en plein traitement ne bloque pas le parcours à vie ;
- un **jeton** (`avance_token`) : le porteur d'un bail périmé, revenu tard, ne peut pas libérer le verrou de
  celui qui l'a repris entre-temps ;
- une **libération explicite** dans un `finally`, y compris quand un envoi jette : sinon le message SUIVANT du
  contact attendrait la fin du bail pour rien, sur un parcours parfaitement sain.

⚠️ **PAS de drapeau de relance**, à la différence du verrou de campagne, et c'est un choix. Le perdant d'une
avance ne doit RIEN rejouer : son message a été traité par le gagnant, qui lisait le même bloc. Un drapeau de
relance ferait avancer le parcours deux fois, c'est-à-dire recréerait le défaut à l'envers.

⚠️ **Perdre la réservation n'est pas une erreur**, c'est le cas normal quand deux messages du même contact
arrivent ensemble. Le perdant sort sans rien faire, en le journalisant (« avance IGNOREE ») : une course qu'on
ne voit pas est une course qu'on ne corrigera jamais.

### Ce que ça ne ferme toujours pas

Le crash APRÈS un succès fournisseur mais AVANT la persistance. Sans clé d'idempotence acceptée par Meta,
l'exactly-once est impossible : le compromis reste « un rejeu possible plutôt qu'une perte », et il est assumé.

---
## DEPLOYE le 2026-09-01 : la liste des scénarios ne transporte plus les graphes

Dernier constat du contre-audit. `PgWorkflowStore.list` renvoie **deux graphes complets par ligne** (le publié
et le brouillon, tous deux dans `COLS`) à des écrans qui n'affichent qu'un nom : la page Scénarios, la liste
des blocs, le sélecteur de campagne, l'inbox, les automations, les webhooks. Avec quelques dizaines de
scénarios c'est indolore ; avec des centaines de graphes riches, chaque écran paie le transfert et l'analyse
de tous les JSON.

Ce que les écrans TIRAIENT réellement du graphe se résume à trois choses, qui deviennent trois champs :
`nodeCount`, `hasDraft`, `campaignEligible`. Les deux premiers se calculent en SQL sans rien transporter ; le
troisième demande un parcours du graphe, et il est donc calculé côté serveur avec `scanOpening`, **la même
fonction que la garde de création de campagne** (parité déjà gardée par `tests/web-campaign-eligibility.test.ts`).
L'écran ne peut donc plus proposer un scénario que la création refuserait.

⚠️ **`list()` n'a PAS changé**, et c'est délibéré : la résolution d'un scénario ou d'un bloc par code
(`/v1/sends`) a réellement besoin des graphes. C'est `listResume()` qui sert le navigateur.

⚠️ **Ce que ça ne fait pas.** La base envoie toujours le graphe à l'application, puisque l'éligibilité en a
besoin. Ce qui disparaît est le trajet application vers navigateur et l'analyse JSON côté client, c'est-à-dire
ce que les écrans paient vraiment. Aller plus loin demanderait de dénormaliser le nombre de blocs et
l'éligibilité en colonnes tenues à l'écriture, avec le risque de péremption que ça implique : à faire le jour
où la lecture en base pèse, pas avant.

### Les deux endroits qui avaient VRAIMENT besoin du graphe

L'écran d'édition appelait déjà `GET /workflows/:id` à l'ouverture : rien à changer. Le formulaire de campagne,
lui, cherche le template d'ouverture à paramétrer : il charge désormais le graphe **au moment où l'opérateur
choisit son scénario**. Un aller-retour à ce moment-là est très largement préférable à N graphes à chaque
ouverture d'écran.

Chaque lecture côté client garde un repli sur l'ancien calcul (`campaignEligible ?? isCampaignEligible(graph)`)
: deux conteneurs ne redémarrent pas à la même seconde, et le temps d'un déploiement le front neuf peut
interroger l'API d'avant.

---
## DEPLOYE le 2026-09-01 : la reprise après un plafond Meta (migration 0103)

Troisième constat du contre-audit. Sur un plafond, le moteur rendait déjà le destinataire à la file et mettait
la campagne en pause, sans perdre personne. Mais **aucune routine ne la repassait en `running`** : il fallait
un clic, alors que le texte affiché promettait une reprise automatique. Le texte a été corrigé le jour même ;
ce lot apporte la reprise.

### La seule décision qui compte : les deux raisons ne se reprennent pas pareil

- **Débit** (130429, ou un HTTP 429 sans code connu) : une limite de CADENCE. Elle retombe seule, donc on
  réessaie après un délai borné. C'est le seul cas repris automatiquement.
- **Qualité** (131048) : Meta juge le NUMÉRO. Relancer sans rien changer aggrave le problème et peut coûter le
  numéro. `paused_until` reste nul, aucune machine ne lève cette pause, et c'est un humain qui décide.

`paused_until` nul veut donc dire « pas de reprise automatique », et c'est le DÉFAUT : une pause dont on ne
sait pas quoi penser (y compris celle qu'un opérateur pose à la main) ne repart pas toute seule.

### Trois choses à connaître avant d'y toucher

⚠️ **Un HTTP 429 sans code connu est désormais un plafond.** Angle mort relevé par l'audit : il était rejouable
dans le transport mais n'entrait pas dans `estPlafondNumero`. Une fois les tentatives épuisées, il finissait en
ÉCHEC DU DESTINATAIRE, qui n'y est pour rien et devient injoignable sans intervention, pendant que le suivant
échouait pareil. « Trop de requêtes » ne parle jamais du destinataire, il parle de nous.

⚠️ **Le délai suit le `Retry-After` de Meta, mais BORNÉ** (1 min à 1 h, 15 min par défaut). C'est Meta qui sait,
mais un en-tête absurde ne doit pas décider seul du comportement d'une campagne.

🔴 **`setStatus` écrit TOUJOURS les deux colonnes, y compris à null.** Les laisser telles quelles sur une
reprise ferait qu'une campagne repartie garderait l'échéance de sa pause d'avant, et le balayage la
« reprendrait » une seconde fois alors qu'elle tourne déjà.

⚠️ **L'ordre du balayage est l'INVERSE de celui des campagnes programmées, et c'est voulu.** Là-bas on enfile
puis on marque, pour qu'un échec d'enfilement laisse la campagne reprise au tour suivant. Ici la reprise en
base est ce qui RÉCLAME la ligne (atomique) : elle doit venir d'abord, sinon deux balayages enfileraient deux
runs. La contrepartie, une campagne `running` sans run, est exactement ce que le balayage de reprise après gel
(R4) rattrape à la minute suivante. On échange un double envoi possible contre un retard d'une minute.

---
## DEPLOYE le 2026-09-01 : la cible d'une campagne part en INTENTION, pas en liste d'identifiants

Deuxième constat du contre-audit. L'écran proposait « tout sélectionner » jusqu'à 100 000 contacts,
rapatriait tous leurs identifiants dans le navigateur, et les renvoyait dans le corps de la requête, plafonné
à 1 Mo. Le JSON des seuls identifiants pèse environ 975 Ko à 25 000 contacts : **la création échouait bien
AVANT la limite que l'écran annonçait**, et sans rien dire. L'interface promettait donc quelque chose qui
n'existait pas.

Rien de neuf n'a été inventé : le mini-CRM faisait DÉJÀ ce geste pour ses actions en masse (`allMode` +
`excluded` + une cible `BulkTarget`). Le formulaire de campagne reprend son modèle, et la route réutilise
**le même analyseur de cible** (`parseBulkTarget`, exporté de `http/contacts.ts`). Deux analyseurs auraient
fini par ne plus viser la même chose, et une cible qui dérive veut dire une campagne qui ne vise pas ce que
l'écran montrait.

### Le pire accident de ce chemin, et les quatre refus qui le ferment

Une campagne qui part à TOUT L'ESPACE. `createCampaignWithRecipients` retombe sur « charger tous les
contacts » dès que la liste d'identifiants est absente ou vide, ce qui est le comportement voulu pour
« absente » et un accident pour « vide ». D'où :

1. une cible qui ne résout **personne** est refusée (422) ;
2. une cible **illisible** est refusée (400), jamais interprétée ;
3. **`contactIds: []` est refusé** (422). 🔴 Trou PRÉ-EXISTANT trouvé en relisant ce chemin : un tableau vide
   est truthy, il traversait toutes les gardes, et la campagne partait à l'espace entier. Le test a été écrit
   AVANT le correctif et rendait 201 ;
4. **deux façons de désigner les mêmes personnes** ensemble sont refusées (liste + cible, cible + webhook),
   même doctrine que le refus liste + webhook qui existait déjà.

⚠️ `contactIds` ABSENT continue de vouloir dire « tous les contacts ». C'est documenté et voulu ; ce qu'on
refuse, c'est de DÉSIGNER une liste et de n'y mettre personne.

### Ce que la revue a trouvé, et qui valait le lot à lui seul

🔴 **Le mode « tout ce qui correspond » SURVIVAIT à un changement de source.** On cliquait « Tout
sélectionner » sur le CRM (filtres vides = tout l'espace), on basculait sur « Import fichier », et l'écran
montrait un widget d'upload vide pendant que l'état retenait encore la cible du CRM. Le bandeau qui annonce
ce mode et le compteur ne sont rendus que dans la branche CRM : plus rien à l'écran ne disait ce qui était
visé, mais « Prêt à lancer à N » restait affiché. Créer aurait envoyé les ANCIENS filtres à un opérateur
persuadé de viser son fichier. **L'accident que le lot ferme, déplacé d'un cran.**
Règle qui en sort : un état de SÉLECTION doit mourir avec l'écran qui le rend visible. S'il survit à un
changement de contexte où plus rien ne l'affiche, il devient une décision que personne ne prend.

⚠️ Les exclusions sont aussi remises à zéro à chaque changement de filtre : elles désignaient des contacts
d'un autre ensemble, les garder retirerait des gens que l'utilisateur n'a jamais vus.

⚠️ `GET /tenants/:id/contacts/ids` n'a plus aucun appelant (c'était le mécanisme du piège). La route reste
montée, la fonction cliente est supprimée, et la décision de retrait est posée dans `todo.md`.

---
## DEPLOYE le 2026-09-01 : le budget d'un numéro, partagé entre l'API et le worker (migration 0102)

Premier constat du contre-audit, et le seul qui se produisait DÉJÀ en production. `src/index.ts` et
`src/worker.ts` construisaient chacun leur arbitre de débit en mémoire ; les deux sont des conteneurs
distincts, donc un numéro avait deux budgets. Pendant qu'une campagne part du worker, un opérateur qui répond
depuis l'inbox consomme un second budget sur le même numéro. **Ce n'est pas un sujet de gros volume : ça se
produit avec un client et deux messages.**

### Le montage, et pourquoi celui-là

Le champ `nextAllowed` que le limiteur en mémoire gardait dans une variable devient une LIGNE, et la
réservation devient une instruction SQL atomique. L'algorithme ne change pas ; c'est son état qui sort du
process. Deux process qui réservent en même temps se sérialisent sur le verrou de ligne, ce qui est
exactement le comportement voulu.

Choisi contre l'autre voie possible, une file d'envoi durable partitionnée par numéro. Celle-ci aurait donné
en plus l'ORDONNANCEMENT (faire passer l'inbox devant une campagne), mais au prix d'un aller-retour de file
sur le chemin interactif, donc de la latence pour l'opérateur. **Le trou d'aujourd'hui est un trou de
COMPTAGE, pas d'ordonnancement** : on le ferme sans changer le comportement de l'inbox. La priorité reste à
prendre le jour où elle manquera vraiment.

### Les trois propriétés à connaître avant d'y toucher

🔴 **Aucune transaction n'est tenue ouverte pendant l'appel à Meta.** La réservation est UNE instruction qui
rend un nombre de millisecondes ; l'attente a lieu ensuite, hors de la base. Tenir un verrou pendant un
aller-retour réseau chez un tiers immobiliserait une connexion du pool pour tous les envois du numéro.

🔴 **En cas de panne de la base, on retombe sur le frein LOCAL, jamais sur « laisser passer ».** C'est ce qui
rend le changement sûr : le pire cas possible après cette migration est exactement le comportement d'avant.
Et un envoi ne doit pas échouer parce que la table de débit est indisponible, parce qu'un frein protège la
qualité d'un numéro, il n'autorise pas l'envoi.

⚠️ **Le temps de référence est celui de Postgres**, jamais celui des conteneurs : deux horloges qui dérivent
de quelques secondes suffiraient à laisser passer une rafale, et personne ne surveille l'heure d'un conteneur.
Les deux `now()` de l'instruction sont dans la même requête, donc la même valeur.

### Ce qui le prouve

Le test unitaire vérifie que l'attente rendue est observée et que la panne retombe sur le frein local. Il ne
peut PAS prouver le partage : c'est Postgres qui l'assure. D'où
`tests/integration/porte-debit.integration.test.ts`, avec **deux pools séparés** pour imiter deux process (un
pool unique aurait pu réussir pour une mauvaise raison, deux requêtes sur la même connexion se sérialisant de
toute façon). Six réservations alternées doivent attendre 0, 1, 2, 3, 4 puis 5 secondes ; avant la migration
elles auraient attendu 0, 0, 1, 1, 2, 2, soit le double du débit configuré.

Le SQL a aussi été éprouvé **contre la base de production dans une transaction annulée** avant tout
déploiement : la requête part vraiment (donc la syntaxe et les types sont vérifiés), et rien n'est écrit.

---
## DEPLOYE le 2026-09-01 : le lot UX + le serveur MCP (les six points de la liste de Julien)

Quatre briques, trois commits, deux migrations. Ce qui suit ne redit pas ce que `features.md` décrit : ce sont
les décisions et les pièges.

### Ce que la reconnaissance a invalidé, avant d'écrire une ligne

🔴 **Une supposition écrite dans un cadrage n'est pas un constat.** Deux affirmations du document de cadrage
étaient fausses, et les vérifier a changé le plan :
1. Le groupe « AI Agent » et la période du qualitatif EXISTAIENT DÉJÀ. Le travail restant sur la nav n'était
   pas « créer un menu » mais « ajouter un troisième niveau au modèle », et il n'y avait rien à faire sur la
   période.
2. L'origine d'un message de service n'était PAS dérivable. Les envois de scénario (`wiring.ts`) et les
   réponses de l'agent IA (`envoyerTexteAgent`) écrivent tous les deux `type: 'text'` avec
   `sender_user_id = null` : rien ne les séparait.

### Migration 0099 : l'origine d'un message sortant

- Colonne **NULLABLE et sans défaut**. Un `not null` aurait fait échouer une insertion sur le chemin chaud du
  webhook le jour d'un oubli d'appelant, c'est-à-dire l'incident du 2026-08-17. La garde contre l'oubli est
  posée là où elle ne coûte rien en production : le paramètre `origine` est **obligatoire dans la signature
  TypeScript**, donc un chemin d'écriture oublié ne compile pas. Le compilateur a désigné les six appelants.
- La lecture de l'historique (`src/inbox/origine.ts`) est **bornée dans le temps**. Avant la bascule, un
  sortant hors template sans expéditeur humain vient forcément d'un scénario : **mesuré** le 2026-09-01 sur la
  base de production, `agent_sessions` était vide. Après la bascule, une origine absente ressort en
  « indéterminée » À L'ÉCRAN. Sans cette borne, un chemin ajouté plus tard sans poser son origine serait
  compté comme du scripté, en silence et pour toujours.
- Le fragment SQL de classement est **partagé** entre l'agrégat et le détail : un total et sa ventilation qui
  classeraient différemment ne tomberaient plus juste.

### Migration 0100 : le résumé de conversation

`justification` explique le CLASSEMENT, pas ce qui s'est dit. La montrer comme un résumé aurait été un
raccourci qu'on ne voit plus une fois pris. Colonne nullable, **jamais remplie rétroactivement** : la fiche
affiche un repli nommé. Le champ est `.optional()` dans le schéma Zod (comme `abusive` avant lui) pour qu'un
modèle qui l'omet ne fasse pas perdre toute l'analyse, et une chaîne vide est écrite `null` : l'absence doit
rester distinguable d'un résumé vide, parce que l'écran ne dit pas la même chose des deux.

### Serveur MCP : les trois décisions qui portent le reste

🔴 **`/v1` ne compte que quatre endpoints et AUCUNE lecture.** « MCP = façade mince sur /v1 » était donc faux :
les outils de lecture n'avaient aucun endpoint à appeler. La règle retenue est plus forte et plus simple :
**un outil MCP n'a jamais de logique métier à lui, il appelle la fonction que la route de console appelle.**
C'est ce qui a fait extraire `src/inbox/repondre.ts` (`repondreDansLaFenetre`), désormais partagé par la route
d'inbox et par l'outil `reply_in_open_window`. Une copie qui dérive ici ne produit pas un affichage bancal :
elle produit un agent tiers qui envoie des WhatsApp avec des garde-fous différents de ceux de l'interface.

🔴 **Transport écrit à la main, sans le SDK officiel.** La surface utile tient en cinq méthodes
(`initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`), et le SDK apporte une gestion
de session et un canal SSE dont un serveur d'outils **sans état** n'a aucun usage. Sans état est un choix :
ni `Mcp-Session-Id` ni reprise de flux, donc deux requêtes du même client peuvent tomber sur deux process
différents. C'est ce qui permettra d'en lancer une seconde instance.

🔴 **Un refus MÉTIER est un RÉSULTAT, pas une erreur de protocole.** Fenêtre de 24 h fermée, conversation
inconnue : `isError: true` dans le résultat, avec la raison en clair. Une erreur JSON-RPC dirait au modèle
« l'outil est cassé » au lieu de « ta demande n'était pas recevable, lis pourquoi ». Seule une panne réelle
sort en `-32603`, et son message d'origine n'est PAS renvoyé (il peut porter un fragment de requête SQL ou de
réponse Meta).

⚠️ **Deux détails d'autorisation qui ne se devinent pas.** (1) Un outil hors des scopes de la clé n'est même
pas LISTÉ, et le refus d'appel dit « inconnu ou non autorisé » : distinguer les deux renseignerait un porteur
de clé sur des capacités qu'on lui refuse. (2) Les scopes MCP ne sont PAS cochés d'avance à la création d'une
clé (`API_SCOPES_PAR_DEFAUT`) : l'écran cochait tout quand il n'y avait que deux droits, et laisser ce geste
aurait donné à toute clé neuve le droit d'envoyer des WhatsApp au nom du client.

⚠️ **Aucun outil n'émet d'événement d'automation.** Le CLAUDE.md range l'API publique parmi les chemins qui
n'émettent pas ; un serveur MCP en est une. Un agent qui boucle sur 500 conversations déclencherait sinon 500
automations, donc des envois facturés que personne n'a demandés. La page Developers le dit à l'intégrateur.

🔴 **Ce que la revue du lot a trouvé, et qu'il faut retenir.** Deux bloquants, tous les deux sur la surface
d'écriture ouverte aux tiers :

1. **Le lot JSON-RPC contournait le plafond de débit.** Le quota se compte UNE FOIS PAR REQUÊTE HTTP, dans le
   preHandler de la clé. Un tableau accepté laissait donc passer, pour une seule unité de quota, autant
   d'appels `reply_in_open_window` que le corps de 1 Mo peut en contenir : des milliers d'envois Meta réels
   dans un seul POST. C'est exactement le mégaphone que le lot dit avoir fermé en n'exposant pas
   `send_template`, rouvert par le VOLUME au lieu de la fonctionnalité. Le lot est désormais REFUSÉ, ce qui
   est aussi la bonne réponse de protocole (il a été retiré de MCP en 2025-06-18).
   **Règle générale : quand un plafond se compte par requête, tout mécanisme qui met N actions dans une
   requête est un contournement du plafond.**
2. **Une réponse MCP était enregistrée « scenario ».** `recordOutbound` DÉDUISAIT l'origine de l'expéditeur.
   Vrai tant que ses appelants étaient tous des routes de console ; faux dès qu'un appelant sans expéditeur
   humain est apparu. Et la faute était INVISIBLE : la valeur fausse étant écrite explicitement, le repli
   « indéterminée » de la migration 0099 ne pouvait pas se déclencher. Le paramètre est devenu obligatoire
   (migration 0101, origine `mcp`).
   **Règle générale : une valeur déduite d'un autre champ n'est une garde que tant que la liste des appelants
   ne bouge pas, et une liste d'appelants bouge toujours.**

⚠️ **`control_owner` reste `app_human` pour un agent tiers**, et c'est un choix. `ControlOwner` n'a que trois
valeurs ; ce qui compte est que le scénario cesse d'avancer TOUT SEUL et que MBA cesse de répondre, ce que
`app_human` produit exactement. La distinction « qui a parlé » est portée là où elle sert et où elle ne coûte
pas de migration du chemin chaud : l'origine du message.

⚠️ **Le rewrite `/mcp` est GELÉ AU BUILD** de l'image web, comme `/r/:code` et `/m/:fichier`. Toute
modification de `web/next.config.mjs` exige `up -d --build`. `tests/rewrites-web.test.ts` garde les quatre.

---
## DEPLOYE le 2026-09-01 : banc de charge et de reprise après kill (dernier item ouvert du lot 8)

**Ce qui a été mesuré, et comment.** Postgres 16 jetable sur le VPS, worker réel en `DRY_RUN=true` (le sender
de démo rend un identifiant sans appeler Meta), campagne de 400 destinataires, `kill -9` du worker en plein
envoi. Script rejouable : `scripts/banc-charge.mts`, avec DEUX gardes indépendantes avant la moindre écriture
(`BANC_CONFIRME=1`, et refus de toute chaîne de connexion qui ressemble à Supabase).

🔴 **CE QUE LE BANC A TROUVÉ, et c'était une perte SILENCIEUSE et DÉFINITIVE.** Le destinataire en vol au
moment du kill reste à l'état `sending`. Le run suivant ne le voit pas (`listPending` ne rend que les
`pending`), vide la file et marque la campagne **`completed`** : 399 envoyés sur 400, campagne « terminée ».
Dix minutes plus tard `reclaimStale` fait son travail et le remet en `pending`... sur une campagne TERMINÉE,
que la reprise ne relance plus (elle ne regarde que les `running`). Ce contact ne recevait jamais son message,
et rien ne le disait. Corrigé : le statut de sortie d'un run reste `running` tant qu'un destinataire est
réservé.

**Ce que le banc a prouvé, et qui tient :**
- **zéro destinataire envoyé deux fois** après le kill : le claim atomique fait son travail ;
- la campagne **repart toute seule**, sans intervention, en **trois minutes au plus** : le bail du verrou de
  run dure 120 s et le balayage de reprise passe toutes les 60 s. Mesuré : 92 envoyés au moment du kill,
  reprise automatique, 400 traités à la fin ;
- `reclaimStale` récupère bien le destinataire coincé.

⚠️ **Ce que le banc ne peut PAS prouver, et qu'il faut savoir** : le destinataire coincé a `message_id` NULL,
donc on ignore si son message était déjà parti chez Meta quand le process est mort. Le rejouer peut produire
**un double envoi par kill brutal et par run**. Le fermer demanderait une idempotence côté Meta, pas une garde
de plus chez nous.

⚠️ **Ce que ce banc ne mesure PAS non plus** : le débit d'une campagne. Il est plafonné à **80 messages par
minute** par une contrainte de base (migration 0033), donc décidé par nous et pas par la tuyauterie. Le débit
qui se mesurerait vraiment est celui de la file des ENTRANTS, qui n'a pas ce plafond.

---
## DEPLOYE le 2026-09-01 : programme II, lot 4 (la rétention des quatre dernières tables non bornées)

Événements de blocs, parcours terminés, clics tracés, journal d'audit : quatre tables qui grossissaient depuis
le premier jour, dont deux portent un numéro de téléphone. Migration 0097 (hors transaction), quatre index
dédiés : ⚠️ les index de LECTURE existants ne servaient à aucun de ces balayages, parce qu'ils commencent tous
par `tenant_id` alors qu'une purge balaye la table entière par date. C'est le cas où « il y en a déjà un » est
faux.

🔴 **Deux natures, deux traitements, et c'est le point du lot.**
- Les **événements de blocs sont ANONYMISÉS**, jamais supprimés (`wa_id = 'anonyme'`). Ils SONT la mesure des
  tableaux, et il n'existe aucune statistique rétroactive (migration 0063) : les effacer viderait l'historique
  du client pour retirer un numéro. On retire le numéro et on garde le compteur, exactement la décision déjà
  prise pour la purge d'un contact et pour `campaign_recipients.to_e164`. ⚠️ Corollaire assumé : ce balayage
  ne borne PAS la croissance de cette table, il ferme le risque RGPD. Le volume sera un pré-agrégat, pas une
  purge.
- Les **trois autres sont supprimées** : plus personne ne les relit.

🔴 **Deux garanties de NON-effacement, testées pour elles-mêmes.**
1. Un parcours **vivant** (`waiting`, `sleeping`) n'est jamais purgé, quel que soit son âge. La garde est posée
   DEUX fois : dans la requête, et dans le prédicat de l'index partiel. Un run en attente depuis un an est une
   anomalie à corriger ailleurs, sûrement pas une ligne à supprimer sous les pieds d'un contact.
2. Purger les clics ne touche **jamais** `tracked_links`. Porte à sens unique : un lien supprimé est une
   adresse morte dans des messages déjà livrés, sans recours.

🔴 **Une rétention à ZÉRO ne purge RIEN, et ce n'est pas cosmétique.** Vérifié sur le banc :
`make_interval(days => 0)` vaut « maintenant », donc `at < now()` est vrai pour TOUTE ligne. Sans le
`if (days <= 0) return 0`, régler une rétention à 0 en croyant la désactiver viderait la table entière,
immédiatement. Un test le fixe pour les quatre méthodes.

**Les durées, et leur logique** : courtes là où il y a une donnée personnelle (blocs 365 j, parcours 90 j),
longues là où il n'y en a pas (clics et journal 730 j), puisque la question n'y est que le volume et que le
journal d'audit est la PREUVE qu'une purge a eu lieu. Le raccourcir reviendrait à effacer l'attestation en
gardant l'obligation.

**Vérifié avant de pousser**, sur un postgres:16 jetable : migration appliquée, purge qui épargne le parcours
en attente, et plan qui utilise bien le nouvel index partiel. En production le balayage est resté muet, ce qui
est correct : les 22 parcours terminés, 89 événements, 79 clics et 9 entrées de journal sont tous récents.

---
## DEPLOYE le 2026-09-01 : programme II, lot 3 (les entrants en parallèle, ordonnés par contact)

**Ce qui changeait.** La file des messages entrants traitait UN job à la fois, tous clients confondus : un
envoi Meta lent ou un appel HubSpot qui traîne, et la réponse d'un autre client attendait derrière. C'est le
« noisy neighbour » de l'audit, sur le chemin le plus visible du produit.

🔴 **Les deux options vont ENSEMBLE, et c'est tout le sujet.** `concurrency` seul remettrait le désordre entre
deux messages d'un même contact : le verrou d'avance conditionnelle (lot 1 du programme I) protège l'ÉTAT du
parcours, pas les EFFETS, et deux messages envoyés dans le désordre restent envoyés dans le désordre.
`groupConcurrency` seul serait un NO-OP, pg-boss n'ayant rien à répartir tant qu'un seul job est en vol. Un
test statique lit désormais `src/worker.ts` et refuse l'une sans l'autre, vérifié dans les deux sens.

**La clé de groupe est `phone_number_id:wa_id`**, calculée par le receveur SANS toucher la base (il doit
accuser réception à Meta immédiatement). Un numéro appartient à un seul espace, donc deux espaces ne peuvent
pas partager une clé : le cloisonnement tient sans lecture. Elle vaut `undefined` dès que le payload ne désigne
pas UN contact et un seul (plusieurs contacts, `wa_id` masqué par un BSUID, bascule de contrôle dont la forme
n'est pas documentée) : même doctrine conservatrice que l'aiguillage des accusés, dans le doute on renonce à
l'optimisation plutôt que d'inventer un ordre faux.

**Concurrence à 3, avec l'arithmétique.** Le worker tient déjà 4 runs de campagne en parallèle, plus les
accusés, les automations et les tours d'agent ; le pool applicatif est de 8 connexions PAR PROCESS, valeur
mesurée comme la capacité réelle du pooler. Relever `WEBHOOK_CONCURRENCY` demande de refaire ce calcul, pas
seulement de changer la variable.

⚠️ **La garantie d'ordre est LOCALE au process** (`localGroupConcurrency`). Avec un second worker elle tombe :
c'est le lot 8. `automation-event` reste à un job en vol, donc ordonnée par construction, et la note est posée
à l'endroit exact où quelqu'un voudra lui donner de la concurrence.

**Refactor préalable, commit séparé.** `handleWebhookJob` prenait DOUZE paramètres positionnels : l'appel de
la file des accusés s'écrivait avec sept `undefined` d'affilée, dont aucun lecteur ne peut dire ce qu'ils
désignent, et où insérer un paramètre au mauvais rang changeait le câblage en silence (tout est optionnel et
de types voisins, le compilateur ne bronchait pas). Dépendances nommées, corps inchangé, seize appels de test
convertis, même leçon que `enqueueCampaignRun`.

---
## DEPLOYE le 2026-09-01 : programme II, lots 1 et 2 (index des chemins chauds, et ce qui se dégradait en silence)

**Lot 1, le runner AVANT les index, et l'ordre n'est pas négociable.** `db/migrate.ts` jouait tout dans une
transaction, donc `CREATE INDEX CONCURRENTLY` y était interdit : le premier index sur une grosse table aurait
bloqué les écritures en plein déploiement. D'où la directive `-- migrate: no-transaction` (migration 0096, la
première du dépôt à s'en servir).

🔴 **Le piège qui rendait la directive INUTILE, et qui a failli passer.** Postgres exécute une requête simple
contenant PLUSIEURS instructions dans une transaction IMPLICITE. Retirer le `begin`/`commit` ne suffisait donc
pas : envoyer le fichier entier en un `client.query()` gardait `CONCURRENTLY` illégal. Mesuré dans un
postgres:16 jetable : deux `CONCURRENTLY` dans un seul `psql -c` échouent, les mêmes en deux `-c` passent. Le
runner envoie désormais **instruction par instruction** (`decouperInstructions`, conscient des chaînes, des
commentaires et des dollars). Contrepartie assumée et écrite dans le runner : une migration hors transaction
n'a **aucun filet**, elle est rejouée depuis le début après un échec, donc chaque instruction doit être
idempotente. `tests/migration-directives.test.ts` garde les deux sens sur les fichiers réels.

**TROIS index, pas quatre, et c'est la mesure qui a tranché.** Banc jetable, 200 000 lignes, plans réels :
résolution `wa_id` -> contact **54,96 ms -> 0,20 ms** (BitmapOr des trois branches) ; `reclaimStale`
**16,01 ms -> 0,17 ms** ; préfixe téléphone en Index Scan, y compris en plan générique. L'index réclamé par
l'audit pour le `NOT EXISTS` du funnel n'a **pas** été posé : le plan et le temps ne bougent pas (186 -> 184 ms),
Postgres préfère un Hash Anti Join complet, et un index posé « au cas où » se paie à chaque écriture.

⚠️ **Deux commentaires FAUX corrigés au passage**, tous deux démentis par un `explain` sur la production :
le `like` ancré sur `phone_e164` n'utilisait PAS l'index unique (un btree ordinaire ne borne pas un préfixe
hors collation C, d'où `text_pattern_ops`), et le GIN `contacts_fields_gin` de la migration 0032 ne sert PAS
`fields ->> clé` (noté pour le lot 6).

⚠️ **Sur la production d'aujourd'hui, ces index ne changent RIEN** : 12 contacts, 51 destinataires, Postgres
les ignorera à raison. Ils sont posés à froid, exactement pour la raison donnée à propos du quota par numéro :
construire un index d'expression sous charge est une opération à cœur ouvert.

**Lot 2, deux dégradations silencieuses.** (1) `setInterval` ne saute pas un tour parce que le précédent n'est
pas fini : une passe plus lente que sa cadence se superposait à elle-même, et **un seul des dix-sept balayages
se protégeait**. La garde est posée dans le registre `src/worker/taches.ts`, donc elle couvre les dix-sept et
les suivants. Le saut est journalisé avec le nombre de tours sautés d'affilée, sans quoi on aurait échangé une
contention contre une invisibilité. ⚠️ Limite connue : elle protège les passes PÉRIODIQUES entre elles, pas la
passe de démarrage lancée à côté par l'appelant, d'où la garde locale conservée sur `reveil-parcours`.
(2) Le POST de webhook refusé rendait 403 **sans écrire une ligne**. Trois causes distinguées, parce qu'elles
ne disent pas la même chose : signature ABSENTE (un scanner), signature INVALIDE (**Meta nous parle et notre
secret ne correspond plus, donc 100 % des entrants jetés**, la panne indiagnosticable du 2026-08-17), corps
absent. Au plus une ligne par cause et par minute, avec le compte depuis la dernière ligne, et jamais le corps
ni la signature reçue. Le test de rafale a trouvé un vrai défaut de comptage : la ligne annonçait 51 pour 50.

---
## DEPLOYE le 2026-09-01 : lot 7, un brouillon et une version publiée pour les scénarios

**Ce que ça ferme.** `workflow_runs` porte `workflow_id` et `current_node`, jamais une version : modifier un
bloc changeait les parcours DÉJÀ démarrés, dans la seconde, sans que personne l'ait demandé.

**Les quatre décisions de Julien (2026-09-01) ont divisé le lot par trois.** Un parcours en cours SUIT la
version publiée (pas d'épinglage), et une campagne programmée prend la version en ligne le jour de
l'expédition. La version publiée est donc la SEULE qui existe à l'exécution : ni table de versions, ni colonne
`workflow_version_id` par run, ni migration des runs existants, ni sémantique de retour arrière. Deux refus
explicites : **pas de conservation de la version précédente** (« on s'encombre pas de l'ancienne version »), et
**un contact qui attend sur un bloc supprimé par la nouvelle publication reste clos en silence** (« tant pis on
assume que le user tombe dans le vide »).

🔴 **LE POINT DE CONCEPTION : `graph` reste le PUBLIÉ, et `draft_graph` est le nouveau.** Une douzaine de
chemins lisent `graph` pour exécuter (exécuteur, campagnes, automations, API publique par code, mesures,
comptage de blocs). Nommer le brouillon `graph` aurait fait basculer les douze d'un coup, et le moindre oubli
aurait mis un brouillon en ligne sans que rien ne le signale. Dans ce sens-ci, un oubli lit le publié : le
pire cas est de ne pas voir une modification, pas d'en envoyer une qui n'était pas prête. **Seuls deux
chemins lisent le brouillon**, tous deux par `grapheEditable(row)` : l'éditeur, et le lien de test.

**Deux gardes MESURÉES, pas supposées.**
1. **Ouvrir un scénario déclenche UN enregistrement** (mesuré le 2026-09-01 avec une sonde Playwright : React
   Flow remesure les blocs au montage, ce qui change `nodes`, ce qui réveille l'auto-save). Sans garde, tout
   scénario simplement CONSULTÉ aurait porté « brouillon non publié » à vie. D'où le `case when $4::jsonb =
   graph then null` de `update` : un brouillon identique au publié n'en est pas un.
2. **Publier vide d'abord la file d'enregistrement** (`enregistrerMaintenant`). L'auto-save attend 1,2 s :
   sans ce vidage, un clic dans cette fenêtre mettait en ligne le brouillon d'AVANT la dernière frappe, en
   affichant « en ligne ». Vérifié DANS LES DEUX SENS : le test e2e échoue si on retire le vidage. La boucle
   d'attente n'est pas du zèle non plus, parce que `doSave` rend la main tout de suite si un PATCH est déjà
   en vol : l'attendre ne prouverait rien dans ce cas précis.

**Le reste des choix.** `publish` promeut avec un `coalesce(draft_graph, graph)` (sans lui, republier deux
fois d'affilée écraserait le publié par NULL, donc effacerait le scénario de la production sur un double-clic)
et ne redate que s'il y avait quelque chose à mettre en ligne. `insert` écrit le BROUILLON : une création, une
duplication, rien n'est en ligne tant qu'on n'a pas publié, une seule règle. Dupliquer copie ce qu'on VOIT.
QUI a publié va au journal d'audit (`workflow.published`), pas dans une colonne : le mécanisme existait.

**Refactor préalable, dans un commit séparé** (règle : jamais refactor et comportement ensemble).
`WorkflowBuilder.tsx` passait de 1 860 à 573 lignes, en trois sorties posées sur des frontières qui existaient
déjà : `WorkflowNode.tsx` (props React Flow + `CustomEvent`), `WorkflowConfigPanel.tsx` (reçoit un bloc, rend
un patch), `lib/use-enregistrement-scenario.ts` (l'enregistrement, c'est-à-dire exactement le code que le lot
allait modifier), plus `lib/workflow-canevas.ts` pour la frontière graphe <-> canevas. Les 64 tests e2e du
builder passent sans modification.

**Migration 0095, BLOQUANTE** (le code écrit `draft_graph`) : migrer AVANT de déployer.

---
## DEPLOYE le 2026-08-29 : le bloc Question, des sorties qu'on voyait sans pouvoir les relier

Symptôme rapporté par Julien : « certains boutons de réponses restent rouges et je ne peux pas les relier […]
puis je vais dans l'inbox et je reviens et là je peux les relier ».

🔴 **Cause racine, lue dans `@xyflow/system` 0.0.79.** React Flow garde les positions des poignées EN CACHE
(`node.internals.handleBounds`) et ne les remesure que si la taille EXTÉRIEURE du bloc change, ou sur ordre
(`updateNodeInternals`). Or `onPointerDown` commence par résoudre la poignée de départ DANS CE CACHE, et sort
**en silence** si elle n'y est pas : le point se voit, se survole, et le glisser ne commence jamais. Passer par
l'inbox remontait le composant, donc vidait le cache, d'où le contournement que Julien avait trouvé seul.

Ce qui rendait le cache faux : `handleSig`, une signature ÉCRITE À LA MAIN censée reproduire le JSX, qui avait
déjà dérivé à deux endroits. Une ligne de menu au libellé VIDE compte dans `rows` mais ne dessine aucune
poignée ; taper son libellé en ajoute une sans changer ni la signature ni la hauteur du bloc. Idem pour un
bouton qui passe de « lien » à « réponse rapide ». Dans les deux cas, la poignée naissait morte.

**Le correctif ne répare pas les deux cas, il supprime la classe entière** : la signature est désormais LUE
DANS LE DOM (les poignées réellement présentes, dans leur ordre), c'est-à-dire la même chose que React Flow
mesure. La dérive devient impossible par construction, et ce qu'on ajoutera plus tard est couvert d'avance.
Test : `web/e2e/workflow-sorties-multiples.spec.ts`, « une réponse AJOUTÉE À L'INSTANT se relie ».

---
## DEPLOYE le 2026-08-31 : LOT 6 (1re moitié), les accusés ne passent plus devant les messages

Une seule file `webhook` traitait TOUT : les messages entrants, les accusés de livraison, et l'avance des
scénarios. Or une campagne de 5 000 messages produit **trois accusés par destinataire**, soit quinze mille
jobs qui passaient DEVANT la réponse d'un vrai client, lequel attendait derrière toute la rafale.

**L'aiguillage est au RECEVEUR**, et il ne pouvait pas être ailleurs : router depuis le worker aurait laissé
la rafale s'empiler dans la même file d'abord, ce qui ne résout rien. Le receveur ne parsait rien, exprès,
pour répondre à Meta immédiatement ; le test ajouté est un parcours d'objet de quelques microsecondes.

**La règle est volontairement stricte et conservatrice** : un payload part sur `webhook-status` s'il contient
AU MOINS un accusé et RIEN d'autre. Message, echo, changement de contrôle, payload mixte, forme inconnue :
tout cela reste sur la file des entrants, qui sait aussi traiter les accusés. On ne perd donc jamais un
événement ; au pire on renonce à l'optimisation. Le traitement est la MÊME fonction, avec les seules
dépendances de livraison : rien n'est dupliqué.

⚠️ **Conséquence assumée** : l'ordre relatif entre un accusé et un message entrant n'est plus garanti. Ils
touchent des lignes différentes (un accusé met à jour un envoi par son `message_id`, un entrant crée une
conversation), donc aucun invariant n'en dépend. C'est écrit dans le code parce que ça ne se devine pas.

Pas de concurrence sur cette file : deux accusés du même message (`sent` puis `delivered`) doivent s'appliquer
dans l'ordre, et c'est sa sérialisation qui le garantit. Sa cadence est de 30 s, comme les traitements de
fond : personne n'attend un accusé, et les espacer réduit d'autant l'egress de la rafale.

**Ce que la garde de files a attrapé tout de suite** : `webhook-status` déclarée sans consommateur. Le test
qui exige que toute file de `BASE_QUEUES` ait un `queue.work` dans le worker a échoué à la seconde où la
déclaration a été ajoutée, avant même que le consommateur soit écrit. C'est exactement le trou qu'il existe
pour fermer (`agent-turn` avait vécu plusieurs jours déclarée et non consommée).

### `CampaignCreateForm` : une extraction, et le refus argumenté des autres

1 686 lignes et 48 états. **`useCampagneReferences` est sorti** (`web/lib/use-campagne-references.ts`) :
templates, scénarios, champs, tags, réglages de l'espace, plus leur indicateur d'attente et le rechargement
des templates. Huit états, un effet et un `useCallback` en moins dans le composant, qui tombe à 1 641 lignes
et 40 états.

🔴 **Le critère du choix est celui de l'audit lui-même** : « une extraction mécanique ne réduit pas la
complexité d'état ». Ce bloc-ci est une concern COHÉRENTE (un chargement, ses données, son attente) qui
n'interagit avec AUCUN état de saisie. Les trois autres découpages proposés ne le sont pas :

- **les zones de rendu** (Destinataires, Message) lisent et écrivent quinze à vingt états chacune : en faire
  des composants demanderait autant de props, c'est-à-dire déplacer la complexité, pas la réduire ;
- **l'enregistrement du brouillon** construit son état à partir d'une vingtaine de champs de saisie : le
  passer en `hook` produirait exactement le « hook opaque à 48 états » que l'audit interdit ;
- **le réducteur de lancement** vaut d'être fait, mais l'audit demande d'abord des tests sur l'hydratation,
  l'autosauvegarde, le changement de type de contenu et le double clic de lancement. Ces tests-là sont le
  vrai préalable, et ils sont un lot en soi.

⚠️ `onErreur` est passé en dépendance EXPLICITE au hook, plutôt qu'un `setError` interne : sinon l'écran
aurait deux endroits où il affiche ses erreurs, dont un invisible depuis le formulaire.

Vérifié par les tests E2E de campagne (brouillons, contacts dégradés, template créé à la volée avec son
sondage d'approbation, filtre de scénarios, RCS), tous verts après extraction.

⚠️ **Cette phrase disait « les 18 tests », et le chiffre a vieilli** dès qu'on a ajouté des cas (il en manquait
neuf le 2026-09-08). Un compte écrit à la main dans une prose ne se tient pas à jour tout seul et ne prouve
rien de plus que la phrase sans lui : ce qui compte est QUE ces chemins soient couverts, pas combien de fois.

### Ce qui NE sera PAS fait, et pourquoi

Les fonctions `register*Jobs` du worker, reportées du lot 3, **ne seront pas écrites**. L'audit demandait de
ranger `worker.ts` avant d'y ajouter des files, et sa propre grille dit comment juger : « mesurer le nombre de
DÉPENDANCES et les tests isolables, pas le nombre de lignes ». Or chaque bloc de composition y utilise une
douzaine de stores : `registerCampaignJobs(...)` prendrait quinze paramètres, ou bien un objet fourre-tout,
c'est-à-dire un localisateur de services que l'audit interdit explicitement. On échangerait une composition
linéaire et lisible contre six fonctions à longue signature. Le gain réel du lot 3 était le REGISTRE DE
TÂCHES, qui a effectivement trouvé trois minuteries jamais arrêtées et un chemin de crash ; celui-ci n'a pas
d'équivalent.

---
## DEPLOYE le 2026-08-31 : LOT 5 du programme, campagnes en lots courts et concurrence (aucune migration)

**Le problème** : `queue.work('campaign-run')` ne passait AUCUNE option, donc aucune concurrence, et un job
traitait sa campagne **jusqu'à épuisement**. 5 000 destinataires à 30/min, c'est 2 h 47 pendant lesquelles la
file ne sert personne d'autre. La campagne d'un client bloquait littéralement celles de tous les autres.

**Une DURÉE, pas un nombre de destinataires.** Le run s'arrête entre deux destinataires au bout de
`CAMPAIGN_RUN_MAX_MS` (2 min), rend `reste: true`, et le job le réenfile. Un nombre fixe serait faux des deux
côtés : à 1/min un lot de 100 durerait plus d'une heure, à 80/min une minute. C'est le temps d'occupation de
la file qu'on borne.

🔴 **Deux gardes qui font la différence entre un découpage et une boucle infinie.**
1. La sortie n'est prise que si du travail a DÉJÀ été fait (`traites > 0`). Sans ça, une durée mal réglée
   ferait un run qui n'envoie rien, se réenfile, n'envoie rien... pour l'éternité, en tournant à plein régime.
2. La campagne reste `running` : ce n'est pas une pause, personne n'a rien décidé. Le statut n'est pas
   réécrit, exactement comme pour l'arrêt du service.

Et la relance se fait **après avoir rendu le verrou**, sinon le job suivant se heurterait à lui et se
contenterait de demander un rerun, ce qui rallongerait le trajet pour rien.

**La concurrence, désormais sûre.** `concurrency: 4` avec `groupConcurrency: 1`, le groupe étant l'ESPACE :
quatre runs en parallèle, mais un seul par client. Un client n'attend plus la campagne d'un autre, et deux
campagnes du même client restent sérialisées (elles partagent de toute façon un seul numéro, donc un seul
budget d'envoi). 🔴 **Ceci n'est sûr QUE parce que le lot 4 est en place** : sans frein partagé par numéro,
deux runs en parallèle doubleraient le débit réel, ce que Meta observe et sanctionne.

**La garde statique a payé, deux fois.** Elle exigeait déjà que tout enfilement de `campaign-run` porte son
expiration ; elle exige maintenant qu'il porte son GROUPE. Elle a immédiatement trouvé **trois enfilements
sans groupe** : les campagnes programmées, le lancement manuel et le renvoi d'un destinataire. Chacun aurait
échappé au plafond par espace, c'est-à-dire aurait permis à un seul client d'occuper toute la file, ce que
la concurrence est précisément censée empêcher.

`enqueueCampaignRun` prend désormais un objet plutôt que quatre paramètres positionnels : à ce nombre on
finit par en inverser deux, et une inversion entre le compte et le débit ne se voit que sur une campagne
longue. `getRunSizing` et `listDueScheduled` rendent le `tenantId` au même endroit que le dimensionnement,
pour ne pas payer une seconde requête à chaque relance.

---
## DEPLOYE le 2026-08-31 : LOT 4 du programme, le débit partagé par NUMÉRO (aucune migration)

Le seul frein d'envoi du dépôt était instancié **par run de campagne** : deux campagnes du même numéro avaient
deux budgets, et 30/min configurés en faisaient 60. Les trois autres chemins d'envoi (réponse d'inbox, message
de scénario, automation) n'avaient **aucun** frein. Le débit réel d'un numéro n'était donc borné par rien,
alors que c'est lui que Meta observe et sur lequel il fonde la qualité et les paliers.

**Le point de pose est ce qui fait la valeur du lot.** `MetaClientFactory.clientForTenant` est l'endroit où
les quatre chemins se rejoignent : campagne, scénario, automation et inbox y construisent tous leur client.
Une ligne y injecte la porte du numéro, `MetaClient.call` l'acquiert avant chaque appel `messages`, et un
chemin d'envoi FUTUR en hérite sans que personne y pense. Aucun appelant n'a été modifié.

**L'arbitre ne remplace pas le débit par campagne, il s'y ajoute, en série.** Le débit de campagne dit « à
quelle vitesse je veux que CETTE campagne parte » (1 à 80/min, c'est une fonctionnalité de l'écran) ;
l'arbitre dit « ce numéro ne dépassera jamais ça ». D'où le défaut de `PHONE_RATE_PER_MINUTE_MAX` à **80** :
c'est exactement le maximum qu'une campagne peut choisir, donc une campagne seule n'est jamais bridée, et deux
campagnes se partagent 80 au lieu d'en faire 160.

🔴 **Ce que ça ne fait PAS.** Le budget est en mémoire, donc **par process** : l'API et le worker en ont
chacun un. Le worker porte tout le volume ; l'API ne porte que les envois d'un humain dans l'inbox, à cadence
humaine. Le pire cas théorique est deux fois le plafond. Rendre le budget réellement partagé (base, ou
affectation exclusive d'un numéro à un worker) est le **prérequis du second worker**, pas de celui-ci.

Le RCS n'est pas concerné : il ne passe pas par Meta et a ses propres quotas fournisseur. Les mélanger ferait
qu'une campagne RCS ralentirait WhatsApp sans raison.

⚠️ Effet de bord assumé : quand une campagne tourne à plein régime, une réponse d'opérateur peut attendre son
tour (au plus l'intervalle du numéro, 750 ms à 80/min). Donner la priorité aux messages humains est un
raffinement séparé, noté dans la synthèse (§A2).

**Un détail de couches, corrigé au passage** : `MetaClientOpts.rateLimiter` était typé sur la CLASSE
`RateLimiter`. L'interface `PorteDeDebit` est désormais déclarée dans `meta/http.ts`, la couche la plus basse,
pour que le client Meta n'ait rien à importer de la couche campagne.

---
## DEPLOYE le 2026-08-31 : LOT 3 du programme, le registre des tâches du worker (aucune migration)

Refactor **neutre en comportement**, sauf sur un point qui est une correction de bug, dit plus bas.

Le worker programmait dix-sept `setInterval` et devait les arrêter **une par une**, à la main, dans son arrêt
propre. Ce couplage a exactement le défaut qu'on attend de lui : on oublie. Deux tâches y avaient déjà
échappé historiquement (le code le disait dans un commentaire), et **les deux balayages de rétention ajoutés
le jour même** n'y étaient pas non plus, découverts en écrivant le registre. Un oubli ne casse rien tout de
suite (les minuteries sont `unref`) : il se voit à l'arrêt, quand une passe part pendant qu'on ferme le pool,
et laisse une erreur à chaque déploiement.

`src/worker/taches.ts` : programmer et arrêter deviennent le MÊME geste. `taches.arreterTout()` remplace les
dix-sept `clearInterval`, et les quatre variables `let ...Sweeper` des tâches conditionnelles disparaissent.

🔴 **Le bug trouvé en écrivant le test, et corrigé ici.** `setInterval(() => void f())` laisse un rejet NON
RATTRAPÉ si `f` rejette, et depuis Node 15 un rejet non rattrapé **tue le process**. Chaque balayage attrape
déjà ses erreurs, mais rien ne le garantissait : il suffisait que le `catch` lui-même échoue (l'alerte
Telegram qui lève) pour que le worker meure en silence, sans autre trace qu'un redémarrage. Le registre
enveloppe donc chaque passe. C'est le seul écart de comportement du lot, et il va dans le sens de la survie.

⚠️ **Ce que le registre ne fait PAS** : lancer la première passe. Les appelants qui balayent au démarrage
gardent leur `void passe()` là où ils l'écrivaient. Le rendre implicite ferait démarrer quinze balayages qui
ne le faisaient pas, c'est-à-dire un changement de comportement caché dans un refactor.

**La seconde moitié de l'item (les fonctions `register*Jobs`) est reportée au lot 6**, et c'est la logique de
l'audit lui-même : elle sert « avant d'y ajouter de nouvelles files », or c'est le lot 6 qui en ajoute (en
séparant les entrants des accusés). L'extraire maintenant serait un gros diff sans utilisateur.

---
## DEPLOYE le 2026-08-31 : LOT 2 du programme, la rétention des conversations (migration 0094)

La moitié restante de 5.2. Les conversations, leurs messages et leur analyse qualitative étaient gardés POUR
TOUJOURS. L'analyse est le pire de ce qu'on garde : son `topic` et sa `justification` sont du texte libre
produit par un modèle à partir de ce que la personne a raconté.

**365 jours, et le chiffre est une décision, pas un réglage.** Julien a donné un PLANCHER de 3 mois
(motif RGPD) ; on prend quatre fois ce plancher, parce que la suppression est IRRÉVERSIBLE et qu'un an est la
durée qu'on défend sans hésiter devant une DSI. Descendre est sans danger, remonter ne ressuscite rien.

**Ce que la purge emporte, et par quel mécanisme** : les messages et l'analyse partent avec la conversation
**par les cascades DÉJÀ déclarées en base** (0009 et 0027), donc en une commande atomique, sans une ligne de
code applicatif. C'est pour ça que le test est en INTÉGRATION : un faux store rendrait ce qu'on lui fait
rendre, et le jour où une cascade manquerait, il resterait du texte libre orphelin et invisible.

**Ce qu'elle n'emporte PAS** : la FICHE du contact. Une conversation périmée n'est pas un contact supprimé.
L'effacement d'une personne reste `purgeMany`, qui anonymise en plus.

⚠️ Deux gardes testées explicitement, dans ce sens-là : `0` DÉSACTIVE la purge (sans le test,
`make_interval(days => 0)` viserait tout ce qui est antérieur à maintenant, donc TOUTES les conversations de
TOUS les clients), et l'effacement est BORNÉ par passage (500), le balayage repassant toutes les 6 heures.

La migration n'ajoute qu'un INDEX : les index existants sur `last_message_at` ne servaient pas ce besoin (celui
de 0069 est préfixé par `tenant_id`, celui de 0027 est partiel sur `analysis_status = 'pending'`).

---
## DEPLOYE le 2026-08-31 : LOT 1 du programme, quatre choses qui cassaient déjà (aucune migration)

### Un plafond Meta brûlait l'audience restante d'une campagne

`130429` (plafond de débit) et `131048` (plafond lié à la qualité) n'étaient dans AUCUNE des deux listes de
`src/meta/errors.ts`, donc traités par le défaut « 4xx sans code connu = terminal ». Un refus TEMPORAIRE, qui
vise le NUMÉRO, faisait donc échouer définitivement le destinataire en cours, puis le suivant, puis tous les
autres. Les contacts brûlés n'étaient plus joignables sans intervention (un destinataire `failed` n'est pas
repris par un relancement).

Trois pièces : les codes sont **rejouables** (c'est la vérité, l'attente les résout, et c'est ce qu'il faut
pour un envoi unitaire depuis l'inbox ou un scénario) ; le moteur de campagne les reconnaît EN PLUS comme un
plafond de numéro (`estPlafondNumero`) et met la campagne **en pause** ; et le destinataire est **rendu à la
file** (`relacher`, l'inverse exact de `claim`) au lieu d'être compté en échec.

⚠️ `131056` est délibérément EXCLU : c'est un plafond de la PAIRE (trop de messages entre ce numéro et CE
contact). Le confondre avec les autres arrêterait 5 000 envois légitimes pour un seul contact. Un test garde
cette distinction dans les deux sens.

### L'avance d'un scénario écrivait sans condition

`setStateSiEncoreSur` existait, était testé, et n'avait qu'UN appelant (le tour d'agent) : les cinq écritures
de `advance` passaient par `setState`, un `update where id` nu. Or deux avances peuvent se chevaucher **dès
aujourd'hui, avec un seul worker** : le process API traite certains retours RCS pendant que le worker traite un
webhook du même contact. Les deux lisaient le run sur le même bloc, et le dernier écrivait : `current_node`
pouvait REVENIR sur un bloc déjà franchi, et rejouer sa branche au message suivant.

Les cinq écritures passent par une fermeture `ecrire()` conditionnée au bloc **de départ**, et une avance
perdue est JOURNALISÉE (on ne corrige pas ce qu'on ne voit pas).

🔴 **Ce que ça ne ferme PAS, et c'est écrit dans le code** : les envois du perdant sont déjà partis quand la
garde le refuse. Cette garde protège l'ÉTAT, pas les effets. Fermer le double envoi demande un claim pris
AVANT les envois (donc un statut transitoire, donc une migration) plus des clés d'idempotence : c'est un lot à
part. Ne pas lire cette garde comme « l'avance est atomique ».

⚠️ Piège trouvé en chemin : la garde SQL disait `current_node = $3`. Un run peut légitimement attendre avec
`current_node` à null, et `null = null` vaut NULL : l'écriture aurait été silencieusement perdue. C'est
désormais `is not distinct from`, identique pour toute valeur non nulle.

### Le garde-fou anti-hallucination vivait en double

La recherche de connaissance était recopiée à l'identique entre le résolveur de PRODUCTION et celui du BAC À
SABLE, et leurs erreurs avaient déjà divergé. Or le bac à sable n'a de valeur que s'il rend EXACTEMENT ce que
la production rendrait : plus indulgent, il laisse croire qu'un agent sait répondre là où il transférera.

La règle vit dans `src/agent/resolvers/connaissance.ts`. Ce qui reste chez chaque appelant est le message
d'erreur d'une requête vide, que les deux surfaces n'expriment pas dans la même forme, et qui n'est pas une
règle métier. Un test de PARITÉ compare les deux sorties (il ne relit pas le code : il tient même si quelqu'un
dé-mutualisait, tant que les deux restent d'accord).

### Un second numéro était accepté et fusionnait les canaux

Décision produit du 2026-08-31 : **un seul numéro WhatsApp par espace**. Le refus est posé DANS la transaction
de rattachement, et il ignore le numéro en cours de rattachement (recommencer l'embarquement reste possible).
Le message nomme le numéro déjà présent et dit quoi faire, en 409 (un 5xx serait remplacé par la page
Cloudflare).

⚠️ Ce refus n'est pas une limitation arbitraire : le modèle suppose un fil par `(tenant_id, wa_id)` et ne
porte pas `phone_number_id` sur `conversations`, `workflow_runs`, les automations ni les analytics. Lever la
limite ne consiste donc PAS à supprimer le test ; la liste des chemins est au §A8 de la synthèse du 2026-08-31.

**Un test d'intégration existant a dû être corrigé** : il rattachait son numéro à l'espace partagé du fichier,
qui en portait déjà un depuis un test précédent. Il aurait échoué pour la nouvelle raison au lieu de celle
qu'il teste. Il a désormais son espace dédié.

---
## DEPLOYE le 2026-08-31 sur `5456d14` : la rétention des événements Meta bruts (migration 0093, PLAN.md 5.2)

`webhook_events` gardait le payload COMPLET de chaque événement Meta reçu **depuis le premier jour** : le
texte des messages entrants et le numéro de la personne qui écrit. Aucune purge, aucun index de date, et
surtout **aucun discriminant d'espace**. C'était la dernière table du dépôt à garder une trace nominative hors
de portée de la purge par contact.

🔴 **Le discriminant est la partie qui ne se rattrape pas.** Une ligne écrite sans lui n'est attribuable à
personne, pour toujours : le payload de Meta ne porte pas d'identifiant d'espace, seulement le numéro
DESTINATAIRE (`value.metadata.phone_number_id`), que `phone_numbers` rattache à son tenant. C'est pour ça que
la colonne est posée maintenant plutôt qu'au moment où on en aura besoin. Les lignes antérieures restent
inattribuables, et c'est la rétention qui s'en occupe.

**Trois pièces.**
1. **Le numéro destinataire suit l'événement** depuis `parseWebhook` jusqu'à l'insertion (`phoneNumberId`).
2. **Une purge par rétention**, `WEBHOOK_EVENTS_RETENTION_DAYS` (30 jours), balayée toutes les heures avec
   alerte Telegram en cas d'échec. L'effacement est BORNÉ par passage (50 000 lignes) : une première purge sur
   une table qui n'en a jamais eu peut viser des millions de lignes, et un `delete` unique tiendrait un verrou
   et gonflerait le WAL d'un coup. ⚠️ `0` désactive la purge, et le test d'intégration verrouille ce sens-là :
   à `0` elle ne doit RIEN toucher, surtout pas tout effacer (`make_interval(days => 0)` viserait tout).
3. **L'effacement par personne** : `purgeMany` efface désormais les événements Meta de la personne, visée par
   `payload->>'from'` (message entrant, echo) ou `payload->>'recipient_id'` (statut de livraison). 🔴 Scopé au
   tenant par le numéro destinataire : la même personne peut écrire à deux de nos clients, et purger chez l'un
   ne doit pas toucher au journal de l'autre. Un test d'intégration pose exactement ce cas.

**Ce qui n'est PAS couvert, et c'est écrit dans le code** : les lignes d'avant 0093 (sans discriminant) et les
payloads `messaging_handovers` (qui ne portent ni `from` ni `recipient_id`, mais pas de texte non plus).

**Reste de 5.2** : la rétention des CONVERSATIONS et des analyses, faite le même jour dans le lot 2 (365 j,
migration 0094). 5.2 est clos.

---
## DEPLOYE le 2026-08-31 sur `5456d14` : les deux restes du lot « journée 1 » (aucune migration)

Deux chemins que le correctif voisin ne couvrait PAS, malgré ce que son intitulé laissait croire.

### Un appel sortant n'avait aucun plafond de temps

Le plafonnement du `Retry-After` bornait l'attente ENTRE deux tentatives, jamais la durée d'UNE requête. Un
fournisseur qui accepte la connexion et ne répond jamais immobilisait donc le job jusqu'au défaut d'undici, de
l'ordre de cinq minutes. Sur la file `webhook`, sérialisée (`batchSize: 1`), c'est l'entrant de TOUS les
clients qui s'arrête derrière un seul appel pendu.

`FetchTransport` porte désormais un plafond **par instance** : 30 s pour un fournisseur d'API ordinaire (Meta,
HubSpot, dont les réponses se comptent en centaines de millisecondes), **120 s pour un modèle de langage**, qui
a le droit d'être lent. Un plafond unique aurait forcément été faux pour l'un des deux.

🔴 **Trois choses font la correction, et il en manquait une à l'énoncé de l'audit.**
1. Le dépassement est **rejouable** (`HttpTimeoutError.retryable`), sinon un silence transitoire ferait échouer
   un envoi parfaitement rejouable. Ce que ça coûte, écrit noir sur blanc dans le code : la requête est PARTIE,
   donc un serveur qui répond après 30 s peut recevoir le même envoi deux fois. Le dépôt acceptait déjà ce
   risque (`ECONNRESET` est rejoué), et le plafond généreux est ce qui le garde théorique.
2. L'échéance de **l'APPELANT est prioritaire et n'est jamais convertie**. Le cerveau d'un agent passe la
   sienne : son abandon est une décision (« je n'ai plus le temps »), pas une panne. La convertir en erreur
   rejouable multiplierait sa limite de temps par le nombre de tentatives. C'est pour ça que le typage passe
   par une erreur À NOUS plutôt que par un test de `TimeoutError` dans `isRetryable`, qui aurait attrapé les
   deux cas sans les distinguer.
3. Le plafond couvre aussi la **lecture du corps**. Sans le test ajouté dans le `catch` de `res.json()`,
   l'abandon y était ravalé et l'appel rendait `{ status: 200, json: null }` : un SUCCÈS au corps vide.

### Le retry-sweep enfilait sans dimensionner

C'était le SEUL enfileur de `campaign-run` à passer par `queue.enqueue` nu : il retombait sur le défaut de 15
minutes, alors qu'une relance de plus de ~450 destinataires (à 30/min) dure plus longtemps. Le job expirait en
plein envoi, pg-boss le rejouait, et le run reparti en parallèle appliquait SON propre limiteur de débit : le
débit réel doublait. Le plafond de 23 h posé par le lot « journée 1 » ne protégeait pas ce chemin, qui n'en
passait simplement pas.

Le câblage passe par `enqueueCampaignRun` avec le sizing relu, comme les trois autres appelants. La garde est
un test STATIQUE (`tests/campaign-pacing.test.ts`) : aucun `enqueue('campaign-run', ...)` du dépôt ne peut
omettre `expireInSeconds`. Un test de comportement était impossible, le câblage vivant dans le `main()` du
worker, que rien n'atteint.

---
## DEPLOYE le 2026-08-31 sur `434d875` : R9 et R7, les deux derniers oranges de l'audit (migration 0092)

### R9. Le mur de l'import CSV tombait au CHOIX du fichier, pas à l'import

Trois choses, dans cet ordre de gravité.

**1. L'aperçu envoyait le fichier ENTIER** pour n'en extraire que les en-têtes et quatre lignes d'exemple.
C'était le premier mur, et le plus bête : avec le plafond de corps global de 1 Mo, choisir un fichier de plus
de 14 000 lignes échouait avant tout import. Il ne part plus que la TÊTE, coupée sur une fin de ligne
(`teteCsv`, `web/lib/csv.ts`, 512 000 caractères). Conséquence assumée : au-delà d'environ 8 000 lignes, le
nombre affiché devient une ESTIMATION au prorata des caractères, signalée par un « ≈ » à l'écran. Un nombre
approché sur un gros fichier vaut mieux qu'un refus, et sous le seuil il reste exact.

**2. La route d'import ne relevait pas le plafond**, alors que flows, media, workflows et rcs le font. Elle
est à 8 Mo (environ 150 000 contacts), l'aperçu à 2 Mo. Pourquoi pas plus : le corps est parsé D'UN BLOC, et
pendant ce temps l'API ne répond à personne d'autre. **Mesuré ici** : 102 ms pour 5,4 Mo / 100 000 lignes,
donc quelques centaines de millisecondes sur le VPS. C'est le vrai facteur limitant, pas la mémoire.

**3. Le refus, quand il tombe, est en français.** Fastify répondait « Request body is too large ». Le message
est traduit dans le gestionnaire d'erreurs GLOBAL (`src/server.ts`, sur `FST_ERR_CTP_BODY_TOO_LARGE`), donc
toutes les routes à corps volumineux en profitent, pas seulement l'import.

**Et l'écriture passe par lots de 500** (`upsertManyByPhone`, `src/crm/contact-store.pg.ts`) au lieu d'un
aller-retour par ligne. À 11 ms d'aller-retour, 50 000 contacts passaient de neuf minutes, donc bien au-delà
du timeout de 100 s de Cloudflare, à une centaine de requêtes.

🔴 **Le piège du lot : Postgres refuse qu'un `on conflict do update` touche deux fois la même ligne** dans une
même commande (« cannot affect row a second time »), et un CSV a des doublons. Le store DÉDUPLIQUE donc avant
d'écrire, sur la règle exacte qu'appliquait l'écriture ligne à ligne (la ligne suivante écrase les mêmes clés,
un nom non vide gagne), et ne compte qu'UNE création par numéro, à sa première apparition. Sans ça, un fichier
répétant cinq fois le même contact annonçait cinq créations pour une personne, ou faisait échouer la requête.

Deux détails de la requête qui coûtent cher à retrouver : le lot voyage en UN paramètre `jsonb`
(`jsonb_to_recordset`) et non en tableaux parallèles, parce qu'un tableau de fragments JSON devrait être
échappé comme littéral de tableau Postgres ; et chaque paramètre est CASTÉ explicitement, parce que dans un
`insert ... select` le type d'un paramètre n'est pas toujours déduit de la colonne visée.

**La file pg-boss d'import (point 4 de l'audit) n'est PAS faite, et c'est une décision** : après les lots, le
timeout n'est plus approché. Condition de réouverture dans `todo.md`.

### R7. Les compteurs de l'inbox, interrogés par chaque utilisateur en boucle

La pastille de non-lus est montée sur TOUTES les pages et pour tous les rôles, relue toutes les 30 s, et
`countUnread` compte avec un `exists` corrélé sur TOUTES les conversations de l'espace. Vingt-cinq
utilisateurs d'un même client posaient vingt-cinq fois la même question, pour un nombre qui n'a pas bougé.

**Micro-cache par espace, 5 secondes** (`src/lib/cache-court.ts`, câblé sur `unread-count`, `todo-count` et, depuis le 2026-09-08, les compteurs du menu de dossiers de l'Inbox).
Deux mécanismes, et les deux comptent : la durée de vie absorbe le polling étalé, la mutualisation des appels
EN VOL absorbe les arrivées simultanées, c'est-à-dire le rechargement collectif après un déploiement, qui est
exactement le moment où ça fait mal.

🔴 **Ce qu'un cache de compteur doit avoir pour ne pas devenir le bug qu'il évite** : une invalidation sur
l'écriture qui le rend faux (marquer un fil comme lu, prendre ou rendre la main), ET une garde d'identité au
moment d'écrire dans le cache. Sans la seconde, une invalidation qui tombe pendant qu'un comptage est en vol
laisse le comptage d'AVANT se ranger en cache juste après : la pastille reste allumée alors que l'opérateur
vient d'ouvrir le fil. Les deux sont testées, chacune vérifiée dans les deux sens.

**Index partiel `conversation_messages_unread_idx` (migration 0092)**, sur les seuls messages entrants :
l'index historique savait borner sur la date mais rapportait aussi les sortants de l'intervalle, que le moteur
écartait ligne à ligne. Sur un contact qui vient de recevoir une campagne, cet intervalle est justement plein
de sortants. ⚠️ Pas de `concurrently` : le runner enveloppe chaque migration dans une transaction, ce qui
l'interdit. La table est petite aujourd'hui ; si elle grossit, créer les prochains index à la main.

**Gigue sur les trois pollings** (`web/lib/poll.ts`, ±20 %, retirée après chaque exécution). Le nombre de
requêtes ne change pas, leur RÉPARTITION si : `setInterval` fait battre tous les onglets ensemble pour
toujours, et c'est la pointe qui sature, pas la moyenne.

**Ce qui n'est PAS traité** : la colonne `unread` dénormalisée, et surtout le polling du fil ouvert toutes les
4 secondes, qui reste la charge de lecture dominante et qu'aucun des quatre correctifs de l'audit ne touche.
Conditions de réouverture dans `todo.md`.

---
## DEPLOYE le 2026-08-31 sur `a737edf` : R4 et R10 de l'audit (aucune migration)

### R4. Un déploiement gelait une campagne en cours, sans erreur visible

Le worker est tué en plein envoi à chaque `up -d` : SIGKILL vers 10 s, un run de deux heures n'a aucune
chance. Rien ne reprenait ensuite la campagne. Chaque interruption consommait un rejeu pg-boss, et **à la
sixième elle était figée pour toujours**. Mesure du jour : ce seul lot a déclenché le cas cinq fois.

🔴 **Le correctif n'est PAS d'attendre la fin d'un run**, c'est de le rendre REPRENABLE. Quatre pièces, et une
seule est la garantie :

- **Le balayage de reprise** (`listCampagnesGelees`) relance toute campagne `running` qui a du travail et
  AUCUN run vivant. C'est la garantie, parce qu'elle rattrape aussi les arrêts qu'aucun signal ne précède
  (SIGKILL, panne, OOM). « Aucun run vivant » se lit sur le verrou d'exécution de R1-bis.
- ⚠️ **Il REMPLACE le balayage du fil de l'eau**, qui n'en était qu'un cas particulier (les campagnes nourries
  par un webhook) et qui, lui, ne savait pas voir qu'un run tournait déjà : il empilait un job de plus par
  minute. Deux balayages pour une seule question, dont un faux.
- 🔴 **Le bail du verrou devient COURT (2 min) et RENOUVELÉ**, et ce raisonnement REMPLACE celui écrit le
  matin même. Le bail était alors calé sur l'expiration du job pg-boss, dimensionnée en heures, au motif que
  les deux mécanismes devaient lâcher prise ensemble. C'était juste pour un bail qu'on ne renouvelle pas, et
  **faux dès qu'on veut reprendre** : le verrou d'un process mort serait resté « vivant » pendant des heures,
  et le balayage aurait sagement attendu. Un renouvellement refusé arrête le run (on ne tient plus le verrou).
- **Un drapeau d'arrêt**, lu à chaque destinataire, laisse le run sortir à la frontière d'un envoi et rendre
  son verrou. ⚠️ Le statut n'est **pas** réécrit : la campagne reste `running`, personne n'a rien décidé, et la
  marquer `paused` exigerait un geste humain pour repartir.
- **`stop_grace_period: 30s`** dans le compose, au-dessus du filet de 25 s du shutdown. ⚠️ Les deux vont
  ENSEMBLE : relever l'un sans l'autre ne change rien. Et ce n'est PAS la garantie, seulement le confort du cas
  courant : un run throttlé peut dormir jusqu'à une minute dans son limiteur avant de relire le drapeau.

### R10 + J2. Le rappel « avant date » pouvait partir deux ou trois fois

La déduplication vivait UNIQUEMENT dans le balayage, qui lit le marqueur d'occurrence avant de publier. Tant
que l'événement publié n'était pas consommé, le balayage suivant revoyait le contact comme dû et **republiait
la même échéance**. Un client avec quinze rendez-vous à la même heure suffit à faire prendre du retard à la
file. Symptôme : deux, parfois trois rappels WhatsApp **identiques, facturés, visibles du client**, avec le
risque de note de qualité Meta.

`markFired` devient un **claim conditionnel** quand un marqueur est donné : la garantie descend du balayage au
RUNNER, seul endroit atomique.

- ⚠️ **SANS marqueur, l'écriture reste inconditionnelle.** Tous les autres déclencheurs y écrivent
  `fired_for = null`, et `null is distinct from null` est faux : rendre ce cas conditionnel aurait fait
  échouer TOUT déclenchement répété, sur toutes les automations du produit.
- ⚠️ **Le rattrapage du balayage n'est pas cassé.** Quand le scénario ne démarre pas, `clearFired` efface le
  marqueur et la tentative suivante regagne le claim. C'est le comportement voulu, documenté dans
  `date-sweep.ts` : un fil momentanément tenu par un opérateur doit pouvoir laisser passer le rappel une
  minute plus tard.

### Ce que la CI a attrapé, et que rien en local ne pouvait voir

Mes tests d'intégration du claim empruntaient une automation qu'un test précédent du même fichier
**supprime** : l'ordre d'exécution décidait du résultat. Le job `integration` ne tourne qu'en CI (le
`DATABASE_URL` local est la production), donc c'est elle, et elle seule, qui pouvait le voir. Un test qui
dépend de ce qu'un autre a laissé n'est pas un test, c'est un pari.

---
## DEPLOYE le 2026-08-31 sur `b058eaa` : le SERVEUR conduit l'entretien de construction (migration 0090)

✅ **Migration 0090 appliquée**, séquence tenue : `build mba-api`, vérification que la 0090 est **DANS l'image**,
`migrate`, vérification EN BASE (six colonnes, la clé primaire, les deux clés étrangères, `0090` en tête de
`schema_migrations`), puis `up -d --build`. Un second déploiement `--force-recreate` a suivi pour
`AGENT_VISION_MODEL` (un `.env.prod` modifié n'est relu qu'à la recréation). **Prochaine libre = 0091.**

Vérifié APRÈS déploiement : trois conteneurs sains sur `mcp-robot_default`, **zéro redémarrage**, aucune erreur
dans les journaux. Par le chemin PUBLIC : l'accueil et `/agents` en 200 ; les quatre nouvelles routes montées et
gardées (**401 sans jeton**, pas 404) : `GET`, `POST` et `DELETE` sur `/setup`, et `POST /setup/piece-jointe`.
`AGENT_VISION_MODEL` relu depuis l'intérieur du conteneur.

⚠️ **La CI a attrapé ce qu'une passe locale partielle avait manqué** : le changement d'onglet d'entrée faisait
tomber trois tests de `agents-fiche.spec.ts`, qui comptaient sur l'ancien défaut. Ils cliquent maintenant
l'onglet, comme le ferait un utilisateur. Leçon rejouée : après un changement de NAVIGATION, la suite e2e se
lance en ENTIER, pas sur le seul fichier touché.

### 🔴 Le défaut n'était pas la liste des points, c'était QUI CONDUIT

Le modèle choisissait sa question suivante et **déclarait lui-même** ce qu'il avait couvert ; le serveur ne
faisait que compter. Rien n'était déterministe, et ça se voyait à l'usage : le ton, l'identité et la base de
connaissance n'étaient jamais demandés, et « l'agent le fait tout seul » passait pour une réponse complète.

L'inversion : **l'ordre du jour et la couverture sont des faits du serveur** (`src/agent/setup/couverture.ts`).
Le modèle formule la question qu'on lui désigne et extrait la réponse ; il ne décide plus de rien. Trois
mécanismes portent la garantie, et aucun n'est une consigne :

- 🔴 **Un point n'est couvert que s'il a été POSÉ au client**, pas seulement si le modèle prétend en connaître
  la réponse. C'est ce qui garantit qu'on a fait le tour et pas que le modèle a bien deviné. Une réponse donnée
  d'avance est gardée : le tour venu, on la fait **confirmer** en une phrase plutôt que de reposer la question,
  ce qui rend l'entretien court sans rien sauter.
- 🔴 **Le prompt reçoit DEUX points, l'ouvert et le suivant.** Structurel : le serveur choisit la question
  AVANT de lire la réponse, il ne peut donc pas savoir que le dernier message y répond déjà. Un seul point
  ferait repiétiner ; toute la liste laisserait le modèle la survoler. Deux, pas un de plus.
- 🔴 **Le creusement est mécanique.** Répondre « il appelle un outil » à `bascules` **ouvre** le point
  `quel_outil`, qui n'existait pas avant, et l'entretien ne peut plus se terminer sans. Se raviser le referme.
  C'est la demande de Julien : « si c'est l'agent qui peut le faire lui-même, il faut que l'agent creuse et
  demande, ben comment l'agent fait dans ces cas là ? ».

L'ordre du jour passe de six à neuf points, **de la substance vers la surface** : on ne demande le ton et
l'identité qu'une fois qu'on sait ce que l'agent fait, sinon on décore une coquille.

⚠️ **Le vieux garde-fou « au moins deux messages du client » a été RETIRÉ.** C'était un pis-aller qui compensait
une couverture déclarée par le modèle. Elle ne l'est plus, et garder les deux aurait fait croire que le second
portait quelque chose.

### La persistance n'est pas qu'un confort

Table `agent_setup_conversations`. Elle rend la conversation reprenable au retour sur l'onglet, ce que Julien
demandait, **mais c'est surtout elle qui rend la couverture calculable côté serveur** : sans état, la couverture
ne pouvait qu'être recalculée à partir de ce que le modèle voulait bien annoncer.

Conséquence de sécurité au passage : le navigateur n'envoie plus l'historique mais **un** message. Un historique
forgé ne peut donc plus faire croire à l'assistant qu'il a déjà tout demandé. Un bouton « Recommencer » évite
que la persistance devienne une prison.

### Les pièces jointes

`src/agent/setup/piece-jointe.ts`. Un document joint devient des **fiches de connaissance**.

- **Le type vient de la SIGNATURE du fichier**, jamais du MIME déclaré : même doctrine que `src/rcs/image.ts`,
  et elle mord autant ici, puisque ce texte finit dans le prompt d'un agent qui parle à de vrais contacts. Un
  ZIP quelconque ne passe pas pour un `.docx` (on exige son `word/document.xml`), et un binaire ne passe pas
  pour du texte (UTF-8 valide, sans octet nul).
- 🔴 **Le texte est DÉCOUPÉ, jamais avalé d'un bloc.** C'est la leçon déjà écrite dans `scrape.ts` : la
  recherche mesure « combien de termes de la question se retrouvent dans la fiche », donc un document entier
  dans une seule fiche contient à peu près tous les mots du métier, devient pertinent pour n'importe quelle
  question, et **rend la garde anti-hallucination inopérante sans qu'aucun test ne le voie**. Un PDF de
  quarante pages est le pire cas de ce défaut. Les plafonds sont ceux de l'import de page web, importés et non
  recopiés.
- ⚠️ **Un test a attrapé un vrai défaut d'implémentation** : une section plus longue que le plafond était
  TRONQUÉE, et tout le reste perdu en silence, le client croyant son document importé. Elle est maintenant
  découpée en « suite 2 », « suite 3 », et le test compare les caractères non blancs de bout en bout.
- **Une image est lue UNE SEULE FOIS**, au moment où elle est jointe, par un appel vision qui en relève le
  texte. Aucune image ne circule dans l'entretien persisté : l'y garder ferait grossir une ligne jsonb de
  plusieurs méga et referait payer sa lecture à chaque tour.
- ⚠️ **`ChatMessage` n'a PAS été élargi** pour ça. L'essai (`content: string | Part[]`) a fait sortir une
  dizaine d'endroits qui lisent ce champ comme une chaîne, dans le runtime de l'agent et ses tests, pour un
  besoin qu'aucun n'a. Un type `ChatMessageImage` séparé, accepté en union par `completer`, laisse tout
  l'existant intact.
- **Deux dépendances neuves**, toutes deux SANS dépendance transitive (le dépôt en compte onze) : `unpdf`
  (importé dynamiquement, pour ne pas faire payer pdf.js au démarrage de l'API) et `fflate` (dézippage du
  `.docx`). `xlsx` reste écarté, comme décidé auparavant : les deux bibliothèques npm sont mauvaises.
- **Écrire directement n'est pas une entorse au « rien ne s'écrit sans un clic ».** Ce diff protège contre ce
  que le MODÈLE propose ; ici c'est le client qui téléverse son propre document, et le geste EST le
  consentement. Même doctrine que l'import d'une page de son site, qui écrit aussi ses fiches directement.

### Écran

« Construire en parlant » devient l'onglet d'**entrée** (l'ordre des onglets le disait déjà, le défaut ouvrait
le formulaire). Un agent se supprime **depuis la liste**. Et la conversation ressemble à un tchat : fil de
hauteur fixe, descente automatique, première bulle qui interroge au lieu d'expliquer, zone de texte
multi-ligne (Entrée envoie, Maj+Entrée va à la ligne), indicateur de frappe.

---
## DEPLOYE le 2026-08-31 sur `3a708ce` : R1, R1-bis et R13 de l'audit du 25 août (migration 0089)

✅ **Migration 0089 appliquée**, séquence tenue : `build mba-api`, vérification que la 0089 est **DANS l'image**
(`docker run --entrypoint sh` sur l'image fraîche), `migrate` (« 1 migration appliquée »), vérification EN BASE
(six colonnes, la clé primaire, les deux clés étrangères, et `0089` en tête de `schema_migrations`), puis
`up -d --build`. **Prochaine libre = 0090.**

Vérifié APRÈS déploiement : les trois conteneurs sains, rattachés à `mcp-robot_default`, **zéro redémarrage**,
aucune erreur dans les journaux de l'API ni du worker (qui redémarre bien avec ses sept files). Par le chemin
PUBLIC : l'accueil et `/campaigns` en 200, `/api/backend/health` en 200, et la nouvelle route de pause qui
répond **401 sans jeton** (donc montée et gardée, un 404 aurait voulu dire qu'elle n'existait pas). Le libellé
« Mettre en pause » est présent dans le bundle réellement servi.

### 🔴 R1. `singletonKey` n'a JAMAIS dédupliqué quoi que ce soit dans ce dépôt

Douze commentaires (l'audit en comptait huit) promettaient « un seul job vivant par campagne / par
conversation » sur la foi d'un `singletonKey`. **Lu dans la source de pg-boss 12.25.1 :** la déduplication sur
`singleton_key` ne passe que par des index uniques **partiels**, tous filtrés sur une policy de file
(`job_i1` short, `job_i2` singleton, `job_i3` stately, `job_i6` exclusive, `job_i8` key_strict_fifo,
`migrationStore.js`). Or `PgBossQueue.ensure()` crée les files sans `policy`, donc en `standard`
(`manager.js` : `options.policy || QUEUE_POLICIES.standard`), où aucun de ces index ne s'applique. Le
paramètre était accepté, écrit en base, et ignoré.

⚠️ **Et on ne peut pas rattraper en ajoutant `policy`** : pg-boss refuse tout changement après création
(« queue policy cannot be changed after creation »), et les files de la production existent déjà. Il faudrait
de nouvelles files, donc de nouveaux noms, donc abandonner les jobs en vol.

Le paramètre a été **retiré de l'interface `Queue`** : un commentaire dérive, un type non. Ce que la vérité
rétablie change concrètement :

- l'enfilement d'un `campaign-run` n'est **pas** idempotent. Ce qui empêche le double-run d'une campagne
  programmée, c'est `markRunning` (la garde sur le statut, qui la retire de la liste des dues), pas la file ;
- le claim atomique par destinataire garantit qu'**aucun contact ne reçoit deux fois**, il ne garantit **pas
  le débit** : N runs concurrents instancient N limiteurs en mémoire et envoient à N fois la cadence annoncée.
  C'est ce qui grille un numéro neuf en palier 250 ;
- 🔴 **le balayage « fil de l'eau » se justifiait par un mécanisme inverse du réel.** Son commentaire disait
  rattraper les arrivants dont le job avait été « avalé » par le `singletonKey`. Rien n'avalait rien : l'effet
  réel est qu'il **empile un run de plus par minute** tant que la campagne a des destinataires en attente,
  alors qu'un run tourne déjà. Un envoi throttlé d'une heure finirait à soixante runs concurrents. Aucune
  campagne au fil de l'eau n'a encore tourné en production, donc ça n'a jamais mordu.

### R1-bis. Le verrou d'exécution qui remplace la déduplication inexistante (migration 0089)

`src/campaign/run-lock.ts`, table `campaign_run_locks`. **Posé au SEUL endroit qui exécute** (`campaignRunJob`),
jamais aux cinq endroits qui enfilent : on n'essaie pas d'empêcher les enfilements en double, on empêche les
exécutions en double. C'est la différence entre verrouiller toutes les portes et verrouiller le coffre, et
c'est ce qui fait qu'un seul point de code couvre les cinq chemins d'un coup (route `/run`, renvoi d'un
destinataire, balayage de planification, auto-relance F6, alimentation au fil de l'eau).

Trois pièces, et il en faut trois :

- 🔴 **Le bail** (`expires_at`). Sans lui, un worker tué en plein envoi (SIGKILL à 10 s au déploiement, cf. R4)
  laisserait la campagne verrouillée pour toujours. Il est dimensionné sur **la même estimation que
  l'expiration du job pg-boss** (`campaignJobExpireSeconds`), délibérément : les deux mécanismes doivent lâcher
  prise au même instant. Un bail plus court laisserait un second run démarrer sous le premier ; un bail plus
  long garderait la campagne bloquée alors que pg-boss rejoue déjà son job.
- 🔴 **Le jeton de garde** (`holder`). Si notre bail a expiré et qu'un autre run a repris le verrou, notre
  libération ne doit pas supprimer le sien. Sans ce jeton, l'expiration du bail recréerait exactement la
  concurrence que la table existe pour empêcher.
- 🔴 **Le drapeau de relance** (`rerun`). Un job écarté peut porter du travail que le run en cours ne verra
  pas : il a pris son instantané de destinataires à son démarrage. Un destinataire remis en attente par
  « Renvoyer » ou par l'auto-relance F6 resterait alors `pending` **à vie** sur une campagne passée
  `completed`. Le tenant du verrou relance donc une fois en sortant, et seulement s'il reste vraiment du
  travail (sinon un double clic sur « Lancer » ferait clignoter le statut pour un run vide).

Un job qui n'obtient pas le verrou **ne lève pas** : il rend un rapport à zéro. Lever ferait rejouer le job par
pg-boss, qui se heurterait au même verrou, cinq fois, puis finirait en file d'échec pour un cas parfaitement
normal.

⚠️ **Ce que le verrou NE fait pas.** Le cas documenté dans `pacing.ts` (un run dont la durée réelle dépasse son
expiration estimée) reste ouvert : à cet instant, le bail expire en même temps que le job, donc le rejeu
pg-boss prend le verrou pendant que le run d'origine tourne encore. C'est le risque déjà assumé pour les très
grosses campagnes à débit très bas, dont le vrai remède est le découpage du run en tranches.

Le SQL est prouvé en intégration (`tests/integration/stores.integration.test.ts`), le câblage en unitaire : les
deux, parce qu'aucun ne peut prouver ce que prouve l'autre.

### R13. Arrêter une campagne lancée

Trois pièces, chacune nécessaire, aucune ne suffit seule :

1. **Le moteur relit le statut dans sa boucle** (`runCampaign`) et sort dès qu'il n'est plus `running`. Cadencé
   par le **temps** (5 s, `statusPollMs`) et non par un nombre de destinataires : une campagne à 1 msg/min
   mettrait sinon des heures à voir la pause. Le contrôle passe **avant le claim**, et la sortie **ne réécrit
   pas** le statut (ce serait écraser la décision de l'opérateur, et `completed` mentirait).
2. **Le job refuse de démarrer une campagne en pause** (`campaignRunJob`). Sans cette garde, un job enfilé avant
   la pause la ressusciterait, puisque le moteur remet toute campagne en `running` à son démarrage. Le cas est
   atteignable précisément parce que la file ne déduplique rien (R1). Conséquence voulue : l'auto-relance F6
   n'insiste plus sur une campagne en pause, elle attend une reprise décidée.
3. **La reprise est explicite** : `POST /run` lève la pause **avant** d'enfiler, et la **rétablit** si
   l'enfilement échoue. Sans ce rétablissement, la campagne resterait affichée « en cours » sans qu'aucun job
   ne tourne, et « Reprendre » ne s'affiche pas sur une campagne en cours : l'opérateur serait coincé.

Route `POST /tenants/:tenantId/campaigns/:campaignId/pause`, admin, scopée tenant. **404 « pas à toi » et 409
« n'envoie pas » sont distincts** (contrôle d'appartenance d'abord), et jamais 5xx : Cloudflare remplace le
corps de toute réponse 5xx par sa page d'erreur.

⚠️ **Piège rencontré, et attrapé par le test :** l'engine appelait la relecture par une référence déliée
(`const f = deps.campaigns.getStatus`), ce qui perd le `this` et aurait cassé `PgCampaignStore` en production
(`this.pool` indéfini). Une méthode d'un store injecté s'appelle **sur son objet**, jamais détachée.

Les trois gardes sont vérifiées **dans les deux sens** : retirée une à une, chacune fait échouer un test avec
son symptôme exact (3 envoyés au lieu de 1, 1 au lieu de 0, pause non rétablie).

---
## DEPLOYE le 2026-08-28 sur `05f791d` : le lot L2, le connecteur API du client

Plan execute : [AGENT-IA-PLAN-L2.md](AGENT-IA-PLAN-L2.md), neuf taches, quatre decisions tranchees par Julien
et retenues telles quelles. Un agent peut desormais interroger le systeme d un client par une API HTTP que le
client declare lui-meme, sans qu aucune adresse ni aucun identifiant de ressource ne soit choisi par le modele.

🔴 **Un trou trouve en ecrivant le plan, et ferme par la tache 4bis.** Un parametre `contactPath: 'wa_id'`
recevait `null` : la projection du contact ne porte PAS le numero (volontairement, elle part chez le
fournisseur de modele), alors qu un connecteur sert d abord a repondre « ou en est MA commande ». Le numero
vient maintenant du contexte du tour, ou il est authentifie par la signature du webhook Meta. Le fixe des tests
portait `wa_id`, ce que la production n a jamais eu : il a ete recale sur la vraie projection.

✅ **Migration 0088 appliquee**, sequence tenue : `build mba-api`, verification que la 0088 est DANS l image,
`migrate` (« 1 migration appliquee »), verification en base (les deux tables, la colonne `source_id`, les deux
contraintes), puis `up -d --build`. **Prochaine libre = 0089.**

Verifie APRES deploiement : les trois conteneurs sains et rattaches a `mcp-robot_default`, zero redemarrage,
l accueil, `/workflows` et `/agents` en 200, la route `/agent-sources` montee (401 sans jeton) et
`POST .../tools/connecteur` montee (401 sans jeton). Le webhook Meta repond 403 sur un jeton faux et sur un
POST non signe, par le chemin public reel (`/api/backend/webhooks/meta`).

⚠️ **Une fenetre de 968 ms d erreurs de proxy pendant la recreation** (`mba-web` -> `mba-api`, ECONNREFUSED,
20:01:41,744 a 20:01:42,712), le temps que l API se mette a ecouter. Les livraisons Meta tombees dans cette
seconde sont rejouees par Meta. C est le cout normal d un `up -d --build` ; le noter pour ne pas le confondre
avec un incident la prochaine fois qu on lit ces logs.

🔴 **L ECRAN A CHANGE DE PLACE le 2026-08-28, apres retour de Julien.** La bibliotheque de systemes vit dans
**Tools > Connecteurs API** (`/connecteurs`), a cote des webhooks, et pas dans l onglet Outils d un agent : un
systeme appartient au CLIENT, et plusieurs agents tapent dedans. L agent, lui, ne declare que les APPELS qu il
a le droit d y faire. En base, rien n a bouge : `agent_tool_sources` portait deja `tenant_id`.

⚠️ **Piege de vocabulaire** : la console a un menu « Tools » ET un onglet « Outils » dans un agent. Ils ne
parlent pas de la meme chose. Si la confusion revient, renommer l un des deux.

⚠️ **Rien n est branche tant qu un client n a pas declare de source.** Le lot n active rien tout seul : sans
source, l onglet Outils est exactement ce qu il etait.

## DEPLOYE le 2026-08-28 : l agent a ses DEUX modeles, et le canevas ne ment plus

**Les modeles (`e678377`).** Deux metiers, deux reglages, choisis au BANC contre le Gateway avec notre propre
schema (tableau complet dans `documentation.md`) :
- `AGENT_SETUP_MODEL=zai/glm-4.7` pour l assistant de CONSTRUCTION (sortie structuree imbriquee, en francais).
  Conforme 4 fois sur 4, propose a chaque fois des regles d arret ET des outils.
- `AGENT_MODEL=zai/glm-4.7-flash` pour un agent NEUF, celui qui tourne a chaque message. 15/15 sur la boucle
  reelle d outil, 0,000084 $ le tour, 2,2 s : le moins cher ET le plus rapide du banc.

🔴 **Piege ferme au passage** : le modele d un agent neuf retombait sur `LLM_MODEL`, l identifiant de l ANALYSE
de conversation servie EN DIRECT par Anthropic. Le Gateway ne le connait pas : chaque tour aurait echoue en
pleine conversation, sans que la creation n ait rien signale. Poser la cle sans les deux modeles est desormais
refuse au boot.

⚠️ **La cle du Gateway est celle du projet hyundai** (compte Vercel de Julien), reutilisee pour debloquer. Une
cle dediee a mba rendrait l attribution du cout lisible par projet : a creer cote Vercel quand Julien voudra.

Verifie APRES deploiement : le worker liste `agent-turn` dans ses files, et le conteneur `mba-api` joint le
Gateway et recoit `usage.cost` (c est lui qui alimente le solde prepaye).

**Le canevas (`a4ea371`).** Trois symptomes signales par Julien, deux causes mesurees : la fleche de « toute
autre reponse » etait ancree sur la PREMIERE sortie du bloc (arete sans `sourceHandle` = pas de poignee nommee
pour React Flow), et les points de liaison faisaient 5,7 px avec une tolerance de visee de ±2 px. Corriges,
avec les mesures en tests de bout en bout. Le visuel d un bloc s affiche desormais dans sa miniature.

## DEPLOYE le 2026-08-28 sur `cd90bd7` (2 commits, migration 0087 appliquee)

Sequence tenue : `git pull`, `build mba-api`, verification que **0087 est DANS l image** (`ls db/migrations`),
`migrate` (« 1 migration appliquee »), verification des deux tables `agent_credits` et
`agent_credit_mouvements` en base (colonnes conformes, aucune `par_utilisateur`), puis `up -d --build`.
Les trois conteneurs sont sains, rattaches a `mcp-robot_default`, zero redemarrage ; l accueil et `/agents`
repondent 200, `mba-api:8095/health` repond depuis le reseau interne.

La surface `/ops/credits` a ete verifiee EN PRODUCTION, en lecture seule : un tenant reel rend
`{"soldeMicroEur":0,"mouvements":[]}`, un uuid inconnu rend **404** (et non un solde de zero, qui etait le
piege), un identifiant mal forme rend **404** (et non un 500 remplace par la page Cloudflare), et sans jeton
d exploitation **401**. Aucune ecriture n a ete faite : personne n a ete recharge.

⚠️ **`EUR_PER_USD` n a PAS ete posee dans `.env.prod`** : elle a un defaut de **0,92** dans `src/config.ts`,
qui s applique donc. C est un parametre COMMERCIAL : le poser explicitement est un choix de Julien, pas une
correction technique.

## LE SOLDE PREPAYE PAR WORKSPACE (tache 21)

Demande de Julien : un budget qui existe dans l outil et qui **descend vraiment avec la consommation**, sans
Stripe (recharge a la main). Ses deux arbitrages : un solde **par workspace**, et tout **en euros** avec un
**taux fixe en configuration** (`EUR_PER_USD`), pas un cours en temps reel.

🔴 **Ce que ca a mis au jour : le cout d un tour n etait ecrit NULLE PART.** La colonne
`agent_sessions.cout_micro_eur` existait, la console affichait un plafond par conversation, `runTurn` le
comparait, et rien ne l alimentait : le reglage montre au client etait DECORATIF. Repare, et c est ce qui rend
le prepaye possible. **Ferme aussi D1** : la conversion dollars vers micro-euros se fait a l entree, en un seul
endroit (`src/agent/devise.ts`).

Le solde se lit et se recharge sur `/ops/credits/:tenantId` (**premiere ecriture metier de `/ops`** : un client
ne doit jamais pouvoir crediter son propre compte). Recharge bornee a 1000 € et **note obligatoire**. Le bac a
sable de la console consomme pour de vrai, il est donc soumis au meme solde.

✅ **Migration 0087 appliquee** le 2026-08-28 (voir la section de deploiement ci-dessus).
Le compteur des migrations vit dans le CLAUDE.md du repo, et nulle part ailleurs.

⚠️ **Nouvelle variable d env** : `EUR_PER_USD` (defaut **0,92** dans `src/config.ts`, gabarit dans
`.env.example`). Elle est un **parametre commercial** : la changer change ce qu on facture. Non posee dans
`.env.prod`, le defaut s applique.

🔴 **AUCUN workspace n a de solde aujourd hui** (la table est vide, donc solde = ZERO partout). C est le bon
defaut (un credit implicite ferait payer une consommation que personne n a autorisee), mais ca veut dire que
**tant que personne n a recharge, les agents ne demarrent pas et le bac a sable rend 409**. Recharge, quand on
la voudra (le montant est en MICRO-euros, 10 EUR = 10 000 000) :

```bash
curl -s -X POST "https://mba.messagingme.app/api/backend/ops/credits/<tenant-uuid>" -H "x-ops-token: <OPS_TOKEN, dans /home/ubuntu/mba/.env.prod>" -H "content-type: application/json" -d '{"montantMicroEur": 10000000, "note": "recharge Julien, phase de conception"}'
```

La **note est obligatoire** (qui recharge, et pourquoi) : c est la seule trace, le jeton d exploitation etant
partage. Plafond de 1000 EUR par operation, et il n existe AUCUNE route de debit pour rattraper une virgule
mal placee.

## DEPLOYE le 2026-08-28 sur `a325844` (54 commits, migration 0086 appliquee)

Sequence tenue : `git pull`, `build mba-api`, verification que 0086 est DANS l image, `migrate`
(« 1 migration appliquee »), verification des cinq tables `agent*` en base, puis `up -d --build`.
Les trois conteneurs sont sains et rattaches a `mcp-robot_default`, l accueil et `/agents` repondent 200,
`mba-api:8095/health` repond depuis le reseau interne, aucune erreur en trois minutes de logs.

🔴 **LE BLOC AGENT EST DEPLOYE MAIS INERTE, ET C EST VOULU.** `AI_GATEWAY_API_KEY` n est pas dans le
`.env.prod` : le worker le DIT au demarrage (« agent-turn: file NON consommee ») et la file n est pas
consommee. Conséquences tant que la cle n est pas posee :

- l assistant de construction et le bac a sable repondent **503** ;
- un agent ACTIVE et pose dans un scenario laisserait le contact **sans reponse** : le tour serait enfile et
  personne ne le consommerait. Le run reste `waiting`, rien ne casse, mais rien ne repond.

Donc : ne pas poser de bloc agent dans un scenario vivant avant d avoir mis la cle.

✅ **D1 (la devise) est fermee depuis, par la tache 21** : le Gateway facture en DOLLARS, la conversion se fait
desormais a l entree au taux `EUR_PER_USD`, en un seul endroit.

✅ **Migration 0086 appliquee** le 2026-08-28 (dette D6 fermee). La **0087** (solde prepaye), elle, ne l est
pas : voir la section « A DEPLOYER » ci-dessus.

⚠️ **Nouvelles variables d env** : `AI_GATEWAY_API_KEY` (19d et 19e) et `AGENT_SETUP_MODEL` (19d). Vides, la
conversation de construction et le bac a sable repondent 503, aucun crash. A poser sur le VPS avant de
deployer ce lot.

**Ou on en est (2026-08-28) : LA TACHE 19 EST FINIE.** Un agent EXISTE (fiche, regles d arret, activation),
il a une base de connaissance (fiches editables, lecture d une page du site), des OUTILS (catalogue maison,
activation par un humain, drapeau d autonomie), il se construit EN PARLANT (l assistant propose, le client
garde ou jette, rien ne s ecrit en silence) et il se TESTE depuis la console avant d etre active.

**Le tour de PRODUCTION est cable (tache 20).** Le worker consomme `agent-turn` avec les VRAIS resolveurs, et
l agent a enfin une MEMOIRE : il lit la conversation en base depuis l ouverture de sa session. Un vrai
contact peut donc lui parler des que le deploiement est fait.

⚠️ **Rien n a encore tourne sur du VRAI trafic.** Ce qui reste a voir en vol : un contact qui atteint un bloc
agent, une reponse qui part, un outil qui s execute, une sortie qui reprend le scenario. C est la premiere
chose a faire apres le deploiement, et elle ne se remplace par aucun test.

## LIVRE ET DEPLOYE le 2026-08-26 : bloc « Question » dans les scenarios

Demande de Julien : un bloc qui ouvre un MENU (au lieu de boutons) avec X reponses, qui ATTEND la reponse du
contact, ou chaque reponse est mappable vers un autre bloc, ou la reponse ecrite est mappable meme quand un
menu existe, et ou « pas de reponse apres X temps » est une sortie mappable elle aussi.

Arbitrages tranches par Julien : sans menu, UNE seule sortie « il a repondu » (pas de mots-cles) ; bloc
RESERVE a WhatsApp (pas de repli RCS).

**Deploiement (prod sur `52a33b6`)** : migration **0085** appliquee AVANT le code, puis les 6 tests
d integration lances contre la vraie base (verts, ils n avaient jamais pu tourner), puis `build mba-api` ->
`ls db/migrations` dans l image pour verifier que 0085 y est -> `migrate` (« a jour », donc fiable) ->
`up -d --build`. Les trois conteneurs sont sains, aucune erreur au demarrage, `mba-web` toujours rattache a
`mcp-robot_default`.

**Verifie EN VOL** : index partiel present en base ; les marqueurs du bloc (`question-node-timeout`,
`question-row-title-`, `wf-row-delete`, la sortie « Pas de reponse ») sont dans le bundle reellement servi ;
le type `question` et `claimDueQuestions` sont bien dans le code des conteneurs qui tournent.

**Reste a voir sur du VRAI trafic** : aucun contact n a encore recu de menu. Le premier test se fait en
posant un bloc Question dans un scenario et en se l envoyant depuis l Inbox (fenetre de 24 h ouverte).

**Le point d architecture** : c est le seul bloc du produit qui attend DEUX choses a la fois, une reponse ET
le temps qui passe. Le run reste `waiting` (sans quoi la reponse du contact serait perdue) et porte en plus un
`resume_at`, reclame par un bail, pas par une consommation. Detail dans `documentation.md`.

**Revue adversariale** : 4 lentilles ont rapporte 39 defauts, chacun soumis a deux sceptiques charges de le
REFUTER. 10 ont survecu, et j en ai verifie chacun dans le code avant de corriger. Les quatre plus graves
etaient reels et invisibles sans revue :
- supprimer une reponse du menu renumerotait les sorties et repointait SILENCIEUSEMENT les branches deja
  reliees (le contact qui choisit « C » partait dans la branche de « B », supprimee) ;
- l echeance etait CONSOMMEE avant la reprise : un refus de Meta la perdait pour toujours, le fil restant
  tenu par un parcours mort que plus rien ne reveillait ;
- une question posee sur un parcours RCS laissait le run marque `rcs`, donc la reponse WhatsApp du contact
  etait jetee par la garde d etancheite ;
- les variables `{{champ}}` du panneau ne resolvaient nulle part : le contact aurait lu `{{prenom}}`.

Deux de mes propres tests passaient A VIDE (le canal, et un filtre d aretes mal ecrit) : corriges et
re-verifies par mutation.

Verifie avant de m arreter : tsc vert (racine + front), racine **2491** tests, front **132**, E2E **329**,
lint front sans avertissement nouveau. **9 mutations dans les deux sens** sur les regles decisives.

## LIVRE ET DEPLOYE le 2026-08-26 : campagne AU FIL DE L'EAU alimentée par un webhook

Demande de Julien : dans la création de campagne, un bouton **« Autre »** à côté de « Liste de contacts » et
« Import fichier », qui contient HubSpot (masqué quand le connecteur est éteint) et un nouveau choix
**Webhook** : on désigne une adresse de Tools > Webhooks, et tous les contacts qui arrivent par elle sont
« shootés au fur et à mesure ».

**Interprétation assumée** : la campagne envoie à partir de son LANCEMENT, pas aux contacts déjà arrivés par
cette adresse avant. C'est la lecture naturelle de « au fil de l'eau », et la seule qui ne risque pas
d'arroser d'un coup des centaines de contacts passés. Un rattrapage des antérieurs reste possible à ajouter.

**Déploiement (prod sur `9f018c2`)** : migration **0084** appliquée AVANT le code, puis les 11 tests
d'intégration lancés contre la vraie base (verts), puis `build mba-api` -> `ls db/migrations` dans l'image
pour vérifier que 0084 y est -> `migrate` (« à jour », donc fiable) -> `up -d --build`. Les trois conteneurs
sont sains, aucune erreur au démarrage, `mba-web` toujours rattaché à `mcp-robot_default`.

**Vérifié EN VOL** : colonne + index + FK `on delete set null` présents en base ; les marqueurs du nouvel
écran (`campaign-source-autre`, `campaign-webhook-select`, `campaign-badge-fil`, `campaign-stop`) sont dans le
bundle réellement servi ; la route `/stop` répond **401** là où une route inexistante répond 404 (le contrôle
rend la distinction probante).

**Reste à voir sur du VRAI trafic** : personne n'a encore fait passer un lead par une adresse alimentée. Le
premier test réel se fait en postant sur l'URL du webhook, campagne lancée.

Vérifié avant de déployer : tsc vert (racine + front), racine **2448** tests verts, front **128**, E2E
**320** (dont 8 neufs), lint front sans avertissement nouveau. Cinq mutations dans les deux sens (statut de
sortie du moteur, anti-doublon, inscription d'un écart, condition de publication de la route publique, garde
d'affichage de HubSpot) : chacune fait bien tomber les tests censés la couvrir.

## LIVRE ET DEPLOYE le 2026-08-24 : le canal RCS ecoute (rappels smsmode) + composeur a visuel

Prod sur **`694b739`**, migrations **0079** et **0080** appliquees AVANT le code (image rebatie d'abord, puis
`ls db/migrations` dans l'image pour verifier qu'elles y sont, puis `migrate`, puis `up -d --build`). Les trois
conteneurs sont sains, aucune erreur dans les logs, `mba-web` toujours rattache a `mcp-robot_default`.

⚠️ **Ce deploiement embarque le chantier d'une AUTRE session** : `98a4438` (consentement des contacts par
webhook, migration 0080, defaut a `true` y compris pour les webhooks deja crees). Decision de Julien du
2026-08-24, mais elle part avec ce lot et pas separement.

### Ce que le lot RCS apporte

**Le canal ecoute.** Une adresse publique par workspace, `POST /rcs/callback/<code>`, posee automatiquement
sur chaque envoi. Elle recoit les rapports de livraison ET les reponses (le corps porte `direction`). Trois
choses n'existaient pas et existent maintenant : la sortie « non joignable » d'un bloc s'allume (cascade RCS
vers WhatsApp), un bouton tape fait avancer le scenario, un STOP pose l'opt-out.

**Deux defauts corriges au passage, qu'aucun envoi n'exercait encore :**
- les charges utiles des boutons partaient en `btn_1` alors que le graphe attend `btn:0` : un clic ne trouvait
  aucune arete et le parcours s'arretait en silence. Reecriture a l'envoi, donc les messages deja enregistres
  sont repares sans ressaisie ;
- le mapping CARTE/CARROUSEL etait faux (`card`/`cards` et `media.url` au lieu de `content`/`contents` et
  `media.fileUrl`) : la premiere image envoyee serait partie en 400.

**Un blocage de conception corrige.** Un bloc RCS sans bouton laissait le parcours en attente pour toujours :
seuls un echec definitif ou une reponse le relancaient. Un rapport `DELIVERED` reprend desormais la sortie
« envoye », mais UNIQUEMENT si le bloc n'offre aucun bouton reponse (l'accuse arrive en secondes, le contact
repond bien plus tard : avancer trop tot enverrait son clic dans le vide).

**Le composeur.** Image d'en-tete (le message bascule en CARTE, texte plafonne a 2000 au lieu de 3072),
variables `{{champ}}` (meme table que les modeles d'email) et emojis, aux trois endroits ou l'on ecrit un
message RCS. La bascule texte/carte vit dans UN endroit (`web/lib/rcs.ts`, miroir serveur dans
`rcsOutboundOf`).

### Ce qui a ete verifie, et comment

- Typecheck des deux tsconfig, **2281 tests unitaires**, **274 E2E** (deux passages complets ; un echec isole
  sur `inbox-envoi-scenario` au premier passage, revenu vert seul et sur un ecran non touche : c'est
  l'instabilite deja documentee dans `playwright.config.ts`, serveur Next partage entre 4 workers).
- Les deux gardes de non-regression ont ete verifiees **DANS LES DEUX SENS** : garde retiree, le test echoue.
- **Sonde de bout en bout sur la PROD**, sans envoyer un seul message : sept corps postes sur l'URL publique
  (donc Cloudflare, NPM, la reecriture du front, l'API). Resultats : bon canal 200, canal etranger **403**,
  code inconnu **404**, corps illisible **200** (ne pas faire rejouer six fois ce qui ne sera jamais lisible),
  statut inconnu ignore. La sonde a laisse une conversation fictive sur `33600000000`, supprimee ensuite
  (1 message, 1 conversation, transaction bornee).

### Ajoute dans la foulee, le 2026-08-24

- **Les six formes de bouton** (Reponse, Lien, Appel, Agenda, Voir un lieu, Demander sa position). Deux
  demandaient plus qu un champ : la position n avait pas de RETOUR (coordonnees jetees, bulle vide) et
  l Agenda exige des date-heures absolues, donc prises dans un champ << date et heure >> du contact, avec
  chute du BOUTON (jamais du message) quand la date ne se resout pas.
- **Les boutons d une carte passent en LISTE.** Julien voulait les boutons larges des campagnes RCS et
  obtenait des mini-pastilles. Verifie dans la doc RBM : accroches a la CARTE ils s affichent pleine largeur
  et RESTENT (4 max), accroches au MESSAGE ce sont des pastilles ephemeres (11 max). Nous n en dessinons
  aucun. Des qu il y a un visuel, les boutons partent donc dans la carte.
- **La console heberge les visuels** (migration 0081). `POST /tenants/:id/rcs/media` rend directement l URL
  publique, servie par `GET /m/<code>.<ext>` (rewrite dedie, comme `/r/`). La SIGNATURE du fichier decide du
  type servi, jamais le type declare.
- 🔴 **Mesure a retenir : Cloudflare cache ces images au bord.** Avec `immutable` sur un an, une suppression
  restait sans effet un an (origine en 404, edge en 200, `cf-cache-status: HIT`). Ramene a 24 h, ce qui
  couvre toute la rafale d une campagne et borne l exposition. Purge immediate = jeton Cloudflare, qu on n a pas.

- **Envoi RCS depuis l Inbox** (bouton 📱). Sans garde de fenetre 24 h : cette fenetre est une regle de
  WhatsApp, pas du RCS, et c est justement quand elle est fermee que le RCS sert. Message pris dans la
  bibliotheque, variables resolues sur la fiche, refus en 422 avec sa raison.
- **Champ variable facon template Meta** : bouton << + Variable >>, chip [Prenom] au curseur, chaine stockee
  inchangee. L editeur a chips est partage avec le corps d un template (motif + resolveur de libelle).
- **`inbox-envoi-scenario` etait instable AVANT ce lot** (un echec sur six executions, mesure). Cause : le fil
  se recharge toutes les 4 s, un `selectOption` pendant le re-rendu vise un noeud detache sans rien signaler.
  Selection reessayee jusqu a etre posee ; le clic d envoi reste unique puisqu il poste.

### 🔴 Le canal est porte par le PARCOURS (2026-08-24, migration 0082)

Deux bugs trouves en testant le scenario reel de Julien, tous deux dus a la meme cause de fond : les regles du
moteur avaient ete ecrites quand WhatsApp etait le seul canal.

1. **Un scenario qui OUVRE par un bloc RCS n apparaissait pas** dans le selecteur de l Inbox fenetre fermee,
   c est-a-dire quand il servait le plus. `scanOpening` porte desormais `rcsOpen` dans les DEUX miroirs.
2. **Un << message rapide >> derriere un bloc RCS partait en WhatsApp**, chez un contact qui n y avait jamais
   ecrit : refus Meta 131047, parcours mort. Or un message rapide est un texte + reponses en un tap, que le
   RCS sait faire. Le bloc dit l INTENTION, le PARCOURS porte le canal (`workflow_runs.channel`).

Regle : un envoi RCS met le parcours sur `rcs`, un TEMPLATE le remet sur `whatsapp` (c est la bascule
volontaire), un message rapide suit. Le canal suit ce que le contact a RECU, jamais une intention : un bloc
RCS saute ne bascule rien, sinon le repli partirait en RCS chez un injoignable.

Seul le FORMULAIRE (WhatsApp Flow) reste impossible derriere un RCS, faute d equivalent : le builder le
signale.

### ✅ RESOLU : le clic sur un bouton RCS (2026-08-24, soir)

**Cause finale, trouvee en gardant le corps recu en base** : leur DOCUMENTATION montre un entrant avec
`from` = le contact et `recipient.to` = l agent ; leur PRODUCTION fait l INVERSE (elle garde l orientation du
sortant). On lisait `from`, on n y trouvait aucun chiffre, et on jetait le clic. Deux clics de Julien perdus.
On se fie desormais a la FORME (le premier des deux qui ressemble a un numero), pas a la position.

⚠️ **A retenir au-dela de smsmode** : l exemple d une doc d API n est pas la verite de sa production.

Corriges dans la foulee, tous signales en testant :
- le premier RCS d un scenario n apparaissait pas dans le fil d Inbox (seul chemin d envoi qui ne
  journalisait pas sa bulle) ;
- l ecran d envoi de template de l Inbox redemandait les variables en texte libre (desormais pre-remplies
  depuis la fiche, avec le libelle du champ) et l URL de l image d en-tete (desormais reprise du template).

### Trace du diagnostic (a garder, la methode a paye)

Symptome : le bouton << Recois un whatsapp >> du scenario de Julien ne declenche pas le template.

Etabli par mesure sur la PRODUCTION :
- le parcours `a6d096a3` est bien en attente sur le bloc RCS, canal `rcs`, `updated_at == created_at` : il n a
  JAMAIS avance ;
- le message est parti correctement (carte, image hebergee, boutons `btn:0`/`btn:1` DANS la carte) et il a ete
  **LU** a 22:36 ;
- un rappel smsmode est arrive 24 s apres l envoi, et **notre lecture l a rejete** (discrimination sur
  `direction`, corrigee : c est la presence d un `status` qui tranche) ;
- **aucun message ENTRANT n existe chez smsmode** sur 10 jours (`GET /rcs/v1/messages`, 4 items, tous MT).

Donc le rappel rejete etait un RAPPORT, pas le clic : le clic n a jamais produit d entrant, meme chez eux.

Deux causes possibles, une seule facon de trancher, un tap :
1. le tap n a pas ete fait / n a rien envoye ;
2. **l agent est depose en NON conversationnel** : il afficherait les boutons sans pouvoir recevoir de reponse.
   ⚠️ Ce choix est fait au depot et n est PAS modifiable (cf. `brain` RCS). Ce serait alors un redepot.

Tout est pret pour le prochain tap : parseur corrige, dernier rappel GARDE en base
(`rcs_agents.last_callback`, migration 0083), fil sous controle `app_workflow`, numero WhatsApp CONNECTED.

### Reste ouvert sur le canal

- Le **carrousel** n'a aucun composeur (le modele et le provider le supportent).
- `webviewSize` sur un bouton lien (ouvrir la page dans une vue integree) n est pas expose.
- Il n y a pas d ecran de MEDIATHEQUE : les visuels se televersent depuis le composeur, la route de liste et
  celle de suppression existent mais aucun ecran ne les appelle encore.
- Les deux cles d'API smsmode qui ont circule en clair dans une conversation sont **a faire tourner**. Elles
  sont desormais stockees chiffrees par workspace : les remplacer veut dire les ressaisir dans la carte
  d'activation de l'accueil.
- Aucun envoi RCS reel n'a ete refait apres ce deploiement : la chaine complete (envoi -> rapport -> reprise
  du parcours) n'est prouvee que par la sonde, pas encore par un vrai message.

## LIVRE ET DEPLOYE le 2026-08-23 : webhooks entrants (menu Tools)

Prod sur **`c109449`**, migration **0074** appliquee AVANT le code (image rebatie d'abord, sinon `migrate`
annonce << a jour >> depuis une image perimee). Les trois conteneurs sont sains et rattaches a
`mcp-robot_default`. Trois commits sont partis : le lot webhooks, le renommage du menu Contenu, et la
doc du lot precedent. Aucun n'etait le chantier d'une autre session.

Ce que ca fait : un outil tiers (Zapier, Make, un CRM, le formulaire d'un site) poste du JSON sur une adresse
que la console fournit ; on choisit en cliquant ou va chaque valeur (telephone, nom, champs de contact) et on
peut declencher un scenario. L'appelant n'est PAS le contact : c'est le CONTENU recu qui porte le telephone
et le nom, precision de Julien du 2026-08-23.

Decision d'architecture a retenir : un webhook qui declenche un scenario **possede** une ligne `automations`
de type `webhook` (`webhooks.automation_id`). On n'a donc ecrit AUCUNE logique de declenchement : les six
garde-fous de `runAutomations` s'appliquent tels quels. Cette ligne est invisible dans l'ecran Automation, et
cet ecran refuse d'en creer une. Detail complet : `documentation.md` §Webhooks entrants.

Etat des portes, mesure :
- racine `tsc` + `vitest` : **2158 tests** verts (2091 avant le lot, donc **67 nouveaux**).
- integration (base reelle) : **146 tests**, 141 verts + **6 nouveaux** sur l'appartenance des automations de
  webhook. Les **5 echecs** sont l'`ENCRYPTION_KEY` absente du `.env` LOCAL, connu et sans rapport (`todo.md`).
- web `tsc` + `vitest` : **107 tests** verts (**11 nouveaux**). `npm run build` passe, la route `/webhooks`
  est generee. `next lint` : aucun avertissement sur les fichiers neufs.
- E2E Playwright : **246 tests** verts (234 avant, donc **12 nouveaux**).
- Chaque test nouveau a ete verifie DANS LES DEUX SENS (mutation du code, echec constate, restauration).

Revue adversariale (agent separe, contexte isole) : **aucun rouge**. Trois points verifies un par un puis
corriges dans la foulee :
- Deux tests sur le secret **ne pouvaient pas echouer** : ils passaient par un faux store qui ne portait de
  toute facon aucun secret. La vraie frontiere est `toRow`, qui SELECTIONNE `secret_hash` et n'en garde que le
  booleen ; elle est desormais exportee et testee directement, et le faux store porte un etat.
- L'appartenance d'une automation a son webhook ne tenait qu'a un fait de presentation (l'identifiant n'est
  expose nulle part). Elle tient maintenant EN BASE : un predicat dans les quatre requetes de
  `PgAutomationStore`, avec un test d'integration qui le verifie dans les deux sens.
- Deux commentaires qui mentaient : un renvoi a une variable d'environnement inexistante, et une regle
  << jamais de 5xx >> que le code contredit deliberement en cas de panne de la file.

⚠️ En restaurant une mutation de test, un `git checkout` sur un fichier NON SUIVI par git n'a rien restaure :
la mutation (une fuite de l'empreinte du secret) est restee en place quelques minutes. Defaire une mutation
sur un fichier neuf demande une copie de sauvegarde, pas git.

Deux tests ecrits pendant ce lot **ne pouvaient pas echouer** et ont ete corriges :
- un test de « repli du mapping » qui passait aussi en dernier-gagne, parce qu'une regle qui ne resout pas
  n'atteint jamais l'affectation. Refait avec deux chemins qui resolvent tous les deux.
- deux tests E2E « pas attachable » dont le selecteur ne trouvait AUCUNE ligne : `toHaveCount(0)` sur un
  locator vide est toujours vrai. Les lignes de l'arbre portent maintenant un `data-cle`, et le test verifie
  d'abord que la ligne existe.

Verifie EN PRODUCTION, avec un webhook sonde cree puis supprime (mapping sans telephone, donc aucun contact
ne pouvait etre cree ; verifie apres coup : 0 contact, 0 webhook restant) :
- Appel bien forme -> **200** avec le corps complet, et la raison exacte (aucun champ du mapping ne vise le
  telephone).
- Corps non-JSON -> **400 `corps JSON invalide`**. C'est la preuve que la relecture du `rawBody` marche a
  travers Cloudflare + le rewrite Next + Fastify, la ou le parseur global aurait rendu un `{}` muet.
- Corps vide -> **400** explicite. Le payload est enregistre a l'identique, avec son horodatage.
- Code inconnu et code mal forme -> **404**. CRUD admin sans jeton -> **401**. Page `/webhooks` -> **200**.
- Non-regression : `/r/:code` rend toujours 404, le handshake Meta toujours 403, `/live` toujours 200.
- Les corps 4xx passent INTACTS a travers Cloudflare : c'est exactement pourquoi tout refus metier sort en
  4xx et jamais en 5xx.

⚠️ Le code de la sonde avait d'abord ete choisi avec des lettres EXCLUES de l'alphabet base32 (i, l, o, u).
La route l'aurait rejete a la verification de forme, et j'aurais conclu a une panne. Un code de test se tire
avec le meme alphabet que `newWebhookCode`, pas a la main.

Reste a faire :
- **Le premier appel d'un VRAI outil** (Zapier, Make) : jamais fait. L'arbre est teste sur des payloads
  fabriques, pas sur ce qu'un outil du marche envoie vraiment.
- Verification a l'oeil du parcours de bout en bout (creer, copier l'URL, envoyer un test, mapper).

## LIVRE ET DEPLOYE le 2026-08-21 : lot « 5 corrections »

Prod sur **`e77434d`**, migrations inchangees (**0073**), conteneurs sains. Cinq demandes de Julien,
traitees ensemble.

1. **Le nom de l'entreprise dans la miniature de template.** L'apercu affichait « Votre entreprise » sur
   100 % des rendus : la prop existait depuis toujours mais aucun ecran ne la passait. `PhoneFrame` resout
   desormais le nom verifie tout seul (une requete par espace, memorisee au niveau du module, car l'apercu de
   `TemplateForm` se redessine a chaque frappe), et l'ecran de campagne passe le numero REELLEMENT choisi.
2. **La cinematique du template cree a la volee.** Le bouton n'etait pas casse : il rechargeait une liste
   filtree sur APPROVED, affichee ailleurs, pendant que le panneau montrait un statut fige a la creation.
   L'ecran sonde maintenant tout seul (15 s, onglet au premier plan uniquement), selectionne le template des
   qu'il est approuve, et annonce un refus sans en inventer le motif.
   ⚠️ Le webhook `message_template_status_update` n'est ni souscrit chez Meta ni parse par `webhooks/parse.ts`
   (verifie des deux cotes) : le sondage est donc la seule voie, et un abonnement seul ne suffirait pas.
3. **Les clics dans le funnel par campagne** (Analytics > Quantitatif) et le RETRAIT de la carte « Clics sur
   les liens » de Mes tableaux, avec toute sa chaine (route `/stats/links`, `listAvecClics`, `lib/liens-traces`).
4. **Les faux clics.** 70 requetes mesurees sur le lien d'un template jamais envoye : 59 du robot
   `facebookexternalhit`, 11 de relecteurs Meta arrivant de Facebook. Filtre a l'ecriture
   (`src/links/clic-automatique.ts`, la redirection reste inconditionnelle) ET seuil « depuis le premier
   envoi » a la lecture, qui couvre en plus tout ce qui a ete enregistre avant.
5. **L'anglais.** 79 chaines francaises trouvees dans les modules `.ts` PURS (ou `useT()` est inappelable),
   toutes corrigees. Plus un vrai bug d'affichage : `ScenarioCanvas` comparait une chaine traduite a une
   chaine qui ne l'etait pas, donc en anglais le sous-titre redondant revenait sur tous les blocs.

### Revue adversariale passee (2026-08-21) : 6 rouges corriges

5 relecteurs sur dimensions separees, puis un refutateur par constat. 35 constats rapportes, 6 rouges
confirmes, tous corriges dans la foulee, jaunes compris (regle zero dette).

Les deux qui auraient coute cher en production :
1. **Le panneau annoncait « il est selectionne » sans savoir si quoi que ce soit l'avait ete.** La selection
   automatique s'abstient quand un AUTRE template a ete choisi pendant l'attente : la phrase mentait dans
   exactement le cas pour lequel le garde-fou avait ete ecrit, et la campagne partait avec l'autre template.
   La phrase suit desormais l'etat REEL (`templateName === submittedTemplate.name`).
2. **Les deux effets n'etaient bornes a AUCUN mode.** Apres une bascule vers Scenario ou RCS, le sondage
   continuait et `chooseTemplate` finissait par s'executer tout seul, ECRASANT la categorie (`marketing` au
   lieu de `utility`) que `chooseWorkflow` ne reecrit jamais : contacts sans opt-in ecartes, facturation
   changee. Les deux effets sortent maintenant si `mode !== 'template'`, et `chooseMode` ferme le panneau.

Les quatre autres : le marqueur `bot` teste en sous-chaine libre ecartait les vrais telephones **CUBOT**
(marque Android vendue en Europe) ; un total de contacts INVENTE a partir des lignes ramenees, plafonne par
la limite de la requete ; et deux tests qui ne pouvaient pas echouer (l'un gardait une normalisation deja
couverte par un `catch`, l'autre pretendait distinguer une reaction emoji sans jamais lui donner de payload).

### La meme fragilite, trouvee TROIS fois

Une reponse 200 amputee d'un champ pose `undefined` dans un etat type tableau, un `.length` ou un `.marketing`
du rendu jette, et React demonte l'ECRAN ENTIER. Le `try/catch` autour de l'appel n'y peut rien : il n'y a
aucune erreur reseau. Deja vu deux fois la veille (brouillons de campagne, fil de conversation), retrouvee ici
sur l'ecran de creation de campagne (`/contacts`) et sur le tableau de bord (`/stats`).

Les trois sont desormais NORMALISES a la frontiere reseau, avant d'entrer dans l'etat. Regle : tout champ
tableau lu d'une reponse se traite comme optionnel, meme quand le contrat dit qu'il ne l'est pas. Le typage
TypeScript ne couvre pas ce cas, il decrit ce que l'API PROMET.

### Verifie APRES deploiement, pas seulement en test
- 🔴 **Le filtre des faux clics, mesure en PRODUCTION sur le vrai lien** : 3 robots
  (`facebookexternalhit`, `curl`, `Googlebot`) + 1 relecteur Meta (vrai navigateur, referent
  `lm.facebook.com`) -> compteur INCHANGE a 70. Puis un vrai destinataire, sur un telephone **CUBOT** (le
  faux positif que la revue avait trouve) -> **71**. La redirection, elle, rend 302 vers la destination pour
  TOUT LE MONDE, robots compris.
  ⚠️ Le compteur de `testurl` est donc a 71 et non 70 : le +1 est mon clic de verification.
- Le nouveau libelle du funnel est bien dans le bundle servi, et `tableaux-liens` n'y est plus.
- `/api/backend/tenants/:t/stats/links` rend **404** : la route retiree a bien disparu.
- Routes protegees en **401** (et non 500), `/health` en 200, aucune erreur dans les journaux des trois
  conteneurs depuis le redemarrage.

### Ce qui n'a PAS ete verifie en production
- Le **nom de l'entreprise dans l'apercu** et la **cinematique du template** demandent une session connectee :
  couverts par 8 tests E2E, pas re-joues sur la prod. A regarder au premier passage sur l'ecran.

### Trouve en chemin, corrige au passage
- L'ecran de creation de campagne tombait ENTIEREMENT si `/contacts` rendait 200 sans le champ `contacts`
  (`undefined.length`). Normalise a la frontiere reseau. Meme classe de defaut que les deux ecrans perdus la
  veille.
- Deux fois : un backtick dans un commentaire SQL ferme le gabarit JS et produit des erreurs de syntaxe qui
  ne pointent pas la bonne ligne. Consigne dans `documentation.md`.
- Un `count` d'agregat sans `group by` rend toujours une ligne : « aucun lien trace » devenait « 0 clic ».
  C'est le test d'integration EXISTANT du funnel qui l'a attrape.

---

## LIVRE ET DEPLOYE le 2026-08-21 : lot « inbox, comptes, moderation » (7/7)

Prod sur **`c4d7b41`**, migrations jusqu'a **0073**, conteneurs sains. Cadrage et decisions :
`.loop/lot-inbox-comptes-moderation.md`. Le detail fonctionnel est passe dans `features.md`.

Les 7 items : brouillons de campagne (0068), entree Accueil, pagination + filtres SQL de l'inbox (0069),
fiche contact partagee, affectation (0070), moderation (0071), observation d'un espace depuis /ops,
multi-espaces par adresse (0072/0073).

**Le chantier « parametres d'activation MBA » est LIVRE lui aussi** (ecran Activation + migration 0067 +
regle du texte libre + abonnement webhook `standby`/`messaging_handovers`). Ce qui en reste ouvert est dans
`todo.md` : le test en conversation reelle est BLOQUE par l'absence de moyen de paiement (le bac a sable est
le seul canal), et la pastille « quelqu'un a besoin d'aide » attend cette mesure.

### Verifie APRES deploiement, pas seulement en test
- Reprise des comptes : 7 users, 7 identites, **0 sans identite, 0 hash perdu**.
- `/auth/login` rend 401 (et non 500) : la nouvelle requete d'identite tourne.
- `/auth/choose-workspace` et `/ops/observe` refusent proprement sans jeton valide.

### Ce qui reste ouvert
- **L'ECRITURE en observation** : volontairement hors lot. S'ouvrira action par action si le besoin apparait.
  Aujourd'hui une action faite par megarde chez un client serait indiscernable d'une action du client.
- **`users.password_hash`** subsiste, tenu en MIROIR de `identities` : c'est le chemin de retour de 0072.
  A retirer quand la confiance est acquise, jamais avant.
- 🔴 **0073 est la seule etape irreversible du lot** : recreer l'index d'unicite n'est possible que TANT
  QU'AUCUN doublon n'existe. Des qu'une adresse portera deux comptes, revenir en arriere voudra dire en
  choisir un a supprimer.
- Le **flake E2E** de `campaign-carousel-preview` (contention), quantifie dans `todo.md`.

---

## TERMINE ET EN LIGNE (2026-08-19/20) : le detail est passe dans features.md / documentation.md

Prod sur **`139eba2`**, migrations jusqu'a **0066**, CI verte. Trois lots livres, plus rien en cours dessus :

1. **UX + exports + statut manager** : un seul bouton « Rajouter des contacts », export PDF des cartes
   d'Analytics et des tableaux, export CSV du journal des actions, statut `manager` (mig 0065), messages de
   service dans Analytics quanti, devise sur les couts, barres d'histogramme jointives.
2. **Tracage des clics sur les liens de templates** (mig 0066) : substitution a la soumission Meta,
   redirection publique `/r/:code`, comptage, re-habillage a la relecture, et la correction d'une case qui
   MENTAIT dans Mes tableaux (un bouton URL proposait « a clique », que Meta n'emet jamais).
3. **Carte « Clics sur les liens »** dans Mes tableaux, tous envois confondus.

Ou lire quoi : le **fonctionnel** dans `features.md` (sections Templates, Analytics, Contacts, Comptes), la
**technique** dans `documentation.md` (§ Tracage des clics, § Export PDF, § Role manager), ce qui **reste
ouvert** dans `todo.md`.

### Ce qui reste ouvert (detail dans todo.md)
- Les **droits du manager** : le statut existe, il ne donne rien de plus qu'un agent. Decision de Julien.
- Le **premier test reel de bout en bout** du tracage : jamais fait. La redirection est verifiee en prod, la
  substitution en test contre un faux Meta, mais aucun template avec un lien n'a encore ete cree depuis la
  console.
- Deux templates d'essai a retirer du WABA de test (le token ne sait pas les supprimer).

### Piege trouve en construisant, a ne pas reperdre
`recordOutboundByWaId` retombe sur `type: 'template'` quand l'appelant ne precise rien : il a d'abord servi
aux envois de campagne. Un test qui n'en dit rien enregistre donc des templates en croyant enregistrer des
messages de service.

## POINT DE REPRISE (2026-08-19, apres-midi)

### En production
Prod sur **`e4d2c8e`**, migrations jusqu'a **0065**. Sont EN LIGNE : le lot des 4 demandes (bug campagne,
creation de contact, bloc Action opt-in/opt-out, Analytics multi-selection) ET « Analytics > Mes tableaux ».

⚠️ **Les mesures ont commence a s'accumuler le 2026-08-19 vers 15h30.** Toute periode anterieure reste vide,
c'est normal et l'ecran le dit. Verifie ce jour-la : le scenario « randstad » avait tourne a 9h49, donc bien
AVANT la mise en service, d'ou un tableau vide qui n'etait pas un bug. Le chemin d'une CAMPAGNE passe bien par
l'instrumentation (`worker.ts` -> `executor.start` -> `apply`), donc les envois suivants sont mesures.

Le deploiement a aussi emporte le front e-mail d'une session concurrente (ecran Boites SMTP, page Modeles
d'email, node dans le builder). Le node est VERROUILLE tant qu'aucune boite n'est connectee, avec l'infobulle
qui l'explique : rien ne peut partir par erreur.

### « Analytics > Mes tableaux » : ce qui est en ligne
Migration **0063** (`workflow_node_events`) + les 4 phases. CI verte, et 125 tests d'integration verts contre
la base de production apres deploiement.

Constat qui commande tout : **rien ne reliait un message envoye au bloc qui l'a envoye**. Il a fallu
instrumenter. **Les mesures demarrent au deploiement, pas d'historique retroactif.**

- `walk()` rend des ETAPES `{ nodeId, action }` : le bloc voyage AVEC son action.
- L'executeur mesure `sent`/`failed` sur l'issue reelle, `reply_button` (avec le handle) et `reply_text`.
- Les accuses Meta retrouvent leur bloc par `meta_message_id` (idempotent ; `sent` exclu, deja compte).
- Route `GET /tenants/:t/stats/workflow/:workflowId` : compteurs BRUTS.
- Ecran `/dashboard/tableaux` : le scenario s'affiche TEL QU'IL EST DESSINE (memes positions, memes fleches),
  blocs non-mesurables grises et inertes, panneau des mesures a droite comme dans l'editeur. Rendu par
  `web/components/ScenarioCanvas.tsx`, composant SEPARE du builder : celui-ci porte l'auto-save, et un mode
  « lecture seule » y aurait mis un enregistrement automatique a un clic d'un ecran de consultation.
- Le tableau est un HISTOGRAMME (`web/components/TableauHistogramme.tsx`) : barres verticales groupees par
  bloc, espace entre les groupes, UNE SEULE ligne d'abscisse (c'est elle qui dit que les groupes sont du meme
  parcours). UNE couleur par NATURE, sauf les clics qui prennent des nuances par POSITION du choix, sans quoi
  deux barres voisines du meme bloc seraient indiscernables. Hauteurs relatives au MAXIMUM DU TABLEAU, pas de
  chaque groupe. Regles de couleur et de groupement dans `lib/mesures-scenario.ts`, donc testables.
- ⚠️ RGPD : la purge ANONYMISE ces lignes (elles portent un wa_id), elle ne les supprime pas.

L'ENREGISTREMENT est fait (migration **0064**, `workflow_reports`) : ouvrir, nommer, enregistrer, mettre a
jour, supprimer. Un tableau ne contient que la SELECTION, jamais des chiffres : ils se recalculent a la
lecture, donc un tableau rouvert sur une autre periode repond juste.

« Echecs » et « Delivres » ne sont proposes que sur le PREMIER bloc de message : apres lui, le message part a
quelqu'un qui vient de repondre, l'envoi aboutit et arrive quasiment toujours (demande de Julien).

**Les clics sur boutons URL ne sont PAS mesurables** : Meta n'envoie aucun evenement. Chantier separe.

### ⚠️ CI rouge le 2026-08-19 au soir : test INSTABLE de la session e-mail
`web/e2e/email-accounts.spec.ts:90` echoue en CI (`getByText('Support')` matche 3 elements) alors qu'il passe
en isolation en local (6/6). Les 172 autres tests passent. Ce n'est PAS mon lot : signale a Julien plutot que
corrige, le fichier appartenant a une session active. **A reprendre : un rouge intermittent finit par rendre le
rouge normal, et c'est exactement ce qui a masque un rouge systematique ce matin.**

Deux executions CI sont aussi restees BLOQUEES 25 min sur `npx playwright install --with-deps` (incident
d'infrastructure, pas le code). Annulees puis relancees, la relance a tourne en 3 min.

### ⚠️ La CI fait partie du controle avant deploiement
Elle a ete rouge a chaque push pendant des heures sans que je la regarde (voir le commit `d442ea3`).
`gh run list` avant tout deploiement, au meme titre que `git log <deploye>..HEAD`.

### Session e-mail en parallele
Une autre session travaille sur le node « Envoi de mail » dans le MEME depot et commite sur `main`. Ne jamais
committer par repertoire ni par `-A` : chemins de FICHIERS explicites.

### (en-tête de l’ancien wip.md, conservé pour le contexte)

## Lots A-F + E.2 (2026-08-02/03) : LIVE ✅

Gros lot demandé par Julien, exécuté en feature-loop avec un reviewer séparé par sous-lot (revues
adversariales multi-lentilles). Tout est déployé.

- **A** nom libre par bloc + page Contenu > Blocs en Type | Nom | Scénario | Code.
- **B** bloc « Action » unique (ajouter/retirer tag, mettre à jour/vider champ) qui remplace les blocs tag et
  champ dans la palette (les anciens restent lisibles, zéro migration).
- **C** cohérence du contrôle du fil : routage standby, un scénario qui atteint le bloc inbox passe la main,
  filtre « À traiter », comportement au retour réglable par espace et par conversation (mig 0051), blocs MBA
  grisés et inertes.
- **D** un scénario peut démarrer sans template ; en contrepartie le sélecteur de campagne ne propose que les
  scénarios lançables.
- **E** section Automation : déclencheurs mot-clé et nouveau contact (mig 0052).
- **F** tester un scénario par lien wa.me + QR, conversation de test exclue des stats et de l'analyse (mig 0053).
- **E.2** déclencheurs tag ajouté et conversation analysée, via une file `automation-event` (pont API vers worker).

Ce que les revues ont rattrapé, et qui vaut d'être retenu : un run de campagne non démarré était compté comme
envoyé ; l'émission « tag ajouté » passait par un point partagé avec les campagnes (envoi de masse possible) ;
un anti-rebond par contact ne borne rien à l'échelle d'une population (d'où un plafond horaire) ; un parcours
en attente sans expiration rendait un contact injoignable à vie.

Tests 1151 -> 1376. Prochaine migration = 0054.

## Lot UX 6 chantiers (2026-07-28) : LIVE ✅

Lot de 6 demandes produit/UX de Julien, en feature-loop (plan validé → boucle code / reviewer(s) séparé(s) /
tests → commit + deploy par cluster). **Tout en prod.** Détail usage : `features.md`.
- **Mini-CRM** (mig **0049** soft-delete) : moteur de filtres sur l'écran Contacts (5 ops de champ,
  tag possède/ne possède pas, Email dédié) + sélection multi + « tout sélectionner (N) » + menu Action
  (tag +/-, poser un champ, **suppression douce** réversible). Soft-delete propagé aux chemins d'envoi ; ré-upsert ressuscite.
- **Scénarios** : bouton **Auto-arranger** (fonction pure `autoLayoutHorizontal`) + menu 3 points
  (Renommer via PATCH existant / Dupliquer route neuve, codes de node re-mintés / Supprimer) + colonne date.
- **Campagnes UX** : nom obligatoire étape-0 (grise le reste), Expéditeur en bandeau, jauge de débit défaut 60,
  hover template « MBA prend le relais ».
- **Contenu > Blocs** : recherche cumulable (mot-clé/contenu/type), fonction pure `filterNodes`, filtrage client.
- **Flow field mapping** : champs de base (Nom/Prénom/Email) proposés + suggérés par libellé ; « Nom » routé
  vers `profile_name` via la **sentinelle `@profile_name`** (impossible à produire par slugify → pas de collision).
- **Guide MBA** : page `/mba` de guidage client (contenu, pas de logique).

**Qualité** : reviewers séparés par cluster → **7 🔴 réels corrigés** (fuite soft-delete sur les ENVOIS,
crash 500 `fieldFilters:[null]`, collision clé email `addRow`, course réseau sur compteur de suppression,
SQL double-`tags=`, détournement `profile_name` par slug, 1re fuite campagne). Apprentissages : `brain/LEARNINGS.md`
(2026-07-28). Tests : **~1116 → 1151**. 1 migration (0049). 8 commits sur `main`, déployés (`13d39b7`→`8de2565`).
⚠️ **Prochaine migration mba = 0050.** Restent les vérifs visuelles Julien (hors boucle).

## Pièce 1 : passe d'analyse : durcissement du balayage (2026-07-14) ✅

Enquête sur un symptôme d'activation (une conversation coincée en `analysis_status='queued'` sans
job pgboss, auto-réparée à 15 min). **La cause supposée (« 1er `enqueue` sur file pg-boss neuve
no-op silencieusement, bug de cache pg-boss ») était fausse**, disprouvée par repro contre un vrai
Postgres (4 scénarios, schéma jetable) : l'enqueue crée le job à tous les coups, et `send()` sur
file absente **lève** (jamais de silence). Détail + règles réutilisables : `brain/LEARNINGS.md`
(2026-07-14).

Vrai point faible corrigé : `analysisSweep` basculait tout un lot en `queued` (`claimForAnalysis`)
puis enqueue un par un ; un enqueue qui lève orphelinait le reste du lot jusqu'au reclaim (15 min).
Extraction testable `src/analysis/sweep.ts` (`runAnalysisSweep`) : enqueue **isolé par
conversation** (un échec ne bloque plus le lot) + `reclaimQueued(id)` qui relâche aussitôt la
conversation en `pending` (reprise en secondes au tour suivant, pas 15 min). Store :
`PgConversationAnalysisStore.reclaimQueued` (gardé `WHERE status='queued'`). Tests : 4 unitaires
(`tests/analysis-sweep.test.ts`) + 2 intégration (`reclaimQueued` + garde). Bannière de démarrage
du worker corrigée (liste `analyze-conversation` quand la file est active).

Décisions actées (pas de code en plus) : (1) ré-tenter chaque tour sur transient est voulu, pas de
boucle serrée possible (un échec réel est global et fait aussi échouer le claim) ; (2) l'edge
« insert commité mais `send` rejette » est absorbé par `singletonKey` + idempotence du job + la
garde `reclaimQueued`.

## État (2026-07-06) : V1 LIVE : 1er envoi WhatsApp réel fait ✅

`mba.messagingme.app` est en **prod LIVE** (`DRY_RUN=false`). Un numéro **Zadarma**
(WABA neuf hors UChat) est branché sur l'app Meta dédiée « Messaging Me MBA »,
webhook actif (statuts de livraison), et le **premier message WhatsApp réel a été envoyé depuis
la console** (template `hello_world`, wamid Meta, livraison remontée). Assets/secrets Meta :
`brain/PROJECTS.md` §Meta/WhatsApp.

**Backend (feature-loop, chaque brique reviewée par un agent séparé) :**
- Loop 1 : webhook receiver async (signature timing-safe, ACK bouclier, file pg-boss durable,
  dédup idempotente, DLQ, BSUID-native).
- Loop 2 : wrapper Meta typé (`MetaClient`, retries/backoff, rate limiter, transport injectable).
- Loop 3 : mini-CRM + import CSV (user fields, reconnaissance colonnes, E.164, variables template).
- Loop 4 : moteur de campagne + garde-fous (opt-in, fréquence marketing-only, quality gate,
  **claim atomique** anti double-envoi, idempotent, report).
- Loop 5 : adaptateurs Postgres + services + routes HTTP + run bout-en-bout (prouvé E2E Supabase).

**Depuis (revues + corrections) :**
- Revue multi-agent Loops 3-5 (23 constats corrigés) + revue sécurité auth (12 constats).
- **Auth** : login JWT (scrypt async, rate-limit, hash leurre anti-énumération), isolation
  tenant sur toutes les routes, **RBAC** (écritures admin-only), `AUTH_SECRET` fail-fast en prod.
- **Suivi de livraison** : webhooks statut Meta -> `delivery_status` par message_id (monotone).
- **Robustesse** : création de campagne transactionnelle + sweeper des `sending` bloqués.
- **UI Next.js** (`web/`) : login, contacts + import CSV, campagnes (création + lancement +
  détail des statuts, auto-refresh).
- **Déploiement** : `mba.messagingme.app` (Docker VPS, NPM + Let's Encrypt). Cf `DEPLOY.md`.

Tests : ~148 unitaires + 10 intégration verts.

## Lot MBA : Contenu/Analytics/Support (2026-07-12) : phases 0-7 LIVE ✅

Grand lot exécuté en feature-loop (plan validé, revue transversale multi-agents + vérif adversariale par
phase, commit + deploy à chaque phase). Détail des décisions : `documentation.md §Décisions D1-D10`.
- **Ph 0** dette + aperçu WhatsApp du carousel. **Ph 1** refonte shell (sidebar gauche, pleine largeur,
  menu Compte à droite, slot Support). **Ph 2** Contenu I : Tags + User fields éditables (répercutés contacts).
- **Ph 3** Flows riches (texte/image/champ + mapping user field + création inline depuis un template),
  webhook mapping isolé, **migration 0016** (elements/ref/mapping).
- **Ph 4** Contenu II : édition/suppression Templates (garde-fou campagne active, header/footer/carousel
  non éditables) + édition-draft / « dupliquer pour modifier » Flows.
- **Ph 5** Analytics : plage de dates libre, funnel de lecture (read receipts), coût par campagne.
- **Ph 6** pastille initiales de l'agent dans l'inbox, **migration 0017** (sender_user_id).
- **Ph 7** Support : formulaire branché sur Resend.

Tests : **~380 verts**. Aucune régression. 2 migrations appliquées (0016, 0017).

## Lot 2 : Contact/Contenu/Analytics/Accueil/Ops (2026-07-12) : phases A-F LIVE ✅

Deuxième grand lot en feature-loop (plan `.loop/lot2-plan.md`, revue transversale + fixes par phase,
commit + deploy à chaque phase). Détail usage : `features.md`. Détail technique : `documentation.md`.
- **A** Fiche contact éditable (champs+valeurs+libellés, ajout champ/tag, `applyEdits` transactionnel).
- **B** Contenu liste-first + créer (Tags/Champs/Templates/Flows), aperçu au clic, **migration 0018** (table `tags`).
- **C** Templates : header **texte/image/vidéo** + footer (variable header interdite V1) ; aperçu WhatsApp header+footer.
- **D** Page **`/accueil`** (clic logo) : « Bonjour {prénom} », statut compte « jamais faux vert » (pull Graph),
  carte MBA déplacée hors Dashboard ; séparateurs de date inbox. **Migration 0019** (`phone_numbers.status`/tier).
- **E** Analytics : funnel PAR campagne (répondu attribué au dernier envoi), breakdown codes d'erreur Meta,
  graphe coût estimé filtrable campagne/template. **Migration 0020** (`campaign_recipients.error_code`).
- **F** Console **`/ops`** cross-tenant LECTURE SEULE (protégée `OPS_TOKEN`, rollup par tenant + charge pg-boss).
  Revue sécurité 10/10. `OPS_TOKEN` posé dans `.env.prod` du VPS.

Tests : **441 unit + 18 intégration**. 2 migrations (0019, 0020) appliquées avant deploy. Aucune régression.

## Lot 3 : Builder visuel (A formulaires + B automatisation) (2026-07-13) : LIVE ✅

Troisième grand lot en feature-loop (plan `.loop/lot3-builder.md`, revue transversale + fixes par phase,
commit + deploy à chaque phase). Deux builders DISTINCTS + le déclencheur campagne. Détail usage :
`features.md`. Détail technique : `documentation.md §Builder`.
- **Fix + quick wins** : bug suppression template (surface le `error_user_msg` de Meta au lieu de « Invalid
  parameter »), tag -> clic sur le compteur ouvre la **liste des contacts** taggés, **créer un nouveau champ
  depuis la fiche** contact, **miniature** de flow.
- **PA : Formulaires WhatsApp, TOUS les composants** : Dropdown/RadioButtonsGroup/CheckboxGroup, OptIn
  (consentement), passcode, date, **bouton final personnalisable**. Aperçu en direct. Menu Contenu>Flow
  renommé « **Formulaires** ». **Migration 0021** (`flows.cta`). 🔴 fermé (optin ne peut plus écraser un autre
  champ, défense front+back, RGPD).
- **PB1 : Workflow builder (modèle + éditeur visuel, SANS exécution)** : nouveau menu gauche « **Flow** »,
  éditeur **React Flow** (`@xyflow/react`), blocs template/inbox/flow/tag/field, flèches courbées drag,
  `+`/poubelle sur chaque arête, config par bloc. **Migration 0022** (table `workflows`).
- **PB2 : Moteur d'exécution** : `engine.ts` (`walk` linéaire), `executor.ts` (start applique les actions +
  persiste ; advance quand le contact répond, dédup `last_message_id`), avance branchée sur le webhook
  **isolée par message**. **Migration 0023** (table `workflow_runs`). 🔴 fermé (isolation par message).
- **PB3 : Déclencheur campagne (Template OU Workflow)** : le run de campagne DÉMARRE le workflow par
  destinataire au lieu d'un envoi template, en réutilisant l'infra campagne (claim/quality/fréquence), pas de
  nouvelle file. Front : contacts choisis d'ABORD, puis Template OU Workflow. **Migration 0024**
  (`campaigns.workflow_id` + template nullable). 🔴 fermé, **le plus sérieux** : le VRAI chemin de création
  `createWithRecipients` ne persistait PAS `workflow_id` (feature cassée en prod) alors que le test visait
  `insertCampaign`, une méthode sœur non branchée -> faux vert ; corrigé + test d'intégration remis sur le
  chemin réel. + 1 🟡 (toSummary null->'').

Tests : **~490 unit + 21 intégration**. 4 migrations (0021-0024) appliquées avant deploy. Aucune régression.
**BUILDER (A + B) TERMINÉ**, flux E2E vivant : campagne -> contacts -> workflow -> tag posé -> template envoyé
-> le contact répond -> avance -> inbox. ⚠️ mba LIVE (`DRY_RUN=false`) : tester une campagne workflow sur son
propre numéro avant un envoi large.

## Lot 5 : Builder v2 + variables + branche par bouton (2026-07-13) : LIVE ✅

6 modifs en feature-loop (plan `.loop/lot5-builder.md`, 3 phases, reviewer + 🔴 fermés + commit/deploy par phase).
- **P1 (layout)** : bot builder plein écran + nodes compacts (AppShell `fullBleed`), galerie de miniatures
  Formulaires, colonnes contact tél/BSUID/email, inbox plein écran.
- **P2 (variables)** : sélecteur « + Variable » (chip `[Prénom]`) + exemples Meta déterministes + **propagation
  malin** (table `template_param_hints` mig 0025, campagne pré-remplit son mapping). 🔴 fermé (clé paramHints
  absente n'efface plus les indices).
- **P3 (branche par bouton)** : node template à une sortie par bouton quick-reply, moteur `nextNodeByHandle` +
  `advance(+buttonPayload)` (repli 1re arête), envoi payload CONTRÔLÉ `btn:<index>`. 🔴 fermé (template sans
  quick-reply exposait 0 sortie -> repli sortie bas). ⚠️ **check LIVE Julien** : taper un bouton -> bonne branche.
- 516 unit + 24 intégration. 1 migration (0025). ⚠️ V2 (todo) : snapshot boutons figé + arêtes orphelines.

## Lot 4 : Retouches builder + identité BSUID (2026-07-13) : LIVE ✅

Quatre demandes de Julien + l'encapsulation d'identité BSUID. Revue transversale (agent séparé) : 2 🔴 fermés
+ vérifs. 501 unit + 23 intégration. Aucune migration (colonnes `bsuid`/`opt_in_source` déjà en 0001).
- **A. Aperçu Flow FIDÈLE** : composant partagé `web/components/FlowScreen.tsx` (écran WhatsApp réel : champs
  Material à label flottant, choix en lignes, bouton vert), utilisé par le builder (aperçu live) ET la popup au
  clic sur le nom. Colonne « Aperçu » du tableau retirée. Ancien rendu grossier supprimé.
- **B. Supprimer un formulaire** : Meta DRAFT->delete / PUBLISHED->deprecate, route DELETE (Meta avant store,
  422 si rattaché à un template), bouton + confirm.
- **C. Bouton campagne** : « Lancer » (brouillon) / « Reprendre » (en pause, relance les restants) seulement ;
  plus rien sur en cours / terminée / échec.
- **D. Identité BSUID** : `src/crm/identity.ts` (`classifyWaId`, `waIdOf` ; le `contactIdentity` serveur listé
  ici à l'origine n'a jamais eu d'appelant, supprimé le 2026-07-18) + `messagingTarget` (envoi
  `to` numéro / `recipient` BSUID). `bsuid` exposé (fiche, liste « Identifiant », campagne). Auto-création de
  fiche depuis l'inbound (numéro OU BSUID, isolée, opt-in 'unknown'). Matching étendu au bsuid
  (merge/tag/conversation). `buildRecipients` cible `phone ?? bsuid`. Détail : `documentation.md §Identité`.
- **2 🔴 fermés à la revue** : (1) l'envoi mettait le BSUID dans `to` au lieu de `recipient` (feature cassée dès
  le 1er contact BSUID) -> `messagingTarget` en source unique ; (2) « Lancer » caché aussi pour `paused`
  (campagne pausée par le quality gate non relançable) -> bouton « Reprendre ».

## Lot 6 : Refonte auth + onboarding (2026-07-13) : 5 phases LIVE ✅

Plan `.loop/lot6-auth.md`, feature-loop (reviewer séparé + 🔴/🟡 fermés + commit/deploy par phase). **Migration
0026** (`auth_tokens` + `tenants.status`) appliquée avant deploy.
- **Ph 1** fondations : `PgAuthTokenStore` (create/consume atomique, token sha256), `createTenantWithAdmin`
  transactionnel, `createPending`/`setPassword`, `getAuthState` + `tenantStatus`, crochet `locked`->403 (inerte).
- **Ph 2** inscription libre (`/signup` -> nouvel espace + admin), mot de passe perdu (`/forgot`, anti-énum),
  reset (`/reset/[token]`), changement (`/compte`). 🔴 fermé : `hashPassword` SYNC sur route publique ->
  event-loop DoS (le webhook tourne dans le même process) -> passé en async + `hashPasswordSync` pour seed/tests.
- **Ph 3** invitations (Resend) : `POST /invitations` (pending + token + email), accept (pose le mdp, rôle/tenant
  depuis la base pas le body). Front InviteCard + badge « invité » + `/invite/[token]`.
- **Ph 4** Google : `verifyGoogleIdToken` (jose + JWKS Google, **pas de nouvelle dépendance**), `POST /auth/google`
  (login/signup/invite par email vérifié), `GET /auth/config`, bouton GIS sur login/signup/invite. GOOGLE_CLIENT_ID
  posé au `.env.prod`. Julien a ajouté l'origine JS + publié l'app Google.
- **Ph 5** onboarding accueil : espace sans numéro -> zone grisée « Connecter ton numéro » (placeholder futur
  Embedded Signup). Pur front, « jamais de faux vert ».

## Lot 7 : variables template + bot builder + fiche contact (2026-07-13) : LIVE ✅

7 demandes de Julien. Exploration parallèle (7 agents) puis revue adversariale par chantier (6 agents) : **1 🔴 +
3 🟡 fermés**, 🔴 re-vérifié PASS. **Aucune migration** (réutilise `template_param_hints` 0025). 565 unit (+19).
- **C7 (bug 132000)** : une campagne via workflow dont le 1er node est un template envoyait **0 variable** ->
  rejet Meta. Fix : la closure `sendTemplate` (worker.ts) résout les `{{n}}` avec les attributs du contact (indices
  `template_param_hints`), repli exemple, fournit TOUJOURS N params. `buildWorkflowTemplateComponents` (PURE,
  testée), `resolveHintParams`, `getResolvableByPhone`, N via `list()` Meta caché 5 min.
- **C1** : corps du template en **chips lisibles** (`VariableBodyEditor` contentEditable, sérialise en `{{n}}`,
  caret-safe). 🔴 fermé : numérotation par MAX+1 (pas de collision après suppression d'une variable) + canonicalise
  1..N au submit ; 🟡 panneau exemples piloté par positions réelles.
- **C2** drag une flèche dans le vide -> crée un node (`onConnectEnd`). **C5** ✕ de suppression sur chaque node.
- **C3** vraie image dans la miniature (object URL local, révoqué). **C4** édition/suppression champs + Nom/Prénom
  sur la fiche (tél + BSUID lecture seule ; champ orphelin supprimable). **C6** tag du node « ajout de tag »
  déclaré dans Contenus > Tags (à la sauvegarde + au runtime, best-effort).

### Suivis ouverts (lots 1 + 2 + 3 + 4)
- **Envoi vers un BSUID non prouvé en prod** : le code route bien `recipient`, mais aucun contact BSUID
  n'existe encore (zéro trafic post-octobre). À valider au 1er BSUID réel (et confirmer l'heuristique
  `classifyWaId`). Cf `todo.md`.
- **PB2 avance sur n'importe quelle réponse** du contact (pas de branche par bouton quick-reply) : réservé à
  une itération V2 si un cas réel l'exige.
- **Funnel campagnes workflow** : delivered/read/replied = 0 (message_id synthétique `wf-<id>`, la livraison
  Meta n'est pas suivie pour ces envois). Limitation V1 assumée.
- ✅ **Refonte auth : FAITE (Lot 6, 2026-07-13)** : inscription libre + Google + invitations Resend + mot de passe
  perdu/reset/changement, tous LIVE. Reste un raffinement V2 non bloquant (invariant admin excluant les pending,
  cf `todo.md`).
- ✅ **Resend HORS mode test (2026-07-13)** : domaine `messagingme.app` **vérifié** dans un compte Resend dédié
  (region eu-west-1). `.env.prod` du VPS basculé : `RESEND_API_KEY` = clé de CE compte (⚠️ PAS l'ancienne clé du
  compte de test), `SUPPORT_FROM=support@messagingme.app`, `SUPPORT_TO=julien@messagingme.fr` ; conteneurs
  `mba-api`/`mba-worker` recréés (`up -d --force-recreate`). Envoi réel confirmé (Resend id retourné). Sauvegarde
  `.env.prod.bak.*` sur le VPS. La clé vit UNIQUEMENT dans `.env.prod` (jamais le repo).
- **Analytics (ph 5)** : le filet de revue multi-agents a stallé (souci workflow) ; revue manuelle + 32 tests
  stats clean, déployé pour test par Julien. À re-vérifier si un retour terrain remonte un souci.
- **Coup d'œil navigateur (Julien)** sur les visuels des lots 1 (ph 3-7), 2 (A-F : `/accueil`, dates inbox,
  cartes analytics, table `/ops`) et 3 (**Contenu>Formulaires** builder tous composants, menu **Flow** éditeur
  de workflow, **Campagnes** switch Template/Workflow).

## Embedded Signup + i18n + fixes campagne (2026-07-16) : LIVE ✅

- **Campagnes workflow : 3 pannes SILENCIEUSES fermées** (le « envoyé mais rien reçu » persistant) : cap fréquence
  24h retiré, indice périmé → 0 destinataire (dropdown coerce), **bouton FLOW #131009** (composant bouton flow +
  flow_token, vérifié vs Cloud API). Détail : `CLAUDE.md` §Gotchas 2026-07-16 + `brain/LEARNINGS.md`.
- **Champs système + sélecteur de variable dropdown** (constante code, sans migration ; attributs bsuid/wa_id ajoutés).
- **Brique Embedded Signup (Tech Provider)** construite + reviewée (2 failles multi-tenant corrigées avant prod) +
  déployée **OFF par défaut** (mig 0029 `waba_credentials`). Activée avec le `config_id` réel (bouton live).
- **i18n FR/EN** sur toute l'app (moteur `web/lib/i18n.tsx`, toggle menu Compte). Logo Meta Business Agent sur
  l'accueil, landing admin → Home, compte de test reviewer créé.

## Programme 16 features : lots A-E (2026-07-16) : LIVE ✅

Cinq feature-loops enchaînées (cartographie 9 explorers → plan `.loop/lotA..E-*.md` validé par Julien → boucle →
reviewer séparé → commit + deploy auto). **13 features + le socle API en prod.** Le reviewer a attrapé 4 vrais
bugs avant merge (dont le wiring `templateName` mort, cf `brain/LEARNINGS.md`).
- **A : Cohérence campagne/template** : variables template = source commune (6 champs de base + persos, comme la
  campagne), sélecteur de langue (39 langues + whitelist serveur), boutons visibles dans la miniature, écran
  campagne en 3 zones (nom en haut).
- **B : UX** : inbox auto-refresh (liste 15s / fil 4s, anti-saut-de-scroll, pause onglet masqué), analytics
  période FIGÉE en haut, suppression complète de « créer un compte » par mdp (invitations only, -221 lignes).
- **C : Scénario** : AUTO-SAVE (debounce + flush démontage/beforeunload keepalive + saves sérialisés, statut
  brouillon droppé mig **0030**, ⚠️ 1re migration DROP = deploy AVANT migrate), node **« message rapide »**
  (2-3 quick replies, `sendInteractive`, branche par bouton stable). Node `flow` no-op → différé Lot 7.
- **4a : Identifiants publics (schéma A)** : `<type>_<code-client>_<ULID>` ADDITIFS (mig **0031** + backfill
  `db/backfill-codes.ts`), racine client immuable, génération à l'INSERT (scn/usr/fld/tag), affichage discret.
  4b (nodes + champs système + endpoints) différé.
- **E : Analytics erreurs** : par TEMPLATE (dropdown, agrégation client) + par période (plage globale). 🔴 réel
  attrapé par le reviewer : wiring `index.ts` perdait le 3e arg → corrigé.
- **F (= 4b) : fin du socle identifiants** : codes des NODES mintés CÔTÉ SERVEUR au save (`nod_<client>_<ulid>`
  dans node.data.code, code valide conservé = stabilité, étranger/malformé re-minté = anti-forge), champs
  SYSTÈME déterministes (`fld_<client>_sys_<key>`), backfill nodes (1 graphe). ZÉRO migration. **Socle #12/#13
  COMPLET** ; endpoints API publics = chantier dédié (todo).
- **G (= 6) : i18n anglais COMPLET** : bug `<html lang>` fermé, day/format locale-REQUIS (Today/Yesterday,
  1,000, 42%, customers…), 0 `fr-FR` hors libs, `LocaleToggle` pré-login (5 pages). Sweep 11 agents parallèles.
  ⚠️ 2 leçons : test hors-sweep cassait le tsc racine (attrapé par le reviewer) + **gate pipé = exit masqué**
  (cf `brain/LEARNINGS.md`). Gates relancés exit codes réels.
- Tests : **707 unit** (681 → 707 : +26 nets). Migrations 0030-0031 appliquées. Baseline verte à chaque lot.

## Lot 7, Flow avancé (2026-07-17) : LIVE ✅, et fin du programme 16 features

Dernier lot du programme, feature-loop 1 tour (plan `.loop/lot7-flow-avance.md` validé, cartographie 5 explorers
+ recherche spec + 4 SONDES LIVE avant plan, reviewer transversal PASS avec 2 🟡 appliqués, commit `9fd2002`).
- **C1 fix node `flow`** : le node de scénario ENVOIE le formulaire (message interactif type flow, calque
  sendQuickMessage, accroche + CTA configurables dans le node). **Garde fenêtre 24 h à 3 étages** : 400 au save
  d'un graphe qui OUVRE sur un flow/message rapide, skip défensif au start(), badge rouge sur le node d'ouverture
  réel dans le builder. La complétion nfm_reply avance le run (mécanique existante, inchangée).
- **C2 multi-écrans** : onglets d'écrans dans le builder (max 10, titre + bouton « Continuer » par écran),
  ids `FORM`/`FORM_B`… (écran 1 = FORM pour toujours, sondé : chiffres REJETÉS par Meta), payload `complete`
  agrégé par refs globales + `_ref` -> **pipeline webhook/mapping inchangé d'une ligne**. Colonne jsonb
  polymorphe (plat = 1 écran à la lecture), ZÉRO migration. Aperçu paginé (builder + modale), miniature = écran 1.
- **C3 champs conditionnels** : « Visible si… » par élément (source = liste choix unique/consentement du même
  écran, est/n'est pas, valeur = option ou coché) -> propriété `visible` backticks. Sondé : champ masqué OMIS
  du payload (zéro écrasement de champ contact), requis caché ne bloque pas la soumission.
- **Sonde committée** `scripts/sonde-flow-live.mts` : fixture générée par LE CODE PRODUIT postée en draft sur
  le WABA réel -> `validation_errors == []` -> delete. Gate T6 rejouable à chaque évolution du générateur.
- Tests : **741 unit** (723 -> +18). Gates exit codes réels. Deploy vérifié (3 containers Up, HTTP 200).

## Lot 8 : Campagne « une-page, 2 étapes » (2026-07-17) : LIVE ✅

Refonte de l'écran campagne. Feature-loop 5 phases (plan `.loop/lot8-campagne-une-page.md` validé, cartographie
5 explorers, reviewer séparé PAR PHASE -> 5 vrais bugs attrapés, commit + deploy par phase). Détail usage :
`features.md §Campagnes`. Détail technique : `documentation.md §Campagne`.
- **P1 (f592536)** : PLEINE LARGEUR (AppShell fullBleed), une seule page en 2 ÉTAPES (Préparation / Lancement),
  lancement RAPATRIÉ sur l'écran (createCampaign -> runCampaign + polling inline). Fini « préparer ici, lancer là ».
- **P2 (055aea1, mig 0032)** : sélecteur de SOURCE (📇 Liste de contacts / 📄 Import / 🔗 HubSpot grisé) + mini-CRM
  REQUÊTABLE : `query`/`count`/`idsForFilters` (WHERE paramétré, tenant toujours) filtres tags ET/OU, opt-in,
  tél commence/contient, valeur de champ, nom ; compteur live « N correspondent ».
- **P3 (257b06b)** : import fichier comme source = composant partagé `CsvImport` (extrait, zéro dupe) + tag
  OBLIGATOIRE, puis pivot sur la source CRM taggée. Bonus : rapport d'import enfin visible côté Contacts.
- **P4 (56b844b, mig 0033)** : DÉBIT ajustable 1-80/min (slider, défaut = max), RateLimiter par campagne. Vrai 🔴
  attrapé : un timeout de job FIXE ne couvre pas un run throttlé long -> rejeu parallèle. Fix = timeout PAR JOB
  dimensionné (`campaign/pacing.ts`), cf `brain/LEARNINGS.md`.
- **P5 (74399d2, mig 0034)** : PLANIFICATION maintenant/plus tard (datetime -> ISO UTC), statut `scheduled` +
  sweeper 60s (`schedule-sweep.ts`), annulable. Badge « planifiée » + date dans la liste.
- Tests : **761 unit** (745 -> +16 : filtres, débit+pacing, sweeper, route schedule/cancel) + intégrations
  (filtres CRM, programmation). 3 migrations (0032-0034). Reviewers PASS. Restent E1 (drive navigateur) + V1
  (œil Julien) hors boucle.

## Lot 9 : ConvAnalyzer light dans Analytics (2026-07-17) : LIVE ✅

Feature-loop 2 phases (plan `.loop/lot9-convanalyzer.md`, cartographie 4 explorers dont le repo convanalyzer
externe, reviewer séparé par phase PASS). Le moteur d'analyse (Pièce 1, actif en prod, sans lecteur) est
surfacé dans Analytics. Détail usage : `features.md §Analytics`. Détail technique : `documentation.md
§Conversations (analyse)`.
- **Phase A (2dbc226)** : couche de LECTURE `src/stats/conversation-stats.pg.ts` (agrégats en une passe +
  liste quali, `tenant_id=$1` partout) + 2 routes admin-only (`/stats/conversations` + `/list`, filtres enum
  validés) + api.ts. 1er lecteur de `conversation_analysis`. ZÉRO LLM, ZÉRO migration.
- **Phase B (c88cdcf)** : bloc `ConversationAnalysisCard` (donut sentiment SVG maison, barres intent/action,
  compteurs, top topics ; table quali filtrable -> clic ouvre le fil inbox via deep-link `?c=`). Empty-state
  différencié (inactif vs aucune donnée sur la période).
- Tests : **763 unit** (+2 route) + intégration Supabase (agrégats sur jeu réel, scope tenant croisé).
  Reviewers PASS. ⚠️ Sémantique `created_at` = date de dernière analyse (cf `brain/LEARNINGS.md`). V1/V2 (rendu
  visuel + montée en charge du trafic) = vérif Julien. Base posée pour un futur agent IA décisionnel (V2).

## Prochaine étape

1. Faire approuver un template Marketing FR à variable pour de vraies campagnes.
2. **Onboarding client (Embedded Signup) : brique FAITE + déployée.** Côté Meta, **Access Verification (Tech
   Provider) VÉRIFIÉE le 2026-07-17 ✓** (email Meta « Your business has been verified as a Tech Provider »,
   business « Messaging Me » ID 103185632463539). **Reste l'App Review, encore en review** (~20 j). Rien à
   faire côté produit d'ici là : quand ce dernier feu passe au vert, le bouton marche de bout en bout et on
   tourne la vraie vidéo de démo. Surveiller mails Meta + onglet Required actions. Voir `todo.md`.
3. **Lots A-F + E.2 : TERMINÉS et déployés (2026-08-03).** La console sait désormais déclencher un scénario sur
   un événement (Automation) et se tester sans campagne (lien wa.me + QR). Suites identifiées en revue mais NON
   traitées : cf `todo.md` (sweeper des parcours en attente, contact de test compté dans la stat Contacts,
   signal « nouveau contact » perdu si le webhook est rejoué).
4. **Programme 16 features : TERMINÉ (16/16 + socle codes publics).** Restent les chantiers hors programme
   (cf `todo.md`) : **HubSpot import #14** (multi-repo, re-consentement portail = action Julien) · chantier dédié
   **endpoints API publics** · analytics palier L (erreurs Inbox/Workflow).

## Lot UX du 2026-08-17 (soir) : LIVRÉ, déployé, et porté dans `features.md`

Neuf retouches demandées d'un bloc, plus deux bugs trouvés en chemin. Les features sont désormais décrites
dans `features.md` (ajout d'un contact à la main, duplication d'un template, bannière de session expirée).
Ne restent ici que les suites.

**Deux bugs corrigés au passage, non signalés par Julien** : l'auto-save d'un scénario se relançait après un
ÉCHEC et bouclait à l'infini sur une session expirée (E2E qui compte les appels) ; et un espace NEUF refusait
le champ Prénom que son propre écran propose (cf. §champs socles).

**Abandonné après discussion** : déplacer les boutons du carousel sous les cartes (Julien a retiré la demande
une fois la contrainte Meta expliquée ; le libellé a été clarifié à la place).

**Reste à faire, petit et mécanique** : les astérisques sur les onze champs de l'éditeur de formulaire. La
liste des manquants sous le bouton couvre déjà tous les cas de blocage, d'où l'arrêt volontaire.

**Reste à VÉRIFIER par Julien** (rien ne bloque, tout est en ligne) : le champ Prénom sur son nouveau compte,
l'ajout d'un contact à la main, la duplication d'un template, le carousel, l'écran formulaire, et la bannière
de session. Plus les deux pilotes en attente de sa main : l'OTP Zadarma (numéro dédié qui décroche) et une
automation « étape de deal » avec un deal déplacé dans HubSpot.

## ✅ LIVE (2026-08-18) : configurer l'agent MBA depuis la console

**Déployé en production le 2026-08-18** (`8043f1d`), après vérification des deux règles de déploiement :
`git log 91f9cde..HEAD` (10 commits, tous ceux de ce chantier, aucun travail d'une autre session embarqué au
passage) et migrations (58 appliquées pour 58 fichiers, aucune en attente).

Vérifié EN PRODUCTION, pas déduit : les 7 ressources répondent **401** sur `/tenants/:t/mba/:pn/*` (donc les
routes sont montées ET la garde admin est active ; un 404 aurait signifié « pas montées »), `/health` répond
`ok:true`, `mba.messagingme.app/mba/parametres` répond 200, aucune erreur dans les journaux des 3 conteneurs.

⚠️ Le `git pull` sur le VPS échouait d'abord : des copies de sondes y traînaient en non-suivi alors que ces
mêmes chemins sont désormais suivis dans le dépôt. Retirées avant le pull. Réflexe pour la prochaine fois : une
sonde déposée à la main sur le VPS devient un obstacle le jour où elle est committée.

**Reste à faire, non bloquant** : le coup d'œil visuel de Julien sur les 4 points marqués « vérif Julien » dans
`.loop/mba-ecrans-parametres.md` (cohérence de style, lisibilité des 8 onglets sur écran étroit, ton des
messages FR et EN, rendu de la transcription du bac à sable).

### Le détail du chantier (historique)


**Reprendre ici : les routes backend `/tenants/:t/mba/*`, puis les écrans.**

### Ce qui a changé aujourd'hui, et qui débloque tout

**MBA est OUVERT sur la France**, mesuré et non déduit : `agent_eligibility` renvoie `is_eligible:true` sur
`+33 5 25 68 03 01` (`phone_number_id=1305301719324792`, WABA `1067000669256166`), après acceptation des ToS
par Julien. Toute la surface `agent_config/*` répond. Le relevé complet et les 20 écarts avec notre
transcription du 2026-07-20 sont dans `docs/MBA-API-REFERENCE.md` (chapitre en tête) et
`messagingme-pilot/docs/META-BUSINESS-AGENT-API.md`.

**L'agent du numéro de test est configuré et il RÉPOND.** Posé par API : business info, une skill de
comportement (interdiction d'inventer horaire/tarif/délai, escalade sur incident), et **80 FAQ dont 77
RÉELLES** tirées de la base du chatbot `keolis-auxerre`. Testé dans le bac à sable (`agent_test`, jetons non
facturés) : il refuse d'inventer un horaire, cite les vrais contacts du réseau, suit le fil d'une
conversation, et « je veux parler à un conseiller » déclenche un `handoff_reason: customer_request`.
**Le mécanisme central du produit fonctionne de bout en bout.**

### Fait et poussé

- `src/mba/client.ts` : client des cinq ressources (business info, FAQ, skills, fichiers, sites web) plus
  réglages, allowlist, éligibilité, `agent_test`. **9 tests** (`tests/mba-client.test.ts`), aucun réseau.
  Trois pièges absorbés dans le client : `api.facebook.com` sans version dans le chemin (pas Graph), la forme
  d'erreur `{title, detail}` propre à MBA (sinon le `detail`, qui porte la marche à suivre, est perdu), et le
  REMPLACEMENT COMPLET de `business_info`/`settings` (`fusionnerBusinessInfo`, `modifierSettings` repassent
  les clés inconnues telles quelles). `agent_id` toujours explicite sur les skills.
- Outillage (`scripts/`) : `sonde-mba-live.mts` (état d'un agent), `mba-config-initiale.mts`,
  `mba-charger-faq-auxerre.mts` (idempotent), `mba-test-agent.mts` (bac à sable, messages via `MBA_MESSAGES`),
  `mba-activer-restreint.mts` (allowlist puis activation), `sonde-waba-billing.mts`, `sonde-capacites-app.mts`,
  `sonde-webhooks.mts`. Plus un lanceur `mba-test.sh` sur le VPS.

### Routes backend : FAITES (2026-08-18)

`src/http/mba.ts`, montées sous `/tenants/:t/mba/:phoneNumberId/*`, groupe **admin-only**. Le contrôle
d'isolation est `phoneNumberBelongsToTenant` : la surface MBA est indexée par NUMÉRO, pas par tenant, donc
sans lui un admin authentifié piloterait l'agent d'un autre client en changeant l'id dans l'URL.

`status` · `settings` (PATCH) · `rollout` (PUT, route SÉPARÉE car l'effet est asymétrique) · `business-info`
(GET/PATCH) · `faq` (CRUD + `preview` + `import`) · `skills` (CRUD) · `websites` · `files` · `allowlist` ·
`test` (bac à sable). **27 tests** (`tests/http-mba.test.ts`) + **16** sur l'extraction (`tests/mba-faq-import.test.ts`).

Trois défauts corrigés au passage, dont deux trouvés en relisant la spec :

- **`PUT settings` renvoyait `agent_id` et `channel` dans le CORPS** alors qu'ils sont dans la réponse du GET
  mais PAS dans le schéma de requête (risque de 400), et sans `agent_id` en QUERY le PUT bascule en
  « create-or-fetch » : on ne sait plus quelle configuration on écrit. Corrigé dans `src/mba/client.ts` ET
  dans `scripts/mba-activer-restreint.mts`, test vérifié dans les deux sens.
- **SSRF par redirection** sur l'import de FAQ depuis une URL : le contrôle d'hôte ne portait que sur l'URL
  saisie. Les redirections sont maintenant suivies à la main et CHAQUE saut est revalidé (3 max).
- Le compte-rendu d'import comptait les créations par identifiant retourné : une entrée créée sans `id`
  aurait été recomptée comme « restant à faire » au passage suivant.

### La suite, dans cet ordre

1. **Écrans**, en remplacement de la maquette GELÉE de `web/app/mba/parametres/page.tsx` (151 lignes, tout est
   désactivé, son propre commentaire dit « le jour de l'éligibilité, on branche chaque section »). Un onglet
   par ressource, plus l'écran d'import de FAQ (aperçu avant écriture).
2. **Excel et PDF vers des FAQ structurées : NON FAIT, décision en attente.** Aucun parseur dans le dépôt et
   les deux candidats sont mauvais (`xlsx` npm est figé en 0.18.5 avec une CVE de pollution de prototype ;
   `exceljs` est énorme). Ce qui marche DÉJÀ sans rien ajouter : Meta accepte nativement `.pdf`, `.docx`,
   `.csv` et `.xlsx` comme **fichiers de connaissance** (route `files`), donc un client qui arrive avec ses
   procédures en PDF est servi aujourd'hui. La conversion d'un PDF en Q/R structurées demanderait en plus une
   segmentation par LLM, avec une perte de fidélité : à ne faire que si le besoin d'ÉDITER chaque Q/R une par
   une le justifie. ⚠️ `.csv` et `.xlsx` en fichier de connaissance sont conditionnés à un réglage de l'asset
   WhatsApp que la doc Meta ne dit ni comment vérifier ni comment activer : prévoir un message d'aide dédié
   quand un CSV part en 400 alors qu'un PDF passe.

### Décisions produit prises avec Julien

- **FAQ : saisie unitaire ET import en masse.** Une par une à la main, plus un chargement par lot depuis
  **CSV, Excel, PDF, ou une URL qui porte les Q/R**. C'est le vrai sujet : un client arrive avec ses Q/R déjà
  écrites ailleurs (Keolis en avait 78), le formulaire unitaire ne suffit pas. Réutiliser `CsvImport` côté
  front. Le chargement doit rester **idempotent** (ne pas dupliquer une question déjà posée), comme
  `mba-charger-faq-auxerre.mts`.
- **Skills = personnalité et procédures, PAS du tool calling.** Trois champs : `title`, `description` (QUAND
  l'appliquer), `skill` (QUOI faire, 20 000 caractères). Le tool calling, ce sont les **Connectors + Tools**,
  qui décrivent un appel HTTP sortant dont l'agent extrait les paramètres depuis la conversation. Une skill
  peut orchestrer des tools. C'est pour ça que l'étape « Tools » de l'écran Meta est grise sans connector.
- **Connectors/Tools : REPORTÉS**, volontairement. Ils ne servent à rien tant que la connaissance de base
  n'est pas pilotable, et l'étude du cas GTFS a montré que le vrai travail est côté API métier du client.

### Le cas GTFS/Auxerre, étudié (à garder pour la reprise des connectors)

⚠️ **Auxerre n'utilise PAS de GTFS** (c'est Grand Dole). Ses horaires viennent de **grilles JSON** générées
hors ligne en parsant les PDF. L'API existe : `GET /api/bus/next?grille=&arret=&heure=&n=`, protégée par un
jeton partagé (`x-api-key` ou `?token=`), ce que MBA sait consommer (`auth_type: API_KEY`).

**Le maillon fragile est le paramètre `grille`** (`3`, `3-samedi`, `dim1`, `navette`) : aujourd'hui c'est le
flow WhatsApp qui choisit la grille selon le jour. Confier ce choix au LLM lui demanderait de connaître les
samedis, dimanches, fériés et vacances scolaires, et une erreur de grille donne un horaire faux avec l'aplomb
d'une réponse juste. **À faire avant tout connector : un endpoint qui prend `arret`, `ligne`, `quand` et
déduit la grille CÔTÉ SERVEUR.** Prévoir aussi un jeton dédié au connector, révocable seul.

### En attente (hors de notre main)

L'agent ne peut pas être allumé (`rollout.enabled=true`) : Meta répond « Cannot enable Meta Business Agent.
A payment method is required », avec le lien exact du Billing Hub. Le numéro de Julien (`+33633921577`) est
déjà dans l'allowlist de l'agent, et `mba-activer-restreint.mts` fait le reste en une commande le moment venu.
**Julien s'en occupe, ne pas relancer sur le sujet.**

## Audit anti-slop du 2026-08-18 : CORRIGÉ et déployé ✅

Demande de Julien : « audit code simple et structure maintenable, sans verbiage et sans slop ». Rapport
complet dans `AUDIT-ANTI-SLOP-2026-08-18.md`, corrections dans les commits `b1f3758` -> `87ba4e0`, déployées
sur `mba.messagingme.app`.

**Méthode** : 7 auditeurs en parallèle (une zone chacun, ~40 000 lignes lues) puis 7 contre-experts séparés
qui rouvrent chaque fichier, refont les grep et réfutent par défaut. **57 findings rapportés, 57 confirmés.**
Le juge n'était pas le producteur, et ça se voit : plusieurs findings ont été regradés ou corrigés dans le
détail par la contre-expertise, aucun n'était inventé.

**Verdict** : la structure profonde est saine (moteurs purs à IO injectée, `tenant_id` partout, transactions
propres, commentaires narratifs jugés « un actif »). La dette avait UNE nature dominante, le copier-coller :
24 findings de duplication sur 57. Le repo connaissait pourtant son antidote (fragments SQL partagés, tests de
parité) ; la dette, c'est là où le réflexe a manqué.

**Les 6 rouges** : `scopeTenant` (le contrôle d'accès tenant) copié 22 fois · un cast non validé sur l'API
publique qui transformait un 400 en 500 · l'INSERT de campagne écrit deux fois (déjà responsable d'un faux
vert sur `workflow_id`) · le matching wa_id copié 10 fois · un composant React déclaré dans le corps d'un
autre, donc une modale qui perdait sa sélection à chaque message reçu (BUG RÉEL) · l'assistant de campagne à
1000 lignes et 41 états.

**50 des 51 jaunes** ont suivi (7 lots) : code mort fauché, documentation décollée de sa fonction recollée,
fragments SQL et helpers front mutualisés. Détail des modules créés : `documentation.md` § Modules partagés.

**Reste UN item, à cadrer avec Julien** : le découpage de `web/lib/api.ts` (1325 lignes, 203 exports) par
domaine derrière un barrel. Mécanique, mais il brasse tous les imports du front. Voir `todo.md`.

**Deux changements VISIBLES à l'écran**, assumés : l'aperçu WhatsApp affiche « Votre entreprise » au lieu du
nom du compte pilote figé en dur (faux chez tout autre client), et l'interrupteur MBA grise pendant sa
sauvegarde comme les trois autres de la page.

**Un flake E2E PRÉEXISTANT supprimé au passage** : mesuré à 3 échecs sur 5 suites complètes avant, 0 sur 5
après. Les tests de l'inbox cliquaient pendant que le fil se rechargeait, et le clic se perdait sur un noeud
détaché. La mesure comptait : sans elle, je me serais attribué un flake qui ne venait pas de moi.

**Gates à la fin** : 1702 tests unitaires, 100 tests d'intégration (base réelle), 79 E2E, build web, types
propres des deux côtés. Déploiement du 2026-08-18 fait dans l'ordre : `git log` du commit déployé (13 commits,
aucun travail tiers embarqué), migrations vérifiées AVANT (« à jour, rien à appliquer »), puis build et
redémarrage. Vérifié après : API saine, worker reparti avec ses 6 files, front public en 200, zéro erreur.

## Migrations : l incident du 2026-08-17, a ne pas refaire

⚠️ **Ce titre annonçait « 0083 appliquée, prochaine libre = 0084 » jusqu au 2026-08-29 : quinze migrations de
retard.** Le compteur vit dans le CLAUDE.md du repo et NULLE PART ailleurs. Trois documents le recopiaient, tous
les trois faux (PLAN.md en retard de 43, le cerveau de 15, celui-ci de 5). Un compteur recopié est un compteur
qui dérive, et croire celui-ci menait à écrire par-dessus une migration existante.

Le chantier RCS (canal comme dimension de premier ordre) a ses migrations en base : `channel` sur
`conversations`/`conversation_messages`/`campaigns` (défaut `whatsapp`, tout l'existant intact), unique de
`conversations` passé à `(tenant_id, channel, wa_id)`, `campaigns.phone_number_id` devenu nullable, et les tables
`rcs_agents`/`rcs_capabilities_cache` créées. Vérifié après coup : aucune perte, toutes les lignes en `whatsapp`.

🔴 **Incident à ne pas refaire.** Ces migrations ont été appliquées en RETARD : du code qui les attendait avait
déjà été déployé, et pendant 1 h 30 aucun message entrant n'a été enregistré (le contact se créait, la
conversation non, le job partait en file d'échec `webhook-dlq`). Cause : quatre déploiements sans exécuter les
migrations, alors que `DEPLOY.md` décrit l'étape et annonce même le symptôme. Voir `~/CLAUDE.md` (règle ferme) et
`brain/LEARNINGS.md` 2026-08-17. ⚠️ Un message reste dans `webhook-dlq` (rien ne consomme cette file) : sans
outil de rejeu, la reprise se fait en renvoyant le message.

## OTP automatique de l'Embedded Signup (Zadarma) : précâblage FAIT, pilote à mener (2026-08-16)

But : ne plus demander au client de trouver un numéro. On lui en fournit un (Zadarma), Meta l'appelle et
dicte le code, on transcrit l'enregistrement et on poste le code par API (`verify_code`), donc **hors de la
popup Meta**, qui est un iframe d'un autre domaine et ne se remplit pas automatiquement.

Codé et testé, inerte tant que `ZADARMA_API_KEY/SECRET` sont vides : `src/zadarma/{client,api,otp-extract,
otp-capture}.ts` et `src/meta/phone-register.ts`.

**Gotchas Zadarma mesurés en direct le 2026-08-16 (ne pas les redécouvrir) :**

- 🔴 **Lecture vs écriture.** En GET les paramètres vont dans l'URL ; en **POST/PUT ils vont dans le CORPS**
  (`x-www-form-urlencoded`), URL nue. Un PUT qui laisse ses paramètres dans l'URL arrive SANS paramètres,
  la signature est recalculée sur une chaîne vide, et Zadarma répond **401 « Not authorized »** : on accuse
  alors les clés, qui sont bonnes. Mesuré : à paramètres identiques, GET -> 404, PUT -> 401 ; paramètres
  déplacés dans le corps, PUT -> 404.
- 🔴 **Signature** = base64 du HMAC-SHA1 **hexadécimal** (56 caractères). Signer les octets bruts donne
  28 caractères et un 401 tout aussi muet.
- `receive_sms` arrive en **chaîne** « false ». Les numéros français sont **voix seule** : pas d'OTP par SMS.
- La **reconnaissance vocale est autorisée** sur le compte (vérifié sur un identifiant bidon : 404
  « fichier introuvable », pas un refus de droits).
- 🔴 **Rien ne décroche aujourd'hui** : le PBX n'a aucune extension, donc aucun enregistrement, donc rien à
  transcrire. À régler dans le panneau Zadarma (« Mon PBX » > « Appels entrants et SVI » : un scénario
  déclenché par « appels vers le numéro », qui DÉCROCHE et garde la ligne, avec l'enregistrement d'appel
  activé). C'est le préalable au pilote, et ça ne se fait pas par l'API.

**Déployé le 2026-08-16** (mba `f20962c`), mais sans effet : les modules ne sont importés par aucun fichier
exécuté. Le parcours d'embarquement actuel (popup Meta, numéro cherché à la main, code recopié à la main) est
strictement inchangé.

**Verdict du sondage d'architecture (2026-08-16).** Le ROUTAGE d'un numéro est pilotable par API :
`PUT /v1/direct_numbers/set_sip_id/` accepte une adresse SIP EXTERNE (exemple explicite dans la doc). Donc un
client se provisionne en un appel d'API, zéro clic, ce qui sauve la thèse « on fournit le numéro » à l'échelle.
Le DÉCROCHÉ, lui, n'a aucune commande d'API : la machine qui répond doit être à nous, ou être le répondeur de
Zadarma, dont personne n'a pu confirmer qu'il dépose un enregistrement porteur d'un identifiant d'appel
exploitable.

**Prochain pas, et ce n'est PAS de construire.** Le risque qui tue l'angle n'est ni le routage ni le décroché,
c'est de savoir si **Meta accepte de dicter son code à une machine** ou raccroche en détectant un répondeur.
Aucun retour d'expérience publié nulle part. Ça se teste sans rien bâtir : répondeur Zadarma sur un numéro
DÉDIÉ (jamais un numéro qui sert Odalys, EDHEC ou Gan Prévoyance), un OTP déclenché, et on regarde. Si Meta
dicte, l'infra SIP maison devient inutile ; s'il raccroche, l'angle full-auto meurt et on bascule sur le repli
assisté en ayant économisé la construction.

Contrainte de conception relevée : l'appel de Meta arrive quasi immédiatement après `request_code`, donc le
routage doit être **armé avant**, jamais réglé à la volée.

Reste ensuite : le pilote, la réserve de numéros en base (migration 0056), la route + l'écran qui affiche le
code en direct (qui est aussi le repli assisté si le full-auto meurt), et l'instanciation du client dans
`index.ts`. Question NON technique à trancher tôt : le dossier d'identité exigé pour un numéro français. S'il
en faut un par client final, le geste manuel revient par la porte juridique et c'est le modèle qui est touché,
pas le code.

## Node « Envoi de mail » (SMTP) dans les Scénarios : design validé, plan à venir (2026-08-18)

Demande de Julien : un node « Envoi de mail » dans les Scénarios. Décidé avec lui : **SMTP
uniquement** (pas d'expéditeur partagé Resend, pas de vérif de domaine, Gmail/Google Sign-In
écarté vu le coût de validation du scope restreint), **plusieurs boîtes SMTP par client** (le
node choisit laquelle envoie), setup **dans le menu en haut à droite** (admin-only), modèles
d'email (basique + HTML, variables `{{champ}}`) dans « Contenu », destinataire **libre**
(adresse en dur, nous/contact/tiers, ou variable d'un champ). Node best-effort non bloquant :
un mail raté n'arrête jamais le parcours WhatsApp.

Design complet : `docs/superpowers/specs/2026-08-18-node-email-smtp-design.md`. Réutilise le
coffre `secretbox`, le patron `waba_credentials`, le câblage unique `wiring.ts`, la résolution
de variables des templates. Neuf : tables `email_accounts`/`email_templates` (**migration
0060**), stores + résolveur + client `nodemailer`, routes admin-only, écran de connexion,
section « Modèles d'email », type de node `email`. ⚠️ Contacts sans colonne email : « écrire au
contact » suppose son email dans un `user_field`. Prochaine étape : plan d'implémentation.

## En attente (dépendances externes)

- **MBA (agent auto-réponse)** : bloqué par les ToS (403 « Meta Business AI Terms »), gating
  vertical. Veille à mettre en place (cron `agent_eligibility`). Parqué.

## Plafond de débit des routes authentifiées (2026-09-07)

Le seul trou de code relevé par l'audit sécurité du 2026-09-07 : `/auth/*`, les clés d'API et `/w/:code`
avaient chacun leur limiteur, **les 235 routes authentifiées n'en avaient aucun**. Un compte agent légitime
pouvait marteler `/tenants/:id/contacts` sans plafond. Ce n'est pas un défaut d'accès, c'est un levier de
déni de service et de coût vers Postgres.

**Deux plafonds, deux clés, et c'est le choix de clé qui porte tout le raisonnement.**

- **Général, par UTILISATEUR** (`RATE_LIMIT_USER_PAR_MINUTE`, défaut 300/min), posé DANS `makeRequireAuth`.
- **Routes coûteuses, par ESPACE** (`RATE_LIMIT_COUTEUX_PAR_MINUTE`, défaut 10/min), composé sur six routes :
  import CSV et son aperçu, action en masse, purge, export d'historique, lancement de campagne. Clé
  `tenantId` parce que ce qu'on borne là est la charge qu'un ESPACE envoie à Postgres : un espace à dix
  comptes aurait sinon dix fois le plafond.

🔴 **La place du plafond dans `makeRequireAuth` est le fond du sujet, pas un détail.** Il se prend APRÈS
`verifySession` (la clé n'existe pas avant, et ce ne peut pas être `req.ip` : sans `trustProxy`, derrière
Cloudflare et NPM, il désigne le conteneur proxy, donc un plafond dessus serait GLOBAL à la plateforme et un
seul appelant bruyant couperait tout le monde) ; AVANT `loadState` (sinon chaque refus coûte une requête SQL,
exactement ce que le limiteur de `/w/:code` a appris) ; et AVANT la branche des sessions d'emprunt, **qui
sort par un `return` anticipé** et serait donc restée sans plafond.

🔴 **Un hook Fastify global ne pouvait pas faire ce travail**, et c'est la raison de fond : les hooks globaux
tournent AVANT les `preHandler` de route, donc `req.auth` n'existe pas encore. La seule clé disponible aurait
été `req.ip`, c'est-à-dire la mauvaise. Se greffer dans la garde d'authentification donne en prime la
propriété du garde-fou `scopeTenant` : les 36 modules l'héritent d'un coup, et un module ajouté demain l'aura
sans que personne y pense.

🔴 **`gardeEtendue` existe pour un piège MUET.** `Guard` vaut « un preHandler OU un tableau », et
`requireAdmin` est déjà un tableau : écrire `[garde, extra]` produit un tableau IMBRIQUÉ que Fastify
n'exécute pas. La garde ajoutée ne tournerait jamais, sans erreur, sans trace.

🔴 **Un défaut trouvé en recopiant l'existant : `retry-after` se calculait sur `Date.now()`** alors que
`resetAt` est daté de l'horloge INJECTABLE du limiteur. Les deux n'ont aucune raison de coïncider, la
soustraction donne un grand négatif, et le plancher à 1 seconde le masque : l'appelant s'entend dire
« réessayez dans 1 seconde » pour une fenêtre d'une minute. Le défaut dormait dans `api-key.ts` depuis sa
création parce que ses tests utilisent l'horloge réelle. La durée d'attente est désormais rendue par
`remaining()`, sur la même horloge que la date de reset, et calculée à un seul endroit.

🔴 **Les en-têtes ne servaient à rien sans `exposedHeaders`.** Depuis la bascule, la console (`engageme`) et
l'API (`api`) sont des origines DIFFÉRENTES : un navigateur ne laisse JavaScript lire qu'une courte liste
d'en-têtes sûrs, dont `retry-after` ne fait pas partie. Ils seraient partis sur le réseau, visibles dans
l'onglet Réseau, invisibles au code. Symptôme : « le plafond marche, mais la console ne sait jamais dire
combien de temps attendre », un défaut qu'on impute au front alors qu'il vient de l'API.

⚠️ **Aucun plafond de CLÉS sur ces deux limiteurs**, contrairement à ceux de `/auth/*` et `/w/:code`. La règle
de `rate-limit.ts` est « en poser un dès que la clé est choisie par l'APPELANT » : ici elle vient d'un JWT
VÉRIFIÉ, donc elle n'est pas libre, et un plafond ferait refuser un utilisateur NEUF quand la table est
pleine, c'est-à-dire punir un client légitime pour la charge des autres.

⚠️ **Les deux limiteurs sont LOCAUX AU PROCESS**, comme tous ceux du dépôt : le plafond annoncé est celui
d'UNE instance. `AUDIT-ARCHITECTURE-AUTOSCALING-2026-09-03.md` les nomme parmi les trois adhérences à lever
avant le multi-replica. Les porter en base coûterait une écriture Postgres par requête, ce qui irait contre
le but de la garde.

**Calibrage MESURÉ, pas deviné** : la console ne porte qu'un seul `setInterval` de 15 s, soit 4 appels/min.
300/min laisse deux ordres de grandeur de marge. **0 désactive** chacun des deux plafonds, et c'est la trappe
de secours assumée : ils s'appliquent aux 235 routes d'un produit en production, un `--force-recreate` va
plus vite qu'un déploiement de code.

**Ce que la revue a écarté après vérification** : `/v1` et `/mcp` passent par `requireApiKey`, qui a son
propre limiteur et ne traverse pas `requireAuth`, donc aucun double comptage ; et monter les modules coûteux
sans `auth` est IMPOSSIBLE, le garde-fou `scopeTenant` fait échouer `buildServer` au démarrage (vérifié en
l'exécutant, pas en le supposant).

**Tests** : `tests/rate-limit-utilisateur.test.ts` (22 cas) et un cas ajouté à `tests/cors.test.ts`. Les deux
sens ont été vérifiés à la main : en remettant le code fautif (route `run` repassée sur la garde ordinaire,
puis consommation du plafond retirée), 8 tests tombent, dont le structurel qui nomme la route exacte.

## Auto-attaque : on tape sur son propre produit (2026-09-07)

`scripts/auto-attaque.mts`, lancée par `npm run auto-attaque`, **et branchée dans la CI** (job `unit`).

🔴 **Ce qu'elle apporte que les 3853 tests n'apportent pas.** Ceux-ci prouvent que chaque garde, prise UNE
PAR UNE, se comporte comme son auteur l'a voulu. Ils ne prouvent pas qu'elle est POSÉE sur les 169 routes
réelles, parce qu'un test unitaire monte son propre câblage et que le faux bouge avec le code. Ici
**l'inventaire vient du serveur CONSTRUIT** (`printRoutes` aplati), jamais d'une liste écrite à la main :
une route ajoutée demain sans garde est trouvée sans que personne y pense. 540 sondes.

🔴 **La polarité est « tout est fermé sauf preuve du contraire ».** Les routes publiques sont énumérées dans
le script, une par une, AVEC la raison de leur ouverture. Une route qui répond sans session sans y figurer
est une trouvaille. L'inverse (lister les routes à tester) serait une liste à tenir à la main, donc une
liste qui dérive. `/auth/change-password` est délibérément ABSENTE de la liste des ouvertes, pour que la
sonde 1 continue de vérifier qu'elle est bien gardée.

⚠️ **Le mode local ne peut pas booter le vrai serveur**, et c'est une contrainte, pas un choix de confort :
le `DATABASE_URL` du `.env` de ce poste pointe sur la base de PRODUCTION. Un « local » qui démarre
l'application serait aussi dangereux que la prod, sous un nom rassurant. Il monte donc `buildServer` avec des
dépendances factices (un `Proxy` qui satisfait n'importe quelle forme, d'où les 40 modules montés sans base
ni réseau). Ça ne retire rien à ce qui est prouvé : **les gardes s'exécutent AVANT les dépendances**.

Le mode distant (`--cible=<url> --je-sais-ce-que-je-fais --jeton= --tenant=`) existe parce qu'il est le seul
à voir la couche que rien d'autre ne couvre : routage par chemin de NPM, Cloudflare, CORS de la nouvelle
origine, config réelle. Il refuse en dur les sondes destructrices, ne joue que les LECTURES pour l'IDOR, et
exige un compte de test dédié. **Les deux modes partagent le même moteur de sondes** derrière une interface
de transport à deux implémentations : deux scripts auraient divergé.

**Les dix sondes** : sans authentification · IDOR (espace croisé) · jeton signé d'un autre secret · session
d'emprunt en écriture · `/ops` avec un jeton de client · webhook Meta sans signature et avec une fausse ·
CORS depuis une origine hostile · plafond de débit · en-têtes de plafond exposés au front · jeton de choix
présenté pour un espace non listé.

🔴 **VÉRIFIÉE DANS LES DEUX SENS, et c'est ce qui la rend crédible.** Un script d'attaque toujours vert ne
prouve rien tant qu'on ne l'a pas vu mordre. Quatre failles plantées à la main, quatre détections précises :
module monté sans garde -> 10 trouvailles sur les routes exactes ; `scopeTenant` rendu défaillant-ouvert
(le défaut réellement corrigé le 2026-09-03) -> 205 ; garde de lecture seule des sessions d'observation
retirée -> 113 ; vérification d'appartenance du jeton de choix retirée -> 1, la bonne.

**Deux faux positifs corrigés à la première exécution, dans le SCRIPT et pas dans le produit** : les points
d'entrée d'authentification portent d'autres noms que ceux que j'avais supposés (`forgot-password`,
`reset-password`, `invitations/accept`, `choose-workspace`), et le receveur Meta refuse en **403**, pas en
401. Vérifiés dans le code avant d'élargir quoi que ce soit : une trouvaille qu'on fait taire en élargissant
la liste blanche est une faille qu'on s'autorise.

## Ce que le déploiement du 2026-09-07 a appris

🔴 **LE 502 APRÈS `up --build` EST INTERMITTENT, et c'est ce qui le rend dangereux.** Le CLAUDE.md racine le
décrit depuis longtemps (NPM tient l'ANCIENNE IP du conteneur, nginx ayant résolu son amont au CHARGEMENT de
sa config). Le fait NOUVEAU est qu'il n'est pas apparu au PREMIER déploiement de la journée et qu'il est
apparu au SECOND, sur exactement la même commande. **Le contrôle public devient donc obligatoire après
CHAQUE reconstruction**, pas seulement quand on se méfie. Diagnostic en deux appels, et il tranche d'un coup :
interne 200 + public 502 = le proxy ; interne 502 = l'application. Remède :
`sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`.

⚠️ **Et le contrôle public se fait sur le BON chemin.** `mba.messagingme.app/webhooks/meta` rend **404**,
parce que le routage par chemin de NPM l'envoie à `mba-web`. Le webhook Meta vit sous
`/api/backend/webhooks/meta`, et aussi sous `api.messagingme.app/webhooks/meta`. Un 404 sur le mauvais chemin
ressemble à une panne du chemin critique de réception des messages clients, et n'en est pas une : on croit
avoir cassé la production alors qu'on s'est trompé d'adresse.

🔴 **La preuve qu'un déploiement a pris ne se lit PAS dans le silence des journaux.** Sans trafic entrant, un
silence ne prouve rien. Ce jour-là, la preuve était l'en-tête `access-control-expose-headers: retry-after,
x-ratelimit-*`, qui n'existe que depuis le commit déployé : une réponse qui ne pouvait PAS être produite par
l'ancienne image. Chercher cette pièce-là à chaque déploiement, plutôt que constater une absence d'erreur.

⚠️ **Un `git checkout` sur le VPS ne reconstruit RIEN.** Les conteneurs continuent de tourner l'image
précédente : les fichiers changent, le service non. Il faut `up -d --build` derrière, sans quoi on croit
avoir déployé un commit et on en sert un autre.

## Le bouton de chaîne qui ne lançait rien (2026-09-08)

🔴 **UNE GARDE QUI REFUSE EN SILENCE SUR UN CHEMIN DÉCLENCHÉ PAR L'UTILISATEUR FINAL EST INDISCERNABLE D'UNE
PANNE.** Julien : « le message qu'on clique n'aboutit pas au lancement du scénario ». Tout fonctionnait : le
message arrivait, le mot-clé correspondait, l'automation était trouvée et évaluée. Le refus venait du
DÉMARRAGE, `runFrom` ayant vu que le fil appartenait à l'agent de Meta. Le seul endroit où cette raison
existait était une ligne du journal du worker. Ni l'abonné, ni la console, ni l'écran des chaînes n'en
disaient un mot, et l'écran des chaînes affichait même « N personnes ont envoyé ce message » juste à côté,
ce qui donnait l'impression que le clic marchait.

🔴 **CE N'ÉTAIT PAS UN CAS RARE, C'ÉTAIT LE CAS NORMAL, et c'est ce qui a fait chercher ailleurs.** L'espace
a l'agent de Meta allumé, donc chaque scénario lui REND le fil en arrivant au bout (`releaseToMba`), et il le
garde 24 heures (`CONTROL_MBA_TIMEOUT_MS`). Le SECOND appui d'un même abonné tombait donc toujours dans cette
fenêtre. La fonctionnalité marchait une fois par abonné et par jour, ce qui ressemble davantage à un bug
intermittent qu'à une règle. La leçon générale : **quand une garde dépend d'un état que le produit repose
lui-même en fin de parcours, cet état est le cas NORMAL, pas l'exception.**

🔴 **ET L'ÉCRAN QUI GÈRE UN ÉTAT DOIT OFFRIR LA SORTIE POUR TOUS SES ÉTATS.** `control_owner` en a trois ;
le bouton « Rendre la main » de l'Inbox ne sortait que sur `app_human`, alors que la route serveur, elle,
rend la main quel que soit le détenteur. Un fil passé à l'agent de Meta n'avait donc AUCUNE sortie depuis la
console : seul le délai de 24 h le libérait. La capacité existait, elle n'était simplement pas atteignable,
ce qu'aucun test ne pouvait voir puisque le serveur, lui, était complet.

**Le correctif, en deux morceaux.** (1) Le bouton s'affiche pour tout détenteur, avec un libellé qui change
de sens (on REND une main qu'on a prise, on la REPREND à l'agent de Meta). (2) Décision de Julien : un clic
sur un bouton de chaîne REPREND la main, comme une campagne, parce que c'est un geste explicite, celui de
l'abonné. ⚠️ **Seulement la chaîne** : une automation ordinaire par mot-clé qui reprendrait la main ferait
écrire un scénario par-dessus l'opérateur en train de répondre, sur n'importe quel message.

⚠️ **`possede_par` a changé de nature au passage**, et c'est le genre de glissement qui se paie plus tard si
on ne l'écrit pas : elle était un PRÉDICAT de portée (quelles automations l'écran Automation peut piloter),
elle est aussi devenue une VALEUR lue par le chemin chaud. `tests/automation-possession.test.ts` affirmait
« `listEnabled` ne contient pas `possede_par` » et a cassé alors que rien n'était cassé : l'assertion visait
le WHERE et interdisait aussi le SELECT. Elle dit maintenant ce qu'elle veut dire, dans les deux sens.

⚠️ **La capacité voyage dans un OBJET, pas dans un sixième paramètre.** `AutomationRunnerDeps.startWorkflow`
a changé de FORME plutôt que de gagner un argument : une flèche à cinq paramètres reste assignable à un
contrat qui en déclare six, et le sixième est avalé en silence (mesuré dans ce dépôt, cf. le CLAUDE.md). Le
changement de forme a fait nommer par le compilateur les trois implémentations à reprendre.

## Trois défauts d'écran signalés par Julien (2026-09-08)

🔴 **UN SEUL DÉCLENCHEUR D'ENREGISTREMENT, PLACÉ AU DÉBUT, NE PEUT CAPTURER QUE LE DÉBUT.** Le brouillon de
campagne ne partait qu'au `onBlur` du champ NOM. Comme le nom est la première chose qu'on tape, le brouillon
photographiait un écran encore vide : ni destinataires, ni template, ni variables, ni débit. Le symptôme
rapporté ne portait que sur les destinataires parce que c'est le travail le plus long, mais tout se perdait.
**`features.md` promettait pourtant depuis le 2026-08-21 « rouvre exactement où on l'avait laissé :
destinataires, message, variables, débit »** : une promesse écrite qu'aucun test n'exerçait, et le faux
backend des E2E n'aidait pas, son `PUT` ne gardant que le `name` et jetant le `state`. **Un faux plus pauvre
que le vrai rend vertes des choses qui ne marchent pas.**

La réparation a deux moitiés, et il fallait les deux : l'état enregistré porte désormais les destinataires
(filtres, sélection, mode « tout ce qui correspond » et ses exclusions), et l'enregistrement suit TOUT
l'écran, débouncé. ⚠️ L'état est sérialisé à chaque rendu plutôt que suivi champ par champ : une liste de
dépendances tenue à la main dériverait au premier champ ajouté, et l'enregistrement cesserait de le suivre
sans que rien ne le signale.

⚠️ **Deux pièges de course, tous deux fermés.** (1) Le chargement de la liste de contacts RECOCHE tout par
défaut, ce qui est juste quand les filtres changent, et tombait juste après la restauration d'un brouillon :
une marque portant les identifiants restaurés le neutralise pour ce seul premier chargement. (2) Une
minuterie d'enregistrement encore en vol RECRÉAIT le brouillon après sa suppression (campagne lancée), en
double et sans identifiant : une marque d'abandon, posée AVANT toute attente, la neutralise.

🔴 **UN POINT DE RUPTURE TAILWIND LIT LA LARGEUR DE L'ÉCRAN, JAMAIS CELLE DU CONTENEUR.** Le formulaire de
template est rendu à deux endroits : sur sa propre page (pleine largeur) et dans la colonne « Message » de la
campagne (une demi-page). Son aperçu prend **300 px fixes**. Mesuré au pixel, largeur restante du champ
« Nom » dans la campagne :

| écran | 1280 | 1440 | 1600 | 1920 |
|---|---|---|---|---|
| champ « Nom » | **26 px** | 101 px | 181 px | 341 px |

À 1280, la page Templates dispose de ~900 px et veut ses deux colonnes ; la campagne de 345 px et n'en veut
qu'une. **Même écran, besoins opposés : aucune media query ne peut les distinguer.** D'où un drapeau posé par
l'appelant, qui SAIT dans quoi il rend. ⚠️ Une requête de conteneur (`@container`) serait l'outil juste, et
elle a été ÉCARTÉE pour une raison mesurable : `container-type` implique `contain: layout`, ce qui fait du
conteneur le bloc de référence des descendants `position: fixed`. Or le sélecteur de variables pose un voile
`fixed inset-0` pour se fermer au clic extérieur : il cesserait de couvrir la page. (Tailwind 3.4 n'a pas le
greffon non plus, et l'ajouter pour un besoin ferait dériver la stack.)

⚠️ Le test qui garde ce point MESURE des largeurs. Une assertion sur une classe CSS passerait au vert le jour
où la classe existe sans plus rien produire.

⚠️ **ET UNE RÈGLE ÉCRITE DANS UN FICHIER N'EST PAS UNE RÈGLE APPLIQUÉE PAR CE FICHIER.** « Construire en
parlant » était déclaré onglet par défaut depuis le 2026-08-31, commentaire à l'appui, et le chemin de
CRÉATION d'un agent ouvrait quand même « Identité et ton » : le seul moment où l'on tombe sur des champs
vides est celui où l'agent vient de naître, donc où l'on a le moins d'idée de quoi y écrire. Le test qui
couvrait ce chemin vérifiait un champ de l'onglet Identité : il exerçait le mauvais onglet, et c'est lui qui
aurait dû faire échouer la règle le jour où elle a été posée.

## Vérifier un test d'INTÉGRATION sans attendre la CI (2026-09-08)

🔴 **LE PROBLÈME, ET POURQUOI IL COÛTE CHER.** Le `DATABASE_URL` du `.env` local pointe sur la base de
PRODUCTION : les tests d'intégration ne se lancent donc pas d'ici, et le dépôt le dit partout. Conséquence
tue : un test d'intégration neuf partait vers la CI **sans jamais avoir été vérifié dans les deux sens**,
alors que la règle du dépôt l'exige. On poussait un test dont on ne savait pas s'il échouait sans le
correctif, ce qui est exactement la garantie qu'il prétend apporter.

**La recette, qui prend deux minutes.** Un Postgres jetable sur le VPS, atteint par un tunnel SSH :

```bash
# 1. Le conteneur. L'image PGVECTOR, la même que la CI : sur l'image nue, la migration 0110 échoue
#    (« extension "vector" is not available ») et on s'arrête à mi-chemin sans base utilisable.
ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS   "sudo docker run -d --name pg-itest -e POSTGRES_PASSWORD=itest -e POSTGRES_DB=itest      -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16"

# 2. Le tunnel, à laisser tourner.
ssh -i ~/.ssh/id_ed25519 -N -L 55432:127.0.0.1:55432 ubuntu@$VPS

# 3. Les migrations, puis les tests. `DB_SSL=off` est OBLIGATOIRE : sans lui, `pgSsl()` force un objet SSL
#    et le Postgres local répond « the server does not support SSL connections ».
DATABASE_URL="postgres://postgres:itest@127.0.0.1:55432/itest" DB_SSL=off npm run migrate
DATABASE_URL="postgres://postgres:itest@127.0.0.1:55432/itest" DB_SSL=off   ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"   npx vitest run --config vitest.integration.config.ts

# 4. Et on le retire quand on a fini.
ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS "sudo docker rm -f pg-itest"
```

⚠️ **`ENCRYPTION_KEY` est nécessaire même pour un test qui ne chiffre rien** : neuf tests des suites
`agent-sources` et `email-account-store` échouent sans elle, et le message (« ENCRYPTION_KEY invalide ») se
lit comme une panne du lot qu'on vient d'écrire. La CI en génère une à chaque exécution.

⚠️ **Le port 55432 et non 5432** : la machine de Julien peut avoir un Postgres local, et un tunnel qui
écraserait son port ferait tourner les tests sur la mauvaise base sans rien dire.

## 🔴 Un test tuyauté dans `tail` perd son code de sortie (2026-09-08)

`npx playwright test --reporter=line | tail -12` rend le code de sortie de **`tail`**, pas celui de
Playwright : il vaut donc **toujours 0**. Cinq échecs sont passés inaperçus derrière un « 500 passed » qui
n'était que la dernière ligne visible du flux tronqué.

**La parade :** rediriger dans un fichier et lire le code de sortie, jamais tuyauter.

```bash
npx playwright test --reporter=line > /tmp/e2e.txt 2>&1; echo "CODE=$?"; tail -6 /tmp/e2e.txt
```

Même famille que le `gh run watch --exit-status` qui a rendu 0 sur un run en échec (cf. CLAUDE.md) : **le
verdict d'une suite se lit sur son code de sortie ou sur son compte d'échecs, jamais sur la dernière ligne
qu'on a sous les yeux.**

## Reste (non bloquant) : voir `todo.md`

- TLS pooler en vérif complète (pinner la CA Supabase).
- Unicité email globale (décision produit).
- Pagination contacts UI, quality rating alimenté par webhook, tests DLQ/CI intégration.

---

## Cinq lots contre une même cause, livrés et déployés le 2026-09-14 et le 2026-09-15

Point d'entrée : le rapport d'architecture du 2026-09-14 (onze candidats, produits par une revue de
profondeur : « quel levier une interface donne-t-elle par unité de complexité à apprendre ? »). Trois lots en
sont sortis sous un plan commun, `docs/superpowers/plans/2026-09-14-dependances-non-optionnelles.md`, puis
deux autres de performance.

**La cause, nommée une fois pour toutes.** Le dépôt écrivait depuis des semaines « une capacité câblée sur un
consommateur sur trois » sans nommer la cause. C'est une FORME D'INTERFACE : quand une règle qui doit tenir
partout est portée par une dépendance déclarée OPTIONNELLE, un câblage qui l'oublie compile, passe les tests,
se déploie, et la règle ne s'applique pas sur ce chemin. Rien ne le signale parce qu'il n'y a rien à signaler,
le programme est valide.

**Lot 1, `cb63450`** : le montage des routes passe par un registre (`modulesDeRoutes`), 48 entrées déclarant
chacune leur `ClasseDAcces` (six classes, pas deux). La couverture du garde-fou d'authentification se DÉRIVE
au lieu d'être une seconde liste de 40 noms recopiée. Essai : la table de routes de Fastify, capturée avant et
après, identique au caractère (220 routes). Trouvé en chemin : `hubspotEvents` était déclaré autorisé par un
code d'URL alors qu'il l'est par une SIGNATURE, et son adresse ne porte aucun code.

🔴 **Et le registre a passé son premier essai réel sans son auteur, en douze heures.** Une autre session a
ajouté deux modules de routes la nuit suivante, sans avoir lu le plan : les deux ont dû déclarer leur classe,
sont entrés sous le garde-fou tout seuls, et ont ajouté leurs deux cas de test sans que personne y pense.

**Lot 2, `0fd9b4e`** : la garde d'authentification devient REQUISE dans 46 modules, sous un seul nom. Le motif
`garde ? { preHandler: garde } : {}` (45 endroits) disparaît, et `gardeEtendue`, point de passage partagé de
sept modules, cesse d'accepter `undefined` en rendant des options vides. Quand `deps.auth` manque, `buildServer`
fabrique une garde qui REFUSE au lieu de `undefined`.

🔴 **Un type qui EXIGE une dépendance ne dit pas qu'elle est POSÉE**, et ce lot l'a prouvé sur lui-même : des
options de route écrites `{ ...garde, bodyLimit }` au lieu de `{ ...opts, bodyLimit }` répandaient la garde au
lieu de l'objet qui la porte. La route partait sans `preHandler` et rendait 403 sur un geste légitime. Le
compilateur ne voyait rien ; un test qui inspecte ce que Fastify a RÉELLEMENT enregistré l'a vu.

**Lot 3, `150dc25`** : `estDesabonne` devient requise dans les quatre interfaces qui la consomment. Trois
fixtures mentaient au compilateur (`as never`, `Record<string, unknown>`) et ont échoué au RUNTIME, sur
`estDesabonne is not a function` : c'est la preuve, obtenue sans la chercher, que la garde s'exécute désormais
là où elle était sautée. ⚠️ Son essai en production reste DÛ (cf. `todo.md`).

**Lot 4, `fc6fe80`** : le rejeu de prise du fil sort de la fermeture de `buildWorkflowRuntime` et rejoint le
geste qu'il rejoue (`src/inbox/controle-du-fil.ts`). Ses quatre règles (un rejeu et jamais deux, la
classification du refus, le `Retry-After`, son plafond) étaient invérifiables. Le câblage ne détient plus que
la version qui rejoue, donc « il appelle bien le module extrait » est vrai par construction.

🔴 **Une mutation qui ne casse rien ne prouve pas que le test est bon, elle prouve que la mutation était
inerte.** Porter la boucle de 2 à 3 tentatives ne cassait aucun test : `derniere` codait en dur
`tentative === 1`, donc la troisième n'existait pas. Deux constantes qui devaient rester cohérentes, dans le
même fichier, remplacées par `REJEU_TENTATIVES`.

**Lots 5 et 6, `3dd9650` et `486f814`** : le numéro Meta de l'espace, son WABA et la note de qualité passent
d'une lecture PAR DESTINATAIRE à une par process. Sur le chemin scénario, jusqu'à trois requêtes de moins par
message, à comparer aux ~7 que coûte déjà un message sur un pool de 8 connexions.

🔴 **On ne met en cache que les réponses POSITIVES, et c'est ce qui autorise à mettre en cache une DÉCISION.**
`cache-court.ts` prévient qu'il ne convient pas à une décision. L'asymétrie lève l'objection : une réponse
positive ne devient fausse que si le numéro change d'espace (et l'envoi échouerait alors VISIBLEMENT chez
Meta), tandis qu'une réponse nulle devient fausse à l'instant où un client branche son premier numéro, et le
cache étant par process, aucune invalidation ne traverse l'API et le worker.

🔴 **Mettre en cache une valeur qui commande un ARRÊT demande une mesure, pas une intuition.** La note de
qualité met la campagne en pause au ROUGE. Ce qui l'autorise : la colonne n'est pas écrite en temps réel, elle
est rafraîchie par le balayage `statut-numeros` toutes les VINGT MINUTES. Un test épingle désormais l'ÉCART
entre les deux constantes, invariant qui ne vit dans aucun des deux fichiers.

**Ce que l'audit du coût des règles d'envoi a établi, et qui a changé la conception du candidat 6.** Un point
d'envoi unique NAÏF, appliquant les sept règles par message, aurait ajouté jusqu'à **15 000 requêtes et 10 000
appels Graph** sur une campagne de 5 000, parce que la plupart de ces règles sont délibérément HISSÉES hors de
la boucle (filtre pur sur une colonne jointe, requête groupée, `Map` en mémoire, mémoïsation par liste
d'effets). Le sas doit donc se placer SOUS les règles, là où `metaFactory.clientForTenant` réunit déjà les
quatre chemins, et porter ce qui reste : le journal et la frontière d'import.

⚠️ **Le 502 de NPM après un `up --build` s'est manifesté deux fois sur cinq déploiements**, et son mécanisme
est devenu clair : seuls les conteneurs RECRÉÉS perdent leur IP. `mba.messagingme.app/` répondait 200 pendant
que tout le reste était à 502, parce que `mba-web` n'avait pas été recréé. Il touche le webhook, donc les
messages entrants.

---

## Deux incidents MBA, la rafale des accusés, et seize actions d'audit : 2026-09-15 au soir et 2026-09-16

Quinze commits, tous déployés, CI verte sur ses trois jobs à chaque fois. **Aucune migration** : le compteur
reste à 0150.

### La file des accusés se vidait à deux par minute, et personne ne le savait

Point de départ : Julien lit la carte de latence de `/ops` et trouve `webhook-status` anormale (p50 à 2 min,
pire cas 5 min). Mesuré dans `pgboss.job` : le traitement d'un accusé dure **0,058 s**, tout le reste est de
l'attente. La file sonde toutes les 30 s, prend UN job, sans notification : **deux accusés par minute**.

Le garde-fou existant (`burstWhenReadyExceeds: 20`) ne servait que l'avalanche d'une campagne. L'usage
ordinaire est un PAQUET (Meta rend trois accusés par message), qui n'atteint jamais vingt. Le seuil est
devenu **par file**, `webhook-status` à 2, donc « dès trois en attente ». ⚠️ La comparaison de pg-boss est
stricte : écrire `3` en pensant « dès trois » aurait laissé le cas le plus fréquent hors rafale.

Rafale mesurée le 2026-09-10 à 16:06 : **vingt accusés en 1,2 seconde**, soit dix-sept par seconde.

### Les « deux minutes de Meta » n'existaient pas

🔴 **La correction la plus importante de la session, et elle porte sur une mesure que j'avais faite la veille.**
Quatre endroits affirmaient que « Meta acquitte nos envois avec DEUX MINUTES de retard », sur une corrélation
par identifiant de message. C'était une **erreur de lecture** : les heures relevées étaient celles où notre
worker TRAITAIT l'accusé. Vérifié dans le journal brut des webhooks : l'horodatage que Meta inscrit dans
l'accusé du message de 08:26:47 vaut **08:26:47**, et son webhook arrive à **08:26:48**.

Le marqueur de la migration 0149 reste juste (on attend une PREUVE, pas un délai), seule la cause était mal
attribuée.

### Le lissage des tâches minutées, qui répare un INDICATEUR et pas une latence

Les 23 tâches du worker partaient toutes de t=0 avec des cadences multiples les unes des autres, donc elles se
rejoignaient. Mesuré : une minute ordinaire coûte **13 requêtes et zéro attente**, une minute de rendez-vous
**26 requêtes et 5 à 10 attentes** sur un pool de huit. Sur 1 763 attentes de la journée, 1 393 venaient de
là. Le registre décale désormais le premier tour selon le rang d'enregistrement.

⚠️ Ce qu'on répare n'est pas 240 ms sur des balayages que personne n'attend, c'est que **la saturation du pool
est le seul signal de saturation du produit** et qu'il était allumé 272 minutes par jour pour une cause
permanente. Vérification après déploiement : la minute de rendez-vous est passée de 5-7 attentes à **zéro**.
⚠️ La minute du REDÉMARRAGE garde son pic, par construction : le registre ne lance pas la première passe, ce
sont les appelants qui le font.

### Deux incidents MBA, et la preuve tenait dans le mode de livraison de Meta

**Incident 1 (`33685973811`)** : un client écrit à 15:28, personne ne répond. La preuve : Meta livre un
message en `messages` quand NOUS tenons le fil, et en `standby` quand son agent le tient. Le matin même, sur
un autre numéro, on recevait des `standby` ; à 15:28 on a reçu `messages`. **Meta nous croyait maîtres du fil,
notre base disait `mba` depuis 07:35.** Cause : le balayage avait rendu **dix** conversations d'un coup,
toutes muettes depuis 166 à 281 heures, donc hors fenêtre de 24 h, et il jetait le verdict de Meta.

**Incident 2 (`33634264992`)** : `app_workflow` avec `control_changed_at` à null. `listHeldControl` excluait
délibérément ce cas, avec une justification fausse (« null = personne n'a jamais pris ce fil ») : or
`app_workflow` est la valeur PAR DÉFAUT et envoyer un message prend le fil implicitement. Résultat : ni dans
« À traiter » (ce dossier exclut `app_workflow`), ni chez l'agent. **Invisible et muette.**

Trois tâches, un commit chacune : le fil repasse à l'agent **à l'arrivée du message** (seul instant où la
fenêtre est ouverte) ; le balayage ne passe plus la main sur une fenêtre fermée et appelle Meta AVANT
d'écrire ; l'angle mort du null est fermé, borné par la fenêtre pour ne pas saturer le lot de 500.

### 🔴 Trois défauts trouvés par la revue dans mes propres correctifs

1. **Une garde posée après l'effet de bord.** `only: ['app_workflow', 'mba']` protégeait notre colonne, pas
   l'appel à Meta : un opérateur en train de répondre se faisait prendre le fil au message suivant du client.
   Le détenteur se lit désormais AVANT l'appel.
2. **Un `coalesce` MORT.** Combiné à la borne de fenêtre, il exigeait le dernier message à la fois plus vieux
   et plus récent que 24 h. Et un test affirmait le contraire, parce qu'il cherchait le mot `coalesce` au lieu
   de l'effet.
3. **Une garde trop large.** La garde de fenêtre portait sur « ce client a un agent » au lieu de « on allait
   appeler Meta » : elle bloquait aussi les transitions qui ne parlent pas à Meta, ce qui aurait éteint en
   silence le garde-fou des 24 h.

### Le journal d'audit passe de 7 à 23 actions

Trois lots, choisis par Julien dans un inventaire des 28 modules d'écriture : les **accès** (comptes, clés
d'API, connexions échouées), les **portes** (webhooks entrants, connecteurs), puis le **numéro connecté** et
**l'export d'un contact**. Aucune migration, `audit_log.action` étant un `text` libre.

⚠️ **Le plan confondait deux familles sous « webhooks sortants »**, relevé en lisant le code : un webhook est
une adresse que NOUS exposons, donc une porte d'ENTRÉE ; un connecteur porte l'adresse du système du client,
donc la SORTIE. Corrigé dans le type, pas seulement dans la conversation.

🔴 **Et une mutation qui n'a rien cassé a révélé le vrai trou.** En débranchant le filtre de données
personnelles du `insert`, la suite restait verte : les tests n'éprouvaient que la fonction pure. Un test lit
désormais les paramètres envoyés à Postgres.

### Un défaut PRÉEXISTANT trouvé en vérifiant sur les vraies données

`CONTROL_MBA_TIMEOUT_MS` repose les fils de l'agent en `app_workflow`, la seule valeur que « À traiter »
exclut. Une conversation où le client attend est donc une ligne de travail visible **pendant 24 h**, puis elle
disparaît. Onze conversations dans ce cas au moment de la mesure. Sans rapport avec les lots du jour, écrit
dans `todo.md` : la question (qui reprend quand l'agent n'a pas conclu ?) est produit, pas technique.

### La cible Scaleway, écrite parce qu'elle a été demandée

`docs/ARCHITECTURE-CIBLE.md` : la règle des deux tiers (l'API élastique, le worker permanent) et ses trois
conséquences indépendantes de tout fournisseur, les trois chantiers à finir avant de multiplier les processus,
le sort du connecteur HubSpot, la question Redis avec son déclencheur, et la séquence du jour J. Mesures qui
l'accompagnent : base à **30 Mo**, **25 connexions ouvertes sur 60 dont une active**, **131 transactions par
minute au repos**, et **aucune dépendance spécifique à Supabase** dans le dépôt.

## L'assistant de construction refusait sa propre proposition (2026-09-17)

Julien, capture à l'appui, au **9e point sur 10** de l'entretien de construction d'un agent IA :
« l'assistant a rendu une proposition hors format ». Il venait de répondre « emoji » à la question du ton.

**Ce point-là est le DERNIER de l'ordre du jour.** Le mandat envoyé au modèle se fait en deux temps :
questions tant qu'il reste un point à couvrir, écriture des champs une fois tout couvert. Le tour qui a
échoué est donc le **premier du temps 2**, le premier où le modèle écrit la fiche entière, ses règles
d'arrêt, ses outils. C'est-à-dire le premier où les bornes du schéma s'exercent vraiment : les neuf tours
précédents ne portaient qu'un message et des réponses, et ne prouvaient rien.

### La mesure

Le schéma JSON envoyé au modèle et le schéma Zod qui juge sa réponse sont écrits à la main, l'un en miroir
de l'autre, avec un test de parité. Ce test compare des **noms de clés** et leur caractère requis. Extraction
faite ce jour-là des bornes réellement appliquées par Zod, puis comparaison avec ce que le schéma annonçait :

```
31 bornes sur 31 refusent une réponse que le modèle n'a jamais été prévenu de borner.
```

Longueurs de textes, tailles de tableaux, motifs des codes et des noms exposés : rien. Un modèle
parfaitement coopératif, respectant chaque consigne écrite du mandat, pouvait donc voir son tour refusé sur
une règle qu'il n'avait jamais reçue. Reproduit sur une proposition de concession automobile :

```
code "coordonnees_transmises_au_conseiller" : 36 car. -> REFUSÉ
```

`CODE_SORTIE_RE` plafonne à 32 caractères, et ce nombre n'était écrit **nulle part ailleurs qu'en elle**. En
français, un aboutissement de conversation dépasse 32 caractères sans effort.

Le coût n'était pas cosmétique : la route n'enregistre l'entretien qu'APRÈS une réponse valide, donc le tour
entier partait, **message du client compris**, et l'appel au modèle était quand même facturé (sur notre clé
maison, cet assistant étant à notre charge depuis le 2026-09-14).

L'asymétrie la plus parlante : le client qui **tape** un code dans le formulaire le voit normalisé sous ses
yeux (`web/lib/agent-sorties.ts`) ; l'assistant qui **propose** le même code voyait toute sa proposition
jetée. La même règle, deux traitements opposés, et un seul des deux écrit quelque part.

### Ce qui a été livré (`f7a9349`)

- `assainirProposition` ramène la réponse dans les bornes avant que Zod ne juge : couper, normaliser un code,
  dédoublonner. **La frontière de sécurité ne bouge pas** : c'est la liste des clés et les énumérations
  fermées, vérifié par deux tests qui exigent qu'un handler hors catalogue reste refusé.
- Les bornes sont annoncées au modèle (556 caractères, environ 139 tokens par tour), et
  `tests/agent-setup-bornes.test.ts` les **dérive** de Zod au lieu de les lister à la main.
- `normaliserCodeSortie` existe côté serveur, autorité dont le front est la copie, parité testée fonction
  contre fonction.
- Le 422 journalise chemins et codes d'erreur, jamais les valeurs. Sans cette trace, le défaut signalé n'a pu
  être attribué qu'en mesurant l'écart entre les deux schémas : **on ne sait toujours pas quel champ exact a
  échoué dans la session de Julien**, seulement lequel était le plus probable.

### Le défaut trouvé en revue SUR LE CORRECTIF LUI-MÊME

Des règles d'arrêt toutes inexploitables (des chaînes au lieu d'objets) devenaient une liste **vide**. Or
`fiche.sorties` est le seul champ que le patch REMPLACE au lieu de fusionner : le diff montré au client
devenait « avant : vos trois règles d'arrêt, après : rien ». Une proposition d'**effacement fabriquée à
partir de bruit**, qu'il ne restait qu'à valider d'un clic. Avant le correctif, ce cas rendait 422. La clé
disparaît désormais ; un `[]` explicite reste, lui, un retrait délibéré du modèle.

### Deux choses apprises sur la vérification

**Cinq mutations jouées à la main**, chacune fait tomber son test : route qui n'assainit plus, borne retirée
du schéma annoncé, normalisation serveur qui dérive du front, handler hors catalogue réécrit, garde
anti-effacement retirée. La première comptait le plus : les tests unitaires appelaient `assainirProposition`
en direct, donc **retirer l'appel de la route les laissait tous verts**. C'est mot pour mot la leçon de
`scope-tenant.test.ts`, « un type qui exige une garde ne dit pas qu'elle est POSÉE ».

Et une **sixième mutation « passait »** : en fait le `sed` ne s'était pas appliqué (indentation différente).
Une mutation qui passe doit d'abord prouver qu'elle a été POSÉE, sinon elle rend un faux négatif rassurant.
Corollaire payé le même jour : restaurer un fichier muté se fait par COPIE de sauvegarde, jamais par
`git checkout --`, qui sur un fichier non commité détruit le travail en cours.
