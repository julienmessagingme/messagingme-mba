# « Tester le scénario » ne marque plus la conversation comme test

Décision de Julien du 2026-10-03, après l'essai réel des envois de bloc : « ne mets plus jamais un flag test sur ma
conversation ». Choix entre trois options (ne plus écarter l'agent, ne plus marquer du tout, exempter son numéro) :
**ne plus marquer du tout**, en production **avant la démo du 7**.

## Le problème

Le jeton de test marquait la conversation `is_test`, en sens unique. Deux effets, pour toujours : la conversation
sortait des statistiques et de l'analyse, et l'agent de Meta ne la reprenait plus jamais tout seul (règle 5 de
`src/inbox/fil.ts`). Mesuré le 3 : Julien répond en texte libre à un modèle d'un scénario lancé par le lien de
test, le parcours s'arrête, et le journal du worker dit « remise à l'agent de Meta ignorée : conversation de
TEST », puis « agent_event non envoyé ». Sa conversation avec le numéro de démonstration restait donc muette côté
agent, même hors de tout test.

## Ce qui change

- `processTestTokens` (`src/webhooks/test-token.ts`) ne marque plus ; `TestTokenDeps` perd `markConversationTest`,
  le câblage (`src/worker.ts`) perd sa ligne, `PgInboxStore.markConversationTest` disparaît (plus aucun appelant).
- Rien d'autre ne bouge : les lecteurs de `is_test` (statistiques, analyse, règle 5) restent, pour les
  conversations marquées AVANT. Aucune migration, aucune reprise de données (la conversation de Julien a été
  démarquée à la main le 3, sur son accord).
- Un test garde la règle : aucun fichier de `src/` n'écrit `is_test = true`.

## Méthode de livraison

**En direct, puis une relecture**, parce que le changement est petit (une ligne de câblage, une dépendance, une
méthode morte) et réversible, mais touche la remise à l'agent de Meta, que la production emprunte. Déploiement des
deux workers (le jeton de test est traité par le worker), l'API n'en a pas besoin.

**Essai réel qui clôt le lot** : Julien lance un scénario par « Tester le scénario », répond en texte libre au
modèle (sortie « Toute autre réponse » non reliée) ; l'agent de Meta doit répondre à son message. Je vérifie en
base que la conversation n'est pas marquée et que l'`agent_event` est parti.
