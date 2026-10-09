# OAuth ouvert aux autres clients MCP : conception (lot 15)

2026-10-09 · décisions de Julien, prises en cadrage le même jour. Suite de la spec
`docs/superpowers/specs/2026-10-03-oauth-mcp-design.md`, qui n'acceptait que Claude Code et Claude.

Aujourd'hui, un autre client MCP (ChatGPT, Cursor, VS Code, Lovable) ne se connecte qu'avec une clé d'API, et une clé
n'ouvre pas les outils réservés à une personne (connecter un numéro, créer un agent). Ce lot lui ouvre la même
connexion que Claude : « Se connecter », choisir son espace, « Autoriser ».

## Méthode de livraison

**Implémenteur par lot, puis une relecture du diff.** Le lot ouvre deux surfaces publiques anonymes (un enregistrement
de client, et une requête sortante vers une adresse choisie par un tiers), sur le chemin d'authentification de `/mcp`,
et il porte une migration. Deux livraisons : **A**, l'API (migration 0227, résolution des clients, enregistrement,
fiches d'identité, routes) ; **B**, la console (consentement, applications autorisées) et la doc. L'essai réel qui clôt
le lot : section 8.

## Décisions de Julien (2026-10-09)

| Question | Décision |
| --- | --- |
| Mécanisme | Les FICHES D'IDENTITÉ de n'importe quel client (Client ID Metadata Documents), récupérées avec nos gardes, ET l'ENREGISTREMENT DYNAMIQUE (RFC 7591) en repli. Déprécié par la spec MCP du 2026-07-28, il reste supporté au moins jusqu'en juillet 2027 et c'est le seul que Cursor et VS Code pratiquent sûrement |
| Adresses de retour | `https` sur tout hôte, et la boucle locale `http://localhost` ou `http://127.0.0.1` sur tout port. Les schémas d'application (`cursor://`, `vscode://`) sont refusés |
| Consentement | Le nom DÉCLARÉ par le client, marqué comme tel, l'hôte de retour en clair, et un avertissement. Claude et Claude Code gardent leur nom vérifié |
| Qui | Toutes les offres, Free compris ; seul un admin autorise, comme pour Claude. Les outils réservés à une personne s'ouvrent à ces clients comme à Claude |
| Essai réel | ChatGPT (fiche d'identité) et Lovable (mécanisme non documenté, l'essai le dira) |

## 1. Trois sortes de clients

| Sorte | `client_id` | Comment il est connu | Ce que montre le consentement |
| --- | --- | --- | --- |
| Épinglé | les deux adresses de `src/oauth/clients.ts` | recopié dans le code, inchangé | « Claude », « Claude Code », vérifié |
| Fiche d'identité | une adresse `https` qui n'est pas épinglée | sa fiche, récupérée à l'autorisation (section 2) | « ChatGPT, publié par chatgpt.com » : le domaine de l'adresse prouve l'éditeur |
| Enregistré | `mcl_` suivi de 32 caractères | `POST /oauth/register` (section 3), gardé en base | « Cursor (non vérifié) » : le nom est celui que le client a déclaré |

Une seule fonction résout un `client_id` en `{ nom, marque: 'epingle' | 'domaine' | 'declaree', adresses }`,
ou `null`. `/oauth/authorize` la lit ; l'échange du code et le renouvellement comparent le `client_id` à celui lié au
code ou à l'autorisation (aucune requête sortante), et refusent un client enregistré qui n'existe plus.

## 2. Les fiches d'identité, récupérées avec nos gardes

🔴 **Une requête sortante vers une adresse choisie par un tiers** : la garde existante des adresses saisies par un
client s'applique (`urlRecuperable`, `resolutionPublique`, `fetchPublic` en `redirect: 'error'`), plus : `https`
seulement, un chemin non vide, ni identifiants ni fragment ; corps lu en flux et borné à 10 Ko (`lireCorpsBorne`) ;
5 secondes au plus. La fiche est validée par Zod (`safeParse`) : `client_id` ÉGAL à l'adresse au caractère près,
`redirect_uris` non vide (10 au plus), chacune conforme à la politique de la section 4 ; `client_name` facultatif,
100 caractères au plus, sans caractère de contrôle. Le mode d'authentification déclaré est ignoré : tout client est
public, avec PKCE. Cache en mémoire par processus : 10 minutes pour une fiche valide, 1 minute pour un échec.

## 3. L'enregistrement dynamique

`POST /oauth/register`, anonyme, corps JSON (RFC 7591). Lit `redirect_uris` (requis, 1 à 10), `client_name`,
`token_endpoint_auth_method`, `grant_types`, `response_types`, `application_type` ; ignore le reste. Le serveur
REMPLACE ce qu'il ne fait pas (RFC 7591, § 2) au lieu de refuser le client entier : une adresse de retour hors politique
(section 4) ou de plus de 500 caractères est écartée, et seul un client sans adresse utilisable est refusé (Cursor
déclare aussi `cursor://`) ; un mode d'authentification avec secret devient `none` ; les `grant_types` deviennent les
nôtres, et seul un client qui n'a ni `authorization_code` ni `code` est refusé. Rend 201 avec un `client_id` aléatoire
`mcl_…`, sans secret, et ce qui est réellement enregistré. Les métadonnées du serveur annoncent `registration_endpoint`.
Plafonds : 10 enregistrements par minute et par adresse du client (`CF-Connecting-IP`), 300 par heure en tout. Le nom
déclaré n'est jamais invisible, ni celui de Claude. Un client enregistré qu'aucune autorisation vivante n'utilise est
purgé 30 jours après sa création.

## 4. Les adresses de retour d'un client non épinglé

`https://` sur tout hôte, ou `http://localhost` et `http://127.0.0.1` sur tout port ; ni identifiants, ni requête, ni
fragment, et l'adresse doit être identique à sa reconstruction (la règle actuelle). À l'autorisation : égalité exacte
avec une adresse déclarée, le port d'une boucle locale excepté (RFC 8252). Tout le reste, `cursor://` compris, est
refusé à l'enregistrement et à l'autorisation, sans redirection.

## 5. Le consentement et la console

La demande rendue à la page porte `client`, `marque`, `domaine` (fiche d'identité) et `hoteDeRetour`. La page :
- un client épinglé s'affiche comme aujourd'hui ;
- un autre s'affiche avec sa marque (« publié par chatgpt.com », « non vérifié ») et un avertissement : vérifiez que
  vous venez de lancer cette connexion depuis cette application, le nom est déclaré par elle ;
- la phrase sur Anthropic devient générale pour un autre client : les données seront lues par cette application et
  traitées par son éditeur.
Les « Applications autorisées » montrent le nom, sa marque et l'hôte de retour. Un espace créé par la connexion d'un
autre client porte l'origine `client_mcp` (une trace : l'origine ne décide plus du crédit offert).

## 6. Base de données (migration 0227, qui ajoute et relâche)

- `oauth_clients` : `client_id` (clé primaire, CHECK `mcl_` et 32 caractères), `nom`, `adresses_de_retour text[]`
  (1 à 10), `type_application`, `cree_le`. Aucune clé vers un espace : l'enregistrement est anonyme.
- `oauth_autorisations_client_chk` remplacé par un CHECK de FORME (une adresse `https`, ou `mcl_` et 32 caractères).
- `tenants_origine_chk` élargi à `client_mcp`.
L'ancien code survit aux trois : la migration passe AVANT le `up`.

## 7. Ce qui ne change pas

Les jetons, leurs durées et la révocation ; la relecture du rôle admin à chaque appel ; le plafond de l'API de l'espace
sur `/mcp` ; `mba.messagingme.app/mcp` reste à clé seulement.

## 8. L'essai réel qui clôt le lot

Julien connecte ChatGPT (connecteur personnalisé, mode développeur) à `https://api.messagingme.app/mcp` : la fiche
d'identité de ChatGPT est récupérée, la page affiche « publié par chatgpt.com », l'autorisation aboutit, et ChatGPT
liste les conversations de l'espace. Puis Lovable (connecteur personnalisé) : son mécanisme se lit dans le journal
(fiche ou enregistrement), et le même parcours aboutit. Un refus de Cloudflare sur un appel venu des serveurs de
Lovable est une cause possible d'échec, à mesurer.
