# Les outils MCP proposés aux agents, et un écran Connecteurs MCP qui se lit

Demandé par Julien le 2026-10-02 pendant l'essai réel des outils MCP de l'agent de Meta : « c'est pas clair, il faut
qu'on voie ici la liste des outils qui ont été importés et éventuellement qu'on les sélectionne ici ». La spec du
2026-09-16 (`docs/superpowers/specs/2026-09-16-connecteurs-mcp-design.md`) importait tout le catalogue et laissait
chaque agent choisir ; elle reste vraie, avec un étage de plus.

## Décisions (Julien, 2026-10-02, par questions fermées)

- **Deux étages** : sur Tools > Connecteurs MCP, on choisit quels outils du serveur sont PROPOSÉS aux agents ; sur
  chaque agent (AI Agent > MBA > Outils, fiche d'un agent IA), on choisit parmi cette liste.
- **Un outil importé est proposé d'office** ; on décoche ce qu'on ne veut pas.
- **Décocher un outil qu'un agent utilise est refusé**, et l'écran nomme les agents : rien ne bouge en silence, et
  l'agent de Meta n'appelle jamais un outil retiré de sa liste sans republication.

## Méthode de livraison

**Implémenteur par lot (la session) puis UNE relecture indépendante du diff**, parce que le lot touche un chemin
que la production emprunte (le rattachement d'un outil à un agent, point de passage unique des consentements) et
pose une migration. Les critères de l'écran se testent en e2e, mais un seul essai réel clôt le lot : Julien importe
Microsoft Learn sur son espace, décoche un outil, constate qu'il disparaît de l'onglet Outils de l'agent de Meta,
et donne `microsoft_docs_search` à l'agent.

## Tâches

1. **Migration 0199** : `agent_tools.mcp_propose boolean not null default true`. Elle AJOUTE une colonne avec un
   défaut constant (instantané) que l'ancien code ignore : avant le déploiement.
2. **Catalogue** : `OutilBibliotheque.mcpPropose` (requis) ; `rattacherConsommateur` refuse un outil MCP non
   proposé (le point de passage des deux consommateurs, agent IA et agent de Meta).
3. **Magasin MCP** : `outilsPourEcran` rend `propose` et `utilisePar` (les noms des agents qui l'ont) ;
   `proposer(tenant, outil, propose)` dans une transaction qui verrouille l'outil, et refuse de décocher un outil
   rattaché à un agent en rendant leurs noms.
4. **Route** `PUT /tenants/:tenantId/mcp/outils/:outilId/propose` : 200, 404, ou 409 avec les noms.
5. **Agent de Meta** : `outilsMcpProposables` ne liste que les outils proposés ; la route `POST …/mba-outils/mcp/:id`
   refuse un outil non proposé en 409 lisible. **Agent IA** : la section « Vos serveurs MCP » ne propose que les
   outils proposés.
6. **Écran Connecteurs MCP** : la liste des outils toujours visible (plus de bouton « Les outils importés ») ; un
   bouton « Importer ses outils » tant que rien n'est importé, « Rafraîchir depuis le serveur » ensuite, et
   « Importer ces N outils » dans l'aperçu d'un premier import ; chaque outil porte « Proposé aux agents » et
   « Donné à : … ».

## Tests attendus

Intégration : défaut à vrai à l'import ; décocher refusé quand un agent a l'outil, accepté sinon ; rattachement
refusé sur un outil non proposé. Unitaires : liste de l'agent de Meta filtrée, route MBA en 409, route `propose`.
E2E : liste visible sans clic, case qui part en `PUT`, refus affiché avec les noms, libellés d'import.

## Ordre de déploiement

Migration 0199 appliquée et relue en base AVANT le `up`, puis `up -d --build`, contrôle public. La console part
sur Vercel au `git push` : elle tolère l'API d'avant (champ absent = proposé, route absente = message d'erreur).
