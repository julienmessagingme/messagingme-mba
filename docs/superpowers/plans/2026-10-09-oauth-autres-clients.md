# Lot 15 : OAuth ouvert aux autres clients MCP

Spec : `docs/superpowers/specs/2026-10-09-oauth-autres-clients-design.md` (décisions de Julien du 2026-10-09).

## Méthode de livraison

Implémenteur par lot, puis UNE relecture du diff par livraison : deux surfaces publiques anonymes neuves (enregistrement,
requête sortante vers une adresse choisie par un tiers) sur le chemin d'authentification de `/mcp`, et une migration.
Les tests d'intégration se vérifient dans les deux sens sur une Postgres jetable (accord de Julien à redemander).
L'essai réel qui clôt le lot : ChatGPT puis Lovable se connectent, autorisent et listent les conversations (spec § 8).

## Livraison A : l'API

1. **Migration 0227** : `oauth_clients`, le CHECK de forme de `oauth_autorisations.client_id`, `client_mcp` dans
   `tenants_origine_chk`. Tests : les CHECK refusent vraiment (intégration).
2. **La politique des adresses de retour** (`src/oauth/clients.ts`) : `https` ou boucle locale, reconstruction exacte,
   port de boucle locale libre. Tests unitaires, dont `cursor://`, identifiants, requête, fragment, `http` distant.
3. **Les fiches d'identité** (`src/oauth/fiche-client.ts`) : récupération gardée (`fetchPublic`, 10 Ko, 5 s), validation
   Zod, cache 10 min et 1 min. Tests : `client_id` différent de l'adresse, adresse interne, corps trop gros, redirection,
   adresse de retour hors politique, cache.
4. **L'enregistrement** (`POST /oauth/register`, store `PgOauthClientsStore`) et `registration_endpoint` annoncé ;
   plafond par adresse ; purge à 30 jours dans le balayage de rétention. Tests : corps valides et refusés, plafond,
   purge qui épargne un client utilisé (intégration).
5. **La résolution d'un client** dans `/oauth/authorize`, l'échange et le renouvellement ; `consentement/demande` rend
   `verification` et `domaine` ; l'origine `client_mcp`. Tests : chaque sorte de client de bout en bout, un client
   enregistré purgé refusé au renouvellement, aucune requête sortante hors de l'autorisation.
6. **Les dépendants** : l'auto-attaque (registre de routes), la liste des applications autorisées côté API, l'audit.

## Livraison B : la console et la doc

7. **La page « Autoriser »** : la marque du client, l'avertissement, la phrase générale sur l'éditeur ; tolère une API
   sans `verification` (déploiement). e2e.
8. **Applications autorisées** : nom, marque, hôte de retour.
9. **La doc** : page MCP (connecter ChatGPT, Cursor, VS Code, Lovable), `features.md`, `documentation.md`.

## Ordre de déploiement

0227 AVANT le `up` de l'API (elle relâche, l'ancien code y survit). La console après l'API : la page lit des champs
neufs, et doit tolérer leur absence.
