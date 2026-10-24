# La coexistence : garder l'application WhatsApp Business et écrire en premier par l'API

**Conception du 2026-10-24**, cadrée avec Julien en rondes de questions. Ce qui est marqué *(choix de Claude)* n'a pas
été tranché par Julien : c'est à relire en priorité.

## 1. Intention

Un numéro relié par QR code (filière application, appareil lié) ne peut pas écrire en premier : WhatsApp le bride.
Mesuré le 2026-10-24 : un premier message est arrivé mais l'appareil a été déconnecté 2,8 s après (401) ; un second a
été refusé dans l'accusé (erreur 463). Le numéro QR code reste donc une option réservée aux réponses (lot C).

Pour écrire en premier (Shopify : confirmation, expédition, relance ; Claude ; l'API) tout en gardant son application
WhatsApp Business et son numéro, la voie officielle est la **coexistence** de Meta : le même numéro vit dans
l'application ET sur l'API Cloud. Les messages qui partent par l'API sont des modèles officiels, que WhatsApp ne bride
pas ; ceux que le marchand tape dans l'application restent gratuits et apparaissent chez nous. C'est ce que font Kanal
et les autres solutions Shopify sérieuses.

## 2. Décisions de Julien (2026-10-24)

| Sujet | Décision |
|---|---|
| Pour qui | **les deux** : le marchand qui a déjà WhatsApp Business sur le numéro de sa boutique, et le développeur relié par QR code qui veut écrire en premier |
| Par où | **Claude Code et la console** : les deux chemins qui relient déjà un numéro par Meta |
| Offres | **toutes, Free comprise** : c'est l'API officielle, avec les limites de l'offre (Free : 1 000 messages par mois, 100 contacts) ; Meta facture les messages envoyés par l'API |
| Un numéro QR code | se voit **proposer la coexistence, sur le même numéro** (il garde ses conversations chez nous) |
| L'historique à la connexion | **rien** : on repart de zéro (ni les 180 jours de conversations, ni les contacts du téléphone) |
| Les contacts | pas d'aspiration du carnet (la limite de 100 contacts de la Free exploserait) ; le marchand importe par l'API publique (`POST /v1/contacts`, `/v1/contacts/batch`, une clé créée par Claude) ou par la console en Pro |
| Le marchand répond depuis son application | **l'agent IA se retire**, comme en QR code : la réponse s'affiche dans la conversation et vaut une prise de main, selon les mêmes réglages de retour que l'Inbox |
| La règle des 14 jours | **un e-mail seulement quand Meta coupe** (rien avant) |
| Essai préalable | **non** : on construit ; l'essai réel se fera avec le numéro WhatsApp Business de Julien |
| L'agent de Meta | **possible** sur un numéro en coexistence, comme sur l'API ; quand le marchand tape dans son application, il se retire lui aussi (le contact sort de sa liste chez Meta) |
| Le premier essai de la fenêtre | **le numéro de test QR code** de newCompany (+44 1555 479304), qui éprouve aussi le passage du QR code à la coexistence ; Meta pourrait le refuser parce qu'il est neuf (depuis le 2026-10-21) |

## 3. Objectifs, non-objectifs, anti-objectifs

**Objectifs**
- Un marchand relie le numéro de son application WhatsApp Business en coexistence depuis Claude Code ou la console,
  sans quitter son application.
- Ses messages Shopify partent ensuite en modèles officiels (le chemin de la filière API, qui existe déjà).
- Ce qu'il tape dans son application apparaît dans la conversation chez nous et fait se retirer l'agent IA.
- Un espace relié par QR code passe en coexistence sur le même numéro ; le compte QR code se retire de lui-même.
- Quand Meta coupe la coexistence, les administrateurs le savent par e-mail, avec la marche à suivre.

**Non-objectifs**
- La synchronisation de l'historique et des contacts (`smb_app_data`). Meta la dit FACULTATIVE (« You can also
  synchronize... ») mais l'enferme dans les 24 heures qui suivent la connexion, une seule fois : sans elle, un marchand
  qui la voudrait un jour devrait se déconnecter depuis son application et refaire la fenêtre de Meta. Accepté.
- Une alerte avant la coupure des 14 jours.
- La migration d'un numéro d'un WABA à un autre, la coche verte, la vérification d'entreprise.
- Les groupes, chaînes, catalogue, messages éphémères : Meta ne les prend pas en coexistence.

**Anti-objectifs**
- Appeler `/register` sur un numéro en coexistence (Meta l'interdit : le numéro est déjà enregistré par l'application).
- Un écho de l'application compté comme un message de l'agent de Meta, ou perdu (c'est ce que ferait le code actuel).
- Un espace laissé avec deux filières vivantes (QR code et API) après le passage.
- Une promesse fausse : « gratuit » pour les messages envoyés par l'API (Meta les facture), ou des fonctions de
  l'application qui continueraient (listes de diffusion, catalogue...).

## 4. Ce que dit Meta (lu le 2026-10-24, sources officielles)

Sources : https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users ,
https://developers.facebook.com/docs/whatsapp/embedded-signup/versions ,
https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation ,
https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog/ , et les références des webhooks
`history`, `smb_app_state_sync`, `smb_message_echoes`.

- **Activation** : `FB.login(..., { config_id, response_type: 'code', override_default_response_type: true, extras: {
  setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' } })` ; l'ancienne valeur
  `coexistence` est refusée depuis le 2025-05-29. Versions de la fenêtre : v2 et v3 dépréciées depuis le 2026-10-15 ; la
  v4 cite `whatsapp_business_app_onboarding` ; la **v5** (2026-10-20, `extras: { version: 'v5' }`) active la coexistence
  par défaut. Notre console lance aujourd'hui la v4 avec `extras: { setup: {} }` (`web/lib/connexion-numero.ts:135`).
- **Fin du parcours** : le message `WA_EMBEDDED_SIGNUP` d'événement `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, avec
  `waba_id` (peut-être sans `phone_number_id` : il se lit alors dans les numéros du WABA, ce que le code sait déjà faire).
- **Pas de `/register`** ; contrôle possible : `is_on_biz_app: true`, `platform_type: 'CLOUD_API'` sur le numéro.
- **Webhooks à ajouter** (abonnement de l'app, geste de Julien dans le tableau de bord de Meta) : `smb_message_echoes`
  (ce que le marchand envoie depuis l'application : `message_echoes[]`, avec `from`, `to`, `id`, `timestamp`, `type`, et
  `edit`/`revoke` avec `original_message_id`), `account_update` (dont `PARTNER_REMOVED`, `PRIMARY_INACTIVITY`,
  `COMPANION_INACTIVITY`), et `history`/`smb_app_state_sync` seulement si un jour on synchronise.
- **Limites** : 20 messages par seconde ; dans l'application, plus de listes de diffusion nouvelles (les anciennes en
  lecture seule), ni groupes, messages éphémères, vue unique, localisation en direct, appels, catalogue, message
  d'accueil ou d'absence, réponses rapides, étiquettes ; tous les appareils liés sont déliés à la connexion (donc la
  session QR code d'un espace qui passe en coexistence).
- **Coupures** : environ 14 jours sans ouvrir l'application (`PRIMARY_INACTIVITY`), 30 jours pour les appareils liés ;
  désinscription depuis l'application (Réglages, Compte, Business Platform, Disconnect) ; l'API Deregister est refusée.
- **Facturation et fenêtre** : les messages tapés dans l'application sont gratuits ; ceux de l'API suivent le tarif de
  l'API ; la fenêtre de 24 heures de l'API ne s'ouvre que sur un message du client reçu APRÈS la connexion, et un message
  tapé dans l'application ne l'ouvre ni ne la prolonge.
- **Éligibilité** : l'éditeur doit être Tech Provider ou Solution Partner, avec Embedded Signup et journalisation de
  session ; l'application en version 2.24.17 ou plus ; la France est ouverte (EEE, UE, Royaume-Uni depuis le
  2025-10-23). Les revendeurs conseillent un numéro actif dans l'application depuis 7 jours au moins.

## 5. Ce qu'il faut construire

### 5.1 La fenêtre de Meta en coexistence (console et Claude)

- Un choix explicite pour la personne : « Garder mon application WhatsApp Business » (coexistence) ou « Un numéro pour
  l'API seule » (le parcours d'aujourd'hui). Dans la console (accueil et page `/brancher`), deux boutons ; pour Claude,
  `start_whatsapp_connection` gagne un mode `coexistence` (filière `api`), qui ouvre le même lien avec le bon parcours.
- La fenêtre s'ouvre avec le `featureType` de coexistence. **Le constructeur tranche entre la v4 + `featureType` et la
  v5** d'après la documentation et un premier essai sur un numéro de test, et le dit dans le plan *(choix de Claude :
  rester sur la v4 pour le parcours ordinaire tant qu'il n'est pas déprécié, ne toucher qu'au parcours de coexistence)*.
- `message-es.ts` reconnaît l'événement de fin de coexistence ; `connexion-numero.ts` (serveur) **saute `/register`**
  pour un numéro en coexistence (lu par `is_on_biz_app`, ou par le mode demandé), et ne tire ni ne range de PIN.
- Le reste du rattachement est celui d'aujourd'hui : échange du code, preuve d'appartenance, `linkTenant`,
  `subscribeApp`, crédit offert au premier numéro vérifié.
- L'état d'un numéro en coexistence est marqué en base *(choix de Claude : une colonne `coexistence boolean` sur
  `phone_numbers`, posée au rattachement, pour l'écran, les e-mails et Claude)*.

### 5.2 Du QR code à la coexistence, sur le même numéro

- Aujourd'hui Claude refuse de relier l'API quand un compte QR code est relié (`src/otp/etat-connexion.ts:48`,
  `src/mcp/outils-numero.ts:412`). Il accepte désormais le mode `coexistence` dans ce cas, et seulement lui.
- La phrase de refus d'« écrire en premier » sur un numéro QR code (lot C) propose la coexistence.
- Au rattachement réussi en coexistence, le compte QR code de l'espace est **retiré** (`retirer` du service de
  connexions : Meta a déjà délié l'appareil) et sa filière devient `api` (déjà le cas : l'API prime dans `filiereDe`).
  Les conversations restent : elles sont rangées par numéro, le même.
- Le refus du Pro pour un espace QR code (`src/stripe/pro.ts:68-72`) renvoie vers la coexistence au lieu de dire
  « pas encore » *(choix de Claude)*.
- Shopify : le lot C refuse les messages Shopify sur un numéro QR code, donc aucun texte n'est en place au passage ;
  après le passage, le marchand règle ses messages en modèles par la skill `shopify` (le chemin de l'API, qui existe).
  Le lot C est livré AVANT ce chantier.

### 5.3 Ce que le marchand tape dans son application

- `smb_message_echoes` est reçu, vérifié comme tout webhook de Meta, et chaque écho devient un **message sortant
  d'origine `humain`** dans la conversation du client, qui **prend le fil** (l'agent IA se retire), sur le modèle exact
  de la filière application (`src/application/entrant.ts:108-111`). Un écho n'est jamais compté comme un message de
  l'agent de Meta (aujourd'hui `parse.ts:163` le range en `standby`, que `processHandovers` inscrit à tort).
- Les types : `text` au premier lot ; un média devient un message de son type sans téléchargement *(choix de Claude)* ;
  `edit` et `revoke` sont ignorés au premier lot *(choix de Claude)*.
- Idempotence par l'identifiant du message, comme les autres webhooks.
- **L'agent de Meta se retire aussi** : quand un écho arrive sur un fil que l'agent de Meta tient (mode `mba`), la prise
  de main passe par le chemin qui retire le contact de la liste de l'agent chez Meta (`reprendreLaMain`), pas seulement
  par l'écriture du détenteur (`prisEnEcrivant` ne suffit pas : rien ne garantit qu'un message tapé dans l'application
  reprenne le fil chez Meta).

### 5.4 Quand Meta coupe

- `account_update` avec `PARTNER_REMOVED`, `PRIMARY_INACTIVITY`, `COMPANION_INACTIVITY` (et `account_offboarded`) : le
  numéro de l'espace est marqué délié (le mécanisme de « Délier » existe), et un e-mail part aux administrateurs, une fois
  par coupure, avec la marche à suivre (ouvrir l'application WhatsApp Business, puis relier de nouveau en coexistence).
- Rien avant la coupure (décision de Julien).

### 5.5 Les textes

- La skill `mise-en-service` du plugin propose la coexistence quand la personne a un numéro dans l'application WhatsApp
  Business et veut écrire en premier ; la skill `shopify` l'indique pour un numéro QR code ; la FAQ du plugin
  (`scripts/plugin/faq.ts`, qui dit encore « pas de coexistence ») ; `features.md`, `documentation.md` ; la fiche d'aide
  qui parle de la connexion du numéro si elle en dit le contraire.
- Les limites de l'application en coexistence et le coût des messages de l'API sont dits au moment du choix, en une
  phrase.

## 6. Ce qui est laissé au constructeur

La version de la fenêtre (§ 5.1), la forme exacte du marquage en base, le découpage en lots, le nom du mode MCP, la
reconnaissance des raisons de coupure dans `account_update`, la phrase exacte des e-mails.

## 7. Les gestes de Julien et l'essai réel

- **Dans le tableau de bord de Meta** : abonner l'app aux champs `smb_message_echoes` et `account_update` (et vérifier
  que l'app est bien Tech Provider avec la journalisation de session de l'Embedded Signup).
- **Le premier essai, au premier lot** : le numéro de test QR code de newCompany passé en coexistence depuis Claude Code :
  la fenêtre (v4 avec `featureType` ou v5), ce que Meta renvoie, l'absence de `/register`, la session QR code déliée et
  retirée, puis l'état du numéro au-delà de 24 heures. Si Meta refuse ce numéro parce qu'il est neuf, l'essai passe au
  numéro WhatsApp Business de Julien.
- **L'essai réel qui clôt** : le numéro WhatsApp Business de Julien, relié en coexistence depuis Claude Code ; une
  confirmation Shopify qui part en modèle vers un client qui n'a jamais écrit ; une réponse tapée dans l'application qui
  apparaît chez nous et fait se retirer l'agent ; puis, si possible, le passage d'un numéro QR code de test en
  coexistence.
