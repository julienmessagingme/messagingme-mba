# Plan : brancher Shopify et régler ses messages depuis la console

> Conception (à lire avec ce plan) : `docs/superpowers/specs/2026-10-22-shopify-console-design.md`, cadrée avec Julien le
> 2026-10-22. Connecteur d'origine : `docs/superpowers/plans/2026-10-21-connecteur-shopify.md` (lots 0 à 3, en
> production).

**But :** un client Pro ou Entreprise branche sa boutique depuis la console (mode opératoire, clés collées) et règle ses
trois messages par un assistant en trois étapes, avec activation automatique à l'approbation de Meta.

**Architecture :** la console appelle la MÊME gestion (`src/shopify/gestion.ts`) que les outils MCP ; la gestion gagne
l'origine du branchement, l'abonnement des webhooks par l'API (console seulement), la préparation d'un message (modèle
créé chez Meta, branchement en attente) et son activation au statut que Meta transmet, avec un filet de relecture.

**Règles qui valent pour toutes les tâches :** secrets côté serveur, `tenant_id = $1` sur chaque requête (une lecture
transverse se nomme dans l'en-tête du store), `safeParse` sur tout corps tiers, aucun tiret cadratin ni demi-cadratin,
routes de la console réservées aux admins, montées sous `etapeEspace`, comptées dans le plafond coûteux quand elles
appellent Shopify ou Meta, et journalisées (actions dans `web/lib/partage/actions-journal.ts`).

## Méthode de livraison

**Implémenteur par lot (moi) puis UNE relecture indépendante du diff par lot, et Julien qui juge l'essai réel.** Raison :
ces lots touchent des chemins que la production emprunte (une migration, la création de modèles chez Meta, l'abonnement
des webhooks d'une boutique, l'écriture du consentement, l'activation automatique d'un envoi marketing) et portent des
invariants qu'aucun écran ne montre (jamais de relance sans consentement ni avant l'approbation, jamais d'événement en
double, le dernier geste gagne). L'interface de la console est éprouvée par l'essai réel, pas seulement par ses tests.

## Lot 0 : la migration (poussée SEULE, appliquée AVANT le code)

Numéro lu par `npm run migrations` au moment de l'écrire (0248 est pris).
- `shopify_boutiques.origine text not null default 'claude_code' check (origine in ('console','claude_code'))` : les
  boutiques existantes viennent toutes de Claude Code.
- Table `shopify_messages_attente` : `tenant_id` (clé étrangère vers `tenants`, cascade), `evenement` (CHECK sur les
  trois événements), `modele`, `langue`, `variables jsonb`, `delai_panier_minutes int null` (CHECK 15 à 4320), `cree_le`,
  `par uuid null` ; clé primaire `(tenant_id, evenement)` (une attente par événement : la nouvelle remplace).
- Avant : le code qui écrit `origine` ne doit pas arriver avant elle. Après : relecture en base (colonnes, défauts, CHECK
  sous leur nom, `confdeltype`).

## Lot 1 : la gestion et l'API (serveur)

**Fichiers :** `src/shopify/store.pg.ts`, `src/shopify/abonnements.ts` (neuf), `src/shopify/gestion.ts`,
`src/shopify/preparation.ts` (neuf), `src/shopify/traitement.ts`, `src/webhooks/statuts-modeles.ts` (et son câblage
dans le worker), `src/http/shopify.ts`, `src/mcp/outils-shopify.ts`, `src/emails-produit/catalogue.ts`,
`src/index.ts`, `src/worker.ts`, `web/lib/partage/actions-journal.ts`.

**Interfaces :**
- Store : `connecter(tenantId, c: Connexion & { origine: 'console' | 'claude_code' })` ; `acces()` rend aussi
  `origine` ; `poserAttente(tenantId, a: AttenteMessage)`, `attentes(tenantId): Promise<AttenteMessage[]>`,
  `retirerAttente(tenantId, evenement)`, `attentesAnciennes(minutes): Promise<Array<AttenteMessage & { tenantId }>>`
  (LECTURE TRANSVERSE 6, nommée dans l'en-tête) ; `AttenteMessage = { evenement, modele, langue, variables, delaiMinutes:
  number | null, creeLe }`.
- `abonnerWebhooks(acces: { domaine: string; jeton: string }, appeler = fetchPublic): Promise<{ ok: true; abonnes:
  string[]; deja: string[] } | { ok: false; message: string }>` : les six sujets (`ORDERS_CREATE`, `ORDERS_PAID`,
  `FULFILLMENTS_CREATE`, `CHECKOUTS_CREATE`, `CHECKOUTS_UPDATE`, `APP_UNINSTALLED`) vers
  `https://api.messagingme.app/shopify/webhooks` ; le refus « Address for this topic has already been taken » compte
  comme `deja` (mesuré). Entre dans l'inventaire de `tests/lib-adresse-privee.test.ts`.
- `connecterShopify(deps, tenant, saisie, par, origine)` : `origine` REQUIS ; `console` abonne les webhooks après la
  connexion (un échec d'abonnement rend 503 avec son geste, la boutique reste branchée et un nouvel essai est
  idempotent) ; `claude_code` n'abonne rien (`connect_shopify` passe `claude_code`). `DepsGestionShopify` gagne
  `abonner` et `creerModele(tenantId, input: CreateTemplateInput): Promise<{ ok: true; statut: string } | { ok: false;
  message: string }>` (lié à `creerUnModele`).
- `preparerMessage(deps, tenant, { evenement, texte, langue, delaiMinutes?, consentementAffirme? }, par)` dans
  `preparation.ts` : le texte porte des repères `{{first_name}}`, `{{order_number}}`... (les clés de
  `DONNEES_PAR_EVENEMENT` de l'événement, rien d'autre) ; ils deviennent `{{1}}`, `{{2}}`... dans l'ordre d'apparition,
  et `variables` dans le même ordre. Catégorie : `utility` pour les commandes, `marketing` pour la relance, qui reçoit le
  pied « Répondez STOP pour ne plus recevoir ces messages » (en anglais : « Reply STOP to stop these messages »). Nom du
  modèle : `shopify_<evenement>_<horodatage en base 36>`. Relance : consentement affirmé exigé (l'existant ou celui de
  l'appel, posé par `affirmerConsentement` et journalisé). Approuvé tout de suite : branché tout de suite ; sinon
  `poserAttente`. Le message actif n'est jamais touché ici.
- `reglerMessage(deps, tenant, { evenement, delaiMinutes?, consentementAffirme? }, par)` : délai et case sans repasser
  par Meta ; retirer le consentement d'une boutique dont la relance est active rend la relance inactive et le dit.
- `activerSelonStatut(deps, tenant, modele, langue, statut, raison)` : `APPROVED` branche l'attente qui porte ce modèle
  (actif, avec son délai), la retire, e-mail `shopify_message_actif` ; `REJECTED` la retire, e-mail
  `shopify_modele_refuse` (raison de Meta), le message actif reste. Appelé par `statuts-modeles.ts` (worker) et par le
  filet (API, minuterie d'une minute, attentes de plus de 10 min relues par `statutsDuModele`).
- Branchement direct (`set_shopify_message`) : retire l'attente du même événement (le dernier geste gagne).
- `app/uninstalled` : boutique `console` effacée (`effacerBoutique`), boutique `claude_code` coupée comme aujourd'hui.
- `etatShopify` rend aussi `attentes` (la carte affiche « en validation »).
- Routes (sous `g.admin`) : `POST /tenants/:tenantId/integrations/shopify` (brancher, origine `console`, plafond coûteux,
  journal `shopify.branchee`) ; `POST .../shopify/messages` (`preparerMessage`, plafond coûteux, journal
  `shopify.message`) ; `PATCH .../shopify/messages/:evenement` (`reglerMessage`) ; `GET .../shopify/clients/apercu` et
  `POST .../shopify/clients/import` (`{ maximum }`, fonctions du lot 3, plafond coûteux, journal `shopify.import`).

**Tests attendus :** `tests/shopify-abonnements.test.ts` (six sujets, « already taken » vaut déjà, refus de Shopify
rendu) ; `tests/shopify-preparation.test.ts` (repères vers positions et variables dans l'ordre, repère inconnu ou d'un
autre événement refusé, catégorie, pied STOP sur la relance seulement, relance sans consentement refusée, approbation
immédiate branchée, sinon attente, message actif intact) ; `tests/shopify-gestion.test.ts` (origine console abonne,
claude_code n'abonne pas, dernier geste gagne, `reglerMessage`, activation et refus avec leurs e-mails, la relance ne
s'active jamais sans consentement) ; `tests/shopify-traitement.test.ts` (`app/uninstalled` selon l'origine) ; les tests
de routes et `tests/scope-tenant.test.ts` (chaque route refusée à un autre espace) ; `tests/integration/
shopify-store.integration.test.ts` (origine, attentes, lecture transverse) ; l'auto-attaque lancée avant de pousser.

## Lot 2 : la page `/shopify/console/` de la vitrine

`site/shopify/console/index.html` et sa jumelle `site/en/shopify/console/` (générée), variante de `/shopify/installe/` :
« C'est installé. Revenez dans votre console Messaging Me et collez l'identifiant et le secret de l'app : nous branchons
la boutique. » `noindex`, hors du plan du site, `JUMELLES` et dictionnaire `anglais/shopify.json`. Tests : la suite de la
vitrine (`vitrine-anglais`, `vitrine-entete`, `vitrine-langues`, `vitrine-pages`).

## Lot 3 : la carte et l'assistant (console)

**Fichiers :** `web/components/ReglageShopify.tsx` (la carte, ses deux états), `web/components/ShopifyAssistant.tsx`
(neuf), `web/components/ShopifyImport.tsx` (neuf), `web/lib/api-shopify.ts`, les captures du mode opératoire dans
`web/public/shopify/` (prises sur l'app d'essai, sans identifiant ni secret lisibles).

Conforme aux deux maquettes validées : sans boutique, les gestes chez Shopify (chacun sa capture, « Copier » pour
l'adresse `https://app.messagingme.fr/shopify/console/` et pour les droits) puis le formulaire ; avec une boutique, les
trois messages et leur état (actif, en validation, actif avec une nouvelle version en validation, pas encore réglé), la
ligne d'import, les chiffres et « Couper ». L'assistant : une étape à la fois, le texte proposé de la conception (les
repères en bleu, un aperçu WhatsApp avec des valeurs d'exemple), le délai pour la relance (15 min, 1 h par défaut,
3 h, 24 h, autre jusqu'à 72 h), la case du consentement (pré-cochée quand elle existe, obligatoire pour la relance),
puis « Envoyer à Meta et activer dès l'approbation ». Vouvoiement, formes et icônes de la console
(`tests/web-formes.test.ts`, `tests/web-icones.test.ts`), textes bilingues.

**Tests attendus :** la suite de `web/` ; un e2e de la carte (brancher refusé puis réussi sur une API simulée,
assistant de la relance jusqu'à « en validation ») ; `npm run aide:carte` si `web/lib/nav.ts` bouge.

## Lot 4 : la doc

`features.md` (section Shopify : le parcours console) et sa fiche d'aide (empreinte), le mode opératoire dans la fiche
(avec la consigne RGPD : une demande d'effacement transmise par Shopify s'efface à la main dans Messaging Me),
`documentation.md` (origine, abonnement par l'API, attentes, lecture transverse 6), `todo.md`, le journal.

## Ordre de déploiement

1. Lot 0 seul, migration appliquée sur le VPS et relue en base.
2. Lot 1 : API et deux workers en deux temps, même `REVISION`, après la CI lue job par job.
3. Lot 2 : la page de la vitrine (Vercel), vérifiée en ligne.
4. Lot 3 : la console APRÈS le `up` du lot 1 (Vercel publie au push : un écran qui appelle une route neuve casse avant
   son API).
5. Lot 4 avec le dernier push. Le plugin ne change pas (Claude Code inchangé).

## Ce que les tests ne voient pas (à éprouver)

1. Une boutique de Claude Code dont le marchand colle les clés de l'app de la CLI dans la console : les webhooks seraient
   abonnés en double. La déduplication des événements (`reserverEvenement`, paniers par jeton) doit absorber le double
   envoi ; un test de traitement le prouve (même commande reçue deux fois : un seul message).
2. Meta approuve avant que l'attente soit écrite : le filet la rattrape à la relecture suivante.
3. Deux préparations du même événement le même jour : noms distincts (horodatage), la seconde remplace l'attente.
4. Un texte avec un repère inconnu, ou plus de dix repères : refusé avec le repère en cause.
5. Un secret ou un identifiant collé avec des espaces ou un retour à la ligne : nettoyé avant la vérification.

## Essai réel qui clôt la feature

Celui de la conception : en Pro, depuis la console seule, branchement par le mode opératoire, relance de panier réglée
(15 min), « en validation » puis « actif » sans autre geste, relance reçue ; puis un espace passé de Free à Pro avec une
boutique de Claude Code : un message réglé depuis la carte, aucun événement reçu en double. Avant d'ouvrir le parcours
aux clients : la mesure de la décision 13 sur une boutique en production.
