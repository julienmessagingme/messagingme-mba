# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **VIDÉ POUR LA QUATRIÈME FOIS le 2026-09-09**, et c'est le chiffre qui compte. Trois fois, c'est que le
> problème n'est pas la négligence : **un lot terminé n'a aucune raison d'attendre ici**, il a une place
> ailleurs le jour même.
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.**
>
> **Au-delà de cent lignes, ce fichier a recommencé à être une archive.**

## 🔴 L'ÉTAT EXACT, AU 2026-09-13 AU SOIR

| | |
|---|---|
| `origin/main` | `289bf07` |
| VPS (`mba-api`, `mba-worker`, `mba-web`) | `444b509` |
| L'écart entre les deux | **un commentaire et des `.md`** : aucun redéploiement dû |
| Vercel (`engageme`) | suit `origin/main` tout seul, à chaque push |

⚠️ **LE 502 PUBLIC EST SYSTÉMATIQUE, PLUS INTERMITTENT.** Cinq déploiements le 2026-09-13, cinq fois le
même : conteneurs `healthy`, appel interne à 200, appel public à 502 sur les trois chemins d'API, réglé
par `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`. **Le contrôle public après CHAQUE
`up --build` est la seule façon de ne pas laisser la réception des messages coupée sans le savoir.**

## 🔴 LA FILE DE TRAVAIL (à jour au 2026-09-13, après le lot 8)

| Rang | Chantier | Spec | Plan | État |
|---|---|---|---|---|
| **1** | **Chaîne de repli des campagnes** + assistant de création | [spec](docs/superpowers/specs/2026-09-12-campagnes-chaine-de-repli-design.md) | [plan](docs/superpowers/plans/2026-09-12-campagnes-chaine-de-repli.md) | **HUIT LOTS DÉPLOYÉS** (`d22b3b0`). L'ancien formulaire est RETIRÉ |
| **2** | **Traduction des conversations** (FR / EN) | [spec](docs/superpowers/specs/2026-09-12-traduction-conversations-cadrage.md) | [plan, 6 tâches](docs/superpowers/plans/2026-09-12-traduction-conversations.md) | ✅ **TERMINÉ ET DÉPLOYÉ** le 2026-09-13 (0137 appliquée, `TRADUCTION_MODELE=google/gemini-2.5-flash` posée en prod). Décrit dans `features.md`. 🔴 **JAMAIS ESSAYÉ EN RÉEL** : aucun message étranger n'a encore été traduit sur de vraies données |
| **3** | ✅ **BUG « Modèle et scénario »** | — | [todo.md](todo.md) | ✅ **CORRIGÉ ET DÉPLOYÉ** le 2026-09-13 (`01b82c6`, CI verte, Vercel). Le sélecteur de modèle disparaît en formule scénario, les variables se vident à la bascule, et un scénario qui n'ouvre pas par un modèle est refusé sur un étage WhatsApp |
| **4** | **Récap de la veille** dans le bot d'aide | [spec](docs/superpowers/specs/2026-09-12-recap-bot-aide-cadrage.md) | [plan, 4 tâches](docs/superpowers/plans/2026-09-12-recap-bot-aide.md) | ✅ **LES 4 TÂCHES LIVRÉES** (`289bf07`), aucune migration. **Pas encore déployé sur le VPS.** 🔴 **Jamais essayé en réel**, cf. plus bas |
| **5** | **Créer un scénario sans quitter sa campagne** | [spec](docs/superpowers/specs/2026-09-13-scenario-a-la-volee-design.md) | [plan, 6 tâches](docs/superpowers/plans/2026-09-13-scenario-a-la-volee.md) | spec et plan écrits, rien de commencé |
| **6** | **Centre de Sécurité & compliance** (opt-out, IA, audit, erreurs) | [spec](docs/superpowers/specs/2026-09-13-centre-securite-design.md) | [plan, 9 tâches en 3 lots](docs/superpowers/plans/2026-09-13-centre-securite.md) | spec et plan écrits. ⚠️ Tâches 7 et 9 **pas cadrées**, à préciser avec Julien |
| **7** | ✅ Menu Scénario dans Contenu + la réponse compte comme engagement | — | [plan, 2 tâches](docs/superpowers/plans/2026-09-13-menu-scenario-et-engagement.md) | ✅ **FAIT ET DÉPLOYÉ** le 2026-09-13 (`444b509`). Essai réel concluant : « Testjulien2 », zéro clic, **1 engagé** |

### Où en est le chantier 1, exactement

Migrations **0133 à 0137 appliquées**. Prochaine libre : **0138** (le compteur fait foi dans
`CLAUDE.md`, relu en base).

**Ce qui marche de bout en bout** : l'assistant à cinq étapes est le SEUL chemin de création, il gère
les variables de template, l'aperçu, « Plus tard », le fil de l'eau, le visuel RCS, les brouillons
(les deux formats), l'audience complète et la jauge de débit. Le moteur envoie sur le canal de
l'étage. La joignabilité WhatsApp se mémorise. Le funnel compte par canal.

### 🔴 Le récap d'hier : ce qu'il reste à faire

Le lot est **complet et poussé** (`289bf07`), sans migration : le SQL, la garde de rôle, le cache, le
gabarit, la garde des nombres inventés et le bouton. Il manque **deux choses, dans cet ordre** :

1. **Le déploiement sur le VPS** (l'API porte la route ; Vercel a déjà le bouton, qui rendra 404 tant que
   l'API n'a pas suivi). Rien à migrer, mais le contrôle public après `up --build` reste obligatoire.
2. 🔴 **L'ESSAI RÉEL, et le plan le nomme précisément** : ouvrir le bot sur la production avec un compte
   admin, cliquer le bouton, et **RECOMPTER À LA MAIN** les conversations de la veille contre ce qu'il
   annonce. Puis rouvrir avec un compte `agent` et vérifier que le bouton n'est pas là. **Un récap qui
   affiche un chiffre plausible et faux est pire que pas de récap, parce que les gens agissent dessus.**

⚠️ **Une décision y a été prise qui mérite d'être confirmée à l'usage** : « une conversation d'hier » veut
dire « une conversation qui a PARLÉ hier », pas « une ligne créée hier ». Une conversation étant unique par
numéro pour toujours, compter les créations aurait fait dire « hier : 2 conversations, 128 messages reçus »
chez un client installé. Les ouvertures sont comptées à part, sous « dont N nouvelles ».

🔴 **CE QUI N'A JAMAIS TOURNÉ EN RÉEL** : aucune chaîne de repli n'a jamais basculé sur de vraies
données. Zéro campagne à deux étages, zéro ligne de journal, zéro joignabilité mesurée (compté en
base le 2026-09-12). **L'essai réel est LA chose qui manque**, et le plan le nomme : une campagne à
deux étages sur le numéro de Julien, avec un destinataire volontairement injoignable en WhatsApp.

⚠️ **Les heures d'ouverture de l'espace Demo sont RÉGLÉES depuis le 2026-09-13** (Julien y a ouvert le
dimanche). Ce fichier a affirmé le contraire. ⚠️ Et le piège qui reste : changer ses horaires ne réveille
PAS une campagne déjà en pause, `paused_until` ayant été calculé au moment de la pause. Le bouton
« Reprendre » de la liste est le geste qui rattrape ça, cf. `todo.md`.

### Ce que les huit lots ont appris, et qui vaut pour les deux chantiers suivants

🔴 **Le motif qui s'est répété DEUX fois : l'écran affiche ce que la requête n'envoie pas.** Au lot 7
la cible était posée sur les filtres quoi qu'on ait coché ; au lot 8 le message RCS était un littéral
texte alors que l'écran montrait le visuel. La cause est la méthode de construction, pas
l'inattention : ce qu'un écran MONTRE et ce qu'il ENVOIE avancent à des vitesses différentes, et les
tests d'interface ne voient que la première. **Parade, à appliquer aux chantiers 2 et 3 : pour tout
écran qui construit une requête, au moins un test lit le CORPS de la requête.**

🔴 **Une fixture écrite en même temps que le code qu'elle garde REPRODUIT ses hypothèses.** Quatre
tests d'intégration validaient un critère faux (`password_hash` comme preuve d'activité) parce que
leur fixture posait un mot de passe à tout le monde, comme le code. C'est un essai humain qui l'a
trouvé. **Écrire une fixture, c'est se demander de quoi le VRAI MONDE a l'air, pas de quoi le code a
besoin.**

⚠️ **Chacune des huit revues a trouvé un défaut réel qu'aucun test ne voyait** : un index manquant sur
le chemin des accusés, deux commentaires affirmant que le code survivait à une migration absente, un
étage e-mail configurable et inerte, une arithmétique fausse dans le sens rassurant, et les deux
défauts du motif ci-dessus. Julien a dû la réclamer trois fois ; elle n'est jamais une économie.

### Ce que la session du 2026-09-13 a appris

🔴 **`abort()` n'annule pas ce que le SERVEUR a déjà lancé.** Le fil d'Inbox se rafraîchit toutes les
4 secondes ; sa traduction s'accorde jusqu'à 20. Chaque tour annulait la requête en vol, ce qui ferme la
connexion du navigateur mais PAS l'appel au modèle, déjà parti et déjà facturé. Mesuré par mutation :
**quatre traductions payées en treize secondes** là où une suffisait, en boucle tant que la conversation
reste ouverte. **Dès qu'un rafraîchissement périodique déclenche un traitement plus long que sa période,
le tour suivant PASSE SON TOUR, il n'annule pas.** (Aussi dans `brain/LEARNINGS.md` : c'est transversal.)

🔴 **Un test qui désigne un élément par son TEXTE ne nomme aucun symbole.** En retirant une case à
cocher, trois `grep` (le champ, le `data-testid`, la fonction) ont rendu zéro reste. Deux e2e la
gardaient pourtant, via un libellé qui RESSEMBLAIT à celui de la case qui reste. **Quand on retire un
élément d'interface, chercher aussi son LIBELLÉ.** C'est la CI qui l'a dit, pas la revue.

🔴 **`features.md` peut affirmer une capacité qui n'existe pas, et c'est pire qu'un silence.** Il disait
« l'écran de la campagne dit pourquoi elle est en pause et vers quand elle repartira ». Faux depuis
toujours. C'est cette phrase qui a fait chercher une panne là où il n'y en avait pas.

🔴 **Le motif de l'écran qui affiche ce que la requête n'envoie pas s'est produit une TROISIÈME fois** :
le réessai, masqué sur une chaîne de repli mais toujours envoyé. La parade reste la même, et elle n'est
toujours pas systématique : **pour tout écran qui construit une requête, au moins un test lit le CORPS
de la requête.**

⚠️ **Le hook de rayon de souffle a trouvé deux défauts que la revue avait manqués** : la carte du bot
d'aide devenue périmée en déplaçant une entrée de menu, et un texte d'écran devenu faux au moment même
où la colonne d'à côté apparaissait.

⚠️ **La classification de méthode se RÉVISE en cours de route.** « Réponse = engagement » était classé
« en direct » ; en cherchant d'où venait le compte, il a fallu une requête SQL neuve sur le chemin d'un
chiffre affiché et deux définitions à trancher avec Julien. **Une complexité découverte en cours de
tâche fait monter la méthode d'un cran, elle ne se contourne pas.**

### Où en est le chantier 2, exactement

✅ **LES SIX TÂCHES SONT DÉPLOYÉES ET LA FONCTIONNALITÉ EST ALLUMÉE.** Migration 0137 appliquée,
`TRADUCTION_MODELE=google/gemini-2.5-flash` posée en production le 2026-09-13 (choix validé par Julien).

🔴 **RIEN N'A ENCORE TOURNÉ SUR DE VRAIES DONNÉES**, et l'essai réel que le plan nomme reste dû : un message espagnol reçu sur le numéro de service, lu en français, puis une
réponse traduite, avec le contrôle EN BASE que `body` porte ce qui est PARTI et `redaction_origine` ce
que l'opérateur a écrit.

⚠️ **La dépense tombe sur le crédit PRÉPAYÉ du client**, pas sur notre clé comme le bot d'aide. Deux
bornes vivent côté écran et se cassent en silence si on y touche : un tour de rafraîchissement qui
tombe pendant une requête PASSE SON TOUR (`enCoursRef`), et basculer le réglage recharge le fil ENTIER
au lieu du delta. Les deux sont gardées par des tests qui COMPTENT les requêtes ou LISENT leur URL.

### La méthode de livraison est désormais une RÈGLE TENUE PAR UN TEST

Tout plan doit porter une section `## Méthode de livraison` qui nomme la méthode, l'argumente, et
nomme **l'essai réel qui clôt la feature**. `tests/plan-methode.test.ts` le vérifie, et le
`CLAUDE.md` global porte les quatre méthodes et les quatre questions qui tranchent.

## Ce que le bot d'aide ne sait pas encore

Les fiches (`docs/aide/fiches/`) ne parlent ni du bilan d'un contact, ni du choix des blocs, ni du
réglage de silence, ni du funnel sans accusé, ni de la création d'un champ à la volée. Un client qui
pose la question obtiendra « je ne trouve pas la réponse dans le mode d'emploi » : honnête, inutile.

⚠️ **Les fiches ne se régénèrent PAS toutes seules, et c'est délibéré** : une régénération automatique
remplacerait un texte RELU par un texte que personne n'a validé, et le bot parlerait aux clients avec
des phrases non relues. `features.md` porte les sections ; il reste à en tirer des fiches et à les relire.

⚠️ **La détection de dérive fait son travail** : elle a rougi QUATRE fois depuis sa création, dont deux
le 2026-09-13 (une par section de `features.md` touchée). Chaque fois, la fiche a été relue et enrichie
du cas que le lot changeait, pas seulement ré-empreintée.

### Ce qui demande une décision de Julien, pas du code

- **Le coût réel du MBA n'est pas récupérable aujourd'hui**, mesuré le 2026-09-11. Meta facture
  **2,00 $ par million de jetons** (~4 à 5 centimes par message, 20 000 à 25 000 jetons chacun), mais :
  `pricing_analytics` ne rend AUCUNE catégorie MBA sur notre WABA (Meta écrit que ces analytics « are
  forthcoming »), et sur le second numéro Meta refuse le coût à la source, « le COÛT ne s'affiche pas pour
  les entreprises qui effectuent les paiements par le biais d'un partenaire ». La seule chose honnête
  constructible est donc une **estimation** (messages tenus par le MBA × tarif publié), affichée comme
  telle. Julien doit dire s'il la veut.
- **L'allowlist n'est PAS un dispositif de gratuité**, contrairement à ce qu'on pouvait croire. Doc Meta,
  verbatim : « Adding consumers to the allowlist does not by itself limit who the agent replies to. The
  allowlist is only enforced when `ai_audience` is `ALLOWLISTED_ONLY`. » C'est un filtre sur QUI l'agent
  sert. Le gratuit, c'est `agent_test`. Pour essayer dans un vrai WhatsApp il faut payer les messages
  (« messages are not delivered unless your account has a payment method attached »). ⚠️ L'allowlist reste
  utile pour autre chose : **restreindre l'agent au seul numéro d'essai**, pour qu'il ne réponde à personne
  d'autre pendant les tests. À faire si Julien le veut.
- **Lancer un AUTRE scénario depuis un agent** n'existe pas, et ce n'est pas un oubli. L'outil « Envoyer un
  bloc » n'envoie qu'un bloc du scénario où le contact se trouve DÉJÀ, et `envoyerBlocDepuisAgent` écrit
  pourquoi : passer par `runFrom` tuerait le run de l'agent qui appelle et clôrait sa session. Julien décrit
  aussi « choisir un scénario » : c'est une capacité différente, donc un OUTIL différent, à cadrer.

## Ce qui attend une action de Julien

- 🔴 **Activer les deux outils de l'agent « Conseiller IA Gan Prevoyance »** : `mba_chercher_connaissance`
  et `mba_escalader_humain` sont INACTIFS en base (vérifié le 2026-09-09). C'est la cause de l'essai raté du
  2026-09-08, et le changement de modèle ne la corrige pas : Haiku sait appeler des outils, mais on ne lui en
  expose aucun. Onglet Outils de la fiche. C'est une décision qui change ce que l'agent a le droit de faire
  chez un client en secteur RÉGULÉ, donc elle ne se prend pas sans lui. ⚠️ Le modèle, lui, est déjà passé sur
  `anthropic/claude-haiku-4.5` (écriture en base du 2026-09-09, vérifiée, et le modèle appelle bien l'outil).
- **Relire la phrase de passage de main du MBA** (Paramètres de l'agent Meta, « message de transfert ») :
  celle qui est en place a été posée par moi pendant les essais du 2026-09-10, sans accents et sans les mots
  de la marque. C'est la phrase que LIT le client au moment où l'agent de Meta passe la main : elle doit être
  la vôtre. ⚠️ Le même écran décide aussi si l'agent LÂCHE le fil après l'avoir annoncée : à « non », le
  client lit « un conseiller arrive » sans que personne ne soit prévenu.
- **Poser une photo de profil sur le numéro WhatsApp** : la pastille de l'Accueil n'affiche rien tant qu'il
  n'y en a pas, et aucun des deux numéros du parc n'en a (mesuré).
- 🔴 **Copier `ENCRYPTION_KEY` dans le coffre**, hors de toute infrastructure. Elle n'existe QUE dans
  `.env.prod` sur le VPS : si la machine disparaît, la base survit mais ses 8 secrets chiffrés deviennent
  illisibles pour toujours. Deux minutes, et c'est le seul point du plan RSSI qui ne demande ni code ni budget.
- **Facultatif : éteindre `mba-web`** et faire de `mba.messagingme.app/` une redirection vers `engageme`.
  Rien ne presse : le laisser tourner ne coûte presque rien et garde une porte de sortie.

## Ce qui est en PAUSE, et pourquoi

Le bloc **agent IA, lots L3, L4, L6 et L7**. Le cadrage est écrit, rien n'est commencé. ⚠️ L2 est LIVRÉ
depuis le 2026-08-28, et il n'y a pas de L5. Détail dans [todo.md](todo.md).
