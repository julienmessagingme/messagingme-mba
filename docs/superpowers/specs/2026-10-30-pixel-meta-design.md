# Le pixel Meta et la Conversions API : nos segments et nos look-alike (spec du 2026-10-30)

> Pour NOS publicités Meta (l'acquisition de clients de Messaging Me), pas pour celles d'un client. Cadrée avec Julien
> le 2026-10-30 en trois rondes de questions, puis relue à froid par un constructeur qui n'avait que ce document (ses
> six questions sont tranchées ici). Dans ce document, **décision** = tranché par Julien ; **choix de Claude**
> = un défaut proposé, à relire. Les faits sur Meta (format des événements, seuils des audiences) sont connus, **pas
> relus dans la doc aujourd'hui** : le plan les revérifie avant d'écrire le code.

## Ce que veut Julien

Poser le pixel sur le site et décider précisément ce qui remonte chez Meta, pour construire des segments (relancer un
visiteur selon ce qui l'intéresse), des look-alike et des campagnes que Meta sait optimiser. **Décision : la graine des
look-alike est le numéro connecté**, l'activation réelle d'un espace, plutôt que la simple inscription ou le paiement
(trop rare pour une graine).

## Ce qui existe aujourd'hui (relevé le 2026-10-30)

- **La vitrine (`app.messagingme.fr`, `site/`) n'a aucun traceur** : ni pixel, ni bannière de cookies, ni CSP. Ses
  en-têtes (`site/vercel.json`) : `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`. Elle n'a et ne doit
  avoir aucune variable d'environnement (`CLAUDE.md`).
- **La politique de confidentialité vit hors du dépôt**, sur `www.messagingme.fr` (lien du pied de page).
- **La console** (Next, `web/`) n'a pas de pixel. Sa CSP autorise déjà `connect.facebook.net`, pour le SDK de
  l'Embedded Signup (`web/lib/fb-sdk.ts`).
- **Le parcours change de domaine** : la vitrine renvoie vers `console.messagingme.app/signup` et `/login`. Les cookies
  posés sur `messagingme.fr` ne sont pas lus sur `messagingme.app`.
- **Les conversions naissent sur le serveur** :
  - une identité créée par e-mail : `POST /auth/signup` (`src/auth/routes.ts`) ;
  - une identité créée par Google : `entrerParGoogle` rendant `nouveau: true` (`src/auth/entree-google.ts`), appelée par
    `POST /auth/google` et par l'autorisation du plugin (`src/http/oauth.ts`, troisième route de création) ;
  - le premier numéro vérifié d'un espace, par TROIS filières : `offrir()` dans `src/account/connexion-numero.ts` (API
    Cloud, Embedded Signup ou outil MCP), `offrirCredit` dans `src/application/connexion.ts` (application WhatsApp
    Business), et le rattachement 360dialog (`src/http/connexion-360dialog.ts`, `src/account/rattacher-360dialog.ts`,
    par le client ou par `/ops/360dialog`), qui n'appelle pas `offrir()` ;
  - le paiement de Pro : `src/stripe/traitement-abonnements.ts` (Pro commence par 14 jours d'essai).
- **L'adresse e-mail n'est prouvée que par Google** (`emailVerified`, exigé par `entrerParGoogle`) : une inscription par
  e-mail ne vérifie pas que la personne possède l'adresse, et `identities` n'a aucune colonne de vérification.
- **Le premier admin d'un espace se lit déjà** : `users` (une ligne par espace et par adresse) porte `role` et
  `created_at`.
- **Les corps des trois routes de création se lisent sans schéma strict** (champ par champ pour `/auth/signup` et
  `/auth/google`, `z.object` non strict pour `src/http/oauth.ts`) : un champ inconnu envoyé à une API plus ancienne est
  ignoré, il ne casse rien.
- **Le portefeuille Meta de Messaging Me a déjà un pixel, relié au compte publicitaire** (décision : fait confirmé par
  Julien). Julien donne son identifiant.

## Premier canal : le pixel, sur la vitrine seulement

- **Il ne se charge qu'après « Accepter »** dans une bannière qui nomme Meta (Facebook) et dit à quoi sert le pixel
  (mesurer nos publicités, montrer nos publicités aux visiteurs). « Accepter » et « Refuser » ont le même poids. Le
  choix est retenu six mois, puis redemandé (choix de Claude, durée recommandée par la CNIL). Un lien « Gérer les
  cookies » du pied de page rouvre la bannière.
- **Le code de base seulement : `PageView` sur chaque page**, `/en/` comprise. Aucun `fbq('track')` sur un clic (choix
  de Claude) : un événement envoyé juste avant une navigation se perd (vécu sur newdevis, `brain/LEARNINGS.md`
  2026-06-08), et les vraies conversions partent du serveur. Les segments se construisent **chez Meta, par l'adresse
  de la page** (voir « Côté Meta »), sans code de plus.
- **L'identifiant du pixel s'écrit en dur dans `site/site.js`** : il est public par nature, et la vitrine n'a pas de
  variable.
- **Le raccord avec la console** : après « Accepter », `site.js` ajoute aux liens vers `console.messagingme.app` deux
  paramètres, `fbc` et `fbp`, qui portent la valeur des cookies `_fbc` et `_fbp` que le pixel a posés (`_fbc` n'existe
  que pour un visiteur arrivé d'une publicité, avec `fbclid`). Sans « Accepter », aucun paramètre. Sans ce raccord,
  Meta ne relie pas une inscription au clic sur la publicité, et l'optimisation des campagnes reste aveugle.
- **Rien du `fbclid` n'est gardé avant « Accepter »** (choix de Claude, la lecture prudente de la CNIL) : ni stockage, ni
  recopie dans les liens internes. Le pixel ne crée `_fbc` que s'il voit `fbclid` dans l'adresse au moment où il se
  charge : un visiteur qui accepte sur sa deuxième page perd l'attribution de son clic. Perte acceptée en v1.

## Second canal : la Conversions API, envoyée par notre serveur

| Événement | Quand | Valeur |
|---|---|---|
| `CompleteRegistration` | création d'une identité NOUVELLE (par e-mail ou par Google) ; un espace de plus pour une identité existante ne compte pas (choix de Claude) | aucune |
| `NumeroConnecte` (événement personnalisé) | premier numéro vérifié d'un espace, par l'une des trois filières (360dialog comprise, choix de Claude : c'est une activation comme les autres) ; une fois par espace, pour toujours | aucune |
| `Subscribe` | premier paiement de Pro d'un espace, selon la règle qui existe déjà (première facture payée non nulle, donc après l'essai) ; choix de Claude, pour des audiences pondérées par la valeur plus tard | montant et `EUR` |

- **La personne d'un événement d'espace** (`NumeroConnecte`, `Subscribe`) est l'admin le plus ancien de l'espace
  (`users.created_at`), rattaché à son identité (choix de Claude : aucune colonne neuve).
- **Ce qui part** : `user_data` porte `external_id` (SHA-256 de l'identifiant de l'identité), `fbc` et `fbp` s'ils ont
  été enregistrés, et pour `CompleteRegistration` seulement l'adresse IP et le navigateur de la requête d'inscription.
  🔴 **L'e-mail haché (SHA-256, minuscules, sans espaces) ne part que pour une adresse PROUVÉE** (décision) : aujourd'hui,
  une identité entrée par Google. Une identité inscrite par e-mail part sans son adresse, pour qu'on n'envoie jamais
  celle d'un tiers ; Meta la reconnaît moins bien, et c'est accepté. La preuve se lit au moment de l'envoi : le jour où
  une identité inscrite par e-mail entre par Google sur la même adresse, ses envois suivants portent l'e-mail. `action_source: website`, `event_source_url` la page de
  la console concernée, `event_time` le moment du fait (Meta refuse un événement de plus de sept jours).
- **Un fait donne un seul événement chez Meta, même rejoué.** L'`event_id` est stable et dérivé du fait (par exemple
  `numero:<espace>`) ; un envoi réussi se marque chez nous, et un fait déjà marqué ne repart pas. Meta ne fusionne deux
  envois de même `event_id` que sur une fenêtre courte : la marque de notre côté est ce qui tient au-delà.
- **L'envoi passe par une file du worker** (entrée dans `BASE_QUEUES`), jamais dans la requête. Mettre l'envoi en file
  ne fait jamais échouer ni ralentir le geste qui l'a déclenché : une panne se journalise et le geste réussit, comme
  `offrir()` le fait déjà pour le crédit. Le consentement se relit AU MOMENT DE L'ENVOI, pas à la mise en file.
- **La configuration** : `META_PIXEL_ID` et `META_CAPI_TOKEN` (le jeton, un secret, posé par Julien dans le conteneur
  de l'API ET dans le `.env.prod` de la machine des workers, qui envoient). Les deux vides : fonction éteinte, c'est le
  défaut (CI, poste). Une seule des deux : fonction éteinte et une ligne au démarrage, **jamais un refus de démarrer**
  (choix de Claude : un traceur publicitaire ne doit pas pouvoir arrêter l'API, à l'inverse de la paire Stripe). Le
  jeton n'entre jamais dans `web/` ni dans `site/`.

## Le consentement (décision : une case à l'inscription)

- **Sur la vitrine, la bannière ne gouverne que le pixel.**
- **Dans la console, une case NON cochée** accompagne chaque création de compte : `/signup` (e-mail et Google) et
  `/autoriser` (le parcours du plugin). Elle couvre les TROIS usages que la spec en fait (mesurer, recibler, servir de
  graine à un look-alike), sinon les audiences prévues côté Meta iraient au-delà du consentement. Texte proposé, à
  relire par Julien : « J'accepte que Messaging Me transmette à Meta (Facebook) mes étapes d'inscription, et mon
  adresse e-mail sous une forme non lisible, pour mesurer ses publicités, me les montrer et les montrer à des personnes
  au profil proche. »
- **Pas de consentement, pas d'événement** : case non cochée, ou absente (une identité née par Google depuis `/login`,
  par exemple), rien ne part pour cette identité tant qu'elle n'a pas consenti.
- **Le consentement peut naître après l'inscription** (choix de Claude) : l'interrupteur « Partage avec Meta » de la
  page de compte (`web/app/compte/`) accorde comme il retire, et une identité qui existe déjà et coche la case sur
  `/autoriser` ou sur le bouton Google de `/signup` voit son consentement enregistré. **Jamais de rattrapage** : un fait
  antérieur au consentement ne part pas (le `CompleteRegistration` d'un compte ancien, par exemple) ; seuls les faits
  qui suivent partent.
- **Ce qui s'enregistre** : sur l'identité (choix de Claude : la personne consent, pas l'espace), la date du
  consentement, et `fbc`/`fbp` seulement s'il est donné.
- **Le retrait est aussi simple que l'accord** : l'interrupteur efface la date et les `fbc`/`fbp`. Un envoi encore en
  file pour cette identité ne part plus.
- **`fbc` et `fbp` arrivent par l'adresse** (le raccord de la vitrine). La console les garde jusqu'à la requête de
  création de compte, qui les porte dans son corps (les trois routes de création acceptent le champ `pub`). Le parcours
  du plugin les perd (vitrine, puis Claude Code, puis `/autoriser`) : accepté en v1 (choix de Claude), Meta ne
  rapproche alors que par l'e-mail que Google a prouvé. Le serveur les valide (Zod, `safeParse`, format `fb.<chiffre>.
  <horodatage>.<valeur>`, longueur bornée) ; une valeur invalide est ignorée sans erreur.
- 🔴 **La politique de confidentialité est mise à jour AVANT l'allumage** (Julien, sur `www.messagingme.fr`) : elle
  cite le pixel, la Conversions API, Meta comme destinataire, et le retrait.

## Côté Meta (Julien)

- L'identifiant du pixel (il existe) et un jeton de la Conversions API (Gestionnaire d'événements, réglages du jeu de
  données, « Générer un jeton d'accès »).
- La vérification des domaines `messagingme.fr` et `messagingme.app` dans le Business Manager : une ligne TXT chez OVH
  et chez Cloudflare, aucun code.
- Les audiences proposées :
  - visiteurs du site sur 30, 90 et 180 jours ;
  - par intérêt, par l'adresse : `/solutions/assurance/`, `/solutions/shopify/` et `/shopify/`, `/developpeurs/` et
    `/en/developers/`, `/tarifs/` et `/en/pricing/` (l'intention la plus forte), et chaque autre secteur au besoin ;
  - les leads : `/contact/merci/` et `/en/contact/thanks/` ;
  - inscrits sans numéro : `CompleteRegistration` sur 180 jours, moins `NumeroConnecte`, pour relancer l'activation ;
  - **clients activés : `NumeroConnecte` sur 180 jours**, la graine d'un look-alike de 1 % en France, et l'exclusion
    des campagnes d'acquisition.
- ⚠️ **Un look-alike demande au moins une centaine de personnes reconnues dans sa graine**, et une campagne optimisée
  sur un événement en veut une cinquantaine par semaine pour apprendre. Tant que `NumeroConnecte` n'y est pas, on
  optimise et on construit sur `CompleteRegistration` (seuils connus, à revérifier).

## Les lots, dans l'ordre (choix de Claude)

0. **Côté Meta et confidentialité (Julien), en parallèle** : identifiant, jeton, domaines, politique de confidentialité.
1. **La vitrine** : bannière, pixel, raccord des liens, lien « Gérer les cookies » (par les gabarits du pied de page,
   puis `npm run vitrine:entete` et `npm run vitrine:anglais`). Un changement NOUVEAU de la face publique : le oui de
   Julien avant le push. Les paramètres ajoutés aux liens sont ignorés par la console tant que le lot 3 n'est pas là.
2. **Le serveur** : la migration (consentement et `fbc`/`fbp` sur l'identité, la marque des envois réussis), le module
   d'envoi et sa file, les déclencheurs (création d'identité, numéro connecté par trois filières, Pro payé), `pub`
   accepté par les trois routes de création, la route de l'interrupteur. La migration part en `avant` : le code neuf écrit ses colonnes.
3. **La console** : la case sur `/signup` et `/autoriser`, la lecture des paramètres, l'interrupteur. Poussée APRÈS le
   déploiement du lot 2, sinon le consentement coché n'est enregistré nulle part.

**L'essai réel qui clôt la feature** : Julien arrive sur la vitrine avec `?fbclid=essai...`, accepte, crée un compte
neuf avec la case cochée, et voit `CompleteRegistration` dans le Gestionnaire d'événements avec `fbc` reconnu ; puis le
premier vrai `NumeroConnecte`. En négatif : un compte créé sans la case n'y apparaît pas, et la vitrine refusée
n'appelle jamais `facebook.com`.

## Ce que le changement casse ailleurs (rayon de souffle)

- **Des fichiers de la console sont en cours chez une autre session** (état de l'arbre le 2026-10-30 :
  `web/app/signup/page.tsx`, `web/app/login/page.tsx`, `web/app/autoriser/page.tsx`, `web/components/GoogleButton.tsx`,
  et `ops/scaleway/docker-compose.workers.yml` pour les variables des workers). Le lot 3 attend leur commit.
- **`NumeroConnecte` ne dépend pas du crédit offert** : `CREDIT_OFFERT_MICRO_EUR=0` éteint l'offre sans éteindre
  l'activation. L'événement a sa propre marque, il ne s'appuie pas sur `credits_offerts`.
- **Une file neuve** : `BASE_QUEUES`, tenu par `tests/queue-names.test.ts`.
- **Une route neuve** (l'interrupteur) : sa classe d'accès au registre (`modulesDeRoutes`), l'auto-attaque, et le
  test d'isolation si elle porte un `:tenantId` (le consentement est sur l'identité, elle ne devrait pas).
- **La purge RGPD** : les colonnes de l'identité partent avec elle ; la marque des envois ne garde aucune donnée
  personnelle, ou la purge la nomme (et la migration devient bloquante, règle du `CLAUDE.md`).
- **Les tests de la vitrine** (`vitrine-entete`, `vitrine-anglais` : le lien du pied passe par les gabarits et les
  dictionnaires), de la console (`web-vouvoiement`, `web-formes`), `features.md` et les empreintes des fiches d'aide
  (`aide-proposer`), `documentation.md`, `.env.example` (les deux variables, vides).
- **Une CSP posée un jour sur la vitrine** devra autoriser `connect.facebook.net` et `www.facebook.com`, sinon le pixel
  se tait sans erreur visible.

## Hors du périmètre (v1)

- Le pixel dans la console, et tout événement navigateur au-delà de `PageView`.
- L'envoi d'une liste de clients à Meta, les look-alike pondérés par la valeur, Google Ads et Google Analytics.
- Le renvoi des leads des publicités Click-to-WhatsApp de nos CLIENTS (autre spec, 2026-10-09).
- Tout envoi rétroactif pour les comptes déjà créés.
- Un identifiant qui ferait voyager `fbc`/`fbp` par le plugin (publication manuelle et montée de version).
- Une preuve de l'adresse e-mail par un lien de confirmation (seul Google prouve l'adresse en v1).

## Ce qui ferait échouer le projet même s'il marche

- Un seul événement envoyé à Meta pour quelqu'un qui n'a pas consenti, ou un pixel chargé avant « Accepter ».
- Une inscription, une connexion de numéro ou un webhook Stripe qui échoue ou traîne parce que Meta ne répond pas.
- Le jeton de la Conversions API dans un bundle (`web/` ou `site/`).
- Un `NumeroConnecte` envoyé deux fois pour le même espace : la graine compterait double ce qu'elle doit imiter.
