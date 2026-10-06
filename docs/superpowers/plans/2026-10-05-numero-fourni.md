# Lot 3b : le numéro fourni côté client, plan

Spec : `docs/superpowers/specs/2026-10-05-numero-fourni-design.md`. Plan court : tâches, interfaces, tests attendus,
ordre de déploiement. Le code se lit dans origin (l'arbre partagé peut être en retard) ; commits en plomberie.
**Réécrit le 2026-10-06** : la mesure (tâche 0) a montré qu'en v4 rien ne fait sauter l'écran du numéro, et Julien a
décidé le repli (le client tape le numéro attribué, la page affiche le code capté).

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante par livraison, parce que la production
emprunte ces chemins : la connexion d'un client, une migration, le montant d'un crédit offert. Le code porte des
invariants invisibles (le CHECK à sens unique de l'espace, l'unicité par espace, une offre par espace). Aucun
workflow multi-agents pour coder.

**L'essai réel qui clôt** : sur un espace créé depuis Claude Code, « Fournissez-moi un numéro », le numéro tapé dans
la fenêtre Meta avec la vérification par appel, le code affiché sur la page en moins d'une minute, le numéro connecté ;
crédit offert de 1 € ; alerte Telegram de réserve basse reçue.

## Contraintes globales

- Aucun tiret long dans le code, les commentaires et les docs.
- `tenant_id = $1` sur chaque requête d'espace ; dépendances requises, jamais optionnelles.
- Migration écrite au numéro libre relu dans origin (0211 au 2026-10-06), appliquée AVANT le `up`.
- La console n'est poussée qu'après le déploiement de l'API qui porte ses routes.

## Points de vigilance (chacun avec son test dans sa tâche)

1. Deux demandes simultanées pour le même espace (double clic, deux onglets) : un seul numéro attribué.
2. Le code d'un autre espace, ou un code antérieur à l'attribution, ne s'affiche jamais.
3. L'espace qui a déjà un numéro WhatsApp n'obtient pas de numéro fourni (409).
4. « Abandonner » après la connexion du numéro est refusé : le numéro ne retourne pas à la réserve en servant.
5. La réserve vide : un message clair, et l'alerte part quand même.

## Livraison A : le compte sans numéro (en production, `a1bb1c63`)

Faite le 2026-10-05 : un compte revenu sans numéro est gardé avec son jeton. **Tâche 0, la mesure** : conclue le
2026-10-06, l'écran du numéro ne se saute pas en v4 ; d'où cette réécriture.

## Livraison B : le repli

**Tâche 1. Migration 0211 et magasin**
- `tenants.origine` (`console` par défaut, CHECK `console` ou `claude_code`), sans reprise ; `numeros_fournis` : statut
  `bloque` ajouté au CHECK, index unique partiel `(tenant_id) where statut = 'attribue'`.
- `src/otp/store.pg.ts` : `attribuer(tenantId)` (rend l'existant, sinon prend un `libre` en `for update skip locked`,
  `null` si la réserve est vide), `numeroDeLEspace(tenantId)`, `codeDeLEspace(tenantId)` (dernier code certain reçu
  après l'attribution et dans les 15 minutes), `remplacer(tenantId)` (bloque l'actuel, en attribue un autre),
  `rendre(tenantId)`, `compterLibres()`.
- Tests d'intégration : deux espaces et un libre, un seul gagnant ; rejouer rend le même ; le code d'un autre espace
  et un code antérieur invisibles ; remplacer et rendre.

**Tâche 2. Le crédit offert selon l'origine**
- `creerEspaceParGoogle` et `createTenantWithAdmin` prennent l'origine : `claude_code` depuis `src/http/oauth.ts`,
  `console` depuis `/auth/google` et l'inscription.
- `CREDIT_OFFERT_CLAUDE_CODE_MICRO_EUR` (1 € par défaut) ; `offrirCredit` choisit le montant selon `tenants.origine`.
- Tests : l'espace créé par OAuth porte `claude_code` ; 1 € contre 5 € ; une seule offre par espace.

**Tâche 3. Les routes et l'alerte**
- Module de classe `tenant` `src/http/numero-fourni.ts` : `POST`, `GET`, `POST .../remplacer`, `POST .../abandonner`
  sous `/tenants/:tenantId/numero-fourni` (spec § 4), admin.
- L'alerte : `compterLibres()` sous `ALERTE_RESERVE_SEUIL` (3) après chaque attribution et sur réserve vide, Telegram
  sous le verrou court `numeros.reserve-basse` de 24 heures ; remplacer prévient Julien du numéro bloqué.
- Tests : les vigilances 1, 3, 4, 5 ; agent refusé ; isolation par `tests/scope-tenant.test.ts`.

**Tâche 4. La page « Connecter WhatsApp »**
- `web/app/connecter-whatsapp/page.tsx` : les deux choix ; « fourni » : obtenir le numéro, l'afficher avec « Copier »,
  les trois consignes, ouvrir la fenêtre (`useConnexionNumero`), interroger toutes les 3 secondes et afficher le code,
  « En obtenir un autre », « Abandonner », l'état connecté. L'Accueil sans numéro y mène.
- `web/lib/api/` : les fonctions et leurs types. E2e : le numéro, le code qui apparaît, « En obtenir un autre ».
- Docs : `features.md` (fiches d'aide vérifiées par `aide-proposer`), `documentation.md`, `wip.md`.

## Ordre de déploiement

1. Relecture, CI job par job ; migration 0211 AVANT le `up` de l'API et des deux workers, relue en base, compteur de
   `CLAUDE.md` mis à jour ; contrôle public ; puis push de la console.
2. **Essai réel** (ci-dessus), puis la réserve réapprovisionnée par Julien.
