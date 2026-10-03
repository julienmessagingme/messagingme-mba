# OAuth 2.1 devant le serveur MCP : conception

2026-10-03 · décisions de Julien, prises en cadrage le même jour. Lot 2 du plan « Engage Me pour Claude Code ».

Aujourd'hui, `POST /mcp` n'accepte qu'une clé d'API de l'espace. Claude Desktop et claude.ai ne savent pas en porter,
et un nouvel utilisateur de Claude Code doit d'abord ouvrir la console pour en créer une. Ce lot ajoute un serveur
d'autorisation OAuth 2.1 : depuis Claude Code (ou claude.ai), la personne clique « Authenticate », se connecte, clique
« Autoriser », et Claude travaille dans son espace. Pour une adresse inconnue, la connexion Google crée le compte et
l'espace au passage. Les clés d'API ne changent pas.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** La production emprunte ce chemin (des clients appellent
`/mcp`), le lot ouvre une surface d'authentification publique, et il porte des invariants qu'un test ne voit pas
seul : l'égalité exacte entre l'adresse annoncée et l'adresse appelée, la rotation des jetons, la relecture du rôle à
chaque appel. Deux lots : **2a**, l'API (migration, jetons, routes OAuth, garde de `/mcp`, consentement côté
serveur) ; **2b**, la console (page « Autoriser », liste des applications autorisées). Une relecture indépendante
par lot. L'essai réel qui clôt la feature est décrit en section 8.

## Ce que le lot engage, et qui ne se reprend pas

🔴 **L'ADRESSE `https://api.messagingme.app/mcp` DEVIENT L'IDENTITÉ DE LA RESSOURCE.** Le client compare l'adresse
qu'il appelle au champ `resource` des métadonnées (RFC 9728 §3.3) et refuse si elles diffèrent ; l'émetteur
(`https://api.messagingme.app`) est enregistré avec chaque jeton. Renommer l'une ou l'autre déconnecte tous les
Claude déjà autorisés : chacun devrait se réautoriser. Ce n'est pas une perte de données, mais c'est un geste imposé
à chaque utilisateur, donc ces deux adresses se figent maintenant.

🔴 **LE CONSENTEMENT N'EST JAMAIS SAUTÉ.** Notre serveur délègue l'identité à Google avec un identifiant client fixe :
la spécification MCP exige alors un écran de consentement à NOUS, qui nomme le client, ses droits et l'hôte de
retour, avant toute émission de code (« confused deputy »). Le clic « Autoriser » est cet écran, y compris pour une
personne déjà connectée.

## 1. La surface publique (sur `api.messagingme.app`)

Le module ne se monte que si `PUBLIC_API_URL` est posée : vide, elle retombe sur l'adresse de la console, et
l'émetteur annoncé serait faux. Sans elle, toutes ces routes rendent 404.

| Route | Classe d'accès | Rôle |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource` et `.../oauth-protected-resource/mcp` | anonyme | Métadonnées de la ressource (RFC 9728), servies aux deux formes : Claude Code lit la racine, la spec fait essayer la forme à chemin d'abord |
| `GET /.well-known/oauth-authorization-server` | anonyme | Métadonnées du serveur d'autorisation (RFC 8414) |
| `GET /oauth/authorize` | anonyme | Vérifie la demande, puis 302 vers la page de consentement de la console |
| `POST /oauth/token` | anonyme | Échange du code (PKCE) et renouvellement, corps `application/x-www-form-urlencoded`, `Cache-Control: no-store` |
| `POST /oauth/revoke` | anonyme | Révocation par le client (RFC 7009), rend toujours 200 |
| `POST /oauth/consentement/demande` | anonyme | Rend à la page ce qu'elle doit afficher (client, hôte de retour, droits), demande vérifiée |
| `POST /oauth/consentement/google` | anonyme | Jeton d'identité Google + demande : crée le compte si l'adresse est inconnue, rend les espaces de la personne |
| `POST /oauth/consentement/autoriser` | anonyme | Demande + preuve Google signée + espace choisi : émet le code, rend l'adresse de retour |
| `POST /tenants/:tenantId/oauth/autoriser` | tenant, admin | Même geste avec la session de la console |
| `GET /tenants/:tenantId/oauth/autorisations`, `DELETE .../:id` | tenant, admin | Liste et révocation |

**Métadonnées de la ressource** : `resource` = `<PUBLIC_API_URL>/mcp` (sans barre finale), `authorization_servers` =
`[<PUBLIC_API_URL>]`, `scopes_supported` = `mcp:read`, `mcp:write`, `bearer_methods_supported` = `header`.

**Métadonnées du serveur d'autorisation** : `issuer` = `<PUBLIC_API_URL>` ; `authorization_endpoint`,
`token_endpoint`, `revocation_endpoint` ; `response_types_supported: ["code"]` ;
`grant_types_supported: ["authorization_code", "refresh_token"]` ; `code_challenge_methods_supported: ["S256"]`
(sans lui, le client doit refuser de continuer) ; `token_endpoint_auth_methods_supported: ["none"]` ;
`client_id_metadata_document_supported: true` (avec `none`, c'est ce qui fait choisir à Claude les fiches d'identité
plutôt que l'enregistrement dynamique) ; `scopes_supported` ; `authorization_response_iss_parameter_supported: true`.
**Aucun `registration_endpoint`** : il n'y a pas d'enregistrement dynamique (section 2).

**Le 401 de `/mcp`** porte `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_API_URL>/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write"`,
plus `error="invalid_token"` quand un jeton OAuth a été présenté et refusé. Claude ignore cet en-tête sur un 200 :
c'est le 401 qui déclenche la connexion. L'en-tête n'est posé que sur `/mcp`, et seulement quand l'hôte appelé est
celui de `PUBLIC_API_URL` : sur `mba.messagingme.app`, un client à clé révoquée partirait sinon vers un OAuth qui ne
peut pas aboutir (section 7). Ni `/v1`, ni un 403, ni un 429 ne le portent.

**`/oauth/authorize`** exige `response_type=code`, un `client_id` connu, une `redirect_uri` acceptée pour ce client,
`code_challenge` avec `code_challenge_method=S256`, et `state`. `scope` absent vaut les deux droits ; un droit
inconnu est refusé. `resource`, s'il est présent, doit valoir l'adresse de la ressource ; absent, il la vaut.
- Client ou adresse de retour invalide : **aucune redirection** (OAuth 2.1 §7.12.2), une page d'erreur en texte, sous
  la politique de sécurité fermée de l'API.
- Toute autre erreur : redirection vers l'adresse de retour avec `error`, `state` et `iss`.
- Demande valide : 302 vers `<APP_URL>/autoriser?demande=<jeton>`. La demande voyage dans un jeton signé
  (`kind: 'oauth_demande'`, 10 minutes, sur le modèle de `signChoice`, refusé comme session par `verifySession`) :
  aucune table de demandes en attente.

**`/oauth/token`** : erreurs en 400 au format OAuth (`invalid_grant`, `invalid_request`, `invalid_client`,
`unsupported_grant_type`), jamais en 5xx, dont Cloudflare remplace le corps. Le lecteur de formulaires est limité à
la portée du module, comme celui de la vitrine (`src/http/contact-vitrine.ts`). Un plafond partagé freine les
échecs (`PlafondPartage`).

## 2. Les clients acceptés : Claude Code et claude.ai, épinglés

Deux fiches d'identité (Client ID Metadata Documents), relues le 2026-10-03 et **recopiées dans le code**, jamais
récupérées à la volée : pas de requête sortante vers une adresse fournie par un tiers, et pas de dépendance au
Cloudflare de claude.ai, qui rend 403 à certaines adresses de nuage (ticket anthropics/claude-code#84263).

| `client_id` | Nom affiché | Adresses de retour acceptées |
| --- | --- | --- |
| `https://claude.ai/oauth/claude-code-client-metadata` | Claude Code | `http://localhost:<port>/callback` et `http://127.0.0.1:<port>/callback`, tout port (OAuth 2.1 §8.4.2 : le port d'un client natif change à chaque session) |
| `https://claude.ai/oauth/mcp-oauth-client-metadata` | Claude (claude.ai, Desktop, mobile) | `https://claude.ai/api/mcp/auth_callback`, exactement |

Tout autre `client_id` est refusé sans redirection. Cursor, VS Code ou ChatGPT gardent la clé d'API ; l'enregistrement
dynamique (déprécié par la spec MCP 2026-07-28) se rouvrira à la première demande réelle. Un script relit les deux
fiches publiées et dit si elles divergent de la copie ; il touche le réseau, donc il vit hors de `npm test` et se
lance à chaque déploiement de l'API (`DEPLOY.md`) : un changement chez Anthropic devient visible au lieu de casser
les connexions en silence.

## 3. Le consentement : une page de la console

La page vit dans la console (`engageme.messagingme.app/autoriser`, sans `AppShell`), pas sur l'API : la politique de
sécurité de l'API est `default-src 'none'` et `form-action 'none'`, réécrite sur chaque réponse, et l'origine de la
console est déjà autorisée chez Google. Aucun cookie : la session de la console est un en-tête, et la preuve
d'identité de la page OAuth est un jeton Google frais ou cette session.

**Ce que la page affiche, avant tout bouton** : le client (« Claude Code » ou « Claude »), l'hôte de retour
(`localhost` ou `claude.ai`), ce que Claude pourra lire (conversations, contacts, widgets, scénarios, membres) et
faire (répondre dans la fenêtre de 24 h, poser des étiquettes, confier une conversation, créer et modifier des
widgets), et une phrase : ces données seront lues par Claude et traitées par Anthropic, avec un lien vers la
politique de confidentialité de messagingme.fr. Pas de case à cocher au lot 2 : les conditions d'utilisation
s'écriront avant l'ouverture publique du plugin.

**Deux façons de prouver qui l'on est** :
1. **Déjà connecté à la console** (session dans le navigateur) et admin de cet espace : un bouton direct
   « Autoriser dans <espace> ». Les comptes à mot de passe et second facteur passent ainsi par leur connexion
   habituelle.
2. **« Continuer avec Google »** (le composant existant, en mode `surJeton`) : l'API vérifie le jeton Google comme
   `/auth/google`. Adresse inconnue : elle crée « Espace de <nom Google> » et son admin, par le même chemin que
   `/auth/google` (`createTenantWithAdmin`), et la page le dit sous le bouton avant le clic. Elle rend une preuve
   signée (`kind: 'oauth_choix'`, 5 minutes, liée à la demande) et la liste des espaces de la personne : un bouton
   « Autoriser dans <espace> » par espace où elle est admin, les autres affichés avec « demandez à un administrateur ».

**Seul un admin autorise** (décision du 2026-10-03). Le rôle est relu en base au moment d'émettre le code, pas pris
dans la preuve. Les outils MCP supposent un admin (la création de widgets est réservée à l'admin dans la console) :
cette règle garde leur hypothèse vraie sans les réécrire. Ouvrir aux autres rôles demandera d'appliquer à chaque
outil la règle de sa route console.

**Au clic**, l'API crée l'autorisation et le code, et rend l'adresse de retour
(`<redirect_uri>?code=…&state=…&iss=…`) ; la page y navigue. Pas de second facteur exigé : c'est la règle actuelle
de la connexion Google à un espace (les comptes nés par Google ne peuvent pas encore s'enrôler).

## 4. Les jetons et les données

**Jetons opaques**, jamais des JWT : ils se révoquent sur-le-champ et ne peuvent pas être confondus avec une session
signée par `AUTH_SECRET`. Préfixes distincts de la clé d'API (`mba_`), ce qui aiguille la garde sans ambiguïté :
`mbo_` pour l'accès, `mbr_` pour le renouvellement. Seule leur empreinte SHA-256 est stockée.

| Élément | Durée |
| --- | --- |
| Code de retour | 60 secondes, à usage unique (consommation atomique) |
| Jeton d'accès | 1 heure, `expires_in` rendu (Claude renouvelle jusqu'à 5 minutes avant) |
| Jeton de renouvellement | 30 jours sans usage, 90 jours au plus après l'autorisation ; remplacé à chaque usage |

🔴 **Un ancien jeton de renouvellement présenté révoque toute l'autorisation** (RFC 9700 §4.14) : c'est le signe
qu'il a fui. Le renouvellement refusé rend `invalid_grant`, et Claude redemande une connexion.

**Une autorisation par passage dans le consentement** : deux Claude Code sur deux machines font deux autorisations,
listées et révocables séparément. Une autorisation vaut pour **un seul espace** ; changer d'espace, c'est autoriser
de nouveau.

**Tables** (une migration qui ne fait qu'ajouter, numéro pris au moment de l'écrire, appliquée avant le code) :
- `oauth_autorisations` : identifiant, `tenant_id` et `user_id` en cascade (la suppression d'un compte révoque),
  `client_id` (un des deux, CHECK), droits (CHECK : inclus dans `mcp:read`, `mcp:write`), ressource, empreinte et
  échéance du jeton d'accès, empreinte du jeton de renouvellement en cours et du précédent, échéances, date de
  création, dernier usage, date de révocation. Index uniques sur les deux empreintes en cours.
- `oauth_codes` : empreinte du code en clé primaire, autorisation en cascade, `code_challenge`, adresse de retour,
  échéance, date d'usage.

Ni adresse IP ni user-agent. **Purge** : codes échus, autorisations révoquées ou expirées depuis 30 jours. Le journal
d'audit note `oauth.autorise` et `oauth.revoque`, sans jeton ni empreinte.

## 5. Le jeton sur `/mcp`

La garde existante (`makeRequireApiKey`) reste le seul point d'entrée de `/mcp`, de `/v1` et du relais : un jeton
`mbo_` y suit le même ordre (format avant empreinte, budget des empreintes inconnues, relecture en base à chaque
appel). La lecture d'un jeton joint l'autorisation, le compte et l'espace, et refuse : autorisation révoquée ou
échue, compte supprimé ou désactivé, **rôle qui n'est plus admin** (401 `invalid_token`, donc une nouvelle
connexion, que le consentement refusera) ; espace suspendu, 403 (un 401 relancerait la connexion en boucle).

- **`/mcp` seulement.** Un jeton OAuth ne porte que `mcp:read` et `mcp:write` ; `/v1` et le relais exigent d'autres
  droits et le refusent. `req.auth.role` reste `api` : y mettre le vrai rôle ouvrirait un jour une route qui le
  composerait.
- **Plafond** : les appels comptent dans le plafond de l'API de l'espace, partagé avec `/v1` (décision du
  2026-10-03). Le journal d'usage les range sous `oauth:<autorisation>`.
- **Qui signe** : `ContexteMcp` gagne la personne (`null` pour une clé). Une réponse envoyée ou une conversation
  confiée par un jeton OAuth porte la personne comme auteur, avec l'origine `mcp` ; avec une clé, rien ne change.

## 6. La révocation

Sur la page des clés d'API, réservée aux admins : « Applications autorisées », une ligne par autorisation (client,
personne, date, dernier usage) et un bouton « Révoquer ». `POST /oauth/revoke` permet aussi au client de révoquer
son propre jeton. Un compte désactivé ou rétrogradé perd l'accès à l'appel suivant, par la relecture.

## 7. L'infrastructure

- **`api.messagingme.app`** : NPM y envoie déjà tout l'hôte à l'API, donc `/.well-known/oauth-*` atteint Fastify.
  Rien à régler, à mesurer après déploiement (les en-têtes de l'API doivent apparaître, pas une 404 de NPM).
- **`mba.messagingme.app/mcp` reste à clé seulement.** Son proxy envoie `/.well-known/*` à l'ancienne console, et
  la ressource annoncée (`api.`) ne correspondrait pas à l'adresse appelée. Les clés y marchent comme avant.
- **Cloudflare** : aucune règle n'est connue sur ces routes. Mesuré le 2026-10-03 : `/mcp` refuse le client Python
  `urllib` par défaut (erreur 1010) et laisse passer `httpx`, Node et `curl`. Après déploiement, mesurer `/.well-known`
  et `/oauth/token` depuis l'extérieur ; si une vérification navigateur les bloque, Julien pose une règle « Skip »
  sur `/mcp`, `/.well-known/oauth-*`, `/oauth/token` et `/oauth/revoke` (jamais sur `/oauth/authorize`, page de
  navigateur).
- **Google** : rien à régler, la page vit sur l'origine de la console, déjà autorisée.

## 8. Ce qui clôt la feature

Ordre de déploiement : la migration, puis l'API (lot 2a), puis la console (lot 2b), qui appelle des routes neuves.

Essai réel, sur la production :
1. Depuis Claude Code sur le PC de Julien : ajouter `https://api.messagingme.app/mcp` **sans clé**, `/mcp`,
   Authenticate, Google, « Autoriser dans <espace> » ; Claude liste ses outils et lit les derniers messages d'un fil.
2. Révoquer depuis la console : l'appel suivant de Claude échoue et il redemande une connexion.
3. Une adresse Google jamais vue : l'espace est créé, et l'autorisation aboutit.
4. Depuis claude.ai, le même serveur ajouté en connecteur.

## 9. Ce qui n'est pas dans ce lot

- L'enregistrement dynamique et les autres clients MCP (ils gardent la clé d'API).
- L'autorisation par un manager ou un agent, et les outils filtrés par rôle.
- Le second facteur pour les comptes nés par Google (il faut d'abord leur permettre de s'enrôler).
- Les conditions d'utilisation et leur case (avant l'ouverture publique, lot 10).
- L'OAuth sur `mba.messagingme.app`.
- Un compteur de débit propre à chaque autorisation.

## Questions encore ouvertes

- Le comportement de Claude Code est déduit de sa documentation et des fiches : envoi de `resource`, lecture de
  `resource_metadata` dans l'en-tête, et renouvellements concurrents (deux renouvellements simultanés avec le même
  jeton déclencheraient la révocation par rejeu). À mesurer sur une copie de l'API avant la doc, et à l'essai réel.
- L'adresse de retour de claude.ai pourrait passer un jour en `claude.com` : le script de relecture des fiches le
  verra.
