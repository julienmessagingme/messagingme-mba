# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.** Vidé pour la sixième fois le 2026-09-16 :
> il annonçait encore `93a10c4` et répétait une mesure démentie depuis (voir plus bas).

## L'ÉTAT EXACT, AU 2026-09-23

| | |
|---|---|
| `origin/main` | voir `git log` (ce fichier ne recopie plus un SHA, il a menti six fois) |
| VPS (`mba-api`, `mba-worker`, `mba-web`) | ✅ **À JOUR AU 2026-09-23 vers 9 h 15** : les trois lots que la production n’avait pas, soit 21 commits, relus et déployés d’un bloc par une session qui n’en avait écrit aucun (les publicités Click-to-WhatsApp « Capter » ; l’activation d’un numéro que l’Embedded Signup v4 laisse non vérifié ; les jaunes de coûts et d’Inbox). Le SHA n’est pas recopié ici (`git log` et `.git/revue-finale.json` font foi). **Migration 0163 appliquée AVANT le `up`** ; 0164 et 0165 l’étaient depuis la veille 20 h 49. Le compteur qui fait foi est celui de `CLAUDE.md`, relu en base après `migrate`. |
| Vercel (`engageme`) | suit `origin/main` tout seul |
| Migrations | 🔴 **LE COMPTEUR N'EST PAS ICI, IL EST DANS [CLAUDE.md](CLAUDE.md), SECTION DÉPLOIEMENT.** Cette ligne l'a recopié et l'a eu FAUX (elle annonçait 0151 quand la base portait 0152, neuvième dérive), exactement comme `PLAN.md` et `brain/PROJECTS.md` avant elle. En cas de doute, c'est la BASE qui tranche : `select name from public.schema_migrations order by name desc`. |
| CI | ✅ verte job par job, lue sur `gh run view <id> --json jobs` et jamais sur le code de sortie du watch. ⚠️ **Elle est passée ROUGE une fois le 2026-09-17**, sur le seul job qui voit une base (`integration`), pour un test qui laissait de la donnée derrière lui : la cause et la parade sont dans la section Performance Lab |
| Revue finale | ✅ **ATTESTÉE, 0 rouge, 4 jaunes**, sur `9c29257a` (rapport `docs/prive/REVUE-FINALE-2026-09-23-deploiement.md`). Vérifié par moi et pas sur le rapport d’un pair : typecheck propre, **6294 tests unitaires verts**, CI relue JOB PAR JOB sur le dernier commit de code, et surtout l’état RÉEL de la base, qui a démenti le « trois migrations en attente » d’un message inter-session. Les 4 jaunes sont préexistants ou déjà déclarés par leurs auteurs. |
| Contrôle public | ✅ **Les cinq portes publiques à 200** après le déploiement du 2026-09-23 : `/health` et `/live` sur `api.`, le chemin `/api/backend/` de `mba.` qui porte le webhook Meta, la console Vercel, l’ancienne console. `nginx -s reload` posé APRÈS l’attente de `healthy`, jamais enchaîné au `up` (leçon du 2026-09-08) : aucun 502 cette fois. ⚠️ Et les deux routes neuves répondent **401, pas 404** : montées et gardées, donc la fenêtre Vercel/API est fermée. |

## PUBLICITÉS CLICK-TO-WHATSAPP (LOT 1 « CAPTER » ÉCRIT LE 2026-09-22, PAS ENCORE DÉPLOYÉ)

Spec `docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md`, plan
`docs/superpowers/plans/2026-09-22-pubs-ctwa-lot1-capter.md`.

- Lot 1 « Capter » : arrivées publicitaires (`arrivees_pub`, `ctwa_clid` compris) et tarifs de Meta
  (`tarifs_meta`) gardés à la réception, 72 h gratuites exclues de toute lecture de coût, `ctwa_clid` effacé
  par la purge RGPD. Migration 0163 à appliquer AVANT le déploiement. ⚠️ La capture des arrivées n'est PAS
  éprouvée : aucun clic réel n'est encore arrivé. Elle le sera pendant l'essai réel du lot 3 (première
  campagne MessagingMe créée depuis Engage Me).
- ⚠️ L'attestation locale (`.git/revue-finale.json`) couvre À TORT les commits de ce lot : une autre session l'a
  posée sur `HEAD` pendant qu'ils arrivaient. La revue finale de ce déploiement part du dernier commit
  réellement relu, celui des lots 3 et 4 des outils maison.
- Lot 2 « Connecter » : attend les prérequis Meta de la spec, § 11.

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
`docs/superpowers/plans/2026-09-21-relais-mba.md`) : Meta appelle `POST /mba/relais/outils/:id`, Engage Me
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

## 🔴 INBOX : « TRAITÉ », PIÈCES JOINTES, « JE M'EN OCCUPE » (2026-09-19, DÉPLOYÉ, ESSAI RÉEL DÛ)

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
3. Créer un compte agent, activer « Les agents peuvent prendre une conversation non affectée » dans
   Paramètres DEPUIS UN COMPTE MANAGER, et vérifier que l'agent voit « Je m'en occupe » sur une conversation
   non affectée, rien sur celle d'un collègue ; et que le manager peut affecter à quelqu'un (son menu était
   vide jusqu'au 2026-09-19).

⚠️ **À SIGNALER, HORS DE CE CHANTIER** : le VPS tournait sur `0482ae0` (chantier des moments d'un agent IA,
déployé le 2026-09-18 au soir par une autre session) alors qu'aucune attestation de revue finale n'était
enregistrée dans ce dépôt pour ses 25 commits. Ce déploiement-ci n'a fait relire que ce qui le suit.

## 🔴 PERFORMANCE LAB : LES COÛTS ET L'ANALYSE (2026-09-17, POUSSÉ, RIEN DE DÉPLOYÉ)

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

**Engage Me sait se brancher sur un serveur MCP tiers, importer son catalogue et exposer ses outils à un
agent IA.** Le lot est EN PRODUCTION : routes montées et gardées (401 et non 404), migration 0152 déjà en
base (`migrate` a répondu « à jour, rien à appliquer »), contrôle public vert.

🔴 **L'ESSAI RÉEL N'A PAS ÉTÉ FAIT, ET IL SEUL CLÔT LA FEATURE.** Engage Me branché sur NOTRE propre serveur
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

### 3. Tester un scénario À PARTIR D'UN BLOC — ✅ ÇA MARCHE depuis le 2026-09-16 au soir

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
champ, vérifier que la valeur remonte mot pour mot. ⚠️ Le bac à sable est à revérifier en particulier : il
rendait zéro champ pour tout outil de connecteur depuis le 2026-09-02.

## UN POINT D'ÉCRAN QUI RESTE À FAIRE

La section des connexions échouées devra **dire qu'elle ne montre que les tentatives sur des comptes
existants**. `audit_log.tenant_id` est NOT NULL : une tentative sur une adresse inconnue n'appartient à aucun
espace et ne peut pas s'écrire. Sans cette phrase, on lira « aucune tentative » alors qu'il y en a eu.
