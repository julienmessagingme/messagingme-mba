# Les outils MCP de l'agent IA et du crédit : plan (lot 8a)

**Spec** : `docs/superpowers/specs/2026-10-03-mcp-agent-ia-design.md` (12caa9c0). Elle fait foi ; ce plan dit l'ordre,
les fichiers, les interfaces et les tests attendus.

## Méthode de livraison

**Implémenteur par lot, puis UNE relecture indépendante du diff, en deux livraisons** : A (le socle, tâches 1 à 4) et
B (la surface MCP, tâches 5 à 8). Cette méthode parce que la production emprunte ces chemins (création d'agent qui
ouvre une clé Vercel, débit du crédit, paiement Stripe) et que la livraison A déplace de la logique hors des routes de
la console : un écart y casserait la console sans bruit, ce qu'un œil voit mieux qu'un test écrit par l'auteur. Pas de
workflow de relecture. L'essai réel qui clôt le lot : depuis Claude Code, sur un espace qui a au moins 1 € de crédit,
créer un agent, importer le site par `preview_site` puis `import_site`, le tester, l'activer, le retrouver identique
dans la console (fiche, connaissance et sa provenance, outils activés au nom de la personne, historique de la fiche),
puis vérifier qu'une clé d'API ne voit aucun outil d'écriture de l'agent.

## Contraintes globales

- Un outil MCP n'a aucune logique métier : il appelle la fonction que la route de la console appelle. Une issue
  (`Issue<T>`, le type de `src/widgets/gestion.ts`, partagé sans recopie) devient un statut HTTP dans la route et un
  `RefusOutil` dans l'outil, avec la même phrase.
- Les routes de la console gardent EXACTEMENT leurs réponses, sauf les deux changements voulus de la spec (section 3).
- Chaque borne appliquée est annoncée dans le schéma de l'outil, lue dans le Zod de la console, jamais recopiée.
- Filtrage `tenant_id` sur chaque requête ; entrées en `safeParse` ; aucun secret ni URL signée dans un journal.
- Pas de tiret cadratin ni demi-cadratin. Fichiers de câblage partagés (`src/index.ts`, `src/server.ts`) : annonce aux
  sessions voisines, commit en plomberie sur origin.
- Migration : numéro pris dans `db/migrations/` d'origin au moment de l'écrire (0206 réservée le 2026-10-03).

## Livraison A : le socle

### Tâche 1. La migration

- Élargir `reglages_historique_origine_chk` (0146) à `('assistant', 'formulaire', 'mcp')`, sous le même nom.
- Additive : appliquée AVANT le `up`, après lecture de `pg_stat_activity`, relue en base (le CHECK sous son nom, sa
  définition exacte). Ligne du compteur de `CLAUDE.md` dans le commit qui prend le numéro.

### Tâche 2. L'agent : `src/agent/gestion.ts`

- `creerAgent(deps, espace, saisie)` : le corps de `POST /agents` (libellé, modèle imposé, clé Gateway par
  `assurerCleGateway`, crédit insuffisant en refus lisible), rend `Issue<Agent>`.
- `modifierAgent(deps, espace, agentId, patch, auteur: { userId: string | null; origine: 'formulaire' | 'mcp' })` : le
  corps de `PATCH /agents/:id` (bornes de `fichePatchSchema` et `BORNES_FICHE`, verrou `ficheVersionAttendue`, liste
  fermée des modèles), PLUS les deux changements : `manquesAvantActivation` relancé sur l'état EFFECTIF quand l'agent
  reste ou devient actif, et une ligne `fiche_agent` dans l'historique des réglages (avant et après, auteur, origine).
- `changerStatut(deps, espace, agentId, statut, auteur)` : activation avec contrôle de complétude, désactivation.
- `src/http/agents.ts` appelle ces fonctions et traduit l'issue. Tests HTTP existants verts sans changement, plus :
  vider l'objectif d'un agent actif est refusé avec la liste des manques (route ET fonction) ; un patch écrit une
  ligne `fiche_agent` d'origine `formulaire` avec l'auteur.

### Tâche 3. La connaissance et l'essai : `src/agent/connaissance.ts` et `src/agent/essai.ts`

- `ajouterFiches`, `supprimerFiches`, `apercuSite`, `importerSite`, `importerDocument` (le chemin du fichier en
  `dataUrl`, inchangé pour la console) et `importerTexteDocument(deps, espace, agentId, { nom, texte })` (même
  découpage `texteEnFichesHorsBoucle`, même `remplacerSource` en type document, même provenance) : le corps des routes
  de `src/http/agent-knowledge.ts`, gardes d'adresse (`urlRecuperable`, `resolutionPublique`, `fetchPublic`) comprises.
- `essayerAgent(deps, espace, agentId, messages)` : le corps de `POST /agents/:id/test` (solde, débit au prix client,
  archivage de l'essai, trace).
- Routes appelant ces fonctions, tests existants verts. Test neuf : `importerTexteDocument` produit les mêmes fiches
  et la même provenance que `importerDocument` pour le même texte.

### Tâche 4. Le paiement et les réglages : `src/stripe/paiement.ts`, `src/agent/reglages.ts`

- `ouvrirPaiement(deps, espace, offre, payeur)` : le corps de `POST /credit/paiement` (offres fermées, prix relu chez
  Stripe, payeur autorisé par `creerPayeurAutorise`), rend `Issue<{ url: string; montantTtc: string }>`.
- `ajouterOutilsSurs(deps, espace, agentId, codes, personne)` : ajout et activation, signés, limités aux quatre codes
  de la spec (`terminer`, `chercher_connaissance`, `lire_contact`, `escalader`), par le catalogue existant.
- `reglerModeTransfert(deps, espace, mode)` : le corps de la route des réglages (`always`, `business_hours`, `never`).
- Routes appelant ces fonctions, tests existants verts.

**Déploiement A** : CI verte lue job par job ; `compose build mba-api` ; `migrate` et relecture en base ; `up -d
--build` de `mba-api` et des deux workers (ils importent les modules de l'agent) ; rechargement NPM après `mba-api`
sain ; contrôle public ; dans la console, une modification de fiche d'agent écrit bien sa ligne d'historique.

## Livraison B : la surface MCP

### Tâche 5. Le drapeau « personne requise » et le plafond coûteux

- `OutilMcp.exigePersonne?: true` ; `outilsPourScopes` devient `outilsPour(ctx)` et écarte ces outils quand
  `ctx.personne` est nul, pour `tools/list` comme pour `tools/call` (même refus qu'un outil inconnu).
- `DepsMcp` reçoit le `PlafondPartage` des opérations coûteuses de la console (même instance, même clé par espace),
  consommé par `test_agent`, `add_knowledge`, `preview_site`, `import_site`, `import_document_text` et `buy_credit`.
- Tests : une clé `mcp:write` ne liste ni n'appelle aucun outil `exigePersonne` ; un jeton OAuth les voit ; le
  plafond refuse au-delà de sa borne, en `isError` lisible.

### Tâche 6. Les seize outils : `src/mcp/outils-agent.ts`

- Les outils de la spec, section 1, chacun sur la fonction de la livraison A, avec ses annotations (table de la spec),
  ses bornes lues dans le Zod, et sa description (les quatre messages de la spec : pas de réponse aux clients sans
  scénario tant que le répondeur n'existe pas, crédit pour le premier agent, débit de `test_agent`, site par
  `preview_site` puis `import_site`).
- `OUTILS` = outils existants + `OUTILS_AGENT` ; `DepsMcp` câblé dans `src/index.ts` avec les MÊMES objets que la
  console.
- Tests (`tests/mcp-agent.test.ts`) : chaque outil appelle la fonction partagée avec l'espace de la clé ou du jeton,
  jamais d'un argument ; refus métier en `isError` avec la phrase de la console ; `set_agent_tools` refuse tout code
  hors des quatre ; la personne signe l'activation et le journal (origine `mcp`).

### Tâche 7. Les tests du catalogue

- `tests/mcp-serveur.test.ts` : la table des annotations des écritures complétée ; `preview_site` nommé comme seule
  lecture en monde ouvert.
- L'extracteur de bornes Zod sort de `tests/mcp-widgets.test.ts` vers `tests/aide/bornes-zod.ts`, et vérifie les
  outils de l'agent contre `fichePatchSchema`, le corps du bac à sable et les offres.
- `scripts/auto-attaque.mts` : `/mcp` inchangé en surface ; une sonde par clé `mcp:write` qui tente un outil
  `exigePersonne` (refusé).

### Tâche 8. La documentation

- `web/lib/mcp-outils.ts` : les seize outils avec leur droit (tenu par `tests/mcp-doc-parite.test.ts`), et la
  mention « connexion OAuth requise » pour les écritures de l'agent.
- `documentation.md` (domaine MCP), `features.md` (ce que Claude sait faire de l'agent ; `tests/aide-proposer.test.ts`
  et les fiches citées), `wip.md`.

**Déploiement B** : CI verte ; `up -d --build` de `mba-api` ; contrôle public ; puis la console (texte seulement) ; puis
l'essai réel de la section « Méthode de livraison ».

## Rayon de souffle à vérifier par la relecture

- Les routes de l'agent, de la connaissance, du bac à sable et du paiement : réponses identiques pour la console
  (codes, corps, plafonds), sauf les deux changements voulus.
- Le contrôle de complétude sur modification : qui modifie un agent actif aujourd'hui (l'assistant de construction
  applique ses propositions par les mêmes routes) et pourrait désormais être refusé.
- `outilsPourScopes` a d'autres appelants (`serveur.ts`) : la clé d'API garde exactement ses outils d'avant.
- Le journal des réglages : son lecteur dans la console doit afficher l'origine `mcp`.
