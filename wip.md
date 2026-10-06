# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.** Vidé pour la sixième fois le 2026-09-16 :
> il annonçait encore `93a10c4` et répétait une mesure démentie depuis (voir plus bas).

## L'ÉTAT EXACT, AU 2026-09-28

| | |
|---|---|
| `origin/main` | voir `git log` (ce fichier ne recopie plus un SHA, il a menti six fois) |
| VPS (`mba-api`, `mba-worker`, `mba-web`) | ✅ **À JOUR AU 2026-09-29** : la recharge Stripe (Crédit IA sous Paramètres, commission au débit, traduction débitée, code promo, lien Facture, 5 € au numéro vérifié), le panneau Détail de l'Inbox et les publicités archivées ou programmées, migrations 0189 à 0193 appliquées AVANT chaque `up` et relues en base. CI verte job par job, sauf le plan d'une autre session (voir `todo.md`). Le SHA n'est pas recopié ici (`git log` fait foi). |
| Vercel (`engageme`) | suit `origin/main` tout seul |
| Migrations | 🔴 **LE COMPTEUR N'EST PAS ICI, IL EST DANS [CLAUDE.md](CLAUDE.md), SECTION DÉPLOIEMENT.** Cette ligne l'a recopié et l'a eu FAUX (elle annonçait 0151 quand la base portait 0152, neuvième dérive), exactement comme `PLAN.md` et `brain/PROJECTS.md` avant elle. En cas de doute, c'est la BASE qui tranche : `select name from public.schema_migrations order by name desc`. |
| CI | ✅ verte job par job, lue sur `gh run view <id> --json jobs` et jamais sur le code de sortie du watch. ⚠️ **Elle est passée ROUGE une fois le 2026-09-17**, sur le seul job qui voit une base (`integration`), pour un test qui laissait de la donnée derrière lui : la cause et la parade sont dans la section Performance Lab |
| Revue finale | ✅ **ATTESTÉE, 0 rouge, 4 jaunes**, sur `9c29257a` (rapport `docs/prive/REVUE-FINALE-2026-09-23-deploiement.md`). Vérifié par moi et pas sur le rapport d’un pair : typecheck propre, **6294 tests unitaires verts**, CI relue JOB PAR JOB sur le dernier commit de code, et surtout l’état RÉEL de la base, qui a démenti le « trois migrations en attente » d’un message inter-session. Les 4 jaunes sont préexistants ou déjà déclarés par leurs auteurs. |
| Contrôle public | ✅ **Les cinq portes publiques à 200** après le déploiement du 2026-09-23 : `/health` et `/live` sur `api.`, le chemin `/api/backend/` de `mba.` qui porte le webhook Meta, la console Vercel, l’ancienne console. `nginx -s reload` posé APRÈS l’attente de `healthy`, jamais enchaîné au `up` (leçon du 2026-09-08) : aucun 502 cette fois. ⚠️ Et les deux routes neuves répondent **401, pas 404** : montées et gardées, donc la fenêtre Vercel/API est fermée. |

## RETOURS CONSOLE DU 6 OCTOBRE (RC1 À RC8) : RC1 À RC4 EN PRODUCTION (ESSAIS RÉELS DUS), RC5 ENSUITE

⏳ **Essai réel de RC1, par Julien** : ouvrir un scénario, vérifier que les textes listés ont disparu des cinq blocs,
taper une réponse rapide et voir `0/20` se remplir, trouver « Widget WhatsApp » sous Tools.

⏳ **Essai réel de RC2, par Julien** : marquer à la main une conversation urgente depuis l'Inbox (« Ranger dans… »),
la voir dans « Urgent » et en tête de « À traiter », la passer « Traité » et la voir quitter « Urgent » ; puis donner
l'outil « Marquer la conversation urgente » à un agent IA, lui écrire « c'est urgent » depuis un vrai téléphone, et
retrouver la conversation dans « Urgent » (pas dans « À traiter » : l'agent la tient encore), l'agent continuant de
répondre.

⏳ **Essai réel de RC3, par Julien** : avec son adresse qui porte plusieurs espaces, ouvrir le menu du compte, y voir
le nom de l'espace actuel et « Changer d'espace » avec les autres, en choisir un, arriver sur ses données sans écran de
connexion, et revenir de la même façon ; une adresse à un seul espace ne voit pas l'entrée.

⏳ **Essai réel de RC4, par Julien** : sur l'agent IA d'un espace de test, l'onglet Outils montre « Toujours là » et
la grille de six cartes ; poser un « Lancer un scénario » vers un scénario publié et un « Poser un tag » fixe, cocher
l'autonomie du premier ; depuis un vrai téléphone, amener l'agent à les appeler : le tag est sur la fiche, le scénario
part, l'agent se tait ensuite. ⚠️ À valider aussi : l'assistant de construction ne propose plus d'outil à cible
(`todo.md`).

Douze demandes de Julien regroupées en huit lots, cadrées le 2026-10-06 par une série de questions ; les décisions sont
écrites dans chaque plan (`docs/superpowers/plans/2026-10-06-rc*.md`). Ordre retenu : du plus petit au plus structurel.

| Lot | Contenu | Méthode |
|---|---|---|
| RC1 | Textes d'aide retirés (la liste de Julien), compteurs 0/20 et 0/24, Widget WhatsApp sous Tools | En direct |
| RC2 | Statut « urgent » (dossier, pastille, en tête de « À traiter »), outil de l'agent IA | Revue du diff |
| RC3 | Changer d'espace depuis le menu du compte | Revue du diff |
| RC4 | Outils de l'agent IA présentés comme ceux du MBA, « Lancer un scénario », cibles fixes | Revue du diff |
| RC5 | Condition à familles nommées, champs système, bloc « Aller à », bouton « copier le code » | Revue du diff |
| RC6 | Qui répond : MBA, agent IA, scénario ou équipe ; MBA en veille ; bloc « Envoyer au MBA » | Revue du diff |
| RC7 | Champ du contact dans l'URL d'un bouton de template, rempli au clic | Revue du diff |
| RC8 | Supprimer un espace depuis /ops, ménage chez les tiers, liens Stripe | Revue du diff |

## UN AGENT NE VOIT JAMAIS DEUX OUTILS DU MÊME NOM (0211, 0213) : LES DEUX LOTS EN PRODUCTION, ESSAIS D'ÉCRAN DUS

Plan : `docs/superpowers/plans/2026-10-06-nom-unique-par-consommateur.md` ; récit et mesures :
`docs/JOURNAL-TECHNIQUE.md` (les deux entrées du 2026-10-06).

- ✅ **Lot 1** (`2a6c2046`) déployé le 2026-10-06, 0211 appliquée à 7 h 05 UTC et relue en base.
- ✅ **Lot 2** (`3cb96ab7`) déployé le 2026-10-06, 0213 appliquée à 8 h 01 UTC et relue en base (`tool_name` NOT NULL).
- ⏳ **Essais d'écran, par Julien** (puis cette section sort) :
  - lot 1 : sur un agent de test qui a une action (par exemple `mba_terminer`) et un appel de connecteur, « Modifier »
    l'appel et lui donner le nom technique de l'action, puis Enregistrer : le refus s'affiche dans le formulaire, rien
    ne change ; l'onglet Tester répond toujours ;
  - lot 2 : sur un agent qui a une action `x` et un connecteur `x` de l'espace qu'il n'utilise pas, l'assistant de
    construction ne propose pas de brancher `x`, et l'onglet Outils le propose toujours, avec le refus lisible au clic.
- 🟡 **Laissés, avec leur raison** (les trois jaunes de conception du lot 2 sont dans `todo.md`) : le 409 ne nomme ni l'outil ni l'agent en conflit (le nom est celui qu'on vient de
  saisir ; nommer l'agent demanderait de lire le détail de l'erreur de Postgres) ; deux interblocages théoriques
  relevés par la relecture (la migration contre trois chemins rares, deux renommages croisés simultanés), en 500 sur
  une requête au pire.

## LOT 4 DE « MESSAGING ME POUR CLAUDE CODE » : CE QUE DEVIENT UN NUMÉRO FOURNI DONT L'ABONNEMENT TOMBE, PLAN ÉCRIT

Cadré avec Julien le 2026-10-06 ; spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`. Deux livraisons :
A, la suspension (état calculé sur des dates, migration 0215, garde au point d'envoi unique, réabonnement, bandeau,
rappel MCP) ; B, la libération (délié, résilié chez DIDWW) et les e-mails. L'espace de l'essai du 2026-10-06 suit le
cycle : c'est l'essai réel.
- ✅ Spec validée par Julien ; plan `docs/superpowers/plans/2026-10-06-numero-impaye.md` (12 tâches).
- ✅ Migration 0215 poussée seule (`149db406`) et appliquée le 2026-10-06 à 16 h 57 UTC, relue en base.
- ✅ **Lot 4, livraison A (la suspension) en production le 2026-10-06 : migration 0215 appliquée à 16 h 57 UTC et relue
  en base, API et deux workers sur `fca3d285` (premier balayage à 18 h 48 UTC), console `bef80514` publiée à 18 h 52
  UTC, CI verte job par job.** Relue : deux rouges corrigés avant le déploiement,
  chacun avec son test vu rouge puis vert ; neuf jaunes dans `todo.md`. Réglages Stripe faits par Julien avant le `up`
  (`customer.subscription.updated` au webhook, relu chez Stripe ; « annuler l'abonnement » après la dernière relance
  l'était déjà, pour tout le compte).
- ✅ **Essai réel de A fait le 2026-10-06** (Julien, après le déploiement) sur l'espace de l'essai du 3c, dont
  l'abonnement était fini depuis 15 h 14 : une seule alerte Telegram, le bandeau « envois coupés » avec la date de
  libération (13 octobre), le refus dans l'Inbox, et dans Claude Code `get_number_subscription` « suspendu » et le
  rappel sur chaque réponse d'outil. Vérifié aussi par le code déployé, en lecture seule : ce numéro est suspendu,
  ceux de trois autres espaces non.
- Reste : les jaunes de la relecture, puis la livraison B (la libération à J+7, « Abandonner », les e-mails), tâches 9
  à 12. Sans B, l'espace de l'essai reste suspendu après le 13 octobre : rien ne le libère encore.

## LOT 3c DE « MESSAGING ME POUR CLAUDE CODE » : LE NUMÉRO BRANCHÉ DEPUIS CLAUDE CODE, EN PRODUCTION, ESSAI RÉEL FAIT

Le client ne passe jamais par la console : Claude Code lui donne un lien qui ouvre la page de connexion du numéro
sans connexion, suit le branchement et affiche le code. Spec `docs/superpowers/specs/2026-10-06-lien-attente-abonnement-design.md`,
validée par Julien le 2026-10-06 ; plan `docs/superpowers/plans/2026-10-06-lien-attente-abonnement.md`.

- ✅ **Livraison A en production le 2026-10-06** : API `d20dea6b` (aucune migration), console `b4f81ec4` poussée après
  le `up`. Relue : zéro rouge ; les jaunes (numéro relié non activé, 403 sur la page, chargeur d'état exigé, « Abandonner »
  après la connexion d'un autre numéro, test d'isolation resserré) corrigés dans le commit suivant ; la révocation de
  l'accès de Claude qui ne coupe pas un lien déjà donné est dans `todo.md`.
- ✅ **Livraison B en production le 2026-10-06** : migration 0214 appliquée à 12 h 24 UTC et relue en base, API et
  workers sur `c9973f44` (12 h 25), console `7c1ede29` poussée après le `up`. Réglages Stripe faits par Julien avant le
  `up` : `STRIPE_PRIX_NUMERO` (posé par Claude avec son accord), les trois événements ajoutés au webhook (relus chez
  Stripe), le portail client actif. Relue : un rouge (« Remplacer » attribuait sans abonnement) corrigé, test vu rouge
  puis vert. Ses huit jaunes sont corrigés le même jour, chacun avec son test vu rouge puis vert : le portail de Stripe
  dans la console (route à la session d'admin seule), le texte après « Abandonner », le retour de Stripe qui rouvre le
  numéro fourni (et « Payer » si l'abonnement est résilié), la course de « Remplacer », les numéros libres dus d'abord
  aux abonnés en attente (paiement, alerte, et un numéro rendu qui les sert), et les deux fausses alertes du webhook.
  En production le même jour : API et workers sur `6050fdb7` (aucune migration ; la route du portail rend 401 sans
  session, contre 404 pour une route inconnue), console `fbae4608` poussée après, CI verte job par job.
- ✅ **Essai réel commun A et B fait le 2026-10-06** (Julien, vérifié en base, chez Meta et chez DIDWW en lecture
  seule) : +44 1259 797311 acheté chez DIDWW, déclaré dans /ops à 14 h 41 UTC (libre, branché sur le trunk de
  l'Asterisk) ; espace neuf né de la connexion de Claude Code à 14 h 45 (`claude_code`, avec le Gmail de l'essai du 3b,
  dont l'espace avait été supprimé) ; un vrai paiement : l'abonnement `actif` en mode réel et le numéro attribué dans la
  MÊME transaction à 14 h 52, la facture payée juste après pose la fin de période ; le code de Meta capté et affiché
  dans le terminal de Claude Code ; le numéro relié à 14 h 57, `CONNECTED` et `VERIFIED` chez Meta ; 1 € offert.
  Meta a imposé le SMS : la ligne fixe l'a lu à voix haute, code non retenu (« ### to ### ») ; le code redemandé est
  arrivé par appel. Corrigé le même jour : `extraireCodeOtp` lit aussi le SMS lu (centaines anglaises, trois chiffres
  « to » trois chiffres juste après « code »), et la page comme la consigne de Claude disent que le SMS arrive aussi. La résiliation par le portail ne donne rien avant la fin de période (aucun événement écouté) ; annulé ensuite
  immédiatement dans Stripe : `resilie` à 15 h 14, l'alerte Telegram reçue (Julien), le numéro reste attribué (rien
  n'est coupé avant le lot 4). Ce qu'il a montré est dans `todo.md`. Reste à Julien : résilier chez DIDWW le numéro de
  l'essai du 3b (+44 1235 619343, en `bloque`), puis le passer en `resilie`.

## LOT 5 DE « MESSAGING ME POUR CLAUDE CODE » : LE RÉPONDEUR PAR DÉFAUT, EN PRODUCTION, ESSAI RÉEL FAIT, CORRECTIFS ÉCRITS

Un agent IA qui répond à tout message que personne ne tient, comme l'agent de Meta, sans scénario du client. Cadré
avec Julien le 2026-10-04 ; spec `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`, plan
`docs/superpowers/plans/2026-10-05-repondeur-par-defaut.md`. La technique durable est dans `documentation.md` (§ 4.4,
« Le répondeur de l'espace »).

- ✅ **Livraison A en production le 2026-10-05** (`1f28aee7`, 0209 appliquée à 10 h 41 UTC AVANT le `up` de l'API
  et des deux workers, relue en base) : le réglage et son geste unique (`src/repondeur/reglage.ts`, route
  `PUT /tenants/:tenantId/agents/repondeur`, outil MCP `set_default_responder`), le scénario système caché par le
  magasin, le type de lancement `repondeur` au graphe fourni et figé, le démarreur branché dans la remise « personne ne
  suit » par une liaison tardive du socle, la mémoire de trente messages sur trente jours pour tous les agents, la
  mention d'IA sur le dernier message d'une sortie, l'événement de frise `sortie_agent`, l'alerte de crédit épuisé.
  Deux pièces que le plan ne listait pas : le message « à côté » d'un parcours qui finit va au répondeur IA
  (`confierAuRepondeur`), et un `standby` arrivé après la bascule est requalifié (`unRepondeurRepond`).
- ✅ **Relue sans rouge**, CI verte job par job, et les tests d'intégration vérifiés DANS LES DEUX SENS par deux commits
  mutés sur étiquettes jetables (quatorze mutations : chaque test visé tombe, aucun masquage). Aucun espace n'a encore de
  répondeur : rien n'a changé pour personne tant que personne ne le désigne.
- 🟡 **Jaunes de la relecture de A** (J1, J4, J6 et J7 traités dans B, ci-dessous) : (J1) une RÉACTION (pouce) du
  contact relance l'agent IA là où l'agent de Meta se tait ; (J3) la bascule depuis l'agent de Meta est synchrone
  (un appel Meta par contact de sa liste) : lire la taille de `mba_liste` de l'espace de l'essai avant ; (J4) trous de
  tests sur l'exécuteur qui confierait le « à côté » au répondeur agent de Meta allumé, et sur le câblage du worker qui
  ne nommerait pas le message déclencheur (`rendreLeFil`, `confierAuRepondeur`) ; (J5) deux résidus de double tour
  rares (lot redélivré de plusieurs messages, deux jobs parallèles du même contact) ; (J6) les contacts que Meta refuse
  de retirer de sa liste restent muets, la console B doit l'afficher ; (J7) allumer l'agent de Meta efface le répondeur
  IA sans ligne d'historique, la console B doit l'annoncer ; (J8) l'alerte de crédit marque le jour avant l'envoi ;
  (J9) la mémoire de 30 jours donne au modèle nos sortants (opérateur, campagne) en rôle agent.
- ✅ **Livraison B en production le 2026-10-05** (`8e907531`, API et deux workers relancés, aucune migration, CI verte
  job par job) : le bloc « Répondeur de l'espace » sur la
  page des agents (`web/components/RepondeurEspace.tsx` : « Aucun » ou un agent ACTIF, l'agent de Meta allumé dit avec
  un lien vers son écran, la confirmation « l'agent de Meta sera éteint pour tous vos contacts de cet espace », les
  contacts que Meta n'a pas retirés COMPTÉS) ; la désactivation et la suppression de l'agent répondeur confirmées ; les
  libellés « Le répondeur automatique prend la main » des campagnes, du widget et des publicités, qui suivent désormais
  l'agent de Meta OU l'agent IA répondeur (`repondeurAutomatique`, `web/lib/repondeur.ts`), le choix grisé « agent IA
  (à venir) » du widget retiré ; `features.md` (Agent IA, Campagnes, Publicités, Widget, MBA) et leurs cinq fiches
  d'aide, empreintes à jour. Aucune migration. Un e2e neuf (`web/e2e/agents-repondeur.spec.ts`).
- ✅ **Jaunes de A traités dans B** : (J1) une réaction ne démarre plus le répondeur (la remise passe
  `reactionsSeules`, lu sur le TYPE) et ne fait plus répondre un agent IA en pleine conversation (la porte Meta passe
  `entrant.reaction` à `WorkflowExecutor.advance`, câblé dans `src/worker.ts`) ; (J4) l'exécuteur qui confierait le
  « à côté » au répondeur agent de Meta allumé, le câblage `confierAuRepondeur` (monté et exécuté) et `rendreLeFil` du
  worker (lu dans sa source) sont tenus par des tests ; (J6) l'écran compte les contacts non retirés ; (J7) allumer
  l'agent de Meta (Accueil, paramètres, assistant) dit avant que l'agent IA quitte le rôle de répondeur. ⚠️ B touche
  donc aussi le SERVEUR (J1 dans le worker, plus deux textes de l'API : la description MCP du devenir d'un widget et
  le refus du devenir `agent`) : `up` de l'API ET des deux workers. La console n'appelle aucune route neuve (celle du
  répondeur est en production depuis A), elle peut partir avec le push.
- ✅ **B relue sans rouge, ses jaunes traités** (2026-10-05, même extraction, chacun avec son test vérifié dans les
  deux sens) : (JB1) une réaction sur un bloc agent sort SANS RIEN ÉCRIRE, l'échéance d'inactivité survit
  (`setStateSiEncoreSur` réécrit `resume_at` sans coalesce, et aucun tour ne la reposait) ; (JB2) deux tests tiennent
  la garde `reactionsSeules` AVANT la bascule `app_human -> app_workflow`, et la réaction lue au TYPE (une fiche de
  contact, une commande, un type inconnu, sans texte, démarrent le répondeur) ; (JB4, JB5) le bloc relit l'état de
  l'agent de Meta au moment d'enregistrer et après une erreur, le dit éteint sur toute réussite qui désigne un agent,
  et le choix ne part plus qu'au bouton « Enregistrer » (« Aucun » se confirme : plus aucun agent IA ne répondra) ;
  (JB3) un état illisible fait confirmer, et la phrase J7 de l'interrupteur des paramètres et de l'assistant de
  l'agent de Meta sont tenues par des e2e ; (JB6) la page MCP publique et `features.md` ne disent plus qu'un agent IA
  ne répond jamais seul ; (JB8) l'interrupteur des paramètres de l'agent de Meta est occupé dès la lecture du
  répondeur ; (JB9) le refus du devenir `agent` d'un widget ne nomme plus un scénario. Reste (JB7) : ce n'est pas une
  livraison console seule, `src/worker.ts` change (annonce aux autres sessions avant le commit, câblage partagé) et
  J1 ne vaut qu'après le `up` du worker : faire le `up` de l'API et des deux workers avant l'essai réel.
- 🟡 **Toujours ouverts de la relecture de A** : J3 (bascule synchrone ; le bouton dit seulement « Enregistrement… »
  pendant qu'elle dure), J5, J8, J9, la ligne d'historique de J7 côté serveur, RA, MX5.
- ✅ **Essai réel fait le 2026-10-05** (espace « Messaging Me Tech SANDBOX », Gan PrevMCP répondeur, téléphone de
  Julien ; détail daté dans le journal) : premier message pris en compte, retour de l'équipe puis reprise par l'agent,
  réaction sans réponse ni débit, aucun doublon de l'agent de Meta. La demande d'humain arrive dans « À traiter », mais
  seulement après deux correctifs (ci-dessous). Le répondeur est retiré et l'agent de Meta rallumé sur cet espace le
  même jour, à la demande de Julien. La mémoire de trente jours reste à vérifier lors d'un prochain essai.
- ✅ **Livraison C, les correctifs de l'essai : EN PRODUCTION le 2026-10-05** (`fad9a0c6`, API et deux workers, CI verte
  job par job, aucune migration). Méthode : en direct, chaque test vérifié dans les deux sens par mutation, une
  relecture indépendante. ✅ Essai réel fait à 15 h 21 UTC : après « Rendre la main », le répondeur répond, la demande
  de conseiller part avec sa phrase (« Je transmets ta demande à un conseiller… ») et arrive dans « À traiter ».
  (1) Désigner le répondeur laissait `mba` sur les fils que l'agent de Meta tenait : un parcours en attente gelait et
  la remise refusait l'agent IA, donc plus aucune réponse. `ControleDuFil.reprendreLesFilsDeMeta`, appelé APRÈS le
  réglage, les rend aux robots (`prise_mba` dans la frise). (2) Dans le répondeur, l'escalade jetait la phrase de
  l'agent (dans un scénario, c'est la branche `humain` qui parle ; ici rien) : `ContexteTourAgent.repondeur`, lu par
  `estRepondeur` sur le scénario du job. (3) Un `message` imposé sur l'outil d'escalade, comme sur `terminer` :
  Mistral Small escalade sans un mot 10 fois sur 10, Claude Sonnet 4.5 9 sur 10, Gemini 2.5 Flash Lite 7 sur 8 ; avec
  lui, plus aucune escalade muette. ⚠️ Le contact de Julien est revenu à l'agent de Meta : rien à réparer en base.
- ✅ **Relue sans rouge** (une relecture indépendante). Traités avant le commit, chacun avec son test vérifié par
  mutation : la lecture `estRepondeur` sort du `try` du cerveau (un raté de la base fait rejouer le job au lieu de
  sortir par `echec`) ; le `message` de l'escalade ne promet plus un conseiller quand l'équipe est fermée (remesuré :
  aucune escalade muette sur Mistral Small ni Claude Sonnet 4.5) ; le test des paquets compte ses lectures ; un
  identifiant de message libre dans le test d'intégration.
- 🟡 **Jaunes ouverts de la relecture de C** : (JC3) re-désigner le même agent ne relance pas la reprise des fils, et
  `fils` ne remonte ni à l'écran ni à l'outil MCP (le balayage de 24 h les rend de toute façon) ; (JC6) un fil `mba`
  dont le dernier message est ENTRANT sort d'« À traiter » à la reprise, sans réponse tant que le contact ne réécrit
  pas (décision produit : le donner à l'équipe ?) ; (JC7) aucun test du lien réel entre `systeme = 'repondeur'` et
  `estRepondeur` (lambda du worker), l'annonce d'IA sur le `message` d'une escalade l'étant depuis le 2026-10-05 ; (JC8) le bac à sable simule
  l'escalade sans rendre la main, il ne montre donc pas la phrase que le contact du répondeur recevrait.
- ❌ **Abandonné, mesure à l'appui** : une phrase de consigne « passe la main par l'outil d'escalade, jamais par une
  règle d'arrêt » (l'agent était sorti par la règle « Passage à un conseiller humain » de sa fiche, retirée depuis).
  Ce choix arrive 1 fois sur 48 sur Gemini 2.5 Flash, et la phrase faisait INVENTER des noms d'outil à Flash Lite
  (`escalader_humain`). Reste un conseil de fiche : pas de règle d'arrêt qui passe la main à un humain.
- ✅ **Tranché par Julien le 2026-10-05 : les agents créés par Claude Code passent sur Claude Haiku 4.5**
  (`MODELE_AGENT_CLAUDE_CODE`, l'outil MCP `create_agent`), Gan PrevMCP aussi ; la console garde son défaut, son
  client choisit le modèle. Mesuré sur la qualification de Gan PrevMCP (5 essais par situation) : Haiku cherche dans
  la connaissance avant de répondre, ferme chaque sortie et escalade sans fausse promesse ; Gemini 2.5 Flash répond de
  mémoire, ferme « hors cible » 3 fois sur 5 et promet un conseiller sans le prévenir 3 fois sur 5. Environ quatre
  fois le prix par appel. Le défaut, mesuré avant la décision : Sur la même demande « je veux parler à un conseiller », le modèle
  écrit « un conseiller va prendre le relais » SANS appeler aucun outil : personne n'est prévenu. Mesuré sur 10 appels :
  GLM 4.7 Flash 7, Gemini 2.5 Flash 3 (2 à 6 selon les passes), GPT-4.1 mini 1, Gemini 2.5 Flash Lite 1, Claude Haiku
  4.5, Claude Sonnet 4.5 et Mistral Small 0. Une consigne plus ferme n'y change rien (4 sur 20 contre 5 sur 20). Défaut
  de TOUS les agents IA, pas seulement du répondeur.
- 🟡 **L'Inbox dit « agent Meta » quand c'est l'agent IA qui a la main** (remarque de Julien pendant l'essai). Pendant
  l'essai, c'était vrai de notre colonne (défaut 1) ; une fois réparé, le libellé doit dire « agent IA » quand le
  répondeur IA tient le fil.

## LOT 8a DE « MESSAGING ME POUR CLAUDE CODE » : LES OUTILS MCP DE L'AGENT IA ET DU CRÉDIT, EN PRODUCTION, ESSAI RÉEL FAIT

Spec `docs/superpowers/specs/2026-10-03-mcp-agent-ia-design.md`, plan `docs/superpowers/plans/2026-10-03-mcp-agent-ia.md`.
La technique durable est dans `documentation.md` (§ 7, « Les outils MCP de l'agent IA et du crédit »), le
fonctionnel dans `features.md` (« Construire un agent IA depuis Claude »).

- ✅ **Livraison A relue (aucun rouge) et en production** (`b1b4c034`, 0206 appliquée avant le `up`) : la logique de
  l'agent, de sa connaissance, du bac à sable et du paiement sortie des routes (`src/agent/gestion.ts`,
  `connaissance.ts`, `essai.ts`, `reglages.ts`, `src/stripe/paiement.ts`), le contrôle de complétude sur la
  modification d'un agent actif, la ligne `fiche_agent` de l'historique, et la migration 0206 (origine `mcp`).
- ✅ **Livraison B écrite, à relire** : les outils de l'agent IA et du crédit (`src/mcp/outils-agent.ts`), le drapeau `exigePersonne`
  (`outilsPour`), le plafond coûteux de la console posé dans le MCP par `buildServer`, la sonde 15 de
  l'auto-attaque, la page « Serveur MCP » et la page « Autoriser » qui disent ces outils, l'historique qui affiche
  « par Claude », et trois jaunes de la relecture de A (le 422 d'un agent actif lisible dans la console, les textes
  de l'historique, le caractère nul refusé par l'import d'un texte et sa découpe sous l'échéance d'un fichier).
  Aucune migration.
- ✅ **Relecture indépendante de B : aucun rouge.** Corrigés avant le commit, chacun avec son test vérifié dans les deux
  sens : les descriptions d'`activate_agent` et d'`update_agent` disent que désactiver COUPE l'agent dans ses
  scénarios publiés et ne se fait que sur demande explicite (sinon un refus poussait Claude à le faire de lui-même) ;
  le test des sept outils coûteux vérifie que rien n'est touché quand le plafond refuse (il ne le tenait que pour deux) ;
  `list_knowledge` dit que ses extraits sont des données de tiers ; le refus du caractère nul est annoncé ; la garde de
  personne échoue fermée sur `undefined` ; la page « Autoriser » nomme les gestes sur la connaissance.
- ✅ **Livraison B en production le 2026-10-04** (`5b6f4a1f`, `mba-api` seul, workers inchangés ; la console avec le
  push). Mesuré en production avec la clé de lecture du poste : 12 outils (les 8 d'avant, plus `list_agents`,
  `get_agent`, `list_knowledge`, `get_credit`), aucun outil réservé à une personne, `create_agent` refusé comme un
  outil inconnu, `get_credit` et `list_agents` répondent.
- ✅ **Essai réel du 2026-10-04, vers 12 h 37 UTC, par Julien**, depuis une session Claude Code neuve connectée par
  OAuth (29 outils) : l'agent « Gan PrevMCP » monté de bout en bout par Claude (`create_agent`, `preview_site`,
  `update_agent`, `set_agent_tools`, `import_site`, douze `test_agent`, `activate_agent`). Relu en base, en lecture
  seule, juste après : la fiche et le modèle tels que Claude les a posés ; 150 fiches de connaissance, 22 pages,
  provenance `page` avec leur adresse, toutes vectorisées ; les quatre outils actifs, signés par l'admin ; quatre
  lignes `fiche_agent` d'origine `mcp` avec leur auteur, l'activation comprise ; douze essais, chacun débité de son
  coût exact au prix client, note « essai depuis le serveur MCP » (2,9 centimes au total). La création elle-même ne
  laisse pas de ligne, comme dans la console.
- ✅ **Corrigé et en production le 2026-10-04 : une sortie part avec son dernier message.** L'essai avait trouvé que sous
  GPT-5 mini l'agent appelait `mba_terminer` sans écrire (5 sorties sur 5 muettes). `terminer` porte désormais le
  paramètre imposé `message` (`2674276b`, relu sans rouge), dont la description demande un message toujours rempli
  (`866aae5c`, après un premier essai où le lead qualifié partait encore vide). Essai réel sous GPT-5 mini sur Gan
  PrevMCP, avec l'accord de Julien : 3 sorties sur 3 avec leur message, récapitulatif compris ; sous Gemini, le texte
  écrit part seul, sans doublon. Puis **GPT-5 mini a quitté la liste des modèles** (`1351821d`, aucun agent ne
  l'utilisait) : 2,5 fois le coût de Gemini 2.5 Flash à l'essai, pour un tarif affiché plus bas.
- 🟡 **Restes de la relecture de ce correctif** : un dernier message refusé à l'envoi fait
  sortir par « échec » et perd la règle d'arrêt (déjà vrai pour un texte écrit) ; le texte écrit à côté d'un appel qui
  sort n'est pas passé à `ressembleAUnBlocOutil`, seul le message de repli l'est.
- 🟡 **Ouverts, hors de ces deux livraisons** : l'assistant de construction journalise ses propositions « depuis les
  onglets » (il passe par la même route) ; chaque modification de la fiche d'un agent actif relit toutes ses fiches
  de connaissance (`etatPourLint`, un compte suffirait) ; `ajouterFiches` n'est pas atomique (un agent qui disparaît
  au milieu laisse les premières fiches) ; un changement de statut est journalisé sous `fiche_agent` et pas
  `activation` ; les lignes `fiche_agent` repoussent plus vite les suppressions hors des 200 lignes affichées ;
  `list_agents` relit toutes les fiches de chaque agent pour les compter ; les refus de bornes de `modifierAgent`
  nomment les champs de la console (`contenu.objectif`) et pas ceux de l'outil ; `src/mcp/outils-agent.ts` importe une
  constante de `src/http/agents` ; sur une erreur qui n'est pas un 422 (verrou, 400), l'écran des agents laisse sa
  liste de manques vide (antérieur à B).

## OAUTH DEVANT `/mcp` (LOT 2 DE « MESSAGING ME POUR CLAUDE CODE ») : EN PRODUCTION, ESSAI RÉEL FAIT DEPUIS CLAUDE CODE

- ✅ **Essai réel du 2026-10-03, vers 20 h 30 UTC, par Julien, depuis Claude Code 2.1.257 sous Windows** :
  `api.messagingme.app/mcp` ajouté sans clé, `/mcp`, Authenticate, page « Autoriser », retour vers Claude Code, et
  Claude liste les conversations ; révocation depuis « Applications autorisées », Claude redemande la connexion.
  L'adresse de retour `http://localhost` passe le proxy NPM (Claude encode ses paramètres). Puis depuis l'app de
  bureau (onglet Code) : le serveur apparaît dans `/mcp` (seul, sans nom) dans une NOUVELLE session, « Connecter »
  ouvre la page « Autoriser », et Claude lit les conversations ; le jeton du terminal est partagé avec l'app.
- ⚠️ **Deux frictions du poste, pas du serveur, à écrire dans la FAQ du plugin (lot 10)** : PowerShell refuse
  `claude.ps1` quand l'exécution de scripts est désactivée, et `claude.cmd` passe sans toucher à ce réglage ; Claude
  Code n'a pas ouvert le navigateur tout seul, il a fallu copier le lien qu'il affiche ; dans l'app de bureau, un
  serveur ajouté pendant une session n'apparaît qu'à la session suivante, et `/mcp <nom>` n'est pas une commande
  (`/mcp` seul ouvre le panneau, avec « Connecter »).
- ⏳ **Reste à essayer** : une adresse Google jamais vue qui crée son espace ; le même serveur en connecteur dans
  claude.ai ; et une connexion qui dure plus d'une heure (le renouvellement du jeton, et le jaune des deux
  renouvellements simultanés).


Spec `docs/superpowers/specs/2026-10-03-oauth-mcp-design.md`, plan `docs/superpowers/plans/2026-10-03-oauth-mcp.md`.
La technique durable est dans `documentation.md` (§ 7, « L'OAuth devant `/mcp` »).

- ✅ **2a écrite (tâches 1 à 8)** : migration 0204 (`oauth_autorisations`, `oauth_codes`), le noyau `src/oauth/`, la
  garde de `/mcp` qui accepte un jeton `mbo_`, le 401 qui annonce la connexion, les routes `/oauth/*` et le
  consentement (`src/http/oauth.ts`, `src/http/oauth-consentement.ts`), la purge `retention-oauth`, le script
  `npm run oauth:fiches` (les deux fiches de Claude relues CONFORMES le 2026-10-03). Tests unitaires et auto-attaque
  verts ; les tests d'intégration du magasin ne tournent qu'en CI.
- ✅ **Relecture indépendante de 2a : aucun rouge.** Corrigés dans le lot, chacun avec son test vérifié dans les deux
  sens : une réponse de Claude signée d'une personne restait comptée comme humaine par l'analyse et comme une
  sollicitation par le bilan du contact ; la ressource d'un renouvellement n'était tenue par aucun test ; deux
  clés étrangères de 0204 sans index ; une phrase fausse de `documentation.md` sur les 5xx de `/oauth/token`.
- 🟡 **Ouverts** : deux renouvellements SIMULTANÉS du même jeton révoquent l'autorisation (à observer à l'essai
  réel, une fenêtre de grâce sinon) ; un code présenté deux fois est refusé sans révoquer l'autorisation (OAuth 2.1
  le recommande) ; chaque jeton d'accès neuf coûte une unité du budget des empreintes inconnues de chaque copie ;
  la liste « Applications autorisées » montre encore celles d'un admin rétrogradé (elles ne marchent plus).
- ✅ **2a déployée le 2026-10-03** (`0a399f9a`) : 0204 appliquée à 16 h 27 UTC et relue en base, `mba-api` et les
  deux workers reconstruits, NPM rechargé, les trois portes à 200, `npm run oauth:fiches` CONFORME. CI verte, et un
  commit faussé jetable (lecteurs « humain » et rejeu défaits) l'a vu rouge sur ces seuls tests.
- ✅ **Les trois mesures, depuis l'extérieur** : `/.well-known/oauth-authorization-server` porte les en-têtes de l'API
  (pas une 404 de NPM), sans `registration_endpoint` ; `POST /mcp` sans jeton rend 401 avec `www-authenticate` sur
  `api.` et sans lui sur `mba.` ; `/oauth/token` rend 400 `invalid_grant` à un client en ligne de commande (Cloudflare
  laisse passer). `/oauth/authorize` encodé comme Claude l'envoie : 302 vers `engageme…/autoriser` ; client inconnu :
  400 en texte, sans redirection.
- ⚠️ **NPM refuse en 403 (« openresty ») une adresse `http://` écrite EN CLAIR dans la requête** (sa protection contre
  les exploits courants) : `?redirect_uri=http://localhost…` non encodé ne parvient jamais à l'API. Claude encode ses
  paramètres, donc rien ne casse ; à confirmer à l'essai réel.
- ⚠️ **Entre 2a et 2b, la page de consentement n'existe pas** : une connexion lancée depuis Claude arrive sur une 404
  de la console. Personne n'est branché sur cette adresse sans clé, donc personne n'est touché.
- ✅ **2b (la console)** : la page `/autoriser` (consentement par Google ou par la session de la console, admin
  seulement, départ vers la seule adresse rendue par l'API et vers l'hôte affiché) et « Applications autorisées »
  sur la page des clés. Relecture : aucun rouge ; corrigé dans le lot, une réponse sans la liste qui emportait toute
  la page des clés. `npm run aide:charger` sur le VPS (la fiche `retrouver-qui-a-fait-quoi` a changé d'empreinte).
- 🟡 **Ouverts de la 2b** : l'e2e « Google ne pose aucune session de la console » lit le stockage APRÈS le départ
  vers Claude, donc il ne vérifie rien (à relire juste après le clic Google) ; la liste d'espaces recopie celle de la
  page de connexion au lieu d'être partagée, et `fmt` est recopié dans la page des clés ; un admin à mot de passe
  connecté sur un autre espace ne voit pas qu'il doit se reconnecter ; le bouton direct disparaît sans explication
  si la lecture du nom de l'espace échoue ; la mention « Il sera créé avec votre adresse Google » reste affichée si
  Google est éteint ; la page « Serveur MCP » ne parle encore que de la clé (à réécrire après l'essai réel).
- ⏳ **L'essai réel qui clôt le lot** (spec, section 8) : Claude Code sur le poste de Julien, `https://api.messagingme.app/mcp`
  ajouté SANS clé, Google, « Autoriser », lecture d'un fil ; révocation depuis la console, nouvelle connexion exigée ;
  une adresse Google jamais vue qui crée son espace ; le même serveur en connecteur dans claude.ai.
## LES ENVOIS D'UN BLOC SORTIS DU CÂBLAGE (DÉPLOYÉ LE 2026-10-03 À 11 H 46 UTC ; ESSAI RÉEL FAIT)

- ✅ Refactor à comportement identique, plan `docs/superpowers/plans/2026-10-03-envois-de-bloc.md` : les quatre
  envois WhatsApp d'un bloc de scénario vivent dans `src/workflow/envois-bloc.ts` (`cdcbde3e`), exécutés par leurs
  tests. Relecture : 0 rouge, 4 jaunes, poussés après le déploiement (`e253e4a5`). **Essai réel fait le 3 à
  16 h 38** (journal du 2026-10-03) : les quatre envois partis, journalisés et routés.
- ⏳ **L'agent de Meta a envoyé son message de passage à un contact ABSENT de sa liste**, juste après un modèle
  (essai du 3 à 16 h 38, une seule occurrence, journal du 2026-10-03). Deux essais suivants (16 h 53 et 16 h 54,
  réponse au modèle par un bouton puis par du texte) : l'agent n'a rien dit. Occurrence isolée, à surveiller.

## UN SEUL GESTE « POSER UNE ÉTIQUETTE » (DÉPLOYÉ LE 2026-10-04 ; ESSAI RÉEL FAIT ; JAUNES POUSSÉS)

- ✅ Piste 6 du rapport d'architecture du 2026-10-02, plan `docs/superpowers/plans/2026-10-04-poser-une-etiquette.md`.
  Cinq portes passent par `src/crm/poser-etiquette.ts` (`93e321b5`, CI verte job par job) ; l'outil MCP coupe à 64
  et déclare, la fiche déclare. Relecture : 0 rouge, 7 jaunes, dont deux corrigés après le déploiement, les autres
  au backlog (`todo.md`, piste 6). API et workers à 14 h 15 UTC.
- ✅ **Essai réel du 4 vers 16 h 35 (Paris)**, relu en base : par Claude (aucune publication), par la fiche
  (publiée), par un scénario lancé depuis l'Inbox (publiée) ; les trois dans Contenus > Étiquettes. Récit au journal.

## UN POINT D'ENTRÉE PAR TYPE DE LANCEMENT DE SCÉNARIO (DÉPLOYÉ LE 2026-10-04 ; ESSAI RÉEL FAIT ; JAUNES POUSSÉS)

- ✅ Piste 4 du rapport d'architecture du 2026-10-02, plan `docs/superpowers/plans/2026-10-04-lancements-de-scenario.md`.
  Les sept lancements passent par `src/workflow/lancements.ts`, comportement identique (`b6e674ac`, CI verte job par
  job). Relecture : 0 rouge, 4 jaunes, poussés après le déploiement. API puis workers (12 h 31 UTC, avec l'accord de
  Julien pour les jaunes pg-boss d'une session voisine qu'ils emportaient).
- ✅ **Essai réel du 4 entre 14 h 42 et 14 h 45 (Paris)**, relu en base : Inbox, lien de test (graphe figé), mot-clé,
  campagne vers un seul numéro ; chacun a fait la même chose qu'avant. Récit au journal du 2026-10-04.

## UNE SEULE TRANSITION DE CONSENTEMENT (DÉPLOYÉ LE 2026-10-04 ; ESSAI RÉEL FAIT ; JAUNES POUSSÉS)

- ✅ Plan `docs/superpowers/plans/2026-10-03-transition-consentement.md`, cadrage en trois rondes avec Julien.
  Serveur `1c4df5ec` (API et deux workers à 8 h 45 UTC, CI verte job par job, intégration comprise), console
  `a34c88c3` poussée APRÈS le `up` (l'écran annonce que la masse garde les STOP). Relecture : 0 rouge, 6 jaunes.
- ✅ **Essai réel du 4 vers 10 h 52 (Paris)**, sur la fiche de Julien : désabonnement par la fiche ; action en masse
  « Passer en opt-in » : STOP gardé, journal `affected 0, stopsGardes 1`, date du refus inchangée, l'écran a dit
  « 1 fiche a gardé son STOP » ; réabonnement par la fiche : passé.
- ✅ Décision de Julien après coup : un refus venu de l'API publique reste annoncé au client (pas d'exception à la
  création ; aucun chemin ne crée une fiche directement `opted_out`, mesuré).
- ✅ **Les six jaunes, poussés (`87931675`, CI verte job par job, intégration comprise)** : une phrase unique « qui
  lève un STOP » (`quiLeveUnStop`) qui dit les quatre chemins, à l'écran, dans `features.md` et la fiche
  `importer-mes-contacts` ; commentaires de création corrigés ; `applyEdits` rend `consentementChange` et la route
  ne journalise qu'alors ; `tenant_id` reposé dans la CTE `ecrit` sur le paramètre que chaque écriture désigne ;
  cas de table ajoutés, cas « gardé » des upserts ancrés sur une preuve. La console (texte seul) est publiée ; le
  serveur part au prochain `up` (celui du lot des lancements), et la relecture de ce lot les couvre.
- ⏳ **Même défaut ailleurs, relevé en passant** : `src/webhooks/flow-mapping.ts` journalise `contact.optin` dès que
  `markOptedIn` rend un identifiant, même si le statut était déjà en place (un formulaire coché deux fois laisse deux
  traces).

## « TESTER LE SCÉNARIO » NE MARQUE PLUS LA CONVERSATION (DÉPLOYÉ LE 2026-10-03 ; ESSAI RÉEL FAIT)

- ✅ Décision de Julien (« ne mets plus jamais un flag test sur ma conversation »), plan
  `docs/superpowers/plans/2026-10-03-lien-de-test-sans-marquage.md`, `0c4e2099` ; ses jaunes (`70613288`, dont la
  relecture du détenteur avant de confier) en production sur les workers depuis 15 h 50 UTC. La conversation de
  Julien a été démarquée à la main le 3.
- ✅ **Essai réel du 3 à 19 h 40 (Paris)** : test lancé par le lien, message rapide, réponse en texte libre
  (« Tu es là MBA ? ») : le parcours s'arrête, la conversation est rendue à l'agent, `agent_event` accepté, l'agent
  répond 23 s plus tard. Conversation non marquée.
- ✅ **Modèle PUIS texte libre : l'agent répond aussi** (23 h 01, après « Reprendre la main »). Deux refus de Meta
  plus tôt dans la soirée restent inexpliqués (`todo.md`). **Parade pour la démo du 7 : « Reprendre la main » sur la
  conversation juste avant de lancer le scénario.**
- ⏳ **Le mot du lien reçu par l'agent de Meta** (vu le 3 à 19 h 38, revu cinq fois le 6 sur SANDBOX avec Geoffrey) :
  si l'agent tient la conversation, Meta lui donne le mot `test-…` ; le test lui reprenait le fil en plein tour, et
  son message de passage tombait 13 à 23 s plus tard au milieu du scénario. Correctif du 6 (`src/mba/lien-de-test.ts`) :
  consigne « Je lance le test. » par `agent_event`, attente de son écho (40 s au plus, hors du job du webhook, l'écho
  passant par la même file groupée par contact), puis lancement. **Essai réel dû** : lien de test sans « Reprendre la
  main », conversation chez l'agent ; lire `lien-de-test:` dans le journal du worker. ⚠️ Inconnue à mesurer : l'agent
  peut répondre DEUX fois (au mot, puis à la consigne) ; le second tour serait alors coupé, et son message de passage
  reviendrait. Si c'est le cas, retirer la consigne et garder l'attente seule.

## DOUBLE WORKER, BANCS, CLÉ D'IDEMPOTENCE, POOLS (TOUT DÉPLOYÉ LE 2026-10-03 ; ESSAI RÉEL FAIT)

Plan `docs/superpowers/plans/2026-10-02-deux-workers-et-banc-deux-api.md`, décidé par Julien le 2026-10-02.

- ✅ **En production** : `mba-worker` au rôle `principal` (7 files : webhooks, campagnes, scénarios, tours d'agent,
  opt-out, signaux), `mba-worker-analyse` au rôle `analyse` (3 files : `analyze-conversation`, `push-analysis`,
  `hubspot-catchup`). Les 10 ensemble, sans recouvrement, lu dans leurs journaux de démarrage.
- ✅ **Un battement par rôle**, depuis deux conteneurs distincts, relu en base après 0202 ; l'ancienne ligne
  `worker` a disparu. `/ops` expose `workers`, la console une ligne par rôle (et lit encore l'ancienne forme).
- ✅ **Déployé en deux temps** (principal, puis analyse) à cause du plafond de 15 sessions du pooler : aucun
  `EMAXCONNSESSION`. Cinq portes publiques à 200.
- ✅ **Le banc à deux copies d'API** est vert sur ses trois propriétés (clé acceptée des deux côtés, clé révoquée
  refusée par les DEUX, plafond par espace GLOBAL : 54 acceptés contre 76 refusés sur 130 tirs, plafond 60). Il a
  été DÉMONTÉ du VPS le 2026-10-03 ; la recette pour le remonter est en tête de `scripts/banc-deux-api.mts`.
- ✅ **L'ESSAI RÉEL EST FAIT** : le message WhatsApp de Julien traité par le principal (webhooks à 9 h 50 UTC le
  2026-10-03), son analyse par le worker d'analyse (job pris à 10 h 54 min 57, fini à 10 h 55 min 24 : sentiment
  négatif, SAV, satisfaction 3/10, urgence 6/10, « escalader »), puis poussée vers HubSpot. L'analyse ne part qu'après
  25 minutes SANS message sur la conversation (`CONVERSATION_INACTIVITY_MS`), à compter du DERNIER message.
- ✅ **Les cinq jaunes de la relecture** : corrigés (`8b37a1ba`) et déployés le 2026-10-03 à 10 h 18 UTC (les deux
  workers seulement). Vérifié en production : le principal rejoue les agrégats au démarrage, l'analyse non ; les
  attentes de pool arrivent sous `worker-principal` et `worker-analyse` ; deux battements frais ; portes à 200.
- ✅ **Le second banc à deux copies d'API a tourné le 2026-10-03** (`scripts/banc-deux-api-2.mts`, démonté
  ensuite) : idempotence entre copies, arrêt propre, webhooks sous pression de pool et connexions par copie
  VERTS ; l'arrêt BRUTAL laissait la clé d'idempotence « en cours » 24 h dans 3 cas sur 5.
- ✅ **La clé coincée est corrigée et DÉPLOYÉE** (`0c476865`, le 2026-10-03 à 11 h 46 UTC, avec la migration 0203
  appliquée avant et le lot `cdcbde3e` d'une session voisine dans le même `up`) : bail de 5 min et jeton de garde.
  Relue sans rouge, CI verte job par job, et l'essai réel fait au banc (clé coupée en 409, puis 201 une fois le bail
  passé, aucune orpheline lancée). Ses deux jaunes de comportement sont traités et DÉPLOYÉS (`f74ebb59`, `mba-api`
  seul, le 2026-10-03 à 14 h 59 UTC) : création et scellement dans UNE transaction, bail limité au même corps.
  Relus sans rouge, prouvés en base (atomicité comprise) et rejoués au banc, zéro campagne orpheline.
- ✅ **Les pools sont dimensionnés par copie, et DÉPLOYÉS** (`f4eec9f2`, `mba-api` recréé à 15 h 49 UTC, `DB_POOL_MAX=10` relu dans le conteneur ; 2026-10-03) : le « Pool Size » du pooler Supabase monté de 15 à 30
  par Julien (mesuré : 31 connexions simultanées, contre 16), chaque service fixe son `DB_POOL_MAX` dans le compose
  (API 10, principal 8, analyse 3), et `tests/budget-pooler.test.ts` refuse tout compose qui dépasse le budget.
- ⏳ **Ce qui reste avant d'autoriser l'autoscaling** : le répartiteur et la capacité, **sur Scaleway** (décision de
  Julien du 2026-10-03 : pas de seconde copie fixe sur le VPS, où des copies ne créeraient aucune capacité ; le
  répartiteur viendra avec les conteneurs serverless, minimum 1 copie). Deux faits mesurés pour ce jour-là : sur
  la base Micro actuelle, le budget du pooler plafonne à DEUX copies d'API de 8 connexions (27 avec les workers,
  la limite exacte des 80 % ; `tests/budget-pooler.test.ts` refuse au-delà) ; et le VPS aurait eu la place (16,8 Go
  libres, 160 Mo par copie), l'API n'ayant qu'une tâche périodique, déjà prévue pour plusieurs copies. La liste
  complète est dans `docs/ARCHITECTURE-CIBLE.md` (en tête, et §10).
- ✅ **Plus de 502 durable après un `up`** (2026-10-03) : les quatre routes de `mba.` (hôte NPM 21) nomment `mba-api`
  par une variable ; essai réel, 4 à 5 s de 502 pendant le redémarrage puis 200, sans recharger NPM.
- ✅ **La migration 0060 vérifiée** (2026-10-03) : ancien nom de `0062_email.sql`, SQL identique, en `if not exists`.

## PROCHAIN : CE QUI RESTE DE L'AUDIT DE PERFORMANCE DU 2026-10-02 (`docs/prive/AUDIT-PERFORMANCE-COMPLET-2026-10-02.md`)

Déjà fait : la preuve à deux copies (deux bancs), le budget de connexions (test, Pool Size 30), les deux workers et
leur battement par rôle, le cache Cloudflare du widget, le document de bascule. Ce qui reste, dans l'ordre recommandé
à Julien le 2026-10-03 (il a demandé de compacter avant de commencer le 1) :
1. ✅ **La latence HTTP par route** (2026-10-03) : déployée à 20 h 33 UTC (`22d01fe4`, migration 0205), essai réel
   fait en base (dix lignes du vrai trafic, aucune adresse réelle). Les jaunes de sa relecture sont poussés
   (`b1d3bc8a` : l'abandon par le client mesuré en 499, le rouge réservé aux webhooks et lectures de l'Inbox, un
   plafond de lignes, l'écriture triée, un vidage final), déployés à 20 h 47 UTC (`f7e9acd0`) ; l'écriture a continué à
   travers le redémarrage. Reste à Julien : ouvrir `/ops` et voir la carte. Le reste du § 11 de l'audit (CPU, mémoire et redémarrages par conteneur, connexions côté pooler
   et Postgres, durée des gros balayages, volume des fichiers en base) n'est pas fait.
2. ✅ **Le banc des trente espaces** (2026-10-03, recadré par Julien : 30 espaces de 2 personnes et 10 conversations,
   pas un client à 30 agents) : `charge` vert avec une marge énorme (p95 de l'Inbox 54 ms pour un seuil de 800, zéro
   attente du pool de l'API, 600 messages du pic écrits en 366 ms au pire) ; `crash` et `arret` sans perte ni doublon.
   Deux défauts trouvés, CORRIGÉS ET DÉPLOYÉS le 2026-10-04 (`933557b7`, puis ses jaunes) : le message en cours lors
   d'un crash repart en 29 s (contre 932), une rafale de 120 messages passe en 8,6 s (contre 67). Ce qui reste est
   dans `todo.md`. Les jaunes (`59ec71e2`) sont partis avec le redémarrage des workers sur `b6e674ac` ; relu en base
   juste après (battement à 20 s sur les dix files, rejeu à 10 s sur `webhook`, moniteur à jour). Le banc a été
   DÉMONTÉ du VPS le 2026-10-04 ; la recette pour le remonter est en tête de `scripts/banc-trente-espaces.mts`.
3. ✅ **Au plus DIX clés d'API actives par espace** (Julien a remonté le chiffre de 5 à 10 le 2026-10-04) : la
   onzième refusée en 409, la clé du relais de l'agent de Meta et les révoquées non comptées, le bouton grisé dans
   la console. Mesuré avant : un seul espace a des clés (2 actives), personne n'est au-delà. Test d'intégration
   prouvé dans les deux sens sur un Postgres jetable. Relu sans rouge, commité en `92652e5c`, CI verte job par job,
   `mba-api` seul déployé le 2026-10-04 à 13 h 38 UTC, fumée verte, essai réel en production fait (sans écriture).
4. ✅ **Le lot observabilité** (2026-10-04, décidé par Julien) : ferme les deux critères de sortie non tenus de l'audit.
   Alerte Telegram quand un worker se tait OU redémarre en boucle (surveillance dans l'API) ; durée, lignes, échecs et
   tours sautés de chaque tâche de fond (migration 0207, carte de `/ops`) ; octets en base, fichiers compris
   (`GET /ops/stockage`, carte de `/ops` ; mesuré le 2026-10-04 : base de 45 Mo, dont 10 Mo pour 28 images RCS) ; les
   six passages « deux copies au plus » d'`ARCHITECTURE-CIBLE.md` ; le compteur « n sur 10 » des clés. Relu sans
   rouge, ses jaunes réglés dans le lot. EN PRODUCTION depuis le 2026-10-04 à 16 h 51 UTC (`e6711818`, migration 0207
   appliquée avant le `up`, CI verte job par job, e2e complet vert). Essai réel fait : `mba-worker-analyse` arrêté à
   16 h 53, alerte Telegram à 16 h 56 min 37 s, retour à 16 h 57 min 40 s, les deux acceptés par Telegram (verrous lus
   en base). Ce qui reste est dans `todo.md`.
5. **mm-hubspot sur sa propre base : décidé par Julien le 2026-10-04, CHEZ SCALEWAY, EN PREMIER**, comme répétition
   quelques jours avant le jour J de Messaging Me, jamais le même jour (`docs/ARCHITECTURE-CIBLE.md` §8 et §10 étape 0).
   Préalable, en lot à part : remplacer la lecture cross-schéma de `mmhs` (`getHubspotPortal`) par un appel au
   connecteur ; sans lui, l'interrupteur HubSpot affirmerait en silence qu'aucun portail n'est relié.
6. **Les médias RCS hors de Postgres : APRÈS la bascule Scaleway**, en lot séparé (décidé le 2026-10-04, §6). Leur
   volume est suivi dans `/ops` (10 Mo aujourd'hui, rouge à 500 Mo).
7. ✅ **Les quotas par espace de l'API publique : tranchés par Julien le 2026-10-04, EN PRODUCTION le 2026-10-05**
   (`fb070954`, 0208 appliquée avant le `up` de l'API, essai réel concluant : récit au journal ; relus sans rouge, usage
   réel mesuré avant : au plus 4 destinataires par jour ; restes dans `todo.md`). Par espace et par
   jour (minuit, heure de Paris) : 2 000 envois et 20 000 fiches écrites par l'API, réglables par espace depuis
   `/ops`, refus 429 lisible ; lectures et MCP sous le plafond d'appels ; compteur en panne, l'appel passe avec une
   alerte (§13.1).
Le reste de l'audit (équité des campagnes, agrégats, Redis, temps réel, troisième worker) attend un seuil mesuré.

## L'AGENT DE META POUR LA DÉMO DU MERCREDI 7 OCTOBRE (TROIS LOTS DÉPLOYÉS LE 2026-10-02 ; ESSAIS RÉELS DUS)

Le fonctionnel est dans `features.md` (section « MBA, le répondeur de Meta » et onglet « Outils »), le récit dans le
journal du 2026-10-02, les restes dans `todo.md`. Ce qui reste EN COURS, ce sont les essais réels, faits par Julien :

- ✅ **Le message de passage en français** : déployé (console seule).
- ⏳ **Le plafond** (Activation, en bas) : poser un petit plafond en jetons, écrire depuis un téléphone, vérifier ce
  que Meta documente (au plafond, l'agent finit son tour puis passe la main à un humain), puis le retirer.
- ⏳ **Le message de passage** : demander un humain depuis un téléphone, et lire le message reçu (en base :
  `conversation_messages.origin = 'mba'`). Le bac à sable ne le montre pas (mesuré le 2026-10-02).
- ⏳ **La carte « Agent de Meta »** de Performance Lab > Synthèse : la lire sur l'espace MessagingMe.
- ✅ **Les outils MCP** : ÉPROUVÉS le 2026-10-02 au soir sur le numéro MessagingMe. Microsoft Learn (exemples de
  code, `ok` en 0,9 s), puis le serveur MCP de Messaging Me : `get_contact`, le numéro posé par la console
  (`contact` / `wa_id`), a lu la fiche de Julien ; une question sur un autre numéro a été refusée par l'agent,
  sans appel. Trois défauts trouvés en route, corrigés et déployés le soir même (journal du 2026-10-02).
- ⏳ **Une compétence « Périmètre »** à poser sur l'agent (Julien) : périmètre = l'activité ET tout ce que ses
  outils permettent, sinon il répond à tout (il a donné du code Azure de mémoire quand l'outil a échoué). Puis
  retirer l'outil Microsoft.
- ✅ **La règle unique du catalogue d'outils** (plan `docs/superpowers/plans/2026-10-02-catalogue-regle-unique.md`) :
  déployée dans la nuit du 2 au 3 octobre, **essai réel fait le 3 à 12 h 26** (journal du 2026-10-02 et 03) :
  `get_contact` proposé, réglé, publié puis appelé avec succès par l'agent de Meta. ⚠️ Effet voulu mais à savoir : un
  appel de connecteur dont le système est en brouillon ne s'active plus, donc ne s'essaie plus au bac à sable.
- ⏳ **Remplacer la clé `mba_HZak…`** (écrite en clair dans une conversation le 2026-10-03) : elle sert À LA FOIS au
  connecteur « Serveur Messaging ME MCP » de l'espace de démo et à Claude Code (`~/.claude.json`, serveur `mba`). Les
  deux se changent ensemble, sinon ils cassent ensemble.
- ⏳ **Après le lot 1 du serveur MCP (autre session)** : l'annonce des douze outils change (annotations, bornes), donc
  le premier rafraîchissement du connecteur marquera `get_contact` modifié et l'éteindra pour l'agent de Meta. Le
  revalider, puis republier l'agent.

## WIDGET WHATSAPP (LOTS 1 À 5 DÉPLOYÉS DANS LA NUIT DU 2 AU 3 OCTOBRE ; ESSAI RÉEL DÛ)

Le fonctionnel est dans `features.md` (section « Widget WhatsApp »), la technique dans `documentation.md` (§4.1 et
bloc « Widgets »), le récit dans le journal du 2026-10-02 et 03, les jaunes ouverts dans le plan
(`docs/superpowers/plans/2026-10-02-widget-whatsapp.md`, « Ce qui reste »). Ce qui reste EN COURS :

- ⏳ **Le passage sur l'écran** (Julien) : créer un widget, l'éteindre, copier la balise, modifier un widget dont le
  scénario a été supprimé. Personne n'a encore cliqué.
- ⏳ **L'essai réel qui clôt la feature** : ✅ la balise sur un vrai site (l'accueil de la vitrine depuis le
  2026-10-03, widget `ndabjvs20vc4`, servi : bulle, panneau du QR au clic au bureau, appui direct vers WhatsApp sur
  téléphone) ; ✅ la bulle grisée constatée en production sur un espace SANS numéro (`kh532t8hq6nr`, « Test DIDWA
  claude code ») ; reste un message depuis un vrai téléphone, la conversation marquée `widget-<code>`, le devenir
  qui prend la main, la bulle grisée sur un numéro DÉLIÉ, puis `create_widget` depuis Claude Code avec une clé
  `mcp:write`.
- ⏳ **Trois décisions de Julien** : un droit à part pour les widgets (`mcp:write` peut aujourd'hui changer ce que la
  bulle affiche sur le site public ; au déploiement, les clés qui le portaient étaient toutes dans l'espace
  SANDBOX) ; une longueur minimale de phrase (« Bonjour » passe sur un espace sans historique) ; les bornes posées au
  lot 4 (nom 80, phrase 300, libellé 60).

## TOUT SUR LA FICHE (LOTS 1 À 3 DÉPLOYÉS ET ESSAYÉS ; LOT 4 EN COURS)

Spec `docs/superpowers/specs/2026-09-30-fiche-unique-design.md`, plan
`docs/superpowers/plans/2026-09-30-fiche-unique.md` (le plan veut chaque lot essayé avant le suivant). Le récit
des trois lots est dans le journal technique, le présent dans `documentation.md` § Contacts.

- ✅ **Lot 1** (la dernière analyse recopiée sur la fiche) : essai réel fait le 2026-09-30, la copie s'est posée
  sur la fiche de Julien dans l'espace SANDBOX.
- ✅ **Lot 2a** (liste unique, connecteurs sur l'origine `fiche`) et **lot 2b** (filtres de la liste et du
  ciblage, bloc Condition), déployés et vérifiés par le vrai code en production.
- ✅ **Essai réel du lot 2 fait le 2026-10-02** : les filtres « sentiment négatif, urgence au moins 7 » trouvent la
  fiche dans la liste et dans le ciblage (Julien), et l'appel `signaler` de Messaging me Brevo envoie les vraies
  valeurs de la fiche (`EM_URGENCY` = 9 vu dans Brevo, l'ancien appel envoyait 8 en dur).
- ✅ **Lot 3** (« la dernière analyse d'un contact change », filtres de « conversation analysée », délai de
  relance réglable à l'écran) : déployé et ESSAYÉ le 2026-10-02 (journal technique : un contact qui reste mécontent
  ne relance rien, un contact qui le devient déclenche, dans la seconde). Plus deux corrections demandées pendant
  l'essai : le premier clic d'un choix remplace la valeur cochée d'office, et une automation se modifie.
- **Lot 4** (API contacts `lastAnalysis`, MCP, trois attributs de signaux, outil « Lire la fiche » de l'agent IA) :
  en cours.
- 🟡 **Jaunes du lot 2a encore ouverts** : les connecteurs et les signaux ne lisent pas encore la même liste
  (divergence voulue jusqu'au lot 4) ; le format des dates envoyées (ISO complet) reste à confirmer avec un
  premier intégrateur ; une note du journal sur le retour arrière du lot 2a (une API d'avant refuserait
  `fiche:*` à l'enregistrement).

## PANNEAU DÉTAIL DE L'INBOX (DÉPLOYÉ LE 2026-09-29, ESSAI RÉEL DÛ)

Spec `docs/superpowers/specs/2026-09-28-inbox-panneau-detail-design.md`. Le journal `conversation_evenements`
(0192) s'écrit dans la même requête que chaque changement de `PgInboxStore`. En production, la frise ne porte
encore que sa ligne d'amorçage (la seule assignation en cours sur 17 conversations).

🔴 **L'ESSAI RÉEL, PAR JULIEN** : sur une conversation de l'espace MessagingMe, assigner, réassigner,
désassigner, prendre puis rendre à l'agent de Meta, archiver ; relire la frise (qui, par qui, quand, dans
l'ordre) ; puis vérifier qu'un message du contact sur la conversation archivée ajoute « rouverte ».

## LES DEUX ÉCRANS D'AGENT : EN-TÊTE ET MENU EN COLONNE (DÉPLOYÉ LE 2026-09-23, ESSAI RÉEL DÛ)

Neuf tâches, relues une par une puis en bloc. Les deux écrans de réglage d'agent portent un en-tête qui
IDENTIFIE l'agent (logo, nom, état, ce qui manque, messages échangés sur 30 jours) et leurs onglets sont
descendus en colonne. Deux routes de comptage neuves, sans migration. Détail dans
`docs/superpowers/plans/2026-09-23-refactor-ecrans-agents.md`.

🔴 **L'ESSAI RÉEL, QUATRE POINTS, ET LE TROISIÈME NE TOMBERA PAS JUSTE.** Ouvrir les deux écrans sur un
agent complètement réglé ET sur un agent vide : le bon logo de fournisseur ; le nombre d'étapes restantes
comparé à ce que les onglets contiennent vraiment ; le chiffre de messages comparé au Performance Lab ; et
la colonne sur un téléphone, où elle doit redevenir la barre horizontale.

⚠️ **L'écart attendu sur le chiffre** : l'en-tête compte TOUS les messages des conversations tenues, envois
de campagne compris, là où le Performance Lab exclut les modèles sortants. C'est le périmètre arbitré, la
légende l'avoue. Ce qu'on vérifie est le SENS et l'ORDRE DE GRANDEUR de l'écart, pas qu'il soit nul.

⚠️ **Un arbitrage attend Julien** : la pastille de l'en-tête montre l'état du NUMÉRO, pas celui de l'agent.
Sur un numéro sain dont l'agent est éteint, l'écran affiche un point vert à côté d'une ligne qui dit que
personne ne répond. Les textes ont été corrigés, le choix reste ouvert. Cf. `todo.md`.

## API PUBLIQUE COHÉRENTE : LOTS 1 À 6 (DÉPLOYÉS LE 2026-09-25 DANS LA NUIT, ESSAIS RÉELS DUS)

Spec `docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md`, plans
`docs/superpowers/plans/2026-09-24-api-v1-lot*.md`. Tout est en production (API sur le VPS, console chez
Vercel), migrations 0172 à 0177 appliquées avant le code et relues en base. Le récit : journal technique,
2026-09-24 et 25. ⚠️ `POST /v1/messages` n'existe plus, c'est `POST /v1/messages/whatsapp` (on a cassé
proprement, aucun intégrateur n'était branché).

🔴 **LES ESSAIS RÉELS, À FAIRE PAR JULIEN** (une vraie clé d'API, droits Écrire + Lire les contacts et
Envois, le numéro d'essai) :
1. **Lot 1** : `POST /v1/contacts` avec un `externalId`, puis la fiche dans le mini-CRM porte « Identifiant API ».
   ⚠️ Depuis le 2026-09-26, un champ ou une étiquette envoyés dans l'essai doivent déjà exister dans l'espace.
2. **Lot 2** : `POST /v1/sends` cible template avec `idempotencyKey` dans le corps ; rejouer la même clé
   avec un autre corps rend 422 `idempotency_key_reused` ; `GET /v1/sends/{id}` rend le rapport.
3. **Lot 3** : les six gestes du plan du lot 3 (§ « Essai réel »), dont un RCS vers un appareil SANS RCS :
   l'échec doit apparaître dans Sécurité > Journal des erreurs, et le second envoi rendre 422 `rcs_unreachable`.
4. **Lot 4** : `GET /v1/templates`, `/v1/scenarios`, `/v1/rcs-messages` avec la clé ; relire la page
   Developers > Documentation API.
5. **Lot 5** : trois conversations d'essai (suivi de commande, retour, achat), chacune classée juste dans le
   Performance Lab. La tâche 7 du lot 5 (le récit dans la doc) suit cet essai.
6. **Lot 6** : brancher un outil dans Paramètres > Intégrations sur un espace d'essai et regarder arriver les
   signaux ; relire la fiche d'aide « retrouver qui a fait quoi », réécrite (texte lu par les clients, elle
   part au prochain `npm run aide:charger`).

🟡 **LES DÉCISIONS QUI ATTENDENT JULIEN** (le code n'y a pas touché) :
- un scénario « RCS puis attente » est accepté par l'API alors que la console le refuse (`ouverture-api.ts`) ;
- une clé neuve (externalId) est rattachée à la fiche même quand le message est ensuite refusé ;
- un `{{x}}` sans valeur part VIDE dans un RCS de l'API (un template, lui, écarte en `missing_variable`) ;
- `POST /v1/messages/rcs` prend le fil en local, mais pas chez Meta quand l'agent de Meta le tient ;
- chaque repli WhatsApp d'un bloc RCS de scénario écrit une ligne « RCS non délivré » dans le journal ;
- `null` sur un champ de destinataire est refusé (et non lu comme une absence) ;
- une panne de Meta rend 422 sans `code` (un code dédié élargirait la table des codes) ;
- un événement trop vieux pour l'outil est écarté sans compteur visible, et un refus partiel répété de l'outil
  écrit une ligne par job dans le journal (plafond à décider).

## HUBSPOT MASQUÉ SANS PORTAIL (LOT 9, DÉPLOYÉ LE 2026-09-23, ESSAI RÉEL DÛ)

Lot 9 du plan `docs/superpowers/plans/2026-09-23-liste-julien.md`, RÉDUIT à ses deux écarts réels après
inventaire (arbitrage de Julien du 2026-09-23).

- 🔴 **L'INVENTAIRE A MONTRÉ QUE LE LOT N'ÉTAIT PAS CE QUE LE PLAN DÉCRIVAIT**, et c'est le vrai résultat de
  cette étape. Sur les quatre fonctions à masquer : la source de campagne l'était **déjà**, mais sur le
  MAUVAIS signal ; le déclencheur « étape de deal » était **grisé** et seulement après sélection ; la
  « mention injoignable dans HubSpot » n'est **pas un écran** mais une écriture du balayage de relance ; et
  la quatrième (l'action du bloc) n'existe pas encore.
- ✅ **Écrit et vert** : les deux écrans se masquent désormais sur le **lien du portail**, pas sur
  l'interrupteur `hubspotListsEnabled`. Un client qui DÉLIE son portail gardait son interrupteur allumé,
  donc la source restait offerte et ne menait nulle part.
- ⚠️ **Aucune migration.** Le lien du portail est une lecture LOCALE (schéma `mmhs` de la même base), jointe
  aux réglages, donc aucun aller-retour réseau sur une route que plusieurs écrans appellent.
- 🔴 **`undefined` VEUT DIRE « ON NE SAIT PAS », ET ON MONTRE.** Une API antérieure à ce lot ne rend pas le
  drapeau : le traiter comme « pas connecté » ferait DISPARAÎTRE la source d'un client qui l'a, pendant
  toute la fenêtre entre le déploiement de la console et celui de l'API. Entre les deux erreurs possibles,
  une seule se rattrape d'un clic. Tenu par un cas e2e.
- ⚠️ **CE QUI RESTE DEHORS, PAR DÉCISION DE JULIEN** : `flagUnreachable` (le balayage écrit « injoignable »
  dans HubSpot) n'est neutralisé que quand l'INSTANCE n'a pas de connecteur, pas quand un ESPACE n'a pas de
  portail. Le neutraliser par espace toucherait un chemin que la production emprunte. Consigné, pas oublié.
- 🔴 **ET LA SECONDE MOITIÉ DU LOT VIT DANS UN AUTRE DÉPÔT** : l'action « mettre à jour un champ HubSpot »
  demande une route générique d'écriture de propriété dans `mm-hubspot`, seul détenteur du jeton. Non faite.
- 🔴 **L'ESSAI RÉEL QUI CLÔT LE LOT** : un espace SANS portail ne voit ni la source HubSpot d'une campagne,
  ni le déclencheur « étape de deal ». Un espace connecté les voit toujours.

## GRILLE DE PRIX UNIQUE DANS /ops (LOT 8, DÉPLOYÉ LE 2026-09-23, ESSAI RÉEL DÛ)

Lot 8 du plan `docs/superpowers/plans/2026-09-23-liste-julien.md`.

- ✅ **Écrit et vert** : une seule grille de prix pour tous les espaces, réglée dans `/ops`. L'écran « Vos
  prix » des Paramètres du client disparaît. Les six champs n'ont PAS été réécrits, ils vivent désormais
  dans `web/components/GrillePrixChamps.tsx`, partagés par les deux surfaces.
- ✅ **MIGRATION 0168 APPLIQUÉE le 2026-09-23 à 11 h 36, AVANT le `up`**, et relue en base : `grille_prix`
  porte UNE ligne, reprise exacte (marge 100, service 2,48 cts, franchise 1000, RCS 6,00 et 8,00), avec
  `modifie_par = 'migration 0168'`. La requête de contrôle rend « 1 grille distincte, 1 espace », donc le
  `raise exception` ne pouvait pas se déclencher et personne ne voit un chiffre bouger.
- 🔴 **CE QU'ELLE GARANTIT.** Elle CRÉE `grille_prix`, un singleton structurel
  (`id boolean primary key check (id)` : il ne PEUT pas y avoir deux grilles), et reprend la valeur actuelle.
  Elle REFUSE plutôt que d'inventer si les espaces divergent ; mesuré avant de l'écrire, un seul espace
  porte des prix, donc ce refus ne peut pas se déclencher. Elle ne touche à AUCUNE colonne existante, donc
  le retour arrière reste possible jusqu'au dernier moment.
- 🔴 **CE LOT RETOURNE UNE DÉCISION ÉCRITE SIX JOURS PLUS TÔT, et c'est dit dans le code.** `src/stats/prix.ts`
  portait depuis le 2026-09-17 : « par ESPACE et pas en configuration globale, un grand compte ne se facture
  pas comme un petit ». Cette raison n'a pas disparu, elle a été pesée contre « le client n'a pas à fixer ce
  qu'on lui facture » et elle a perdu (arbitrage de Julien, question posée explicitement). Le jour où un
  grand compte demandera son prix, ce sera une SURCHARGE par espace à rouvrir, pas un oubli à réparer.
- ⚠️ **LES SIX COLONNES DE `tenant_settings` RESTENT EN PLACE, mortes**, et leur `drop` est une migration
  SUIVANTE, à passer APRÈS le déploiement (la marche à suivre est dans [todo.md](todo.md)).
- ⚠️ **FENÊTRE VERCEL / API, et elle est réelle ici** : la carte `/ops` appelle une route que la production
  n'a pas encore. Elle se MASQUE dans ce cas, avec une phrase qui dit pourquoi, et un e2e tient ce
  comportement : un formulaire de zéros ferait croire que tout est gratuit, pour tous les espaces.
- 🔴 **L'ESSAI RÉEL QUI CLÔT LE LOT** : changer un prix dans `/ops`, avec sa phrase, et le voir dans le coût
  par engagement de DEUX espaces différents. C'est le seul essai qui prouve « une grille pour tous ».
- ✅ **La devise est tranchée** (Julien, 2026-09-23) : tous les WABA sont en euros, aucune garde, aucune
  conversion. Ce qui rendrait la question vivante est consigné dans [todo.md](todo.md).

## PUBLICITÉS CLICK-TO-WHATSAPP (LOTS 1 À 3 DÉPLOYÉS ; UNE VRAIE CAMPAGNE DIFFUSE DEPUIS LE 2026-09-29)

Spec `docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md`, plan
`docs/superpowers/plans/2026-09-22-pubs-ctwa-lot1-capter.md`.

- ✅ **Lot 1 « Capter », DÉPLOYÉ le 2026-09-23 vers 9 h 15**, par une session qui n'en avait écrit aucune
  ligne : arrivées publicitaires (`arrivees_pub`, `ctwa_clid` compris) et tarifs de Meta (`tarifs_meta`)
  gardés à la réception, 72 h gratuites exclues de toute lecture de coût, `ctwa_clid` effacé par la purge
  RGPD. Migration 0163 appliquée AVANT le `up` et relue en base point par point (le détail vit dans
  [CLAUDE.md](CLAUDE.md) § Déploiement, il ne se recopie pas ici). Revue finale : 0 rouge.
- ✅ **UNE VRAIE CAMPAGNE, créée depuis Messaging Me sur le compte publicitaire MessagingMe, diffuse depuis le
  2026-09-29** : statut, dépense, clics, impressions, couverture et dépense jour par jour relus par le balayage ;
  dépense recoupée avec le Gestionnaire de Meta par Julien le 2026-10-01, et vue dans le coût par engagement de
  Performance lab.
- ✅ **LE PREMIER CLIC RÉEL EST ARRIVÉ LE 2026-09-30 À 14 H 34 UTC** (lu en base le 2026-10-01) : une arrivée
  rattachée à sa campagne, `en_standby` VRAI (l'agent de Meta tenait le fil, le contact étant sur sa liste), issue
  `agent_meta` (la destination de cette publicité), et SANS `ctwa_clid`, que Meta n'a pas rendu (la spec le dit
  « parfois vide »). ⚠️ Une seule arrivée : rien n'est encore mesuré sur un lead routé vers un SCÉNARIO.
- ⚠️ **La moitié TARIFS se prouve, elle, SANS publicité** : `tarifs_meta` se remplit à chaque accusé ordinaire.
  C'est la preuve la moins chère que le lot tourne vraiment en production, et elle se lit en base. Pas faite.
- 🟡 **Les jaunes de la revue finale qui portent sur ce lot**, rapport
  `docs/prive/REVUE-FINALE-2026-09-23-deploiement.md` : le puits de tarifs en queue de paramètres optionnels est
  CORRIGÉ depuis (`PuitsAccuses`, nommé et obligatoire, vérifié dans les deux sens) ; l'interpolation SQL de
  `horsEntreeGratuite` RESTE, ses deux arguments étant des expressions de la requête appelante et jamais une
  valeur d'utilisateur ; `bilanContact` garde l'écart de gardes de livraison ANTÉRIEUR à ce lot et déclaré dans
  le code, parce que le fermer CHANGE un chiffre que le client voit et demande donc sa propre mesure.
- ✅ **Lot 2 « Connecter » : ÉPROUVÉ EN PRODUCTION le 2026-09-23.** Un vrai compte publicitaire d'un vrai
  portefeuille est connecté depuis l'écran : nom, devise, fuseau et Page lus chez Meta. Migrations 0167
  et 0169 appliquées avant leur `up`, relues en base point par point.
- ✅ **SIX RELECTURES À FROID ONT SUIVI, ET TOUT EST DÉPLOYÉ** (2026-09-23 au soir, `cc3380ee`).
  Quatorze constats bloquants au total, et **chaque relecture a trouvé un défaut que la précédente
  avait créé** : c'est le vrai enseignement du lot, plus que les défauts eux-mêmes.
- 🔴 **LE PLUS GRAVE ALLAIT DANS LE SENS INVERSE DE CE QU'ON CROYAIT CORRIGER.** Le dépôt par `/ops`
  révoquait l'ancien jeton sans voir que `DELETE /me/permissions` porte sur le couple (application,
  ENTITÉ) : dans l'usage normal de cette route, il désarmait le jeton NEUF et répondait 200 sur une
  connexion morte. Le raisonnement était déjà écrit 400 lignes plus haut dans le même fichier, non lu.
  On compare désormais les identités (`GET /me`) avant de retirer quoi que ce soit.
- 🔴 **ET LA GARDE CENSÉE PROTÉGER TOUT ÇA A ÉTÉ PRISE EN DÉFAUT DEUX FOIS**, parce qu'elle lisait le
  TEXTE d'un `if` : trois orthographes du même bug l'ont traversée, et une réécriture censée la
  renforcer l'a AFFAIBLIE. La décision vit désormais dans `retirerAncienAcces`, exécutée contre un faux
  client : 13 mutants sur 14 tués, le survivant étant équivalent. **Un test de source ne sait pas juger
  une sémantique**, il épingle une orthographe.
- 🔴 **LES DEUX MESURES DU PLAN SONT TRANCHÉES, ET LA TROISIÈME N'AVAIT PAS ÉTÉ POSÉE.** La liaison
  Page / numéro ne se lit PAS chez Meta (le verdict `inconnu` est le cas normal, pas un repli) ; la
  devise et le fuseau se lisent SANS la permission `MANAGE`, ce qui valide l'arbitrage de la
  configuration ; et un jeton d'utilisateur système **ne déclare pas ses actifs**, il faut les
  DEMANDER. Ce dernier point a coûté un écran qui annonçait « aucun compte » sur une connexion
  parfaite : `brain/LEARNINGS.md`, 2026-09-23.
- ✅ **LES DEUX GESTES QUI MANQUAIENT CÔTÉ JULIEN SONT FAITS** (points 4 et 5 de la spec § 11) : la Page
  « Messaging Me » est liée au numéro, et le compte publicitaire porte un moyen de paiement actif.
  ⚠️ La Page à choisir reste CELLE QUI EST LIÉE au numéro : c'est elle qui décide vers quel WhatsApp le
  bouton ouvre la conversation.
- 🔴 **L'ÉCRAN MONTRE DÉSORMAIS SI LE COMPTE PEUT DIFFUSER, et il ne prétend plus connaître la
  liaison.** Le statut du compte et la présence d'un moyen de paiement sont lus EN DIRECT chez Meta,
  parce que sans eux une pub se crée et ne diffuse jamais, et l'erreur arrive des jours plus tard.
  `null` y veut dire « je n'ai pas pu demander », jamais « tout va bien ». La liaison Page / numéro,
  elle, n'est plus demandée du tout : dix champs essayés, aucun ne la rend, et l'appel était condamné
  à un 400 à chaque choix. L'écran emmène le client là où Meta l'affiche.
- ⚠️ **MessagingMe ne peut pas connecter SON PROPRE compte par cet écran**, et c'est structurel chez
  Meta : le portefeuille qui possède l'app ne peut pas être son propre client. D'où
  `POST /ops/pubs/connexion/:tenantId`, qui dépose un jeton d'utilisateur système créé à la main après
  l'avoir vérifié chez Meta. Notre propre espace est connecté ainsi depuis le 2026-09-23.

### Lot 3 « Router, créer, suivre » : DÉPLOYÉ LE 2026-09-24

Plan : `docs/superpowers/plans/2026-09-23-pubs-ctwa-lot3-router-creer-suivre.md`. Livré en trois commits,
comme le cadrage l'impose (routage, puis création, puis suivi), CI verte sur les trois.

- ✅ **MIGRATION 0170 APPLIQUÉE LE 2026-09-24, AVANT le `up`** (`pubs_router` : `publicites`, `pubs_connues`, et
  quatre colonnes de routage sur `arrivees_pub`), relue en base point par point juste après `migrate`. Le compteur qui fait foi est celui de `CLAUDE.md`.
- ✅ **Le routage** : une fonction PURE, les six lignes du tableau de la spec, et une exception à la doctrine
  du `standby` pour un seul cas, celui d'un lead dont on a DÉJÀ repris le fil chez Meta.
- ✅ **La création** : tout est créé EN PAUSE chez Meta, chaque identifiant rangé dès qu'il arrive, et un
  rattrapage qui supprime la campagne dès qu'une étape échoue. Publier allume l'automation AVANT Meta.
- ✅ **Le suivi** : deux appels par compte toutes les quinze minutes, l'entonnoir, la pause et la reprise.
- 🔴 **LE PLUS GROS DÉFAUT DU LOT ÉTAIT UNE RÉGRESSION, PAS UNE CAPACITÉ MANQUANTE**, et c'est une relecture
  à froid qui l'a vu : le fil était pris à l'agent de Meta dès qu'un lead arrivait en `standby`, SANS
  regarder s'il y avait quoi que ce soit à démarrer. Sur une publicité créée et pas encore publiée (son
  automation naît éteinte), un clic PAYÉ recevait donc un silence de vingt-quatre heures, là où l'agent de
  Meta répondait avant ce lot. Deux moitiés au correctif : la règle ne prend plus le fil sans automation
  ALLUMÉE, et le handler REND le fil quand il l'a pris et que rien n'a finalement démarré.
  ⚠️ **Aucun compte de relectures ni de rouges n'est écrit ici.** Cette ligne a annoncé « deux rouges »
  pendant que les relectures suivantes en trouvaient d'autres : c'est un fait dérivable du `git log`, donc
  il n'a pas sa place en prose. Le détail vit dans `.git/revue-finale-rapport.md`, hors versionnement.
- ✅ **DÉPLOYÉ le 2026-09-24** : migration 0170 d'abord, relue en base point par point, puis l'API et le
  worker, puis le contrôle des portes publiques, qui a de nouveau rendu 502 le temps d'un `nginx -s
  reload`. La fenêtre Vercel est refermée : l'écran et les routes qu'il appelle sont en ligne ensemble.

**Ce qui reste** : l'ESSAI RÉEL, qui seul clôt la feature, et qui appartient à Julien : première campagne
MessagingMe créée depuis Messaging Me, un vrai clic depuis un téléphone, l'agent de Meta qui se tait pendant
que le scénario parle, et les cinq mesures de la spec § 6. 🔴 Rien de ce qui précède ne le remplace : aucun
mécanisme de ce lot n'a encore tourné sur de l'argent réel.

⚠️ **Deux points que seule cette première campagne tranchera**, et qui sont écrits dans le code à l'endroit
où on les changera : l'optimisation `CONVERSATIONS` pour un annonceur français, et l'emplacement de
`page_welcome_message` dans la créa, sur lequel la documentation de Meta se contredit.
  ⚠️ L'App Review, elle, n'est PAS bloquée : la démonstration se fait avec un portefeuille client, ce
  qui est le cas d'usage réel.

### Brouillons et aperçu (2026-09-24, DÉPLOYÉ, ESSAI RÉEL DÛ)

Demande de Julien du 2026-09-24. Plan : `docs/superpowers/plans/2026-09-24-pubs-brouillons-et-liste.md`.

- **Migration 0171** (`pubs_brouillons`), purement additive, passée AVANT le `up`. L'état d'application ne
  se recopie pas ici : il vit dans [CLAUDE.md](CLAUDE.md) § Déploiement, et la base tranche.
- ✅ **L'aperçu** : l'annonce dans le fil, la conversation qui s'ouvre, puis la réponse. Un scénario est
  déterministe, donc ses mots exacts sont lus dans le graphe PUBLIÉ ; l'agent de Meta compose, donc c'est
  une illustration et l'écran le dit.
- ✅ **Les brouillons** vivent dans leur table, pas comme un état de `publicites` : c'est
  `publicites.campagne_id` qui est `not null` et porte l'unique par laquelle le routage retrouve la
  publicité d'un lead payé, et un brouillon n'a aucune campagne chez Meta.
- ✅ **La liste en trois groupes** (brouillons, en cours, achevées), « achevée » dérivé de la date de fin.
  Au clic, budget initial, dépensé à date et clics en face.
- 🔴 **L'ESSAI RÉEL QUI CLÔT CE LOT, et il appartient à Julien** : écrire un brouillon avec un visuel,
  fermer l'onglet, revenir, le rouvrir et retrouver l'image, puis le transformer en publicité et voir le
  brouillon disparaître.

## 🔴 OUTILS MAISON DE L'AGENT DE META (LOT 2 DÉPLOYÉ ET ÉPROUVÉ ; LOTS 3 ET 4 ÉCRITS LE 2026-09-22)

Spec `docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md`, plan
`docs/superpowers/plans/2026-09-21-outils-maison-mba.md` (4 lots, 20 tâches, deux déploiements).

- ✅ **Lot 1, la mesure `agent_event`** : l'agent de Meta répond 11 secondes après l'événement, dans une
  conversation en cours, en suivant la consigne (`docs/MBA-API-REFERENCE.md`). La transmission de la réponse
  « à côté » (lot 4) est donc possible.
- ✅ **Lot 2, DÉPLOYÉ le 2026-09-21 au soir** : gestes « Poser un tag » et « Enregistrer une information »
  exécutés par le relais ; publication ; onglet « Outils » refait d'après le croquis de Julien. Séquence tenue :
  attestation (trois relectures à froid, `.git/revue-finale-rapport.md`), build, 0162 vue DANS l'image,
  `migrate`, relecture en base point par point, `up -d --build`, rechargement de NPM (le 502 est revenu),
  `fumee.mjs` à 6 sur 6, `/mba-outils` à 401 au lieu de 404, relais à 401 sans clé. Le verdict de la CI se lit
  sur le dernier commit de code (`gh run view <id> --json jobs`), jamais dans ce fichier : il y a menti.
- ✅ **Revue finale à froid du lot 2 (2026-09-21 au soir) : 4 rouges, 16 jaunes, tous traités.** Les rouges :
  un test d'intégration périmé par la règle des orphelins, l'IP d'origine du VPS dans le plan (dépôt public),
  `.env.example` resté à l'ancienne valeur de `API_MAX_LOURDES_SIMULTANEES` (`.env.prod` ne la porte pas : sans
  effet en production), et une note de l'écran qui renvoyait vers « Lancer un scénario », absent du lot 2. Les
  jaunes portant sur le lot de sécurité ont été corrigés par sa propre session.
- ✅ **L'onglet « Outils » a été EN PANNE en production** du push de `b30c3a05` au déploiement (Vercel sert
  la console à chaque push, l'API n'avait pas la route). Réparé par le déploiement ; la règle est dans
  `CLAUDE.md` § Déploiement.
- ✅ **ESSAI RÉEL DU LOT 2, FAIT PAR JULIEN LE 2026-09-21 AU SOIR, ET RELU EN BASE.** Deux outils créés depuis
  l'onglet (`messagingme_is_genial`, étiquette `genial` ; `job_description`, champ `metier`), passés « Chez
  Meta », puis déclenchés sur WhatsApp : trois lignes de journal, appelant `mba`, toutes `ok` (deux poses à
  21:20 et 21:22 UTC, l'information à 21:26:46.880), et la fiche porte `genial` et `metier: électricien`,
  modifiée 26 ms après l'appel. La conversation est rendue à l'agent de Meta.
- ✅ **SECOND ESSAI RÉEL, FAIT PAR JULIEN LE 2026-09-22 AU MATIN, ET RELU EN BASE** (après le déploiement des
  corrections) : un outil information modifié depuis l'onglet (renommé `metier_du_client`, l'ancien nom retiré chez
  Meta dans le même envoi), un outil maison supprimé depuis l'onglet (parti, sans bandeau résiduel), et
  « rajoute une étiquette » sur le connecteur `add_tag` : journal `ok`, appelant `mba`, HTTP 200 du CRM en 494 ms,
  ce qui éprouve `fetchPublic` (lot 1 de sécurité) en conditions réelles.
- ✅ **L'ORDRE UNIQUE des verrous de `remove`, DÉPLOYÉ le 2026-09-22 vers 10 h** : l'agent, ses sessions, les
  définitions, puis le reste (trois ordres antérieurs interbloquaient chacun avec un chemin voisin, tous rejoués
  contre un Postgres jetable), avec les outils et le connecteur distingués dans `effacementsImprevus` et la
  suppression en cours qui bloque aussi le formulaire.
- ✅ **DÉPLOYÉS le 2026-09-22 vers 11 h 25, les deux lots de suites** : un rattachement qui verrouille son agent,
  la dispense du bandeau purgée dès la publication, un enregistrement qui bloque « Supprimer » et « Modifier », puis
  les chemins VOISINS de la suppression d'un agent alignés sur son ordre (import et suppression d'un serveur MCP,
  relecture de la connaissance, chacun rejoué contre un Postgres jetable et rouge sur son mutant).
- ⏳ **Poussé après ce déploiement, sans relecture dédiée (règle du 2026-09-22)** : les 5 jaunes de la dernière
  relecture (l'import d'un serveur MCP verrouille AVANT ses insertions, sans quoi il interbloquait avec la
  suppression du même serveur ; une clé d'agent en majuscules ramenée en minuscules ; « Annuler » grisé pendant un
  enregistrement ; la précondition physique du test de suppression vérifiée). Relus et déployés avec le lot 3.
- ✅ **Connecteurs orphelins, décision de Julien du 2026-09-21 : suppression automatique.** Une action ou un
  connecteur HTTP qui perd son dernier utilisateur part (`detacher`, suppression d'un agent, `retirerDeMba`) ; un
  outil MCP reste. `supprimerDefinition` et `detacherConsommateur`, devenus sans appelant, sont retirés.
- ✅ **Le drapeau « test » de la conversation de Julien est levé** (décision du 2026-09-21, une ligne, relue avant
  et après) : sa conversation revient à l'agent de Meta en fin de scénario, et compte désormais dans les
  statistiques et l'analyse.
- 🔴 **Lots 3 et 4, ÉCRITS ET PROUVÉS, À RELIRE ET DÉPLOYER** (2026-09-22) : « Envoyer un bloc » (le bloc seul,
  vérifié à la création et à chaque appel), « Lancer un scénario » (le chemin de l'Inbox), la réponse « à côté »
  transmise par `agent_event`, et le marqueur de 0149 qui ne se pose plus sur un envoi déjà traité (aucun marqueur
  en attente en production au moment de l'écrire, mesuré en lecture seule : le défaut se lit dans le code, le
  balayage l'a toujours rattrapé). Prouvé : unitaires, 7 mutations rouges, intégration sur Postgres jetable (le
  marqueur : l'ancienne règle fait tomber les 4 cas neufs et eux seuls), e2e de l'onglet 41/41. Pas de migration
  (0162 porte déjà `accuse_le`). Reste : la revue finale, le déploiement, puis **l'essai réel de Julien** : un bloc
  déclenché en conversation, un scénario mené au bout (l'agent de Meta reprend la parole), et un second scénario
  où il répond à côté (l'agent de Meta répond à ce qu'il a écrit). L'inconnue M1 (l'agent de Meta écrit-il après
  notre prise du fil ?) se lit pendant cet essai.

## ✅ META BUSINESS AGENT : LE RELAIS (2026-09-21, DÉPLOYÉ, ESSAI RÉEL FAIT)

**Le relais** (spec `docs/superpowers/specs/2026-09-21-relais-mba-design.md`, plan
`docs/superpowers/plans/2026-09-21-relais-mba.md`) : Meta appelle `POST /mba/relais/outils/:id`, Messaging Me
retrouve le contact par la macro `WHATSAPP_PHONE_NUMBER`, remplit les variables du mini-CRM et fait l'appel
par `creerAppelConnecteur`. Déployé le 2026-09-21 (0161 appliquée avant, relue en base).

✅ **L'ESSAI RÉEL, FAIT PAR JULIEN LE 2026-09-21 À 15 H 04 (heure de Paris)** : « je voudrais rajouter une
étiquette » sur WhatsApp, l'étiquette est posée sur sa fiche UChat. Preuves relues : ligne de journal
`add_tag`, `ok`, appelant `mba`, HTTP 200 de UChat en 2,9 s ; clé « Agent de Meta » utilisée à la même
seconde ; chez Meta, un seul connecteur `EngageMe` (adresse du relais, clé API) et un seul outil `add_tag`.

**Ce que l'essai a appris** (consigné dans `docs/MBA-API-REFERENCE.md`) :
- `WHATSAPP_PHONE_NUMBER` est rempli en conversation, et vaut le numéro international SANS « + », chiffres
  seuls (11 caractères pour un numéro français). Le relais le lisait déjà ; c'était la dernière inconnue.
- 🔴 **C'est la description de l'outil qui décide si l'agent de Meta l'appelle, et ses compétences peuvent
  l'emporter.** Deux essais avec « Le client demande à rajouter une etiquette » : l'agent n'a jamais appelé
  l'outil, sa compétence « passer la main » a gagné. Avec une description DIRECTIVE (quand l'appeler, ce que
  l'outil sait déjà, confirmer après, « ne passe pas la main, c'est cet outil qui traite »), il l'a appelé au
  premier essai.
- Un premier essai a échoué parce que « Envoyer » n'avait pas été cliqué, l'écran ne disant pas si un outil
  était déjà chez Meta. C'est fait depuis : l'onglet refait du 2026-09-21 donne l'état chez Meta ligne par ligne,
  et enregistrer envoie.

**Reste à faire, sans urgence** :
- Confirmer d'un clic qu'un « Envoyer » sans changement répond « Rien à changer » (la forme que Meta renvoie
  est identique, clé pour clé, à celle qu'on publie : aucun geste attendu).
- `journaliserForme` reste en place (il ne journalise que la FORME du numéro, jamais sa valeur) tant que les
  refus du relais n'ont pas de ligne de journal (`todo.md`) : c'est aujourd'hui la seule trace d'une macro vide.

## 🔴 CARROUSEL RCS : EN SERVICE, ESSAI RÉEL EN PARTIE FAIT (2026-09-21)

Plan `docs/superpowers/plans/2026-09-21-carrousel-rcs.md` ; l'essai qui le clôt est écrit dans la spec
(`docs/superpowers/specs/2026-09-21-carrousel-rcs-design.md`, § « L'essai réel »). Récit et mesures :
[docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), entrée du 2026-09-21.

✅ **FAIT PAR JULIEN, RELU CHEZ SMSMODE ET EN BASE** : un carrousel de 3 cartes renvoyé depuis l'Inbox à
14 h 46, après le déploiement du correctif `96eebb5a`. smsmode l'accepte, les rappels et les boutons sont sur
`api.messagingme.app`, et l'appui sur « En savoir plus » est compté ET attribué, son rappel revenant en moins
d'une seconde. Les envois de 14 h 21 et 14 h 40 gardent des boutons morts (leur adresse est figée chez
smsmode) : c'est attendu, rien à réparer.

🔴 **CE QUI RESTE DÛ** (rien n'est clos avant) :
1. Le rendu, dit par Julien : les cartes défilent, les visuels s'affichent, les boutons sont dans les cartes.
2. Un bouton **Réponse** : ce carrousel n'en portait pas. Son chemin (un rappel `SUGGESTION`) est celui qu'a
   pris l'appui sur le lien, mais aucune réponse n'a été vue arriver.
3. Une **campagne** RCS vers lui-même avec ce carrousel : le lot 2 n'est jamais parti pour de vrai.

⚠️ **À ARBITRER PAR JULIEN, MESURÉ PENDANT L'ESSAI** : chez smsmode, l'appui sur un bouton LIEN revient AUSSI
en rappel `SUGGESTION`, avec son `postbackData`. Il entre donc dans le fil comme une réponse du contact
(« En savoir plus ») et range la conversation dans « À traiter » ; aucun parcours n'a démarré. Sur WhatsApp,
un bouton lien ne produit aucun message entrant : le clic, compté sur la fiche, est le seul signal.

⚠️ **QUESTION OUVERTE** : un texte AU-DESSUS des cartes, comme sur un template WhatsApp. smsmode n'en prévoit
pas dans un carrousel ; l'option proposée est un message texte envoyé juste avant lui. En attente de Julien.

## 🔴 INBOX : « TRAITÉ », PIÈCES JOINTES, « JE M'EN OCCUPE » (2026-09-19, DÉPLOYÉ, ESSAI RÉEL EN PARTIE FAIT)

Trois demandes de Julien, arbitrées le jour même. Plan :
`docs/superpowers/plans/2026-09-19-inbox-traite-medias-prise.md`. Fonctionnel dans [features.md](features.md),
invariants dans [documentation.md](documentation.md) § Conversations, migration 0160 dans le compteur de
[CLAUDE.md](CLAUDE.md).

🔴 **L'ESSAI RÉEL, À FAIRE PAR JULIEN SUR SON ESPACE** (rien n'est clos avant) :

1. Envoyer depuis son téléphone une photo puis un PDF au numéro : la photo s'affiche dans le fil, le PDF se
   télécharge sous son nom.
2. Marquer la conversation « Traité » : elle quitte « À traiter », reste dans « Tout » avec sa pastille.
   Répondre par un 👍 : elle RESTE « Traité » (c'est le seul endroit où un vrai payload de réaction Meta
   traverse ce chemin). Puis écrire un mot : elle revient dans « À traiter », la pastille disparaît.
   ✅ **Fait le 2026-10-01 pour « Traité » et la réouverture** (essai du délai de reprise : le délai repart du clic,
   un message avant le délai reste à l'équipe et ouvre une demande, après le délai l'agent de Meta répond). Le 👍
   reste à essayer.
3. Créer un compte agent, activer « Les agents peuvent prendre une conversation non affectée » dans
   Paramètres DEPUIS UN COMPTE MANAGER, et vérifier que l'agent voit « Je m'en occupe » sur une conversation
   non affectée, rien sur celle d'un collègue ; et que le manager peut affecter à quelqu'un (son menu était
   vide jusqu'au 2026-09-19).

⚠️ **À SIGNALER, HORS DE CE CHANTIER** : le VPS tournait sur `0482ae0` (chantier des moments d'un agent IA,
déployé le 2026-09-18 au soir par une autre session) alors qu'aucune attestation de revue finale n'était
enregistrée dans ce dépôt pour ses 25 commits. Ce déploiement-ci n'a fait relire que ce qui le suit.

## PERFORMANCE LAB : LES COÛTS ET L'ANALYSE (2026-09-17, DÉPLOYÉ LE 2026-09-23 AU PLUS TARD)

Refonte de l'onglet Synthèse demandée par Julien : une carte « Coûts » à gauche (coût moyen par
engagement, coût total des messages envoyés, coût total IA), les intentions et la matrice
urgence/satisfaction à droite, l'écran d'analyse en UNE LIGNE PAR JOUR, et « qui a répondu ».
Spec : `docs/superpowers/specs/2026-09-17-performance-lab-couts-et-analyse-design.md`.
Plan : `docs/superpowers/plans/2026-09-17-performance-lab-couts.md` (8 tâches).

✅ **0154 ET 0155 SONT APPLIQUÉES**, le 2026-09-18. Le compteur de [CLAUDE.md](CLAUDE.md) fait foi et porte
le détail de ce qui a été relu en base ; il n'est pas recopié ici.

🔴 **LE BALAYAGE D'AGRÉGATS A TOURNÉ AVANT LA PURGE, ET ON L'A VU PLUTÔT QUE SUPPOSÉ.** Au démarrage du
worker : `agregats-analyse: 6 journee(s) ecrite(s)`. Puis vérifié en base par le vrai code : sur les deux
espaces, la lecture directe et la table d'agrégats rendent des journées **IDENTIQUES**. C'est la propriété
qui autorise à effacer.

⚠️ **ET LA PURGE N'A RIEN EFFACÉ, PARCE QU'ELLE NE LE POUVAIT PAS** : zéro conversation n'a plus de 90
jours (la plus ancienne date du 2026-08-18). La seule opération irréversible du dépôt a été allumée au
moment précis où elle ne peut rien détruire, ce qui était le bon moment pour l'allumer et pas une chance.

🔴 **LA RÉTENTION PASSE DE 365 À 90 JOURS, ET L'ORDRE DES DEUX BALAYAGES EST LA SEULE CHOSE
IRRATTRAPABLE DU LOT.** Supprimer une conversation supprime son analyse EN CASCADE : si la purge part
avant que les agrégats du jour soient écrits, l'historique est perdu pour toujours. C'est rendu
MÉCANIQUE dans `src/worker.ts` : le balayage d'agrégats est **attendu** au démarrage, et un drapeau
`agregatsAJour` **suspend la purge** tant qu'il a échoué. ⚠️ Un espace peut poser SA durée, et `0` chez
lui veut dire « ne purge jamais cet espace » quand `0` au niveau de l'INSTANCE veut dire « purge
éteinte partout ». Les deux zéros ne disent pas la même chose et c'est délibéré.

⚠️ **LA CI EST PASSÉE ROUGE SUR CE LOT, ET SEUL LE JOB `integration` POUVAIT LE VOIR.** Un des deux cas
de rétention par espace que je venais d'ajouter laissait derrière lui une conversation de 500 jours,
volontairement protégée de la purge : le cas voisin, qui vérifie que l'effacement est BORNÉ à deux par
passage, en supprimait donc une qui n'était pas à lui. `npm test` en local n'a pas de base et ne
pouvait rien en dire. Corrigé, les deux cas rendent maintenant la base comme ils l'ont trouvée.

🔴 **0155 EST DEVENUE BLOQUANTE POUR UN SECOND CHEMIN, ET C'EST LE PLUS CHAUD DES DEUX.** Depuis le
correctif de revue du 2026-09-17, `getSummary` LIT `tenant_settings.conversation_retention_days` pour
annoncer à l'écran la durée réellement appliquée à CET espace. C'est le chemin d'affichage de toute la
page Synthèse : déployer le code avant la migration ne casserait plus seulement le balayage, ça rendrait
`42703` sur la page entière, en boucle. Même symptôme que le 2026-08-17. ⚠️ Mesuré : la colonne n'existe
pas encore en base, une sonde l'a confirmé en rendant `column ts.conversation_retention_days does not
exist`. Le SQL a donc été validé dans une session isolée par TABLE TEMPORAIRE du même nom (`pg_temp` passe
avant `public`), sans jamais poser de verrou sur la vraie table.

⚠️ **UNE FICHE DU BOT D'AIDE A CHANGÉ, DONC IL FAUT LA CHARGER** : `npx tsx db/charger-aide.ts` après le
déploiement. Le dépôt est la source, la table `aide_fiches` n'est que l'index : sans ce chargement, le bot
continue de répondre avec l'ancien texte. La fiche « importer-mes-contacts » décrit désormais le résumé
de conversation sur la fiche du contact. ⚠️ Elle a été rattrapée par un test (`aide-proposer`), pas par
moi : modifier une section de `features.md` PÉRIME l'empreinte des fiches qui la citent, et la CI le dit.

✅ **LA TÂCHE 8 EST COMPLÈTE depuis le 2026-09-17 au soir**, step 6 compris : le résumé de la dernière
conversation analysée est un champ de base de la fiche contact, DÉRIVÉ et jamais recopié (la purge le vide
d'elle-même, une copie dans `contacts.fields` y survivrait). L'arbitrage de coût a été tranché sur l'option
recommandée : la fiche, pas la liste paginée, et surtout pas une variable de message. Détail et mesure dans
le plan. ⚠️ Cette ligne annonçait encore « SEUL point non fait » après la livraison, relevé en revue à
froid : c'est très exactement la dérive contre laquelle l'en-tête de ce fichier met en garde.

**CE QUI RESTE DÛ SUR CE CHANTIER**, dans l'ordre où ça se pose :

1. 🔴 **L'ESSAI RÉEL, ET IL SEUL CLÔT LA FEATURE. IL A DEUX MOITIÉS.**

   **(a) Les écrans.** Ouvrir Performance Lab sur les vraies données : déplier les trois lignes de la carte
   « Coûts », cliquer une campagne mesurée et vérifier que le funnel et les barres par bloc disent quelque
   chose de vrai, puis cliquer une journée de l'écran d'analyse. Aucun de ces écrans n'a jamais tourné
   ailleurs que dans ses propres tests.

   **(b) 🔴 LA MARGE, ET C'EST CELLE QU'ON ALLAIT OUBLIER.** Poser une **marge à 150 %** dans Paramètres >
   Vos prix, puis vérifier que **cinq écrans annoncent le même prix unitaire** : l'écran Campagnes (total,
   ligne, tiroir de détail), la fiche d'une campagne dans Performance Lab, le graphe de coût du Quantitatif,
   le détail par template, et le bilan d'un contact. Vérifier au passage que la carte « Facturé par Meta »
   nomme la marge comme cause de l'écart, en plus du tarif moyen.

   ⚠️ **POURQUOI CETTE MOITIÉ EXISTE.** Le défaut « un écran affiche encore le tarif brut » a échappé à
   TROIS revues successives, parce qu'il est **invisible tant que la marge vaut 100** : les deux chiffres
   coïncident alors, et tous les tests passent. Un essai qui ne pose jamais de marge ne peut donc pas voir
   le septième consommateur oublié. Elle était écrite dans le plan, que le plan lui-même déclare non fiable ;
   relevé à la sixième revue, elle est désormais ici, où ce fichier fait foi.
2. **Lot 3 : les thèmes déclarés par le client et la réanalyse de toute la base**, facturée sur SA clé
   Gateway. Cadré dans la spec, aucun plan écrit, rien commencé.

## 🔴 CE QUI RESTE DÛ SUR LES CONNECTEURS MCP (déployés le 2026-09-17)

**Messaging Me sait se brancher sur un serveur MCP tiers, importer son catalogue et exposer ses outils à un
agent IA.** Le lot est EN PRODUCTION : routes montées et gardées (401 et non 404), migration 0152 déjà en
base (`migrate` a répondu « à jour, rien à appliquer »), contrôle public vert.

🔴 **L'ESSAI RÉEL N'A PAS ÉTÉ FAIT, ET IL SEUL CLÔT LA FEATURE.** Messaging Me branché sur NOTRE propre serveur
MCP (`/mcp` sur `api.messagingme.app`), puis depuis un vrai WhatsApp : poser à l'agent une question dont la
réponse exige l'appel, vérifier qu'il répond avec la donnée du BON contact, puis lui demander explicitement
la donnée d'un AUTRE numéro et vérifier qu'il ne l'obtient pas. C'est la garde anti-IDOR du lot, et ni les
5 555 tests ni les quatre relectures à froid ne la remplacent. ⚠️ Le chemin à emprunter dans l'écran :
Tools > Connecteurs MCP pour déclarer et importer, puis **AI Agent > Outils, section « Vos serveurs MCP »**,
où il faut RATTACHER l'outil avant de l'activer. Ces deux gestes sont séparés exprès.

🔴 **`0153_outil_source_kind_strict.sql` RESTE À ÉCRIRE ET À JOUER, et seulement une fois que ce déploiement
a vécu.** 0152 est délibérément permissive : sa clé étrangère composite est en `MATCH SIMPLE`, donc une
ligne dont `source_kind` est null lui échappe. Le CHECK strict ferme cette échappatoire, et il ne peut
passer qu'une fois que tout le code en production renseigne la colonne. Détail dans `todo.md`.

⚠️ **CE QUE QUATRE RELECTURES À FROID ONT COÛTÉ ET RAPPORTÉ, parce que ça décide de la prochaine fois.**
15 rouges au total, tous reproduits dans le code avant correction, AUCUN faux positif. Trois d'entre eux
étaient le MÊME motif : une capacité livrée sans le chemin qui la produit (aucune route ne créait de
serveur, puis les outils n'apparaissaient sur aucun écran d'agent, puis ils n'y étaient pas rattachables).
Deux fois, un correctif avait cassé autre chose. Le nombre de rouges n'a PAS convergé vers zéro (6, 3, 2,
4), mais leur GRAVITÉ s'est effondrée : de la perte de données en production à une phrase fausse à l'écran.
C'est la gravité qui dit quand s'arrêter, pas le compte.

⚠️ **LA FENÊTRE FRONT / API EST REFERMÉE, et elle mérite d'être racontée.** Entre le push du bouton lecture et
le déploiement de l'API, Vercel servait un bouton que le serveur ne savait pas lire : le mot n'était pas
reconnu comme un jeton, donc pas consommé, et il descendait jusqu'à l'agent de Meta, qui répondait au
testeur. 🔴 **Règle pour la prochaine feature qui traverse cette frontière : ordonner les lots pour que le
FRONT parte en dernier.**

⚠️ **CE QUI A ÉTÉ VÉRIFIÉ DANS LE CONTENEUR, pas déduit du push.** Le module déployé a été exécuté dans
`mba-worker` : un lien sans suffixe rend `nodeId: null` (les liens déjà distribués marchent toujours), un
lien avec suffixe est lu, un mot recopié EN CAPITALES donne le bon bloc après résolution, et un message de
client ordinaire rend `null`, donc ne coûte aucune requête.

## CE QU'UNE SESSION SUIVANTE DOIT SAVOIR

- 🔴 **LE DÉPÔT EST PUBLIC** depuis le 2026-09-15 (GitHub Actions gratuit). Rien de sensible ne s'écrit ici.
- 🔴 **LA CI EST DÉCOUPÉE EN DEUX WORKFLOWS**, et l'asymétrie est volontaire : `ci-web.yml` ne part que sur
  `web/**`, mais `ci.yml` garde un `paths-ignore` et jamais un filtre positif, parce que 43 tests de la
  racine LISENT des fichiers de `web/`. `tests/ci-decoupage.test.ts` tient la règle ET sa raison.
- ⚠️ **LA MESURE DU 2026-09-15 SUR META ÉTAIT FAUSSE, ET LA CORRECTION COMPTE PLUS QUE L'ERREUR.** Ce fichier,
  trois commentaires de code et `CLAUDE.md` ont affirmé toute une journée que « Meta acquitte nos envois avec
  DEUX MINUTES de retard ». C'était une erreur de LECTURE : les heures relevées étaient celles où NOTRE worker
  traitait l'accusé. L'horodatage que Meta inscrit vaut la seconde de l'envoi, et son webhook arrive une
  seconde après. Les deux minutes venaient de la file `webhook-status`, qui se vidait à deux accusés par
  minute. Corrigé partout le 2026-09-15 au soir.

## CE QUI ATTEND UN ESSAI RÉEL

🔴 **Aucun des chemins livrés le 2026-09-15 et le 2026-09-16 n'a tourné sur un vrai échange.** Ils sont verts,
déployés, et éprouvés par mutation ; aucun n'est éprouvé tout court. ⚠️ Et Julien a signalé le 2026-09-16 que
les numéros des deux incidents ne sont pas les siens : **il ne peut pas rejouer ces deux cas-là**, ce qui
déplace le poids sur la revue et sur les vérifications faites contre les vraies données.

### 1. L'agent de Meta répond après un silence

Écrire depuis un numéro dont la conversation dort depuis des jours : l'agent doit répondre, quel que soit le
délai et quel que soit le canal du dernier échange. Puis **répondre à un scénario qui pose une question** : le
scénario doit avancer et l'agent rester MUET. C'est cette troisième vérification qui prouve qu'on n'a rien
cassé, et c'est la plus importante des trois.

⚠️ **Ce qui peut être rejoué sans les numéros des clients** : mettre la conversation d'un numéro qu'on
contrôle dans l'état exact de l'incident (`app_workflow` + `control_changed_at` à null), ce qui est une
écriture réversible, puis écrire depuis ce numéro.

### 2. Le journal d'audit

Inviter quelqu'un, changer son rôle, créer puis révoquer une clé d'API, et ouvrir Sécurité > Audit : les
quatre lignes doivent y être, avec le bon auteur et le bon horodatage, et **aucune ne doit porter d'email
ailleurs que dans la colonne auteur**.

### 3. Tester un scénario À PARTIR D'UN BLOC : ✅ ÇA MARCHE depuis le 2026-09-16 au soir

✅ **CONFIRMÉ PAR JULIEN le 2026-09-16 au soir : « ça a marché, le scénario est parti ».** C'est le geste 1
de la liste ci-dessous, et il a fallu DEUX essais ratés pour y arriver.

🔴 **CE QUE CES DEUX ESSAIS ONT TROUVÉ, ET QU'AUCUN TEST N'AURAIT TROUVÉ.** L'agent de Meta tenait le fil,
il répondait « je n'ai pas bien compris votre message », et le test ne démarrait jamais. Mesuré en base :
zéro parcours créé, conversation même pas marquée comme test. **Cause réelle : le message arrivait sur le
canal `standby`**, que le chemin du jeton refusait. Or `standby`, c'est Meta qui dit « mon agent tient ce
fil » : exactement la situation où il faut la lui reprendre.

⚠️ **ET LE PREMIER ESSAI N'AVAIT LAISSÉ AUCUNE TRACE** : quatre sorties muettes, cause indéterminable. Ce
qui a résolu l'affaire n'est pas un correctif, c'est de rendre ces sorties bavardes : le scan suivant a
nommé la cause en une ligne. Les trois leçons transversales sont dans `brain/LEARNINGS.md` au 2026-09-16.

**Les trois gestes qui restent dus** (le 1 est fait) :

⚠️ **La revue finale du 2026-09-16 a attesté le CODE, pas l'usage.** L'essai ci-dessous est matériellement
impossible avant le déploiement du VPS, et la skill refusait d'écrire l'attestation tant qu'il manquait :
Julien a tranché « on atteste le code, l'essai reste dû ». Tant que ces quatre gestes n'ont pas eu lieu,
**cette feature n'est pas close**, et personne ne doit écrire le contraire ailleurs.

Quatre gestes, et le troisième est le seul qu'aucun test ne remplace :

1. **Cliquer le bouton lecture d'un bloc AU MILIEU d'un scénario**, scanner le QR, envoyer : c'est CE
   message-là qui doit arriver, pas le premier du scénario.
2. **Modifier le brouillon SANS publier**, recliquer le même bloc : le test doit suivre la modification.
3. 🔴 **Atteindre un bloc d'attente ou une question et RÉPONDRE** : le parcours doit continuer sur le
   BROUILLON. C'est la vérification du défaut que la migration 0151 répare, et elle ne se fait qu'à la main.
4. **Cliquer un bloc d'un scénario publié SANS brouillon en attente** : ce cas ne doit rien casser.

⚠️ **Et regarder la bulle WhatsApp** : `test-a7k2m9p3.<uuid>` ressemble à un nom de domaine, WhatsApp va
probablement l'afficher en lien bleu. Ça ne change pas le texte envoyé, mais personne ne l'a encore vu.

### 4. « Ça pousse ou ça intègre » (migration 0150), toujours dû depuis le 2026-09-15

Donner `testadd` (`POST /subscriber/add-tag`) à un agent IA en « ça pousse », l'essayer depuis le bac à sable,
puis **vérifier dans UChat que l'étiquette est réellement posée**. Refaire avec un appel qui intègre, cocher un
champ, vérifier que la valeur remonte mot pour mot. ⚠️ Un `POST` reste SIMULÉ au bac à sable (seul un GET qui
intègre, sans donnée du contact, y part pour de vrai depuis le 2026-10-05) : l'étiquette ne se vérifie que dans une
vraie conversation. Le bac à sable rendait zéro champ pour tout connecteur jusqu'au 2026-10-05 : réparé.

## UN POINT D'ÉCRAN QUI RESTE À FAIRE

La section des connexions échouées devra **dire qu'elle ne montre que les tentatives sur des comptes
existants**. `audit_log.tenant_id` est NOT NULL : une tentative sur une adresse inconnue n'appartient à aucun
espace et ne peut pas s'écrire. Sans cette phrase, on lira « aucune tentative » alors qu'il y en a eu.
