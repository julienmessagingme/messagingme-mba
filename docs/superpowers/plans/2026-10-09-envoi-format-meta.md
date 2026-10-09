# Lot 13, domaine 2 : l'envoi au format de Meta

Spec : `docs/superpowers/specs/2026-10-08-api-complete-design.md` § 4 (décisions de Julien du 2026-10-09).

## Méthode de livraison

Implémenteur par lot, puis UNE relecture : la route ENVOIE des messages chez Meta au nom du client, chemin que la
production emprunte, avec des gardes à ne pas perdre (fenêtre, STOP, numéro délié ou suspendu, quota, prise du fil).
Aucune migration.
L'essai réel qui clôt le domaine : avec une clé de l'espace d'essai, envoyer depuis un terminal une image par URL, des
boutons de réponse et une liste à un téléphone qui a écrit dans les 24 h, toucher un bouton, et voir la réponse dans
l'Inbox et dans `message.received`.

## Tâches

1. **La validation** `src/api/message-meta.ts` : un schéma Zod strict par type courant (texte, image, vidéo, audio,
   document, lieu, réaction, interactif bouton, liste, lien), bornes de Meta annoncées, médias par `link` https
   seulement ; la désignation (`to`, ou `contactId`, ou `externalId`) ; l'aperçu écrit dans l'Inbox. Tests : chaque
   type accepté, chaque borne refusée, un champ inconnu refusé.
2. **L'envoi** : `MetaClient.sendMessage(to, corps)` (l'envoi générique existant, rendu public) et
   `repondreAvecUnMessage` dans `src/inbox/repondre.ts`, qui partage les gardes de `repondreDansLaFenetre` (un seul
   chemin de gardes). Tests : fenêtre fermée, STOP, prise du fil, trace dans l'Inbox.
3. **La route** `POST /v1/messages` (`src/http/v1-messages.ts`, droit `sends:create`, mêmes refus que
   `/v1/messages/whatsapp`, compté comme lui). Tests de route.
4. **Claude** : l'outil `send_message` (`mcp:write`, ouvert en Free comme `reply_in_open_window`).
5. **La doc** : la route dans la page Messages, l'exemple validé par `tests/api-exemples.test.ts`, les points d'entrée ;
   `features.md`, `documentation.md`.

## Ordre de déploiement

Aucune migration. La console (doc) ne dépend d'aucune route neuve pour fonctionner : push, CI lue, `up` de l'API et
des deux workers.
