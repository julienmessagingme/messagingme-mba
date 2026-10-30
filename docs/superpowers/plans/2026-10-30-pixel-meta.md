# Le pixel Meta et la Conversions API : lots 1 à 3 (plan)

> **Pour l'exécutant :** suivre ce plan tâche par tâche (superpowers:executing-plans), les cases `- [ ]` servent au
> suivi. Plan COURT par règle du dépôt : fichiers, interfaces, tests attendus, ordre de déploiement ; le code s'écrit à
> l'exécution.

**But :** le pixel de la vitrine (après consentement) pour les segments, et trois conversions envoyées par notre serveur
(`CompleteRegistration`, `NumeroConnecte`, `Subscribe`) pour les look-alike et l'optimisation de nos publicités.

**Architecture :** la vitrine charge le pixel depuis `site/site.js`, derrière une bannière. Le serveur RÉSERVE chaque
conversion dans un journal en base (une ligne par fait, clé unique), puis enfile un job `conversions-meta` que le
worker envoie à Graph, sur le modèle exact des e-mails du produit (`src/emails-produit/emission.ts` : la réservation
est le dédoublonnage, un balayage reprend ce qui reste dû). La console porte la case et l'interrupteur.

**Pile :** HTML et JavaScript sans dépendance (vitrine), TypeScript, Fastify, Postgres et pg-boss, Next.js (console),
vitest, Playwright.

**Spec :** [2026-10-30-pixel-meta-design.md](../specs/2026-10-30-pixel-meta-design.md). Elle fait foi ; ce plan dit
seulement où et dans quel ordre.

## Méthode de livraison

- **Lot 1 (vitrine) : en direct**, parce qu'il est isolé, réversible d'un commit et qu'aucun chemin de la production
  ne passe par lui. Sa preuve est un passage Playwright sur un aperçu local : aucune requête vers `facebook.com` avant
  « Accepter », un `PageView` après.
- **Lots 2 et 3 : implémenteur par lot (Claude) et une relecture indépendante du diff en fin de lot**, parce qu'ils
  touchent trois chemins que la production emprunte (l'inscription, la connexion d'un numéro, le webhook Stripe) et un
  invariant invisible (aucun événement sans consentement). Un rouge = ce qui casse la production ou envoie un
  événement non consenti.
- **Essai réel qui clôt la feature**, en production, par Julien : arriver sur la vitrine avec `?fbclid=essai<date>`,
  accepter, créer un compte NEUF avec la case cochée, et voir `CompleteRegistration` dans le Gestionnaire d'événements
  avec `fbc` reconnu ; puis le premier vrai `NumeroConnecte`. En négatif, le même parcours case décochée ne laisse rien
  chez Meta. À inscrire dans `docs/prive/ESSAIS-REELS.md`.

## Contraintes globales

- Aucun événement sans consentement ; aucun pixel avant « Accepter ». « Accepter » et « Refuser » du même poids, Meta
  nommé, choix retenu six mois.
- La vitrine n'a aucune variable d'environnement : l'identifiant du pixel s'écrit en dur dans `site/site.js`.
- `META_CAPI_TOKEN` ne vit que sur le serveur (conteneur et `.env.prod`, posé par Julien) ; jamais dans `web/`, `site/`,
  ni dans une URL (il part dans le corps de la requête à Graph).
- Mettre une conversion en file ne fait jamais échouer ni ralentir le geste : toute erreur se journalise et le geste
  réussit.
- L'e-mail haché ne part que pour une adresse prouvée (`adresse_prouvee_le` non nul).
- Zod `safeParse` sur le champ `pub` reçu et sur la réponse de Graph, jamais `parse` ni `as`.
- Graph en `v25.0`, la version par défaut de `src/meta/client.ts`.
- Numéro de migration lu par `npm run migrations` ; bornes de texte par `char_length`, jamais une répétition de regex
  au-delà de 255.
- Textes : pas de tiret cadratin ni demi-cadratin ; vouvoiement dans la console (`tests/web-vouvoiement.test.ts`).
- Commits par `git commit --only` sur ses chemins ; `src/index.ts`, `src/worker.ts` et `src/socle.ts` sont du câblage
  partagé : annonce aux sessions voisines et commit par plomberie (`CLAUDE.md`).

## Points à surveiller en relecture

1. **Un visiteur qui accepte sur sa deuxième page** : le pixel se charge sans recharger, et la décoration des liens
   démarre à ce moment. Test : tâche 1, passage Playwright « accepter plus tard ».
2. **Un visiteur qui accepte puis refuse** par « Gérer les cookies » : `_fbp` et `_fbc` sont effacés, plus aucun lien
   décoré, et la page suivante ne charge plus rien. Test : tâche 1, passage « retrait ».
3. **Un stockage local bloqué** (navigation privée stricte) : la bannière revient à chaque page, le site marche, rien ne
   se charge sans accord. Test : tâche 1, `localStorage` qui lève.
4. **Deux copies de l'API qui reçoivent le même signal de Meta** au même instant : une seule ligne au journal, un seul
   envoi. Test : tâche 3, intégration (deux réservations concurrentes de la même clé).
5. **Une personne qui retire son accord pendant qu'un envoi attend** : il ne part pas. Test : tâche 3, envoi.

## Choix de Claude à relire

- **La console lit `fbc` et `fbp` dans l'adresse au moment d'envoyer la création de compte**, sans rien stocker : une
  navigation qui les perd (de `/login` à `/signup`) les perd, accepté.
- **`NumeroConnecte` se branche dans le câblage** (`src/index.ts`), autour des trois gestes qui existent (l'offre de
  bienvenue des filières Cloud et application, `lierNumero` de 360dialog), par une fonction testée de `src/pub/` : aucune
  interface de connexion ne change.
- **L'interrupteur est une route de la personne connectée**, à côté des préférences d'e-mails (`src/http/emails-moi.ts`,
  `/tenants/:tenantId/moi/...`) : il hérite de la classe `tenant` du registre et du test d'isolation, sans module neuf.
- **Trois échecs d'envoi au plus** (5xx ou réseau), puis `abandonne` ; un 4xx de Graph abandonne tout de suite.

---

## Lot 1 : la vitrine

**Prérequis (Julien) :** l'identifiant du pixel, et la politique de confidentialité de `www.messagingme.fr` mise à jour
(le pixel s'allume avec ce lot).

### Tâche 1 : la bannière, le pixel, les liens décorés

**Fichiers :** modifier `site/site.js` (un bloc neuf, sur le modèle des autres), `site/site.css`,
`scripts/vitrine/pied.fr.html` et `pied.en.html` (un bouton « Gérer les cookies » / « Manage cookies »), puis
`npm run vitrine:entete` et `npm run vitrine:anglais` ; créer `tests/vitrine-consentement.test.ts` ; script Playwright
de vérification dans le scratchpad (pas dans le dépôt).

**Interfaces produites :**
- `localStorage['mm-consentement']` = `{ choix: 'accepte' | 'refuse', le: <ISO> }`, relu à chaque page, échu après 183
  jours ; toute lecture et écriture dans un `try`.
- Le pixel (`fbq('init', ID)` puis `PageView`) ne se charge que dans la fonction appelée sur « Accepter » ou sur un
  accord encore valide.
- Après accord, chaque `a[href^="https://console.messagingme.app/"]` reçoit `fbc` et `fbp` (valeurs de `_fbc`, `_fbp`)
  s'ils existent ; les liens ajoutés après coup ne comptent pas (la vitrine n'en crée pas).
- Le retrait efface `_fbp` et `_fbc` (domaine `.messagingme.fr` et l'hôte), enregistre `refuse`, retire les paramètres
  ajoutés.
- Textes en français et en anglais choisis par `document.documentElement.lang`, sans tiret long, Meta (Facebook) nommé.

- [ ] **Tests texte** (`tests/vitrine-consentement.test.ts`) : `connect.facebook.net` n'apparaît dans AUCUNE page HTML de
  `site/`, seulement dans `site.js` ; l'identifiant du pixel y figure une fois ; chaque page porte le bouton « Gérer les
  cookies » (par la génération du pied) ; `vitrine-entete` et `vitrine-anglais` restent verts.
- [ ] **Passage Playwright sur un aperçu local** (serveur Node du scratchpad, `apercu-vitrine-extraction`) : première
  visite, aucune requête vers `facebook.com` ni `facebook.net` ; « Refuser », recharger, toujours rien, pas de bannière ;
  « Accepter » sur une deuxième page, `fbevents.js` chargé et `facebook.com/tr?...ev=PageView` émis, liens de la console
  décorés quand `_fbc` existe (arrivée avec `?fbclid=essai`) ; « Gérer les cookies » puis « Refuser », cookies effacés,
  liens nus ; `localStorage` qui lève, bannière présente et rien de chargé. Captures avant et après pour Julien.
- [ ] **Commit `--only`** de ses fichiers ; **push seulement après le oui de Julien** (nouveauté de la face publique).

## Lot 2 : le serveur

**Prérequis :** annoncer aux sessions voisines l'édition de `src/index.ts`, `src/worker.ts`, `src/socle.ts`,
`src/worker/roles.ts` et `src/queue/names.ts` (les trois derniers ont des modifications en cours d'une autre session le
2026-10-30 : attendre leur commit ou construire le commit par plomberie).

### Tâche 2 : la migration

**Fichiers :** `db/migrations/<NNNN>_conversions_meta.sql`, `tests/migration-<NNNN>.test.ts` (sur le modèle des tests de
migration existants).

**Interfaces produites :**
- `identities` : `pub_consenti_le timestamptz`, `pub_fbc text`, `pub_fbp text` (bornés à 500 par `char_length`),
  `adresse_prouvee_le timestamptz`. Tous nullables.
- Table `conversions_meta` : `id uuid` clé, `cle text` UNIQUE (l'`event_id`), `evenement text` CHECK
  (`CompleteRegistration`, `NumeroConnecte`, `Subscribe`), `identity_id uuid` NOT NULL référence `identities` `on delete
  cascade`, `tenant_id uuid` référence `tenants` `on delete cascade` (nul pour une inscription), `fait_le timestamptz`,
  `valeur_centimes integer`, `devise text`, `ip text`, `navigateur text`, `statut text` CHECK (`a_envoyer`, `envoye`,
  `abandonne`) défaut `a_envoyer`, `tentatives integer` défaut 0, `prochain_essai_le timestamptz`, `cree_le`.
- Index partiel de la reprise : `(prochain_essai_le) where statut = 'a_envoyer'`, son prédicat repris mot pour mot par
  la requête de la tâche 3.
- La purge (`src/ops/suppression-espace.pg.ts`) ne nomme pas la table : les cascades suffisent, donc migration non
  bloquante. Elle part en `avant` (le code neuf écrit ces colonnes ; l'ancien les ignore).

- [ ] Test de migration : colonnes, CHECK, unicité de `cle`, cascade à la suppression d'un espace et d'une identité,
  prédicat exact de l'index partiel.
- [ ] Commit.

### Tâche 3 : le journal, l'envoi et sa file

**Fichiers :** créer `src/pub/conversions-meta.ts` (pur : construction de l'événement), `src/pub/conversions-meta.pg.ts`
(le magasin), `src/pub/envoi.ts` (le travail de la file), `src/pub/emission.ts` (l'émetteur, qui ne lève jamais) ;
modifier `src/config.ts`, `.env.example`, `src/queue/names.ts` (`BASE_QUEUES` reçoit `conversions-meta`),
`src/worker/roles.ts` (`principal`, et `conversions-meta-reprise`), `src/worker.ts` (le travail et la reprise toutes les
5 minutes, comme `emails-produit-reprise`), `src/socle.ts` (l'émetteur, construit une fois pour l'API et le worker).
Tests : `tests/pub-conversions-meta.test.ts`, `tests/pub-envoi.test.ts`, `tests/pub-emission.test.ts`,
`tests/integration/pub-conversions-meta.pg.test.ts`.

**Interfaces produites :**
- `type EvenementMeta = 'CompleteRegistration' | 'NumeroConnecte' | 'Subscribe'`.
- `interface Fait { evenement: EvenementMeta; cle: string; faitLe: Date; identityId?: string; tenantId?: string;
  valeurCentimes?: number; devise?: string; ip?: string; navigateur?: string }`. Clés : `inscription:<identityId>`,
  `numero:<tenantId>`, `pro:<tenantId>`.
- `EmetteurConversions.signaler(f: Fait): Promise<void>` : fonction éteinte = rien ; sinon réserve (pour un fait
  d'espace, la personne est l'admin le plus ancien, `users.created_at`) puis enfile ; ne lève jamais.
- `PgConversionsMetaStore` : `reserver(f): Promise<string | null>` (`on conflict (cle) do nothing`, rend l'id créé),
  `prendre(id)`, `marquer(id, statut, prochainEssai?)`, `aReprendre(limite)`, `consentement(identityId)`,
  `enregistrerConsentement(identityId, { fbc?, fbp? })`, `retirerConsentement(identityId)` (efface date, `fbc`, `fbp`,
  et passe ses lignes `a_envoyer` en `abandonne`), `marquerAdresseProuvee(email)` (`coalesce`, insensible à la casse).
- `construireEvenement(ligne, personne, opts: { urlConsole: string }): EvenementGraph` : `event_name`, `event_time`
  (secondes), `event_id` = `cle`, `action_source: 'website'`, `event_source_url`, `user_data` (`external_id` haché,
  `em` haché seulement si adresse prouvée, `fbc`, `fbp`, `client_ip_address` et `client_user_agent` seulement pour
  `CompleteRegistration`), `custom_data` (`value` en euros, `currency`) pour `Subscribe`.
- Config : `META_PIXEL_ID`, `META_CAPI_TOKEN` ; les deux posés = allumé ; une seule = éteint et une ligne au démarrage,
  jamais un refus de démarrer.

- [ ] **Tests purs** (`pub-conversions-meta`) : `em` égal au SHA-256 hexadécimal de l'adresse en minuscules et sans
  espaces, absent quand l'adresse n'est pas prouvée ; `external_id` = SHA-256 de l'identifiant ; `Subscribe` de 4900
  centimes donne `value: 49` et `currency: 'EUR'` ; ni IP ni navigateur pour `NumeroConnecte` ; `event_id` = la clé.
- [ ] **Tests de l'envoi** (`pub-envoi`, Graph simulé) : consentement retiré, pas d'appel et `abandonne` ; consentement
  postérieur au fait (hors `CompleteRegistration`), pas d'appel ; fait de plus de 7 jours, pas d'appel et `abandonne` ;
  Graph en 500, `a_envoyer` et `tentatives` + 1, puis `abandonne` au troisième ; Graph en 400, `abandonne` sans
  reprise ; succès, `envoye`, `ip` et `navigateur` effacés ; l'URL appelée ne contient jamais `access_token`.
- [ ] **Tests de l'émetteur** (`pub-emission`) : fonction éteinte, ni réservation ni file ; réservation déjà prise, rien
  d'enfilé ; magasin ou file qui lèvent, `signaler` se résout quand même.
- [ ] **Intégration** : deux `reserver` concurrents de la même clé, une seule ligne ; l'admin le plus ancien est choisi ;
  `aReprendre` rend une ligne due et pas une `envoye`.
- [ ] `tests/queue-names.test.ts` vert ; `npm run typecheck`, `npm run lint`, `npx tsx scripts/auto-attaque.mts`.
- [ ] Commit (plomberie pour le câblage partagé).

### Tâche 4 : le consentement et l'inscription dans les trois routes de création

**Fichiers :** créer `src/pub/champ-pub.ts` ; modifier `src/auth/routes.ts` (`/auth/signup`, `/auth/google`),
`src/http/oauth.ts` (l'entrée Google du plugin), leurs dépendances (l'émetteur et le magasin, requis). Test :
`tests/auth-pub.test.ts`.

**Interfaces :**
- Consomme `EmetteurConversions.signaler`, `enregistrerConsentement`, `marquerAdresseProuvee` (tâche 3).
- Produit `lireChampPub(corps: unknown): { fbc?: string; fbp?: string } | null` : `null` sans `pub.accord === true` ;
  `fbc` et `fbp` validés un par un (format `fb.<chiffre>.<horodatage>.<valeur>`, 500 au plus), un invalide est omis.
- Règle : création réussie et `pub` présent, le consentement s'enregistre sur l'identité ; identité NEUVE et `pub`
  présent, `CompleteRegistration` est signalé avec l'IP (la même source que le plafond de débit) et le navigateur ;
  toute entrée Google ouverte marque l'adresse prouvée.

- [ ] Tests : inscription avec `pub`, consentement et un signal ; sans `pub`, ni l'un ni l'autre ; identité existante
  avec `pub`, consentement sans signal ; `fbc` invalide, consentement sans `fbc` ; Google neuf avec `pub`, signal ; Google
  existant, adresse prouvée et pas de signal ; l'entrée du plugin, un cas ; émetteur qui lève, l'inscription rend
  toujours 201.
- [ ] Commit.

### Tâche 5 : `NumeroConnecte` et `Subscribe`

**Fichiers :** créer `src/pub/declencheurs.ts` ; modifier `src/index.ts` (les trois gestes du numéro),
`src/stripe/traitement-abonnements.ts` (dépendance requise `signalerPro`), `src/http/credit-stripe.ts` (son câblage).
Tests : `tests/pub-declencheurs.test.ts`, et le test existant du traitement des abonnements.

**Interfaces :**
- `apresGesteNumero<A extends unknown[]>(geste: (tenantId: string, ...a: A) => Promise<void>, signaler: (tenantId:
  string) => void): (tenantId: string, ...a: A) => Promise<void>` : le geste d'abord, le signal ensuite, même quand
  l'offre vaut 0 (`CREDIT_OFFERT_MICRO_EUR=0`), jamais si le geste lève.
- `signalerPro(tenantId: string, montantCentimes: number, devise: string, payeLe: Date): void`, appelé dans la branche
  `invoice.paid` quand `payeeNonNulle` et `amount_paid > 0` (le cycle à 0 € d'un code promo à 100 % ne compte pas).

- [ ] Tests : le geste qui réussit signale une fois ; le geste qui lève ne signale pas et relève ; l'offre à 0 signale ;
  la première facture payée non nulle appelle `signalerPro` avec son montant ; la facture à 0 € de l'essai et le prorata
  d'un siège ne l'appellent pas. Les fixtures du traitement reçoivent un `signalerPro` muet déclaré.
- [ ] Commit (plomberie pour `src/index.ts`).

### Tâche 6 : l'interrupteur et la documentation du serveur

**Fichiers :** modifier `src/http/emails-moi.ts` (`GET` et `PUT /tenants/:tenantId/moi/partage-meta`),
`documentation.md` (la section, ses invariants), `DEPLOY.md` (les deux variables, posées par Julien dans le conteneur ET
le `.env.prod` de la machine). Test : `tests/partage-meta-moi.test.ts`.

**Interfaces produites :** `GET` rend `{ accord: boolean; depuis: string | null }` ; `PUT { accord: boolean }` (Zod),
`true` pose la date si elle manque, `false` appelle `retirerConsentement`. Tous les rôles, la personne connectée
seulement.

- [ ] Tests : `PUT false` efface et abandonne les envois en attente ; `PUT true` pose la date une fois ; corps invalide,
  400 ; `tests/scope-tenant.test.ts` vert sans retouche.
- [ ] Suite racine entière, `typecheck`, `lint`, auto-attaque ; commit ; CI lue job par job.
- [ ] **Relecture indépendante du lot 2**, puis déploiement `migration=avant`, relecture en base point par point.

## Lot 3 : la console

**Prérequis :** lot 2 déployé ; les fichiers de connexion de la console commités par la session qui les modifie.

### Tâche 7 : la case et les trois envois

**Fichiers :** créer `web/lib/pub.ts`, `web/lib/pub.test.ts`, `web/components/CasePartageMeta.tsx` ; modifier
`web/app/signup/page.tsx`, `web/app/autoriser/page.tsx`, `web/components/GoogleButton.tsx` (le champ `pub` dans le corps
de `/auth/google`), `web/lib/oauth.ts` si le parcours du plugin y construit son corps, les dictionnaires de `web/lib/i18n`.
E2E : `web/e2e/partage-meta.spec.ts` (et `grep` de `web/e2e` sur les rôles touchés).

**Interfaces produites :** `champPub(accord: boolean, search: string): { accord: true; fbc?: string; fbp?: string } |
undefined`. La case, non cochée par défaut, porte le texte de la spec (fr et en, vouvoiement).

- [ ] Tests : `champPub(false, ...)` rend `undefined` ; `champPub(true, '?fbc=...&fbp=...')` les porte ; e2e, la case
  est décochée au chargement de `/signup` et `/autoriser`, la cocher ajoute `pub.accord` au corps de `/auth/signup`
  (requête interceptée), sans elle le corps n'a pas de `pub`.
- [ ] Commit.

### Tâche 8 : l'interrupteur de la page de compte, et le fonctionnel

**Fichiers :** modifier `web/app/compte/page.tsx` (un bloc sur le modèle de `EmailsDuProduit`, masqué si la route manque),
`web/lib/api/compte.ts`, `features.md` (la section, et l'empreinte d'une fiche d'aide si elle la cite).

- [ ] Tests : e2e, l'interrupteur reflète `GET` et envoie `PUT` ; `tests/aide-proposer.test.ts` vert si `features.md`
  bouge.
- [ ] Suites racine ET web entières (un lot console lance la suite racine), commit, push APRÈS le déploiement du lot 2,
  CI lue job par job.
- [ ] **Relecture indépendante du lot 3**, puis l'essai réel de Julien.

## Ordre de déploiement

1. Julien : identifiant du pixel, jeton, vérification de `messagingme.fr` et `messagingme.app`, politique de
   confidentialité.
2. Lot 1 poussé après son oui (Vercel publie la vitrine).
3. Lot 2 : `gh workflow run deploy-scaleway.yml --ref main -f migration=avant`, approuvé par Julien ; puis Julien pose
   `META_PIXEL_ID` et `META_CAPI_TOKEN` (conteneur et `.env.prod`), la fonction s'allume.
4. Lot 3 poussé (Vercel publie la console), puis l'essai réel.
