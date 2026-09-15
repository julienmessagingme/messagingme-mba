# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **VIDÉ POUR LA CINQUIÈME FOIS le 2026-09-13 au soir**, et le chiffre est le sujet. Il avait atteint
> 245 lignes en portant SIX chantiers déjà déployés, c'est-à-dire en redevenant une archive. La règle n'est
> pas « y penser », c'est : **un lot déployé n'a aucune raison d'attendre ici**.
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.**

## 🔴 L'ÉTAT EXACT, AU 2026-09-15 AU MATIN

| | |
|---|---|
| `origin/main` | `4474dd9` |
| VPS (`mba-api`, `mba-worker`, `mba-web`) | `4474dd9` : **déployé le 2026-09-15 vers 2 h**, aucun écart |
| Dernière CI de CODE | ✅ verte, **quatre jobs lus un par un** (`integration` compris) |
| Vercel (`engageme`) | suit `origin/main` tout seul, à chaque push |
| Migrations | **0144 à 0148 appliquées**, relues en base après `migrate`. **Prochaine libre : 0149** |
| Contrôle public | ✅ les quatre noms à 200, **aucun 502 sur les deux déploiements** |

## ✅ LES QUATRE LOTS DES ASSISTANTS SONT LIVRÉS ET DÉPLOYÉS (2026-09-15, en autonomie)

Le plan : [docs/superpowers/plans/2026-09-14-assistants-conversationnels-evolution.md](docs/superpowers/plans/2026-09-14-assistants-conversationnels-evolution.md).
Treize tâches, quatre lots, une revue entre chaque et une revue finale. Le fonctionnel est dans
`features.md` ; ce qui suit est ce qu'il faut savoir pour reprendre.

🔴 **CE QUE LA REVUE FINALE A TROUVÉ, ET QUI VALAIT LE PLUS CHER** : l'assistant d'agent IA dépensait NOTRE
argent **sans plafond**. Il est passé sur la clé maison au lot A, et le plafond n'a été câblé que sur
l'assistant du MBA, alors que le commentaire du câblage annonçait lui-même que « les deux moitiés de cette
décision vont ensemble, l'une sans l'autre est dangereuse ». Les deux partagent désormais la même enveloppe
(`ASSISTANT_PLAFOND_EUROS_MOIS`, 2 € par ESPACE et par mois, `assistant_depense_mois`).

🔴 **ET UNE SONDE SUR LA PRODUCTION A TROUVÉ CE QU'AUCUN TEST NE POUVAIT VOIR** : le branchement d'outil
proposé par l'assistant appelait `/outils/...` quand la route s'appelle `/tools/...`. Tous les tests montent
le module Fastify directement, donc aucun n'emprunte le chemin HTTP. Corrigé, et tenu par un test qui compare
segment pour segment ce que le serveur déclare et ce que le navigateur appelle.

⚠️ **LE FICHIER D'INTÉGRATION DU LOT A N'AVAIT JAMAIS TOURNÉ** : son `beforeAll` créait un agent sans
`mention_ia` (NOT NULL sans défaut), donc TOUT le fichier échouait, et un second défaut se cachait derrière
(un `insert` à sept colonnes et six valeurs, qui faisait passer un test pour la mauvaise raison). Les deux
sont réparés, `integration` est vert.

### 🔴 CE QUI RESTE : L'ESSAI RÉEL

Rien n'a été essayé sur un vrai numéro. À faire sur **+33 5 25 68 02 50**, dans cet ordre :

1. **Onglet Assistant du MBA** : lui demander d'ajouter une FAQ, vérifier que le diff la nomme, appliquer,
   la retrouver dans l'onglet FAQ. Puis lui demander d'en supprimer une : le diff doit la signaler à part.
2. **Joindre un document** (PDF ou .docx) depuis l'assistant : rien ne doit partir chez Meta avant
   « Appliquer », et le fichier doit apparaître dans l'onglet Fichiers après.
3. **Onglet Historique** (MBA puis agent) : les gestes ci-dessus doivent y figurer, avec **votre adresse**.
4. **Onglet Construire en parlant** d'un agent DÉJÀ construit : il ne doit plus proposer d'écrire des champs
   dont personne n'a parlé. Lui demander de brancher un outil de la bibliothèque, et vérifier dans l'onglet
   Outils qu'il est branché mais **PAS activé**.
5. **Vider un champ** (le ton, par exemple) dans l'onglet Identité, puis rouvrir la conversation : il doit le
   signaler, sans reposer tout l'entretien.

⚠️ **Ce qui n'est PAS encore journalisé** : les créations et modifications faites à la main dans les onglets.
Seules les suppressions le sont, par ordre de priorité assumé, et **l'écran le dit**. Détail et liste des
routes à couvrir : `todo.md`.

⚠️ **LE 502 PUBLIC EST QUASI SYSTÉMATIQUE.** Douze déploiements sur treize entre le 2026-09-13 et le
2026-09-14 : conteneurs `healthy`, appel interne à 200, appel public à 502. Réparation :
`sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`.

⚠️ **ET LE TREIZIÈME N'EN A PAS EU**, sans qu'on sache pourquoi. C'est la première fois. Ça ne change rien à
la règle : le contrôle public après CHAQUE `up --build` reste obligatoire, puisque c'est la seule façon de
voir ce défaut.

🔴 **ET UN SEUL RELOAD NE SUFFIT PAS TOUJOURS** (vu DEUX fois le 2026-09-13, dont le déploiement de la
tâche 7) : le contrôle public juste après rendait encore 502, le second reload l'a réglé. Le reload rend `0`
dans les deux cas, donc il ne dit rien. La séquence est : contrôler, réparer, **RE-CONTRÔLER**, recommencer
si besoin.

## ✅ LE PLAN DE L'API EST FINI, essai réel compris (2026-09-14 au soir)

🔴 **L'ESSAI RÉEL A TROUVÉ CE QU'AUCUN TEST VERT NE MONTRAIT**, et c'est la seule chose qui justifie de le
faire. Dix lots de 500 lancés simultanément sur la production : cinq refusés en 429, comme prévu, mais
`/ops/usage` affichait **`refusees = 0` et 5 005 unités dont 2 500 n'avaient jamais été travaillées**. Le
commentaire du code promettait exactement l'inverse. Corrigé (`ef42289`), figé par trois cas, redéployé,
puis **re-mesuré sur la vraie API** : trois refusés, `refusees = 3`, `unites = 3 500`.

⚠️ **UN SEUL GESTE N'A PAS ÉTÉ FAIT, DÉLIBÉRÉMENT** : l'envoi de 50 destinataires. `DRY_RUN=false`, donc
ce serait de vrais messages à de vraies personnes. Il demande un numéro de test et des destinataires
consentants, c'est-à-dire une décision de Julien.

⚠️ **ET LA CLÉ D'ESSAI (`testsecu2`, espace Demo) EST À RÉVOQUER** : elle a circulé en clair. Écran
Developers > Clés d'API, bouton « Révoquer ».

Les contacts et le champ personnalisé créés par l'essai ont été retirés de la base.

## 🔴 CE QUI VIENT ENSUITE

Les arbitrages ci-dessous, et les **huit essais réels** qui n'ont toujours pas été faits (opt-out, poussée
vers un système tiers, politique d'annonce d'IA, journal des erreurs système, chaîne de repli, traduction,
récap d'hier, créer un scénario depuis une campagne). Celui de l'API vient de montrer ce que ça rapporte.

✅ **DÉPLOYÉ le 2026-09-14 au soir**, sans migration (aucune n'est en jeu, la base reste à 0143). Contrôlé
après coup plutôt que déduit : le code neuf est DANS l'image (`usage-guard.ts`, `FORMAT_CLE`, la route du
verrou), le format de clé refuse `mba_x` en 401 depuis l'extérieur, `GET /ops/usage` répond avec le jeton
et 401 sans, le webhook Meta rend bien 403 sur un jeton faux (donc la route vit), et les journaux des deux
conteneurs ne portent aucune erreur depuis le redémarrage.

🔴 **LE 502 EST REVENU, ET IL A FALLU DEUX RELOADS** : conteneurs `healthy`, appel interne à 200, appels
publics à 502 sur les deux noms. Le premier `nginx -s reload` n'a réparé que `mba.` ; le second a réparé
`api.`. C'est exactement le cas documenté (« un seul reload ne suffit pas toujours »), et c'est pour ça que
la séquence est : contrôler, réparer, RE-CONTRÔLER, recommencer.

### Ce que les quatre lots ont fermé

| Lot | Ce qui était ouvert | Ce qui le ferme |
|---|---|---|
| 1 | la route **castait** le corps du batch : un `null` emportait le lot entier en 500, `fields` en chaîne créait un champ perso PAR CARACTÈRE | un schéma Zod, le type DÉRIVÉ de lui, l'erreur rendue à SON index |
| 1 | l'auto-création de champs n'avait **aucune borne** | trois bornes configurables, mesurées sur la production (défauts 5 à 20 fois au-dessus de l'usage réel) |
| 2 | une fausse clé coûtait un SHA-256 **et une requête Postgres**, comptée par aucun plafond | le format exact avant la base, plus un budget global de lookups spéculatifs |
| 3 | **aucun compteur d'usage n'existait** : la seule trace était un `last_used_at` écrasé | le garde d'usage, en OBSERVATION, lisible sur `GET /ops/usage` |
| 4 | rien ne comptait les requêtes lourdes **en vol** (8 connexions au pool, 4 demandées par lot) | un plafond de 2 lourdes simultanées, 429 + `Retry-After` |
| 4 | le verrou d'espace n'était **lu ni par `/v1` ni par `/mcp`**, et **écrit nulle part** | la garde de clé le lit, `POST /ops/verrou/:tenantId` le pose, le runbook dit ce qu'il ne coupe pas |

🔴 **DEUX FOIS, L'EXÉCUTION A CORRIGÉ LE PLAN, ET LE PLAN LE DIT MAINTENANT.** Sa tâche 3 demandait un
limiteur « indexé sur l'empreinte du bearer » : mesuré faux par un test (trente clés différentes font
trente compteurs à 1, et les trente requêtes partent). Et son compte de symboles morts (34) valait pour un
autre jour : le compte réel était 17 côté serveur, dont 12 dans les tests.

### Les arbitrages qui t'attendent

- **les seuils de quota** : le garde compte, il ne refuse rien. Les chiffres viendront de ce que
  `GET /ops/usage` montrera des vrais clients, pas d'une intuition ;
- **le plafond de clés par espace**, et **les coûts à notre charge** (dont la recherche sémantique sans
  compteur) ;
- **les garde-fous RCS**, restés ouverts depuis l'arbitrage du 2026-09-14. Il est écrit sur des MESURES : l'audit Codex du 2026-09-13 a été
   vérifié affirmation par affirmation (94 constats, 76 vrais, 9 faux, 7 partiels, 2 périmés), et le plan
   ne retient que ce qui tient. Il dit aussi ce qu'il REFUSE, avec sa raison.

🔴 **TROIS ARBITRAGES DE JULIEN Y SONT INSCRITS** (2026-09-14) : tout le niveau A d'affilée ; les champs
personnalisés créés par l'API restent auto-créés mais **bornés** ; le verrou d'espace est **étendu à `/v1`
et `/mcp`**, et le geste qui le pose vivra sur `/ops`.

⚠️ **ET DEUX MESURES ONT CHANGÉ LA FORME DU TRAVAIL.** Le verrou `locked` est LU dans `makeRequireAuth`
mais **écrit nulle part** : « l'étendre » demande donc aussi de créer le moyen de le poser. Et le repli RCS
sur notre clé smsmode **n'est pas réalisé** : un seul agent en production, et il a sa propre clé.

## ✅ CE QUI VIENT D'ÊTRE FINI : une question à la fois dans l'assistant de campagne (2026-09-14)

Correction demandée par Julien, livrée avant l'audit comme il l'avait rangée. Trois changements de
parcours, plus une garde au point d'envoi :

- **l'étape Canal ouvre sur sa seule question**, sans réponse pré-cochée. Le canal n'a plus de défaut, le
  bouton « Suivant » y est gardé et l'écran dit pourquoi. Le réessai et la question des heures ouvrées
  n'apparaissent qu'ensuite ;
- **la question du devenir attend TOUT le contenu**, étage de repli compris (elle ne regardait que le
  rang 1) ;
- **elle disparaît quand chaque étage ouvre un scénario**, avec sa raison à la place : « la logique qui
  répond, est-ce un agent IA ou un collab, est gérée dans le scénario ». Un seul étage hors scénario la
  repose ;
- 🔴 **et `entreeDeCreation` n'emporte plus l'assignation quand la question n'est pas posée**. Masquer
  n'efface pas : le serveur applique ce réglage à l'arrivée de chaque réponse, scénario ou pas.

⚠️ **RELEVÉ EN PASSANT, ET IL ATTEND TON ARBITRAGE** (porté dans `todo.md`) : sur les trois réponses de
cette question, **une seule voyage jusqu'au serveur**. `devenir` et `agentId` ne sortent pas de l'écran,
`campaigns` n'a aucune colonne pour eux. Choisir « un agent IA prend la main » ne change donc rien
aujourd'hui, et l'écran fait pourtant désigner un agent dans une liste.

## ✅ CE QUI VIENT D'ÊTRE FINI : chantier 6, le centre de Sécurité & compliance

[spec](docs/superpowers/specs/2026-09-13-centre-securite-design.md) ·
[plan](docs/superpowers/plans/2026-09-13-centre-securite.md)

🔴 **LES NEUF TÂCHES SONT LIVRÉES, RELUES ET DÉPLOYÉES** (`79415a8`). Le menu et sa page d'accueil, les deux
journaux déménagés, l'inventaire des chemins d'envoi, le blocage réel de l'opt-out sur tous les chemins
automatiques, l'écran Consentement, la règle élargie en observation, la poussée du refus vers le système du
client, le sous-menu IA au niveau de l'espace, et la moitié SYSTÈME du journal des erreurs.

⚠️ **CE QUI RESTE DÛ EST ENTIÈREMENT DES ESSAIS RÉELS**, ci-dessous. Rien de ce chantier n'a jamais été
exercé par un humain sur un vrai téléphone ni contre un vrai système tiers.

## 🔴 CE QUI N'A JAMAIS TOURNÉ SUR DE VRAIES DONNÉES

🔴 **C'EST LA SEULE CHOSE QUI RESTE VRAIMENT À FAIRE, ET C'EST LE SEUL VRAI RISQUE.** Tous les lots sont
livrés, relus, déployés et verts. HUIT essais attendent, dont aucun ne demande de code : il faut un
téléphone, un compte, et quelqu'un qui regarde. Un mécanisme qui n'a jamais tourné sur de vraies données
n'est pas éprouvé, il est seulement vert.

- **L'opt-out** : écrire « stop » depuis un vrai téléphone, constater le passage en opt-out, **puis tenter
  d'atteindre ce contact par un scénario ET par une automation**. Puis l'essai inverse, celui qui protège
  l'usage : un opérateur doit encore pouvoir lui répondre à la main.
- **Le récap d'hier** : ouvrir le bot avec un compte admin, cliquer, et **RECOMPTER À LA MAIN** les
  conversations de la veille. Puis rouvrir en `agent` et vérifier que le bouton n'est pas là.
- **La chaîne de repli** : aucune n'a jamais basculé. Zéro campagne à deux étages, zéro joignabilité mesurée.
  Une campagne à deux étages sur le numéro de Julien, avec un destinataire volontairement injoignable.
- **La traduction** : aucun message étranger n'a jamais été traduit. Un message espagnol reçu, lu en
  français, puis une réponse traduite, avec le contrôle EN BASE que `body` porte ce qui est PARTI et
  `redaction_origine` ce que l'opérateur a écrit.
- **Créer un scénario depuis une campagne** : le publier, vérifier qu'il apparaît dans l'onglet Scénario, et
  lancer la campagne sur un vrai numéro.
- **Le journal des erreurs système** (tâche 9, déployée) : casser volontairement un connecteur (une adresse
  fausse dans Tools), faire jouer un bloc « Appel HTTP » d'un scénario, et **constater la ligne dans
  Sécurité > Journal des erreurs**, section « Erreurs système », avec le bon appelant et le bon code. Puis le
  même essai avec une adresse qui ne répond jamais, pour voir « n'a pas répondu à temps » plutôt qu'une
  erreur. ⚠️ Le journal est VIDE en production (mesuré : zéro ligne partout), donc l'écran n'a jamais été vu
  avec des données.
- **La politique d'annonce d'IA** (tâche 8, déployée) : ouvrir Sécurité > IA, passer l'espace à
  « à chaque message », écrire à l'agent depuis un vrai téléphone et **constater la phrase à chaque réponse**.
  Puis repasser à « une fois par conversation » et vérifier qu'elle ne part qu'au premier tour. ⚠️ Ce chemin
  n'a jamais tourné : le réglage existait depuis le 2026-09-09 sans qu'aucun essai réel ne l'ait exercé.
- **La poussée d'un opt-out vers un système tiers** (tâche 7, déployée) : déclarer un appel dans
  Tools > Connecteurs API vers un point de réception qu'on peut observer, le brancher depuis
  Sécurité > Consentement, écrire « stop » depuis un vrai téléphone, et **constater l'appel arrivé avec le
  bon numéro**. Puis l'essai qui compte autant : **débrancher le connecteur, ou le casser, et vérifier que
  l'opt-out est quand même posé**. C'est la promesse du lot, et elle ne vaut que mesurée.

⚠️ **UN POINT À REGARDER au premier essai d'un étage RCS avec scénario** : le contact reçoit le message de
l'étage **puis** le premier message du scénario, puisque les scénarios proposés là ouvrent par un envoi.
C'est la lecture littérale de « message plus scénario », mais ça se juge à l'usage.

## 🔴 UN ARBITRAGE EN ATTENTE : « arrêt maladie » désabonne aujourd'hui

Mesuré le 2026-09-13 **sur la règle qui agit déjà en production** :

```
"arrêt maladie" -> true   "arrêt du traitement" -> true
"arrêt de bus"  -> true   "stop covid" -> true   "stopper la commande" -> true
```

Le docblock d'`estDemandeArret` citait pourtant « arrêt de bus » comme un cas **évité** par l'ancrage : c'est
faux, la phrase COMMENCE par « arrêt ». **Gan Prévoyance est un assureur, en production** : « arrêt maladie »
y est un message ordinaire, et la personne cesserait de recevoir sans que personne ne le sache.

⚠️ **La règle n'a PAS été modifiée** : resserrer l'ancrage ferait perdre « stop merci », qui est un vrai
refus. C'est un choix produit. Le docblock faux est corrigé, et `tests/consentement-observation.test.ts` fige
le comportement ACTUEL en NOMMANT chaque cas, pour que celui qui le changera voie la liste de ce qu'il change.

## 🔴 CE QUE LA REVUE DU CHANTIER 6 A TROUVÉ (2026-09-14)

Cinq défauts, tous déployés, tous corrigés. Ils se ressemblent tous.

🔴 **UNE JUSTIFICATION CRUE PLUTÔT QUE MESURÉE, ET ELLE S'EST PROPAGÉE.** Un commentaire de câblage
affirmait « scénario, automation et agent IA passent par cet exécuteur ». Faux pour l'agent : sa réponse part
par `client.sendText` directement. **Un contact désabonné recevait donc encore les réponses de l'agent IA.**
La phrase avait été recopiée dans le verdict du test d'inventaire, dans `features.md`, et sur l'écran de
conformité que le client lit. Elle a survécu à une revue, à un test de câblage et à un déploiement.

🔴 **UN INVENTAIRE NE PROUVE QUE LA LISTE, JAMAIS LES VERDICTS.** `tests/optout-chemins.test.ts` avait bien
TROUVÉ le fichier fautif, et l'avait classé « bloqué ». Le classement a été écrit par la même main que la
garde, dans la même heure, depuis la même croyance.

🔴 **UNE GARDE SERVEUR QUI NOMME UN RÔLE SANS QUE LA CONSOLE Y MÈNE N'EST PAS UNE CAPACITÉ, C'EST UNE
PROMESSE.** La route des désabonnés nommait `manager` et aucun manager ne pouvait l'atteindre. Trouvé par le
relecteur indépendant, pas par moi. Tranché par Julien le jour même, et corrigé des deux côtés.

🔴 **UN INDEX PARTIEL SANS REQUÊTE EST UNE JUSTIFICATION FAUSSE INSCRITE DANS LE SCHÉMA.** Celui de 0139 ne
servait rien. Le coût n'était pas le sujet : le prochain lecteur l'aurait cru et se serait autorisé à
élargir un `where` en pensant rester dans son contrat.

⚠️ **ET LE MÊME MOTIF, UNE FOIS DE PLUS, EN CORRIGEANT** : ouvrir la console aux managers a filtré la barre
sans rien montrer, parce qu'un SECOND contrôle de rôle était écrit en dur dans le rendu. Seul l'e2e l'a vu.

## Ce que la session du 2026-09-13 a appris

🔴 **`abort()` n'annule pas ce que le SERVEUR a déjà lancé.** Un rafraîchissement toutes les 4 s, une
traduction qui s'accorde 20 s : chaque tour fermait la connexion du navigateur, jamais l'appel au modèle,
déjà parti et déjà facturé. Mesuré par mutation : quatre traductions payées en treize secondes. **Dès qu'un
rafraîchissement périodique déclenche un traitement plus long que sa période, le tour suivant PASSE SON
TOUR, il n'annule pas.** (Aussi dans `brain/LEARNINGS.md`.)

🔴 **UNE LISTE ÉCRITE À LA MAIN DÉRIVE, MÊME QUAND ELLE EST LE GARDE-FOU.** L'inventaire des chemins d'envoi
citait six méthodes quand le client Meta en expose HUIT ; il passait quand même, parce que les fichiers
concernés en appelaient d'autres par ailleurs. **Une liste qui définit un périmètre de sécurité se DÉRIVE du
code qui la définit** (ici `src/meta/client.ts`), sinon elle protège de ce qu'on avait en tête le jour où on
l'a écrite.

🔴 **UN INVARIANT ÉNONCÉ DANS UNE MIGRATION SE TIENT PARTOUT OU NULLE PART.** La migration 0138 écrit
« la date se remet à null au réabonnement » ; je ne la tenais que sur trois chemins d'écriture sur quatre,
le quatrième étant un upsert qui fait régresser un statut sans qu'on y pense. **Écrire un invariant, c'est
énumérer ses écritures, pas celles auxquelles on pense.**

🔴 **UN TEST QUI DÉSIGNE UNE PAGE (un `goto`) NE NOMME AUCUN SYMBOLE.** En déplaçant deux écrans, aucun
`grep` sur le composant ni sur son `data-testid` ne trouvait l'e2e qui les rejoignait par `/parametres` :
il n'a rougi qu'en CI. Même famille que le test qui désigne par LIBELLÉ. **Quand on DÉPLACE un écran, les
dépendants ne se lisent pas dans les imports, ils se lisent dans les `goto`.**

🔴 **UN `not.toHaveBeenCalled()` PASSE AUSSI QUAND RIEN NE SE PRODUIT.** Un test de garde écrivait `{ text }`
là où un bloc lit `body` : il ne produisait aucune action, et il validait donc du code sans garde. **Tout
test de blocage porte son TÉMOIN dans l'autre sens**, sinon il ne prouve que sa propre maladresse.

⚠️ **« Par cohérence » n'est pas une raison de transporter une donnée.** Les variables du rang 1 partaient
avec le scénario d'un étage de repli, parce que la branche voisine le faisait. Elles décrivent un autre
modèle : Meta refuse, ou remplit le bon nombre de trous avec les mauvaises valeurs.

🔴 **UNE JUSTIFICATION CRUE PLUTÔT QUE MESURÉE A TENU UNE JOURNÉE ENTIÈRE, ET C'EST LE DÉFAUT LE PLUS GRAVE
DU CHANTIER.** Un commentaire de câblage affirmait « scénario, automation et agent IA passent par cet
exécuteur ». C'était faux pour l'agent, dont la réponse part par `client.sendText` directement. Cette phrase
a été RECOPIÉE dans le verdict du test d'inventaire, dans `features.md`, et sur l'écran de conformité que le
client lit. Elle a survécu à une revue, à un test de câblage et à un déploiement. **Un chemin d'envoi se
SUIT, il ne se déduit pas d'un voisinage.**

🔴 **ET UN INVENTAIRE NE PROUVE QUE LA LISTE, JAMAIS LES VERDICTS.** `tests/optout-chemins.test.ts` avait
bien TROUVÉ le fichier fautif ; il l'avait classé « bloqué » avec la justification fausse. Le test garde
l'exhaustivité, pas la justesse, parce qu'il a été écrit par la même main, dans la même heure, depuis la
même croyance.

🔴 **`git checkout <fichier>` SUR UN FICHIER NON COMMITÉ DÉTRUIT LE TRAVAIL, ET JE L'AI FAIT.** En restaurant
trois fichiers après une mutation, j'ai effacé une heure de travail non commité. Deux ont été récupérés
depuis des copies `/tmp` prises avant la mutation ; le troisième a dû être réécrit. **La parade est de
commiter AVANT de muter**, pas de se fier à `git checkout` comme à un « annuler » : pour du travail non
commité, il n'annule pas la mutation, il annule TOUT.

🔴 **UNE ÉTAPE « INVENTORIER AVANT D'AGIR » N'EST PAS UNE PRÉCAUTION, C'EST ELLE QUI TROUVE LE SUJET.**
Celle de la tâche 9 a corrigé le plan sur deux points : ce qu'il demandait d'ajouter y était déjà, et le vrai
trou était ailleurs (une table écrite depuis des semaines et lue par personne). Sans elle, on aurait
journalisé plus, à côté.

🔴 **DEUX MIGRATIONS POUSSÉES ENSEMBLE NE S'APPLIQUENT PAS ENSEMBLE.** 0140 ajoute et reprend (avant le
déploiement), 0141 retire (après). Mais les migrations vivent DANS L'IMAGE et `migrate` applique TOUT ce
qu'il y trouve : un `build` puis un `migrate` les aurait passées d'un coup, et la colonne serait tombée
pendant que l'ancien code la lisait encore. **La parade est de mettre la migration différée DE CÔTÉ sur le
VPS avant le build**, de la remettre après le déploiement, et de reconstruire l'image pour elle seule.

🔴 **UN CHAMP QUI DÉMÉNAGE SE REFUSE, IL NE S'AVALE PAS.** `z.object()` retire une clé inconnue EN SILENCE :
un onglet resté ouvert sur l'ancienne console aurait continué d'envoyer le réglage sur le PATCH d'agent,
aurait reçu 200, et le choix du client aurait été perdu sans un mot. La route rend 400 en DISANT où il est
parti. **Un déménagement se garde des deux côtés : l'écran renvoie, et l'API refuse.**

🔴 **UN NOMBRE ÉCRIT À LA MAIN DANS UN COMMENTAIRE EST FAUX AVANT D'ÊTRE LU.** Trois exemplaires trouvés en
une soirée : « DEUX appelants » de `creerAppelConnecteur` quand il y en avait trois, « 9 clés » dans une
fixture qui en listait huit (l'ajout de ce lot l'a rendue vraie PAR ACCIDENT), et le compte de files. La
parade n'est pas de les corriger, c'est de **ne pas les écrire** : on nomme la source, on ne la recopie pas.

🔴 **UNE JUSTIFICATION FAUSSE SE RECOPIE, ET C'EST COMME ÇA QU'ELLE SE PROPAGE.** Le docblock de
`registerSettings` annonçait « GET ouvert (lecture), PUT admin-only » ; le module entier est monté avec
`requireAdmin` depuis longtemps. J'ai repris la phrase telle quelle dans une route neuve, en toute confiance,
et seul le TEST l'a montrée. **Un docblock voisin n'est pas une source, c'est un témoignage.**

⚠️ **`reuseExistingServer` DE PLAYWRIGHT PEUT FAIRE MENTIR UNE MUTATION.** Le serveur laissé vivant par le
tour précédent est réutilisé, donc on teste le build d'AVANT : après avoir restauré le code muté, le test
est resté rouge, et il a fallu relancer pour le voir vert. Dans l'autre sens, une mutation passerait pour
« non attrapée ». Sur un e2e, **la mutation se juge sur un serveur neuf**.

⚠️ **Le hook de rayon de souffle trouve ce que la revue manque**, et l'inverse est vrai aussi : la revue de
ce soir a trouvé deux défauts réels qu'aucun test ne voyait, et le hook a attrapé un commentaire devenu faux
qu'elle n'avait pas relevé. Les deux, à chaque fois.

## Ce qui attend une action de Julien

- 🔴 **Copier `ENCRYPTION_KEY` dans le coffre**, hors de toute infrastructure. Elle n'existe QUE dans
  `.env.prod` sur le VPS : si la machine disparaît, la base survit mais ses 8 secrets chiffrés deviennent
  illisibles pour toujours. Deux minutes, et c'est le seul point du plan RSSI sans code ni budget.
- 🔴 **Activer les deux outils de l'agent « Conseiller IA Gan Prevoyance »** (`mba_chercher_connaissance`,
  `mba_escalader_humain`), INACTIFS en base. C'est la cause de l'essai raté du 2026-09-08. Secteur régulé :
  la décision ne se prend pas sans lui.
- **Relire la phrase de passage de main du MBA** : celle en place a été posée pendant les essais, sans
  accents ni mots de la marque. C'est ce que LIT le client au moment du transfert.
- **Poser une photo de profil sur le numéro WhatsApp** : la pastille de l'Accueil n'affiche rien sans elle,
  et aucun des deux numéros du parc n'en a.
- **L'arbitrage « arrêt maladie »** ci-dessus.
- Le détail des décisions produit en attente (coût du MBA, allowlist, lancer un autre scénario depuis un
  agent) vit dans [todo.md](todo.md).

## Ce que le bot d'aide ne sait pas encore

Les fiches (`docs/aide/fiches/`) ne parlent ni du bilan d'un contact, ni du choix des blocs, ni du réglage de
silence, ni du funnel sans accusé, ni de la création d'un champ à la volée, **ni du centre de Sécurité**. Un
client qui pose la question obtiendra « je ne trouve pas la réponse dans le mode d'emploi » : honnête, inutile.

⚠️ **Les fiches ne se régénèrent PAS toutes seules, et c'est délibéré** : une régénération automatique
remplacerait un texte RELU par un texte que personne n'a validé. La détection de dérive, elle, fait son
travail : elle a rougi CINQ fois depuis sa création, dont trois le 2026-09-13.

## Ce qui est en PAUSE, et pourquoi

Le bloc **agent IA, lots L3, L4, L6 et L7**. Le cadrage est écrit, rien n'est commencé. ⚠️ L2 est LIVRÉ
depuis le 2026-08-28, et il n'y a pas de L5. Détail dans [todo.md](todo.md).
