# Plan : les actions de l'agent IA (2026-10-13)

Spec : `docs/superpowers/specs/2026-10-13-actions-agent-design.md`. Carte du code : outils maison
(`src/agent/outils-maison.ts`, `resolvers/mba.ts`, `resolvers/simulation.ts`), webhooks sortants (`src/evenements/`,
sur le modèle de `besoin-reponse.ts`), automations (`web/lib/partage/automations.ts`, `src/automation/`), frise de la
conversation (`conversation_evenements`, `web/lib/partage/evenements-conversation.ts`).

## Méthode de livraison

**Implémenteur par livraison, une relecture par livraison, puis l'essai réel.** Le chemin est celui de production :
un tour d'agent sur une vraie conversation, un webhook vers l'application d'un client, une automation qui peut lancer
un scénario facturé. Le code porte des invariants invisibles : l'unicité par jour tenue par une contrainte, la
publication d'automation gouvernée par le chemin appelant (jamais depuis une dépendance partagée), le CHECK des types
de la frise reposé sous son nom. Les critères se testent, mais l'essai réel clôt : un vrai contact écrit « je veux
résilier » à un agent qui porte l'action, le webhook arrive à une adresse d'essai, la frise et l'automation le disent.

## Livraison 0 : la migration (seule, appliquée avant le code)

- Table `agent_actions` : id, tenant_id, tool_id (en cascade), agent_id, wa_id, conversation_id, `jour` (date dans le
  fuseau de l'espace), champs (jsonb), at ; unique (tool_id, wa_id, jour).
- Le CHECK de `conversation_evenements.type` reposé sous son nom avec `action_agent` (lire le nom en base d'abord).

## Livraison A : le moteur (API et worker)

1. L'outil `declencher_action` : entrée du catalogue, schéma de sa cible (nom, consigne, 1 à 10 champs typés, bornes),
   paramètres dérivés pour le modèle, plafond de 10 par agent à l'ajout.
2. Le handler de production : réservation du jour, webhook, frise, automation, réponse au modèle ; refus lisibles
   (date ou e-mail mal formés, action déjà déclenchée aujourd'hui). Le cas simulé du bac à sable.
3. Le type `agent.action` des webhooks sortants (décoché par défaut), son contrat OpenAPI, sa page de doc, son
   dictionnaire.
4. Le type `action_agent` de la frise et son libellé dans l'Inbox.
5. Le déclencheur d'automation `agent_action` (configuration `{ actionId }`), et la route qui liste les actions de
   l'espace pour le menu.
6. Câblage du worker (la dépendance du handler).

## Livraison B : la console

L'outil « Déclencher une action » dans la fiche de l'agent (nom, consigne, champs et leurs types), le menu
d'automation « Action déclenchée », la frise de l'Inbox. Poussée APRÈS le `up` de A (la route de la liste).

Laissés par la relecture de A, à traiter ici :
- La carte de l'action prévient quand aucune adresse de webhook n'est abonnée à `agent.action` (décoché par défaut) :
  l'agent dirait sinon « c'est enregistré » sans que rien ne parte vers l'application.
- Le menu d'automation dit que seul un scénario fait d'actions (tag, e-mail) laisse l'agent continuer : un scénario
  qui ouvre par un message est refusé hors fenêtre, un modèle coupe l'agent.
- Le modèle ne connaît pas la date du jour : sans elle, « demain » ou « fin du mois » donnent une date réelle mais
  fausse dans un champ date. La dire dans le contexte du tour (⚠️ `src/agent/prompt.ts` est en cours chez une autre
  session au 2026-10-13 : s'aligner avant d'y toucher).
- Retirer l'exception `PAS_ENCORE_A_L_ECRAN` de `tests/web-agent-outils.test.ts`.

## Livraison C : Claude Code

`set_agent_action` et `delete_agent_action` (personne requise, toutes offres), `get_conversation` qui rend les
actions, la skill et la FAQ (plugin 0.1.5), `features.md` et sa fiche d'aide.

## Tests attendus

- La cible : bornes, types, plafond de 10, paramètres dérivés (liste en énumération, aucun requis).
- Le handler : déclenché une fois par jour et par contact (le second rend « déjà déclenchée »), webhook avec un
  identifiant stable, frise, automation publiée par le seul handler de production, refus de format lisibles ; le
  tour CONTINUE (aucun drapeau d'arrêt).
- Les parités : types de webhooks (OpenAPI, dictionnaire, doc), types de la frise (migration), déclencheurs
  d'automation, catalogue des outils maison, MCP et skill.
- Intégration : la contrainte d'unicité du jour en base.

## Ordre de mise en ligne

0, appliquée et relue en base ; A, `up` de l'API et des workers ; B (la console, après A) ; C, puis le plugin 0.1.5.
