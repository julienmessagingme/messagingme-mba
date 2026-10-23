# Les limites d'une conversation d'agent IA, réglées depuis Claude et la console (2026-10-23)

**But :** l'idée de Julien du 2026-10-22, cadrée le 2026-10-23 (`todo.md`, « Un plafond de crédit par conversation ») :
le client règle lui-même les trois limites qui arrêtent une conversation de son agent IA (crédit dépensé, nombre de
réponses, nombre d'actions), sans limite de crédit par défaut, et les deux autres limites montent au maximum.

**Décisions de Julien (2026-10-23) :** les trois limites dans le même outil ; le défaut des réponses et des actions
monte au maximum (20 et 60) pour tous les agents restés au défaut ; réglables depuis Claude ET dans la console.

## Tâches

**1. Migration 0250 : le défaut au maximum.** `max_tours` passe à 20 et `max_appels_outils` à 60 par défaut ; les
agents restés à l'ancien défaut (8, et 12, chaque colonne pour elle-même) suivent. Les CHECK (1 à 20, 0 à 60) ne
changent pas. L'ancien code y survit : elle passe AVANT le `up`.
- Test (`tests/migration-0250.test.ts`, sur le modèle de `tests/migration-0222.test.ts`) : les défauts, et que seuls
  les agents à 8 (ou 12) sont relevés.

**2. L'outil MCP `set_agent_limits`** (`src/mcp/outils-agent.ts`, catalogue `web/lib/partage/catalogue-mcp.ts` en
`mcp:write` avec une personne, famille de l'agent dans `scripts/plugin/familles-outils.ts`, phrase de
`web/lib/mcp-outils.ts`). Entrée : `agent_id`, et au moins un de `max_turns` (1 à 20), `max_tool_calls` (0 à 60),
`budget_eur` (0,01 à 100, ou `null` pour « sans limite », écrit 100 000 000 micro-euros). Il passe par `modifierAgent`
(mêmes bornes que la console, journal signé de la personne) et rend les trois limites. La description dit ce qu'une
limite atteinte fait (sortie « Plafond atteint », la conversation passe à l'équipe), les défauts, et qu'on ne la change
qu'à la demande de la personne.
- `get_agent` rend aussi `limites` (`max_turns`, `max_tool_calls`, `budget_eur`, `null` = sans limite), à côté de
  `agent` et pas dedans : la vue rendue par `create_agent` et `update_agent` ne change pas (la vitrine en montre une).
- Le refus d'`update_agent` sur une clé de plafond renvoie à `set_agent_limits`.
- Tests (`tests/mcp-agent.test.ts`) : les trois limites écrites par la porte de la console et rendues ; `budget_eur`
  à `null` écrit le maximum et se relit `null` ; hors bornes, aucun champ, ou un agent d'un autre espace : refus sans
  écriture ; les bornes annoncées dans le schéma sont celles de `saisieDeModification` (le test de parité existant) ;
  invisible derrière une clé d'API.

**3. La console : le crédit par conversation dans l'onglet Périmètre** (`web/app/agents/page.tsx`), à côté de
« Tours maximum » et « Appels d'outils maximum » : un montant en euros et une case « Sans limite », écrits par la route
existante (`budgetMicroEur`, aucune route neuve). Les aides des trois champs disent qu'ils se règlent aussi depuis
Claude.
- Test : e2e de l'onglet (cocher « Sans limite », saisir 0,50 €, le PATCH envoyé).

**4. Documentation** : `features.md` (les trois plafonds, leurs défauts, l'outil), la fiche
`docs/aide/fiches/construire-un-agent-ia.md` et son empreinte, `documentation.md` (la vue d'agent du MCP), le
catalogue généré (`web/public`), le plugin régénéré (`npm run plugin:generer`), version 0.3.7 ; `todo.md` : l'entrée
sort.

## Ordre de déploiement

La migration 0250 d'abord (build de `mba-api`, migration, relecture en base), puis `up` de `mba-api` (le MCP) ; le
worker n'a pas de code neuf. La console part au push : elle n'appelle aucune route neuve. Le plugin en dernier
(`gh workflow run plugin.yml --ref main`).

## Méthode de livraison

**Implémenteur (moi), puis une relecture indépendante du diff en fin de lot**, parce que la migration change les
limites que chaque tour d'agent lit en production et que l'outil écrit dans la fiche d'un agent actif, sans brouillon.

**L'essai réel qui clôt le lot :** depuis Claude, Julien demande un plafond de 0,50 € par conversation sur son agent,
puis le retire ; la console montre chaque fois la même valeur dans l'onglet Périmètre ; Claude relit en base que les
agents restés à 8 et 12 sont à 20 et 60.
