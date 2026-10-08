# Les paramètres d'un outil de connecteur suivent sa requête (2026-10-08)

Constat (Groupama PJ, 2026-10-08) : la variable `age_mois` de la requête « tarif » est renommée `age` à 9 h 43 UTC dans
Tools > Connecteurs API. L'agent IA qui s'en sert (`obtenir_tarif`) continue de voir `age_mois`, le remplit, et le
résolveur, qui lit la requête COURANTE, refuse chaque appel (« information manquante »), sans rien à l'écran. Déjà au
backlog depuis la relecture de `099fd6c1` (2026-10-05, `todo.md`, « Connecteurs : les paramètres d'un outil ne suivent
pas les variables de sa requête »).

## La cause

À la création d'un outil de connecteur, la route recopie les variables `modele` de la requête dans
`agent_tools.params` (deux fois la même dérivation : `src/http/agent-tools.ts` et `src/http/mba-outils.ts`). Le
schéma envoyé au modèle (`outilExpose`) et la validation des arguments (`executeTool`, étape 3) lisent cette copie ;
le résolveur (`creerAppelConnecteur`, étape 4) lit la requête. Rien ne rafraîchit la copie : un renommage, une
variable ajoutée, une obligation, une liste de valeurs ou une description changées divergent jusqu'à ce qu'on
supprime et recrée l'outil. L'agent de Meta n'a pas le défaut : sa publication et son relais lisent la requête.

## Mesures (2026-10-08, production en lecture seule, base à 0220)

- Sonde SQL (`begin read only` sur un client dédié, aucun SET) : **3 outils de connecteur sur 3 divergent de leur
  requête**. Groupama PJ : `obtenir_tarif` (agent IA, actif) et `demande_un_devis` (agent de Meta) voient
  `[espece, race, age_mois]` au lieu de `[espece, race, age]`. Messaging Me Tech SANDBOX : `add_tag` (agent de Meta)
  voit `[user]`, la requête n'a plus aucune variable « décidée par l'agent ».
- Le VRAI code du catalogue (`PgToolCatalog.listToutesConsommateur`, puis `outilExpose`) sur Groupama PJ :
  `obtenir_tarif` expose et exige `espece, race, age_mois`.

## La parade retenue : dériver, ne plus recopier

Les paramètres d'un connecteur se lisent sur sa requête à CHAQUE lecture de l'outil, par le catalogue :
`PgToolCatalog` sélectionne les variables de la requête avec l'outil (sous-requête filtrée sur l'espace de l'outil,
dans la projection unique `COLONNES`), et `versOutil` en dérive les paramètres par une fonction unique
`paramsDuConnecteur` (`src/agent/requetes.ts`), après la même relecture que le résolveur (`lireVariables`, déplacée
de `requetes.pg.ts` vers `requetes.ts`). L'exposition, la validation et le résolveur lisent ainsi la même liste.
La création n'écrit plus de copie (colonne à son défaut `[]`), et les deux dérivations des routes disparaissent.

Pourquoi pas les deux autres pistes :
- **Resynchroniser `agent_tools.params` dans la transaction du PATCH** (la piste du `todo.md`) garde une copie :
  chaque écrivain futur des variables devra y penser, les 3 outils déjà faux demandent une reprise, et la création
  lit la requête avant sa transaction (la fenêtre que `todo.md` décrit déjà pour le risque). Le risque, lui, se
  recopie parce que le client peut le MONTER outil par outil ; les paramètres d'un connecteur n'ont aucun réglage
  par outil (le PATCH d'un outil refuse toute énumération hors catalogue maison), donc la copie ne porte rien que la
  requête n'ait déjà.
- **Refuser ou prévenir (« N outils à recréer »)** ferait recréer à la main, consentement compris, ce que le serveur
  sait faire seul.

C'est aussi la conception d'origine (0105 : « l'outil d'un agent DÉSIGNE une requête au lieu de la redécrire ») et la
règle du dépôt pour toute valeur dérivée (`paramsInitiaux`, `avecValeursDuChamp` : « une copie divergerait »).

Ce qui ne bouge pas : un outil maison et un outil MCP gardent `agent_tools.params` (énumérations réglables, sources
`contact`/`champ`/`fixe` d'un paramètre MCP, `reporterClouage`) ; les champs lus (`output_paths`) restent PROPRES à
chaque outil, délibérément ; le risque suit déjà la méthode (`PgRequeteStore.patch`).

## Méthode de livraison

**En direct, sans agent d'implémentation, un seul lot clos par UNE relecture indépendante.** Raison : le chemin est
celui de chaque tour d'agent (lecture du catalogue), mais le changement tient en six fichiers de code sans migration,
se défait par un redéploiement, et ses critères se vérifient mécaniquement ; la relecture porte sur les invariants
invisibles, nommés pour elle : la garde anti-IDOR (seules les variables `modele` sont exposées), la parité exposition
/ validation / résolveur (une seule relecture des variables), la projection unique `COLONNES` lue par tous les
chemins, et l'isolation de la sous-requête (`r.tenant_id = t.tenant_id`). Rayon de souffle à relire : tout lecteur
d'`OutilDefini.params` (exposition, exécuteur, bac à sable, relais, publication, onglets), et les créations qui
passaient une copie.

**Essai réel qui clôt** : après le déploiement, la même sonde en lecture seule rend `age` pour `obtenir_tarif` sur
Groupama PJ ; puis, sur un espace de test, renommer une variable « décidée par l'agent » d'une requête utilisée par un
outil d'agent IA, et voir l'agent appeler l'outil au bac à sable avec le nouveau nom, sans supprimer ni recréer
l'outil.

## Le lot

- `src/agent/requetes.ts` : `lireVariables` (déplacée, inchangée) et `paramsDuConnecteur(variables)`.
- `src/agent/requetes.pg.ts` : importe `lireVariables`.
- `src/agent/catalog.pg.ts` : `requete_variables` dans `COLONNES`, `versOutil` dérive pour `origin = 'http'` ;
  `creerOutilConnecteur`, `ajouterConnecteur`, `ajouterConnecteurPourMba` n'acceptent plus de `params`.
- `src/http/agent-tools.ts`, `src/http/mba-outils.ts` : plus de copie ni de `params` dans leurs dépendances.
- `src/http/agent-requetes.ts` : le commentaire du PATCH dit que les variables ne sont pas copiées.
- `src/agent/catalog.ts` : la doc d'`OutilDefini.params`.

Tests attendus :
- Unitaire (`tests/agent-connecteur-params.test.ts`) : la garde anti-IDOR conservée des deux tests de route qu'elle
  remplace (une variable `modele` requise, un champ du mini-CRM, une valeur système, une ancienne forme `contact:*`),
  la fidélité de la dérivation (type, description, obligation, valeurs permises), et le chemin entier d'un appel après
  renommage (`executeTool` et le vrai `creerResolveurHttp`, réseau simulé), dans les deux sens : la copie d'avant le
  renommage est refusée, la dérivation de la requête courante part avec `age`.
- Intégration (`tests/integration/connecteur-suit-sa-requete.integration.test.ts`, vrais magasins) : renommer, ajouter
  une variable requise, changer valeurs permises et description sur la requête, puis relire l'outil (`listToutes`,
  `byName`, `listActifs`) et l'appeler par `executeTool` avec le vrai résolveur ; un outil MCP et un outil maison
  gardent leur colonne ; un outil qui désigne la requête d'un autre espace n'en reçoit rien.
- Routes : les deux tests « le modèle ne voit que les variables qu'il doit remplir » deviennent « la route ne recopie
  plus rien », leur cas étant porté par le test unitaire ci-dessus.
- Vérification dans les deux sens : par mutation pour l'unitaire ; pour l'intégration, sur Postgres jetable si Julien
  l'accorde, sinon par la sonde en lecture seule de l'ancien et du nouveau code sur les vraies données, puis la CI.

Ordre de déploiement : sans migration. API et workers ensemble (le catalogue est lu par les deux). La console n'a pas
de changement. ⚠️ Retour arrière : une image antérieure exposerait SANS paramètre les outils de connecteur créés
depuis (colonne vide) ; il faudrait les recréer.

Doc : `features.md` (section des connecteurs API, citée par aucune fiche d'aide), `documentation.md` (l'invariant,
§ 4.4), `docs/JOURNAL-TECHNIQUE.md` (le récit), `todo.md` (l'entrée du 2026-10-05, dont les autres points restent).
