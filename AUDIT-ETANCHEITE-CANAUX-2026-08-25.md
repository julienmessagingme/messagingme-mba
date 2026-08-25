# AUDIT : étanchéité des circuits de retour RCS et WhatsApp, 2026-08-25

> Demandé par Julien après l'incident de la fenêtre 24 h : « les 2 circuits de retour doivent être bien
> étanches ». Ce document existe pour que le travail d'audit ne soit pas à refaire : il porte les constats
> VÉRIFIÉS, ce qui est délibérément partagé entre canaux, et les corrections déjà appliquées.

## Le contexte, en trois phrases

Depuis la migration **0058**, le fil de conversation est **UNIQUE par contact** : les bulles RCS et WhatsApp
cohabitent, et c'est `conversation_messages.channel` (migration **0056**, défaut `whatsapp`) qui porte le
tuyau de CHAQUE bulle. Le fil unique est un **choix produit assumé**, pas un défaut.

Ce qui est fautif, c'est d'appliquer une règle **propre à Meta** (la fenêtre de service de 24 h, les branches
d'un parcours, la facturation) à un événement qui n'est **jamais passé par Meta**.

## L'incident d'origine, et ce qui a déjà été corrigé

Un contact tape une **suggestion RCS**. Le retour est enregistré (`channel='rcs'`, identifiant UUID smsmode,
payload `btn:0`). Le calcul de la fenêtre WhatsApp ne filtrait pas le canal : il comptait ce retour et
annonçait la fenêtre **ouverte** alors que le dernier retour WhatsApp datait de 50 h. Un opérateur qui écrit
du texte libre se fait refuser par Meta en **131047**.

| Commit | Ce qu'il corrige |
|---|---|
| `bf0408d` | `getConversationContext` et `getWindowOpenByWaIds` filtrent sur `channel = 'whatsapp'`. Les DEUX, jamais un seul. |
| `76756c3` | 🔴 **Régression introduite par le précédent** : un message rapide destiné au canal RCS était bloqué par une fenêtre devenue fermée pour toujours. Le pré-contrôle rejoue désormais la mutation ordonnée du canal que fait `apply` (un template réussi ramène le parcours sur WhatsApp). |

⚠️ **La leçon de `76756c3`** : le correctif évident (exempter le message rapide si le run est RCS) aurait
introduit un autre bug, parce que `apply` fait MUTER le canal en cours de lot. Toute correction dans cette
zone doit rejouer cette mutation, pas lire le canal une fois pour toutes.

## Ce qui reste ouvert : 6 rouges, 9 jaunes

Sévérité : **rouge** = produit un comportement faux chez un client ou un opérateur ; **jaune** = dégrade
ou trompe. Les constats marqués CONFIRMÉ ont passé une contre-vérification adversariale.

### Rouges

#### Reprise d'un parcours sur le canal RCS : le message rapide est bloque par la fenetre WhatsApp, qui est desormais fermee pour toujours

`src/workflow/executor.ts:496` · **CONFIRME**

**Ce qui se passe.** Scenario multicanal : bloc RCS (contact joignable) -> le contact tape une suggestion -> bloc Attente 1 h -> bloc Message rapide. Le run est persiste avec channel='rcs' (executor.ts:688-690), donc apply() enverrait ce message rapide EN RCS via envoyerQuickEnRcs (executor.ts:389-393). Mais resume() filtre AVANT apply, sur le seul kind de l'action : aBesoinFenetre(a) rend true pour sendQuickMessage QUEL QUE SOIT run.channel. Il appelle donc isWindowOpen, qui est cable sur getWindowOpenByWaIds (wiring.ts:307), c'est-a-dire la fonction que le correctif vient de restreindre a channel='whatsapp'. Contact purement RCS (jamais un entrant WhatsApp, ou plus vieux que 24 h) : fenetre = fermee A TOUT JAMAIS. Le message rapide n'est PAS envoye, le run est clos en status='inbox', la conversation est escaladee a un humain, et le log dit 'fenetre 24 h fermee a la reprise' sur une conversation qui n'a rien a voir avec WhatsApp. AVANT le correctif, le retour RCS du contact comptait comme un entrant : isWindowOpen rendait true et le message partait bien, en RCS. C'est donc un cas legitime que le correctif casse.

**Preuve.** executor.ts:496-507 : `const aBesoinFenetre = (a: WorkflowAction): boolean => a.kind === 'sendFlow' || a.kind === 'sendQuickMessage';` puis `if (actions.some((e) => aBesoinFenetre(e.action))) { const ouverte = this.deps.isWindowOpen ? await this.deps.isWindowOpen(tenantId, waId) : false; if (!ouverte) { fenetreFermee = true; aExecuter = actions.filter((e) => !aBesoinFenetre(e.action)); ...`, aucune lecture de `run.channel`, alors que la signature de resume le recoit (executor.ts:470) et le passe a walkResolved (executor.ts:491). Cablage : wiring.ts:307 `isWindowOpen: async (tenant, waId) => (await inboxStore.getWindowOpenByWaIds(tenant, [waId])).get(waId) === true`, et store.pg.ts:449 filtre maintenant `and m.channel = 'whatsapp'`. Contraste avec apply(), qui LUI est canal-conscient : executor.ts:391 `? (canal === 'rcs' ? await this.envoyerQuickEnRcs(...) : await this.deps.sendQuickMessage(...))`.

**Correctif proposé.** Rendre la garde canal-consciente, exactement comme apply() : passer le canal du run a la garde et n'exiger la fenetre que sur le canal WhatsApp. Concretement dans resume(), remplacer le test par quelque chose comme `const canalCourant = apresWalk; const aBesoinFenetre = (a) => a.kind === 'sendFlow' || (a.kind === 'sendQuickMessage' && canalCourant !== 'rcs');` (sendFlow reste WhatsApp par nature, cf. campaign-eligibility.ts:167-173, donc il garde la garde). Test de non-regression a verifier DANS LES DEUX SENS : run channel='rcs', isWindowOpen renvoyant false -> le message rapide DOIT partir par envoyerQuickEnRcs ; le meme test sur le code d'avant doit echouer.

**Réserve du contre-vérificateur.** Le constat tient, et le piège annoncé est évité : ce n'est pas le fil unique (0058) qui est mis en cause, c'est le fait qu'une règle purement META (fenêtre 24 h) soit appliquée à un envoi qui ne passe pas par Meta. La conséquence est réellement fausse pour l'opérateur : conversation escaladée à tort, run tué, et un log qui parle de WhatsApp sur un parcours RCS, donc un diagnostic à contresens le jour où ça arrive.

Deux nuances honnêtes, qui n'annulent pas le constat :

a) La portée est plus étroite que « le RCS est cassé ». Seule la branche « le contact a RÉPONDU en RCS puis bloc Attente » est une RÉGRESSION de bf0408d. La branche « bloc RCS bien remis, contact silencieux, puis Attente, puis message rapide » était DÉJÀ bloquée avant le correctif (aucun entrant du tout -> fenêtre fermée dans les deux versions). Le correctif n'a donc pas créé le défaut de conception, il l'a élargi. Cela renforce plutôt l'intérêt de la correction proposée : elle répare aussi un cas antérieur.

b) Le correctif proposé est proportionné (une ligne, aucune migration, aucune dépendance nouvelle, `sendFlow` correctement laissé sous garde puisqu'un WhatsApp Flow est WhatsApp par nature, cf. campaign-eligibility.ts:167-173), MAIS il est imprécis sur un cas de bord qu'il faut connaître. `apresWalk` est UN canal pour tout le lot, alors qu'apply() peut basculer en cours de lot : executor.ts:400 `if (!rate && (a.kind === 'sendTemplate' || a.kind === 'sendFlow')) canal = 'whatsapp';`. Un lot « template puis message rapide » avec `apresWalk === 'rcs'` verrait donc la garde sautée alors que le message rapide partira, lui, en WhatsApp. Dégradation acceptable (Meta refuse en 131047, le refus est capté par le chemin `refus !== null` d'executor.ts:524-533 qui clôt et escalade), mais le symptôme change : au lieu d'un refus propre avant envoi, on prend un aller-retour Meta. Si on veut être exact plutôt que seulement correct, la garde doit se calculer par action dans l'ORDRE du lot, avec le même automate de canal que apply(), ou, plus simple et plus sûr : ne garder la fenêtre que si `apresWalk !== 'rcs'` (le cas visé) et laisser apply() rester la seule autorité sur le canal réel.

c) Le test de non-régression demandé est bien faisable en unitaire (contrairement au test du correctif bf0408d, qui devait être en intégration parce que le filtre vivait dans le SQL) : `makeResume` accepte déjà des deps surchargées, il suffit de poser `run.channel = 'rcs'`, `isWindowOpen: async () => false`, une dep `rcs` factice, et d'attendre un envoi via `envoyerQuickEnRcs`. Sur le code d'aujourd'hui il doit échouer avec `calls === []` et un run en `inbox`, c'est exactement le symptôme à voir avant de corriger.

---

#### POST /v1/sends : cibler un bloc RCS ecarte tous les destinataires en out_of_window

`src/http/v1-sends.ts:165` · **CONFIRME**

**Ce qui se passe.** Un integrateur lit le code public d'un bloc dans Contenu > Blocs (les blocs `rcs_message` y sont listes AVEC leur code nod_, cf. node-list.ts:32 et node-codes.ts qui minte un code pour TOUT node) et appelle POST /v1/sends avec {target:{node:'nod_..._<bloc RCS>'}}. La route applique le filtre de fenetre des qu'il y a un startNodeId, sans jamais regarder le TYPE du bloc vise : le bloc RCS, qui n'a aucune fenetre a respecter, se voit imposer la fenetre de service WhatsApp. Chaque destinataire dont la fenetre WhatsApp est fermee est ecarte avec le motif `out_of_window`, qui est faux pour ce canal, et l'envoi RCS ne part jamais. Le correctif aggrave et fige ce cas : un contact qui n'a repondu qu'en RCS etait jusqu'ici vu 'en fenetre' pendant 24 h (donc l'envoi passait), il est desormais out_of_window en permanence. Meme mecanique qu'au constat precedent, autre porte d'entree.

**Preuve.** v1-sends.ts:164-175 : `let windowOpenById: Map<string, boolean> | undefined; if (startNodeId && deps.getWindowOpenByWaIds) { ... const byWaId = await deps.getWindowOpenByWaIds(tenantId, [...]); ... }` puis `const { eligible, skipped: optSkips } = buildApiRecipients(category, contacts, windowOpenById ? { windowOpenById } : undefined);`, la condition est `startNodeId`, jamais le type du node. sends-build.ts:28 : `if (opts?.windowOpenById && !opts.windowOpenById.get(c.id)) { skipped.push({ phone: to, reason: 'out_of_window' }); continue; }`. Le resolveur n'exclut aucun type : ids/resolve.ts:52 `const node = w.graph.nodes.find((n) => n.data.code === code);`. Et le runtime, lui, enverrait tres bien : startFromNode pose `allowSessionOpen: true` (executor.ts:751).

**Correctif proposé.** Faire remonter le type du bloc par resolveNode (il a deja le graphe : ids/resolve.ts:48 rend `graph`) et ne construire `windowOpenById` que si le bloc vise est un bloc de session WhatsApp (`quick_message` / `flow`). Un bloc `rcs_message` (et un bloc `template`) n'est soumis a aucune fenetre. A defaut, refuser explicitement la cible node sur un bloc RCS en 422 avec la raison, plutot que de rendre un rapport `out_of_window` mensonger.

**Réserve du contre-vérificateur.** CONFIRME, avec deux nuances et une correction de périmètre sur le correctif.

Nuance 1, sur le mot « mensonger ». Le rapport n'est pas un mensonge au regard du contrat publié : web/app/developers/api/page.tsx:150-153 annonce le node comme « Réservé à la fenêtre de 24 h ». L'API fait donc ce que sa doc dit. Ce qui est faux, c'est la RÈGLE elle-même, écrite quand WhatsApp était le seul canal et jamais rouverte à l'arrivée du RCS. Le motif `out_of_window` sur un bloc qui n'a pas de fenêtre reste trompeur pour l'intégrateur, mais le défaut à corriger est la règle, pas seulement l'étiquette.

Nuance 2, sur « le correctif aggrave ». Factuellement exact (avant bf0408d une réponse RCS ouvrait la fenêtre tous canaux, donc l'envoi passait), mais l'ancien comportement passait pour une raison FAUSSE. bf0408d n'a pas créé le défaut, il a retiré le bug qui le masquait. À écrire comme ça, sinon on donne envie de reculer sur un correctif juste.

Sur le correctif proposé : proportionné dans son principe, mais sous-dimensionné sur trois points.
- Périmètre trop étroit. Le constat isole RCS, alors que la même cécité au type touche `template` (envoyable hors fenêtre par définition) et `email` (aucun rapport avec WhatsApp). Ne traiter que RCS, c'est reprogrammer la même session dans un mois. La bonne formulation est l'inverse de celle proposée : ce sont les blocs de SESSION WhatsApp (`quick_message`, `flow`) qui exigent la fenêtre, tout le reste ne la voit pas. C'est bien ce que dit le correctif, il faut juste assumer qu'il corrige aussi template et email, pas seulement RCS.
- Ne pas inventer une liste de types en dur dans v1-sends.ts. `scanOpening` (src/workflow/engine.ts:86) porte déjà exactement ce jugement « par quoi ce parcours ouvre-t-il », et campaigns.ts s'en sert. Réutiliser ce concept (appliqué au bloc de départ au lieu de l'entrée du graphe) évite une troisième source de vérité sur la même règle. Faire remonter le type par resolveNode est en revanche la bonne mécanique : resolve.ts:53 rend déjà `graph`, et index.ts:905 cherche déjà le node pour son label, l'ajout de `type` est d'une ligne.
- Le correctif est incomplet tant qu'il ne rouvre pas `createMissing`. v1-sends.ts:123 force `createMissing = false` sur toute cible node, et son commentaire (120-122) le justifie EXCLUSIVEMENT par « il serait créé puis immédiatement écarté out_of_window ». Cette justification tombe pour un bloc RCS ou template : le destinataire est joignable sans avoir jamais écrit. Laisser `createMissing` forcé à false, c'est remplacer un rapport 100 % `out_of_window` par un rapport 100 % `unknown_contact` sur une cible RCS envoyée à des prospects. Même trou, autre étiquette.

Un point à surveiller, non bloquant : relâcher la fenêtre sur un bloc RCS laisse le parcours continuer. Si la branche « non joignable » retombe sur un `quick_message`, celui-ci partira en WhatsApp (le canal ne bascule que si le RCS est vraiment parti, executor.ts:602-606) chez un contact hors fenêtre, donc refus Meta 131047. Ce n'est pas une régression du correctif (le montage existe déjà par la console), mais il faut le dire dans le commit plutôt que le découvrir en production.

Le repli proposé (422 explicite sur un bloc RCS) est honnête mais je le déconseille comme cible : il ferme définitivement l'envoi RCS par API alors que la console sait déjà le faire. À garder seulement si le lot doit être coupé en deux.

---

#### Un retour RCS fait avancer un parcours qui attend une réponse WhatsApp (et l'inverse) : `advance` ne reçoit aucun canal

`src/index.ts:801` · **CONFIRME**

**Ce qui se passe.** Un contact a un parcours en attente sur un bloc TEMPLATE WhatsApp à deux boutons [Oui / Non]. En parallèle une campagne RCS DIRECTE lui envoie une carte avec les suggestions [Voir l'offre / Stop] (une campagne RCS directe ne touche pas `control_owner`, donc `mayAct` reste vrai et le run reste `waiting`). Il tape « Voir l'offre » : smsmode renvoie postbackData `btn:0`, `onMo` appelle `advance(tenant, mo.from, mo.messageId, 'btn:0')`, le run est retrouvé PAR CONTACT et le handle `btn:0` est appliqué tel quel au bloc template WhatsApp. Le scénario part dans la branche « Oui » d'une question à laquelle le contact n'a jamais répondu, et envoie la suite. Symétrique : un run en attente sur un bloc `rcs_message` que le contact fait avancer en tapant un vieux bouton WhatsApp (handle `btn:1` appliqué au bloc RCS), ou en écrivant sur WhatsApp (handle forcé à `sent`, donc le parcours prend la sortie « envoyé » du bloc RCS).

**Preuve.** src/index.ts:801 `await workflowRuntime.executor.advance(tenant, mo.from, mo.messageId, mo.postbackData);`, aucun canal transmis. Côté WhatsApp le même appel se fait en src/webhooks/workflow-advance.ts:29 `deps.advance(tenantId, m.waId, m.messageId, m.buttonPayload)`. Dans src/workflow/executor.ts:816-856, `advance` n'a pas de paramètre de canal : ligne 817 `findWaitingByWaId(tenantId, waId)` cherche le run PAR CONTACT, et ligne 849 `const handle = courant?.type === 'rcs_message' ? (buttonPayload ?? 'sent') : buttonPayload;` applique le payload sans jamais vérifier d'où il vient. Le danger est déjà connu des auteurs mais n'a été fermé QUE pour les accusés de livraison : executor.ts:758-762 « `advance` retombe sur la première arête libre quand aucun handle ne correspond. Sur un run qui attend AUTRE CHOSE qu'un bloc RCS (un template, par exemple), passer « unreachable » ferait donc avancer le parcours d'un cran sur un accusé qui ne le concerne pas », d'où la garde `blocRcsEnAttente` (executor.ts:797-803) utilisée par `rcsUndeliverable`/`rcsDelivered`, et par rien d'autre. La clé qui manquerait est DÉJÀ lue puis jetée : src/rcs/callback.ts:218 `originMessageId: e.data.originMessageId ?? null` est parsé dans `RcsMo` et n'est utilisé nulle part.

**Correctif proposé.** Passer le canal du retour à `advance` depuis les DEUX portes d'entrée (index.ts:801 -> 'rcs', workflow-advance.ts:29 -> 'whatsapp'), et dans executor.ts refuser le routage par bouton quand le canal du retour ne correspond pas au bloc en attente : `run.channel` (colonne posée par 0082, déjà lue lignes 491/866) et `courant.type === 'rcs_message'` donnent le canal attendu. Plus sûr encore pour le RCS : utiliser `mo.originMessageId` (déjà parsé, callback.ts:218) et n'avancer que s'il désigne le message que le bloc en attente a envoyé.

**Réserve du contre-vérificateur.** Ce n'est pas le fil unique inter-canaux (choix produit de 0058) qui est en cause : l'inbox a raison de tout afficher au même endroit. Ce qui est faux, c'est le ROUTAGE : un tap dans le fil RCS choisit une branche d'une question posée sur WhatsApp. Conséquence concrète pour l'opérateur : le contact est tagué et relancé comme s'il avait répondu « Oui » à une question qu'il n'a jamais vue, et l'analytics `reply_button` (executor.ts:826-832) enregistre cette réponse imaginaire sur le bloc template. Pour le client : il reçoit la suite d'un parcours auquel il n'a pas consenti. Sévérité réelle, en production depuis que le RCS est LIVE.

Sur la proportion du correctif, je le coupe en deux.

MOITIÉ 1 (à faire, proportionnée) : passer le canal du retour aux deux portes d'entrée et refuser dans `advance` quand il ne correspond pas au canal attendu. Le canal attendu se calcule sans nouvelle colonne ni migration : `courant.type === 'rcs_message'` -> 'rcs', sinon `run.channel` (déjà lu executor.ts:849). Attention à ne PAS écrire « bloc non-RCS = whatsapp » : c'est exactement ce que 0082 est venu casser, un « message rapide » derrière un bloc RCS est envoyé EN RCS et attend donc une réponse RCS. Deux points à trancher explicitement, sinon on remplace un bug par un autre :
- refuser doit vouloir dire « ne rien faire » (le run reste `waiting`, le message reste visible dans l'inbox), pas « clore le run » : clore ferait du retour sur le mauvais canal un tueur de parcours, ce qu'on cherche justement à empêcher ;
- il faut aussi ne PAS mesurer (`this.mesurer`, executor.ts:826) un clic qui ne concerne pas le bloc, sinon l'analytics reste faux même après le fix.
Coût : un paramètre, deux appelants, une garde de trois lignes, plus deux tests (RCS sur run WhatsApp, texte WhatsApp sur bloc RCS) à vérifier dans les DEUX SENS.

MOITIÉ 2 (à ne pas faire maintenant) : l'appariement sur `originMessageId`. Plus précis en théorie, mais il exige de mémoriser l'identifiant du message RCS émis par le bloc (nouvelle colonne ou nouvelle table = migration), et le champ est `z.string().optional()` (callback.ts:92) : en faire une condition d'avancement casserait tout clic dès que smsmode l'omet, sur un fournisseur qu'on maîtrise mal et qui rejoue jusqu'à six fois. Le rapport risque/gain n'est pas là. La garde de canal ferme déjà 100 % des croisements décrits.

---

#### Le funnel de campagne compte une réponse de l'AUTRE canal comme une réponse à la campagne

`src/stats/store.pg.ts:108` · non contre-vérifié

**Ce qui se passe.** Une campagne WhatsApp part à 10 h sur 500 contacts. Un contact ignore le template, mais tape à 11 h une suggestion d'un message RCS reçu par ailleurs. `entrantAttribue` ne voit qu'un `direction = 'in'` postérieur à `sent_at` sur le même numéro : il le compte dans `replied`. Pire, `onMo` enregistre une suggestion RCS avec `type: 'button'` (src/index.ts:791), donc ce retour RCS entre AUSSI dans `buttonReplies`, présenté à l'écran comme « a tapé un bouton du template ». L'opérateur lit un taux de réponse et un taux de clic de son template WhatsApp qui viennent d'un autre tuyau, et reconduit une campagne sur cette base. Le sens inverse est identique : une campagne RCS (`campaigns.channel = 'rcs'`, store.pg.ts:188) compte comme « a répondu » un simple message WhatsApp.

**Preuve.** src/stats/store.pg.ts:103-118, le fragment `entrantAttribue` : `and m.direction = 'in' and m.created_at > r.sent_at`, aucune contrainte sur `m.channel`, alors que `campaigns` porte bien un canal (`src/campaign/store.pg.ts:188` et 216 : `channel: r.channel ?? 'whatsapp'`) et que les DEUX canaux alimentent la même table `campaign_recipients` (src/campaign/run-job.ts:74 `const isRcs = campaign.channel === 'rcs';`). Le fragment est utilisé deux fois, lignes 256 (`replied`) et 260 (`button_replies`). La garde « aucun envoi ultérieur entre les deux » (lignes 110-117) ne porte que sur l'antériorité, jamais sur le canal.

**Correctif proposé.** Dans `entrantAttribue`, ajouter `and coalesce(m.channel, 'whatsapp') = coalesce(c.channel, 'whatsapp')` (le `coalesce` des deux côtés couvre les lignes antérieures aux migrations 0056 : `conversation_messages.channel` comme `campaigns.channel` peuvent y être nuls, et le repo traite déjà null comme WhatsApp, cf. inbox/store.pg.ts:485 et campaign/store.pg.ts:216).

---

#### Un message WhatsApp fait avancer un bloc RCS et se fait router comme un accuse de livraison RCS

`src/workflow/executor.ts:849` · **CONFIRME**

**Ce qui se passe.** Un parcours attend sur un bloc `rcs_message` qui propose des boutons reponse. Le contact ne clique pas dans le RCS, il ecrit sur WhatsApp (« c'est quoi ce message ? »). Le webhook Meta appelle processWorkflowAdvance -> advance(tenant, waId, wamid, null). Comme le bloc courant est un rcs_message, handle devient 'sent' : le parcours part par la sortie « envoye » du bloc RCS, declenchee par un message WhatsApp, alors qu'aucun rapport de livraison n'est arrive. Pire avec un tap de bouton : les deux canaux partagent le MEME espace de handles `btn:<i>`, donc un `btn:0` venu de WhatsApp prend la branche du bouton RCS numero 0, qui peut etre « Non merci » la ou le client a tape « Oui » sur autre chose.

**Preuve.** src/workflow/executor.ts:849 : `const handle = courant?.type === 'rcs_message' ? (buttonPayload ?? 'sent') : buttonPayload;` . `advance` n'a aucun parametre de canal et ses appelants sont indistincts : src/webhooks/workflow-advance.ts:29 (webhook Meta) et src/index.ts:801 (rappel smsmode) appellent la meme signature. `findWaitingByWaId` (src/workflow/run-store.pg.ts:80-90) ne filtre pas non plus le canal. Cela contourne la garde deliberee de rcsDelivered (src/workflow/executor.ts:786-792), qui refuse justement d'avancer sur « envoye » quand le bloc porte des boutons reponse. Espace de handles commun : src/meta/client.ts:103 (`reply.id = btn:<i>` cote WhatsApp) et src/rcs/schema.ts:123 (`postbackData = btn:<i>` cote RCS). Effet de bord : la reponse du client n'est meme pas comptee, executor.ts:839 exclut les blocs rcs_message de `mesurer`.

**Correctif proposé.** Passer le canal d'origine a `advance(tenantId, waId, messageId, buttonPayload, canal: 'whatsapp' | 'rcs')`. Les trois appelants le connaissent sans ambiguite : workflow-advance.ts = 'whatsapp', index.ts:801 = 'rcs', rcsDelivered/rcsUndeliverable = 'rcs'. Ligne 849, ne prendre le routage RCS ('sent' par defaut, handles du bloc RCS) QUE si canal === 'rcs'. Un entrant WhatsApp sur un bloc RCS doit etre traite comme une reponse ordinaire : mesurer reply_text/reply_button (retirer l'exclusion l.839 dans ce cas), router par buttonPayload puis arete libre, et sinon clore comme n'importe quelle reponse hors script.

**Réserve du contre-vérificateur.** Constat confirmé sur le fond, avec deux réserves de formulation et une réserve sur le correctif.

Ce n'est pas le fil unique multicanal (migration 0058) qui est en cause : le fil unique est un choix produit assumé côté Inbox, et le canal y est porté par la bulle. Le bug est ailleurs, dans le MOTEUR : `workflow_runs.channel` existe depuis 0082, il est correctement écrit à l'envoi, et il n'est jamais relu au moment de décider si un entrant concerne ce parcours. C'est une incohérence interne au code, pas une conséquence du fil unique.

Réserve 1 (portée, à la baisse). Le scénario exige que le contact écrive sur WhatsApp pendant qu'un parcours attend sur un bloc RCS à boutons. Rien ne l'empêche (un contact peut écrire à un numéro WhatsApp sans fenêtre ouverte, la fenêtre 24 h ne contraint que l'entreprise), mais cela reste une collision de timing, pas un chemin nominal. Ce n'est pas un « chaque envoi RCS est cassé ».

Réserve 2 (formulation, à la baisse). « sa vraie question n'est jamais traitée » est un peu fort : le message EST enregistré dans le fil (`inboxStore.recordInbound`), donc visible d'un opérateur. Ce qui est vrai, c'est qu'il n'est traité par personne automatiquement (le MBA est en standby tant que l'app tient le fil) et qu'il n'est pas mesuré. Le vrai dommage, et il est réel, est ailleurs : le client reçoit la suite d'un scénario RCS en réponse à une question WhatsApp sans rapport, ou son parcours est clos en silence.

Réserve 3, sur le correctif (à la hausse en exigence). Le paramètre `canal` sur `advance` est la bonne granularité et le bon endroit, et le coût est faible : deux appelants à modifier, deux appels internes (`rcsUndeliverable`/`rcsDelivered`) qui passent `'rcs'` sans risque puisque `channel` vaut forcément `'rcs'` quand le run attend sur un bloc RCS (executor.ts:607-608). Mais trois points à trancher avant de coder :
- Le placement doit être AVANT le bloc `mesurer` (executor.ts:836-846), sinon on compterait un entrant d'un autre canal comme une réponse au bloc en attente.
- Ne PAS écrire `lastMessageId` en sortant : le message n'appartient pas à ce parcours, le marquer consommé masquerait un rejeu légitime.
- Un `return` muet laisse le contact sans réponse ET sans signal : le fil reste sous `app_workflow`, le MBA ne reprend pas la parole, et personne n'est alerté. Le correctif referme la corruption du parcours mais pas le trou de traitement que le constat dénonce. Il faut au minimum une trace serveur, et idéalement décider explicitement quoi faire du message hors canal (escalade vers l'Inbox « à traiter », ou remise de main au MBA), sinon on remplace un mauvais routage par un silence, ce qui est plus propre mais toujours pas traité.

Le cas symétrique mérite le même traitement dans la foulée, la garde le couvre gratuitement : un run sur canal `whatsapp` en attente d'un bouton de template, et un clic de suggestion RCS `btn:i` qui tombe pile sur une branche câblée. Même cause, même correctif, aucune ligne supplémentaire.

---

#### Le payload `btn:<i>` est un espace de noms COMMUN aux deux canaux : un clic RCS choisit une branche WhatsApp

`src/workflow/executor.ts:816` · non contre-vérifié

**Ce qui se passe.** Scénario : bloc RCS avec 2 boutons -> le contact tape le bouton 0 -> la branche envoie un template WhatsApp avec 2 réponses rapides -> le run attend sur ce template (run.channel repasse à 'whatsapp', executor.ts:400). Le contact remonte dans son fil RCS et tape le bouton 1 de l'ANCIEN message RCS (les suggestions RCS restent tapables indéfiniment). smsmode renvoie `postbackData: 'btn:1'`, `onMo` appelle `advance(tenant, from, moId, 'btn:1')`, et `nextNodeByHandle` trouve l'arête `btn:1` DU BLOC TEMPLATE. Le scénario croit que le contact a choisi l'option 2 de la question WhatsApp, qu'il n'a jamais lue, et lui envoie la suite correspondante. Symétrique : un `btn:i` WhatsApp (bouton d'un template antérieur, toujours tapable) sélectionne la branche d'un bloc RCS.

**Preuve.** Les deux canaux écrivent le MÊME format de payload, sans marqueur de canal : `src/rcs/schema.ts:123` (`postbackData: \`btn:${rang++}\``), `src/meta/client.ts:103` (`reply: { id: \`btn:${i}\` }`) et `src/workflow/template-send.ts:63` (`payload: \`btn:${i}\``). `advance` (executor.ts:816) reçoit `buttonPayload: string | null` et ne dispose d'aucune information de canal ; `run.channel` est lu (executor.ts:866, passé à `walkResolved`) mais n'est JAMAIS comparé à la provenance de l'événement. Aucune garde entre executor.ts:817 et 856 ne mentionne le canal.

**Correctif proposé.** Même correctif que le constat précédent (paramètre `canal` sur `advance` + refus si `canal !== run.channel`). En défense de fond, qualifier le payload à l'émission (`rcs:btn:<i>` côté `normaliserPostbacks`, `wa:btn:<i>` côté Meta) et faire correspondre le handle du graphe en retirant le préfixe : deux tuyaux ne doivent pas partager un espace de noms de branche.

---

### Jaunes

#### Le refus de reponse libre ne mentionne que le template, alors que le RCS est offert sur le meme ecran

`src/http/inbox.ts:267` · non contre-vérifié

**Ce qui se passe.** Conversation dont la fenetre WhatsApp est fermee mais dont le contact est joignable en RCS (le cas devenu la norme depuis le correctif). Si l'operateur envoie sa reponse pendant que la fenetre se ferme (l'ecran recharge toutes les 4 s), ou si un integrateur appelle la route directement, il recoit `Fenetre de 24 h fermee : envoie un template.` Cette phrase est incomplete depuis le multicanal : le meme ecran propose juste en dessous le bouton `...ou envoyer un message RCS (pas de fenetre de 24 h)` (web/app/inbox/page.tsx:751-759). Consequence : l'operateur croit devoir faire approuver un template alors qu'il a un chemin immediat.

**Preuve.** inbox.ts:266-269 : `// Hors fenetre 24 h : Meta refuse le texte libre. On bloque et on invite a un template.` / `if (!ctx.windowOpen) { return reply.code(422).send({ error: 'Fenetre de 24 h fermee : envoie un template.', code: 'window_closed' }); }`. A comparer avec le texte de l'ecran, lui a jour : web/app/inbox/page.tsx:757 `'...ou envoyer un message RCS (pas de fenetre de 24 h)'`.

**Correctif proposé.** Completer le message du 422 : `Fenetre de 24 h fermee : envoie un template, ou un message RCS si le contact y est joignable.` Le code `window_closed` reste inchange (l'ecran s'en sert). Aucune logique a toucher.

---

#### Aucune reponse RCS LIBRE depuis l'inbox : un contact purement RCS n'est joignable qu'a travers la bibliotheque

`src/http/inbox.ts:292` · non contre-vérifié

**Ce qui se passe.** Le contact tape une suggestion RCS, puis ecrit un message libre en RCS. L'operateur ouvre le fil : la fenetre WhatsApp est (correctement) fermee, la barre de saisie disparait, et le seul chemin RCS offert est `send-rcs`, qui n'accepte QUE l'identifiant d'un message deja enregistre dans la bibliotheque. Il ne peut donc pas repondre une phrase ecrite a la main sur le canal ou le contact vient de lui parler : il doit soit aller creer une entree de bibliotheque, soit faire approuver un template WhatsApp. Le trou est ANTERIEUR au correctif (il n'y a jamais eu de chemin d'envoi RCS libre) mais le correctif le rend systematiquement visible, puisque la fenetre WhatsApp d'un contact purement RCS est desormais toujours fermee. C'est une decision produit a prendre, pas une regression : signale ici pour qu'elle soit prise sciemment.

**Preuve.** inbox.ts:292-315, la seule route RCS de l'inbox : `const rcsMessageId = (req.body as { rcsMessageId?: unknown } | null)?.rcsMessageId; if (!nonEmpty(rcsMessageId)) return reply.code(400).send({ error: 'rcsMessageId requis' });` puis `deps.sendRcsFromLibrary(tenant, ctx.waId, rcsMessageId as string)`. La dep ne lit qu'un enregistrement de la bibliotheque : index.ts:358 `const enregistre = await rcsMessageStore.getById(tenant, rcsMessageId); if (!enregistre?.content) return { refus: ... }`. Aucune autre porte : src/http/rcs-messages.ts n'expose que le CRUD de la bibliotheque (lignes 34, 40, 51, 65), pas d'envoi. Cote ecran, la saisie libre n'existe que dans la branche `windowOpen` (web/app/inbox/page.tsx:698-731).

**Correctif proposé.** Decision produit d'abord. Si on la prend : ajouter au corps de `send-rcs` une forme `{ text }` (exclusive de `rcsMessageId`), bornee, envoyee via le meme `rcsStack.sender` avec `{ kind: 'text', text }` -> aucun nouveau chemin d'envoi, memes garde-fous opt-out, et journalisation `recordOutbound(..., 'rcs')` deja en place a inbox.ts:313. Cote ecran, rendre la barre de saisie quand `rcsEnabled` et la fenetre fermee, avec un libelle qui dit explicitement 'reponse RCS'. Si on ne la prend pas, l'ecrire dans todo.md pour ne pas la redecouvrir au prochain incident.

---

#### `last_inbound_at` poussé au CRM mélange les canaux : la fenêtre 24 h annoncée à HubSpot est fausse

`src/analysis/enrichment.ts:36` · non contre-vérifié

**Ce qui se passe.** C'est le jumeau non corrigé de bf0408d, du côté du connecteur. Le dernier retour WhatsApp d'un contact date de 50 h, mais il a tapé un bouton RCS il y a 15 min. L'analyse de conversation part vers mm-hubspot avec `lastInboundAt` = l'horodatage du clic RCS, à côté d'un champ nommé `whatsappLine`. Le consommateur, à qui ce champ est explicitement présenté comme celui qui « pilote la fenêtre 24h Meta », conclut que la fenêtre WhatsApp est ouverte : le commercial dans HubSpot croit pouvoir répondre en texte libre, et l'envoi part en 131047. Exactement le scénario constaté en production le 2026-08-25, déplacé d'un écran à l'autre.

**Preuve.** src/analysis/enrichment.ts:35-36, `(select max(m.created_at)::text from conversation_messages m where m.conversation_id = c.id and m.direction = 'in') as last_inbound_at` : aucun filtre `channel`, contrairement aux deux requêtes corrigées de src/inbox/store.pg.ts:425 et 449. L'intention du champ est écrite en toutes lettres ligne 13 : `lastInboundAt: string | null; // dernier message ENTRANT : pilote la fenêtre 24h Meta`. Il est bien émis vers le connecteur : src/analysis/connector-push.ts:34 `lastInboundAt: enr.lastInboundAt`. Réserve honnête : mm-hubspot est un autre dépôt, je n'ai pas pu lire comment il exploite ce champ ; le nom, le commentaire et le voisinage de `whatsappLine` sont l'indice, pas la preuve du dégât en aval.

**Correctif proposé.** Aligner sur bf0408d : `and m.channel = 'whatsapp'` dans la sous-requête, et compléter le commentaire ligne 13 pour dire que c'est le dernier entrant WHATSAPP. Si le connecteur a besoin de savoir que le contact est vivant sur un autre tuyau, ajouter un champ distinct (`lastInboundAnyChannelAt`) plutôt que d'élargir celui-ci.

---

#### Les envois RCS sont comptés dans « Messages de service », série présentée comme non facturée par Meta

`src/stats/store.pg.ts:185` · non contre-vérifié

**Ce qui se passe.** Un client fait une campagne RCS de 3 000 messages. Sur le tableau de bord, la courbe « Messages envoyés » les range dans la barre « Service », dont l'écran et le code affirment qu'elle n'entre pas dans le coût parce que « Meta ne les facture pas au message ». Or ces messages-là sont facturés au message par smsmode. L'opérateur lit un volume envoyé présenté comme gratuit alors qu'une partie est payante, et le coût estimé n'en dit rien.

**Preuve.** src/stats/store.pg.ts:181-191 : `count(*) filter (where m.direction = 'out')::int as sortants` sur `conversation_messages`, filtré seulement par `m.type is distinct from 'template'` (ligne 188), une bulle RCS porte `type='rcs'` (src/campaign/engine.ts:338, src/workflow/wiring.ts:279, src/http/inbox.ts:313), elle est donc comptée. Ce compteur devient `service` (store.pg.ts:205) dont la définition dit, store.pg.ts:69-72 : « Messages de SERVICE : les SORTANTS qui ne sont pas des templates [...] Ils n'entrent PAS dans le coût estimé : Meta ne les facture pas au message ». L'écran répète l'affirmation : web/app/dashboard/page.tsx:94-96 et la série `{ label: 'Service' }` ligne 109.

**Correctif proposé.** Soit ajouter `and m.channel = 'whatsapp'` au compteur `sortants` (store.pg.ts:185) et exposer le volume RCS comme sa propre série, soit renommer la série et corriger la mention de facturation. La première option est la seule qui garde la phrase « Meta ne les facture pas » vraie.

---

#### Aucune automation ne se déclenche sur un message reçu en RCS

`src/index.ts:787` · non contre-vérifié

**Ce qui se passe.** Un opérateur crée une automation « mot-clé DEVIS -> scénario Devis ». Un contact écrit DEVIS dans le fil RCS. `onMo` enregistre la bulle, tente l'avance de parcours, et s'arrête là : `runAutomations` n'est jamais appelé sur ce chemin. Rien ne part, rien n'est journalisé, et l'écran d'automations ne dit nulle part qu'il ne couvre qu'un canal. Le contact reste sans réponse et l'opérateur croit son automation cassée. Même chose pour le déclencheur `new_contact`, qui dépend de `upsertFromInbound` (chemin WhatsApp uniquement).

**Preuve.** src/index.ts:771-806 : `onMo` fait trois choses, opt-out (778), `recordInbound` (787), `executor.advance` (801), et rien d'autre ; aucune occurrence de `runAutomations` ni d'enqueue `AUTOMATION_EVENT_QUEUE` dans ce bloc (les deux enqueues du fichier, lignes 281 et 465, portent sur `tag_added` et les webhooks entrants). Le seul producteur d'événement `kind: 'message'` est le job webhook Meta : src/worker.ts:253-256. `kindsFor` (src/automation/runner.ts:81) confirme que 'keyword' et 'new_contact' ne s'activent que sur cet événement.

**Correctif proposé.** Décision produit à prendre, puis l'une des deux : (a) afficher dans l'écran Automations que les déclencheurs « mot-clé » et « nouveau contact » sont WhatsApp seulement ; (b) câbler `onMo` sur `runAutomations` en portant le canal DANS l'événement, et alors corriger impérativement src/automation/runner.ts:113 (`const windowOpen = ev.kind === 'message';`), qui poserait la fenêtre WhatsApp à `true` sur un message RCS et réintroduirait mot pour mot le bug de bf0408d.

---

#### Les envois RCS sont comptes comme des templates WhatsApp et factures au tarif Meta dans le cout estime

`src/stats/store.pg.ts:348` · non contre-vérifié

**Ce qui se passe.** Un client lance une campagne RCS de 5 000 destinataires. Le lendemain, son tableau de bord affiche 5 000 templates marketing de plus dans « par jour : templates (marketing, utility) », la section « Templates envoyes » gagne une ligne au nom vide, et le graphe « cout estime » multiplie ces 5 000 envois par le tarif Meta marketing. Or Meta n'a rien facture : ces messages sont partis chez smsmode. Le client lit un cout WhatsApp qui n'existe pas, sur l'ecran meme ou il decide de son budget.

**Preuve.** src/stats/store.pg.ts:348-355 (getCostVolume) : `from campaign_recipients r join campaigns c on c.id = r.campaign_id where c.tenant_id = $1 and r.status = 'sent' ...`, aucun `c.channel`. Idem :156-160 pour le graphe quotidien des templates, groupe sur `c.category`. Et :219-223 (getTemplateBreakdown) filtre `c.template_name is not null`, ce qui n'exclut PAS une campagne RCS : src/http/campaigns.ts:309 pose `templateName: isWorkflow || isRcs ? '' : ...` et src/campaign/store.pg.ts:666 n'ecrit null que pour un workflow, donc une campagne RCS stocke la chaine vide, pas null. La categorie, elle, est exigee de toutes les campagnes quel que soit le canal (src/http/campaigns.ts:202).

**Correctif proposé.** Ajouter `and c.channel = 'whatsapp'` aux trois requetes (:157, :219, :348). Le RCS merite ses propres compteurs, mais jamais dans une serie intitulee « templates » ni dans un cout calcule au tarif Meta. Au passage, remplacer `c.template_name is not null` par `nullif(c.template_name, '') is not null` : la chaine vide traverse aujourd'hui tous les filtres ecrits pour null.

---

#### Un clic sur une suggestion RCS est compte comme un tap de bouton du template WhatsApp de la campagne

`src/stats/store.pg.ts:260` · non contre-vérifié

**Ce qui se passe.** Une campagne WhatsApp part avec un template a deux boutons. Le meme jour, un scenario RCS envoie une carte au meme contact ; il tape une suggestion RCS. L'ecran de resultats de la campagne WhatsApp compte ce contact dans « a tape un bouton » alors qu'il n'a jamais touche au template. Le taux de clic du template est faux, et c'est precisement le chiffre sur lequel on juge un template.

**Preuve.** src/stats/store.pg.ts:260 : `count(r.id) filter (where ${entrantAttribue("and m.type = 'button'")})`. Le fragment entrantAttribue (:103-118) joint conversation_messages sur `cv.wa_id` et `m.direction = 'in'` sans jamais regarder `m.channel`. Or une suggestion RCS est justement enregistree avec le type 'button' : src/index.ts:791, `type: mo.kind === 'suggestion' ? 'button' : mo.kind`. Le commentaire :257-259 a pris soin d'exclure les reactions et les interactifs pour ne pas compter un emoji comme un clic, mais le canal n'etait pas encore une dimension quand il a ete ecrit.

**Correctif proposé.** Ajouter `and m.channel = 'whatsapp'` dans le `extra` du compteur de boutons (au minimum), et decider explicitement pour « a repondu » : tous canaux se defend (fil unique, une reponse est une reponse), le bouton non, puisque le bouton compte n'est pas celui du template mesure.

---

#### Le retour RCS ne branche qu'une partie des circuits que branche le retour WhatsApp

`src/index.ts:756` · non contre-vérifié

**Ce qui se passe.** Deux effets. (1) Un client regle une automation « mot-cle : RDV ». Le contact ecrit RDV en RCS : la bulle apparait dans le meme fil, le client la voit, et l'automation ne part jamais. Aucun log, aucune trace : le declencheur est simplement muet sur ce canal. (2) Les rapports de livraison RCS n'alimentent pas la mesure par bloc : dans Analytics > Mes tableaux, un bloc RCS n'affiche que des « envoye », jamais « delivre » ni « lu », alors que smsmode remonte bien DELIVERED et READ (src/rcs/callback.ts:118-133).

**Preuve.** src/index.ts:756-770 (onDlr) appelle updateDeliveryByMessageId et les deux reprises de parcours, mais jamais nodeEventStore.recordStatusForMessage, contrairement au chemin Meta (src/webhooks/delivery.ts:71-74) ; les envois RCS ecrivent pourtant bien leur identifiant smsmode dans workflow_node_events.meta_message_id (src/workflow/executor.ts:409 via messageIdDe, alimente par envoyerQuickEnRcs:328). src/index.ts:771-806 (onMo) fait opt-out + recordInbound + advance, mais ne publie aucun evenement d'automation, la ou le chemin Meta le fait (src/worker.ts:253-256), et n'appelle pas upsertFromInbound (src/worker.ts:240), d'ou aussi le 'STOP RCS sans fiche contact' journalise en index.ts:782.

**Correctif proposé.** Dans onDlr, appeler recordStatusForMessage(dlr.messageId, dlr.status) quand le statut vaut delivered/read/failed, en best-effort comme cote Meta. Dans onMo, publier l'evenement d'automation `message` et creer/rafraichir la fiche contact, ou bien decider et ECRIRE noir sur blanc que les automations sont WhatsApp seulement, et griser le declencheur dans l'ecran quand la conversation est RCS. Ce qu'il ne faut pas laisser, c'est un declencheur qui parait branche et ne l'est pas.

---

#### Le rappel smsmode : la deuxieme garde annoncee ne tient pas devant un corps forge

`src/http/rcs-callback.ts:82` · non contre-vérifié

**Ce qui se passe.** Le code d'URL fuite (log, capture d'ecran, ticket au fournisseur). Un tiers poste un MO forge en OMETTANT simplement l'objet `channel` : channelId vaut null, la garde ne se declenche pas, et le corps est traite. Il ecrit une bulle entrante dans le fil de n'importe quel numero du tenant, peut marquer ce contact opt-out RCS, et surtout FAIT AVANCER son parcours (src/index.ts:801). Le commentaire d'en-tete affirme pourtant qu'un corps forge avec le canal d'un autre client est refuse meme si le code fuitait : c'est vrai d'un corps honnete, faux d'un corps forge.

**Preuve.** src/http/rcs-callback.ts:82 : `if (evenement.channelId !== null && evenement.channelId !== canal.agentId)`. Le champ est optionnel dans l'enveloppe (src/rcs/callback.ts:88, `channel: z.object({ channelId: z.string().optional() }).partial().passthrough().optional()`) et parseRcsDlr/parseRcsMo rendent null quand il manque (:189, :216). L'en-tete :36-39 decrit cette garde comme ce qui empeche un rappel d'ecrire dans les donnees d'un autre tenant.

**Correctif proposé.** Deux options, pas une demi-mesure. Soit exiger le channelId (404/403 si absent), apres avoir verifie sur les corps reels deja captures dans rcs_agents.last_callback qu'il est toujours present, auquel cas la garde devient vraie. Soit rectifier le commentaire pour ne promettre que ce qui est tenu (le code d'URL est la SEULE authentification), et alors traiter le code comme un secret a part entiere : rotation possible depuis l'ecran, jamais journalise. Dans les deux cas, un plafond de requetes sur cette route, qui est aujourd'hui la seule ecriture non signee du produit.

---

## 🔴 À NE PAS « corriger » : les partages de canal qui sont VOULUS

Cette liste compte autant que les constats. Elle évite qu'une prochaine passe casse un choix délibéré en
croyant réparer une fuite.

- [regression-inverse] src/http/inbox.ts:281-315 (route send-rcs) : VOLONTAIREMENT sans garde de fenetre 24 h, et c'est juste. Le commentaire le dit et le code le tient : la fenetre est une regle de WhatsApp, le RCS n'en a pas. C'est meme le chemin qui sauve la situation creee par le correctif. Ne pas 'aligner' cette route sur reply.
- [regression-inverse] src/inbox/store.pg.ts:463-487 (getMessages) : aucun filtre de canal, toutes les bulles remontent. CORRECT : le fil unique par contact est le choix produit de la migration 0058, et l'ecran distingue les canaux par la couleur (web/app/inbox/page.tsx:656-662) et par le title 'RCS'. Ajouter un filtre ici couperait le fil en deux.
- [regression-inverse] web/app/inbox/page.tsx:843 + web/lib/campaign-eligibility.ts:156-163 (isCampaignEligible) : fenetre fermee, la liste des scenarios proposables garde ceux qui ouvrent par un bloc RCS configure (`if (scan.rcsOpen) return true;`). Le correctif ne fait donc PAS disparaitre ces scenarios du selecteur ; il les rend meme plus souvent pertinents. Le miroir serveur est src/workflow/engine.ts:116-127, et tests/web-campaign-eligibility.test.ts:248 verifie la parite des deux. Rien a corriger.
- [regression-inverse] src/workflow/executor.ts:672-676 (garde fenetre de runFrom, atteinte quand l'inbox lance un scenario avec windowOpen=false via index.ts:422-424) : elle ne refuse QUE si le walk a produit une action sendFlow/sendQuickMessage. Un scenario qui ouvre par un bloc rcs_message n'en produit pas, parce que walkResolved rend la main sur ce bloc avec rest='waiting' des que l'envoi RCS a reussi (executor.ts:603-608). Verifie par lecture : le lancement depuis l'inbox d'un scenario a ouverture RCS fonctionne toujours, fenetre WhatsApp fermee. Le correctif ne casse rien la.
- [regression-inverse] src/workflow/executor.ts:389-400 (apply) : un 'message rapide' part sur le canal du PARCOURS et non selon le type du bloc, et un template/formulaire ramene volontairement le parcours sur WhatsApp. C'est le bon modele, et c'est precisement la reference dont resume() s'ecarte (constat rouge n.1).
- [regression-inverse] src/workflow/executor.ts:816-884 (advance) : aucune garde de fenetre. CORRECT : advance n'est declenche que par un message entrant, et la suite part sur run.channel. Un retour RCS y fait donc avancer un parcours RCS sans toucher a la fenetre WhatsApp.
- [regression-inverse] Compteur de non-lus et compteur 'A traiter' (src/http/inbox.ts:166-181) : tous canaux confondus, volontairement. Une reponse RCS non lue est une reponse non lue.
- [regression-inverse] src/inbox/store.pg.ts:420-437 et 445-461 : le correctif lui-meme est juste sur le fond. La fenetre de service est une regle de la messagerie Meta ; y compter un retour RCS annoncait 'ouvert' a un operateur que Meta aurait refuse en 131047. Le probleme n'est pas ce filtre, c'est que deux consommateurs de cette valeur (resume et /v1/sends cible node) l'appliquent a des envois qui ne passent pas par WhatsApp.
- [ecriture-du-canal] Les TROIS seuls points d'écriture dans `conversation_messages` sont dans src/inbox/store.pg.ts (lignes 229, 251, 511), et les trois acceptent un canal : `recordInbound(tenantId, m, channel = 'whatsapp')` (:225), `recordOutboundByWaId(..., msg.channel)` (:245/:254), `recordOutbound(..., channel = 'whatsapp')` (:502/:513). Aucune méthode n'écrit en dur 'whatsapp' sans pouvoir faire autrement.
- [ecriture-du-canal] Webhook Meta entrant : src/webhooks/inbound.ts:180 `await store.recordInbound(tenantId, m)` sans canal -> défaut 'whatsapp'. CORRECT : cette porte ne reçoit que des messages Meta. L'interface (inbound.ts:37) n'expose volontairement pas le paramètre, ce qui rend l'omission non ambiguë plutôt que silencieuse.
- [ecriture-du-canal] Rappel RCS entrant : src/index.ts:787-796 `recordInbound(tenant, {...}, 'rcs')`, canal explicite, correct.
- [ecriture-du-canal] Bloc de scénario RCS : src/workflow/wiring.ts:278-279 `recordOutboundByWaId(tenant, waId, { ...msg, type: 'rcs', channel: 'rcs' })`, appelé par `journaliserRcs` (executor.ts:336-339) pour le bloc `rcs_message` ET pour un message rapide parti en RCS (executor.ts:322). Correct dans les deux cas.
- [ecriture-du-canal] Message rapide et formulaire WhatsApp d'un scénario : wiring.ts:458 et :478 sans canal -> 'whatsapp'. CORRECT, ce sont des appels `client.sendInteractive` / `client.sendFlowMessage` chez Meta (lignes 456 et 476).
- [ecriture-du-canal] Template de scénario : wiring.ts:432 `logTemplateSent` -> src/inbox/outbound-log.ts:22 sans canal -> 'whatsapp'. Correct, un template est WhatsApp par nature.
- [ecriture-du-canal] Campagne : src/campaign/engine.ts:328-342 écrit `channel: 'rcs'` + `type: 'rcs'` quand `deps.channelSender` est défini, et le couple template_category/template_name (donc 'whatsapp' par défaut) sinon. Correct. La condition `!campaign.workflowId` n'est pas un trou : une campagne RCS + scénario est refusée à la création (src/http/campaigns.ts:221-223), et une campagne WhatsApp sur un scénario qui OUVRE en RCS (autorisée, campaigns.ts:258) laisse l'exécuteur écrire la bonne bulle.
- [ecriture-du-canal] Inbox : src/http/inbox.ts:313 (send-rcs) passe explicitement 'rcs' ; :277 (réponse texte) et :399 (template) laissent le défaut 'whatsapp' après un envoi Meta réel. Correct.
- [ecriture-du-canal] Message de l'agent MBA : src/worker.ts:247-248 `recordOutboundByWaId(..., { type: 'mba' })` -> 'whatsapp'. Correct, MBA est l'agent de Meta.
- [ecriture-du-canal] Compteur de non-lus (UNREAD_SQL, store.pg.ts:79-83) et compteur « À traiter » : tous canaux. VOULU, une réponse RCS non lue est une réponse non lue.
- [ecriture-du-canal] Volumes globaux tous canaux : src/ops/store.pg.ts:75-77 et :111-113 (« Messages échangés »), src/crm/contact-history.pg.ts:180 (`messages_count` de la fiche contact), src/analysis/store.pg.ts:79-85 (transcript d'analyse). VOULU : le fil est unique par contact, ce sont des volumes et un transcript, pas des règles de messagerie WhatsApp.
- [ecriture-du-canal] Lignes HISTORIQUES : aucun risque de bulle RCS étiquetée 'whatsapp'. (a) La colonne est `not null default 'whatsapp'` et a bien été créée par la version de 0056 RÉELLEMENT appliquée en production (git show ee0a9dc:db/migrations/0056_channel.sql contient `alter table conversation_messages add column if not exists channel text not null default 'whatsapp'`), donc aucune ligne NULL n'existe malgré la réécriture sur place dénoncée par 0058. (b) Chaque chemin d'écriture RCS est né AVEC son canal : 4988c73 pour le scénario (journaliserRcs + wiring `channel: 'rcs'`), 8db581c pour la campagne, 1f59f07 pour le MO entrant, aucune bulle RCS n'a jamais été écrite avant l'existence de la colonne. (c) store.pg.ts:485 mappe défensivement tout ce qui n'est pas 'rcs' vers 'whatsapp'.
- [ecriture-du-canal] Opt-out : le STOP RCS écrit une colonne DÉDIÉE `contacts.rcs_optout_at` (src/rcs/store.pg.ts:158-163, via index.ts:779) et ne touche pas `opt_in_status`. Correct, un STOP sur un canal ne désabonne pas de l'autre. Et l'opt-in global reste opposable au RCS (src/campaign/build.ts:69, `optInAllows`).
- [ecriture-du-canal] Identifiants : un MO RCS porte son PROPRE `messageId` (src/rcs/callback.ts:215), distinct de `originMessageId` (:218). Le `on conflict (meta_message_id) do nothing` de `recordInbound` ne peut donc pas faire disparaître une bulle entrante RCS en la confondant avec la bulle sortante qu'elle répond.
- [ecriture-du-canal] Interface : l'écran Bibliothèque des messages RCS (src/http/rcs-messages.ts) n'écrit RIEN dans le fil, il ne fait que du CRUD sur la bibliothèque ; l'envoi passe par index.ts:355-373 puis http/inbox.ts:313 qui étiquette 'rcs'.
- [ecriture-du-canal] Inbox, fenêtre fermée : le bouton d'envoi RCS reste offert dans la branche « fenêtre 24 h fermée » (web/app/inbox/page.tsx:751-759), et `isCampaignEligible` accepte un scénario qui ouvre en RCS hors fenêtre (web/lib/campaign-eligibility.ts:159-161). Correct : le correctif bf0408d, qui ferme désormais plus souvent la fenêtre affichée, ne prive donc pas l'opérateur du canal RCS.
- [lecture-du-canal] Compteur de non-lus tous canaux (src/inbox/store.pg.ts:79-83, `UNREAD_SQL`) : une réponse RCS non lue EST une réponse non lue. Le fil est unique par contact, l'opérateur doit voir la pastille quel que soit le tuyau. Ne pas y toucher.
- [lecture-du-canal] `control_owner` et le filtre « À traiter » (src/inbox/store.pg.ts:278 et 348) : le contrôle porte sur le CONTACT, pas sur un tuyau. C'est écrit et assumé aux lignes 106-109 (« la reprise de main par un opérateur continue de valoir pour le contact entier, pas pour un tuyau »). Un opérateur qui répond en RCS gèle donc aussi le scénario WhatsApp : c'est le comportement voulu, et le contraire ferait écrire deux voix au même client.
- [lecture-du-canal] Transcript d'analyse tous canaux (src/analysis/store.pg.ts:79) : le LLM analyse la conversation AVEC LE CONTACT. Couper le transcript par canal découperait un dialogue en deux moitiés incompréhensibles. Correct.
- [lecture-du-canal] `getMessages` (src/inbox/store.pg.ts:469-486) rend le canal PAR BULLE et mappe null -> 'whatsapp' : c'est exactement le bon modèle, l'écran dessine le tuyau de chaque bulle sans découper le fil.
- [lecture-du-canal] Volumes du dashboard `exchanged` et `service` (src/stats/store.pg.ts:181-191) tous canaux : ce sont des volumes échangés, les deux tuyaux comptent légitimement. Contrairement au funnel de campagne, aucune attribution à un envoi précis n'est en jeu.
- [lecture-du-canal] Opt-out RCS cloisonné au canal (src/rcs/store.pg.ts:191, écrit `rcs_optout_at` seul, sans toucher `opt_in_status`) : c'est une DÉCISION PRODUIT explicite, pas un oubli. La preuve est dans le message montré à l'opérateur, src/index.ts:369, « Ce contact s'est désabonné du RCS (il a répondu STOP). Passez par WhatsApp. » Le produit assume que le STOP vaut pour le tuyau. Ne pas le « corriger » sans arbitrage de Julien (le fil étant unique à l'écran, un client peut légitimement croire son STOP global : c'est une question de conformité, pas de code).
- [lecture-du-canal] Le sens inverse de l'opt-out, lui, est bien étanche : `optInAllows` (src/campaign/guardrails.ts:11-15) est appliqué aussi aux campagnes RCS (src/campaign/build.ts:69, appelé avec le canal depuis src/campaign/create.ts:30), donc un contact `opted_out` global est bien écarté d'une campagne RCS. Rien à faire.
- [lecture-du-canal] `rcsUndeliverable` et `rcsDelivered` (src/workflow/executor.ts:767 et 786) sont gardés par `blocRcsEnAttente` (797-803) : un accusé de livraison RCS ne peut PAS faire avancer un run qui attend autre chose. C'est la bonne garde, correctement motivée aux lignes 758-762, et c'est précisément celle qui manque à `advance` (constats 1 et 2).
- [identite-et-routage] Le fil unique par contact et l'unique (tenant_id, wa_id) de conversations (migration 0058, src/inbox/store.pg.ts:104-124). Les deux canaux resolvent bien par la MEME cle : Meta donne un wa_id en chiffres nus, et le RCS passe par chiffresNus (src/rcs/callback.ts:136) puis numeroDuContact (:153) qui rend aussi des chiffres nus. Le rattachement a la fiche contact utilise le meme predicat des deux cotes (matchWaIdPredicat, src/crm/contact-store.pg.ts:44), qui tolere '+33...' comme '33...'. Aucune divergence de normalisation trouvee entre les deux circuits : pas de risque de double conversation pour un meme numero selon le canal.
- [identite-et-routage] Le compteur de non-lus tous canaux (UNREAD_SQL, src/inbox/store.pg.ts:79-83, utilise par listConversations et countUnread). Une reponse RCS non lue EST une reponse non lue. Ne pas y toucher.
- [identite-et-routage] Le canal est porte par la BULLE et jamais deduit du contact. Verifie sur les trois chemins d'envoi : l'operateur choisit explicitement (src/http/inbox.ts:292 send-rcs contre :255 reply, et web/app/inbox/page.tsx:715 propose le bouton RCS sans jamais le deduire du contact), la campagne le porte (campaigns.channel, migration 0056), et le parcours le porte comme un ETAT qui suit ce que le contact a RECU, pas ce que le bloc voulait (workflow_runs.channel, migration 0082, pose seulement si l'envoi est parti : src/workflow/executor.ts:606). La faute d'origine redoutee (deduire le canal du contact) n'existe nulle part.
- [identite-et-routage] Les deux portes sont bien etanches l'une a l'autre. /webhooks/meta exige la signature HMAC sur le corps brut avant toute lecture (src/webhooks/receiver.ts:62-68) : un corps smsmode y est rejete en 403. /rcs/callback/:code n'est atteignable qu'avec un code opaque de 128 bits (src/index.ts:742) : un corps Meta qui y arriverait n'a ni messageId ni status.value, donc estDlr est faux, parseRcsMo rend null faute de numero, et la route repond 200 sans ecrire une ligne (src/http/rcs-callback.ts:71-78). Aucun croisement possible entre les deux formats.
- [identite-et-routage] updateDeliveryByMessageId (src/campaign/store.pg.ts:722-735) et recordStatusForMessage (src/workflow/node-events.pg.ts:68-81) filtrent bien sur l'identifiant SEUL, sans tenant ni canal, et ce n'est pas exploitable aujourd'hui : les deux espaces d'identifiants sont disjoints (un wamid Meta commence par 'wamid.', un identifiant smsmode est un UUID) et un UUID smsmode est unique chez le fournisseur, donc un accuse RCS ne peut pas tomber sur une ligne WhatsApp ni l'inverse. Meme raisonnement pour l'index unique partiel global de conversation_messages.meta_message_id (0009:31), que les deux canaux partagent sans se marcher dessus. A garder en tete quand meme, sans en faire un chantier maintenant : ces requetes ne sont pas scopees tenant, donc le jour ou un fournisseur emettra des identifiants courts ou sequentiels, ce sont ces deux lignes qui deviendront le trou. Un `and c.tenant_id = $x` sur chacune ne couterait rien.
- [identite-et-routage] Le RCS n'ecrit PAS dans webhook_events : l'idempotence Meta (webhook_events.meta_message_id, 0001:74) reste strictement Meta. Le corps d'un rappel smsmode est garde ailleurs, dans rcs_agents.last_callback (src/rcs/store.pg.ts:140-145). Les deux journaux de reception sont separes, c'est bien.
- [identite-et-routage] L'opt-out RCS resiste a la difference de format entre les deux circuits : un STOP arrive en chiffres nus depuis le rappel (src/index.ts:779) est retrouve par une campagne qui interroge en '+E.164', parce que les deux requetes essaient les DEUX formes sans fonction sur la colonne (src/rcs/store.pg.ts:173-179 et :192-197). C'est le seul endroit du parc ou cette precaution etait vitale et elle y est.
- [identite-et-routage] control_owner est pose par CONTACT et non par canal (le commentaire de src/inbox/store.pg.ts:106-109 l'assume). Consequence : une reponse RCS qui termine un parcours peut rendre le fil WhatsApp a l'agent Meta (src/workflow/executor.ts:884 -> rendreLaMainAMba -> releaseThreadChezMeta, src/workflow/wiring.ts:297-300). C'est coherent avec le fil unique et avec la reprise de main d'un operateur qui vaut pour le contact entier. A ne pas 'corriger' : ce n'est pas une fuite, c'est la meme decision produit que 0058.
- [identite-et-routage] Les circuits de reparation restent Meta-only et c'est correct : l'auto-relance (src/campaign/store.pg.ts:480-492) et le breakdown d'erreurs (src/stats/store.pg.ts:328) sont indexes sur des codes d'erreur Meta (131049, 131026) et sur error_code is not null, or le rappel RCS ecrit toujours error_code null (src/index.ts:760). Un echec RCS ne peut donc pas declencher une relance WhatsApp ni polluer le tableau des erreurs de template.

