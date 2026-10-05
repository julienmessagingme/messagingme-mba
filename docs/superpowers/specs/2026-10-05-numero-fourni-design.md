# Le numéro fourni, côté client (lot 3b de « Engage Me pour Claude Code »)

Spec validée par Julien le 2026-10-05. Elle s'appuie sur le lot 3a, en production le même jour
(`docs/superpowers/specs/2026-10-05-pont-du-code-design.md`) : la réserve de numéros DIDWW (`numeros_fournis`), le
pont qui lit le code que Meta dicte (`codes_verification`), l'Asterisk et la carte /ops.

## 1. Ce que veut Julien

- **Numéro fourni** : le client ne s'occupe pas du numéro (« le mec s'en fout du numéro »). Il passe la fenêtre
  Meta SANS numéro ; le serveur ajoute le nôtre à son compte WhatsApp, demande le code par appel, le fait lire par
  l'Asterisk, le soumet et active le numéro.
- **Numéro apporté** : la séquence actuelle, inchangée. Le client tape son numéro dans la fenêtre Meta et demande
  lui-même son code.
- **Libre-service dès le 3b**, gratuit jusqu'au paiement du 3c. La seule borne est la taille de la réserve.
- **Alerte** : Telegram dès qu'il reste moins de 3 numéros libres, au plus une fois par jour.
- **Crédit offert** : 1 € pour un espace créé depuis Claude Code, 5 € pour un espace créé dans la console.
  « Par Claude Code, si le mec fournit son numéro cela coûte zéro, donc on ne va pas lui filer 5 € à chaque fois. »

Supposés, validés avec le design : le 1 € vaut pour tout espace né depuis Claude Code, numéro fourni ou apporté ;
l'origine d'un espace est fixée à sa création (un espace de console qui branche Claude Code plus tard garde ses
5 €) ; un seul numéro fourni par espace.

Hors périmètre (3c) : l'abonnement Stripe, la résiliation chez DIDWW, l'outil d'attente de Claude Code
(`suivre_connexion_numero`).

## 2. Ce que Meta permet, et ce qui reste à mesurer

- **`only_waba_sharing` n'existe plus** (changelog de Meta du 29 mai 2025) : le partenaire ne peut plus faire
  sauter l'écran du numéro. La production tourne déjà en v4 (configuration posée le 2026-09-22), où le client peut
  finir SANS numéro (`FINISH_ONLY_WABA`), mais c'est lui qui le choisit. D'où une consigne claire sur notre page.
- **Non documenté par Meta, donc MESURÉ avant d'écrire la chaîne** (tâche 0 du plan) :
  1. ce que la fenêtre renvoie sur une fin sans numéro (le code échangeable, l'identifiant du compte) ;
  2. si le jeton du client nous laisse ajouter un numéro à son compte (`POST /{waba}/phone_numbers`) ;
  3. la forme attendue de `cc` et `phone_number` (l'exemple de Meta est ambigu) ;
  4. la langue dans laquelle Meta dicte le code demandé par l'API (l'extraction lit le français et l'anglais).
- **Repli si Meta refuse l'ajout** : le client tape lui-même le numéro attribué dans la fenêtre, et la page lui
  affiche le code capté. Seuls la page et ses consignes changent ; l'attribution, l'alerte et le crédit restent.
- **Limite de Meta** : un portefeuille non vérifié porte deux numéros au plus (constaté le 2026-10-05, et dans la
  documentation). Elle porte sur le portefeuille du CLIENT.

## 3. Le parcours

La page **« Connecter WhatsApp »** (`/connecter-whatsapp` dans la console, liée depuis l'Accueil d'un espace sans
numéro, et l'adresse que le 3c donnera à Claude Code) propose deux choix.

**« Fournissez-moi un numéro »**
1. La page demande le nom affiché sur WhatsApp (prérempli avec le nom de l'espace, avec les règles de Meta en une
   phrase), et vérifie qu'il reste un numéro libre. Réserve vide : on le dit, et l'alerte est déjà partie.
2. Elle ouvre la fenêtre Meta, avec la consigne : à l'écran du numéro, continuer sans numéro.
3. Au retour, le serveur échange le code, garde le compte WhatsApp et son jeton (sans numéro), attribue un numéro de
   la réserve et lance l'enchaînement en tâche de fond. La page affiche chaque étape en direct : numéro attribué,
   ajouté au compte, appel de Meta en cours, code reçu, numéro activé.
4. À l'activation, l'espace est relié comme aujourd'hui, et le crédit offert part selon l'origine de l'espace.

**« J'ai déjà un numéro »** : la fenêtre Meta actuelle et la suite actuelle (`/embedded-signup/complete`, puis
l'activation par code saisi). Seul le montant du crédit offert dépend désormais de l'origine.

## 4. Le serveur

- **L'enchaînement en tâche de fond** (une file pg-boss neuve, dans `BASE_QUEUES`) : ajouter le numéro au compte,
  demander le code par appel, puis attendre le code capté. C'est le pont du 3a qui relance la file quand il écrit un
  code pour un numéro attribué en attente ; une échéance de 3 minutes déclare le code absent. Puis `verify_code`,
  `register` (PIN tiré et gardé chiffré comme aujourd'hui), liaison de l'espace, crédit offert.
- **L'état vit dans une ligne par espace** (`connexions_numero`) : l'étape, la cause d'un échec, l'identifiant du
  numéro chez Meta, celui du compte, l'heure de la demande de code. Pas sur la ligne du numéro (corrigé en écrivant le
  plan) : un numéro peut quitter l'espace en cours de route (refusé par Meta, abandonné), et le client doit quand même
  voir pourquoi.
- **L'attribution** est atomique : une instruction prend une ligne `libre` (`for update skip locked`) et pose
  ensemble `attribue`, l'espace et l'heure, sans quoi `numeros_fournis_espace_chk` refuse.
- **Le compte sans numéro** : `/embedded-signup/complete` rend aujourd'hui 422 sur un compte WhatsApp sans numéro.
  Le compte et son jeton doivent être gardés AVANT le numéro (sinon les appels partent avec le jeton global, qui ne
  voit pas le compte du client).
- **Les routes** (module `tenant`, `espaceVerifie`) : démarrer la connexion fournie, lire son état (lecture
  interrogée en boucle, donc hors plafond coûteux), relancer après un échec. Elles ne rendent jamais le code ni la
  transcription : le serveur soumet le code lui-même.
- **Les échecs** ont chacun leur cause et leur message :
  - compte plein (deux numéros) : le numéro reste attribué jusqu'à « Réessayer » (le client a libéré une place) ou
    « Abandonner », qui le rend à la réserve ;
  - numéro refusé par Meta (déjà actif ailleurs, un numéro DIDWW recyclé) : il sort de la réserve et Julien est
    prévenu, pour ne pas le donner au client suivant ;
  - code absent après 3 minutes : bouton « Relancer », dans les limites de Meta ;
  - activation refusée : bouton « Relancer », le `register` étant limité à 10 essais par numéro sur 72 heures.
- **L'alerte de réserve basse** : après chaque attribution, compter les numéros libres ; sous le seuil
  (`ALERTE_RESERVE_SEUIL`, 3 par défaut), un message Telegram sous un verrou court de 24 heures.
- **Le crédit offert par origine** : un marqueur d'origine posé à la création de l'espace (`claude_code` quand
  l'espace naît par la connexion OAuth de Claude Code, `console` sinon), et une seconde variable
  (`CREDIT_OFFERT_CLAUDE_CODE_MICRO_EUR`, 1 € par défaut) à côté de `CREDIT_OFFERT_MICRO_EUR`. Aucune reprise des
  espaces existants : ils restent `console`.
- **Migration 0211** (numéro relu dans le dossier d'origin au moment de l'écrire ; d'autres sessions écrivent aussi
  des migrations) : l'origine de l'espace, la table `connexions_numero`, l'unicité « un numéro attribué par espace »
  (index unique partiel), et le statut `bloque` pour un numéro que Meta refuse. Elle ajoute et relâche : elle passe
  AVANT le `up`.

## 5. La console

- La page « Connecter WhatsApp » et ses deux choix ; le suivi des étapes par interrogation de la route d'état.
- L'écoute de la fenêtre Meta accepte une fin sans numéro (elle n'acceptait que le couple compte et numéro).
- L'Accueil d'un espace sans numéro mène à la page.
- 🔴 Vercel publie la console au `git push` : la page n'est poussée qu'APRÈS le déploiement de l'API qui porte ses
  routes, ou elle tolère leur absence.

## 6. Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** La production emprunte ces chemins (l'inscription d'un
client, une migration, le montant d'un crédit offert, des écritures chez Meta qui consomment des essais limités),
une partie des critères ne se voit que chez Meta, et le code porte des invariants invisibles (le CHECK à sens unique
de l'espace, l'unicité par espace, la borne « une offre par espace »). Une relecture indépendante en fin de lot.

## 7. Les tests attendus

- L'attribution concurrente : deux espaces, un numéro libre, un seul gagne (intégration).
- L'unicité par espace, le statut `bloque`, le retour à la réserve d'un compte plein (intégration).
- La chaîne avec un faux Meta : chaque étape, chaque échec, la relance par le pont, l'échéance de 3 minutes.
- Le crédit : 1 € pour un espace `claude_code`, 5 € pour `console`, et toujours une seule offre par espace.
- L'isolation : les routes d'état passent par `tests/scope-tenant.test.ts`.
- L'alerte : sous le seuil, une seule fois sur 24 heures.

## 8. L'essai réel qui clôt

Sur un espace créé depuis Claude Code, avec un portefeuille Meta qui a une place libre : « Fournissez-moi un
numéro », la fenêtre finie sans numéro, la page suit les étapes, et le numéro est actif en quelques minutes, sans
que le client ait tapé ni numéro ni code. Le crédit offert affiche 1 €. La réserve passant sous 3 numéros libres,
l'alerte Telegram arrive.
