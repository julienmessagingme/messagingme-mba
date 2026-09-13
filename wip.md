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

## 🔴 LA FILE DE TRAVAIL (à jour au 2026-09-13, après le lot 8)

| Rang | Chantier | Spec | Plan | État |
|---|---|---|---|---|
| **1** | **Chaîne de repli des campagnes** + assistant de création | [spec](docs/superpowers/specs/2026-09-12-campagnes-chaine-de-repli-design.md) | [plan](docs/superpowers/plans/2026-09-12-campagnes-chaine-de-repli.md) | **HUIT LOTS DÉPLOYÉS** (`d22b3b0`). L'ancien formulaire est RETIRÉ |
| **2** | **Traduction des conversations** (FR / EN) | [spec](docs/superpowers/specs/2026-09-12-traduction-conversations-cadrage.md) | [plan, 6 tâches](docs/superpowers/plans/2026-09-12-traduction-conversations.md) | ✅ **TERMINÉ ET DÉPLOYÉ** le 2026-09-13 (0137 appliquée, `TRADUCTION_MODELE=google/gemini-2.5-flash` posée en prod). Décrit dans `features.md`. 🔴 **JAMAIS ESSAYÉ EN RÉEL** : aucun message étranger n'a encore été traduit sur de vraies données |
| **3** | 🔴 **BUG : « Modèle et scénario » demande DEUX choix** | — | [todo.md](todo.md) | **LE PROCHAIN**. Régression : le sélecteur de Modèle reste affiché à côté de celui du scénario, et les deux peuvent se contredire |
| **4** | **Récap de la veille** dans le bot d'aide | [spec](docs/superpowers/specs/2026-09-12-recap-bot-aide-cadrage.md) | [plan, 4 tâches](docs/superpowers/plans/2026-09-12-recap-bot-aide.md) | planifié, rien de commencé |
| **5** | Les quatre évolutions demandées le 2026-09-13 | — | [todo.md](todo.md) | cadrées, pas planifiées. L'opt-out du menu Sécurité **demande une discussion avant** d'être planifiable |

### Où en est le chantier 1, exactement

Migrations **0133 à 0137 appliquées**. Prochaine libre : **0138** (le compteur fait foi dans
`CLAUDE.md`, relu en base).

**Ce qui marche de bout en bout** : l'assistant à cinq étapes est le SEUL chemin de création, il gère
les variables de template, l'aperçu, « Plus tard », le fil de l'eau, le visuel RCS, les brouillons
(les deux formats), l'audience complète et la jauge de débit. Le moteur envoie sur le canal de
l'étage. La joignabilité WhatsApp se mémorise. Le funnel compte par canal.

🔴 **CE QUI N'A JAMAIS TOURNÉ EN RÉEL** : aucune chaîne de repli n'a jamais basculé sur de vraies
données. Zéro campagne à deux étages, zéro ligne de journal, zéro joignabilité mesurée (compté en
base le 2026-09-12). **L'essai réel est LA chose qui manque**, et le plan le nomme : une campagne à
deux étages sur le numéro de Julien, avec un destinataire volontairement injoignable en WhatsApp.

⚠️ **L'espace « Demo » a ZÉRO jour ouvert** (mesuré). Cocher « heures ouvrées » y condamne une
campagne, cf. `todo.md`.

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

### Où en est le chantier 2, exactement

Les six tâches sont écrites. Les cinq premières sont déployées et **la migration 0137 est appliquée**.
La sixième (l'interrupteur « Traduire les messages reçus », l'affichage des trois états, le bandeau
« pas de crédit », la cible passée à la transcription d'un vocal) est **commitée et pas déployée**.

🔴 **LA FONCTIONNALITÉ EST ÉTEINTE TANT QUE `TRADUCTION_MODELE` EST VIDE**, et c'est délibéré : le
choix du modèle se mesure, il ne se suppose pas. Sans lui, le fil sort en VO avec son drapeau et le
bouton sortant répond 422. **Rien n'a donc encore tourné sur de vraies données**, et l'essai réel que
le plan nomme reste dû : un message espagnol reçu sur le numéro de service, lu en français, puis une
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

## Les deux lots du 2026-09-11 au soir : ce qui RESTE

Quinze demandes en deux vagues (onze, puis quatre), toutes traitées et déployées le soir même, plus deux
revues passées après coup qui ont produit quinze constats de plus, tous corrigés. ⚠️ Ce qui suit n'est que
le RESTE : le livré est dans [features.md](features.md) et son récit dans
[docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md).

⚠️ **LEÇON DE LA SOIRÉE, ET ELLE EST SUR LA MÉTHODE :** la revue de code a dû être RÉCLAMÉE deux fois, et
les deux fois elle a trouvé un défaut réel qu'aucun test ne voyait (un réglage muet de bout en bout, puis un
champ qui débordait de son panneau de 12 px). Elle n'est pas une formalité de fin de lot, et elle ne doit
pas attendre qu'on la demande.

### 🔴 Le bac à sable de l'agent : la question est CLOSE, mais autre chose est sorti

Julien pensait que le bac à sable n'actionnait pas les outils tant que l'agent n'était pas activé
globalement. **C'est faux, et c'est mesuré** : `agent_test_runs` garde chaque essai, et les trois siens
montrent `mba_chercher_connaissance` appelé à chaque fois, avant comme après l'activation. Ce qui changeait
était la QUESTION, pas l'activation.

La vraie cause était la recherche, sourde aux mots sans accent. **Migration 0132 appliquée et déployée le
2026-09-11 au soir**, vérifiée en base et par le vrai code : « prevoyance » et « prévoyance » rendent
désormais exactement le même résultat.

⚠️ **IL RESTE À LE REVÉRIFIER AVEC LUI, sur une vraie question.** Si l'agent rate encore une réponse que sa
base contient, ce sera un AUTRE défaut, et il faudra repartir des essais enregistrés (`agent_test_runs`)
plutôt que d'une hypothèse. C'est ainsi que celui-ci a été trouvé.

### 🔴 Le bot d'aide ne connaît AUCUNE des nouveautés du 2026-09-11

Les fiches du mode d'emploi (`docs/aide/fiches/`) ne parlent ni du bilan d'un contact, ni du choix des blocs,
ni du réglage de silence, ni du funnel sans accusé, ni de la création d'un champ à la volée. Un client qui
pose la question au bouton d'aide obtiendra « je ne trouve pas la réponse dans le mode d'emploi », ce qui est
honnête mais inutile.

⚠️ **Les fiches ne se régénèrent PAS toutes seules, et c'est délibéré** : une régénération automatique
remplacerait un texte RELU par un texte que personne n'a validé, et le bot se mettrait à parler aux clients
avec des phrases non relues. `features.md` porte désormais toutes ces sections ; il reste à en tirer des
fiches et à les relire. ⚠️ La détection de dérive, elle, a fait son travail DEUX fois dans la soirée
(`importer-mes-contacts` puis `repondre-dans-l-inbox`), et la seconde fiche a été enrichie du cas que le lot
changeait.

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
- **Régler les heures d'ouverture dans Paramètres** avant d'utiliser la case « heures ouvrées » d'une
  campagne ou le bloc Attente « jusqu'aux prochaines heures ouvrées » : sans aucun jour ouvert, la campagne se
  met en pause et le dit, mais ne repart pas toute seule, et le bloc Attente ne retient personne.
- 🔴 **Copier `ENCRYPTION_KEY` dans le coffre**, hors de toute infrastructure. Elle n'existe QUE dans
  `.env.prod` sur le VPS : si la machine disparaît, la base survit mais ses 8 secrets chiffrés deviennent
  illisibles pour toujours. Deux minutes, et c'est le seul point du plan RSSI qui ne demande ni code ni budget.
- **Facultatif : éteindre `mba-web`** et faire de `mba.messagingme.app/` une redirection vers `engageme`.
  Rien ne presse : le laisser tourner ne coûte presque rien et garde une porte de sortie.

## Ce qui est en PAUSE, et pourquoi

Le bloc **agent IA, lots L3, L4, L6 et L7**. Le cadrage est écrit, rien n'est commencé. ⚠️ L2 est LIVRÉ
depuis le 2026-08-28, et il n'y a pas de L5. Détail dans [todo.md](todo.md).
