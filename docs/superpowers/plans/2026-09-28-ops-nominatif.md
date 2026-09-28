# `/ops` nominatif avec second facteur (2026-09-28)

Lot 4 du bilan des audits (`docs/prive/BILAN-AUDITS-2026-09-22.md`), et la seconde moitié de la demande de Julien
« le MFA sur les ops et les admins » (la moitié admins est en production depuis le 2026-09-26 et éprouvée).

Aujourd'hui `/ops`, l'accès le plus puissant du produit (tous les espaces, crédits, prix, verrous, rejeu de DLQ,
observation), est gardé par UN jeton partagé (`OPS_TOKEN`, en-tête `x-ops-token`), que la console garde
indéfiniment dans le `localStorage` du navigateur. Aucune identité : la seule trace de qui a changé un prix ou
rechargé un crédit est une note tapée à la main.

## Décisions de Julien (2026-09-28)

1. **Une liste d'adresses autorisées**, posée côté serveur (`OPS_EMAILS`, vide = `/ops` fermé). Chacun se connecte
   avec son compte Engage Me habituel (mot de passe ou Google) plus son code d'authentification.
2. **`OPS_TOKEN` est supprimé**, sans accès de secours. Si la connexion nominative casse, on répare par le serveur.
3. **Session ops de 12 heures**, comme une session admin.

## Ce qui en découle (sans nouvelle question)

- Un compte ops est une IDENTITÉ (`identities`) dont l'adresse est dans la liste ET dont le second facteur est
  ACTIF et vérifié pour cette session. Une adresse de la liste sans facteur est enrôlée à sa première connexion
  ops, comme un admin (même porte, `apresLeMotDePasse` / `suiteDeConnexion`).
- La preuve d'accès est une session signée dédiée (portée `ops`, 12 h), jamais un jeton partagé : elle porte
  l'identité, et chaque écriture d'exploitation journalise l'adresse de son auteur. La note reste demandée pour
  les écritures (elle dit POURQUOI) ; elle cesse d'être la seule trace de QUI.
- L'observation d'un espace reste possible et porte l'adresse de l'observateur.
- La surveillance existante (alerte Telegram au 5e refus en 5 minutes) reste, sur les refus de la session ops.
- La console `/ops` remplace le champ « jeton » par la connexion ; plus rien d'ops dans le `localStorage` au-delà
  de la session elle-même.

## Méthode de livraison

**Implémenteur, puis UNE relecture**, parce que c'est un chemin d'authentification vers l'accès le plus puissant du
produit : une erreur ouvre tous les espaces, et les invariants (portée de la session, second facteur vérifié,
comparaison de l'adresse, refus par défaut quand la liste est vide) ne se voient pas dans un typecheck. Pas de
feature-loop ni de workflow. Tests : chaque garde vérifiée dans les deux sens (adresse hors liste, facteur non
vérifié, session tenant présentée à `/ops`, session ops présentée à une route d'espace, liste vide, ancien en-tête
`x-ops-token` refusé).

**Essai réel qui clôt la feature** : Julien ouvre `/ops` dans la console, se connecte avec son compte et son code,
voit la vue d'exploitation ; une écriture (par exemple la grille de prix relue puis réenregistrée à l'identique,
ou une observation d'espace) laisse une ligne d'audit à son adresse ; un appel avec l'ancien `x-ops-token` rend
401 depuis l'extérieur.

**Ordre de déploiement** : aucune migration attendue (à confirmer par l'implémenteur). `OPS_EMAILS` est posé dans
`.env.prod` sur le VPS AVANT le `up`. La console part au `git push` (Vercel) avant l'API : entre les deux, `/ops`
est indisponible (quelques minutes, un seul utilisateur, Julien), ce qui est accepté plutôt que de faire vivre les
deux mécanismes. `OPS_TOKEN` est retiré de `.env.prod` APRÈS le déploiement.
