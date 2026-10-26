# Un espace passé en Free au-delà de 100 contacts : le prévenir, et supprimer en masse par Claude : plan

> **Pour un agent** : un implémenteur, puis UNE relecture indépendante du diff. Les étapes se cochent (`- [ ]`).

**Les décisions de Julien (2026-10-26)** : « au passage en Free on demande au client de supprimer jusqu'à moins de 100,
sinon ça bloque ». Puis, à ses questions : ce qui bloque est **« comme une Free pleine »** (ce qui est en production
depuis `d3b0b071` : plus de création ni d'import, un nouveau client qui écrit n'entre pas, les contacts présents écrivent
et reçoivent comme avant) ; le client supprime **« par Claude, en masse »** : un outil qui supprime d'un coup une
sélection (les plus anciens, une étiquette ; « les inactifs » est reporté, voir plus bas), avec confirmation, et plus
de plafond de 10 suppressions par jour tant que l'espace dépasse sa limite.

**Aujourd'hui** (relevé dans le code le 2026-10-26) : la suppression passe par `effacerContacts` (`src/crm/effacement.ts`),
qui consomme d'abord le quota du jour (`QuotaSuppressions.consommer`, `src/offres/compteurs.ts`, 10 en Free, tout ou
rien), puis `PgContactStore.purgeMany` (une transaction ; conversations, messages et traces effacés, fiche anonymisée).
La suppression en masse existe dans la console (`POST /tenants/:tenantId/contacts/purge`, `confirm: 'SUPPRIMER'`, cible
par identifiants ou par filtres), mais ce module est fermé en Free ; une Free n'a que `DELETE /v1/contacts/:id`, une
fiche par appel, et aucun outil MCP ne supprime de contact. Au passage en Free (fin du Pro, de l'essai, sortie de
l'Entreprise), `balayerLimites` (toutes les 30 minutes) envoie une seule fois `limite_contacts_100`, dont le texte dit
« supprimez par l'API » : à 10 par jour, 3 000 contacts demanderaient 290 jours.

## Méthode de livraison

**Implémenteur, une relecture indépendante du diff, puis déploiement**, parce que l'outil EFFACE des données de clients,
sans retour arrière (conversations comprises) : une sélection mal résolue, ou une confirmation qui ne porte pas sur ce
qui a été montré, détruirait autre chose que ce que le client a choisi. **Essai réel qui clôt** : un espace Free de test
amené au-delà de 100 contacts (par l'API, ou un Pro de test qui revient en Free) ; l'e-mail « dépassé » arrive avec le
nombre à supprimer ; Claude prépare la suppression des contacts en trop (les plus anciens), en montre le compte, et les
supprime sur confirmation sans buter sur les 10 par jour ; ensuite un nouveau client qui écrit entre de nouveau.

## Ce qui change

1. **Deux outils MCP, sur le motif des campagnes** (`prepare_campaign` puis `launch_campaign`,
   `src/campaign/confirmation.ts`), ouverts à toutes les offres (`fonction: null`), personne nommée exigée, réservés aux
   administrateurs, `destructiveHint` :
   - `prepare_contacts_deletion` : la sélection, puis le compte, un échantillon de dix fiches au plus (nom, numéro
     masqué, date de création) et un code de confirmation ; rien n'est effacé.
   - `delete_contacts` : le code seul ; il re-résout la sélection, refuse si elle n'a plus la même empreinte (des fiches
     ont changé depuis l'aperçu), puis efface par `effacerContacts` et rend le bilan.
   - La sélection : les champs de cible existants (`CHAMPS_CIBLE_FILTRES` et `contact_ids`, `src/mcp/cible.ts`, sans
     l'analyse), plus `oldest` (les N fiches les plus anciennes, par date de création, parmi la sélection). Une sélection
     sans aucun critère est refusée ; au plus 1 000 fiches par appel (relecture du lot : la durée d'une transaction de
     5 000 fiches et de leur audit n'était pas mesurée). Une fiche déjà supprimée n'est jamais comptée ni rendue.
     🔴 **Pas de critère « inactifs depuis N jours »** (retiré à la relecture du lot) : il lisait la date du dernier
     message des conversations, or elles sont purgées par la conservation (30 jours en Free) et toutes effacées à la
     déconnexion du numéro, donc un client qui a écrit il y a trois mois paraissait « jamais actif ». Il reviendra quand
     la fiche gardera sa propre date de dernier message (`todo.md`).
   - Le code : lié à l'espace, à la sélection et à l'empreinte des identifiants, usage unique, 30 minutes. Sans
     migration si possible (un jeton signé par `AUTH_SECRET` le permet : re-résolue après l'effacement, la sélection
     n'a plus la même empreinte) ; si une table est nécessaire, la migration part seule, avant le code.
   - L'audit : une ligne `contact.purged` par fiche, `{ lot: n, via: 'mcp' }`, signée de la personne.
2. **Plus de plafond tant que l'espace dépasse** : `effacerContacts` ne consomme pas le quota du jour quand l'espace a
   plus de fiches comptées que sa limite (`placesContacts`, la même définition que la porte). Pour tous les chemins
   (API, console, Claude). Revenu sous la limite, le plafond reprend.
3. **Le prévenir** : un seuil de plus au balayage des limites, au-delà de 100 % (`limite_contacts_depassee`, Free
   seulement, une fois par franchissement), plus haut que `limite_contacts_100` : « votre espace Free compte
   {{contacts}} contacts pour {{limite}} : supprimez-en au moins {{a_supprimer}}, en le demandant à Claude ; sinon aucun
   nouveau contact ni nouveau client ne peut entrer ». `limite_contacts_100` cesse de dire « par l'API ».
4. **Ce que voient Claude et la console** : la vue de l'offre porte `contactsEnTrop` (0 sous la limite) ; `get_plan` le
   dit ; la page `/offre` l'affiche sous la jauge des contacts, avec la marche à suivre.
5. **Textes** : `features.md` (Offres, e-mails), `documentation.md`, les fiches « Choisir mon offre » et « Recevoir les
   e-mails de Messaging Me » (empreintes, `traduit_de`, `npm run vitrine:aide`), la doc publique des outils
   (`web/lib/mcp-outils.ts`, `cd web && npm run doc:md`), la famille des outils (`scripts/plugin/familles-outils.ts`). Les
   skills et la FAQ du plugin sont à la session Vitrine (annoncé).

## Tests attendus

- La sélection : chaque critère seul et combinés, `oldest` qui garde les plus anciennes, `inactive_days` refusé comme
  une clé inconnue, une fiche supprimée jamais rendue, un autre espace jamais touché, une sélection vide refusée, plus
  de 1 000 refusé.
- La confirmation : un code d'un autre espace, périmé, déjà servi, ou dont la sélection a changé est refusé ; rien
  n'est effacé sans code valide.
- Le plafond : au-delà de la limite, 50 suppressions d'un coup passent en Free ; sous la limite, la 11e du jour est
  refusée comme avant.
- L'e-mail : un espace qui passe à 3 000 contacts reçoit `limite_contacts_depassee` une fois, pas `limite_contacts_100`.
- Chaque garde vérifiée dans les deux sens.

## Déploiement

L'API (`mba-api`, `mba-worker`, puis `mba-worker-analyse`), garde de révision, puis la console au push (elle tolère
l'absence de `contactsEnTrop`), `aide:charger`, et la session Vitrine pour la FAQ et les skills. ⚠️ La bascule vers
Scaleway est visée le mardi 2026-10-27 au soir : aucun déploiement pendant la coupure.
