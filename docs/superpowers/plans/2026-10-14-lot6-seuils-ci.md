# Lot 6 du bilan des audits, livraison B2 : les seuils bloquants de la CI

Le bilan relevait « aucun seuil bloquant écrit, ni procédure d'exception datée ». Mesuré le 2026-10-14 : le contrôle
`npm audit`, non bloquant, laissait passer des failles hautes de production (corrigées par B1), et son `bash -e`
sautait l'audit de la console.

## Ce que livre ce lot

1. `scripts/audit-production.ts` : `npm audit --omit=dev` sur un dossier, bloquant sur les avis hauts et critiques
   sans exception. `scripts/audit-exceptions.json` : une exception par avis (GHSA), avec son dossier, sa raison et une
   échéance ; échue, elle bloque de nouveau. Deux exceptions à l'ouverture : la copie de postcss embarquée dans next 15.
   Un rapport illisible bloque.
2. `ci.yml`, job `securite` : une étape bloquante par dossier (API, console), l'audit complet en trace (une étape par
   dossier), trivy en trace sur les failles hautes et bloquant sur les critiques de l'image de l'API, l'image de la
   console construite et scannée en trace, l'uid des deux images bloquant.
3. `codeql.yml` : CodeQL (`security-extended`) à chaque push de code et chaque lundi ; alertes dans l'onglet Security.
4. `documentation.md` § les contrôles de sécurité de la CI : la règle et la procédure d'exception.

Pas de Dependabot : ses PR ne cadrent pas avec le travail direct sur `main`, et l'audit bloquant couvre le besoin.

## Tests attendus

`tests/audit-production.test.ts` : bloquant sans exception, excusé jusqu'à son dernier jour, bloquant de nouveau une
fois échu, gravités moindres ignorées, exception inutile signalée, rapport illisible refusé, forme du vrai fichier, et
les étapes bloquantes de `ci.yml` sans `continue-on-error`. Vu dans les deux sens : une exception échue fait échouer le
script réel, un `continue-on-error` ajouté fait échouer le test.

## Méthode de livraison

En direct, sans relecture séparée, parce que ce lot ne touche que la CI et un script d'outillage : aucun chemin que la
production emprunte, et tout est réversible par un commit. Essai réel qui clôt la livraison : le premier run de la CI,
lu étape par étape (les deux audits bloquants verts, les deux exceptions affichées, trivy critique vert sur l'image de
l'API, la mesure de l'image de la console lue), et la première analyse CodeQL visible dans l'onglet Security.
