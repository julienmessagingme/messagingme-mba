# Le Business, lot 1 : la grille, `/ops` et la vitrine (plan)

> **Pour l'exécutant :** superpowers:executing-plans, tâche par tâche (méthode « en direct » ci-dessous). Les étapes se
> cochent (`- [ ]`). Plan court et sans code, comme le veut le `CLAUDE.md` global : les tâches, les interfaces, les tests
> attendus, l'ordre de déploiement.

**But :** une quatrième offre, le Business, posée par Julien dans `/ops` ; le Pro resserré ; la conservation, le numéro et
le crédit offert lus dans la grille ; le widget personnalisable ; la marge IA retirée de tout affichage ; la vitrine à quatre
cartes et les textes que la nouvelle grille rend faux.

**Architecture :** la grille reste dans `src/offres/offres.ts` ; `offre_de_l_espace` apprend un quatrième cas (un drapeau
posé par `/ops`, comme l'Entreprise). Deux sous-lots : A ajoute la mécanique sans changer ce que voit le public (le Pro
garde ses valeurs), B change la grille visible, la console, la vitrine et les textes dans un seul commit, parce que les tests
lient la grille du code aux pages.

**Pile :** TypeScript, Fastify, Postgres (pg-boss), Next.js (console), HTML statique (vitrine), vitest, Playwright.

**Spec :** [2026-10-27-offre-business-design.md](../specs/2026-10-27-offre-business-design.md).

## Méthode de livraison

**En direct (Claude implémente lui-même), en deux sous-lots, une relecture indépendante à la fin de chaque sous-lot**, parce
que A touche des chemins que la production emprunte et qui portent des invariants invisibles (la purge de l'historique, qui
efface ; les droits effectifs des membres ; le numéro fourni ; le crédit, donc de l'argent), ce qui demande une relecture du
diff, et que B se juge surtout à l'écran (la vitrine, la page Offre), ce qui exclut feature-loop ; ni l'un ni l'autre n'est
un balayage mécanique qui justifierait un workflow. Le correctif d'un rouge de relecture ne se fait pas relire : son test,
vérifié dans les deux sens, suffit.

**Essai réel qui clôt le lot**, sur un espace de test, en production : Julien pose le Business dans `/ops` ; la console
affiche le Business, le MBA et les assistants s'ouvrent, le widget accepte une couleur ; le complément de crédit apparaît
une fois, et une seconde pose ne l'ajoute pas ; Julien retire le Business d'un espace qui garde un Pro de test (Stripe en
mode test) : le MBA se ferme avec « Passer en Business », un membre « agent » agit en administrateur, le widget repasse au
vert sur la page de test ; l'écran de conservation dit 60 jours ; la page des tarifs se lit en quatre cartes sur un
téléphone (375 px) et sur un écran large.

## Contraintes globales

- Valeurs du Business : 349 € HT par mois ; 5 000 contacts créés ; 5 utilisateurs, puis 10 € HT par mois l'utilisateur ;
  10 adresses de webhook ; 90 jours ; numéro inclus ; 10 € de crédit offert ; commission 15 % ; limites invisibles : sans
  limite d'administrateurs, 20 clés d'API, 120 appels par minute et 3 000 par heure, 5 000 modèles et 5 000 réponses par jour,
  250 Mo de médiathèque, 30 jours de journal des webhooks, suppressions sans limite, sans badge.
- Valeurs du Pro (sous-lot B) : 1 000 contacts créés, 60 jours, fonctions `console`, `inbox`, `scenarios`, `statistiques`,
  `email` ; administrateurs : autant que d'utilisateurs.
- Aucun objet Stripe pour le Business : ni prix, ni paiement, ni souscription par Claude.
- La commission n'apparaît sur aucun écran, aucune page, aucune réponse de `get_plan`.
- Le numéro d'une migration se lit (`npm run migrations`) au moment de l'écrire, il ne s'écrit nulle part.
- Ni cadratin ni demi-cadratin dans les textes ; vouvoiement dans la console ; « Meta Business Agent » reste tel quel.
- Commits en `git commit --only <ses chemins>` ; un fichier de câblage partagé (`src/index.ts`, `src/server.ts`,
  `src/worker.ts`) se commite en plomberie et s'annonce aux sessions voisines.

## Points à surveiller en relecture

1. **Un espace en Pro au déploiement de B** : passer de 90 à 60 jours ne doit rien purger sans grâce. Test : la durée d'un
   Pro dont la descente date de moins de 30 jours reste l'ancienne ; sonde en lecture seule avant le déploiement (A1).
2. **Un Business posé sur un espace qui a un Pro payé vivant** : `/ops` le signale, et `ouvrirPro` refuse un Business, pour
   qu'aucun second paiement ne naisse. Tests en A3.
3. **Un membre « agent » d'un espace qui passe en Pro** : administrateur effectif partout (routes, Inbox, outils MCP par
   jeton OAuth, e-mails du produit), rôle enregistré intact, rôle d'origine au retour en Business. Tests en A7.
4. **Le complément de crédit rejoué** (double clic, retrait puis nouvelle pose) : une seule fois par espace. Test en A5.
5. **Un widget déjà en couleur dans un espace Free ou Pro** : affiché standard, réglage conservé ; un enregistrement aux
   valeurs standard (le formulaire envoie tout) est accepté ; une valeur personnalisée est refusée. Tests en B2.

---

## Sous-lot A : la mécanique serveur (le public ne voit rien changer)

### Tâche A1 : la migration, et la sonde qui la précède

**Fichiers :** `db/migrations/<numéro lu>_offre_business.sql` (créé), `tests/integration/offres.integration.test.ts`,
`tests/migration-directives.test.ts` (inchangé, il doit rester vert).

- [ ] Sonde en lecture seule sur la machine des workers (`DEPLOY.md`, sans `SET` de session) : les espaces qui ont un Pro
  vivant (payé ou en essai), ceux qui ont `offre_entreprise`, pour chaque Pro la conversation la plus ancienne, et les
  widgets d'un espace Free ou Pro dont l'apparence n'est pas standard. Résultat noté dans le journal. 🔴 Un Pro ou une
  bulle personnalisée trouvés : B ne se déploie pas avant la décision de Julien (spec, « Personne ne perd rien »).
- [ ] Écrire la migration, additive, à jouer AVANT le code (`set local lock_timeout = '5s'`) :
  `tenants.offre_business boolean not null default false`, `tenants.business_utilisateurs integer` (CHECK `> 0` ou nul),
  `tenants.business_quitte_le timestamptz` ; `offre_de_l_espace` rend `entreprise`, puis `business` (le drapeau), puis
  `pro`, puis `base` ; `credits_offerts.complement_business_micro_eur bigint` et `complement_business_le timestamptz` ;
  le CHECK `abonnements_numero_id_chk` relâché à `^(sub|ops)_[A-Za-z0-9]+$` (nom de la contrainte relu en base avant le
  `drop`). L'ancien code survit : il ignore les colonnes, n'écrit jamais `ops_`, et aucun espace n'est en Business avant
  la nouvelle route.
- [ ] Test d'intégration : l'ordre `entreprise` > `business` > `pro` > `base`, dans les quatre combinaisons utiles ; un
  identifiant `ops_…` accepté, un identifiant quelconque refusé.

### Tâche A2 : l'offre `business` dans le code

**Fichiers :** `src/offres/offres.ts`, `src/offres/offre.pg.ts`, `src/offres/vue.ts`, `src/offres/refus.ts`,
`src/offres/membres.ts`, les `case` sur l'offre (`src/auth/plafond-global.ts`, `src/settings/store.pg.ts`,
`src/evenements/store.pg.ts`, `src/worker.ts` purge du journal des webhooks, `src/application/envoi.ts`,
`src/stats/store.pg.ts`, `src/stats/conversation-stats.pg.ts`, `src/http/ops-offre.ts`), tests `tests/offres.test.ts`,
`tests/offres-vue.test.ts`, `tests/offre-route.test.ts`, `tests/offres-console-parite.test.ts`, `tests/analyse-offre.test.ts`.

**Interfaces produites :**
- `type Offre = 'base' | 'pro' | 'business' | 'entreprise'` ; `estOffre` suit.
- `DROITS.business` aux valeurs des contraintes globales ; ses fonctions sont celles du Pro d'aujourd'hui, qui comprennent
  déjà `agent_meta`, `assistants` et `aide` (en A, le Pro ne perd rien ; B les lui retire).
- `PRIX_BUSINESS_HT_CENTIMES = { mois: 34900 }`, `PRIX_SIEGE_BUSINESS_HT_CENTIMES = { mois: 1000 }`.
- `droitsDe(offre, surcharge, sieges)` : en Business, `surcharge.utilisateurs` (de `business_utilisateurs`) remplace les 5.
- `OffrePublique = 'free' | 'pro' | 'business' | 'entreprise'` ; la grille de la vue liste les quatre ; `VueOffre.prixBusiness`
  `{ moisCentimes, siegeMoisCentimes }`, toujours présent (pas de vente en ligne à conditionner).
- `refus.ts` : `ORDRE` à quatre offres, `NOM_OFFRE.business = 'Business'`.

- [ ] Tests d'abord : la grille case par case pour `business` ; la vue rend les quatre offres publiques dans l'ordre ; un
  Business sans réglage a 5 utilisateurs, avec réglage la valeur posée ; `OFFRES_SANS_ANALYSE` contient `business` (pas
  d'analyse avant le lot 2) ; chaque `case` listé range `business` comme le dit la spec (journal des webhooks 30 jours, etc.).
- [ ] Implémenter, puis `npm test`, `npm run typecheck`, `npx tsx scripts/auto-attaque.mts`.

### Tâche A3 : `/ops` pose et retire le Business

**Fichiers :** `src/http/ops-offre.ts`, `src/offres/offre.pg.ts` (`ecrireEntreprise` devient `ecrireOffreManuelle`),
`src/stripe/pro.ts` (`ouvrirPro`), câblage dans `src/index.ts` (plomberie, annoncé), tests `tests/ops-offre*.test.ts`,
`tests/stripe-pro.test.ts`.

**Interfaces :**
- Corps de `POST /ops/offre/:tenantId` : les champs actuels, plus `business?: boolean` et
  `utilisateursBusiness?: number | null` (absents = inchangés). `entreprise` et `business` vrais ensemble : 400.
- `GET /ops/offre/:tenantId` rend aussi `business`, `utilisateursBusiness` et
  `alertes: { proPayeVivant: boolean; numeroSeulVivant: boolean; numeroFourniSansCouverture: boolean }`.
- `ecrireOffreManuelle(tenantId, r: EcritureOffreManuelle): Promise<boolean>` : une transaction ; `business_quitte_le` posé au
  passage de vrai à faux, comme `entreprise_quittee_le`.
- Après la transaction, dans cet ordre, sans lever si l'un échoue (journalisé, Julien prévenu) : passage en Business, les
  gestes de A4 (numéro) et de A5 (crédit) ; retrait, la fin du numéro de A4. Puis l'invalidation du cache et l'audit signé.
- `ouvrirPro` refuse un Business comme il refuse une Entreprise (« votre espace est en Business »).

- [ ] Tests d'abord : la route (garde d'exploitation, note obligatoire, corps strict, 400 sur les deux drapeaux), les trois
  alertes dans les états qui les allument, l'ordre des gestes, un refus de Stripe ou une panne d'un geste qui n'annule pas la
  pose, `ouvrirPro` refusé pour un Business.
- [ ] Implémenter, tests, typecheck, auto-attaque.

### Tâche A4 : le numéro inclus lit la grille

**Fichiers :** `src/numero/reserve.ts`, `src/offres/numero-inclus.ts`, `src/stripe/etat-abonnement.ts`,
`src/stripe/abonnements.pg.ts`, `src/numero/liberation.pg.ts`, `src/http/numero-fourni.ts`, les lecteurs de
`abonnements_numero.stripe_subscription_id`, tests `tests/numero-*.test.ts`, `tests/numero-inclus*.test.ts`, tests de
l'état de l'abonnement du numéro.

**Interfaces :**
- `type DroitAuNumero = 'attribue' | 'abonne' | 'inclus'` ; `droitAuNumero` lit `limites.numeroInclus` de l'offre de
  l'espace (dépendance `offre: { numeroInclus(tenantId): Promise<boolean> }`) au lieu de « un Pro est vivant ».
- Passage en Business : `surPassageEnPro(d, tenantId, { arreterLeNumeroSeul: false })` réutilisée (avis oubliés, campagnes
  reprises, rien chez Stripe).
- `porterLaFinParLOps(a: { tenantId: string; finiLe: Date }): Promise<boolean>` : la même ligne finie que
  `porterLaFinParLePro`, identifiée `ops_<tenant sans tirets><horodatage>`, appelée au retrait d'un Business ou d'une
  Entreprise quand `numeroFourniSansCouverture`.
- `couvertureParLePro` devient `couvertureDuNumero(l, couverture: { vivant: boolean; dernierFini: Date | null })`, où
  `vivant` vaut « un Pro vivant OU une offre posée à la main qui inclut le numéro » et `dernierFini` la plus récente des
  fins (dernier Pro fini, `business_quitte_le`, `entreprise_quittee_le`) ; `etatDeLEspace` et la relecture de la
  libération lisent la même couverture.
- `surFinDuPro` rend une nouvelle issue `couvert_par_offre` quand une offre posée à la main couvre le numéro : rien n'est
  recréé chez Stripe.

- [ ] Tests d'abord : un Business, une Entreprise et un Pro ont droit au numéro, un Free non ; le retrait non couvert écrit
  la ligne `ops_` et le balayage du lot 4 la suspend puis la libère comme une fin de Pro ; un Business dont l'abonnement du
  numéro est fini n'est ni suspendu ni libéré ; la fin d'un Pro payé pendant un Business ne recrée pas le numéro seul ;
  aucun lecteur n'envoie un identifiant `ops_` chez Stripe (inventaire des appels, comme
  `tests/inventaire-cle-360dialog.test.ts`).
- [ ] Implémenter, tests, typecheck.

### Tâche A5 : le crédit offert du Business

**Fichiers :** `src/config.ts`, `.env.example`, `src/account/es-store.pg.ts`, `src/agent/credits.pg.ts`
(`offrirAuNumeroVerifie`, `offrirAuCompteApplication`), `src/account/offre-bienvenue.ts`, tests
`tests/es-credit-offert.test.ts` et un test neuf du complément.

**Interfaces :**
- `CREDIT_OFFERT_BUSINESS_MICRO_EUR`, défaut 10 000 000, même levier d'urgence que `CREDIT_OFFERT_MICRO_EUR` (0 coupe).
- `offrirCredit` et `offrirCreditApplication` : le montant dépend de l'offre de l'espace au moment de l'offre.
- `completerCreditBusiness(tenantId): Promise<number>` : si une ligne `credits_offerts` existe et
  `complement_business_le` est nul, crédite `max(0, 10 € - montant offert)` par le même mouvement que l'offre d'aujourd'hui
  (aucune migration sur `agent_credit_mouvements`), pose les deux colonnes, rend le montant ; sinon 0. Puis
  `remonterPlafondApresRecharge`.

- [ ] Tests d'abord : 10 € au premier numéro d'un Business, 1 € ailleurs ; le complément de 9 € après 1 €, de 10 € après la
  reprise à 0, rien sans ligne (les 10 € viendront au premier numéro), rien la seconde fois, rien quand le levier vaut 0 ;
  deux appels simultanés ne créditent qu'une fois.
- [ ] Implémenter, tests, typecheck.

### Tâche A6 : la conservation lit la grille

**Fichiers :** `src/inbox/retention.ts`, `src/inbox/store.pg.ts` (purge), `src/stats/store.pg.ts`,
`src/stats/conversation-stats.pg.ts`, `src/worker.ts` (paramètres de la purge), tests `tests/retention*.test.ts` et le test
d'intégration de la purge.

**Interfaces :**
- `dureeConservationSql(p: { instance; grace; base; pro; business })` : en `pro` et `business`, la durée de la grille, mêmes
  deux règles que la Base (réglage plus court respecté, plus long plafonné ; grâce de 30 jours depuis la descente :
  `greatest(entreprise_quittee_le, business_quitte_le)` pour le Pro, `entreprise_quittee_le` pour le Business) ; ailleurs,
  inchangé ; le levier d'urgence prime.
- `retentionEffective(instance, espace, offre: { nom: Offre; descenteLe: Date | null } | null, maintenant?)`, même règle.

- [ ] Tests d'abord : le test qui relit la parité SQL et TypeScript, étendu au Pro et au Business ; un Pro sans descente
  prend la grille ; un Pro descendu du Business il y a 10 jours garde l'ancienne durée ; l'instance à 0 ne purge rien ; en A,
  le Pro vaut encore 90, donc aucune conversation ne change de sort (test d'intégration).
- [ ] Implémenter, tests, typecheck.

### Tâche A7 : tous administrateurs en Pro

**Fichiers :** `src/offres/membres.ts`, `src/offres/offres.ts` (`DROITS.pro.limites.admins = null`), `src/index.ts`
(`loadState` et l'état des jetons OAuth, plomberie), `src/http/users.ts`, `src/user/store.pg.ts`,
`src/emails-produit/store.pg.ts`, tests `tests/offres-sieges.test.ts`, `tests/http-users*.test.ts`, tests du middleware et
des e-mails du produit.

**Interfaces :**
- `roleEffectif(offre: Offre, role: string): string` : `admin` en Pro, le rôle enregistré ailleurs. Appliqué là où le rôle est
  relu à chaque requête (session et jeton OAuth), donc toutes les gardes et l'Inbox suivent.
- Invitation en Pro : le rôle enregistré est `admin`, quel que soit le corps. `PATCH .../role` en Pro : 409, « les rôles se
  règlent en Business ».
- Destinataires des e-mails du produit : les membres actifs dont le rôle effectif est `admin`.

- [ ] Tests d'abord : un agent d'un Pro passe les gardes d'administrateur et voit toute l'Inbox, par session et par jeton
  OAuth ; son rôle en base reste `agent` et redevient effectif en Business ; l'invitation en Pro enregistre `admin` et ne
  bute que sur la limite d'utilisateurs ; les e-mails du produit vont à tous les membres d'un Pro.
- [ ] Implémenter, tests, typecheck, auto-attaque.

### Tâche A8 : l'envoi RCS vérifie la fonction

**Fichiers :** `src/workflow/executor.ts` (bloc RCS), `src/campaign/run-job.ts`, `src/http/v1-messages-rcs.ts`, tests de
chacun.

- [ ] Tests d'abord : un espace sans `rcs` mais au canal encore actif (descendu de l'Entreprise) n'envoie rien par ces trois
  chemins, avec la raison journalisée (le scénario prend sa sortie « non joignable », la campagne saute l'étage, l'API
  répond 402) ; une Entreprise envoie comme avant.
- [ ] Implémenter, tests, typecheck.

**Fin de A :** relecture indépendante du diff de A ; commit (plomberie pour les fichiers de câblage) ; `gh run list` et les
jobs lus un par un ; déploiement `migration=avant` (ordre plus bas).

---

## Sous-lot B : la grille visible, la console, la vitrine (un seul commit)

### Tâche B1 : le Pro resserré, et la fonction du widget

**Fichiers :** `src/offres/offres.ts`, `src/offres/refus.ts` (`LIBELLE_FONCTION`), tests de la grille.

- [ ] Tests d'abord : le Pro à 1 000 contacts, 60 jours, sans `agent_meta`, `assistants`, `aide` ; la fonction
  `widget_personnalise` chez le Business et l'Entreprise seulement ; un refus de contacts d'un Pro dit « Passez en Business »,
  d'un Business « Passez en Entreprise » ; un refus du MBA dit « Passez en Business ».
- [ ] Implémenter.

### Tâche B2 : le widget personnalisable

**Fichiers :** `src/widgets/gestion.ts`, `src/http/widget-public.ts`, `src/index.ts` (ce qui passe déjà le badge au rendu),
`src/mcp/outils.ts` (descriptions de `create_widget` et `update_widget`), `web/components/WidgetFormulaire.tsx`,
`web/app/widgets/page.tsx`, tests des widgets.

**Interfaces :** apparence = `couleur`, `position`, `libelle`, `avatarUrl`. Sans `widget_personnalise`, une valeur différente
du standard (`#25d366`, `bas_droite`, libellé et avatar nuls) est refusée en 402 avec la phrase de la fonction ; le rendu
public applique le standard ; rien n'est effacé.

- [ ] Tests d'abord : les cinq cas du point 5 de la relecture.
- [ ] Implémenter ; le formulaire grise l'apparence avec « Personnalisable en Business ».

### Tâche B3 : la marge IA retirée

**Fichiers :** `src/offres/vue.ts` (les limites de la vue et de la grille sans `commissionPct`), `web/lib/offre.ts`,
`web/app/offre/page.tsx`, `docs/aide/fiches/choisir-mon-offre.md` et `en/choisir-mon-offre.md`, pages générées de la
vitrine, `features.md` (section liée, empreinte), tests de la vue et de la parité console.

- [ ] Tests d'abord : la vue et `get_plan` ne portent plus `commissionPct` ; aucun texte public ne contient « commission sur
  le crédit IA » suivi d'un taux (test sur `site/` et `docs/aide/`).
- [ ] Implémenter ; `npm run vitrine:aide` ; `aide:charger` en production après le push.

### Tâche B4 : les refus et les e-mails à quatre offres

**Fichiers :** `src/offres/refus.ts`, `src/emails-produit/alertes.ts`, `src/emails-produit/catalogue.ts`, `src/api/fiche.ts`,
`src/workflow/lancements.ts`, `web/app/developers/evenements/page.tsx`, les descriptions des outils MCP qui nomment une
offre (`src/mcp/outils.ts` : `get_plan` ; `src/mcp/outils-offre.ts` : `subscribe_pro`, qui refuse aussi un Business ;
`src/mcp/outils-agent.ts` : le mode « mba » passe au Business ; `src/mcp/outils-chiffres.ts`, `src/mcp/cible.ts`,
`src/mcp/outils-campagnes.ts`, `src/mcp/outils-numero.ts`, `src/mcp/outils-suppression.ts`), tests
`tests/emails-produit-alertes.test.ts`, `tests/http-automations.test.ts`, `tests/contacts-limite-free.test.ts`,
`tests/mcp-offre.test.ts`.

- [ ] Tests d'abord : un Pro à sa limite d'utilisateurs lit « ajoutez un utilisateur (15 € HT par mois) ou passez en
  Business » ; un Business, « demandez un utilisateur de plus (10 € HT par mois) depuis le Support, ou passez en
  Entreprise » ; les e-mails de limite suivent ; plus aucun « passez en Pro » écrit en dur ; `get_plan` décrit quatre offres.
- [ ] Implémenter ; les docs publiques générées depuis le catalogue MCP se régénèrent en B5 (`npm run doc:md`).

### Tâche B5 : la console à quatre offres

**Fichiers :** `web/lib/offre.ts`, `web/app/offre/page.tsx`, `web/app/support/page.tsx` et `src/http/support.ts`,
`web/app/accueil/page.tsx`, `web/app/admin/page.tsx`, `web/app/ops/page.tsx` et `web/lib/ops-offre.ts`,
`web/components/HorsOffre.tsx`, `EncartOffre.tsx`, `AccountMenu.tsx`, `AppShell.tsx`, `ParcoursNumero.tsx`,
`AbonnementPro.tsx`, `FacturesEspace.tsx`, `web/app/paiement-recu/page.tsx`, `web/app/developers/mcp/page.tsx`,
`web/app/developers/api/guides/order-notifications/page.tsx`, docs générées (`npm run doc:md`),
`web/e2e/captures/offre-demo.ts`, e2e
`web/e2e/offre.spec.ts`, `sieges.spec.ts`, `ops-offre.spec.ts`, `console-free.spec.ts`.

- [ ] La page Offre : la grille en quatre colonnes, l'offre suivante d'un Pro est le Business, la carte Business mène à
  « Nous contacter » (`/support?sujet=business`), un espace Business voit ce qui est inclus et sa limite d'utilisateurs ;
  aucun bouton de paiement pour un Business.
- [ ] Le support connaît « Passer en Business » ; la route marque « prioritaire » une demande d'un espace Business.
- [ ] « Compte & équipe » : pas de choix de rôle en Pro, « Administrateur » pour tous ; le texte des rôles dit enfin juste ce
  que peut un manager (affecter, réglages d'encadrement, contacts désabonnés, journal).
- [ ] `/ops` : la section Business (pose, retrait, utilisateurs), ses trois alertes, la confirmation du retrait quand le
  numéro n'est couvert par rien.
- [ ] Un écran fermé dit « Inclus dans l'offre Business » et propose la fiche d'aide qui fait la même chose pas à pas.
- [ ] e2e lancés avec le serveur démarré à la main (`CLAUDE.md` du dépôt), toute la suite racine aussi (des tests de la
  racine lisent `web/`).

### Tâche B6 : la vitrine à quatre cartes

**Fichiers :** `site/tarifs/index.html`, `scripts/vitrine/anglais/tarifs.json` puis `npm run vitrine:anglais`,
`site/index.html` et `scripts/vitrine/anglais/accueil.json`, `site/developpeurs/index.html` et `site/en/developers/index.html`
(à la main), `scripts/vitrine/boutique-textes.ts`, `scripts/vitrine/cas-textes.ts`, `site/llms.txt`, `site/site.css`, tests
`tests/vitrine-pages.test.ts`, `vitrine-seo.test.ts`, `vitrine-contacts-origines.test.ts`, `vitrine-developpeurs.test.ts`,
`vitrine-boutique.test.ts`, `vitrine-cas.test.ts`, `vitrine-anglais.test.ts`.

- [ ] Tests d'abord : les marques `business.*` (prix, contacts, utilisateurs, siège, webhooks, conservation, crédit offert)
  valent le code ; les marques `business:*` sont exactement les fonctions que le Business ajoute au Pro, `entreprise:*`
  celles que l'Entreprise ajoute au Business ; une ligne `data-bientot` ne nomme jamais une fonction déjà ouverte au
  Business ; les données structurées portent l'offre Business à 349 € par mois hors taxe ; aucune carte mise en avant.
- [ ] Les cartes, le chapeau, le titre, la description, la FAQ (« Comment se paie le Business ? ») ; les quatre cartes tiennent
  sur téléphone, tablette et écran large.
- [ ] Rendu montré à Julien (captures bureau et 375 px) AVANT le push : face publique nouvelle.

### Tâche B7 : le centre d'aide et le plugin

**Fichiers :** `src/aide/fiches.ts` et `scripts/vitrine/aide.ts` (le champ `offre:` dit l'offre minimale : `pro`, `business`,
`entreprise` ou `non`), les fiches de `docs/aide/fiches/` qui citent une offre (choisir mon offre, inviter mon équipe,
HubSpot, le répondeur de Meta, construire un agent IA, me repérer dans la console, connecter mon numéro, recharger le crédit
IA, abonnement du numéro fourni) et leurs jumelles anglaises, `features.md` (sections liées et empreintes),
`scripts/plugin/faq.ts`, `scripts/plugin/generer.ts`, les skills du plugin, `plugin/.claude-plugin/plugin.json` (version
montée), captures (`npm run aide:captures`), tests `tests/vitrine-aide.test.ts`, `tests/aide-proposer.test.ts`,
`tests/plugin-faq.test.ts`, `tests/plugin-readme.test.ts`.

- [ ] Tests d'abord : chaque fiche publique dit l'offre la moins chère qui ouvre sa fonction (les fiches publicités, RCS,
  chaînes et HubSpot disent Entreprise) ; `aide-proposer` vert.
- [ ] Implémenter ; `npm run vitrine:aide`, `npm run plugin:generer`.

### Tâche B8 : les docs du dépôt

**Fichiers :** `features.md` (section Offres), `documentation.md` (§ L'offre d'un espace), `.env.example`, `todo.md` (lots 2
et 3), `docs/JOURNAL-TECHNIQUE.md` (au déploiement).

- [ ] Remettre au vrai ce que la grille a changé, sans ajouter de taux de commission (le sort des taux déjà écrits attend
  Julien) ; aucun compteur calculable.

**Fin de B :** `npx vitest run tests/plan-methode.test.ts tests/aide-proposer.test.ts`, `npm test`, `npm run typecheck`,
auto-attaque, suite `web/` ; relecture indépendante du diff de B ; rendu validé par Julien ; commit unique.

---

## Ordre de déploiement

1. **A1, sonde** en lecture seule ; un Pro trouvé se signale à Julien.
2. **A** : `gh run list` et ses jobs lus un par un ; `gh workflow run deploy-scaleway.yml --ref main -f migration=avant`,
   approuvé par Julien ; avant `migrate`, la liste des migrations de l'image vérifiée ; après, relecture en base (colonnes,
   CHECK sous leur nom, définition de `offre_de_l_espace`) et chemin chaud exécuté par le vrai code en lecture seule.
3. **B** : rendu validé ; push (la vitrine et la console sont publiées au push ; la console appelle la route `/ops` de A, déjà
   en service) ; CI lue ; `deploy-scaleway.yml` avec `migration=aucune` ; `aide:charger` ; `plugin.yml` après le déploiement,
   version montée.
4. **Essai partiel**, avec l'écran `/ops` de B (décision de Julien du 2026-10-27, A déployé sans écran pour le Business) :
   Business posé puis retiré sur un espace de test (offre, numéro, crédit, alertes, gestes affichés). 🔴 Aucun Business
   n'est posé avant que l'API ET les workers de A soient en service : l'ancien code lit une offre inconnue comme la Free, et
   d'anciens workers purgeraient ses conversations à 30 jours (A est en service depuis le 2026-10-27, `b10f981c`).
5. **Essai réel** (section « Méthode de livraison »), puis le journal technique.
