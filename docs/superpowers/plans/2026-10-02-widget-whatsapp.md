# Le widget WhatsApp : plan d'implémentation

**But :** une bulle WhatsApp à poser sur le site d'un client, qui ouvre WhatsApp avec un message pré-rempli, pour
tous les clients de la console.

**Approche :** une route publique sert un JavaScript dont la configuration est écrite dedans (aucun CORS). Une
table `widgets` porte la phrase, l'apparence et le devenir. À l'arrivée d'un message, la phrase identifie le
widget et son devenir s'applique à cette conversation, une seule fois.

**Spec :** [docs/superpowers/specs/2026-10-02-widget-whatsapp-design.md](../specs/2026-10-02-widget-whatsapp-design.md)

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff**, décidée dans la spec. La production emprunte ce chemin, le
lot crée une surface publique irréversible, et il porte des invariants qu'aucun test ne voit : la stabilité d'une
URL distribuée chez des tiers, et l'arbitrage entre deux réglages de répondeur. L'essai qui clôt se fait dans un
navigateur, sur un vrai site, avec un vrai téléphone.

## Contraintes globales

- 🔴 **L'arbre local est en retard de 153 commits sur `origin`** (constaté le 2026-10-02). Travailler depuis
  `origin/main`, et lire chaque référence avec `git show origin/main:<fichier>` plutôt que dans l'arbre.
- 🔴 **Le numéro de migration se lit dans `db/migrations/` d'`origin` au moment d'écrire le fichier.** 0199 a été pris
  par une autre session le jour même (`0199_mcp_propose.sql`), donc **0200** au moment du lot 1 ; et ça recommence, mais plusieurs sessions en écrivent : le dossier tranche sur ce qui est PRIS, la base sur ce qui est
  APPLIQUÉ, et le compteur du `CLAUDE.md` ne fait foi ni pour l'un ni pour l'autre.
- 🔴 **L'identifiant public du widget est opaque et immuable.** Une balise posée chez un client est une porte à
  sens unique : l'adresse devra répondre pour toujours.
- Isolation : `tenant_id = $1` sur chaque requête, la RLS étant contournée par le pooler.
- Validation : `safeParse`, jamais `parse`, jamais de `as` sur une entrée externe.
- Pas de tiret cadratin dans le code, les commentaires ni la doc.
- Réutiliser `lienWaMe(displayPhoneNumber, texte)` de `src/lib/wa-me.ts`, ne jamais refabriquer un lien `wa.me`.

---

## Lot 1 : la table et son store

**Fichiers :** une migration `db/migrations/0200_widgets.sql` (0199 pris le 2026-10-02 pendant la rédaction du plan), `src/widgets/store.pg.ts`,
`tests/integration/widgets-store.integration.test.ts`. ⚠️ Ce plan disait `tests/widgets-store.test.ts` : sous ce
chemin le test n'aurait tourné NULLE PART, `vitest.config.ts` excluant `tests/integration/**` et
`vitest.integration.config.ts` ne prenant que ce dossier.

**Interfaces :** `PgWidgetStore` expose `creer`, `parCode(code)`, `lister(tenantId)`, `modifier`, `supprimer`,
`phrasesDesWidgets(tenantId)`. Le lot ne crée QUE des fichiers neufs, délibérément : aucun risque de collision avec
les autres sessions qui partagent l'arbre.
`parCode` est le seul accès SANS `tenant_id` : il en RETOURNE un, puisque le code opaque est l'autorité, comme
`getByCode` des liens tracés.

**Ce que la migration porte :** `code` unique global, `phrase` unique PAR ESPACE (index, pas contrôle en code),
`devenir` nullable borné à `agent`/`mba`/`scenario`, `agent_id` et `workflow_id` en `on delete set null`, les deux
CHECK à SENS UNIQUE (`agent_id is null or devenir = 'agent'`), l'apparence bornée, `badge`, `actif`,
`max_par_heure`.

**Tests attendus :** le CHECK refuse un `agent_id` sans `devenir = 'agent'` ; il ACCEPTE `devenir = 'agent'` avec
`agent_id` à null (état atteignable, agent supprimé) ; deux widgets d'un même espace ne peuvent pas partager une
phrase ; deux espaces le peuvent ; supprimer un scénario met `workflow_id` à null sans détruire le widget.

✅ **Livré le 2026-10-02**, relu sans rouge. 🔴 **Ses CHECK à sens unique s'écrivent avec `coalesce`, PAS comme dans
0144**, et c'est la leçon du lot : un CHECK qui vaut `NULL` est SATISFAIT, donc `agent_id is null or devenir =
'agent'` laisse passer `devenir` à null avec un `agent_id` renseigné. Ici `null` a un sens (le réglage de l'espace),
d'où `coalesce(devenir = 'agent', false)`. Le trou de 0144 n'existe plus en production, 0145 ayant retiré la colonne
(mesuré en base le 2026-10-02) : ne pas recopier 0144 tel quel.

---

## Lot 2 : la route publique et le script

**Fichiers :** `src/http/widget-public.ts`, le montage dans `src/server.ts` (registre `modulesDeRoutes`, classe
`code-url`), `src/widgets/script.ts` (fabrique le JavaScript), `tests/widget-script.test.ts`.

**Interfaces :** `GET /widget/:code.js` rend `application/javascript`, `Cache-Control: max-age=60`.
`construireScript(config)` est un module PUR : il reçoit ce qui est déjà résolu et rend une chaîne.

**Ce que le script contient :** le numéro, la phrase, l'apparence, le badge, et l'état `servi` ou `grise`. Rien
d'autre.

🔴 **LE SCRIPT SE CONSTRUIT DEPUIS UNE LISTE EXPLICITE DE CHAMPS, JAMAIS PAR UN SPREAD DE `WidgetRow`.** `parCode`
rend la ligne ENTIÈRE (`tenantId`, `agentId`, `workflowId`, `maxParHeure`) : un spread les publierait dans un
JavaScript que n'importe qui lit. Le test « aucun secret » part donc d'un `WidgetRow` COMPLET et vérifie que ces
champs n'apparaissent pas, sinon il ne prouve rien.

🔴 **AVATAR, LIBELLÉ ET PHRASE SE POSENT PAR LES PROPRIÉTÉS DU DOM, JAMAIS CONCATÉNÉS DANS DU HTML OU DU CSS.** Le
CHECK `^https://` sur `avatar_url` ferme `javascript:` et `data:`, mais laisse passer guillemets, chevrons et
parenthèses (`https://x" onerror=...`, ou `https://x)` dans un `url()`). Donc `img.src = valeur` sérialisée en JSON,
`textContent` pour les textes : la page qui reçoit le script est celle du CLIENT.

**Tests attendus :** 🔴 le script ne contient AUCUN secret ni identifiant d'espace, vérifié en cherchant
`tenant_id` et les noms des variables sensibles dans la sortie ; un code inconnu rend un script inerte et JAMAIS
une 5xx (Cloudflare remplacerait le corps) ; le lien `wa.me` est bien formé à partir d'un numéro tel que Meta
l'affiche, espaces et `+` compris ; un widget `actif = false` rend un script qui n'affiche rien ; la phrase est
encodée, donc non tronquée au premier espace.

✍️ **Écrit le 2026-10-02, en attente de relecture.** Ce qui a été livré, et ce qui a bougé par rapport à ce plan :

- **Fichiers** : ceux annoncés, plus `src/widgets/qr.ts` (le QR, généré CÔTÉ SERVEUR : spec section 5),
  l'entrée `widgetPublic` dans `src/server.ts` et son câblage dans `src/index.ts` (fichier de câblage PARTAGÉ :
  commit par patch sur `origin`), la dépendance `qrcode` (et `@types/qrcode` en développement) aux versions de
  `web/`, et `scripts/auto-attaque.mts`.
- **La route** rend `public, max-age=60` ; un repli (lecture en panne, budget épuisé) rend `no-store`. Code inconnu,
  mal formé ou vide, widget éteint, panne : 200 et `SCRIPT_INERTE`, le même dans tous les cas, jamais une erreur.
  Le frein des codes jamais vus (`CODES_INCONNUS_PAR_MINUTE`) est celui de `/w/:code`, à une différence près :
  épuisé, il rend le script inerte et non un 429. Un widget ÉTEINT garde son laissez-passer : sa balise, encore
  posée sur un site fréquenté, aurait sinon entamé le budget de tous les autres.
- **`construireScript` reçoit le lien, pas le numéro et la phrase** : la route appelle `lienWaMe` une seule fois,
  et l'état comme le QR en dérivent. Sa configuration est une union : la bulle grisée ne reçoit que sa position,
  donc ne publie ni lien, ni phrase, ni libellé.
- **Grisée seulement sans numéro, sur un numéro délié, ou sur un numéro sans chiffre**, jamais sur `BLOCKED`
  (spec section 6, avec la mesure).
- **L'auto-attaque** déclare la fausse autorité du module et sa seule exception au 404 de la sonde 11
  (`CODE_INCONNU_SAUF`) : 200 et le script inerte, comparé octet pour octet. Vérifié dans les deux sens.
- **Les tests** exécutent le script contre un faux DOM : le libellé hostile arrive dans `textContent`, l'avatar
  dans `img.src`, l'ombre est FERMÉE, la bulle grisée n'a aucun gestionnaire de clic. Le test « aucun secret »,
  BLOCKED, `innerHTML`, l'échappement de `<` et le laissez-passer du widget éteint ont été vérifiés par mutation.
- **Pas fait** : un plafond par code (voir la question ouverte de la spec sur la charge d'un site fréquenté), et
  aucun essai dans un vrai navigateur ni sur un vrai téléphone : c'est l'essai qui clôt la feature.

---

## Lot 3 : la source et le devenir à l'arrivée

**Fichiers :** `src/widgets/reconnaissance.ts`, le branchement dans le chemin d'entrée des messages,
`tests/widget-devenir.test.ts`.

**Interfaces :** `widgetDuMessage(tenantId, texte)` rend le widget dont la phrase est contenue dans le texte, ou
null. Elle se pose à l'ARRIVÉE, une seule fois, avant que le fil ne décide.

**Ce que le lot décide :** la source du contact est marquée ; le `devenir` du widget s'applique à cette
conversation ; `devenir = null` laisse le réglage de l'espace gouverner.

**Tests attendus :** un message sans phrase connue ne change rien au comportement d'aujourd'hui (garde de
non-régression, à vérifier dans les DEUX SENS) ; `devenir = 'agent'` avec un `agent_id` supprimé retombe sur le
réglage de l'espace au lieu d'échouer ; la décision ne se repose PAS aux messages suivants de la même
conversation ; un message de masse n'émet rien (le chemin de masse n'émet jamais, invariant du dépôt).

**Les décisions de Julien (2026-10-02), appliquées telles quelles :**

1. `scenario` : **démarrage DIRECT dans le chemin de réception, PAS d'automation compagnon.** Par le runner des
   automations et toutes ses gardes, sans les recopier.
2. `agent` : impossible aujourd'hui (une session d'agent IA exige un parcours de scénario). **Grisé « à venir » à
   l'écran au lot 4** ; au lot 3, il se comporte EXACTEMENT comme `null`, sans erreur.
3. `mba` : ne rien prendre, comme `assignerReponse` pour `mba` : l'agent de Meta répond s'il est actif.
4. `null` : rien, le réglage de l'espace gouverne.
5. **La source est une ÉTIQUETTE** posée sur le contact à l'arrivée, pour TOUS les devenirs, dès que le message
   contient la phrase d'un widget actif. Sans doublon, et stable si le widget est renommé.
6. L'émission d'un événement d'automation se décide par le chemin appelant (règle du dépôt), explicitement.

✍️ **Écrit le 2026-10-02, en attente de relecture.** Ce qui a été livré, et ce qui a bougé par rapport à ce plan :

- **Fichiers** : `src/widgets/reconnaissance.ts` (`widgetDuMessage`), `src/widgets/arrivee.ts` (l'étape et son
  assemblage de production), `src/widgets/tirs.pg.ts`, la migration **0201** (`widget_tirs`), l'étape dans
  `processInbound` (`src/webhooks/inbound.ts`), sa propagation dans `handleWebhookJob` (`src/webhooks/handler.ts`), la
  purge RGPD (`PgContactStore.purgeMany`), le câblage dans le job `webhook` de `src/worker.ts` (un import et une
  entrée, à côté d'`inboundAssignation`), `tests/widget-devenir.test.ts`, et en intégration
  `tests/integration/widget-tirs.integration.test.ts` plus deux ajouts à `purge-rgpd.integration.test.ts`.
- 🔴 **0201 était INÉVITABLE, et c'est la conséquence de la décision 1.** Les gardes du runner (anti-rebond par
  contact, plafond horaire, annulation du tir quand rien ne part) lisent et écrivent des tirs par (identifiant,
  contact) ; `automation_fires.automation_id` référence `automations(id)`, et l'identifiant d'un widget y viole la
  clé étrangère. Sans automation compagnon, il fallait une table de tirs à soi, de la forme d'`automation_fires`,
  plus `tenant_id`. Elle porte un numéro : elle **entre dans la purge RGPD**, ce qui la rend **BLOQUANTE** (le code
  qui la nomme dans la transaction de purge, déployé avant elle, ferait échouer toute suppression de contact en
  `42P01`). Elle passe AVANT le `up`, avec 0200.
- **Le démarrage** : l'automation équivalente au widget est construite EN MÉMOIRE (`automationDuWidget` : mot-clé =
  la phrase en `contains`, son scénario, `maxFiresPerHour` = `max_par_heure`, `null` = le plafond de l'instance,
  anti-rebond de l'instance, `possedePar: POSSESSEUR_WIDGET` depuis le lot 3b) et passée à `runAutomations` avec l'objet MÊME des automations du
  worker (`automationRunnerDeps`), dont seule la source change : cette automation-là, et ses tirs dans `widget_tirs`.
  Contact bloqué, anti-rebond, plafond, garde du fil, garde du désabonnement : ce sont les leurs. Le runner revérifie
  la phrase par `matchesTrigger` : une reconnaissance fautive ne suffit pas à démarrer un scénario (mesuré par
  mutation, voir les tests).
- **Le message qui démarre le scénario d'un widget est CONSOMMÉ**, comme celui qui démarre une automation : le job le
  capte par une enveloppe autour de l'étape (comme il capte déjà le signal « nouveau contact » autour de l'upsert,
  sans toucher au type de retour de `processInbound`), et ne le donne ni aux automations (une automation « nouveau
  contact » démarrerait un second scénario par-dessus), ni à l'avance d'un parcours (qui prendrait la phrase pour la
  réponse à la première question du scénario neuf), ni à l'agent de Meta. Un message refusé (anti-rebond, plafond,
  fil tenu, désabonné) n'est PAS consommé : il suit le chemin d'aujourd'hui.
- **L'ordre** : l'étape est la DERNIÈRE de `processInbound`, après l'affectation de campagne. Chaque étape existante
  voit l'état qu'elle voyait avant ce lot, et la propriété clé de l'affectation (seule la PREMIÈRE réponse prend le
  fil) se lit sur un état que le widget n'a pas touché. Si la campagne vient de prendre le fil pour l'équipe, le
  scénario du widget ne le lui prend pas (`epargneLOperateur`, lot 3b) : la décision déjà prise gagne. Chaque geste est dans un `tenter` : un
  widget en échec n'empêche ni l'enregistrement, ni l'affectation, ni le message suivant du lot.
- **Texte seulement** : `wa.me` pré-remplit toujours un message texte ; une légende de média ou un libellé de bouton
  ne sont pas une arrivée par la bulle (même règle que le STOP). Un `standby` (le contact est sur la liste de l'agent
  de Meta) démarre le scénario depuis le lot 3b, la reprise retirant d'abord le contact de la liste de l'agent.
- **L'étiquette est `widget-<code>`**, dérivée du code public, IMMUABLE : un widget renommé (nom ou phrase) pose la
  même. Aucune colonne n'a donc été ajoutée pour elle. Posée par `addTagsByPhoneReturningNew` (dédoublonné en base)
  puis déclarée dans le référentiel, best-effort, comme `applyTag`.
- 🔴 **L'émission, décidée par le chemin appelant** : l'étiquette n'émet RIEN. Le chemin de réception décide ICI qui
  prend la conversation ; une publication « tag ajouté » laisserait une automation démarrer un second scénario sur la
  même arrivée, par la file, hors de l'anti-rebond du widget, soit deux règles sur un message (spec section 3). Le
  scénario démarré, lui, est un démarrage UNITAIRE : il passe par le `startWorkflow` des automations, donc ses
  propres blocs « tag » publient comme ceux de tout scénario déclenché par un message. Gardé par test (les modules du
  widget ne publient rien ; le démarrage passe par le `startWorkflow` du runner ; le worker passe
  `automationRunnerDeps`).
- **« La décision ne se repose pas »** : elle se repose à chaque message qui CONTIENT la phrase, ce qui est rare
  après le premier ; l'étiquette est idempotente, et le scénario ne redémarre pas dans l'anti-rebond (décision de
  Julien). Au-delà, il redémarre, comme un mot-clé.
- **Tests** : la non-régression compare le même lot (texte, média, bouton, STOP, réouverture) traité avec et sans le
  widget, jusqu'à ce que le job donne aux automations, à l'avance et à l'agent de Meta. Vérifiée dans les DEUX SENS
  par mutation : la reconnaissance qui agit sans phrase (l'étiquette se pose, le test rougit sur ce symptôme ; le
  scénario, lui, ne part pas, le runner revérifiant la phrase) ; l'enveloppe du job qui consomme sans démarrage
  (automations, avance et agent de Meta privés du message) ; la même qui ne consomme jamais (une automation reçoit le
  message qui vient de démarrer le scénario du widget) ; la garde de la phrase vide retirée (le widget capte tout).
  Cette dernière était VERTE au premier essai : un départ à 0 de la comparaison des longueurs écartait aussi la
  phrase vide, par accident ; la sélection a été réécrite pour que la garde soit seule à l'écarter. Le scénario
  passe par le VRAI runner et le VRAI exécuteur : démarrage, anti-rebond des deux côtés de sa fenêtre, plafond
  propre et plafond de l'instance, désabonné, bloqué, fil tenu, `standby`.
- **La reprise du fil**, laissée ouverte ici, est le lot 3b. Aucun essai réel : c'est l'essai qui clôt la
  feature.

---

## Lot 3b : le scénario du widget passe devant l'agent de Meta

**Décidé par Julien le 2026-10-02, poussé le même soir.** Avec le lot 3 seul, sur tout espace où l'agent de Meta tient le fil,
le devenir `scenario` ne démarre jamais : le scénario respecte la garde du fil, et le widget ne fait que poser son
étiquette. Le lot 3b donne au widget le comportement des liens de chaîne et des publicités : il REPREND la main à l'agent
de Meta. ⚠️ Il n'a AUCUN rapport fonctionnel avec les chaînes : il ajoute seulement un troisième nom à la liste de ceux
qui ont le droit de passer devant l'agent de Meta.

**Exception, comme la publicité** : un HUMAIN de l'équipe déjà en train de répondre garde la conversation
(`epargneLOperateur`). C'est le visiteur qui déclenche en cliquant, comme sur une publicité ; le lien de chaîne, lui,
écrase l'opérateur comme une campagne.

**Fichiers :** `src/automation/match.ts` (une constante `POSSESSEUR_WIDGET`, nommée dans `reprendLaMain` ET dans
`epargneLOperateur`), `src/widgets/arrivee.ts` (l'automation en mémoire porte ce `possedePar`, et le `standby` ne bloque
plus le widget, traité comme la publicité le traite), `tests/automation-chaine-reprend-la-main.test.ts` (le widget y est
nommé), `tests/widget-devenir.test.ts`.

**Aucune migration** : l'automation du widget n'existe qu'en mémoire, jamais en base, donc ni la colonne
`automations.possede_par` (un `text` sans contrainte) ni le filtre `HORS_WEBHOOK` de l'écran Automation ne la concernent. ⚠️ `match.ts` appartient
à la zone de la session Salesforce : feu vert donné le 2026-10-02 (rien de non poussé, aucun chantier prévu sur
`reprendLaMain`).

**Tests attendus :** l'agent de Meta tient le fil (standby) : le scénario du widget démarre et prend le fil ; un opérateur
tient le fil : le scénario ne démarre pas ; une automation ORDINAIRE garde exactement son comportement (`reprendLaMain`
faux), vérifié dans les deux sens.

## Ce qui reste (état du 2026-10-02 au soir)

- Lots 1 à 3b sur `main`, CI verte, et DÉPLOYÉS le 2026-10-02 au soir (VPS sur `97cdb65a`, `migrate` sans rien à
  appliquer, contrôle public à 200) ; migrations 0200 et 0201 appliquées en production et relues.
- Lot 4 : la moitié API poussée et déployée d'abord, la moitié console ensuite. Lot 5 (les quatre outils MCP, et
  les jaunes 1 et 2 du lot 4) écrit le 2026-10-02 au soir, en attente de relecture, en UNE moitié API. Reste
  l'essai réel.
- Jaunes de la relecture du lot 4 : (1) ✅ **replié au lot 5** : le comptage des messages reçus écarte les
  arrivées par un widget (la règle, et pourquoi elle écarte l'arrivée et non le contact : section du lot 5).
  (2) ✅ **replié au lot 5** : un widget ne choisit qu'un scénario publié, 409 sinon, par `etatDuScenario`,
  partagé avec Channels Me. (3) Ouvert : deux créations simultanées peuvent dépasser la limite de 5 d'un widget
  (pas de verrou).
- 🔴 **À trancher par Julien avant de donner une clé `mcp:write` à un client** (relecture du lot 5) : ce droit gagne le
  pouvoir de créer et modifier les widgets, donc de changer ce que la bulle affiche sur le site public. Mesuré en
  base le 2026-10-02 au soir : les 3 clés actives qui le portent sont toutes dans l'espace interne « Messaging Me
  Tech SANDBOX », aucun client n'était donc touché au déploiement. Les libellés de l'écran des clés et `features.md`
  le disent désormais. Option : un droit à part (`mcp:widgets`), pour qu'une clé confiée à un agent face aux clients
  ne puisse pas toucher au site.
- **Revue finale complète (lots 1 à 5), 2026-10-03 : aucun rouge.** Trois jaunes corrigés tout de suite, chacun avec
  son test vérifié dans les deux sens : une phrase (widget ou lien de chaîne) qui COMMENCE par un mot d'arrêt est
  refusée, sinon `estDemandeArret` désabonnait chaque visiteur avant l'étape du widget ; la purge RGPD efface
  `widget_tirs` par tous les numéros de la personne, fiche comprise, et plus seulement par ceux de ses fils (la
  rétention efface les fils et garde la fiche) ; la route publique garde le script rendu 30 s par code
  (`cacheCourt`), parce qu'un paramètre de requête contourne le cache du navigateur et du CDN. Ouverts, de la même
  revue : une phrase banale (« Bonjour ») passe sur un espace sans historique, une longueur minimale est à décider ;
  le scénario du widget démarre dans la boucle d'enregistrement des entrants (`processInbound`), un envoi lent
  retarde les messages suivants du lot ; une lecture des widgets par message texte entrant, sans cache ; le plafond
  horaire atteint ne laisse qu'une trace serveur ; `list_scenarios` lit les graphes avant de tronquer ;
  `workflow_runs` et `automation_fires` ont le même trou de purge que `widget_tirs`, antérieur au widget.
- Autres jaunes de la relecture du lot 5, ouverts : (a) un contact qui porte l'étiquette d'un widget SUPPRIMÉ voit
  TOUS ses messages qui contiennent la phrase examinée écartés du comptage, pas seulement son arrivée : sur un espace
  dont le trafic venait d'un widget supprimé, une phrase banale peut passer ; n'écarter que le premier message par
  contact (`row_number()`). (b) L'exclusion compare en SQL avec `strpos(lower(...))`, la reconnaissance avec
  `normalizeText` (accents, espaces) : une arrivée reconnue malgré un accent différent continue de compter, dans le
  sens prudent. (c) `type: ['string','null']` et `null` dans un `enum` sont une première dans le catalogue MCP :
  Claude Code les accepte, certains clients (ceux qui s'appuient sur Gemini) les rejettent et peuvent alors perdre
  TOUS les outils de la clé ; à vérifier sur les clients réellement branchés. (d) `list_widgets` signale un scénario
  supprimé mais pas un scénario non publié : un drapeau `scenarioNonPublie` dans la vue, partagé avec l'écran.
  (e) Le jaune 3 du lot 4 devient plus probable avec le MCP (deux `create_widget` en parallèle), et il couvre aussi
  deux phrases dont l'une contient l'autre ; un verrou d'avis par espace (`pg_advisory_xact_lock`) le fermerait.
  Replié tout de suite : `etatDuScenario` lit un graphe sans `nodes` comme `vide` au lieu de lever (500).
- Ouvert, relevé au lot 5 (jaune) : le formulaire du widget (`web/components/WidgetFormulaire.tsx`) propose tous les
  scénarios sans dire lesquels sont en ligne, alors que la console a la règle et son helper (`estEnLigne`,
  `web/lib/api/scenarios.ts` : « à afficher partout où l'on CHOISIT un scénario à déclencher »). L'API refuse
  désormais un scénario non publié avec sa raison ; l'écran pourrait le signaler avant l'envoi. Une moitié console.
- Bornes posées par le lot 4 en l'absence de CHECK de longueur dans 0200, à valider : nom 80, phrase 300 (comme un
  lien de chaîne), libellé 60, avatar 2 000 caractères en `https://`, plafond horaire de 1 à 100 000 ou `null`. Le
  badge n'est PAS modifiable par l'API : son retrait relève de l'offre Pro, qui n'existe pas encore.
- Tranché par Julien le 2026-10-02 pour le lot 4 : **5 widgets au plus par espace** ; un scénario supprimé rend son
  widget **inerte** (la base le fait déjà par `set null`, l'écran du widget le dit) ; l'API des lots 1 à 3b se
  déploie AVANT que l'écran ne soit poussé.
- Ouvert, relevé par la relecture du 3b (jaune) : un scénario refusé APRÈS la reprise (envoi Meta en échec) laisse le
  visiteur d'un `standby` sans réponse jusqu'à son message suivant, comme le bouton de chaîne ; la publicité, elle,
  rend le fil (`rendreLesFilsSansReponse`). Et un rejeu du webhook n'est pas consommé par le widget : l'avance d'un
  parcours peut le prendre pour une réponse (hérité du lot 3).

## Lot 4 : l'écran de la console

**Fichiers :** `web/app/widgets/`, les routes d'écriture côté API (`src/http/widgets.ts`, classe `tenant`), les
tests d'écran.

**Interfaces :** l'écran liste, crée, modifie, montre un APERÇU en direct et le code à copier. Les routes sont
celles que le MCP appellera : une seule vérité.

🔴 **LE CONTRÔLE DE LA PHRASE SE FAIT ICI, ET IL EST CROISÉ AVEC LES LIENS DE CHAÎNE.** Le produit l'a déjà résolu
pour Channels Me (`src/http/channels-me.ts`, câblé dans `src/index.ts`) : le conflit se juge par INCLUSION dans les
deux sens avec `normalizeText` (en mode `contains`, une phrase qui contient l'autre fait déclencher les deux), et une
phrase qui apparaît déjà dans des messages reçus est refusée (elle déclencherait sur des conversations
ordinaires). L'espace des phrases d'un espace est donc **widgets ∪ liens de chaîne**, dans les DEUX sens : créer un
widget regarde les liens, et créer un lien doit désormais regarder les widgets. Extraire la comparaison en fonction
pure partagée plutôt que la recopier. ⚠️ `src/index.ts` est un fichier de CÂBLAGE PARTAGÉ : annonce aux autres
sessions avant de l'éditer, commit par patch sur `origin`.

🔴 **L'AGENT ET LE SCÉNARIO DÉSIGNÉS DOIVENT APPARTENIR AU MÊME ESPACE, et seule la route le garantit.** Les clés
étrangères de 0200 vérifient qu'ils EXISTENT, pas à qui ils sont : sans contrôle, un widget de l'espace A
désignerait l'agent IA de l'espace B, qui prendrait les conversations de A. C'est une fuite entre espaces. Contrôle
obligatoire dans la route, avec un test d'intégration, comme pour `campaign_etages`. (Autre voie possible : une clé
composite `(tenant_id, agent_id)` avec `on delete set null (agent_id)`, PG15.)

**Les autres contrôles que la base ne fait pas :** borner en Zod les longueurs de `nom`, `phrase`, `libelle` ; traduire
le `23505` sur `widgets_phrase_key` en 409 ; refuser une phrase que `normalizeText` réduit à rien (le CHECK `'\S'` ne
voit que le cas flagrant) ; à la MODIFICATION d'une phrase, exclure le widget lui-même de la comparaison (passer par
`lister`, qui porte les identifiants, et non par `phrasesDesWidgets`).

⚠️ **Une décision à prendre avant ce lot.** Supprimer un scénario utilisé rend aujourd'hui le widget silencieusement
inerte (`set null`) : la route de suppression des scénarios ne compte pas les widgets parmi ses usages. (La question
« `automation_id` ou dériver » est tranchée par le lot 3 : il n'y a PAS d'automation compagnon, le scénario démarre
directement dans le chemin de réception.)

**Le devenir `agent` est grisé « à venir »** à l'écran (décision de Julien du 2026-10-02) : une session d'agent IA
exige un parcours de scénario, et le lot 3 le traite comme `null`.

**Tests attendus :** un widget qui désigne l'agent d'un autre espace est refusé ; une phrase qui CONTIENT celle d'un lien de chaîne est refusée, et l'inverse ; une phrase déjà
présente dans des messages reçus est refusée ; `tests/scope-tenant.test.ts` voit le nouveau module et exige sa garde ; une écriture est
réservée aux admins (RBAC). (Ce plan exigeait ici « le QR se génère dans le navigateur, donc aucune dépendance
ajoutée à l'API » : le lot 2 l'a tranché dans l'autre sens, QR généré côté serveur, spec section 5. L'aperçu de
l'écran peut reprendre `qrcode`, déjà dans `web/`.)

✍️ **Écrit le 2026-10-02, en attente de relecture.** Ce qui a été livré, et ce qui a bougé par rapport à ce plan :

- **Les décisions de Julien du 2026-10-02, appliquées telles quelles** : cinq widgets au plus (409 au sixième) ; un
  scénario supprimé rend son widget INERTE, la route de suppression des scénarios ne change pas, l'écran le dit sur
  le widget (`scenarioSupprime` dans la réponse) ; le devenir `agent` est grisé à l'écran ET refusé par l'API (400,
  « à venir »), sinon le MCP du lot 5 poserait un choix inerte. Devenirs acceptés : `null`, `mba`, `scenario`.
- **Les contrôles vivent dans `src/widgets/gestion.ts`, pas dans la route.** Le MCP n'appelle pas de route HTTP, il
  appelle des fonctions (`repondreDansLaFenetre` en est le modèle) : « les mêmes routes » veut donc dire les mêmes
  fonctions, `creerWidget`, `modifierWidget`, `supprimerWidget` et `vueDuWidget`. `src/http/widgets.ts` n'ajoute que
  la garde (`g.admin`, lecture comprise) et les statuts. L'assemblage de production (`gestionDesWidgetsEnBase`) est
  celui que le test d'intégration éprouve.
- **La comparaison des phrases est une fonction pure** (`src/widgets/phrases.ts`), appelée par la gestion des widgets
  ET par le `phraseEnConflit` des liens de chaîne (`conflitDansLEspace`, câblé dans `src/index.ts`, qui lit
  désormais `phrasesDesWidgets`). 🔴 **Elle retire la ponctuation FINALE des deux côtés**, ce que le plan ne
  prévoyait pas : le mot-clé d'un lien est sa phrase privée de sa ponctuation finale (`motCleDepuisPhrase`), donc un
  lien « Je veux le guide ! » déclenche sur le message d'un widget « Je veux le guide. », que deux phrases comparées
  entières ne voyaient pas en conflit. Effet de bord assumé sur les liens : « Promo! » et « Promo? », qui avaient le
  même mot-clé, sont désormais refusés comme deux phrases en conflit.
- **La modification est PARTIELLE** (`PATCH`, un champ absent garde sa valeur), et les gardes se calculent sur
  l'état EFFECTIF. Une phrase inchangée à la normalisation près ne repasse ni la comparaison ni le comptage (ses
  propres arrivées la contiennent) ; une phrase qui change se compare aux AUTRES widgets, jamais à elle-même. Un
  widget inerte reste modifiable (sa couleur, par exemple) : seul CHOISIR le devenir `scenario` exige un scénario.
- **Le scénario désigné est vérifié à chaque écriture qui en porte un** (`getById(id, tenant)`), en unitaire et en
  intégration (`tests/integration/widgets-gestion.integration.test.ts`, qui éprouve aussi la vraie lecture des
  phrases de liens et le nom de la contrainte `widgets_phrase_key`).
- **Le comptage des messages reçus** reprend `messagesContenantLaPhrase` des liens de chaîne, tel quel. (Au lot 5 :
  hors arrivées par un widget, jaune 1.)
- **`badge` n'est pas dans la saisie** : le retirer est un acte commercial (offre Pro) qui n'existe pas encore. Une
  modification garde la valeur en base.
- **L'adresse du script, la balise et le lien `wa.me`** sont fabriqués par `src/widgets/adresses.ts`, que la route
  publique du lot 2 lit aussi (`ROUTE_SCRIPT`, `lienDuWidget`) : un test charge l'adresse distribuée sur la route
  publique et obtient le script servi.
- **L'écran** : `web/app/widgets/page.tsx`, `web/components/WidgetFormulaire.tsx` et `WidgetApercu.tsx`, l'entrée
  « Widget WhatsApp » du menu (juste après Publicités), et `web/lib/widgets.ts`. Le QR est dessiné dans le navigateur
  par `qrcode`, déjà présent. Une modification n'envoie que l'écart (`ecartsDeSaisie`).
- 🔴 **Le découpage en deux poussées ne suit pas exactement « src d'un côté, web de l'autre ».** La moitié API porte
  aussi `web/lib/widgets.ts` (et son test), parce que `tests/web-widgets-parite.test.ts` le lit. La moitié console
  porte aussi `features.md`, la fiche d'aide `docs/aide/fiches/poser-une-bulle-whatsapp-sur-mon-site.md` et la carte
  émise `src/aide/carte-console.ts` : la nouvelle section de `features.md` exige sa fiche
  (`tests/aide-proposer.test.ts`), la fiche désigne l'écran `widgets`, qui n'existe dans la carte qu'avec l'entrée
  de menu, qui n'existe qu'avec la page. Ils partent donc ensemble, et le bot d'aide ne connaît l'écran qu'au
  déploiement de l'API qui suit la publication de la console.

---

## Lot 5 : les outils MCP (quatre), et deux jaunes du lot 4

**Fichiers :** `src/mcp/outils.ts`, `tests/mcp-widgets.test.ts`.

**Interfaces :** `create_widget`, `update_widget`, `list_widgets`, qui appellent les MÊMES routes que l'écran.

**Tests attendus :** les trois outils entrent dans le catalogue et portent le droit `mcp:write` pour les deux
premiers ; un outil appelé sur un espace qui n'est pas celui de la clé est refusé.

✍️ **Écrit le 2026-10-02, en attente de relecture.** Ce qui a été livré, et ce qui a bougé par rapport à ce plan :

- **Un quatrième outil, `list_scenarios`** (`mcp:read`, décision de la session du lot 5) : sans lui, `create_widget`
  avec le devenir `scenario` était inutilisable par un modèle, qui n'a aucun autre moyen de connaître l'identifiant
  d'un scénario. Il rend `id`, `nom` et `publie` (le graphe PUBLIÉ porte au moins un bloc, la lecture qui décide du
  refus), borné à 200 avec `tronque`, comme `list_members`. Lecture seule, sur `PgWorkflowStore.listResume`
  (`tenant_id = $1`), aucune requête neuve.
- **« Les mêmes routes » veut dire les mêmes FONCTIONS** (`src/widgets/gestion.ts`), comme au lot 4 : un `Refus`
  devient un `RefusOutil` avec sa phrase (`valeurOuRefus`), aucun contrôle n'est recopié. La mise en vue, qui vivait
  dans la route, est montée dans la gestion (`miseEnVue`, `listerEnVue`, `DepsWidgets`) : la route et l'outil lisent
  le numéro AVANT d'écrire, de la même façon. `src/index.ts` donne aux deux portes le MÊME objet
  (`widgetsDeLaConsole`), donc le même numéro et la même adresse de script ; un test lit le câblage.
- **Les champs gardent les NOMS de la route** (`workflowId`, `avatarUrl`, `maxParHeure`) : la saisie passe telle
  quelle à la gestion, qui est `.strict()`. Seul l'identifiant d'`update_widget` suit la convention des autres
  outils (`widget_id`), et il est retiré avant la saisie. Un `tenantId` glissé dans les arguments est donc une clé
  inconnue, refusée.
- 🔴 **Les schémas d'entrée annoncent chaque borne de la saisie, avec sa valeur** (longueurs, motif de la couleur,
  énumérations, `format: uuid`, l'intervalle du plafond horaire, `^https://` de l'avatar, `additionalProperties:
  false`), construits sur les constantes de la gestion et jamais sur des nombres recopiés ; `satisfies
  Record<ChampWidget, ...>` refuse à la compilation un champ de saisie non annoncé. Le test DÉRIVE les bornes des
  internes de Zod (`saisieDeCreation`, `saisieDeModification`, désormais exportés) et les compare valeur par
  valeur, avec un compte plancher et un échec sur toute forme de borne inconnue de l'extracteur. Le devenir `agent`
  n'est pas PROPOSÉ au modèle (la saisie l'accepte pour le refuser avec sa raison). La limite de cinq widgets et la
  balise à coller juste avant `</body>` sont dans la description de `create_widget`.
- **Pas d'outil de suppression** : le plan n'en prévoyait pas, et une balise posée ne doit pas disparaître sur un mot
  d'un modèle. Le test le dit.
- **Le catalogue de la console** (`web/lib/mcp-outils.ts`) porte les quatre outils ; la parité de
  `tests/mcp-doc-parite.test.ts` les vérifie. **`features.md`** : la section « Widget WhatsApp » (jaunes 1 et 2,
  l'accès par MCP) et la section « Serveur MCP » ; la fiche d'aide `poser-une-bulle-whatsapp-sur-mon-site.md`
  relue, complétée et son empreinte reposée.
- **Jaune 2 du lot 4, replié** : un widget ne CHOISIT qu'un scénario publié, 409 sinon (« publiez-le d'abord »). La
  lecture est celle des liens de chaîne, PARTAGÉE et non recopiée : `etatDuScenario` (`src/workflow/store.pg.ts`),
  que le câblage Channels Me de `src/index.ts` appelle aussi, et la dépendance de la gestion devient `scenarioEtat`.
  L'isolation (`inconnu`, 400) reste vérifiée à CHAQUE désignation, inchangée comprise ; la publication seulement
  quand la requête porte le devenir ou le scénario : un widget inerte, ou dont le scénario n'est plus publié, reste
  modifiable (sinon on ne pourrait même plus l'éteindre). Vaut pour la route et le MCP.
- **Jaune 1 du lot 4, replié** : la garde d'un widget compte les messages reçus HORS arrivées par un widget
  (`messagesContenantLaPhrase(..., { horsArriveesDeWidget: true })`, une condition neutralisée par un drapeau dans la
  MÊME requête que celle des liens, qui rend exactement ce qu'elle rendait). 🔴 **La règle écarte l'ARRIVÉE, pas le
  contact** : un message n'est écarté que si son contact porte l'étiquette d'un widget de l'espace ET contient la
  phrase ACTUELLE de ce widget. Écarter tous les messages des contacts étiquetés aveuglerait la garde sur un espace
  dont les visiteurs viennent surtout de ses bulles (un widget « Bonjour » y capterait tout). Un widget SUPPRIMÉ a
  perdu sa phrase : les messages de ses contacts qui contiennent la phrase examinée sont alors présumés être ses
  arrivées, la seule imprécision, écrite. L'étiquette se reconnaît à sa forme EXACTE (`MOTIF_ETIQUETTE_WIDGET`,
  confronté au générateur), pas à son préfixe : « widget-salon » posée à la main n'écarte rien.
- ⚠️ **Limite connue** : une phrase qui a servi AVANT d'être modifiée (« A » puis « A web ») n'est plus la phrase
  actuelle du widget ; revenir à un fragment de « A » recompterait ces anciennes arrivées. Rare, et refusé avec son
  nombre plutôt qu'accepté à tort.
- **Tests** : `tests/mcp-widgets.test.ts` (catalogue et droits, clé de lecture, refus lisibles, espace étranger, saisie
  partielle, bornes dérivées de Zod), `tests/widget-comptage.test.ts` (qui demande l'exclusion, forme de
  l'étiquette, filtres d'espace de la requête), jaune 2 dans `tests/http-widgets.test.ts`, et pour la CI
  `tests/integration/widgets-comptage.integration.test.ts` plus deux ajouts à
  `widgets-gestion.integration.test.ts` (ses scénarios sont désormais PUBLIÉS, un scénario sans version publiée,
  brouillon compris, est refusé). Vérifiés dans les DEUX SENS par mutation : borne retirée de l'annonce, borne
  ajoutée à Zod, droit de `create_widget` abaissé, saisie non stricte, refus traduit en panne, espace pris ailleurs
  que dans la clé, jaune 2 retiré puis appliqué sans l'exception du widget existant, exclusion non demandée, motif
  réduit au préfixe puis plus étroit que le générateur. Les tests d'intégration n'ont PAS tourné (aucune base
  locale) : la CI les joue.
- **Un seul envoi** : la seule modification de `web/` est `web/lib/mcp-outils.ts`, module pur lu par un test du
  serveur et affiché par l'écran Developers > Serveur MCP. Tout part en une moitié API. ⚠️ Vercel publie l'écran au
  push : il annonce les quatre outils avant le `up` de l'API, une fenêtre de documentation seulement (un appel rend
  « outil inconnu » jusqu'au déploiement). `src/index.ts` est un fichier de câblage PARTAGÉ : commit par patch.
- **Aucune migration.**

---

## Ordre de déploiement

1. **La migration AVANT le code**, puisqu'elle crée une table que le code écrit. Image construite, `migrate`,
   puis `up -d --build`. 🔴 **0201 l'est doublement** : la transaction de purge RGPD la nomme, et le code déployé
   avant elle ferait échouer toute suppression de contact (`42P01`). 0200 et 0201 passent ensemble, avant le `up`
   du lot 3, et se relisent en base juste après `migrate`.
2. **Lots 1 à 3 déployés avant le lot 4.** 🔴 Vercel publie la console à CHAQUE push, l'API attend son
   `up --build` : un écran poussé avant sa route appelle une route que la production n'a pas, et le client voit
   une page cassée pendant toute la fenêtre. C'est arrivé le 2026-09-21 avec l'onglet « Outils », en 404 pendant
   plus d'une heure. **Le lot 4 lui-même part en deux poussées** : la moitié API (routes, gestion, tests, et
   `web/lib/widgets.ts` qu'aucune page n'importe encore), déployée et contrôlée ; PUIS la moitié console (l'écran,
   le menu, `features.md`, la fiche d'aide et la carte émise). Le détail est dans la section du lot 4.
3. **`gh run list` lu AVANT le déploiement**, job par job sur `gh run view <id> --json jobs` : les tests
   d'intégration ne tournent qu'en CI, et `gh run watch --exit-status` a déjà rendu 0 sur un run en échec.
4. **Contrôle public après le `up --build`** : les deux portes depuis l'extérieur. Le 502 de NPM tenant une
   ancienne IP est revenu plusieurs fois, et `nginx -s reload` le corrige.

## Ce qui clôt la feature

🔴 **Aucun test vert ne la clôt.** La balise posée sur un vrai site, un message envoyé depuis un vrai téléphone,
la conversation qui arrive marquée de la bonne source, et le devenir du widget qui prend effectivement la main.
Puis le même essai avec le numéro délié, pour voir la bulle grisée.

## Questions à trancher avant le lot 1

- [ ] Le texte exact de la bulle grisée, et s'il est traduit.
- [x] Une limite au nombre de widgets par espace : 5 (Julien, 2026-10-02).
- [x] Supprimer un scénario utilisé par un widget : le widget devient inerte (Julien, 2026-10-02).
