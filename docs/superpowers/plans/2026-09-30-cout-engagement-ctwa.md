# Le coût par engagement des publicités Click-to-WhatsApp, dans la carte Coûts

Demande de Julien du 2026-09-30, arbitrée en trois questions : dans Performance lab, la ligne « Coût par
engagement » de la carte Coûts porte deux accordéons, « Campagnes push » (le tableau d'aujourd'hui) et
« Campagnes publicitaires CTWA ». Un engagé de publicité est une personne qui a cliqué ET écrit sur WhatsApp
(une arrivée), pas un prospect qualifié. Le grand chiffre du haut devient TOUT CONFONDU (rapport des totaux,
push et publicités), et la dépense des publicités suit EXACTEMENT la période, donc elle se lit jour par jour.

## Méthode de livraison

**Implémenteur par lot (la session elle-même) puis UNE relecture indépendante du diff**, parce que le lot
touche un chemin que la production emprunte (le balayage de suivi des publicités), une migration et un montant
affiché. Pas de feature-loop : le critère décisif (le chiffre se recoupe avec le Gestionnaire de Meta) se juge
à l'œil sur une vraie campagne : l'essai réel qui clôt le lot est décrit en fin de plan.

## Ce qui est mesuré avant d'écrire

Sur la seule campagne publiée (2026-09-30), `insights.date_preset(maximum).time_increment(1).limit(1000){spend}`
rend une ligne par jour de diffusion (`spend`, `date_start`, `date_stop`), et leur somme égale la dépense
cumulée (0,86 + 0,51 = 1,37). Un jour sans diffusion n'a pas de ligne. Et la même expansion, aliasée
`.as(jours)`, passe DANS l'appel du cumul : Meta rend alors `insights` et `jours` côte à côte (mesuré le même
jour). Le balayage reste donc à deux appels par compte publicitaire.

## Tâches

1. **Migration 0198** `pubs_depense_jour` : `(tenant_id, campagne_id, jour)` en clé primaire, `depense
   numeric(12,2) not null`, cascade sur l'espace. Additive, AVANT le `up`.
2. **Lecture chez Meta** : `lireDepenses` rend aussi `jours`, lus dans le même appel par l'alias `.as(jours)`,
   `safeParse`, une ligne illisible ignorée, un historique tronqué (`paging.next`) dit dans le journal.
3. **Balayage** : inchangé ; le câblage du worker écrit les jours après le cumul, par `noterDepensesJour`
   (upsert par jour, `tenant_id = $1`).
4. **Chiffrage** : `PgPublicitesStore.coutParPub(tenant, range, { inclureArchivees })` : par publicité de
   l'espace, la dépense des jours de la période et les CONTACTS DISTINCTS arrivés par sa campagne dans la
   période (bornes `BOUNDS_CTE`, fuseau de Paris) ; une publicité sans dépense ni arrivée sur la période n'est
   pas listée. La devise est celle de `pub_connexion`.
5. **Route** `GET /tenants/:id/stats/cost/pubs` (même garde que ses voisines), qui rend `{ currency, lignes }`
   avec le coût par engagé calculé côté serveur, `null` si l'un des deux termes manque.
6. **Écran** : la ligne garde son titre ; son chiffre est `coutMoyenParEngagement` sur les deux listes réunies,
   SAUF si les devises diffèrent (le chiffre retombe alors sur le push, et l'écran le dit) ; deux accordéons,
   chacun avec sa propre moyenne ; la case « Inclure les archivées » vaut pour les deux. Un quatrième appel
   séparé : sa panne n'éteint pas le tableau push.

## Tests attendus

- la lecture jour par jour (forme mesurée, ligne illisible, jour absent, un seul appel) ;
- l'intégration : upsert par jour, bornes de période, contacts distincts, archivées, isolation entre espaces ;
- la route : validation de la période, garde ;
- le calcul du chiffre tout confondu (devises égales, différentes, liste pub vide ou en panne).

## Ordre de déploiement

CI verte, migration 0198 appliquée et relue en base, `up -d --build mba-api mba-worker`, contrôle public.
⚠️ La console part sur Vercel au push : jusqu'au `up`, la route rend 404 et l'accordéon CTWA le dit sans
éteindre le reste. La fenêtre se ferme dans la foulée de la CI.

## Essai réel qui clôt le lot

Julien ouvre Performance lab sur une période qui couvre la campagne de test, déplie « Campagnes
publicitaires CTWA », et compare la dépense affichée à celle du Gestionnaire de Meta pour les mêmes jours.
