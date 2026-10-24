# La coexistence : plan de construction

> **Pour un agent** : un implémenteur par lot, puis UNE relecture indépendante du diff en fin de lot (`CLAUDE.md`,
> « Revue de code »). Les étapes se cochent (`- [ ]`).

**But** : un marchand relie le numéro de son application WhatsApp Business en coexistence (le même numéro dans
l'application et sur l'API Cloud), depuis Claude Code ou la console ; ce qui part par Messaging Me part en modèles
officiels ; ce qu'il tape dans l'application apparaît chez nous et fait se retirer l'agent ; un espace relié par QR code
y passe sur le même numéro.

**Architecture** : la fenêtre de Meta d'aujourd'hui (Embedded Signup v4) reçoit `featureType:
'whatsapp_business_app_onboarding'` pour ce seul parcours ; le rattachement existant (`connecterNumero`) saute `/register`
pour un numéro en coexistence ; deux lecteurs de webhook neufs (les échos de l'application, les coupures) se branchent
dans la réception à côté des bascules de l'agent de Meta.

**Conception** : `docs/superpowers/specs/2026-10-24-coexistence-design.md` (décisions de Julien, faits de Meta, ce qui
est laissé au constructeur). L'implémenteur lit les deux.

**Prérequis** : le lot C (le numéro QR code ne fait que répondre) est en production avant le lot 1 ; ses phrases de
refus sont retouchées ici (tâche 4).

**Choix tranchés par ce plan** (laissés au constructeur par la conception, § 6) : la **v4 avec `featureType`**, pour le
seul parcours de coexistence (la v5 ne s'essaie que si Meta refuse la v4 à l'essai du lot 1 : une ligne dans
`optionsFenetreMeta`) ; le marquage en base par **deux colonnes** de `phone_numbers` ; **deux lots** ; le mode MCP
s'appelle **`coexistence`**.

**Le questionnaire de Julien (son arbre du 2026-10-24)** : « Avez-vous un compte Meta Business ? une application
WhatsApp Business ? depuis plus ou moins d'un mois ? un numéro disponible, ou un numéro fourni ? », avec à chaque
embranchement la différence expliquée (QR code : pas de compte à créer, ne fait que répondre, coexistence possible
ensuite ; API : un compte Meta Business à créer, écrit en premier). Il vit dans les TEXTES du plugin (skill
`mise-en-service`, `plugin/README.md`, `scripts/plugin/faq.ts`) et de la vitrine, écrits dès maintenant par la session
Vitrine avec la coexistence dite « bientôt ». Ce plan les fait passer à « disponible » (tâche 7), et ajoute la
proposition de passer en coexistence au bout d'un mois de QR code (tâche 8).

**Rien à construire pour le compte Meta Business** : la fenêtre de Meta propose de choisir un portefeuille existant ou
d'en créer un nouveau (documentation de l'Embedded Signup), avec un simple profil Facebook. Comme nous sommes Tech
Provider, Meta demande ensuite au client un moyen de paiement sur son compte WhatsApp avant le premier modèle : les
textes le disent au moment du choix (tâches 3 et 4).

## Méthode de livraison

**Implémenteur par lot, une relecture indépendante du diff en fin de lot, puis déploiement**, parce que ces chemins
sont ceux que la production emprunte (le rattachement d'un numéro chez Meta, la réception des webhooks, la prise de main
d'une conversation) et qu'ils portent des invariants invisibles : `/register` interdit sur un numéro en coexistence, une
seule filière vivante par espace, un écho redélivré qui ne doit pas reprendre un fil rendu depuis. Pas feature-loop :
la moitié des critères ne se mesure que chez Meta. Pas de workflow.

Chaque lot se clôt par un essai réel :
- **Lot 1, la connexion** (tâches 1 à 4) : le numéro de test QR code de newCompany (+44 1555 479304) passé en
  coexistence depuis Claude Code (conception § 7). Si Meta refuse ce numéro parce qu'il est neuf, l'essai passe au
  numéro WhatsApp Business de Julien.
- **Lot 2, ce que Meta envoie ensuite** (tâches 5 à 8), **l'essai réel qui clôt la feature** : le numéro WhatsApp
  Business de Julien relié en coexistence depuis Claude Code ; une confirmation Shopify qui part en modèle vers un
  client qui n'a jamais écrit ; une réponse tapée dans l'application qui apparaît chez nous et fait se retirer l'agent.

Les essais s'inscrivent dans `docs/prive/ESSAIS-REELS.md` à la livraison de chaque lot.

## Contraintes globales

- Français, vouvoiement dans la console (`tests/web-vouvoiement.test.ts`), aucun tiret cadratin ni demi-cadratin.
  « Meta Business Agent » et « l'agent de Meta » restent tels quels.
- Toutes les offres, Free comprise. Aucun texte ne dit « gratuit » pour un message qui part par Messaging Me (Meta le
  facture) ; les messages tapés dans l'application, eux, restent gratuits.
- Jamais `/register` sur un numéro en coexistence. Aucune synchronisation de l'historique ni des contacts
  (`smb_app_data`, `history`, `smb_app_state_sync`).
- Avant chaque push : `npm run lint`, `npx tsc --noEmit` à la racine et dans `web/`, la suite racine ENTIÈRE, la suite
  `web/`, `npx tsx scripts/auto-attaque.mts`. Après : la CI lue job par job (`gh run view <id> --json jobs`).
- Un outil MCP dont la description change : `npm run doc:md` et `npm run plugin:generer` dans le même commit.
- Commits par plomberie sur `origin/main` ; `src/index.ts`, `src/server.ts`, `src/worker.ts` annoncés aux sessions
  voisines avant d'y toucher.
- La console part toujours APRÈS le déploiement de l'API qui la sert (Vercel publie au push).

## Points de vigilance

Ce qu'aucun test d'une tâche ne couvrirait seul ; chaque ligne a son test dans la tâche nommée.

1. **Un champ que Meta ne connaît pas** ajouté à la lecture du numéro (`getPhone`) ferait échouer TOUTES les connexions
   (erreur 100 de Graph). `is_on_biz_app` se lit à part, et son échec ne touche pas le parcours ordinaire (tâche 2).
2. **Un écho redélivré** des heures plus tard reprendrait un fil que l'équipe a rendu à l'agent depuis : un écho déjà
   enregistré ne refait rien, prise de main comprise (tâche 5).
3. **Le retrait de l'appareil QR code qui échoue** : le rattachement réussit avec un avertissement, il n'échoue pas ;
   l'API prime déjà (`filiereDe`), la session restante n'agit plus (tâche 2).
4. **Un numéro coupé par Meta qu'un administrateur « Relie »** depuis l'Accueil enverrait vers un numéro que l'API ne
   sert plus : « Relier » est refusé sur une coupure, seule la fenêtre de coexistence la lève (tâche 6).
5. **Un écho vers un client inconnu de l'espace** (le marchand écrit en premier depuis son application) est un contact
   AJOUTÉ (règle de Julien du 2026-10-24) : il crée une fiche qui compte dans la limite de l'offre (Free : 100), comme
   une création à la main. Seuls les gens qui écrivent les premiers restent hors compte. Une conversation sans fiche
   serait une porte dérobée à la limite (tâche 5).

---

## Lot 1 : la connexion en coexistence

### Tâche 1 : la migration

**Fichier** : créer `db/migrations/<n>_coexistence.sql`, `<n>` lu par `npm run migrations` (0253 au jour du plan).

- [ ] `set local lock_timeout = '5s'` ; `alter table phone_numbers add column if not exists coexistence boolean not null
  default false` ; `alter table phone_numbers add column if not exists coexistence_coupee_le timestamptz` (servie au
  lot 2, posée ici pour une seule migration). Défaut constant : instantané sur une table pleine.
- [ ] Poussée SEULE, appliquée en production AVANT le code de la tâche 2, qui écrit la colonne (l'ancien code survit à
  la colonne, le nouveau échouerait sans elle). Après `migrate`, relire en base les deux colonnes : type, nullabilité,
  défaut.

### Tâche 2 : le rattachement en coexistence (serveur)

**Fichiers** : `src/account/connexion-numero.ts`, `src/meta/embedded-signup.ts`, `src/account/es-store.pg.ts`
(`linkTenant`), `src/http/embedded-signup.ts` (réponse), `src/index.ts` (câblage, annoncé). Tests :
`tests/connexion-numero.test.ts`, `tests/connexion-numero-protocole.test.ts`, créer
`tests/webhooks-coexistence-abonnement.test.ts`.

**Interfaces** :
- Produit : `export const EVENEMENT_COEXISTENCE = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'`
  (`src/account/connexion-numero.ts`).
- `MetaInscriptionDep.surApplication(phoneNumberId: string, businessToken: string): Promise<boolean | null>` :
  `GET /{id}?fields=is_on_biz_app`, `null` sur toute erreur (journalisée), ne lève jamais. Implémentée dans
  `MetaEmbeddedSignupClient`.
- `linkTenant(input)` reçoit `coexistence: boolean` et l'écrit dans `phone_numbers.coexistence` (insertion et `do update`).
- `DepsConnexionNumero.retirerCompteApplication(tenantId: string): Promise<'retire' | 'aucun' | 'echec'>` : retire le
  compte de la filière application de l'espace s'il n'est pas déjà retiré (client du service de connexions,
  `retirer(compteId)`, comme `retirerApplication` dans `src/worker.ts`).
- La branche connectée de `IssueConnexionNumero` gagne `coexistence: boolean` ; la route rend `coexistence: true`
  seulement quand c'est vrai ; la trace `numero.connecte` le porte.

**Règle** : `coexistence = input.evenement === EVENEMENT_COEXISTENCE || (await surApplication(...)) === true`, lu après
`getPhone`. En coexistence : aucun `register`, PIN `null`, `aActiver: false`, crédit offert (déjà borné à un par espace
et par numéro affiché, `offrirAuNumeroVerifie`), puis `retirerCompteApplication`. Son `echec` ajoute l'avertissement
« L’appareil lié par QR code n’a pas pu être retiré de notre côté : WhatsApp l’a déjà délié, et l’espace passe par
l’API. »

- [ ] Tests, écrits d'abord et vus rouges :
  - `coexistence annoncée par la fenêtre` : `register` jamais appelé, `saveCredentials(..., null)`, `linkTenant` reçoit
    `coexistence: true`, `offrirCredit` appelé, issue `coexistence: true` et `aActiver: false` ;
  - `coexistence lue chez Meta sans l'événement` : `surApplication` rend `true`, même issue ;
  - `surApplication en échec, parcours ordinaire intact` : elle rend `null`, numéro vérifié et non `CONNECTED`, donc
    `register` appelé une fois et `coexistence: false` ;
  - protocole : la chaîne `fields` de `getPhone` reste exactement `id,display_phone_number,verified_name,status,code_verification_status` ;
  - `espace relié par QR code` : `retirerCompteApplication` appelé APRÈS `linkTenant` ; `echec` donne une issue `ok`
    avec l'avertissement, jamais un refus ; parcours ordinaire : jamais appelé ;
  - garde de l'abonnement (`webhooks-coexistence-abonnement`) : un `smb_message_echoes` et un `account_update` (payloads
    de la documentation de Meta) traversent la réception sans entrant, sans `recordAgentMessage` et sans erreur. Julien
    abonne l'app à ces deux champs dès ce lot en production : la garde doit tenir avant.
- [ ] Implémenter, tests verts, puis la suite entière.

### Tâche 3 : la fenêtre en coexistence (console)

**Fichiers** : créer `web/lib/fenetre-meta.ts` et `web/lib/fenetre-meta.test.ts` ; modifier `web/lib/connexion-numero.ts`,
`web/components/ParcoursNumero.tsx`, `web/app/accueil/page.tsx` (la zone de connexion), `web/lib/message-es.test.ts`.

**Interfaces** :
- `optionsFenetreMeta(configId: string, coexistence: boolean): { config_id: string; response_type: 'code';
  override_default_response_type: true; extras: Record<string, unknown> }`, que `connect` passe à `FB.login`.
- `ConnexionNumero.connect(o?: { coexistence?: boolean }): Promise<void>`.
- `ParcoursNumero` : `choixInitial: 'fourni' | 'apporte' | 'coexistence' | null`, et une troisième carte ; l'Accueil
  gagne un second bouton à côté de « Connecter ».

**Textes exacts** : le bouton « Garder mon application WhatsApp Business » (« Keep my WhatsApp Business app ») ; sous lui,
une phrase : « Votre numéro reste dans l’application, où les messages que vous tapez restent gratuits ; ceux qui partent
par Messaging Me sont facturés par Meta. L’application perd ses listes de diffusion, son catalogue, ses messages
d’absence et ses étiquettes, et ses appareils liés sont déliés. » (« Your number stays in the app, where the messages you
type stay free; those sent through Messaging Me are billed by Meta. The app loses its broadcast lists, catalogue, away
messages and labels, and its linked devices are unlinked. ») Puis une seconde : « Pas encore de compte Meta Business ?
La fenêtre de Meta le crée en chemin, avec votre profil Facebook. Avant le premier modèle, Meta vous demandera un moyen
de paiement sur votre compte WhatsApp. » (« No Meta Business account yet? Meta's window creates one on the way, with
your Facebook profile. Before the first template, Meta will ask for a payment method on your WhatsApp account. »)

- [ ] Tests :
  - `fenetre-meta` : coexistence, `extras` vaut exactement `{ setup: {}, featureType: 'whatsapp_business_app_onboarding',
    sessionInfoVersion: '3' }` ; ordinaire, `extras` vaut exactement `{ setup: {} }` (le parcours d'aujourd'hui ne bouge pas) ;
  - `message-es` : `{ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '123' } }`
    rend `{ wabaId: '123', evenement: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' }` ;
  - rendu : `choixInitial: 'coexistence'` montre la phrase et le bouton (`data-testid="choix-coexistence-ouvert"`).
- [ ] Implémenter ; suite `web/` ET suite racine (des tests de la racine lisent `web/`).

### Tâche 4 : par Claude, et depuis un numéro QR code

**Fichiers** : `src/auth/token.ts` (`lienNumero.mode`), `src/mcp/outils-numero.ts`, `src/otp/etat-connexion.ts`,
`src/http/numero-fourni.ts` (`numeroConnecte`), `src/application/envoi.ts` (`PHRASE_PREMIER_CONTACT`),
`src/shopify/gestion.ts` (`PHRASE_SHOPIFY_QR_CODE`), `src/stripe/pro.ts` (refus `filiere_application`),
`web/app/brancher/page.tsx`. Tests : `tests/mcp-numero.test.ts`, les tests existants de ces phrases et du Pro.

**Interfaces** :
- `LienNumero.mode: 'fourni' | 'apporte' | 'coexistence'` ; un jeton d'avant reste valide.
- `start_whatsapp_connection` : `mode` gagne `coexistence`, décrit en anglais comme les autres : « the person's own
  number, kept in the WhatsApp Business app on their phone; messages sent through Messaging Me are official templates
  billed by Meta, those typed in the app stay free ».
- `numeroConnecte` et `EtatConnexion.connecte` gagnent `coexistence?: true` (lu sur `phone_numbers.coexistence`) ;
  `watch_whatsapp_connection` le rend.

**Règles** :
- `coexistence` exige la filière `api` : avec `filiere: 'application'`, refus « coexistence : la filière est « api » ».
- Refusé si un numéro de Meta est relié (le message d'aujourd'hui) ; ACCEPTÉ quand la seule chose reliée est un compte
  de l'application (`etat.application` présent) : c'est le passage du QR code. `fourni` et `apporte` restent refusés
  dans ce cas.
- La consigne rendue, dans le registre des consignes voisines du fichier : « Donne ce lien à la personne. Dans la
  fenêtre de Meta, elle saisit le numéro de son application WhatsApp Business et confirme dans l’application, sur son
  téléphone. Son numéro y reste : les messages qu’elle y tape restent gratuits, ceux qui partent par Messaging Me sont
  des modèles facturés par Meta. Pas encore de compte Meta Business ? La fenêtre le crée en chemin, avec un profil
  Facebook ; avant le premier modèle, Meta demandera un moyen de paiement sur le compte WhatsApp. » suivie de l'appel à
  `watch_whatsapp_connection`, comme les autres consignes.
- Les deux phrases du lot C et le refus du Pro pour la filière application se terminent par : « Pour écrire en premier
  tout en gardant l’application WhatsApp Business, reliez ce numéro en coexistence, depuis l’Accueil de la console ou
  depuis Claude. » (le Pro : « Pour le Pro, reliez ce numéro en coexistence... », même fin). Le code `filiere_application`
  ne change pas.

- [ ] Tests : `coexistence accepté sur un espace relié par QR code` (jeton `mode: 'coexistence'`, sans `filiere`) ;
  `coexistence refusé avec filiere application` ; `coexistence refusé quand un numéro de Meta est relié` ; `fourni et
  apporte refusés sur un espace relié par QR code` (inchangé) ; `watch rend coexistence: true` ; le jeton `coexistence`
  se vérifie, un jeton d'avant aussi ; `/brancher` passe `coexistence` à `ParcoursNumero` ; les phrases contiennent
  « coexistence ».
- [ ] Implémenter ; `npm run doc:md` et `npm run plugin:generer` ; suites.

### Déploiement du lot 1

1. Tâche 1 poussée seule ; `build`, vérification dans l'image, `migrate`, relecture en base.
2. Serveur (tâches 2 et 4 hors `web/`) poussé ; CI lue ; `up` de l'API et des workers, garde de révision dans chaque
   commande.
3. Console (tâche 3 et `/brancher`) poussée APRÈS ce `up`.
4. Gestes de Julien dans le tableau de bord de Meta : abonner l'app à `smb_message_echoes` et `account_update` ;
   vérifier qu'elle est Tech Provider avec la journalisation de session de l'Embedded Signup.
5. Essai du lot 1 (conception § 7). Dans la fenêtre, choisir « créer un nouveau portefeuille », pour éprouver la
   création du compte Meta Business en chemin. Le numéro de test est dans l'application depuis le 2026-10-21 : moins
   d'un mois, l'arbre de Julien dirait « QR code, puis coexistence dans un mois » ; l'essai éprouve justement si Meta
   l'accepte, et passe sinon au numéro WhatsApp Business de Julien. Pendant l'essai, Julien tape un message depuis
   l'application : son `smb_message_echoes` brut, lu en base en lecture seule, devient le gabarit des tests de la
   tâche 5 ; de même pour un `account_update` s'il en arrive un.

---

## Lot 2 : ce que Meta envoie ensuite

**Ce que la relecture du lot 1 y ajoute (2026-10-25)**, à traiter dans ce lot, chacun avec son test :
- **Un renouvellement ne doit pas effacer la coexistence** : « Renouveler la connexion Meta » rouvre la fenêtre
  ordinaire, qui ne renvoie que le code ; si `surApplication` rend `null`, `coexistence = excluded.coexistence` repasse le
  numéro à faux, et la tâche 6 ne verrait plus sa coupure. Un `null` garde la valeur en base, et le renouvellement d'un
  numéro en coexistence rouvre la fenêtre de coexistence (console et Claude).
- **Le courriel « appareil retiré » au passage voulu** : WhatsApp délie l'appareil QR code dès la fenêtre de
  coexistence ; `fermee('deconnecte')` (`src/application/sessions.ts`) prévient alors les administrateurs que « plus
  aucun message ne part ni n'arrive ». Faux une fois la coexistence faite : ne pas l'envoyer pour un espace qui a un
  numéro de Meta, ou le remplacer par la confirmation du passage.
- **Un compte WhatsApp à plusieurs numéros** : sans `phone_number_id` à la fin de la fenêtre, le rattachement rend 409
  « impossible de deviner » alors que Meta a déjà fait la coexistence ; départager par `is_on_biz_app` sur chaque numéro.
- **Le même numéro** : `retirerLeCompteApplication` retire le compte QR code quel que soit le numéro relié ; comparer le
  numéro affiché, et sinon le dire dans l'avertissement.
- **La forme réelle d'`account_update`** (tâche 6) : `PRIMARY_INACTIVITY` et `COMPANION_INACTIVITY` ne sont pas des
  événements mais des `disconnection_info.reason` sous `PARTNER_REMOVED` ; `ACCOUNT_OFFBOARDED` et `ACCOUNT_RECONNECTED`
  existent aussi. Un `account_update` n'est gardé que dans `pgboss.job` (aucun événement dans `webhook_events`) : c'est
  là que l'essai le relève.
- **Les textes** (tâche 7) : la skill `mise-en-service` doit appeler `watch_whatsapp_connection` avec le mode
  `coexistence` (sans lui, un espace QR code est dit « branché » avant la coexistence) ; la capture de la fiche d'aide
  « connecter mon numéro » (`web/e2e/captures/connecter-mon-numero-whatsapp.capture.ts`) montre deux choix, `ParcoursNumero`
  en a trois.
- **Accepté pour le lot 1, à savoir** : le bouton de l'Accueil et les trois phrases de refus proposent la coexistence
  avant ce lot, alors que ce que tape le marchand y est ignoré ; au 2026-10-25, seuls newCompany (QR code) et trois espaces
  sans numéro de Meta pouvaient les voir, tous de test.

### Tâche 5 : ce que le marchand tape dans son application

**Fichiers** : créer `src/webhooks/echos-coexistence.ts` et `tests/webhooks-echos-coexistence.test.ts` ; modifier
`src/webhooks/handover.ts` (sortir la lecture d'un écho), `src/webhooks/handler.ts` (une étape isolée par `tenter`,
après les bascules), `src/worker.ts` (câblage, annoncé), le commentaire de `src/webhooks/parse.ts` (« coexistence / MBA »).

⚠️ La conception dit que l'écho de l'application serait aujourd'hui inscrit comme un message de l'agent de Meta : c'est
inexact, `lireLesBascules` ne garde que `standby` et `messaging_handovers`. L'écho est donc aujourd'hui ignoré, et un
test le fige pour qu'il le reste.

**Interfaces** :
- `lireEcho(echo: Record<string, unknown>, value: Record<string, unknown>): { waId?: string; body?: string; messageId:
  string | null; type: string }` (`handover.ts`) : la lecture que fait aujourd'hui `processHandovers`, qui l'appelle.
- `lireLesEchosCoexistence(payload: unknown, espaceDe: EspaceDuNumero): Promise<EchoCoexistence[]>` : seulement
  `field === 'smb_message_echoes'`, rattaché comme les bascules ; `EchoCoexistence = { tenantId: string | null;
  phoneNumberId?: string; echo: Record<string, unknown>; value: Record<string, unknown> }`.
- `traiterEchosCoexistence(echos: readonly EchoCoexistence[], deps: DepsEchosCoexistence): Promise<void>`, avec
  `DepsEchosCoexistence = { dejaRecu(tenantId: string, messageId: string): Promise<boolean>; ficheDeLEcho(tenantId: string,
  waId: string): Promise<'existe' | 'creee' | 'limite'>; inbox: { recordOutboundByWaId }; reprendreLaMain:
  ControleDuFil['reprendreLaMain'] }` ; `dejaRecu` est celui de la filière application (`creerDejaRecu`) ;
  `ficheDeLEcho` passe par `upsertByPhoneReturningId` SANS la marque de l'entrant, donc une fiche créée compte dans la
  limite de l'offre, et `LimiteOffreError` rend `'limite'`.

**Règle, par écho** : déjà reçu, rien ; `edit` ou `revoke`, journalisé et rien d'autre ; sinon `ficheDeLEcho` (un
inconnu devient une fiche qui compte : règle de Julien, point de vigilance 5), puis
`recordOutboundByWaId(tenant, waId, { body, messageId, type, origine: 'humain' })` (sans texte, `body` vaut le type
entre crochets, `[image]`, comme la filière QR code) puis
`reprendreLaMain(tenant, waId, auteurDeLEnvoi('humain', null))`, qui retire aussi le contact de la liste de l'agent de
Meta s'il y est ; `'refuse'` est journalisé, le message reste. Sans `waId` ou d'un numéro inconnu : journalisé.
🔴 **`'limite'` (le 101e contact d'une Free) : à trancher par Julien AVANT le lot 2** (question posée le 2026-10-24 :
rien chez nous et l'administrateur prévenu, ou rien chez nous et l'agent muet pour ce numéro, ou la fiche créée
quand même) ; le lot 2 ne part pas sans sa réponse.

- [ ] Tests (sur le gabarit relevé à l'essai du lot 1) : écho texte vers une fiche existante, message sortant `humain`
  PUIS reprise de la main ; écho vers un numéro jamais vu, `ficheDeLEcho` rend `'creee'` et la fiche n'a pas la marque de
  l'entrant (elle compte) ; écho à la limite, le comportement tranché par Julien ; écho redélivré (`dejaRecu` vrai),
  aucun appel ; `edit` et `revoke` ignorés ; un média enregistré sous `[image]` sans téléchargement ; reprise refusée,
  le message reste et rien ne lève ; un `smb_message_echoes` ne donne aucune bascule (`lireLesBascules` rend `[]`) ni
  `recordAgentMessage` ; un numéro délié, l'écho est écarté (le filtre `numeros-delies` couvre déjà `message_echoes`, à
  prouver par la réception composée).
- [ ] Implémenter ; suites.

### Tâche 6 : quand Meta coupe

**Fichiers** : créer `src/webhooks/coupures-coexistence.ts` et son test ; modifier `src/account/numero-delie.pg.ts`,
`src/account/connexion-numero.ts`, `src/http/embedded-signup.ts` (« Relier »), `src/otp/etat-connexion.ts`,
`src/mcp/outils-numero.ts`, `src/emails-produit/catalogue.ts`, `web/app/accueil/page.tsx`, `src/worker.ts` (annoncé).
Créer un test d'intégration (CI seulement) pour le SQL des deux méthodes neuves, qui nettoie ce qu'il crée.

**Interfaces** :
- `EVENEMENTS_COUPURE: readonly string[]`, lus dans la référence `account_update` de Meta (son adresse citée dans le
  fichier) : `PARTNER_REMOVED` (sa raison dans `disconnection_info.reason`, `PRIMARY_INACTIVITY` ou
  `COMPANION_INACTIVITY`, portée dans le courriel) et `ACCOUNT_OFFBOARDED` ; `ACCOUNT_RECONNECTED` lève la coupure s'il
  arrive. Un événement inconnu sur un numéro en coexistence est journalisé en entier.
- `lireLesCoupures(payload: unknown): Array<{ wabaId: string; evenement: string }>` (`entry.id`, `field ===
  'account_update'`), l'espace par `espaceDuCompte` (celui des statuts de modèles).
- `PgNumeroDelieStore.couperCoexistence(tenantId: string): Promise<{ phoneNumberId: string; numero: string; coupeeLe: Date } | null>` :
  la transaction de `delier` (campagnes en pause `numero_delie`) plus `coexistence_coupee_le = coalesce(coexistence_coupee_le,
  now())`, seulement `where coexistence` ; `null` hors coexistence.
- `PgNumeroDelieStore.leverCoupure(tenantId: string): Promise<boolean>` : si coupé, la transaction de `relier`
  (campagnes reprises) et `coexistence_coupee_le = null`. `connecterNumero` l'appelle après `linkTenant` en coexistence.
- Le courriel `coexistence_coupee`, `a: 'admins'`, occasion `coupure:${phoneNumberId}:${coupeeLe.toISOString()}`,
  valeur `numero`. Il dit ce qui s'est passé (Meta a coupé la liaison, par exemple après environ 14 jours sans ouvrir
  l'application), ce qui ne marche plus (aucun message ne part par Messaging Me) et la marche à suivre (ouvrir
  l'application WhatsApp Business sur le téléphone, puis relier de nouveau en coexistence depuis l'Accueil ou depuis
  Claude).
- `EtatConnexion.connecte.coupee?: true` : `start_whatsapp_connection` accepte `coexistence` sur un numéro coupé ;
  l'Accueil montre alors le bouton de coexistence au lieu de « Relier ».
- « Relier » refuse un numéro coupé en 409 : « Meta a coupé la coexistence de ce numéro : ouvrez l’application WhatsApp
  Business sur le téléphone, puis reliez-le de nouveau en coexistence. »

- [ ] Tests : `PARTNER_REMOVED` sur un numéro en coexistence, coupure marquée et courriel émis, deux livraisons donnent la
  même occasion ; `account_update` hors coexistence, ni coupure ni courriel ; événement inconnu, journalisé seulement ;
  « Relier » refusé sur une coupure ; rattachement en coexistence après coupure, `leverCoupure` appelé ;
  `coexistence` accepté par Claude sur un numéro coupé.
- [ ] Implémenter ; suites.

### Tâche 7 : la coexistence « disponible » dans les textes

Pas avant le lot 2 : sans lui, ce que le marchand tape dans l'application n'apparaît pas chez nous et l'agent ne se
retire pas, donc la coexistence ne se recommande pas encore.

**Fichiers** : le questionnaire écrit par la session Vitrine (skill `mise-en-service`, `plugin/README.md`,
`scripts/plugin/faq.ts`, la vitrine), annoncé à cette session avant d'y toucher : chaque issue « coexistence, bientôt »
de l'arbre devient le mode `coexistence` de `start_whatsapp_connection`, avec le compte Meta Business créé en chemin et
le moyen de paiement dits ; la skill `shopify` (un numéro QR code qui veut les messages Shopify : la coexistence) ; la
version de `plugin.json` ; `features.md` (avec `tests/aide-proposer.test.ts` et l'empreinte des fiches qui citent la
section) ; `documentation.md` ; la fiche d'aide de la connexion du numéro si elle dit le contraire (publique :
`npm run vitrine:aide` et sa version `en/`) ; la confirmation de « Déconnecter le numéro » pour un numéro en coexistence
(une phrase : on quitte aussi la coexistence dans l'application, Réglages, Compte, Business Platform) ; `todo.md`.

- [ ] Tests existants verts (plugin, FAQ, `aide-proposer`, vitrine si une fiche publique change) ; `git grep -i "pas de
  coexistence"` ne rend plus rien hors du journal.

### Tâche 8 : la coexistence proposée au bout d'un mois de QR code

L'arbre de Julien : un numéro dans l'application depuis moins d'un mois commence en QR code et passe en coexistence un
mois plus tard, si le client le veut. Claude le propose de lui-même, une fois, sans insister.

**Fichiers** : `src/mcp/mise-en-service.ts` (l'état que rend `get_setup_state`) et son test ; la phrase de la skill
`mise-en-service`, dans le texte de la tâche 7.

**Interface** : `get_setup_state` rend, pour un espace relié par QR code, `numero.coexistence = { possible: boolean;
a_partir_du: 'AAAA-MM-JJ' }`, où `a_partir_du` est la date de liaison du compte (`comptes_application.relie_le`) plus
30 jours ; absent sur la filière API et pour un compte non relié.

- [ ] Tests : relié depuis 29 jours, `possible: false` avec la date ; depuis 30 jours, `possible: true` ; filière API,
  absent ; compte non relié, absent.
- [ ] La skill propose le passage quand `possible` est vrai et que le client veut écrire en premier (Shopify, campagnes) :
  une phrase, et la différence dite (le numéro reste dans l'application, les modèles sont facturés par Meta).

### Déploiement du lot 2

0. La réponse de Julien sur le 101e contact d'une Free (tâche 5) est écrite dans ce plan.
1. Serveur (tâches 5, 6, 8 et 7 hors `web/`) poussé ; CI lue ; `up` de l'API et des workers, garde de révision.
2. Console (l'Accueil d'un numéro coupé) poussée APRÈS ce `up`.
3. `gh workflow run plugin.yml --ref main` après le `up` ; `aide:charger` si une fiche a changé.
4. L'essai réel qui clôt (Méthode de livraison).
