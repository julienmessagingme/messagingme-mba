# Lot 13, domaine 1 : la lecture des fils

Spec : `docs/superpowers/specs/2026-10-08-api-complete-design.md` § 3 (décisions de Julien du 2026-10-08).

## Méthode de livraison

Implémenteur par lot, puis UNE relecture par livraison. La livraison A ne fait que LIRE (un magasin neuf, aucune
écriture), la livraison B écrit sur le chemin des accusés de Meta, que la production emprunte des milliers de fois par
campagne : elle porte un invariant invisible (un statut ne recule pas) et passe donc par la relecture du diff.
L'essai réel qui clôt le domaine : avec une clé neuve portant `conversations:read`, lister les fils de l'espace d'essai,
lire les messages d'un fil en remontant deux pages, télécharger une image reçue, et lire le statut `read` d'un message
envoyé par `POST /v1/messages/whatsapp`.

## Livraison A : lire (aucune migration)

1. **Le droit** `conversations:read` dans `VALID_API_SCOPES` et son miroir console (`web/lib/api/integrations.ts`, écran
   des clés, page de référence), sans reprise des clés existantes. La clé créée par `/demarrer` le porte.
2. **Le magasin** `src/api/conversations-v1.pg.ts` : liste paginée, un fil, les messages paginés, un message par son
   identifiant public, le média ; chaque requête filtrée sur l'espace. Tests d'intégration (curseurs, isolation).
3. **Les routes** `src/http/v1-conversations.ts` (droit `conversations:read`, opération `conversations.read` hors quota),
   montées dans l'entrée `v1` du registre. Tests : forme, pagination, 404 d'un autre espace, 410 du média expiré.
4. **Claude** : `list_conversations`, `get_conversation`, `get_messages` passent en `fonction: null` ; `get_messages`
   prend `before` et rend `before` pour la page suivante.
5. **La doc** : page `/developers/api/conversations`, `api-doc-endpoints.ts`, l'e2e de la doc ; `features.md`,
   `documentation.md`.

## Livraison B : le statut d'un message (migration 0225)

1. `conversation_messages.statut` et `statut_le`, CHECK à quatre valeurs, nullables.
2. L'écriture dans le traitement des accusés, monotone (rang `sent` < `delivered` < `read`, `failed` toujours), gardée
   par l'identifiant de Meta (index unique existant).
3. `GET /v1/messages/{messageId}` et l'outil `get_message_status` ; le statut dans la liste des messages.

## Ordre de déploiement

A : aucune migration, mais DEUX pushs (relecture : 🔴 de la fenêtre Vercel). La page « Démarrer » crée sa clé avec
`conversations:read`, que l'API d'avant refuse en 400 : elle part dans un SECOND push, après le `up` de l'API. Le
premier push porte tout le reste ; l'écran des clés y propose déjà la case, refusée en 400 si on la coche avant le
`up` (fenêtre de quelques minutes, sans effet sur les clés existantes).
B : 0225 AVANT le `up` de l'API et des deux workers (le worker des accusés écrit la colonne).
