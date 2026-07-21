# PLAN.md : plan global (au 2026-07-21)

Vue unique de tout ce qui reste, audit de scalabilité **et** lot de features confondus.
Source des constats : `AUDIT-SCALE-2026-07-18.md` (les références Bn et « Railway n » y renvoient).
Ce fichier est la référence de séquencement. Le détail d'un constat se lit dans le rapport.

**Estimations** : développeur seul, à temps plein. « S » = moins d'une journée, « M » = 1 à 3 jours, « L » = une semaine.

---

## Reprise à froid : à lire dans cet ordre

Pour une session qui démarre sans contexte.

1. **`docs/MBA-ARCHITECTURE.md`** (10 min). Ce que MBA implique pour notre code, et pourquoi le
   chantier n° 1 se construit sans attendre Meta. C'est le document qui donne le sens du reste.
2. **Ce fichier**, section « Bloc 1 » (le prochain chantier), puis 3, 4, 5.
3. **`docs/MBA-API-REFERENCE.md`** seulement quand on code un appel MBA. 3 700 lignes, à consulter
   par chapitre, jamais en entier.

Ne PAS relire `AUDIT-SCALE-2026-07-18.md` en entier : les constats qui restent sont déjà résumés ici.

**État au 2026-07-21** : blocs 0 et 2 livrés, bloc A aux 3/5, tout déployé en production (964 tests).
**Prochain chantier : le bloc 1, sécurité.** Puis A.3 et A.5 (qui attendent MBA), puis 3, 4, 5.

---

## La thèse produit, qui commande tout le séquencement

`mba.messagingme.app` est **la couche de pilotage du MBA de Meta**, pas un constructeur de bot
concurrent. Cinq piliers : onboarder MBA, contrôler finement ce à quoi l'agent répond, **passer la
main à un humain** (le cœur), lancer des campagnes (ce que MBA ne fait pas), analyser et remonter
dans HubSpot. Ce qui ne sert aucun des cinq est probablement hors sujet.

Pari sous-jacent, énoncé par Julien : Meta pousse vers la réponse full IA via MBA, et **au 01/10 les
messages de service deviennent facturables sauf si c'est MBA qui répond**. MBA cesse alors d'être
une option pour les clients. Reste le point d'entrée, qui est notre terrain : un bouton sur le site
laisse MBA répondre, sinon il faut des campagnes ou des pubs CTWA.

**Blocage actuel, contractuel et non technique.** `agent_eligibility` renvoie 403 « Terms of Service
must be accepted ». Aucune ligne de code n'accélère cette date. Deux veilles tournent sur le VPS,
toutes les 6 heures, avec alerte Telegram : `ops/mba-eligibility-watch.mjs` (l'accès) et
`ops/mba-docs-watch.mjs` (la doc, qui arrive au compte-gouttes avant le 01/08).

---

## Décision produit prise le 2026-07-20 : qui répond après une campagne

Chaque campagne **déclare qui reprend la main une fois le message parti**. La règle par défaut se
déduit de la forme de la campagne :

| Forme de la campagne | Détenteur visé après envoi | Raison |
|---|---|---|
| Workflow qui se termine par un bloc **inbox** | `app_human` | le bloc inbox dit explicitement qu'un humain prend le relais |
| Workflow sans bloc inbox | `app_workflow` | le scénario continue de piloter la conversation |
| **Template seul, sans workflow** | `mba` | personne de notre côté n'attend la réponse, MBA doit répondre |

Le défaut est déduit, mais **surchargeable par campagne** dans l'écran de création : c'est
exactement le « ça je fais répondre automatiquement, ça non » qui fait la valeur du produit.

⚠️ **Question non tranchée, et qui doit l'être en conditions réelles** : un envoi sortant prend-il
implicitement le contrôle du fil ? La doc ne le dit nulle part. Si oui, une campagne « template
seul » coupe MBA sur tous ses destinataires jusqu'à un `release` explicite, donc il faudra un
`release` **par destinataire** après l'envoi, avec le coût et le débit que ça implique. C'est le
premier test à faire le jour de l'ouverture, avant toute campagne de volume.

Note sur l'audience : `ai_audience` n'accepte que `ALLOWLISTED_ONLY` ou `EVERYONE`, et l'allowlist
est une liste de **numéros**. Meta n'offre aucune segmentation (pas de « seulement les prospects »,
pas de « seulement ceux venus de CTWA »). **La règle qui produit la liste, c'est notre produit** :
un segment CRM chez nous, poussé dans l'allowlist. C'est typiquement ce qu'une couche d'agence
apporte et que Meta ne fera pas.

---

## ✅ Bloc A : FAIT aux 3/5 (2026-07-21), déployé en production

**A.1, A.2 et A.4 sont livrés et déployés** (migrations 0040 et 0041 appliquées). Le bug de production
est corrigé : un opérateur qui répond dans l'inbox gèle le scénario sur cette conversation.

| # | État | Quoi |
|---|---|---|
| A.1 | ✅ | `control_owner` sur `conversations` (app_workflow / app_human / mba) + `control_changed_at`. Pose sur les deux familles d'émetteurs. Badge dans l'inbox, bouton « Rendre la main », réglage de la durée sur l'Accueil |
| A.2 | ✅ | Gel du scénario en DEUX points : `advance()` et `runFrom()` (ce dernier couvre `start` et `startFromNode`, qui envoient sans rien demander) |
| A.4 | ✅ | Garde-fou d'inactivité (`src/inbox/control-sweep.ts`), délai réglable **par client** (`tenant_settings.control_handback_seconds`), défaut serveur 2 h |
| A.3 | 🔲 | Consommer `standby` et `messaging_handovers`. **Le module existe** (`src/webhooks/handover.ts`, câblé et testé), mais il est INERTE tant que MBA n'est actif nulle part. Il reste à confronter la forme devinée du payload au réel |
| A.5 | 🔲 | Intention de campagne (qui reprend la main après l'envoi). Voir `docs/PLAN-BLOC-A.md` §A.5, réécrit après la chasse aux pièges |

**Ce qui a été RETIRÉ en cours de route, décision de Julien** : le garde qui bloquait les campagnes vers
un contact tenu par un opérateur. Une campagne est un acte délibéré de l'entreprise, pas la continuation
automatique d'un scénario. La règle est « un humain a la main, le scénario se tait », rien de plus.

**À vérifier au premier test MBA réel** (rien de tout ça n'est documenté par Meta) : la forme exacte des
payloads `standby` et `messaging_handovers` (chercher `handover_recu` et `standby_echo` dans les logs du
worker, le payload complet y est journalisé), si un envoi sortant prend le contrôle du fil, ce que fait
un `release` quand on ne détient pas le contrôle, et le délai avant que MBA reprenne effectivement.

---

## La tension à trancher (rédigée le 2026-07-18, toujours valable)

Ton objectif est « des dizaines de clients connectent leur numéro ». **Aujourd'hui cette promesse
est simulée** : les 12 sites d'envoi utilisent un token Meta global unique, et le token business
chiffré de chaque client, écrit en base par l'Embedded Signup, n'est jamais relu (`decryptSecret`
n'a aucun appelant en production). C'est le constat **B1**, effort L.

Or B1 est en bloc 4 ci-dessous. C'est un choix, pas une évidence :

- si le prochain jalon est de **montrer** le produit (démos, premiers rendez-vous), B1 ne se voit
  pas en démo et peut attendre ;
- si le prochain jalon est de **faire signer** un client qui branchera son propre numéro, B1
  remonte avant tout le reste, parce que c'est lui qui rend la promesse vraie.

**Ce que MBA change à cet arbitrage** : le jour où MBA s'ouvre, chaque client aura son propre numéro
et sa propre configuration d'agent, pilotés **par numéro** (Meta ne partage rien entre numéros).
B1 cesse alors d'être une dette de scalabilité pour devenir un prérequis d'exploitation. Il remonte
donc mécaniquement dès que l'éligibilité passe au vert.

Le bloc 1 est à faire dans les deux cas, juste après le bloc A.

---

## ✅ Bloc 0 : FAIT (2026-07-18), déployé en production

| # | Action | Constat | État |
|---|---|---|---|
| 0.1 | `DB_POOL_MAX` (3), `PGBOSS_MAX` (2), `DB_CONN_TIMEOUT_MS` (8000) au zod, câblés dans `src/db/pool.ts` **et** dans les deux `PgBossQueue`. `poolOptions` extrait en fonction pure (piège `max: 0`). `onError` exposé et attaché avant `start()` dans les deux process | B2 | ✅ |
| 0.2 | Les deux `setErrorHandler` journalisent un JSON (méthode, url, tenant, message, stack) sur les 5xx avant de renvoyer le corps opaque. Côté mm-hubspot l'URL est tronquée avant la query | B9 | ✅ |
| 0.3 | Fail-fast production sur `DATABASE_URL` et `META_APP_SECRET` vides. Vérifié : `.env.prod` porte bien `NODE_ENV=production`, donc le `superRefine` s'exécute réellement | B9 | ✅ |
| 0.4 | `getAccountStatus` sorti de la rafale dans son propre `loadAccount` avec son état `accountLoading`, le reste en `Promise.allSettled`, branche « Statut indisponible » + bouton Réessayer, retry unique sur 5xx réservé aux GET/HEAD | bug Dashboard | ✅ |

**Invariant posé par ce bloc** : « Aucun numéro » ne s'affiche QUE si le statut est chargé ET dit qu'il n'y en
a pas. Ne jamais affirmer une absence qu'on n'a pas constatée.

Reviewer séparé : FAIL au premier passage (un trou réel dans 0.4, `loading` passait à false avant que le statut
n'arrive, ce qui affichait « Aucun numéro » de façon transitoire mais systématique), puis PASS après correction.
5 🟡 fermés dans la foulée, dont une fuite du code d'autorisation HubSpot dans les logs que 0.2 venait
d'introduire, et deux tests qui étaient des faux témoins. Tests : 875 -> 886.

**Reportés en backlog, arbitrage assumé** : `/ops/overview` consomme les 3 connexions du pool d'un coup
(surface admin rare, protégée par `OPS_TOKEN`) ; abaisser les plafonds à 2/1 pour rentrer strictement sous les
15 coûte en latence pour un gain marginal tant que le mode transaction (bloc 4) n'est pas fait.

---

## Bloc 1 : sécurité, à fermer avant tout nouveau client (2 à 3 jours)

Ces quatre points sont exploitables aujourd'hui, sur la prod.

| # | Action | Constat | Effort |
|---|---|---|---|
| 1.1 | `/oauth/install` accepte un `?tenant=` arbitraire **sans authentification** : qui connaît l'identifiant d'un client peut lier son propre portail HubSpot à ce client, et lui servir ses listes de contacts. Faire générer le lien par mba sur une route JWT, jeton court signé, consommé au callback | B5b | M |
| 1.2 | L'Embedded Signup réaffecte silencieusement un numéro d'un tenant à un autre (`on conflict do update set tenant_id` sans condition). Ajouter la garde `where tenant_id = excluded.tenant_id`, 409 explicite, chemin admin séparé pour la migration voulue. Revalider l'appartenance dans `campaignRunJob` | B5a | S |
| 1.3 | `POST /card/action` : garde cross-portail contournable en omettant ou en **dupliquant** `portalId`. Pousser le filtre `hub_id` dans le SQL, exiger `portalId`, supprimer le fallback bearer `CARD_SECRET` | B5c | S |
| 1.4 | mm-hubspot n'a **ni CI ni remote GitHub**, et son `DATABASE_URL` local pointe sur le pooler de **production** où un test fait `delete from conversations`. Pousser sur GitHub, copier la CI de mba, sortir les tests d'intégration de la base de prod, `throw` au lieu de `skipIf` quand `CI` est défini | §5 | S |

---

## ✅ Bloc 2 : FAIT (2026-07-19/20), le lot de features demandé, 8/8

Arbitrages déjà tranchés par Julien le 2026-07-18, intégrés ci-dessous.

> Les 8 items sont livrés et revus (commits 10cef93, 07b8d40, 01156ab). Aucune migration restante :
> 0037, 0038 et 0039 étaient déjà appliquées, le code les lit désormais.
>
> `.loop/lot2-cartographie.md` (cartographie des points d'insertion, ~500k tokens à produire) reste sur disque,
> gitignorée. Elle a servi et a attrapé plusieurs pièges non évidents ; la garder tant que le lot n'est pas
> validé à l'écran par Julien.

| # | Action | Décision / note | Effort |
|---|---|---|---|
| 2.1 | ✅ **FAIT** Menu « Developers » en bas de la sidebar, avec deux entrées : documentation de l'API et gestion des clés. Aujourd'hui les clés se créent en curl, la page n'existe pas (c'est la « Phase C » différée du Palier 3) | **Plusieurs clés nommées** par espace (ce que le backend fait déjà) : créer, lister, révoquer. Clé affichée en clair une seule fois à la création | M |
| 2.2 | ✅ **FAIT** Analytics en sous-menus quanti / quali dans la sidebar | quanti = le dashboard actuel ; quali = le bloc Conversations (analyse) déjà construit au Lot 9, extrait dans sa propre page | S |
| 2.3 | ✅ **FAIT (2026-07-18)** Date de dernière connexion par compte sur la page Équipe | Migration 0037 appliquée. Écrite sur les **5** émissions de session (login, login Google, inscription, inscription Google, acceptation d'invitation), en fire-and-forget, et APRÈS le contrôle `disabled` du chemin Google. 5 tests | ✅ |
| 2.4 | ✅ **FAIT** Créer un template depuis l'écran Campagne, dans la liste de choix, en réutilisant le formulaire de création existant | ⚠️ La liste est filtrée sur `APPROVED` : un template neuf n'y apparaîtra pas tant que Meta ne l'a pas approuvé. À dire explicitement à l'écran, sinon le bouton paraît cassé | M |
| 2.5 | ✅ **FAIT** Bouton supprimer sur la liste des campagnes | **Archivage**, sauf les brouillons jamais lancés qui sont supprimés pour de bon. Une campagne envoyée porte l'historique qui alimente les analytics : la masquer, pas l'effacer. Filtre « voir les archivées » | M |
| 2.6 | ✅ **FAIT** Historique par contact : quelle campagne et quel template lui ont été envoyés et quand, plus toutes les conversations tenues avec lui et leur analyse | Nouvelle route de lecture scopée tenant, plus un onglet sur la fiche contact. Le plus gros item du lot | M |
| 2.7 | ✅ **FAIT (2026-07-18)** Renommer « Contacts » en « mini-CRM » dans la sidebar | Libellé seulement, l'URL `/contacts` ne bouge pas | ✅ |
| 2.8 | ✅ **FAIT** Support : le mail part déjà, et il arrive déjà chez toi. Rien à changer sur la destination. Ce qu'il faut corriger : le `catch {}` sans binding qui perd le message en silence, l'absence de rate limit sur une clé Resend partagée avec les mails de reset, et le reply-to pris dans le corps de la requête au lieu du JWT | §6B | M |

---

## Bloc 3 : fin de la vague 1 de l'audit (2 jours)

| # | Action | Constat | Effort |
|---|---|---|---|
| 3.1 | Deux index : `contacts(tenant_id, created_at desc)` et `conversation_messages(created_at)`, plus les index de clés étrangères manquants. Les deux index existants sur `contacts` sont **partiels**, donc un `where tenant_id = $1` seul fait un seq scan tous tenants confondus | B8c | S |
| 3.2 | Câbler le rate limiter manquant du worker : une campagne à `ratePerMinute: null` envoie aujourd'hui sans aucun frein | B4 | S |
| 3.3 | Job CI pour `web/` : `tsc --noEmit` et `build`. Aujourd'hui la CI ne compile jamais le frontend, la première personne à voir une erreur de type est le build Docker de production. Installer eslint, ou supprimer le script `lint` mort et les `eslint-disable` qui ne désactivent rien | §5 | S |

---

## Bloc 4 : avant la bascule Railway (8 à 12 jours)

Verdict Railway : **pas prêt**, mais les blocages sont peu nombreux et identifiés. Les deux services
sont fondamentalement portables (pas d'écriture disque, `PORT` lu de l'environnement, SIGTERM géré,
sweepers sûrs en multi-réplique).

| # | Action | Constat | Effort |
|---|---|---|---|
| 4.1 | **Résolution du token Meta par tenant** : `resolveMetaCredentials`, fabrique `metaClientFor`, les 12 sites, expiration et révocation, état `token_invalid` par tenant, test prouvant que deux tenants produisent deux tokens | **B1** | L |
| 4.2 | Bind `'::'` au lieu de `'0.0.0.0'` dans les deux `index.ts` : le réseau privé Railway est **IPv6 uniquement**, les appels mba vers mm-hubspot échoueront dès la bascule | Railway 1 | S |
| 4.3 | Passer l'API mba en mode **transaction** sur le pooler (après test du `search_path` de mm-hubspot). Le mode session n'est nécessaire qu'à pg-boss | §4 | M |
| 4.4 | `BACKEND_URL` est figé au **build** du front : la ligne `environment:` du compose est un no-op complet aujourd'hui. Déplacer en `build.args`, déclarer en variable de build sur Railway, ou route handler Next au runtime | Railway 3 | M |
| 4.5 | Horodatage, nonce, méthode et chemin dans le HMAC de `/service/*` et `/ingest` : sur Railway le blocage NPM disparaît, et un corps signé capturé est rejouable indéfiniment | Railway 6 | M |
| 4.6 | `trustProxy` correctement borné (**jamais** `true`, sinon contournement total par `X-Forwarded-For`) et compteurs d'authentification en base. Aujourd'hui `req.ip` est l'IP du conteneur `mba-web` : le plafond de 10 logins par minute est **global à la plateforme** | B11 | M |
| 4.7 | `/health` avec `select 1` et 503, `/live` trivial séparé | Railway/B9 | S |
| 4.8 | Advisory lock dans `db/migrate.ts`, un seul service porteur de la release command | Railway 8 | M |
| 4.9 | Heartbeat du worker en base exposé dans `/ops`, `QUEUE_NAMES` complété (4 files sur 8 aujourd'hui), alerte Telegram extraite du script cron | B9 | M |
| 4.10 | Sweeper de rafraîchissement du statut et de la qualité des numéros, alerte sur RED, sur `status != CONNECTED` et sur `authError`. Aujourd'hui `quality_rating` n'est écrit que quand un **admin** ouvre la page d'accueil | B7 | M |
| 4.11 | CA Supabase montée + `DB_SSL_CA_FILE`, puis retrait de `DB_SSL_INSECURE`. ⚠️ Le commentaire du `.env.prod.example` qui dit que le certificat est public est **faux et périmé** : le correctif naïf casse la prod | Railway 10 | S |
| 4.12 | `tsx` en dependencies (la prod tourne dessus alors que c'est une devDependency), ou réparer le chemin compilé. `npm start` n'a **jamais** fonctionné dans aucun des deux repos | Railway 4, 9 | S |
| 4.13 | Écrire et **tester une fois** la procédure de restauration, avec RPO et RTO réels | Railway 11 | M |

**Point non négociable** : garder `mm-hubspot.messagingme.app` en CNAME devant Railway. L'URL est figée
dans le redirect OAuth et l'allowlist de l'app HubSpot, poussée à la main, en distribution marketplace.
Une URL `*.railway.app` casse le callback OAuth de toute nouvelle installation, sans rollback possible.

---

## Bloc 5 : après, par ordre de valeur

| # | Action | Constat | Effort |
|---|---|---|---|
| 5.1 | **Opt-out écrivable** : aucun chemin n'existe aujourd'hui pour désinscrire un contact (`markOptedIn` ne fait que promouvoir, le webhook ne connaît ni STOP ni DESABONNER), alors que le front affiche déjà un badge « opt-out ». ⚠️ **À remonter en bloc 1 si tu envoies du marketing en volume avant** : c'est de la conformité | B6 | M |
| 5.2 | Rétention et purge : `webhook_events` d'abord (jamais purgée, sans `tenant_id`, donc effacement RGPD structurellement impossible), puis conversations et analyses, puis routine d'effacement par contact | B8a, B8b | M |
| 5.3 | Concurrence worker : `localConcurrency` et `groupConcurrency` par tenant, découpage de `campaign-run` en lots, throttle au niveau du **numéro** | B4 | L |
| 5.4 | Multi-numéro : `phone_number_id` sur `conversations` et `workflow_runs`, unicité `(tenant_id, phone_number_id, wa_id)`, `is_default`, suppression de `getTenantPhoneNumberId` | **B3** | L |
| 5.5 | Appliquer `messaging_limit_tier` à la création de campagne et au dimensionnement du débit | B7 | M |
| 5.6 | Extraire `scopeTenant` (copié **19 fois**), compléter la garde de boot (liste incomplète : inbox, stats, settings, media, tags, fields), test paramétré cross-tenant, test statique sur les `.pg.ts` | B10 | M |
| 5.7 | `schemaVersion` dans le contrat mba vers mm-hubspot, schéma zod couvrant les **valeurs d'enum** (aujourd'hui `z.record(z.unknown())` : un changement de valeur passerait sans bruit sur 100 % des escalades) | §5 | M |
| 5.8 | Frontend : pagination et recherche serveur sur Contacts et Inbox, `AbortController`, distinguer erreur et état vide | §5 | M |
| 5.9 | Extraire les modules infra réellement communs (`ssl.ts` est identique octet pour octet). Aligner le chiffrement de mm-hubspot sur le format versionné de mba (formats **incompatibles** aujourd'hui) | §5 | L |
| 5.10 | Nettoyage du code mort : `contactIdentity`, `systemFieldCode`, `resolveTag`, `FLOW_TEXT_KINDS`, `pullPending` et son harnais orphelin, `conversations.hub_id`, `listAllContacts`. Et surtout **corriger les commentaires mensongers** (`identity.ts:2`, `user/store.pg.ts:220`, `llm-client.ts:9`, `.env.prod.example:19`) qui dissuadent activement le prochain lecteur de chercher le problème | §5 | S |
| 5.11 | Découper `web/app/campaigns/page.tsx` (1384 lignes, dont un composant de 929 lignes avec 36 `useState`) et extraire la logique métier du corps de `main()` dans `worker.ts` (113 lignes inatteignables par tout test) | §5 | L |
| 5.12 | Sortir du plan Supabase actuel vers un projet dédié ou pgbouncer en mode transaction, **avant le dixième client** | §4 | M |

---

## Ce qui n'attend pas du code

- **Phase 3 HubSpot** : activer le toggle, cliquer le CTA de re-consentement sur le portail cobaye 139615673, approuver « Lists », faire un import de test et vérifier que les contacts ne sont pas en `opted_in`.
- **App Review Meta** : en review depuis le 2026-07-17, environ 20 jours. Débloque l'Embedded Signup de bout en bout.
- **Un template Marketing FR à variable** à faire approuver.
- **Les vérifications visuelles accumulées** (Palier 3 B2, Palier 2, Lots 7, 8 et 9), détaillées dans `todo.md`, plus les 8 items du bloc 2 livrés le 2026-07-20 et jamais vus à l'écran.
- **MBA** : accepter les Terms of Service Meta Business Agent dans WhatsApp Manager le jour où l'onglet apparaît, et les Tech Provider ToS dans le portail développeur. Rien de tout ceci n'est faisable par API, et les deux veilles alertent sur Telegram quand ça bouge.

---

## Décisions produit à trancher

Elles changent le coût, pas la faisabilité.

1. **Plusieurs numéros par tenant, oui ou non ?** Si oui, 5.4 coûte L. Si non, c'est S : il suffit de refuser proprement le second numéro au lieu de le casser en silence.
2. **Quelle rétention par défaut**, et est-ce contractuel ou réglable par client ?
3. **Le cap anti-répétition marketing** (désactivé en dur depuis le 2026-07-15) reste-t-il la politique des 30 clients ? Si tu le réactives, crée l'index d'abord, sinon la garde coûte plus cher que l'envoi qu'elle protège.
4. **Le segment CRM qui alimente l'allowlist MBA** : quels critères (tags, opt-in, origine CTWA, ancienneté) et qui a le droit de les modifier ? C'est la brique qui rend `ALLOWLISTED_ONLY` utilisable, et Meta n'en fournit aucun équivalent. À cadrer avant de coder l'écran, pas pendant.
