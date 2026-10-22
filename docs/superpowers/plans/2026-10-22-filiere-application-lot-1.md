# Filière « application WhatsApp Business », premier lot : plan

> **Pour l'exécutant :** superpowers:executing-plans (en direct) ou superpowers:subagent-driven-development, tâche par
> tâche. Les étapes se cochent (`- [ ]`). Plan COURT par règle de Julien : tâches, interfaces, tests attendus, ordre de
> déploiement ; le code s'écrit à l'exécution.

**But :** un espace sans compte Meta Business relie son compte de l'application WhatsApp Business par QR code, reçoit
ses messages dans ses conversations, y répond depuis Claude et par l'agent IA, et la filière s'arrête proprement si
WhatsApp coupe le numéro.

**Architecture :** un nouveau processus, le **service de connexions** (`npm run application`, conteneur
`mba-application`, même image que l'API), tient une session Baileys par compte relié. Il verse chaque message reçu dans
une file pg-boss (`application-entrant`) que le worker traite par la MÊME ingestion que les webhooks de Meta ; l'API et
le worker lui demandent d'envoyer par une petite API interne signée. Les comptes vivent dans une table à part
(`comptes_application`), pas dans `phone_numbers`.

**Pile :** Node 22, TypeScript, Fastify, pg-boss, Postgres, `@whiskeysockets/baileys` 6.7.23 (la version de wagroups),
`qrcode` (déjà au dépôt).

**Spec :** `docs/superpowers/specs/2026-10-22-filiere-application-whatsapp-design.md` (fea500e3).

## Décisions du constructeur (la spec les lui laissait)

- **Table à part, pas de faux `phone_number_id`.** `phone_numbers.id` reste l'identifiant de Meta : un compte de
  l'application dans cette table serait lu par chaque chemin qui appelle Graph (synchronisations, statuts, MBA) avec un
  faux identifiant. Une table à part échoue fermé : un lecteur oublié ne voit pas le numéro, il ne casse rien. Les
  lecteurs à adapter sont nommés tâche par tâche.
- **Un seul processus pour toutes les sessions** (pas un fork par compte comme wagroups) : moins de pièces, la mémoire
  bornée par la mise en sommeil à 30 jours. On recopie de wagroups le transport, l'état d'authentification et la
  machine d'états de la connexion, pas le superviseur.
- **Une file d'entrée, pas un faux webhook de Meta.** Le service ne fabrique pas de charge « à la Meta » : il enfile un
  message déjà converti, et le worker appelle la partie « entrants » de `handleWebhookJob`, extraite pour être partagée.
- **Le choix de la filière se lit, il ne se devine pas** : `filiereDe(tenantId)` rend `'api' | 'application' | null`,
  et chaque point d'envoi la consulte.

## Contraintes globales

- Un espace : une filière, un numéro. Un numéro déjà relié dans un autre espace est refusé.
- Le STOP, le numéro bloqué et le détenteur du fil s'appliquent à chaque envoi de la filière, comme sur l'API.
- La fenêtre de 24 heures ne s'applique pas à la filière application.
- Un bannissement : plus aucun envoi, état visible, développeur prévenu, JAMAIS de relien automatique.
- Mise en sommeil après 30 jours sans aucun message (`APPLICATION_SOMMEIL_JOURS`, défaut 30), toujours dite.
- Le Pro est refusé à un espace de la filière application, avec la phrase « le passage au Pro depuis l'application
  arrive ; il demandera un compte Meta Business ».
- Pas de tiret cadratin ni demi-cadratin dans les textes ; une phrase visible d'un client se relit avec Julien.
- Le plugin se publie EN DERNIER : sa publication ouvre la filière à tous.

## Focus de la relecture

Les cinq cas que les tests de tâche n'épinglent pas seuls, chacun rattaché à la tâche qui porte son test :
1. Un message déjà reçu, redonné par WhatsApp à la reconnexion : enregistré une seule fois (tâche 4).
2. Le service redémarre : chaque compte relié reprend sa session ; un compte banni ou déconnecté ne reprend pas (tâche 3).
3. Le développeur répond sur son téléphone pendant un tour de l'agent : l'envoi de l'agent est refusé par le détenteur
   du fil (tâche 5).
4. Un contact qui a dit STOP écrit de nouveau : ni l'agent ni Claude ne peuvent lui répondre (tâche 5).
5. Le même numéro relié dans un second espace : refus, le premier garde sa connexion (tâche 1).

---

### Tâche 1 : les comptes de l'application, en base

**Fichiers :** migration `db/migrations/<prochain numéro libre, lu par npm run migrations>_comptes_application.sql` ;
`src/application/comptes.ts` (types et contrat), `src/application/comptes.pg.ts` ; tests
`tests/application-comptes.test.ts`, `tests/integration/application-comptes.integration.test.ts`.

**Interfaces produites :**
- table `comptes_application` : `id uuid`, `tenant_id uuid unique` (un compte par espace), `numero text` (chiffres,
  unique tant que le statut n'est ni `banni` ni `retire`), `jid text`, `statut text check in ('en_attente', 'relie',
  'sommeil', 'banni', 'deconnecte', 'retire')`, `fourni_id uuid null` (numéro de la réserve), `relie_le`,
  `dernier_message_le`, `statut_change_le`, `cree_le` ;
- table `comptes_application_auth` : `compte_id`, `cle`, `valeur` chiffrée par `ENCRYPTION_KEY` (le chiffrement
  existant de `src/crypto`), clé primaire `(compte_id, cle)`, cascade à la suppression du compte ;
- `ComptesApplication` : `creer(tenantId, { numero, fourniId })`, `parEspace(tenantId)`, `parId(id)`, `relies()`,
  `marquer(id, statut)`, `toucher(id, quand)` (dernier message), `filiereDe(tenantId): 'api' | 'application' | null`.

**Tests attendus :** un second espace qui crée le même numéro est refusé (cas 5 du focus) ; `filiereDe` rend
`application` pour un compte non retiré, `api` pour un espace qui a un `phone_numbers`, `null` sinon ; le CHECK refuse
un statut inconnu (intégration).

- [ ] Écrire les tests, les voir échouer, écrire migration et store, les voir passer.
- [ ] Pousser la migration SEULE, l'appliquer en production avant le code (tables neuves, que rien ne lit encore).

### Tâche 2 : le transport, recopié de wagroups

**Fichiers :** `src/application/transport/` recopié de `~/wagroups` au commit `526d3cc` (`src/transport/baileys/
transport.ts`, `authState.ts`, `src/transport/connectionState.ts`, leurs tests), chaque fichier avec la référence du
commit source en tête ; `package.json` (Baileys 6.7.23, épinglé).

**Interfaces produites :** `ouvrirSession(compte, auth, rappels): Session` avec `rappels = { qr(texte), ouverte(jid),
message(m), fermee(cause) }`, `Session.envoyer(destinataire, texte): Promise<string>` (identifiant du message),
`Session.fermer()`, `Session.retirer()` (déconnexion de l'appareil) ; `causeDeFermeture(code): 'reprise' | 'banni' |
'deconnecte'` (403 donne `banni`, 401 donne `deconnecte`, le reste `reprise` avec attente croissante plafonnée).

**Tests attendus :** les tests de wagroups recopiés (machine d'états, état d'authentification) passent sur notre table ;
une session reliée par QR code est reconnue reliée par `creds.me` même sans `creds.registered` (l'essai du 21).
⚠️ Avant d'ajouter Baileys : `npm audit` de ses dépendances, le job `securite` bloque une faille haute ou critique de
production (`scripts/audit-exceptions.json` si une exception datée est justifiée).

- [ ] Recopier, adapter l'état d'authentification à `comptes_application_auth`, faire passer les tests.

### Tâche 3 : le service de connexions

**Fichiers :** `src/application/service.ts` (point d'entrée, script `application` dans `package.json`),
`src/application/sessions.ts`, `src/application/routes-internes.ts`, `src/application/client.ts` ;
`docker-compose.yml` et `ops/scaleway/docker-compose.workers.yml` (service `mba-application`) ; tests
`tests/application-sessions.test.ts`, `tests/application-client.test.ts`.

**Interfaces produites :**
- routes internes, signées comme nos services (`signRequest` / `verifyRequest`, classe `signature-service` au registre
  de `src/server.ts` si elles y passent, sinon leur propre garde de signature) : `POST /comptes/:id/relier`,
  `GET /comptes/:id/qr`, `POST /comptes/:id/envoyer { destinataire, texte } -> { messageId }`,
  `POST /comptes/:id/sommeil`, `POST /comptes/:id/retirer` ;
- `ClientApplication` (même forme, côté API et worker), construit sur `APPLICATION_SERVICE_URL` et
  `APPLICATION_SERVICE_SECRET` (posés par Julien dans `.env.prod`) ;
- au démarrage, `reprendre()` rouvre chaque compte `relie` ; à la fermeture `banni` ou `deconnecte`, `marquer` puis un
  courriel par `emails-produit` (« WhatsApp a coupé votre numéro » ou « l'appareil a été retiré »).

**Tests attendus (faux transport) :** redémarrage, seuls les comptes `relie` reprennent (cas 2) ; un 403 marque
`banni`, n'appelle jamais `relier` de nouveau et envoie un courriel ; `envoyer` sur un compte non relié rend un refus
lisible ; une signature absente ou fausse rend 401.

- [ ] Tests, service, client, conteneur ; `npm run auto-attaque` en local si les routes entrent au registre.

### Tâche 4 : recevoir

**Fichiers :** `src/application/entrant.ts` (Baileys vers `InboundMessage`) ; `src/webhooks/handler.ts` (extraire la
partie « entrants » en `traiterEntrants(entrants, deps)`, appelée par `handleWebhookJob` sans changer son
comportement) ; `src/queue/names.ts` (`application-entrant` dans `BASE_QUEUES`) ; `src/worker.ts` (la file) ; tests
`tests/application-entrant.test.ts`, `tests/webhook-handler*.test.ts` existants (inchangés, verts).

**Interfaces :** consomme `Session.rappels.message` (tâche 2) ; produit le job `{ tenantId, compteId, message }`.
- messages individuels seulement (`@g.us` et `status@broadcast` écartés) ;
- `messageId` préfixé `app:` (dédoublonnage par l'unicité existante de `conversation_messages.meta_message_id`) ;
- `waId` = les chiffres du numéro quand WhatsApp le donne, sinon l'identifiant masqué (`…@lid`), reconnu par
  `classifyWaId` comme une forme de plus ;
- un média : un message de son type, sans téléchargement ;
- un message tapé sur le téléphone (`fromMe`) : `recordOutboundByWaId` origine humaine, puis `takeControl` (prise de
  main humaine, l'agent se retire selon les réglages de retour) ;
- `toucher(compteId)` à chaque message, reçu ou envoyé.

**Tests attendus :** un même message redonné deux fois n'est enregistré qu'une fois (cas 1) ; un message de groupe est
ignoré ; un `fromMe` prend le fil ; la suite des webhooks de Meta reste verte à l'identique après l'extraction.

### Tâche 5 : répondre

**Fichiers :** `src/inbox/repondre.ts` (`DepsRepondre.filiere(tenantId)`, requise) ; `src/index.ts` (`sendReply`
routé) ; `src/workflow/wiring.ts` (`envoyerTexteAgent` routé) ; `src/mcp/outils.ts` (`get_conversation`) ; tests
`tests/inbox-repondre*.test.ts`, `tests/application-envoi.test.ts`.

**Interfaces :** consomme `filiereDe` (tâche 1) et `ClientApplication.envoyer` (tâche 3).
- filière `application` : pas de contrôle de fenêtre ; l'envoi passe par le service ; STOP, numéro bloqué et détenteur
  du fil inchangés ;
- `get_conversation` rend `"fenetre": "sans_objet"` pour cette filière au lieu de `window_open`.
⚠️ `sendReply` et l'agent sont des fichiers de câblage partagés (`src/index.ts`, `src/worker.ts`) : annonce aux sessions
voisines et commit en plomberie (règle du dépôt).

**Tests attendus :** un contact désabonné ne reçoit rien, ni de l'agent ni de `reply_in_open_window` (cas 4) ; un fil
pris par l'humain refuse l'envoi de l'agent (cas 3) ; une conversation de plus de 24 heures reçoit la réponse ; la
filière API garde exactement ses refus de fenêtre.

### Tâche 6 : relier, depuis Claude et la page du lien

**Fichiers :** `src/mcp/outils-numero.ts` (`start_whatsapp_connection` : paramètre `filiere: 'api' | 'application'`,
défaut `api` ; `watch_whatsapp_connection` : l'état du compte et la disponibilité du QR) ; `src/otp/etat-connexion.ts`
et `src/http/numero-fourni.ts` (l'état et le QR derrière le jeton du lien) ; `src/mcp/mise-en-service.ts`
(`get_setup_state` : `numero.filiere`, connecté quand le compte est `relie`, et un avertissement `numero_coupe`
ou `numero_en_sommeil` qui dit à Claude quoi faire, pour que le développeur soit prévenu dans sa session aussi) ; `src/agent/credits.pg.ts`
(`offrirAuCompteApplication`, `phone_number_id = 'app:' + compteId` dans `credits_offerts`, mêmes bornes) ;
`web/app/brancher/page.tsx` et `web/components/ParcoursNumero.tsx` (le QR, rafraîchi, à la place de la fenêtre de
Meta) ; e2e `web/e2e/brancher.spec.ts` (cas application).

**Interfaces :** un numéro fourni de la filière suit le parcours existant (paiement 3,50 € HT, attribution, code capté
par le pont, qui appuie sur 5) puis le QR ; son propre numéro va directement au QR.

**Tests attendus :** `start_whatsapp_connection` sans `filiere` se comporte exactement comme aujourd'hui ;
`get_setup_state` passe à l'étape suivante quand le compte est relié ; le crédit est offert une fois par numéro et par
espace ; l'e2e de `/brancher` montre le QR puis « connecté ».
⚠️ La page `/brancher` appelle une route neuve : la console (Vercel, publiée au push) se pousse APRÈS le déploiement de
l'API qui porte la route (règle du dépôt).

### Tâche 7 : les gardes de la filière

**Fichiers :** `src/mcp/outils-offre.ts` (`subscribe_pro`) et `src/http/offre-paiement.ts` (refus du Pro) ; les outils
sans objet sur l'application (modèles, campagnes, agent de Meta) refusent avec une phrase qui propose le passage à
l'API ; un balayage de mise en sommeil dans le worker ; `src/numero/liberation.pg.ts` (fin d'abonnement d'un numéro
fourni de la filière : retirer notre appareil lié, puis résilier chez DIDWW ; un numéro fourni banni se remplace sur
demande par le remplacement existant de la réserve, l'ancien résilié) ; les courriels dans `src/emails-produit/`.

**Tests attendus :** le Pro refusé avec la phrase des contraintes ; un compte sans message depuis 30 jours passe en
`sommeil` et un courriel part ; la libération d'un numéro fourni de la filière appelle `retirer` et jamais
`vuDeMeta` ; chaque outil sans objet refuse sans appeler Graph.

### Tâche 8 : dire, aiguiller, publier

**Fichiers :** `plugin/skills/mise-en-service/SKILL.md` et la consigne de `start_whatsapp_connection` (la question
« Avez-vous un compte Meta Business ? », le numéro fourni recommandé pour un essai) ; `scripts/plugin/faq.ts` (la phrase
du risque ; l'entrée `api-officielle` relue pour rester vraie des deux filières), `npm run plugin:generer` ; la page
développeurs (une phrase) ; `features.md`, `documentation.md`, le journal ; `plugin/.claude-plugin/plugin.json` monté.

**Tests attendus :** `tests/plugin*.test.ts`, `tests/plugin-faq.test.ts`, `tests/vitrine-developpeurs.test.ts`,
`tests/aide-proposer.test.ts` verts.

---

## Ordre de déploiement

1. La migration de la tâche 1, poussée SEULE, appliquée en production, relue en base point par point.
2. API, worker et `mba-application` (tâches 2 à 7, côté serveur), avec `APPLICATION_SERVICE_URL` et
   `APPLICATION_SERVICE_SECRET` posés par Julien dans `.env.prod`, après une CI verte job par job.
3. La console (la page `/brancher` de la tâche 6), poussée APRÈS le point 2.
4. L'essai réel ci-dessous, avec le plugin en local.
5. La doc et le plugin (tâche 8), publié en dernier : c'est ce qui ouvre la filière à tous.

## Méthode de livraison

**Implémenteur par lot, puis une relecture indépendante du diff en fin de lot**, parce que ce lot touche des chemins
que la production emprunte tous les jours : la réception des messages (l'extraction de `handleWebhookJob`), l'envoi
(`repondreDansLaFenetre`, l'agent), une migration et le câblage partagé ; et parce qu'il porte des invariants
invisibles au compilateur (STOP, détenteur du fil, `phone_numbers.id` = identifiant de Meta, aucun relien après un
bannissement). Un feature-loop n'irait pas : la porte est la tenue de ces invariants, pas la complétude d'une liste.

**L'essai réel qui clôt le lot**, sur la production déployée, avec le plugin en local (`claude --plugin-dir`), avant
sa publication : sur un espace neuf, demander à Claude de relier son numéro, répondre « je ne sais pas » au compte
Meta Business, prendre un numéro fourni, l'ajouter dans l'application WhatsApp Business d'un vrai téléphone, scanner le
QR code ; écrire au numéro depuis un autre téléphone et voir l'agent IA répondre seul ; demander à Claude qui a écrit
et répondre par lui ; répondre à la main sur le téléphone et voir l'agent se retirer ; arrêter `mba-application` une
minute pendant qu'un message arrive, puis noter s'il entre dans la conversation à la reprise ou si la coupure est
signalée (la spec laisse cette mesure à l'essai).
