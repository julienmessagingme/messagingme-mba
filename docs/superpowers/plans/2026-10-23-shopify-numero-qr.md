# Écrire en premier sur un numéro relié par QR code, et Shopify dessus : plan

> **Pour un agent qui l'exécute :** suivre les tâches dans l'ordre, cases à cocher. Plan court (règle de Julien) :
> tâches, interfaces, tests attendus, ordre de déploiement, sans code.

**But :** la filière application écrit en premier (Claude, l'API, et d'abord Shopify), et les trois messages Shopify
partent d'un numéro relié par QR code, en texte, dans les seules limites de la Free.

**Architecture :** une porte unique « écrire en premier » (`src/application/premier-message.ts`) qui garde, compte,
réserve un créneau espacé par compte et enfile ; une file pg-boss qui résout l'adresse par `onWhatsApp`, envoie par le
service de connexions et inscrit l'issue chez l'appelant. Shopify choisit entre modèle (API) et texte (QR code) au
moment d'envoyer ; les portes de réponse détournent vers la porte hors des 24 heures.

**Conception :** `docs/superpowers/specs/2026-10-23-shopify-numero-qr-design.md` (à lire avant ce plan).

## Méthode de livraison

**Implémenteur par lot + UNE relecture indépendante du diff en fin de lot** (deux lots, A puis B). Les quatre questions
de la règle : la production emprunte ce chemin (des messages partent chez de vrais clients) ; ce n'est pas réversible (un
message parti ne se rappelle pas, un numéro coupé par WhatsApp non plus) ; les critères sont en grande partie testables,
mais l'adressage et la remise ne se voient que sur un vrai téléphone ; le code porte des invariants invisibles
(idempotence d'un envoi sans clé côté transport, unité de quota consommée sans remboursement, correspondance numéro et
identifiant masqué). Deux oui en haut et des invariants : revue humaine du diff, pas feature-loop, parce qu'une erreur
ici fait partir un message de trop ou fait couper le numéro d'un marchand. Pas de workflow de relecture (règle de
Julien) : un implémenteur, un relecteur. Ce qui clôt : l'essai réel de la tâche 1 (point d'arrêt) et l'essai réel de
la fin, sur un vrai téléphone, dans un espace Free, depuis Claude Code.

## Contraintes globales

- Limites : **celles de la Free, rien d'autre** : `envoisModelesMois` (1 000 par mois civil de Paris, compteur
  `QuotaModeles`, clé `offre.modeles|<tenant>|AAAA-MM`) et `contacts` (100, `verifierPlaceContacts`). Pas de plafond par
  jour, pas de réchauffement, pas de réglage par compte.
- Espacement : **au moins 30 s, plus un aléa de 0 à 30 s**, entre deux messages écrits en premier d'un même compte ;
  jamais un refus.
- Règle des 24 heures : un message dans les 24 h après le dernier message reçu du contact
  (`getConversationContext().lastInboundAt`, `FENETRE_SERVICE_MS`) est une réponse libre ; tout autre passe par la porte.
- Consentement : Shopify sur cette filière exige le consentement affirmé du marchand (`consentement_le`) pour **les trois**
  messages ; Claude et l'API exigent une fiche `opted_in` ou une déclaration `consent` + `consentSource` écrite par
  `appliquerConsentement` avant l'envoi. STOP et contact bloqué toujours absolus (`machineSeTaitParWaId`).
- Un numéro banni n'est jamais relié de nouveau automatiquement ; un refus de WhatsApp sur un premier message gèle les
  premiers messages du compte **72 h** et prévient les administrateurs.
- La filière API ne change pas : mêmes tests, mêmes résultats.
- Texte : liens en clair, sans bouton ; `PIED_STOP` en dernière ligne de la relance seulement ; `avecPrenomDeSecours`.
- Règles du dépôt : `safeParse` sur toute entrée ; `tenant_id = $1` sur chaque requête ; toute borne appliquée est
  annoncée dans le schéma MCP ; vouvoiement ; ni tiret cadratin ni demi-cadratin ; jamais le nom de l'infrastructure
  sous-jacente.
- Partage de l'arbre : annoncer aux sessions voisines avant d'éditer `src/index.ts`, `src/server.ts`, `src/worker.ts` ;
  commit par plomberie sur `origin/main` pour ces fichiers ; `tsc` et la suite racine entière avant chaque push (vitest ne
  vérifie pas les types) ; `npx tsx scripts/auto-attaque.mts` en local ; aucun test d'intégration en local (le
  `DATABASE_URL` du poste est la production).

## Points de relecture (non couverts par les tests ordinaires, à épingler)

1. Shopify rejoue un webhook déjà servi pendant que son message attend en file : **un seul** message part (clé unique de
   la file, tâche 2, test `un rejeu de la même clé ne crée pas un second message`).
2. Le compte est coupé (403) ou mis en sommeil entre l'enfilement et le créneau : le job **n'envoie pas** à un banni, ne
   le relie pas, inscrit `numero_coupe` ; un compte en sommeil est réveillé puis réessayé (tâche 2).
3. Le client dit STOP entre l'enfilement et le créneau : le job relit le STOP et **n'envoie pas** (tâche 2).
4. Cinquante expéditions validées d'un coup : le webhook répond tout de suite, les messages partent espacés, l'issue
   passe de `en_file` à `envoye` (tâches 2 et 5).
5. La limite du mois atteinte pendant un passage de relance : les paniers non envoyés **restent dus**, aucun n'est
   consommé (tâche 5, test `une relance refusée par la limite libère son panier`).

---

## Lot A : l'adresse d'un inconnu, et un vrai premier message (point d'arrêt)

### Tâche 1 : résoudre l'adresse par `onWhatsApp`, et l'essayer sur un vrai téléphone

**Fichiers :**
- Créer : `src/application/transport/resolution.ts` (fonction pure).
- Modifier : `src/application/transport/session.ts` (`Session` gagne `verifier`, branchée dans `ouvrirSession`) ;
  `src/application/sessions.ts` (`GestionnaireSessions.verifier`) ; `src/application/routes-internes.ts` (route
  `POST /interne/application/comptes/:id/verifier`) ; `src/application/client.ts` (`ClientApplication.verifier`).
- Créer : `scripts/application/essai-premier-message.mts` (essai seulement : vérifie puis envoie un texte à un numéro).
- Tests : `tests/application-resolution.test.ts` (modèle : `tests/application-adresse-reponse.test.ts`) ;
  `tests/application-client.test.ts` (la route réelle par `app.inject`) ; `tests/application-sessions.test.ts`.

**Interfaces produites :**
- `resoudreDestinataire(sock: { onWhatsApp(...jids: string[]): Promise<{ jid: string; exists: unknown; lid: unknown }[] | undefined> }, c: Pick<Correspondances, 'retenir' | 'lidDe'>, numero: string): Promise<{ present: true; lid: string | null } | { present: false }>` :
  liste absente ou vide = `present: false` ; un `lid` qui n'est pas `^[0-9]{1,30}@lid$` est ignoré ; un `lid` valide est
  passé à `retenir(lid, numero)`.
- `Session.verifier(numero: string): Promise<{ present: boolean }>` ; `GestionnaireSessions.verifier(compteId: string, numero: string): Promise<{ present: boolean }>` (lève `ErreurApplication('non_relie')` sans session ouverte).
- Route : corps `z.object({ numero: z.string().regex(/^[0-9]{8,15}$/) })`, réponse `{ present: boolean }`, même
  signature et même `preHandler` que `envoyer`.
- `ClientApplication.verifier(compteId: string, numero: string): Promise<Resultat<{ present: boolean }>>`.

**Tests attendus :**
- `resoudreDestinataire` : un numéro absent (liste vide, liste `undefined`) rend `present: false` et ne retient rien ;
  un `lid` valide est retenu puis `lidDe(numero)` le rend ; un `lid` invalide ou absent rend `present: true, lid: null`
  sans écrire.
- La route réelle : 401 sans signature, 400 sur un numéro invalide, 409 `non_relie` sans session, `{ present }` sinon.
- Après `verifier`, l'envoi au même numéro est adressé au `@lid` (`adresseDeReponse` rend le `lid`).

**Étapes :**
- [ ] Tests rouges, puis le code, puis verts ; `tsc` ; `tests/application-sans-baileys.test.ts` vert (aucun module de
  l'API n'importe `transport/` en valeur).
- [ ] Relecture du lot A, déploiement du service de connexions et de l'API (aucune migration).
- [ ] **Essai réel, point d'arrêt** : depuis le compte relié par QR code d'un espace de test, `essai-premier-message`
  vers un téléphone de Julien qui **n'a jamais écrit** à ce numéro. Le message doit s'afficher lu sur le mobile ET sur
  l'ordinateur du destinataire, jamais « En attente de ce message ». Vrai pour un numéro absent de WhatsApp aussi (rien
  ne part, `present: false`). **Si le message reste « En attente », arrêter et revenir vers Julien** (la conception le
  prévoit : l'écoute des accusés devient une brique, à décider avec lui). Sinon, l'écoute des accusés va au todo.

---

## Lot B : la porte, Shopify, Claude et l'API, le plugin

### Tâche 2 : la porte « écrire en premier », sa file, son espacement, ses raisons

**Fichiers :**
- Créer : `db/migrations/0252_premiers_messages.sql` (0251 pris par HubSpot ; numéro relu par `npm run migrations` au moment d'écrire) :
  - table `application_premiers_messages` : `id uuid pk`, `tenant_id uuid not null` FK `tenants` cascade, `cle text not
    null` (idempotence), `wa_id text not null`, `texte text not null check (char_length between 1 and 4096)`, `origine text
    not null check in ('shopify_commande', 'shopify_panier', 'mcp', 'api', 'reponse')`, `reference text null` (clé
    d'événement Shopify ou jeton de panier), `statut text not null default 'en_file' check in ('en_file', 'envoye',
    'abandonne')`, `issue text null`, `prevu_le timestamptz not null`, `essais int not null default 0`, `message_id text
    null`, `cree_le`, `envoye_le` ; `unique (tenant_id, cle)` ;
  - `comptes_application.premiers_geles_jusqu_au
    timestamptz null` ;
  - `shopify_messages` : `alter column modele drop not null`, `add column texte text check (char_length(texte) between 1
    and 4096)`, `add constraint shopify_messages_modele_ou_texte check ((modele is null) <> (texte is null))`.
  - Toute la migration passe AVANT le code (colonnes écrites par le code, contrainte relâchée : l'ancien code survit),
    avec `set local lock_timeout = '5s'`.
- Créer : `src/application/premier-message.ts` (la porte) et `src/application/premier-message.pg.ts` (le store).
- Modifier : `src/application/envoi.ts`, `client.ts`, `interne.ts`, `sessions.ts` (raisons distinctes) ;
  `src/queue/names.ts`, `src/worker/roles.ts`, `src/worker.ts` (la file) ; `src/emails-produit/catalogue.ts` (e-mail du
  gel) ; `tests/queue-names.test.ts` (tables de résolution) ; `tests/optout-chemins.test.ts` (raison de
  `sock.sendMessage` : la porte est un appelant) ; `tests/application-sans-baileys.test.ts` (`DEPARTS`).
- Tests : `tests/application-premier-message.test.ts`, `tests/integration/application-premier-message.integration.test.ts`
  (nettoie ce qu'il crée).

**Interfaces produites :**
- `RaisonClient` gagne `'banni' | 'sommeil' | 'refuse_whatsapp'` (et `RaisonRefus`, l'enum de `refusLu`) : `envoyer`
  rend la raison du statut au lieu de `non_relie` ; une exception de `sock.sendMessage` qui n'est pas réseau devient
  `refuse_whatsapp` (la reconnaissance exacte de l'erreur 463 est au choix du constructeur, dite dans le commit).
  `phraseApplicationIndisponible` : « numéro coupé par WhatsApp » pour `banni`, jamais « reliez-le de nouveau ».
- `type OriginePremier = 'shopify_commande' | 'shopify_panier' | 'mcp' | 'api' | 'reponse'`
- `interface DemandePremierMessage { tenantId: string; cle: string; telephone: string; texte: string; origine: OriginePremier; reference: string | null; consentement: { mode: 'exige_opt_in' } | { mode: 'declare'; source: string } | { mode: 'marchand'; source: string } }`
- `type RefusPremier = 'filiere_api' | 'numero_coupe' | 'gele' | 'desabonne' | 'bloque' | 'sans_consentement' | 'limite_contacts' | 'limite_modeles' | 'sans_telephone'`
- `enfilerPremierMessage(d: DepsPremierMessage, demande: DemandePremierMessage): Promise<{ ok: true; id: string; prevuLe: Date; dejaEnFile: boolean } | { ok: false; refus: RefusPremier }>` :
  dans l'ordre : filière `application` et compte non `banni` ; gel ; fiche par `resoudreFiche(..., { creer: 'phone' })`
  (`plan_limit_reached` = `limite_contacts`) ; consentement selon le mode (`declare` et `marchand` écrivent `opted_in` par
  `appliquerConsentement` avant le tri) ; STOP et blocage ; insertion idempotente sur `(tenant_id, cle)` (une clé déjà
  là rend `dejaEnFile: true` sans consommer) ; `QuotaModeles.consommer(tenantId, 1)` ; créneau réservé ; enfilement
  `startAfter: prevuLe`.
- Le créneau (livré ainsi) : dans l'insertion, sous un verrou consultatif par espace, `prevu_le` = `greatest(clock_timestamp(),
  max(prevu_le) de l'espace) + 30 s + aléa(0..30 s)` ; deux insertions concurrentes rendent deux instants espacés d'au
  moins 30 s (aucune colonne sur `comptes_application`).
- `FILE_PREMIER_MESSAGE = 'application-premier-message'` (dans `BASE_QUEUES`, polling 5 s, non notifiée, rôle
  `principal`).
- Relecture du lot A, à reprendre ici : la vérification d'un numéro **lit d'abord `lidDe(numero)`** et ne demande à
  WhatsApp que s'il ne rend rien (une interrogation de contact par premier message est un signal surveillé) ; et
  `GestionnaireSessions.verifier` rend les **mêmes raisons distinctes** que `envoyer` (`sommeil`, `banni`), sinon le job,
  qui vérifie avant d'envoyer, ne réveillerait jamais un compte endormi.
- `traiterPremierMessage(d: DepsJobPremier, data: { id: string }): Promise<void>` (worker) : relit la ligne (une ligne
  `envoye` ou `abandonne` ne fait rien) ; relit STOP, blocage, statut du compte, gel ; `verifier` puis `envoyer` ; trace
  par `recordOutboundByWaId` (origine selon la ligne, sans prendre le fil) ; écrit `statut`, `issue`, `message_id` ;
  `sommeil` : `client.relier` puis réessai (au plus 3, puis `abandonne`) ; `refuse_whatsapp` : gel 72 h et e-mail
  `application_premiers_geles` aux administrateurs ; puis `noterIssue(origine, reference, issue)` chez l'appelant.
- `type IssueJobPremier = 'envoye' | 'pas_sur_whatsapp' | 'numero_coupe' | 'refuse_whatsapp' | 'desabonne' | 'bloque' | 'abandonne'`
- `DepsJobPremier.noterIssue(origine: OriginePremier, tenantId: string, reference: string | null, issue: IssueJobPremier): Promise<void>` (Shopify le remplit à la tâche 5 ; `mcp`, `api`, `reponse` : rien).

**Tests attendus :**
- `un rejeu de la même clé ne crée pas un second message` (et ne consomme pas une seconde unité).
- Chaque refus de `RefusPremier` dans l'ordre ci-dessus, et aucun enfilement après un refus.
- `limite_modeles` : `consommer` à `{ ok: false }` rend le refus, rien n'est inséré.
- Le créneau : deux réservations du même compte sont espacées d'au moins 30 s et d'au plus 60 s ; deux comptes ne se
  gênent pas.
- Le job : STOP posé après l'enfilement, rien ne part ; compte `banni`, rien ne part, issue `numero_coupe`, aucun appel à
  `relier` ; `present: false`, issue `pas_sur_whatsapp` ; `refuse_whatsapp`, gel posé à +72 h, e-mail envoyé une fois ;
  la trace dans la conversation porte l'`OrigineMessage` que l'envoi Shopify d'aujourd'hui pose déjà (à relire dans
  `lancerEnvoiPublic`), `mcp` pour Claude, `api` pour l'API et la réponse différée ;
  `sommeil`, `relier` puis réessai ; succès, message tracé sans `takeControl`.
- Raisons : `envoyer` sur un compte `banni` rend `banni` et sa phrase ne dit pas « reliez-le ».
- Intégration (CI) : l'insertion idempotente, la réservation concurrente, la contrainte de `shopify_messages`.
- `tests/queue-names.test.ts`, `tests/worker-roles.test.ts`, `tests/optout-chemins.test.ts` verts.

**Étapes :**
- [ ] Migration écrite, relue contre la skill `migrations-postgres`.
- [ ] Tests rouges, code, verts ; `tsc` ; suite racine.

### Tâche 3 : la règle des 24 heures sur les portes de réponse

**Fichiers :** modifier `src/inbox/repondre.ts`, `src/mcp/outils.ts` (`reply_in_open_window`, `reponseOuRefus`),
`src/http/v1-messages.ts`, `src/http/inbox.ts` ; tests `tests/inbox-repondre*.test.ts` (ou le fichier qui teste
`repondreDansLaFenetre`), `tests/mcp-serveur.test.ts`, `tests/http-v1-messages*.test.ts`.

**Interfaces :**
- Consomme : `enfilerPremierMessage` (tâche 2).
- `ResultatReponse` gagne `{ differe: { id: string; prevuLe: string } }`. Sur la filière application, quand
  `windowOpen` est faux et que l'origine n'est pas `humain` : la réponse passe par `enfilerPremierMessage` avec
  `origine: 'reponse'`, `cle` = `reponse:<conversationId>:<empreinte du texte>:<minute>`, consentement
  `{ mode: 'exige_opt_in' }`. Un refus devient un `RefusReponse` neuf `{ motif: 'premier_message'; refus: RefusPremier }`.
- MCP : « message en file, il part vers HH:MM (hors des 24 heures, compté dans les 1 000 messages du mois) ». `/v1` :
  202 avec l'identifiant. La filière API ne change pas (`fenetre_fermee`).

**Tests attendus :** dans les 24 h, la réponse part tout de suite et rien n'est compté ; hors des 24 h sur la filière
application, elle est différée et comptée ; hors des 24 h sans `opted_in`, refus `sans_consentement` ; sur la filière
API, `fenetre_fermee` inchangé.

### Tâche 4 : Claude et l'API écrivent en premier

**Fichiers :** modifier `src/mcp/outils.ts` (outil neuf) et `src/api/contrat-public.ts` + `src/http/v1-messages.ts`
(`/v1/messages/whatsapp` sans fil) ; `scripts/plugin/familles-outils.ts` ; `npm run doc:md` (périme `web/public`) ;
tests `tests/mcp-serveur.test.ts`, `tests/http-v1-messages*.test.ts`, la suite web entière.

**Interfaces :**
- Outil MCP `write_first_message` : `{ phone: string (E.164), text: string (1..4096), consent_source?: string (1..120) }`,
  `required: ['phone','text']`, bornes annoncées dans le schéma ; ouvert à toutes les offres, refusé sur la filière API
  (« sur l'API, un premier message est un modèle : send_template_to_contact ») ; `consent_source` présent = consentement
  `declare`, absent = `exige_opt_in` ; `cle` = `mcp:<empreinte du téléphone et du texte>:<minute>`.
- `/v1/messages/whatsapp` : `schemaMessageWhatsapp` gagne `consent?: 'opted_in'` et `consentSource?: string` (facultatifs,
  compatibles) ; sur la filière application, `sans_fil` ou hors des 24 h passe par la porte (`origine: 'api'`) et rend 202.

**Tests attendus :** l'outil sur la filière API refuse avec la phrase ; avec `consent_source`, la fiche passe `opted_in`
avant l'envoi ; sans, une fiche non consentante est refusée ; `/v1` sans fil sur la filière application rend 202 ; sur la
filière API, `window_closed` inchangé ; le schéma annoncé porte toutes les bornes (`tests/mcp-*bornes*` ou équivalent).

### Tâche 5 : Shopify en texte

**Fichiers :** modifier `src/shopify/store.pg.ts`, `gestion.ts`, `envoi.ts`, `traitement.ts`, `relance.ts`,
`preparation.ts` (exporter la validation des repères), `src/mcp/outils-shopify.ts`, le câblage `src/index.ts` ;
tests `tests/shopify-gestion.test.ts`, `shopify-traitement.test.ts`, `shopify-relance.test.ts`,
`tests/integration/shopify-store.integration.test.ts` (chercher ses `toEqual` : `MessageBranche` et `PanierDu`
grossissent).

**Interfaces :**
- `MessageBranche` : `modele: string | null; texte: string | null`. `brancher(tenantId, m: { ...; modele: string | null; texte: string | null })`. `PanierDu` gagne `texte: string | null`.
- `Branchement` gagne `texte: unknown`. `brancherMessage` lit la filière (`DepsGestionShopify.filiere(tenantId): Promise<Filiere | null>`) :
  - `application` : `texte` exigé, `template` refusé (400) ; texte validé par `validerTexteShopify(evenement: EvenementShopify, texte: unknown): { ok: true; texte: string; variables: DonneeShopify[] } | { ok: false; message: string }` (repères connus de l'événement, 1 à 4096 caractères, sans les règles propres à Meta) ; un message actif exige le consentement affirmé pour **chacun** des trois événements (409) ; actif tout de suite, sans lecture de modèle, sans attente, sans oubli.
  - `api` : comme aujourd'hui ; `texte` refusé (400 « un texte simple ne part que d'un numéro relié par QR code »).
- `set_shopify_message` : `template` et `text` (1..4096) facultatifs, `required: ['event','language']`, description qui
  dit les deux voies ; `get_shopify_state` rend `text` à côté de `template`.
- `composerTexteShopify(texte: string, evenement: EvenementShopify, valeurs: Partial<Record<DonneeShopify, string>>, langue: string): string` : repères remplacés (après `avecPrenomDeSecours`), `PIED_STOP[langueDuPied(langue)]` en dernière ligne pour `checkout_abandoned`.
- L'envoi : `servir` et `relancerPaniers` aiguillent sur le message et la filière : `texte` + `application` = `enfilerPremierMessage` (`origine` `shopify_commande` ou `shopify_panier`, `reference` = clé d'événement ou jeton, `cle` = celle de l'envoi public d'aujourd'hui, consentement `{ mode: 'marchand', source: 'shopify' }`) ; `modele` + `api` = `envoyerShopify` inchangé ; tout croisement = issue `filiere_differente`, sans envoi.
- `IssueEnvoi` gagne `'en_file' | 'pas_sur_whatsapp' | 'gele' | 'numero_coupe' | 'refuse_whatsapp' | 'filiere_differente'`. `noterIssue` (tâche 2) met à jour `shopify_evenements.issue` ou l'issue du panier.
- La relance : `reclamerPaniersDus(limite, exclus: readonly string[])` exclut les espaces de la filière application dont
  `QuotaModeles.etatDuMois` rend `reste: 0` ; un refus `limite_modeles` d'un panier réclamé appelle
  `libererPanier(tenantId: string, jeton: string): Promise<void>` (`relance_le` remis à null) au lieu de noter l'issue.

**Tests attendus :**
- Branchement : sur la filière application, `text` accepté et actif, `template` refusé ; consentement exigé pour la
  confirmation et l'expédition aussi ; sur la filière API, rien ne change (les tests actuels restent verts) et `text` est
  refusé ; le schéma annoncé porte la borne de `text`.
- Envoi : une commande payée sur la filière application enfile le texte composé (repères remplis, prénom de secours,
  sans pied) ; la relance porte le pied STOP en dernière ligne ; un croisement rend `filiere_differente` ; l'issue
  `en_file` puis `envoye` par `noterIssue`.
- `une relance refusée par la limite libère son panier` (le panier est de nouveau dû) ; un espace sans reste n'est pas
  réclamé.
- Intégration (CI) : `brancher` avec `texte`, la contrainte « l'un ou l'autre », `reclamerPaniersDus` avec `exclus`,
  `libererPanier`.

### Tâche 6 : le plugin et la doc

**Fichiers :** `plugin/skills/shopify/SKILL.md` (par `npm run plugin:generer` si elle est générée ; la FAQ s'écrit dans
`scripts/plugin/faq.ts`), `plugin/skills/mise-en-service/SKILL.md`, `plugin/.claude-plugin/plugin.json` (version
montée) ; `features.md` (§ filière application, § Shopify), la fiche `docs/aide/fiches/brancher-ma-boutique-shopify.md`
et son empreinte dans le même commit (`tests/aide-proposer.test.ts` vert avant le push) ; `documentation.md` (la porte,
la file, l'adressage, les raisons) ; `todo.md` (l'écoute des accusés si la tâche 1 a passé, et ce que la relecture
laisse) ; `docs/JOURNAL-TECHNIQUE.md`.

**Ce que disent les skills :**
- `shopify` : lire `numero.filiere` dans `get_setup_state` d'abord ; sur un numéro QR code, pas de `create_template`,
  `set_shopify_message` avec `text`, les données entre doubles accolades, actif tout de suite ; l'accord du marchand pour
  les trois messages ; la phrase de risque (pas l'API officielle, WhatsApp peut couper un numéro qui écrit beaucoup en
  premier) ; les issues `en_file`, `limite_modeles` (les 1 000 du mois), `pas_sur_whatsapp`, `gele`, `numero_coupe`.
- `mise-en-service` : au moment de relier par QR code, la phrase de risque mentionne l'écriture en premier (Shopify
  compris) et laisse choisir entre le numéro de la boutique et un numéro fourni ; la filière écrit en premier, en texte.

---

## Ordre de déploiement

1. **Lot A** : relecture, push, CI lue job par job, déploiement du service de connexions et de l'API (aucune
   migration), essai réel de la tâche 1. **Point d'arrêt** si le message reste « En attente ».
2. **Lot B, migration** : la migration de la tâche 2 seule, poussée et appliquée AVANT le code qui la lit (image
   construite, migrations relues dans l'image, `pg_stat_activity`, puis relecture en base point par point : colonnes,
   contraintes sous leur nom, `confdeltype`).
3. **Lot B, code** : relecture, push, CI lue job par job, déploiement de l'API, du worker et du service de connexions
   (même `REVISION`), empreintes du code servi, fumée.
4. **Le plugin** : `gh workflow run plugin.yml --ref main`, APRÈS l'API qui porte les outils que ses skills nomment.
5. `aide:charger` en production si la fiche d'aide a changé.

## L'essai réel qui clôt

Celui de la conception (§ 8), dans un **espace Free**, depuis **Claude Code**, avec un **numéro relié par QR code** :
brancher la boutique de test et régler les trois messages en texte ; un panier abandonné depuis un téléphone qui n'a
jamais écrit au numéro (la relance lue sur le mobile et sur l'ordinateur) ; le client répond, l'agent IA répond ; une
commande, sa confirmation, son avis d'expédition ; Claude écrit en premier à un autre numéro ; un STOP, puis plus rien.
Inscrit dans `docs/prive/ESSAIS-REELS.md` ; il solde aussi les essais 144 et 145.
