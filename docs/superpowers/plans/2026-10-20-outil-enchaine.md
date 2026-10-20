# Plan : l'outil enchaîné d'un agent IA (« Enchaîner des étapes »)

Demande de Julien du 2026-10-20, sur l'agent Pigier de la sandbox : « un nouveau type d'outil qui permette de faire
plusieurs actions, demander une information (ou plusieurs) puis passer un scénario ; tu choisis un premier outil, puis
avec un + un autre, etc. », et « me laisser l'ordre ». Cas d'origine : qualifier un candidat (prénom, nom, campus,
formation) puis lancer le scénario qui le passe à l'équipe, même s'il n'a rien donné et veut un humain tout de suite.

## Méthode de livraison

**Implémenteur (moi) puis une relecture indépendante du diff, et Julien qui juge l'essai réel.** Raison : le chemin
d'exécution des outils de TOUS les agents en production est touché (`executor.ts`, la garde d'isolation SQL de
`catalog.pg.ts`, le risque et l'autonomie), avec des invariants invisibles (scénario terminal, reprise qui rejoue les
étapes, garde d'isolation multi-scénarios). Ce n'est ni isolé ni trivial, et le bon comportement de l'agent face à un
vrai contact ne se prouve pas par un test.

## Tâches

1. **Le module** `src/agent/enchainement.ts` : schéma des étapes (six types), règles d'ordre (`fauteDOrdre`),
   paramètres dérivés (`paramsDeLEnchainement`), décision pure (`planEnchainement`), risque, scénarios visés.
2. **Le catalogue** (`outils-maison.ts`) : handler `enchainer`, cible ajoutée à `cibleOutilAgentSchema`, paramètres et
   mots exposés au modèle. **La pose** (`reglages.ts`) : message de refus, risque calculé (`risqueDeLOutil`).
3. **L'exécution** : handler de production (`resolvers/mba.ts`, étapes dans l'ordre, échecs non bloquants, scénario
   terminal), bac à sable (`resolvers/simulation.ts`, même décision), délai dépassé terminal (`executor.ts`).
4. **L'écriture** (`catalog.pg.ts`) : garde d'isolation sur un tableau de scénarios, risque réécrit au `PATCH`.
5. **La console** : carte dans « Quel outil ajouter ? » (affichée seulement si l'API la connaît), éditeur d'étapes
   (`CibleEnchainement.tsx`, « + Ajouter une étape », flèches), règles d'ordre dites avant l'envoi, autonomie selon
   les étapes, libellé de la ligne.
6. **Doc** : `features.md` (section Agent IA) et sa fiche d'aide (empreinte), `documentation.md`.

## Tests attendus

- `tests/agent-enchainement.test.ts` : règles d'ordre, paramètres, décision, ordre d'exécution réel, refus puis
  transfert, échec d'écriture non bloquant, scénario de l'agent refusé avant toute étape, bac à sable aligné.
- `tests/web-agent-outils.test.ts` : parité console/serveur (types, bornes, règles d'ordre, aller-retour).
- `tests/agent-tool-executor.test.ts` : délai dépassé sur un enchaînement qui finit par un scénario.
- `web/e2e/agents-outils.spec.ts` : la carte, un ordre refusé puis corrigé, le corps envoyé, l'autonomie.

## Ordre de déploiement

Aucune migration (le `binding` n'a pas de contrainte, `risk` garde ses valeurs). L'API d'abord (`up -d --build` de
`mba-api` et `mba-worker`) ; la console peut partir avant sans dégât, puisque sa carte n'apparaît que quand le
catalogue de l'API contient `enchainer`.

## Essai réel qui clôt la feature

Sur l'agent Pigier de la sandbox : remplacer les cinq outils « Enregistrer » et le « Transfert à un conseiller » par
un seul outil enchaîné (prénom, nom, campus, formation, puis « pigier transfert collab »), autonomie cochée. Depuis un
téléphone : (1) « je veux parler à quelqu'un » sans rien donner, l'agent pose UNE question ; répondre ; la fiche du
contact porte les quatre champs et la conversation arrive en « À traiter » ; (2) même début, répondre « non, juste un
humain » : transfert immédiat, sans deuxième question.
