# Embedded Signup : passer de la v2 à la v4 avant le 15 octobre 2026 (plan proposé)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Statut : PROPOSITION du 2026-09-22, en attente de l'accord de Julien.** Rien n'est implémenté, rien n'est
déployé, aucune configuration Meta n'a été touchée. Destination prévue : `docs/superpowers/plans/2026-09-22-embedded-signup-v4.md`.

**But :** que le bouton « Connecter mon compte WhatsApp » (Accueil d'un espace sans numéro) marche encore après
le 15 octobre 2026, date à laquelle Meta retire les versions 2 et 3 de l'Embedded Signup.

**Architecture :** la version ne se choisit pas dans notre code mais dans la configuration Facebook Login for
Business : une configuration créée AVEC des produits passe d'elle-même en v4, et notre appel `FB.login` est déjà
celui de la page d'implémentation v4. Le cœur de la migration est donc une nouvelle configuration (geste de
Julien chez Meta) et le changement de `META_ES_CONFIG_ID` sur le VPS. Le code ne change que pour deux raisons :
l'état de fin que la v4 ajoute (un numéro non vérifié), et une reconnexion qui doit réparer un espace dont le
jeton est mort, parce que la configuration actuelle délivre des jetons de 60 jours (section 3).

**Tech Stack :** API Fastify et TypeScript (tsx), console Next.js (`web/`), Postgres, vitest, Graph API.

**Spec :** ce document (sections 1 à 3, sourcées). Lié : `docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md`,
dont la section 10 renvoie la migration ici.

## Mise à jour du 2026-09-22 au soir (à lire en premier)

**Fait :**
- A0 : l'ancienne configuration `1935064477162674` tournait bien en v2 (la popup se taisait). A1 : nouvelle
  configuration v4 `28360690800224915` (Cloud API, jeton « jamais »). A5 : bascule faite par Julien (variable dans
  `.env.prod`, `mba-api` recréé, image inchangée), fumée publique verte. L'ancienne reste le retour arrière
  jusqu'au 15 octobre.
- Essai réel : la popup v4 ENVOIE les identifiants (deux passages, aucune ligne de repêchage par `debug_token`
  dans les journaux). Le premier passage a été refusé par notre garde « compte WhatsApp déjà rattaché à un autre
  espace » : c'est le chantier 4 ci-dessous.
- Mesuré chez Meta (`debug_token`) : le jeton de l'espace « MessagingMeEmbdedded » (WABA `1067000669256166`, relié
  le 2026-08-17) **expire le 2026-10-16** ; celui de l'espace neuf **n'expire jamais**. La section 3 est confirmée.
  Seuls deux numéros sont embarqués par ce parcours, tous deux `CONNECTED` ce soir.

**Incident de l'essai réel : l'enregistrement du numéro a échoué en silence.** Meta a affiché son écran final
(« Your account is connected »), mais le `register` de notre route a échoué : numéro resté `PENDING`,
`platform_type: NOT_APPLICABLE`, santé du compte `BLOCKED`. La cause est perdue : la route ne journalise pas cet
échec, elle le rend dans `warnings`, et **l'écran l'efface** (`connect()` appelle `onConnected()`, qui recharge le
compte ; l'espace ayant désormais un numéro, `ConnectNumberZone`, qui porte l'avertissement, est remplacée par la
carte du numéro). Relancé à la main une heure plus tard (script ad hoc, même geste que l'étape 5 de la route) :
accepté du premier coup, `PENDING` puis `CONNECTED`.

🔴 **LA CAUSE, DONNÉE PAR JULIEN APRÈS COUP : le numéro n'était pas vérifié.** Pour débloquer, il a cliqué
« Not connected » dans WhatsApp Manager, Meta lui a proposé de renvoyer un code, il l'a validé. C'est APRÈS cette
re-vérification que l'enregistrement est passé (et que le diagnostic a lu `code_verification_status: VERIFIED`).
C'est exactement la nouveauté de la v4 relevée en section 1 : **on peut y terminer le parcours avec un numéro NON
vérifié**, là où la v2 finissait toujours vérifié. Meta refuse alors le `register` (erreur 133006, « le numéro doit
être vérifié avant l'enregistrement »). La tâche 1 de ce plan avait donc vu juste, mais son remède ne suffit pas :
refuser en 422 et demander de recommencer tout le parcours n'est pas une réponse acceptable pour un client.

Fait mesuré ensuite : le même
numéro existe DEUX fois chez Meta, un exemplaire `PENDING` jamais enregistré dans le premier compte (WABA
`1067000669256166`, id `1400058939849963`, ajouté au premier essai) et l'exemplaire connecté dans le compte neuf
(id `1329241546947125`). Ce doublon est la différence la plus visible avec l'embarquement d'août (numéro neuf,
enregistré du premier coup), donc la piste principale ; ce n'est qu'une piste. Écartée : l'erreur 133015 (« numéro
supprimé récemment, attendre 5 minutes »), puisque le premier exemplaire n'a pas été supprimé.
À côté, la santé du compte signale l'erreur 141006 (moyen de paiement), qui ne bloque que les conversations
lancées par l'entreprise, pas l'enregistrement.

**Nouvelles priorités, dans cet ordre :**

1. **« Activer le numéro », vérification comprise. Priorité 1 : chaque nouvel embarquement passe par là.**
   Demande de Julien : que ça marche du premier coup quand Meta dit que c'est bon, et un bouton de secours qui
   sache AUSSI refaire la vérification, puisque Meta redemande un code.
   - **La route lit `code_verification_status` avant toute tentative** (tâche 1 de ce plan, déjà spécifiée).
     Numéro non vérifié : on n'appelle PAS `register`, qui échouerait en 133006 et consommerait une des
     10 requêtes permises par numéro sur 72 h.
   - **Le numéro devient « à activer », et l'écran le dit** : la carte du numéro montre l'état réel (« pas encore
     activé chez Meta »), la raison, et le bouton, réservé aux admins.
   - **Le bouton fait le parcours complet dans notre console, sans repasser par la fenêtre Meta** : demander un
     code (`requestCode`, par SMS ou par appel, en français), saisir le code (`verifyCode`), puis enregistrer
     (`register`, PIN tiré au CSPRNG, conservé chiffré seulement si Meta accepte). Les deux premières briques
     EXISTENT et ne sont câblées nulle part : `MetaPhoneRegisterClient` (`src/meta/phone-register.ts`), écrit pour
     le pool de numéros. Ne pas en écrire une seconde.
   - **Le plafond de Meta est la contrainte de conception : 10 requêtes par numéro sur 72 h, toutes étapes
     confondues** (demande de code, vérification, enregistrement), puis 133016 et numéro bloqué 72 h. L'écran
     refuse donc un second envoi de code dans la minute, et n'offre jamais un « réessayer » en boucle.
   - **Chaque échec est journalisé côté serveur**, avec le code et le message de Meta, jamais le PIN ni le code
     reçu. C'est ce qui a manqué ce soir : la cause a failli être perdue.
   - 🔴 **AUCUNE RELANCE AUTOMATIQUE. Décision de Julien, 2026-09-22 : « je ne veux pas un truc qui relance tout
     seul, je veux un bouton que le client actionne quand il veut. »** Un échec laisse le numéro « à activer »,
     visible, et c'est le client qui décide quand réessayer. Une répétition invisible consommerait en plus le
     plafond des 10 requêtes sans que personne ne le voie.
   - **Le bouton lit l'état avant d'agir, à chaque fois** : déjà `CONNECTED` et il ne fait rien ; vérifié mais pas
     enregistré et il enregistre seulement ; non vérifié et il propose d'abord le code. Meta refuse une demande de
     code sur un numéro déjà vérifié (136024), donc cet ordre n'est pas une précaution, c'est la seule séquence
     valide.
   - **SMS ou appel, et le défaut dépend du numéro** : Meta déconseille le SMS sur un numéro VoIP (les numéros
     Zadarma du pool), où l'appel est le chemin fiable.
   - **L'avertissement de la connexion ne disparaît plus** : aujourd'hui `connect()` appelle `onConnected()`, qui
     remplace la zone porteuse du message par la carte du numéro. Le remonter au niveau de la page.
   - Essai réel : un embarquement neuf avec un numéro jamais utilisé, dont l'enregistrement aboutit sans
     intervention ; puis le bouton éprouvé sur un numéro laissé non vérifié, code reçu, saisi, numéro activé.
2. **Tâche 5 (« Renouveler la connexion Meta ») AVANT le 2026-10-16**, date d'expiration mesurée du jeton de
   « MessagingMeEmbdedded ». Sans elle, cet espace ne pourra plus envoyer à cette date, et aucun écran ne permet de
   le reconnecter. Reconnecter AVANT l'expiration marche avec le code actuel (le jeton est encore `active`).
3. Tâches 1 à 3 de ce plan (numéro non vérifié, reconnexion qui remet le jeton actif, sonde des jetons).
4. **Chantier « un compte WhatsApp partagé par plusieurs espaces, un numéro chacun »**, tranché par Julien le
   2026-09-22 (modèles de messages PARTAGÉS entre ces espaces ; un numéro par espace reste la règle). À spécifier
   à part. Points déjà repérés : le rattachement doit être porté par le numéro et non plus par le compte ; un jeton
   par espace (migration de `waba_credentials`, dont la clé est `waba_id`) ; les coûts lus chez Meta
   (`pricing_analytics`, niveau compte) filtrés sur le numéro de l'espace, sinon chaque espace voit les dépenses
   des autres ; et `waba.tenant_id ... on delete cascade`, qui effacerait les numéros des autres espaces avec le
   premier.

## Contraintes globales

- Pas de tiret cadratin ni demi-cadratin, nulle part (doc, messages d'erreur, commentaires).
- Tout sur `main`, `git commit --only <chemins>`, liste construite depuis ce qu'on a touché soi-même.
- Jamais `npm run test:integration` en local : le `DATABASE_URL` du `.env` est la production. Le job `integration`
  de la CI fait foi, lu job par job (`gh run view <id> --json jobs`), jamais sur le code de sortie de `gh run watch`.
- Rien en production sans le oui de Julien. Tout `docker compose up` sur le VPS passe par la garde de déploiement
  (revue finale attestée).
- Un refus lisible sort en 422, jamais en 5xx (Cloudflare détruit le corps).
- Un jeton ne s'affiche ni ne se journalise jamais, même tronqué.

## 1. Ce que dit Meta (pages relues en ligne le 2026-09-22)

Préfixe : `developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/`.

| Page | Mise à jour |
|---|---|
| `versions` | 24 juillet 2026 |
| `version-4` | 3 septembre 2026 |
| `implementation` | 24 juillet 2026 |
| `default-flow` | 3 septembre 2026 |
| `onboarding-customers-as-a-tech-provider` | 5 août 2026 |
| `developers.facebook.com/documentation/facebook-login/facebook-login-for-business` | 30 juin 2026 |
| `.../whatsapp/business-phone-numbers/registration` | 26 juin 2026 |

- **La date : le 15 octobre 2026.** La v2 (janvier 2023), la v3 (29 mai 2025) et leurs « public preview »
  (14 août 2025) sont toutes disponibles jusqu'au 15 octobre 2026. La v4 (8 octobre 2025) et la
  v4-public-preview (12 mai 2026) n'ont pas de date de fin. Le bandeau est en tête de toutes les pages de
  l'inscription.
- **Ce qui casse à cette date : Meta ne le décrit pas.** Il demande seulement de migrer avant, pour éviter une
  interruption. Ni ces pages ni le changelog (aucune entrée pour cette dépréciation) ne disent si la fenêtre
  affichera une erreur ou basculera sans prévenir vers un autre parcours. On ne parie sur aucune des deux : on
  migre avant.
- **Ce que ça touche chez nous : la fenêtre d'inscription, et elle seule.** Aucune page ne relie un numéro déjà
  embarqué, son jeton, les envois ou les webhooks à la version de l'inscription.
- **Comment la version se choisit.** Par l'objet `extras` de l'appel `FB.login` : la v3 exige `version: "v3"`,
  chaque « public preview » exige `version: "vN-public-preview"`, la v2 n'a pas de clé `version`. La v4 fait
  exception : il faut CRÉER une nouvelle configuration Facebook Login for Business et y choisir des produits, ce
  qui la fait passer en v4 d'elle-même ; son `extras` est vide exprès.
- **Ce qui change entre la v2 et la v4, pour nous :**
  - fin de parcours : en v2, le client termine forcément avec un numéro vérifié ; en v4, il peut terminer avec
    un numéro vérifié, NON vérifié, ou sans numéro (événement `FINISH_ONLY_WABA`) ;
  - message de session (`WA_EMBEDDED_SIGNUP`) : en v2, Meta ne l'envoie que si l'appel porte
    `sessionInfoVersion` ; en v3 et v4, il l'envoie pour tous les parcours, y compris quand le client ferme la
    fenêtre sur l'écran final ;
  - en v4, le numéro se saisit et se vérifie en premier (« Phone Number First », déploiement en cours chez Meta) ;
  - en v4, les produits se choisissent dans la configuration (Cloud API, Marketing Messages API, pubs Click to
    WhatsApp, Conversions API, et d'autres) ;
  - depuis début septembre, la nouvelle interface est servie à TOUTES les versions : l'apparence de la fenêtre ne
    dit donc rien de la version.
- **Les étapes serveur d'un Tech Provider ne changent pas** (page du 5 août 2026) : échange du code, abonnement du
  WABA aux webhooks, register du numéro. C'est exactement ce que fait `src/http/embedded-signup.ts`.
- **Deux prérequis rappelés par la page d'implémentation v4** : le domaine qui ouvre la fenêtre doit figurer dans
  « Allowed domains » et « Valid OAuth redirect URIs », et l'app doit être abonnée au webhook `account_update`.
- **Register** : réservé à un numéro vérifié, 10 appels par numéro sur 72 heures ; au-delà, erreur 133016 et
  numéro bloqué 72 heures.

## 2. Quelle version tourne chez nous : la v2, à confirmer en deux minutes

**Le code ne tranche pas.** `web/app/accueil/page.tsx:877` appelle `FB.login` avec `extras: { setup: {} }`, sans
`version`. Cela exclut la v3 et toutes les « public preview ». Restent la v2 (configuration sans produits) et la
v4 (configuration avec produits).

**La configuration penche pour la v2.** Elle a été créée le 2026-07-16 par « Create from template », modèle
« WhatsApp Embedded Signup Configuration With 60 Expiration Token » (`brain/LEARNINGS.md`, entrée du 2026-07-16).
La doc v4 exige une configuration nouvelle AVEC des produits ; le chemin par modèle n'en parle pas.

**Le comportement mesuré tranche.** Nous n'avons JAMAIS reçu de message `WA_EMBEDDED_SIGNUP` :

- premier passage réel, le 2026-08-17 (entreprise et numéro créés chez Meta, code OTP validé) : le front a affiché
  « la popup n'a pas renvoyé le compte WhatsApp sélectionné » (commit `39ef35b1`). Or l'écouteur de l'époque
  (`git show 39ef35b1^:web/app/accueil/page.tsx`) acceptait tout message `WA_EMBEDDED_SIGNUP` venu de facebook.com
  portant les deux identifiants, en texte ou en nombre, quel que soit l'événement : un message v3 ou v4 serait
  passé ;
- second passage, toutes traces ouvertes : le seul message venu de facebook.com était le canal interne du SDK
  portant le code (commit `875a6b37`).

La v4 envoie ce message pour tous les parcours ; la v2 ne l'envoie qu'avec `sessionInfoVersion`, que nous n'avons
jamais passé. **Seule la v2 explique les deux silences.**

⚠️ **Ce que ça corrige.** L'entrée `brain/LEARNINGS.md` du 2026-08-17 (« la popup ne dit RIEN au second
passage ») attribue au second passage un silence qui était déjà là au premier, et que la doc explique. Le
repêchage par `debug_token` reste utile (il couvre un message perdu, en v4 aussi). L'entrée est annotée dès
maintenant et se corrige pour de bon après l'essai réel (tâche 6).

**Où Julien confirme (deux minutes, rien à créer) :**

1. Relever l'identifiant utilisé : `grep '^META_ES_CONFIG_ID=' /home/ubuntu/mba/.env.prod` sur le VPS, ou, dans la
   console, l'Accueil d'un espace sans numéro, outils du navigateur, onglet Réseau, réponse de
   `embedded-signup/config`, champ `configId`.
2. developers.facebook.com, app `988129420727963`, menu Facebook Login for Business, Configurations : ouvrir la
   configuration qui porte cet identifiant.
3. Y lire deux choses. **Des produits** (Cloud API, Marketing Messages, Click to WhatsApp, Conversions API)
   sont-ils associés ? Aucun : configuration d'avant la v4, donc v2 avec notre appel. **L'expiration du jeton** :
   60 jours attendus, vu le nom du modèle.

Quel que soit le verdict, la configuration A1 reste nécessaire, à cause du jeton (section 3). Le verdict change
l'échéance : en v2, c'est le 15 octobre ; déjà en v4, seule l'échéance des jetons reste.

## 3. Trouvé en chemin : les jetons clients expirent à 60 jours, et se reconnecter ne répare pas

- **Le modèle fixe l'expiration.** Selon la doc Facebook Login for Business, une configuration choisit le type de
  jeton ET son expiration, et un jeton « business integration system user » n'expire jamais par défaut. Le modèle
  retenu le 2026-07-16 porte « 60 Expiration Token » dans son nom.
- **Ces jetons portent TOUS les envois d'un espace embarqué** (`src/meta/credentials.ts`, depuis le lot B1). À
  l'expiration, le premier envoi reçoit une erreur 190, `markTokenInvalid` marque le WABA, et plus rien ne part.
  Les messages entrants arrivent toujours (l'abonnement webhook ne dépend pas du jeton), donc la panne se voit à
  la première réponse.
- **Défaut n°1 : se reconnecter ne répare pas.** `saveCredentials` (`src/account/es-store.pg.ts`) remplace le jeton
  mais ne remet ni `token_status` à `'active'` ni `token_invalid_at` à null, et rien d'autre dans le dépôt n'écrit
  `'active'` (grep sur `token_status`). Un espace dont le jeton est mort resterait bloqué APRÈS reconnexion.
- **Défaut n°2, sur le même chemin.** `markTokenInvalid(wabaId)` invalide la LIGNE, pas le jeton qui a échoué. Un
  client construit avant une reconnexion (une campagne en cours) qui reçoit un 190 avec l'ancien jeton
  condamnerait le nouveau. C'est le jeton de garde de `src/campaign/run-lock.ts`, qui manque ici.
- **Défaut n°3 : aucun espace connecté ne peut se reconnecter depuis la console.** La zone de connexion ne
  s'affiche que sans numéro (`page.tsx`, condition `account && !account.hasNumber`). Côté serveur, rejouer
  l'inscription sur le MÊME numéro est idempotent (`linkTenant` le dit en commentaire) : seule l'entrée manque.
- **L'exposition n'est pas mesurée.** La lecture de `waba_credentials` en production a été refusée à cette session
  par la garde « lecture de production ». Si l'embarquement du 2026-08-17 est toujours rattaché, son jeton expire
  vers le 16 octobre 2026, lendemain de l'échéance Meta. À mesurer par Julien : la requête ci-dessous (dates en
  base), puis la sonde de la tâche 3 (expiration exacte, lue chez Meta).

```sql
select t.name as espace, c.waba_id, c.created_at, c.updated_at, c.token_status, c.token_invalid_at
from public.waba_credentials c join public.tenants t on t.id = c.tenant_id
order by c.created_at;
```

## 4. La proposition

### A. Obligatoire avant le 15 octobre 2026

| # | Quoi | Qui | Où |
|---|---|---|---|
| A0 | Confirmer la version et l'expiration du jeton (section 2), lancer la requête de la section 3 | Julien | Meta, VPS |
| A1 | Créer la configuration v4 (pas à pas ci-dessous) | Julien | Meta |
| A2 | Refuser proprement un numéro non vérifié | code | tâche 1 |
| A3 | Une reconnexion remet le jeton actif, et seul le jeton qui a échoué est invalidé | code | tâche 2 |
| A4 | Sonde d'expiration des jetons, en lecture seule | code, puis Julien la lance | tâche 3 |
| A5 | Bascule de `META_ES_CONFIG_ID` et essai réel | Julien donne le go | tâche 4 |
| A6 | Entrée « Renouveler la connexion Meta », puis reconnexion des espaces embarqués avant l'expiration de leur jeton | code, puis chaque admin | tâche 5, seulement si A0 trouve des espaces clients |

**A1, la configuration, pas à pas** (d'après la page `version-4`) :

1. App `988129420727963`, Facebook Login for Business, Configurations, « Create configuration ». Une configuration
   NOUVELLE : c'est ce qui fait la v4.
2. Variante de connexion : Embedded Signup (WhatsApp).
3. Produits : **Cloud API, et lui seul.** Chaque produit ajoute des écrans et des permissions soumises à l'accès
   avancé ; les pubs sont traitées en C.
4. Jeton : jeton d'utilisateur système, expiration **jamais** si l'assistant la propose. S'il ne la propose pas, la
   sonde de la tâche 3 dira ce qu'on a obtenu.
5. Actifs et permissions : ceux que le produit coche lui-même (comptes WhatsApp Business ;
   `whatsapp_business_management`, `whatsapp_business_messaging`), rien de plus. La doc prévient qu'un actif
   demandé sans besoin fait abandonner les clients.
6. Copier le nouvel identifiant. Il n'est pas secret : il part dans le navigateur.
7. **Garder l'ancienne configuration** : c'est le retour arrière, valable jusqu'au 15 octobre.
8. Au passage, vérifier : Facebook Login for Business, Settings, les six interrupteurs de « Client OAuth settings »
   à Yes (Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Strict Mode for
   redirect URIs, Login with the JavaScript SDK) ; `engageme.messagingme.app` dans « Allowed Domains » ET dans
   « Valid OAuth Redirect URIs », sans retirer `mba.messagingme.app` ; le champ de webhook `account_update` coché
   (WhatsApp, Configuration). Notre analyseur l'ignore sans erreur : `src/webhooks/parse.ts` n'extrait que les
   messages, les statuts, les échos et les changements de contrôle.

**Côté front : aucun changement obligatoire**, parce que notre appel est déjà l'appel v4 officiel, que l'écouteur
capte tout événement portant les deux identifiants, et qu'un message v4 est une chaîne JSON venue de
`www.facebook.com`, acceptée par l'origine ancrée.

**Ordre imposé** : tâches 1 à 3 déployées (API) AVANT la bascule ; tâche 2 déployée AVANT toute reconnexion d'un
espace existant. Aucune migration de base : `token_status` et `token_invalid_at` existent depuis 0043.

### B. Utile, sans échéance (hors publicité)

- Front : sur `CANCEL`, montrer le message d'erreur de Meta et son `session_id` (Meta le demande au support), ou
  l'écran abandonné (`current_step`), au lieu de « Connexion Meta annulée ou refusée » ; sur `FINISH_ONLY_WABA`,
  dire tout de suite « tu as terminé sans numéro » au lieu d'attendre le refus du serveur.
- Garder le `business_id` du message de session (le portefeuille du client) : c'est le `client_business_id` de
  l'API de gestion des jetons, et le chantier pub en aura besoin.
- Afficher l'état du jeton dans la console (reste du point 4.1 de `PLAN.md`).
- `FB.init` en `v26.0`, comme la doc le conseille. Sans effet sur l'inscription, qui n'appelle pas l'API par le SDK.

### C. Pour le chantier publicitaire (ne rien faire maintenant)

- **Ce que la v4 apporte.** Le produit « Click to WhatsApp » (actifs : WABA, Pages, comptes pub ; accès avancé sur
  `ads_read`, `ads_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list`), « Conversions API
  for CTWA » (WABA et pixels ; `whatsapp_business_manage_events`) et l'API d'événements automatiques. Le message de
  session rend alors `ad_account_ids`, `page_ids` et `dataset_ids` (seulement si le client en a choisi), et Meta
  **lie lui-même le numéro à la Page** quand on embarque vers les pubs Click to WhatsApp.
- **Pourquoi pas dans la configuration WhatsApp.** La v4 exige l'accès avancé sur toutes les permissions que les
  produits cochent. Y mettre CTWA rendrait l'inscription WhatsApp de TOUS les clients dépendante d'une revue d'app
  pub pas encore obtenue (la spec pub pilote en accès « Limited »), et demanderait une Page et un compte pub à des
  clients qui n'en veulent pas.
- **Pour le lot 2 de la spec pub (« Connecter »), sans rouvrir sa décision** (un bouton séparé, une seconde
  configuration `META_ADS_CONFIG_ID`) : cette seconde configuration peut être une configuration v4 avec Cloud API
  et CTWA (et Conversions API). Gains attendus : Meta lie la Page au numéro (la spec le fait à la main, avec le code
  reçu dans l'Inbox), et les identifiants arrivent dans le message de session au lieu d'être lus dans
  `debug_token`. À mesurer au lot 2 : l'inscription rejouée sur un espace déjà embarqué, et ce que porte le jeton.
- **Un manque dans la spec pub** : la Conversions API pour CTWA demande `whatsapp_business_manage_events`, absente de
  sa liste de permissions. À ajouter le jour où le renvoi des conversions est décidé.

### À côté : la décision ouverte « OTP post-octobre » (`todo.md`, Décisions ouvertes)

`only_waba_sharing` (sauter l'écran du numéro) n'existe qu'en v2 et disparaît le 15 octobre ; la v3 l'avait déjà
retiré le 29 mai 2025. La v4 a une fin « sans numéro » (`FINISH_ONLY_WABA`), mais c'est le client qui la choisit :
aucun écran ne peut être sauté par le partenaire. Le « pari optimiste » de `PROJET-MBA-CONSOLE.md` §12 est donc à
moitié vrai. `todo.md` n'est pas modifié par ce plan (une autre session l'a en cours).

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff**, parce que les quatre questions du `CLAUDE.md` global y mènent :
la production emprunte ces chemins (le seul chemin d'inscription, et l'intercepteur d'authentification par lequel
passe CHAQUE envoi d'un espace embarqué) ; une erreur coûte chez un vrai client (un register raté consomme un des
10 essais sur 72 heures, un jeton invalidé à tort coupe les envois d'un espace) ; une partie des critères ne se voit
que chez Meta ; et le code porte des règles invisibles (le cycle de vie de `token_status`, l'ordre rattacher,
abonner, register, le jeton de garde). La configuration A1 et la bascule sont des gestes de Julien.

**L'essai réel qui clôt la migration** : après la bascule, un vrai embarquement sur un espace d'essai avec un vrai
numéro. On doit voir dans la console du navigateur `[ES] message reçu` avec `WA_EMBEDDED_SIGNUP` et `FINISH`, puis
`[ES] ids capturés` ; côté serveur, AUCUNE ligne « identifiants retrouvés depuis le token » ; un message envoyé et
reçu dans les deux sens ; et la sonde de la tâche 3 qui dit « expire jamais » pour ce jeton. Puis, si la tâche 5
existe, un second passage sur le même espace, pour savoir enfin ce que la v4 envoie la seconde fois.

## Rayon de souffle (dépendants énumérés avant d'écrire)

| Symbole touché | Qui le lit ou l'appelle | Ce qui doit suivre |
|---|---|---|
| `EsPhoneInfo`, `getPhone` | la route `complete` (câblage `src/index.ts`, bloc `embeddedSignup`) ; `listPhones` partage le type | champ OPTIONNEL : les fixtures existantes restent valides |
| route `complete`, étape 2 bis | `ConnectNumberZone` (affiche `error`) | rien : le message part tel quel |
| `ResolvedToken` | `src/meta/factory.ts` (six méthodes), `src/workflow/wiring.ts` (ne lit que `token`), tests | `tokenEnc` partout où on en construit un |
| `onError` | un seul appelant, `factory.guard` | signature changée : le compilateur trouve l'appelant |
| `invalidate` | le résolveur et ses tests (`src/http/email.ts` appelle un AUTRE résolveur) | second paramètre requis |
| `markTokenInvalid` | câblages `src/index.ts` et `src/worker.ts`, store, test d'intégration | paramètre REQUIS dans le store : un câblage `(w) => store.markTokenInvalid(w)` ne compile plus, c'est voulu |
| `saveCredentials` | la route d'inscription seule | aucun autre écrivain |
| « `markTokenInvalid` garde la 1re date » | test d'intégration existant | la date repart de null à chaque reconnexion, c'est le sens voulu |
| `ConnectNumberZone` (tâche 5) | l'Accueil seul | comportement inchangé, code déplacé dans un hook |

---

### Tâche 1 : refuser proprement un numéro non vérifié (A2)

**Files :**
- Modifier : `src/meta/embedded-signup.ts` (`EsPhoneInfo`, `getPhone`)
- Modifier : `src/http/embedded-signup.ts` (type de `getPhone` dans `EmbeddedSignupRouteDeps`, variable `phone`,
  étape 2 bis)
- Tests : `tests/meta-embedded-signup-client.test.ts`, `tests/embedded-signup.test.ts`

**Interfaces :**
- Produit : `EsPhoneInfo.codeVerificationStatus?: string | null` ; le `getPhone` des deps de la route rend
  `{ displayPhoneNumber, verifiedName, status, codeVerificationStatus? }`.

- [ ] **Étape 0 : mesurer avant de coder.** Le champ doit être lisible sur le nœud numéro (la page
  « Business phone numbers » le montre dans sa réponse type). Avec le jeton System User, sur NOTRE numéro (le
  Zadarma de production, `phone_number_id` relevé dans `brain/PROJECTS.md`), en lecture seule, jeton jamais
  affiché :

```bash
set -a; . ./.env; set +a
curl -s "https://graph.facebook.com/v25.0/1234840649713976?fields=id,status,code_verification_status" \
  -H "Authorization: Bearer $META_ACCESS_TOKEN"
```

  Attendu : un JSON avec `code_verification_status` (par exemple `VERIFIED`). Une erreur sur ce champ arrête la
  tâche : on ne l'ajoute pas à l'appel qui sert de preuve d'appartenance.

- [ ] **Étape 1 : test du client, qui échoue.** Ajouter à la fin de `tests/meta-embedded-signup-client.test.ts` :

```ts
describe('getPhone', () => {
  it('demande code_verification_status et le rend (la v4 laisse finir avec un numéro NON vérifié)', async () => {
    const urls = fausseReponse({ id: 'pn-1', display_phone_number: '+33600000000', status: 'PENDING', code_verification_status: 'NOT_VERIFIED' });
    const phone = await client().getPhone('pn-1', 'TOKEN_CLIENT');
    expect(urls[0]).toContain('code_verification_status');
    expect(phone.codeVerificationStatus).toBe('NOT_VERIFIED');
  });

  it('champ absent -> null, et rien ne sera refusé sur cette base', async () => {
    fausseReponse({ id: 'pn-1', status: 'CONNECTED' });
    expect((await client().getPhone('pn-1', 'T')).codeVerificationStatus).toBeNull();
  });
});
```

- [ ] **Étape 2 :** `npx vitest run tests/meta-embedded-signup-client.test.ts`. Attendu : ÉCHEC (l'URL ne demande pas
  le champ, `codeVerificationStatus` vaut `undefined`).

- [ ] **Étape 3 : le client.** Dans `src/meta/embedded-signup.ts`, ajouter le champ à `EsPhoneInfo` :

```ts
  /**
   * Vérification du numéro par code (`VERIFIED`, `NOT_VERIFIED`...). Lue par `getPhone` seulement. Depuis la v4 de
   * l'inscription, un client peut terminer avec un numéro NON vérifié, que `register` refuserait.
   */
  codeVerificationStatus?: string | null;
```

  et dans `getPhone`, demander le champ et le rendre :

```ts
    const qs = new URLSearchParams({ fields: 'id,display_phone_number,verified_name,status,code_verification_status' });
    // ... appel inchangé ...
    return {
      id: typeof b['id'] === 'string' ? b['id'] : phoneNumberId,
      displayPhoneNumber: typeof b['display_phone_number'] === 'string' ? b['display_phone_number'] : null,
      verifiedName: typeof b['verified_name'] === 'string' ? b['verified_name'] : null,
      status: typeof b['status'] === 'string' ? b['status'] : null,
      codeVerificationStatus: typeof b['code_verification_status'] === 'string' ? b['code_verification_status'] : null,
    };
```

- [ ] **Étape 4 :** relancer l'étape 2. Attendu : PASSE.

- [ ] **Étape 5 : tests de la route.** Dans `tests/embedded-signup.test.ts`, bloc `describe('POST /embedded-signup/complete')` :

```ts
  /**
   * v4 de l'inscription : on peut y terminer avec un numéro NON vérifié (la v2 imposait un numéro vérifié). Le
   * register d'un tel numéro échoue, et chaque tentative consomme une des 10 permises par numéro sur 72 h
   * (au-delà : erreur 133016 et numéro bloqué 72 h). On refuse donc AVANT de rattacher quoi que ce soit.
   */
  it('v4 : numéro NON vérifié -> 422 avec la marche à suivre, RIEN rattaché ni registré', async () => {
    const { server, cap } = app({
      getPhone: async () => ({ displayPhoneNumber: '+33600000000', verifiedName: null, status: 'PENDING', codeVerificationStatus: 'NOT_VERIFIED' }),
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/pas été vérifié/);
    expect(cap.linked).toHaveLength(0);
    expect(cap.subscribed).toHaveLength(0);
    expect(cap.registered).toHaveLength(0);
    expect(cap.saved).toHaveLength(0);
    await server.close();
  });

  it('numéro déjà CONNECTED : rattaché quel que soit son code_verification_status (le statut prime)', async () => {
    const { server, cap } = app({
      getPhone: async () => ({ displayPhoneNumber: '+33600000000', verifiedName: 'X', status: 'CONNECTED', codeVerificationStatus: 'NOT_VERIFIED' }),
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(cap.linked).toHaveLength(1);
    expect(cap.registered).toHaveLength(0);
    await server.close();
  });

  it('EXPIRED sur un numéro neuf : register TENTÉ comme avant (valeur jamais mesurée, on ne la refuse pas)', async () => {
    const { server, cap } = app({
      getPhone: async () => ({ displayPhoneNumber: null, verifiedName: null, status: 'PENDING', codeVerificationStatus: 'EXPIRED' }),
    });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/embedded-signup/complete', ...h(adminTok), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(cap.registered).toHaveLength(1);
    await server.close();
  });
```

- [ ] **Étape 6 :** `npx vitest run tests/embedded-signup.test.ts`. Attendu : le test « NON vérifié » ÉCHOUE
  (`expected 200 to be 422`) ; les deux autres passent déjà (ils décrivent l'existant qu'on garde).

- [ ] **Étape 7 : la route.** Dans `src/http/embedded-signup.ts`, ajouter `codeVerificationStatus?: string | null` au
  type de retour de `getPhone` dans `EmbeddedSignupRouteDeps` ET au type de la variable `phone`, puis insérer, juste
  après le `try/catch` de l'étape 2 et avant `const warnings: string[] = [];` :

```ts
    // 2 bis. NUMÉRO NON VÉRIFIÉ. La v4 de l'inscription laisse terminer avec un numéro non vérifié (la v2 imposait un
    //        numéro vérifié). `register` le refuserait, et chaque tentative consomme une des 10 permises par numéro
    //        sur 72 h (au-delà, erreur 133016 et numéro bloqué 72 h). On refuse donc AVANT de rattacher quoi que ce
    //        soit. Seul NOT_VERIFIED est refusé : EXPIRED n'a jamais été mesuré, et un numéro CONNECTED n'a pas
    //        besoin de register.
    if (phone.status !== 'CONNECTED' && phone.codeVerificationStatus === 'NOT_VERIFIED') {
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: numéro non vérifié refusé (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId})`);
      return reply.code(422).send({
        error: "ce numéro n'a pas été vérifié dans la fenêtre Meta. Relance « Connecter mon compte WhatsApp » et va jusqu'à la saisie du code reçu par SMS ou par appel.",
      });
    }
```

- [ ] **Étape 8 :** `npx vitest run tests/embedded-signup.test.ts tests/meta-embedded-signup-client.test.ts`, puis
  `npm run typecheck` et `npm test`. Attendu : tout vert.

- [ ] **Étape 9 : dans les deux sens.** Mettre le `if` de l'étape 2 bis en commentaire, relancer : le test « NON
  vérifié » échoue avec `expected 200 to be 422`. Restaurer, relancer : vert.

- [ ] **Étape 10 : commit.**

```bash
git commit --only src/meta/embedded-signup.ts src/http/embedded-signup.ts tests/meta-embedded-signup-client.test.ts tests/embedded-signup.test.ts \
  -m "fix(embedded signup): la v4 laisse finir avec un numero non verifie, on le refuse avant de rattacher" \
  -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Tâche 2 : une reconnexion remet le jeton actif, et seul le jeton qui a échoué est invalidé (A3)

**Files :**
- Modifier : `src/meta/credentials.ts` (`CredentialsResolverDeps.markTokenInvalid`, `ResolvedToken`, cache,
  `invalidate`, `onError`)
- Modifier : `src/meta/factory.ts` (les six méthodes et `guard`)
- Modifier : `src/account/es-store.pg.ts` (`saveCredentials`, `markTokenInvalid`)
- Modifier : `src/index.ts` et `src/worker.ts` (câblage de `markTokenInvalid`, une ligne chacun)
- Tests : `tests/meta-credentials.test.ts`, `tests/meta-factory.test.ts`, `tests/integration/stores.integration.test.ts`

**Interfaces :**
- Produit : `ResolvedToken { token: string; wabaId: string | null; tokenEnc: string | null }`
- Produit : `MetaCredentialsResolver.onError(err: unknown, servi: Pick<ResolvedToken, 'wabaId' | 'tokenEnc'>): Promise<void>`
- Produit : `MetaCredentialsResolver.invalidate(wabaId: string, tokenEnc: string): Promise<void>`
- Produit : `CredentialsResolverDeps.markTokenInvalid(wabaId: string, tokenEnc: string): Promise<void>` et
  `PgEmbeddedSignupStore.markTokenInvalid(wabaId: string, tokenEnc: string): Promise<void>`

- [ ] **Étape 1 : tests du résolveur.** Dans `tests/meta-credentials.test.ts` :
  - le faux `markTokenInvalid` de `makeDeps` devient le miroir de la garde SQL :

```ts
    // Miroir de la garde SQL : seul le jeton QUI A ÉCHOUÉ est invalidé.
    markTokenInvalid: async (w, enc) => { invalidated.push(w); if (creds[w] && creds[w]!.businessTokenEnc === enc) creds[w]!.tokenStatus = 'invalid'; },
```

  - les deux tests « SOMMEIL » attendent `{ token: 'GLOBAL_TOKEN', wabaId: null, tokenEnc: null }` ;
  - le test `invalidate` appelle `r.invalidate('wabaA', 'enc:TOK_A')` ;
  - les appels à `onError` passent l'objet servi : `{ wabaId: 'wabaA', tokenEnc: 'enc:TOK_A' }`,
    `{ wabaId: 'wabaB', tokenEnc: 'enc:TOK_B' }`, `{ wabaId: 'wabaA', tokenEnc: 'enc:TOK' }` (test « DB down ») et
    `{ wabaId: null, tokenEnc: null }` ;
  - deux tests neufs :

```ts
  it('résolution : rend le jeton CHIFFRÉ qui a servi, depuis la base comme depuis le cache', async () => {
    const { deps } = makeDeps({ tenants: { tA: 'wabaA' }, creds: { wabaA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' } } });
    const r = new MetaCredentialsResolver(deps);
    expect(await r.resolveForTenant('tA')).toEqual({ token: 'TOK_A', wabaId: 'wabaA', tokenEnc: 'enc:TOK_A' });
    expect(await r.resolveForTenant('tA')).toEqual({ token: 'TOK_A', wabaId: 'wabaA', tokenEnc: 'enc:TOK_A' });
  });

  it('🔴 un 190 venu de l’ANCIEN jeton ne condamne pas le NOUVEAU (client construit avant une reconnexion)', async () => {
    const creds: Record<string, { businessTokenEnc: string; tokenStatus: 'active' | 'invalid' }> = {
      wabaA: { businessTokenEnc: 'enc:VIEUX', tokenStatus: 'active' },
    };
    const { deps } = makeDeps({ tenants: { tA: 'wabaA' }, creds });
    const r = new MetaCredentialsResolver(deps);
    const servi = await r.resolveForTenant('tA'); // une campagne construit son client avec le vieux jeton
    creds.wabaA = { businessTokenEnc: 'enc:NEUF', tokenStatus: 'active' }; // le client se reconnecte entre-temps
    await r.onError(new MetaApiError(401, { code: 190, message: 'x', type: 'OAuthException' }), servi);
    expect(creds.wabaA.tokenStatus).toBe('active');
    expect((await r.resolveForTenant('tA')).token).toBe('NEUF'); // cache purgé, le neuf est servi
  });
```

- [ ] **Étape 2 : test de la fabrique.** Dans `tests/meta-factory.test.ts`, bloc `MetaClientFactory (B1 : câblage par tenant)` :

```ts
  it('🔴 intercepteur : invalide le jeton QUI A SERVI, pas « le WABA » (garde de reconnexion)', async () => {
    const t = new FakeTransport([{ status: 401, json: { error: { code: 190, type: 'OAuthException', message: 'x' } } }]);
    const marques: Array<[string, string]> = [];
    const r = new MetaCredentialsResolver({
      getWabaIdForTenant: async () => 'wA',
      getCredentialsByWaba: async () => ({ businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' }),
      markTokenInvalid: async (w, enc) => { marques.push([w, enc]); },
      decrypt: (enc) => enc.replace(/^enc:/, ''),
      fallbackToken: 'GLOBAL',
    });
    const sender = await factory(r, t).senderForTenant('tA', 'pnA');
    await expect(sender.sendTemplate('33600000001', { name: 'promo', language: 'fr' })).rejects.toBeTruthy();
    expect(marques).toEqual([['wA', 'enc:TOK_A']]);
  });
```

- [ ] **Étape 3 :** `npx vitest run tests/meta-credentials.test.ts tests/meta-factory.test.ts`. Attendu : ÉCHECS
  (`tokenEnc` absent des résolutions, `marques` vaut `[['wA', undefined]]`).

- [ ] **Étape 4 : le résolveur** (`src/meta/credentials.ts`).

```ts
  /**
   * Marque invalide le jeton d'un WABA (sur erreur d'auth). Best-effort.
   *
   * 🔴 `tokenEnc` = le jeton CHIFFRÉ QUI A ÉCHOUÉ, tel que lu en base. Seul CE jeton est invalidé : un client
   * construit avant une reconnexion (une campagne en cours) qui échoue avec l'ancien jeton ne doit pas condamner le
   * nouveau. C'est le jeton de garde de `src/campaign/run-lock.ts`, appliqué aux jetons Meta.
   */
  markTokenInvalid(wabaId: string, tokenEnc: string): Promise<void>;
```

```ts
/** Token résolu, le WABA d'origine, et le jeton CHIFFRÉ qui a servi (null = token global de repli). */
export interface ResolvedToken {
  token: string;
  wabaId: string | null;
  tokenEnc: string | null;
}
```

```ts
  private readonly cache = new Map<string, { token: string; tokenEnc: string; at: number }>();

  async resolveForTenant(tenantId: string): Promise<ResolvedToken> {
    const wabaId = await this.deps.getWabaIdForTenant(tenantId);
    if (!wabaId) return { token: this.deps.fallbackToken, wabaId: null, tokenEnc: null };
    return this.resolveForWaba(wabaId);
  }

  async resolveForWaba(wabaId: string): Promise<ResolvedToken> {
    const cached = this.cache.get(wabaId);
    if (cached && this.now() - cached.at < this.ttl) return { token: cached.token, wabaId, tokenEnc: cached.tokenEnc };

    const cred = await this.deps.getCredentialsByWaba(wabaId);
    if (!cred) return { token: this.deps.fallbackToken, wabaId: null, tokenEnc: null }; // sommeil
    if (cred.tokenStatus === 'invalid') throw new TokenInvalidError(wabaId);

    const token = this.deps.decrypt(cred.businessTokenEnc);
    this.cache.set(wabaId, { token, tokenEnc: cred.businessTokenEnc, at: this.now() });
    return { token, wabaId, tokenEnc: cred.businessTokenEnc };
  }

  async invalidate(wabaId: string, tokenEnc: string): Promise<void> {
    this.cache.delete(wabaId);
    try {
      await this.deps.markTokenInvalid(wabaId, tokenEnc);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`markTokenInvalid ignoré pour ${wabaId}:`, err instanceof Error ? err.message : err);
    }
  }

  /** À appeler dans un catch d'appel Meta, avec CE QUI A SERVI : n'invalide que ce jeton-là, et seulement sur une erreur d'auth. */
  async onError(err: unknown, servi: Pick<ResolvedToken, 'wabaId' | 'tokenEnc'>): Promise<void> {
    if (servi.wabaId && servi.tokenEnc && isMetaAuthError(err)) await this.invalidate(servi.wabaId, servi.tokenEnc);
  }
```

- [ ] **Étape 5 : la fabrique** (`src/meta/factory.ts`). Importer `type ResolvedToken` à côté de
  `MetaCredentialsResolver`. Chacune des six méthodes garde ce qui a servi et le donne à `guard`, par exemple :

```ts
  async templateClientForTenant(tenantId: string): Promise<MetaTemplateClient> {
    const servi = await this.o.resolver.resolveForTenant(tenantId);
    return this.guard(new MetaTemplateClient(servi.token, this.o.version), servi);
  }
```

  (`clientForTenant` passe `token: servi.token` au `MetaClient` et `servi` à `guard` ; `flowClientForTenant`,
  `pricingClientForTenant`, `phoneClientForTenant` et `mbaClientForTenant` suivent la même forme.) Puis :

```ts
  private guard<T extends object>(target: T, servi: ResolvedToken): T {
    const resolver = this.o.resolver;
    // ... Proxy inchangé, sauf le rejet :
    //   async (err: unknown) => { await resolver.onError(err, servi); throw err; },
  }
```

  Mettre à jour le commentaire de tête : l'intercepteur invalide le jeton QUI A SERVI, plus « le WABA ».

- [ ] **Étape 6 :** relancer l'étape 3. Attendu : PASSE.

- [ ] **Étape 7 : le store** (`src/account/es-store.pg.ts`). Dans `saveCredentials`, l'`on conflict` remet l'état :

```ts
    // 🔴 UN NOUVEAU JETON EST UN JETON VALIDE. Sans la remise à 'active', un espace dont le jeton est mort (expiré,
    // application retirée) restait bloqué APRÈS s'être reconnecté : le jeton neuf était stocké, mais `token_status`
    // restait 'invalid' et le résolveur refusait d'envoyer. Rien d'autre n'écrit 'active'.
    const res = await this.pool.query(
      `insert into waba_credentials (waba_id, tenant_id, business_token_enc, pin_enc)
       values ($1, $2, $3, $4)
       on conflict (waba_id) do update set
         tenant_id = excluded.tenant_id,
         business_token_enc = excluded.business_token_enc,
         pin_enc = coalesce(excluded.pin_enc, waba_credentials.pin_enc),
         token_status = 'active',
         token_invalid_at = null,
         updated_at = now()
       where waba_credentials.tenant_id = excluded.tenant_id`,
      [wabaId, tenantId, businessTokenEnc, pinEnc],
    );
```

  et `markTokenInvalid` ne vise que le jeton qui a échoué :

```ts
  async markTokenInvalid(wabaId: string, tokenEnc: string): Promise<void> {
    await this.pool.query(
      `update waba_credentials
       set token_status = 'invalid', token_invalid_at = coalesce(token_invalid_at, now()), updated_at = now()
       where waba_id = $1 and token_status <> 'invalid' and business_token_enc = $2`,
      [wabaId, tokenEnc],
    );
  }
```

- [ ] **Étape 8 : les câblages.** `npm run typecheck` échoue sur `src/index.ts` et `src/worker.ts` (argument
  manquant) : c'est le garde-fou. Écrire `markTokenInvalid: (w, enc) => esCredentialsStore.markTokenInvalid(w, enc),`
  dans `src/index.ts` et `markTokenInvalid: (w, enc) => esStore.markTokenInvalid(w, enc),` dans `src/worker.ts`.

- [ ] **Étape 9 : test d'intégration.** Dans `tests/integration/stores.integration.test.ts`, les deux appels
  existants `es.markTokenInvalid(wabaId)` deviennent `es.markTokenInvalid(wabaId, 'enc:TOK_LIVE')`, et on ajoute :

```ts
  it('PgEmbeddedSignupStore : une reconnexion REND le jeton actif, et un vieux jeton ne condamne pas le neuf', async () => {
    const es = new PgEmbeddedSignupStore(pool);
    const wabaId = 'waba-reconnexion';
    try {
      await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'w') on conflict (id) do nothing`, [wabaId, tenantId]);
      await es.saveCredentials(wabaId, tenantId, 'enc:VIEUX', null);
      await es.markTokenInvalid(wabaId, 'enc:VIEUX');
      expect((await es.getCredentialsByWaba(wabaId))?.tokenStatus).toBe('invalid');

      // Le client se reconnecte : jeton neuf, et l'espace doit pouvoir envoyer de nouveau.
      await es.saveCredentials(wabaId, tenantId, 'enc:NEUF', null);
      expect(await es.getCredentialsByWaba(wabaId)).toEqual({ businessTokenEnc: 'enc:NEUF', tokenStatus: 'active' });
      const ligne = (await pool.query<{ token_invalid_at: Date | null }>(`select token_invalid_at from waba_credentials where waba_id = $1`, [wabaId])).rows[0]!;
      expect(ligne.token_invalid_at).toBeNull();

      // Un envoi parti avec l'ANCIEN jeton échoue en 190 après la reconnexion : il ne condamne pas le neuf.
      await es.markTokenInvalid(wabaId, 'enc:VIEUX');
      expect((await es.getCredentialsByWaba(wabaId))?.tokenStatus).toBe('active');

      // Le neuf, lui, s'invalide normalement.
      await es.markTokenInvalid(wabaId, 'enc:NEUF');
      expect((await es.getCredentialsByWaba(wabaId))?.tokenStatus).toBe('invalid');
    } finally {
      await pool.query('delete from waba_credentials where waba_id = $1', [wabaId]);
      await pool.query('delete from waba where id = $1', [wabaId]);
    }
  });
```

- [ ] **Étape 10 :** `npm run typecheck` puis `npm test`. Attendu : vert. (Le test d'intégration ne se lance PAS en
  local.)

- [ ] **Étape 11 : dans les deux sens.**
  - Unitaire : dans `guard`, passer temporairement `{ wabaId: servi.wabaId, tokenEnc: null }` à `onError` ; le test
    « invalide le jeton QUI A SERVI » échoue (`marques` vide). Restaurer.
  - SQL : il ne tourne que dans la CI (pas de Docker sur le poste, et la base locale est la production). Pousser
    d'abord le test d'intégration seul : le job `integration` doit échouer sur
    `expected { businessTokenEnc: 'enc:NEUF', tokenStatus: 'invalid' } to equal { ... tokenStatus: 'active' }`
    (et `typecheck` sur l'appel à deux arguments, attendu lui aussi). Pousser ensuite le correctif : tout vert.
    ⚠️ Deux commits rouges assumés sur `main`, à valider par Julien avant de le faire.

- [ ] **Étape 12 : commits.**

```bash
git commit --only tests/integration/stores.integration.test.ts \
  -m "test(jetons): une reconnexion doit rendre le jeton actif (rouge attendu, correctif au commit suivant)" \
  -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git commit --only src/meta/credentials.ts src/meta/factory.ts src/account/es-store.pg.ts src/index.ts src/worker.ts tests/meta-credentials.test.ts tests/meta-factory.test.ts \
  -m "fix(jetons): une reconnexion remet le jeton actif, et seul le jeton qui a echoue est invalide" \
  -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Tâche 3 : sonde d'expiration des jetons, en lecture seule (A4)

**Files :**
- Créer : `scripts/sonde-jetons-es.mts`

**Interfaces :**
- Produit : une ligne par espace embarqué : espace, WABA, dates en base, statut en base, et ce que Meta dit du
  jeton (valide, type, expiration). Aucune écriture, aucun jeton affiché.

- [ ] **Étape 1 : le script.**

```ts
/**
 * Sonde LIVE de l'expiration des jetons clients de l'Embedded Signup. Lecture seule.
 *
 * Pourquoi : la configuration Facebook Login for Business créée le 2026-07-16 vient du modèle « WhatsApp Embedded
 * Signup Configuration With 60 Expiration Token », et ces jetons portent TOUS les envois de l'espace
 * (src/meta/credentials.ts). La sonde dit, pour chaque espace embarqué, quand son jeton expire, lu chez Meta.
 *
 * Un SELECT, puis un GET /debug_token par jeton, authentifié par le jeton d'APPLICATION (comme `wabasForToken`).
 * Le jeton n'est JAMAIS affiché : seulement ce que Meta dit de lui.
 *
 * Usage, sur le VPS, avec l'accord de Julien :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/sonde-jetons-es.mts:/app/scripts/sonde-jetons-es.mts \
 *     mba-api npx tsx scripts/sonde-jetons-es.mts
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const V = process.env.META_GRAPH_VERSION ?? 'v25.0';
const jetonApp = `${process.env.META_APP_ID ?? ''}|${process.env.META_APP_SECRET ?? ''}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

/** Meta rend des secondes Unix, 0 voulant dire « jamais ». */
const jour = (s: unknown): string => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString().slice(0, 10) : 'jamais');

try {
  const { rows } = await pool.query<{
    espace: string; waba_id: string; created_at: Date; updated_at: Date; token_status: string; business_token_enc: string;
  }>(
    `select t.name as espace, c.waba_id, c.created_at, c.updated_at, c.token_status, c.business_token_enc
       from waba_credentials c join tenants t on t.id = c.tenant_id
      order by c.created_at`,
  );
  console.log(`${rows.length} espace(s) embarqué(s) par l'Embedded Signup`);
  for (const r of rows) {
    const jeton = decryptSecret(r.business_token_enc, process.env.ENCRYPTION_KEY ?? '');
    const qs = new URLSearchParams({ input_token: jeton, access_token: jetonApp });
    const res = await fetch(`https://graph.facebook.com/${V}/debug_token?${qs.toString()}`);
    const body = (await res.json().catch(() => ({}))) as {
      data?: { is_valid?: boolean; type?: string; expires_at?: number; data_access_expires_at?: number; error?: { message?: string } };
    };
    const d = body.data ?? {};
    console.log([
      r.espace,
      `waba ${r.waba_id}`,
      `embarqué le ${r.created_at.toISOString().slice(0, 10)}`,
      `dernière écriture ${r.updated_at.toISOString().slice(0, 10)}`,
      `statut en base ${r.token_status}`,
      `HTTP ${res.status}`,
      `valide ${String(d.is_valid)}`,
      `type ${d.type ?? '?'}`,
      `expire ${jour(d.expires_at)}`,
      `accès aux données jusqu'au ${jour(d.data_access_expires_at)}`,
      d.error?.message ? `erreur Meta : ${d.error.message}` : '',
    ].filter(Boolean).join(' | '));
  }
} finally {
  await pool.end();
}
```

- [ ] **Étape 2 :** `npm run typecheck` (le script doit compiler avec le reste). Ne PAS le lancer depuis le poste.

- [ ] **Étape 3 : commit.**

```bash
git add scripts/sonde-jetons-es.mts
git commit --only scripts/sonde-jetons-es.mts \
  -m "feat(sonde): expiration des jetons clients de l'Embedded Signup, lue chez Meta, en lecture seule" \
  -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Étape 4 (Julien) :** la lancer sur le VPS (commande en tête du script) et reporter la sortie dans le
  journal de livraison. Une expiration datée confirme la section 3 ; « jamais » la dément, et A6 tombe.

### Tâche 4 : bascule et essai réel (A5)

Préalables : A1 fait (nouvel identifiant en main), tâches 1 à 3 déployées sur l'API par la séquence habituelle
(`DEPLOY.md`), sans migration.

- [ ] **Étape 1 : la CI du dernier commit de code est verte, job par job.**

```bash
gh run list --limit 5
gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'
```

- [ ] **Étape 2 : revue finale attestée** (la garde de déploiement l'exige pour le `docker compose up` qui suit).

- [ ] **Étape 3 (VPS, go de Julien) : changer l'identifiant.** Noter l'ANCIEN (il n'est pas secret, c'est le retour
  arrière), puis modifier la seule ligne `META_ES_CONFIG_ID=` de `/home/ubuntu/mba/.env.prod`. Sans copie de
  sauvegarde du fichier : il porte tous les secrets, et une copie hériterait de droits plus larges.

```bash
cd /home/ubuntu/mba
grep '^META_ES_CONFIG_ID=' .env.prod
```

- [ ] **Étape 4 : recréer l'API seule.** `env_file` n'est relu qu'à la recréation, et seul `mba-api` sert la
  configuration de l'inscription.

```bash
sudo docker compose up -d --force-recreate --no-deps mba-api
until [ "$(sudo docker inspect -f '{{.State.Health.Status}}' mba-api)" = healthy ]; do sleep 2; done
sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload
```

  Puis, depuis le poste : `node scripts/fumee.mjs`.

- [ ] **Étape 5 : l'essai réel** (Julien, sur `engageme.messagingme.app`) :
  1. un espace d'essai SANS numéro, outils du navigateur ouverts (Console et Réseau) ;
  2. l'onglet Réseau montre `embedded-signup/config` avec le NOUVEL identifiant ;
  3. « Connecter mon compte WhatsApp », jusqu'au bout, avec un vrai numéro jamais utilisé sur WhatsApp et capable
     de recevoir le code (SMS ou appel), dans le portefeuille MessagingMe ;
  4. la Console montre `[ES] message reçu` avec `WA_EMBEDDED_SIGNUP` et `FINISH`, puis `[ES] ids capturés`. Copier le
     message entier dans le journal : il dira aussi s'il porte un champ de version ;
  5. sur le VPS, `sudo docker logs mba-api --since 15m 2>&1 | grep embedded-signup` ne contient AUCUNE ligne
     « identifiants retrouvés depuis le token » ;
  6. un message envoyé au numéro depuis un téléphone, une réponse depuis l'Inbox : aller et retour ;
  7. la sonde de la tâche 3 dit « expire jamais » pour ce jeton.

- [ ] **Retour arrière** (jusqu'au 15 octobre seulement) : remettre l'ancien identifiant dans `.env.prod`, puis la
  même étape 4 et la fumée.

### Tâche 5 : l'entrée « Renouveler la connexion Meta » (A6, seulement si A0 trouve des espaces clients)

**Files :**
- Modifier : `web/app/accueil/page.tsx`

**Interfaces :**
- Produit : `useEmbeddedSignup(tenantId: string, isAdmin: boolean, onDone: () => void): { ready: boolean; busy: boolean; error: string | null; warnings: string[]; lancer: () => Promise<void> }`
- Produit : `RenouvelerConnexionMeta({ tenantId, onDone })`

- [ ] **Étape 1 : extraire le hook.** Créer `useEmbeddedSignup` juste au-dessus de `ConnectNumberZone` et y
  DÉPLACER, sans les modifier, les états (`cfg`, `busy`, `error`, `warnings`, `idsRef`), les deux `useEffect`
  (lecture de la configuration, écouteur `message`) et le corps de `connect()`, renommé `lancer`, où
  `onConnected()` devient `onDone()`. Le hook rend :

```ts
  return { ready: cfg?.enabled === true && isAdmin, busy, error, warnings, lancer };
```

  `ConnectNumberZone` appelle `const es = useEmbeddedSignup(tenantId, isAdmin, onConnected);` et lit `es.ready`,
  `es.busy`, `es.error`, `es.warnings`, `es.lancer` là où il lisait ses variables. Son rendu ne change pas.

- [ ] **Étape 2 : le bouton.**

```tsx
/** Rejoue l'inscription sur le numéro DÉJÀ rattaché : le serveur est idempotent sur le même numéro (`linkTenant`),
 *  et `saveCredentials` remet le jeton actif. Seule porte de sortie d'un espace dont le jeton est mort. */
function RenouvelerConnexionMeta({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const t = useT();
  const es = useEmbeddedSignup(tenantId, true, onDone);
  if (!es.ready) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => { void es.lancer(); }}
        disabled={es.busy}
        className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700 transition hover:bg-ink-100 disabled:opacity-60"
      >
        {es.busy ? t('Connexion en cours…', 'Connecting…') : t('Renouveler la connexion Meta', 'Renew Meta connection')}
      </button>
      <p className="mt-1 text-xs text-ink-400">
        {t("Rouvre la fenêtre Meta sur le même numéro. À faire si les envois s'arrêtent sur une erreur d'autorisation.", 'Reopens the Meta window on the same number. Do it if sending stops on an authorization error.')}
      </p>
      {es.error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{es.error}</p>}
    </div>
  );
}
```

  Le placer dans la carte `numero-card`, juste après le paragraphe « Moyen de paiement » :
  `{isAdmin && <RenouvelerConnexionMeta tenantId={session.tenantId} onDone={() => void loadAccount()} />}`.
  Un seul écouteur à la fois : la zone « Connecter » et la carte du numéro s'excluent (même ternaire).

- [ ] **Étape 3 :** dans `web/`, `npx tsc --noEmit` et `npm run build`. Attendu : vert.

- [ ] **Étape 4 : l'essai réel** : sur l'espace de la tâche 4, « Renouveler la connexion Meta » ; la Console montre
  le message de session (ou son absence, qu'on consigne : c'est la réponse à la question du 2026-08-17), la sonde
  montre un jeton neuf, et un envoi part.

- [ ] **Étape 5 : commit.**

```bash
git commit --only web/app/accueil/page.tsx \
  -m "feat(accueil): renouveler la connexion Meta d'un espace deja connecte" \
  -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Tâche 6 : ce que la doc et le cerveau retiennent

- [ ] `docs/JOURNAL-TECHNIQUE.md` : l'entrée datée de la livraison (version constatée, bascule, sortie de la sonde,
  message de session vu en vrai).
- [ ] `documentation.md` : l'invariant, au présent (la version de l'inscription se choisit dans la configuration
  Meta ; jetons sans expiration ; une reconnexion remet le jeton actif ; l'invalidation vise le jeton qui a échoué).
  ⚠️ Une autre session a ce fichier modifié : `git diff documentation.md` avant le `--only`, qui emporterait son
  travail avec le nôtre.
- [ ] `features.md` : le bouton « Renouveler la connexion Meta », si la tâche 5 a été faite.
- [ ] `brain/LEARNINGS.md` : clore l'entrée du 2026-09-22 (DORMANT vers PROMU) et corriger pour de bon celle du
  2026-08-17 avec ce que l'essai réel a montré.

## Calendrier proposé

- Du 22 au 25 septembre : A0 et A1 (Julien) ; tâches 1 à 3 codées, relues, CI verte.
- Semaine du 28 septembre : déploiement de l'API (revue finale), bascule, essai réel.
- Jusqu'au 15 octobre : retour arrière possible sur l'ancienne configuration ; tâche 5 et reconnexions, avant
  l'expiration des jetons que la sonde aura datée.

## Questions pour Julien

1. Quel numéro pour l'essai réel (un numéro du pool Zadarma, ou une ligne de test) ?
2. Les deux commits rouges assumés sur `main` pour prouver le SQL dans les deux sens (tâche 2, étape 11) : oui ou non ?
3. Ajouter aussi le produit Marketing Messages API à la configuration ? Pas obligatoire, et l'envoi par
   `/marketing_messages` reste réglé globalement (`META_MM_LITE`) : à décider à part.

---

## Priorité 1 (cadrée le 2026-09-22 au soir) : « Activer le numéro »

**Ce qui change par rapport à la tâche 1 ci-dessus, et pourquoi.** La tâche 1 refusait le parcours en 422 quand le
numéro n'était pas vérifié. La note du soir l'a écartée : « refuser en 422 et demander de recommencer tout le
parcours n'est pas une réponse acceptable pour un client ». Le numéro est donc RATTACHÉ, il est dit « à activer »,
et un bouton fait le reste dans notre console. Ce qui SURVIT de la tâche 1, intégralement : lire
`code_verification_status` avant toute tentative, et ne jamais appeler `register` sur un numéro non vérifié
(133006, et une des 10 requêtes permises par numéro sur 72 h brûlée pour rien).

**Trois mesures faites avant d'écrire une ligne, et elles réduisent le chantier :**

1. `code_verification_status` est DÉJÀ tiré de Meta (`src/meta/phone-number.ts`), DÉJÀ persisté (colonne
   `phone_numbers.code_verification_status`, migration 0028) et DÉJÀ rendu par `/account/status`
   (`src/http/account.ts`) jusque dans le type du navigateur (`web/lib/api/compte.ts`). Il n'est ni affiché ni
   utilisé. **Donc aucune migration** : l'état « à activer » se lit sur ce qui existe.
2. `MetaPhoneRegisterClient` (`src/meta/phone-register.ts`) porte déjà `requestCode` et `verifyCode`, écrits pour
   le pool de numéros et câblés NULLE PART. On les câble, on n'en écrit pas une seconde copie.
3. Le module `embeddedSignup` est monté en `g.admin` (`src/server.ts`) : les routes neuves y sont admin par
   construction, sans garde supplémentaire à poser ni à oublier.

**Arbitrages de Julien (AskUserQuestion, 2026-09-22 au soir) :**

- **Appel (VOICE) par défaut, SMS en second choix.** C'est le défaut de `MetaPhoneRegisterClient`, écrit pour les
  numéros Zadarma du pool où le SMS ne passe pas, et Meta déconseille le SMS sur un numéro VoIP. Le SMS reste
  offert à côté, parce qu'un numéro client ordinaire le reçoit très bien.
- **Le parcours vit DANS la carte du numéro de l'Accueil**, déplié en place. Aucune page ni modale nouvelle :
  l'état est déjà chargé par la carte, et une modale désynchroniserait la carte derrière elle.
- **L'essai réel qui clôt le chantier, ce sont les deux** : un embarquement neuf avec un numéro jamais utilisé qui
  s'active du premier coup, PUIS le bouton éprouvé sur un numéro laissé non vérifié.

**Ce qu'on ne fait PAS, et pourquoi :**

- 🔴 **Aucune relance automatique** (décision de Julien : « je ne veux pas un truc qui relance tout seul »). Un
  échec laisse le numéro « à activer », visible, et c'est le client qui décide quand réessayer. Une répétition
  invisible consommerait le plafond des 10 requêtes sans que personne ne le voie.
- **On ne compte pas nous-mêmes les 10 requêtes sur 72 h.** Meta n'expose aucun compteur, et les essais faits
  ailleurs (WhatsApp Manager, comme le 2026-09-22 au soir) y entrent aussi : un compteur maison afficherait un
  reste faux, donc pire que pas de reste du tout. On surface l'erreur 133016 telle quelle, en clair.
- **Aucun stockage d'un nouvel état.** « À activer » se DÉDUIT de `status` et `code_verification_status`. Une
  colonne de plus serait une seconde vérité à côté de ce que Meta dit, et c'est Meta qui tranche.

### Lot 1 : la route d'embarquement ne tente plus un register voué à l'échec

**Files :**
- Modifier : `src/meta/embedded-signup.ts` (`EsPhoneInfo`, `getPhone`), `src/http/embedded-signup.ts` (étape 5)
- Tests : `tests/meta-embedded-signup-client.test.ts`, `tests/embedded-signup.test.ts`

- [ ] `EsPhoneInfo.codeVerificationStatus?: string | null`, et `getPhone` demande
      `code_verification_status` dans ses `fields` et le rend (`null` si absent). `listPhones` reste inchangé :
      il ne sert qu'à retrouver un identifiant.
- [ ] Étape 5 de la route : `phone.status !== 'CONNECTED'` ET `codeVerificationStatus === 'NOT_VERIFIED'` ->
      on n'appelle PAS `register`, on pousse un avertissement qui DIT QUOI FAIRE, et on journalise. Seul
      `NOT_VERIFIED` retient le register : `EXPIRED` n'a jamais été mesuré et un numéro `CONNECTED` n'a pas
      besoin de register.
- [ ] **L'échec du register est journalisé côté serveur** avec le message de Meta. C'est ce qui a manqué le
      2026-09-22 au soir : la cause a failli être perdue, parce que la route se contentait de la rendre dans
      `warnings`, que l'écran effaçait.
- [ ] La réponse porte `aActiver: true` quand le numéro est rattaché sans être activable.
- [ ] Tests, dans les deux sens (le `if` mis en commentaire doit faire échouer le test).

### Lot 2 : les deux routes d'activation

**Files :**
- Modifier : `src/meta/phone-register.ts` (`requestCode` accepte le canal), `src/meta/factory.ts`
  (`phoneRegisterClientForTenant`), `src/http/embedded-signup.ts` (deux routes), `src/server.ts` (la limite
  coûteuse passée au module), `src/index.ts` (câblage), `src/account/es-store.pg.ts` (`enregistrerPin`)
- Tests : `tests/numero-activation.test.ts`

- [ ] `requestCode(phoneNumberId, opts?: { methode?: 'VOICE' | 'SMS'; language?: string })`. Un objet et non un
      second paramètre positionnel : l'ancien second paramètre était `language`, et le compilateur voit
      immédiatement un appelant qui passait une chaîne.
- [ ] `POST /tenants/:tenantId/numero/code`, corps `{ methode?: 'VOICE' | 'SMS' }`, VOICE par défaut.
      Elle LIT l'état chez Meta avant d'agir : `CONNECTED` -> 409 (déjà activé), `VERIFIED` -> 409 (il ne reste
      qu'à activer ; Meta refuserait en 136024). Anti-répétition de 60 s par numéro, en mémoire du process ->
      429. Échec Meta -> 422 avec son message, journalisé.
- [ ] `POST /tenants/:tenantId/numero/activer`, corps `{ code?: string }`. Elle LIT l'état, puis :
      `CONNECTED` -> 200 sans rien faire ; non vérifié -> le code est requis (400 sinon) et `verifyCode` passe
      avant ; puis `register` avec un PIN tiré au CSPRNG, **conservé chiffré seulement si Meta accepte**.
- [ ] Les deux portent `limiteCouteuse` : ce sont des appels Meta plafonnés, comme l'import ou l'aperçu.
- [ ] Le jeton du tenant ne remonte JAMAIS dans la route : le câblage résout le jeton et n'expose que des
      fonctions `(tenantId, ...)`. Même règle que pour le chiffrement de `saveCredentials`.

### Lot 3 : la carte du numéro dit l'état, et le bouton vit dedans

**Files :**
- Modifier : `web/lib/api/compte.ts`, `web/app/accueil/page.tsx`
- Tests : `web/e2e/accueil-activer-numero.spec.ts`

- [ ] La carte affiche « pas encore activé chez Meta », la raison, et le bouton, pour un numéro dont
      `status !== 'CONNECTED'`.
- [ ] Le panneau se déplie en place : canal (appel coché, SMS à côté), envoi du code, saisie du code,
      activation. Pas de « réessayer » en boucle, pas de minuteur qui relance.
- [ ] **L'avertissement de la connexion ne disparaît plus** : aujourd'hui `connect()` appelle `onConnected()`,
      qui remplace `ConnectNumberZone` (porteuse du message) par la carte du numéro. Le message remonte au
      niveau de la page.

### L'essai réel qui clôt la priorité 1

Un embarquement neuf avec un numéro jamais utilisé, dont l'activation aboutit sans intervention ; puis le bouton
éprouvé sur un numéro laissé non vérifié, code reçu par appel, saisi, numéro activé. Aucun test ne remplace ces
deux passages : les tests d'écran sont écrits par celui qui a écrit l'écran.
