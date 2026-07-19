# PLAN.md — plan global (au 2026-07-18)

Vue unique de tout ce qui reste, audit de scalabilité **et** lot de features confondus.
Source des constats : `AUDIT-SCALE-2026-07-18.md` (les références Bn et « Railway n » y renvoient).
Ce fichier est la référence de séquencement. Le détail d'un constat se lit dans le rapport.

**Estimations** : développeur seul, à temps plein. « S » = moins d'une journée, « M » = 1 à 3 jours, « L » = une semaine.

---

## La tension à trancher en premier

Ton objectif est « des dizaines de clients connectent leur numéro ». **Aujourd'hui cette promesse
est simulée** : les 12 sites d'envoi utilisent un token Meta global unique, et le token business
chiffré de chaque client, écrit en base par l'Embedded Signup, n'est jamais relu (`decryptSecret`
n'a aucun appelant en production). C'est le constat **B1**, effort L.

Or B1 est en bloc 4 ci-dessous, après ton lot de features. C'est un choix, pas une évidence :

- si le prochain jalon est de **montrer** le produit (démos, premiers rendez-vous), le lot de
  features passe devant, il rend la console présentable et B1 ne se voit pas en démo ;
- si le prochain jalon est de **faire signer** un client qui branchera son propre numéro, B1
  remonte avant le lot, parce que c'est lui qui rend la promesse vraie.

Les blocs 0 et 1 sont à faire dans les deux cas, en premier.

---

## Bloc 0 — les quatre correctifs de quelques heures (1 jour)

Meilleur rapport gain sur effort de tout l'audit. Le point 4 corrige le « internal error »
du Dashboard que tu constates depuis des jours.

| # | Action | Constat | Effort |
|---|---|---|---|
| 0.1 | Borner les 4 pools : `DB_POOL_MAX`, `PGBOSS_MAX`, `DB_CONN_TIMEOUT_MS` au zod de `src/config.ts`, câblés dans `src/db/pool.ts` **et** dans les deux `new PgBossQueue`. Exposer `onError` sur `PgBossQueue` et l'attacher (aujourd'hui un event non capté tue le process) | B2 | S |
| 0.2 | Logger l'exception avant de la masquer dans les deux `setErrorHandler`, activer pino JSON sur stdout (les deux Fastify tournent en `logger: false`) | B9 | S |
| 0.3 | Fail-fast au boot sur `DATABASE_URL` et `META_APP_SECRET` vides (aujourd'hui `.default('')` sans garde : le service démarre, `/health` répond ok, et 100 % des webhooks partent en 403) | B9 | S |
| 0.4 | `/accueil` en `Promise.allSettled` avec un état par appel, sortir `getAccountStatus` de la rafale, distinguer « statut indisponible » de « aucun numéro », bouton Réessayer, retry unique sur 5xx dans `web/lib/api.ts` | bug Dashboard | S |

Après ce bloc : le bug du Dashboard disparaît, et la prochaine panne laisse enfin une trace.

---

## Bloc 1 — sécurité, à fermer avant tout nouveau client (2 à 3 jours)

Ces quatre points sont exploitables aujourd'hui, sur la prod.

| # | Action | Constat | Effort |
|---|---|---|---|
| 1.1 | `/oauth/install` accepte un `?tenant=` arbitraire **sans authentification** : qui connaît l'identifiant d'un client peut lier son propre portail HubSpot à ce client, et lui servir ses listes de contacts. Faire générer le lien par mba sur une route JWT, jeton court signé, consommé au callback | B5b | M |
| 1.2 | L'Embedded Signup réaffecte silencieusement un numéro d'un tenant à un autre (`on conflict do update set tenant_id` sans condition). Ajouter la garde `where tenant_id = excluded.tenant_id`, 409 explicite, chemin admin séparé pour la migration voulue. Revalider l'appartenance dans `campaignRunJob` | B5a | S |
| 1.3 | `POST /card/action` : garde cross-portail contournable en omettant ou en **dupliquant** `portalId`. Pousser le filtre `hub_id` dans le SQL, exiger `portalId`, supprimer le fallback bearer `CARD_SECRET` | B5c | S |
| 1.4 | mm-hubspot n'a **ni CI ni remote GitHub**, et son `DATABASE_URL` local pointe sur le pooler de **production** où un test fait `delete from conversations`. Pousser sur GitHub, copier la CI de mba, sortir les tests d'intégration de la base de prod, `throw` au lieu de `skipIf` quand `CI` est défini | §5 | S |

---

## Bloc 2 — le lot de features demandé (3 à 4 jours)

Arbitrages déjà tranchés par Julien le 2026-07-18, intégrés ci-dessous.

| # | Action | Décision / note | Effort |
|---|---|---|---|
| 2.1 | **Menu « Developers » en bas de la sidebar**, avec deux entrées : documentation de l'API et gestion des clés. Aujourd'hui les clés se créent en curl, la page n'existe pas (c'est la « Phase C » différée du Palier 3) | **Plusieurs clés nommées** par espace (ce que le backend fait déjà) : créer, lister, révoquer. Clé affichée en clair une seule fois à la création | M |
| 2.2 | **Analytics en sous-menus quanti / quali** dans la sidebar | quanti = le dashboard actuel ; quali = le bloc Conversations (analyse) déjà construit au Lot 9, extrait dans sa propre page | S |
| 2.3 | **Date de dernière connexion par compte** sur la page Équipe | **Dernière connexion**, écrite au login. La colonne n'existe pas : **migration requise** (`users.last_login_at`) | S |
| 2.4 | **Créer un template depuis l'écran Campagne**, dans la liste de choix, en réutilisant le formulaire de création existant | ⚠️ La liste est filtrée sur `APPROVED` : un template neuf n'y apparaîtra pas tant que Meta ne l'a pas approuvé. À dire explicitement à l'écran, sinon le bouton paraît cassé | M |
| 2.5 | **Bouton supprimer sur la liste des campagnes** | **Archivage**, sauf les brouillons jamais lancés qui sont supprimés pour de bon. Une campagne envoyée porte l'historique qui alimente les analytics : la masquer, pas l'effacer. Filtre « voir les archivées » | M |
| 2.6 | **Historique par contact** : quelle campagne et quel template lui ont été envoyés et quand, plus toutes les conversations tenues avec lui et leur analyse | Nouvelle route de lecture scopée tenant, plus un onglet sur la fiche contact. Le plus gros item du lot | M |
| 2.7 | **Renommer « Contacts » en « mini-CRM »** dans la sidebar | Libellé seulement, l'URL `/contacts` ne bouge pas (aucun lien cassé) | S |
| 2.8 | **Support** : le mail part déjà, et il arrive déjà chez toi. Rien à changer sur la destination. Ce qu'il faut corriger : le `catch {}` sans binding qui perd le message en silence, l'absence de rate limit sur une clé Resend partagée avec les mails de reset, et le reply-to pris dans le corps de la requête au lieu du JWT | §6B | M |

---

## Bloc 3 — fin de la vague 1 de l'audit (2 jours)

| # | Action | Constat | Effort |
|---|---|---|---|
| 3.1 | Deux index : `contacts(tenant_id, created_at desc)` et `conversation_messages(created_at)`, plus les index de clés étrangères manquants. Les deux index existants sur `contacts` sont **partiels**, donc un `where tenant_id = $1` seul fait un seq scan tous tenants confondus | B8c | S |
| 3.2 | Câbler le rate limiter manquant du worker : une campagne à `ratePerMinute: null` envoie aujourd'hui sans aucun frein | B4 | S |
| 3.3 | Job CI pour `web/` : `tsc --noEmit` et `build`. Aujourd'hui la CI ne compile jamais le frontend, la première personne à voir une erreur de type est le build Docker de production. Installer eslint, ou supprimer le script `lint` mort et les `eslint-disable` qui ne désactivent rien | §5 | S |

---

## Bloc 4 — avant la bascule Railway (8 à 12 jours)

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

## Bloc 5 — après, par ordre de valeur

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
- **Les vérifications visuelles accumulées** (Palier 3 B2, Palier 2, Lots 7, 8 et 9), détaillées dans `todo.md`.

---

## Décisions produit à trancher

Elles changent le coût, pas la faisabilité.

1. **Plusieurs numéros par tenant, oui ou non ?** Si oui, 5.4 coûte L. Si non, c'est S : il suffit de refuser proprement le second numéro au lieu de le casser en silence.
2. **Quelle rétention par défaut**, et est-ce contractuel ou réglable par client ?
3. **Le cap anti-répétition marketing** (désactivé en dur depuis le 2026-07-15) reste-t-il la politique des 30 clients ? Si tu le réactives, crée l'index d'abord, sinon la garde coûte plus cher que l'envoi qu'elle protège.
