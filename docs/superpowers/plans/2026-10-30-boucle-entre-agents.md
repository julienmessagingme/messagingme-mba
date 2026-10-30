# Deux agents de Messaging Me qui se répondent en boucle (2026-10-30)

## Le cas

Le 30 octobre vers 20 h 28, Julien touche la bulle WhatsApp de l'espace « Messaging Me demo » (numéro en 0247) depuis
son téléphone, dont le WhatsApp est l'application WhatsApp Business reliée par QR code à l'espace « newCompany », qui a
son propre agent IA. L'agent de la démo répond, celui de newCompany répond à sa réponse, six fois de chaque côté en une
minute, jusqu'au « Stop » tapé sur le téléphone. Sans lui, la boucle courait jusqu'au plafond de tours de chaque session
(20 par défaut), chaque tour payé sur le crédit d'un client.

## La décision (Julien, 2026-10-30)

Reconnaître nos machines, sans débit maximal : un message qui vient d'un numéro servi par un autre espace, et que la
machine de cet espace vient d'écrire (dernier sortant de moins de 120 s, origine autre qu'une réponse d'équipe), ne reçoit
pas de réponse de notre agent. Il se tait comme pour un désabonné : ni modèle ni débit, session ouverte, message dans
l'Inbox. Un message tapé à la main depuis ce numéro a toujours sa réponse.

## Tâches

1. `src/agent/nos-machines.pg.ts` : `creerEcritParNosMachines(pool)`, la lecture entre espaces qui rend un booléen, et
   `ecritParUneMachine`, la règle pure.
2. `src/agent/run-turn.ts` : dépendance REQUISE `ecritParNosMachines`, lue au rang des plafonds, après le numéro bloqué ;
   résultat `nos_machines`. Câblée dans `src/worker.ts`.
3. Tests : `tests/agent-boucle-nos-machines.test.ts` rejoue la boucle avec le vrai `runTurn` des deux côtés (sans la
   garde : 20 réponses de chaque côté ; avec : 1 et 0) ; `tests/integration/nos-machines.integration.test.ts` tient la
   requête sur une vraie base.

Aucune migration. Ordre : push, CI lue job par job, déploiement de l'API et des workers (`migration=aucune`).

## Méthode de livraison

En direct, avec une relecture indépendante du diff avant le déploiement, parce que le changement tient en trois
fichiers de code, ne touche aucun schéma et se retire en un commit, mais qu'il se place sur le chemin de chaque tour
d'agent en production : une garde qui répondrait `true` à tort ferait taire tous les agents. Le test de la boucle se
vérifie dans les deux sens.

Essai réel qui clôt : le même geste que le 30, la bulle de la démo touchée depuis le téléphone de newCompany avec les deux
agents actifs ; la démo répond une fois, l'agent de newCompany se tait, et un second message tapé à la main reçoit encore
la réponse de la démo. Consigné dans `docs/prive/ESSAIS-REELS.md`.
