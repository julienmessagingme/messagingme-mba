# Plan : « Qualifier et transférer », et choisir son camp

Demande de Julien du 2026-10-20, après l'outil enchaîné (`2026-10-20-outil-enchaine.md`) : un outil qui pose des
questions, range chaque réponse dans un champ choisi dans une liste (avec un « + » pour la suivante), puis passe la
conversation en « À traiter ». « Si y a cet outil il ne peut pas y avoir la règle de base “passer la main à un humain”
ni une règle de stop genre transfert à un humain. Il faut choisir son camp. » Le même transfert devient une étape de
« Enchaîner des étapes ». Et « Enregistrer une information » doit citer le champ qu'il remplit.

Réponses du grill : refuser l'activation en disant quoi désactiver d'abord ; une carte à part ; la dernière phrase est
celle de l'agent ; une case « passe à un humain » sur chaque règle d'arrêt ; l'enchaînement qui finit par le transfert
est du même camp ; un champ par outil « Enregistrer une information », cité dans ce que l'agent lit ET dans le titre
proposé, pour l'agent IA comme pour l'agent de Meta.

## Méthode de livraison

**Implémenteur (moi) puis une relecture indépendante du diff, et Julien qui juge l'essai réel.** Raison : le chemin
d'exécution des outils de tous les agents, l'activation des outils (trois portes : console, MCP, assistant) et
l'écriture de la fiche sont touchés, avec des invariants invisibles (transfert terminal, case préservée quand un
écrivain remplace la liste, ce qui part chez Meta comparé en entier). Le bon comportement face à un vrai contact ne se
prouve pas par un test.

## Tâches

1. **L'étape « transférer »** dans `src/agent/enchainement.ts` : terminale, une seule entre elle et le scénario, en
   dernier ; paramètre `message` (la phrase de l'agent) ; mots dits au modèle.
2. **L'outil « Qualifier et transférer »** (`qualifier_transferer`) : cible = liste de questions (champ, question,
   valeurs), traduite en étapes « demander » puis « transférer », donc le même moteur (demander une seule fois).
   Catalogue, pose, production (`resolvers/mba.ts`, boucle d'étapes partagée), bac à sable.
3. **Choisir son camp** (`src/agent/camp.ts`, une seule classification) : camp « qualification » (l'outil, ou un
   enchaînement qui finit par le transfert), camp « direct » (« Passer la main à un humain », ou une règle d'arrêt
   cochée « passe à un humain »). Refus en 409 avec ce qu'il faut désactiver : à l'activation d'un outil
   (`PgToolCatalog.activer`, porte unique des trois appelants), au `PATCH` d'une cible d'outil actif, et à
   l'écriture des règles d'arrêt (`PgAgentStore.patch`, porte unique des trois écrivains de la fiche).
4. **La case « passe à un humain »** : `humain` sur une règle d'arrêt (schéma, lecture `sortiesDeLaFiche`, types
   serveur et console), préservée par code quand un écrivain remplace la liste sans la porter (`modifierAgent`) ;
   case dans l'onglet « Objectif et transferts ».
5. **Le champ cité** : agent IA, une ligne « Ce qu'il enregistre » dans les mots exposés ; agent de Meta, la
   description de la variable publiée ; titre proposé « Enregistrer : {libellé du champ} » dans les deux formulaires.
6. **La console** : carte « Qualifier et transférer » (affichée seulement si l'API la connaît), éditeur de questions
   (« + Ajouter une question », champ choisi dans la liste du mini-CRM, flèches), étape « Transférer en À traiter »
   dans l'éditeur d'étapes, libellés et badge de la ligne.
7. **Doc** : `features.md` et sa fiche d'aide (empreinte), `documentation.md`.

## Tests attendus

- `tests/agent-enchainement.test.ts` : étape transférer (ordre, paramètres, exécution, échec du transfert), outil de
  qualification (traduction en étapes, demander une fois, transfert même sans réponse), bac à sable aligné.
- `tests/agent-camp.test.ts` : classification et messages, dans les deux sens.
- `tests/agent-gestion*.test.ts` (ou voisin) : la case préservée par code, le refus du store traduit en 409.
- `tests/web-agent-outils.test.ts` : parité console/serveur (types d'étape, ordre, aller-retour de la qualification).
- `tests/mba-outils-maison.test.ts` : la variable publiée cite le champ.
- `web/e2e/agents-outils.spec.ts` : la carte, une question ajoutée par « + », le corps envoyé.

## Ordre de déploiement

Aucune migration (`binding` et `fiche` sont des jsonb sans contrainte). L'API d'abord ; la console peut partir avant
sans dégât (la carte n'apparaît que quand le catalogue contient `qualifier_transferer`, la case d'une règle est ignorée
par une API qui ne la connaît pas). ⚠️ La description de la variable d'un outil « champ » de l'agent de Meta change :
la prochaine publication de chaque espace qui en a un le republiera chez Meta (même outil, mots plus précis).

## Essai réel qui clôt la feature

Sur l'agent Pigier de la sandbox : désactiver « Passer la main à un humain », poser « Qualifier et transférer »
(prénom, nom, campus, formation). Vérifier que réactiver « Passer la main » est refusé avec le message. Depuis un
téléphone : (1) « je veux parler à quelqu'un » sans rien donner : UNE question, répondre, la fiche porte les quatre
champs, la conversation est en « À traiter » (la phrase de l'agent part en répondeur ou équipe fermée, sinon c'est
la branche « Transfert à un humain » du scénario qui parle : vérifier qu'elle dit quelque chose) ; (2) même début,
« non, juste un humain » :
transfert immédiat, sans deuxième question.
