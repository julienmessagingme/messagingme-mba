# Publicités CTWA : brouillons, et la liste qui se lit

Demande de Julien du 2026-09-24, après avoir vu l'aperçu des trois écrans : « il faut aussi que tu gardes
en mémoire les brouillons, que tu élargisses l'écran où on crée la pub, et qu'en terme d'UX sur le 1er
écran tu aies : le compte pub setuppé (comme aujourd'hui) et la liste des publicités en brouillon, en
cours, ou achevées ; quand on clique dessus on voit le détail, notamment le coût dépensé à date et le
budget initial et le nombre de clics en face pour venir sur WhatsApp ».

Spec de la feature : `docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md`. Ce lot vient APRÈS le lot 3
(déployé le 2026-09-24) et ne touche ni le routage, ni la création chez Meta, ni le suivi.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Les quatre questions du `CLAUDE.md` global :

- **La production emprunte-t-elle ce chemin ?** Oui. La liste des publicités est l'écran que le client
  regarde pour décider de couper ou de remettre du budget, et le lot ajoute une table que la production
  lit et écrit.
- **Est-ce réversible ?** Oui, et c'est ce qui rend le lot sûr : la migration n'AJOUTE qu'une table
  neuve, elle ne touche à aucune colonne existante. Un retour arrière laisse des lignes orphelines et
  rien d'autre.
- **Les critères sont-ils vérifiables par un test ?** En grande partie (les états, le groupement, ce que
  le détail affiche), mais le rendu et le confort de l'écran élargi demandent un œil.
- **Le code touché porte-t-il des invariants invisibles ?** Oui, et c'est le point qui tranche :
  `publicites.campagne_id` est `not null` et porte l'unique `(tenant_id, campagne_id)` par laquelle le
  routage retrouve la publicité d'un lead payé. Un brouillon n'a pas de campagne Meta.

Deux « oui » en haut, donc revue humaine du diff. Pas de feature-loop : le rayon de souffle touche
l'argent du client.

🔴 **Et aucune méthode ne remplace l'essai réel, détaillé en fin de plan** : écrire un brouillon avec un
visuel, fermer l'onglet, revenir et retrouver l'image, puis le transformer en publicité et voir le
brouillon disparaître. Les tests d'un écran sont écrits par celui qui a écrit l'écran, donc ils vérifient
ce qu'il a pensé à vérifier ; un aller-retour de persistance qui n'a jamais tourné sur un vrai navigateur
et une vraie base n'est pas éprouvé, il est seulement vert.

## 🔴 La décision d'architecture, et sa raison

**Un brouillon vit dans SA table, `pubs_brouillons`, jamais dans `publicites`.**

Mettre un brouillon dans `publicites` obligerait à rendre `campagne_id` nullable. Trois conséquences, et
la première suffit à trancher :

1. `PgPublicitesStore.pubDeLaCampagne` retrouve une publicité PAR sa campagne Meta, sur le chemin chaud
   d'un lead qui vient de cliquer. Des lignes à `campagne_id` nul y entreraient sans identité.
2. L'unique `(tenant_id, campagne_id)` cesserait de contraindre quoi que ce soit pour les brouillons
   (Postgres considère les `null` comme distincts), donc l'invariant deviendrait partiel sans le dire.
3. Le code DÉPLOYÉ lit `etat` dans une liste fermée et l'affiche : lui servir un état inconnu ferait
   apparaître des lignes sans libellé chez un client, pendant la fenêtre Vercel/API.

Un brouillon n'est pas une publicité dégradée : c'est un FORMULAIRE mémorisé. Il n'a ni identifiant Meta,
ni dépense, ni entonnoir, ni automation. La table séparée dit cela dans le schéma.

## Migration 0171 `pubs_brouillons`

**Purement additive, donc AVANT le `up`.** L'ancien code ignore une table qu'il ne nomme pas.
⚠️ Le numéro se prend sur la ligne « Dernière appliquée » de `CLAUDE.md` (0170) et **la base tranche**.
La relecture point par point se fait juste APRÈS `migrate`, jamais en écrivant cette ligne.

Colonnes : espace, nom, et le formulaire complet (titre, texte, accueil, message pré-rempli, budget,
début, fin, pays, villes, âges, destination, scénario, tag), plus le visuel.

🔴 **LE VISUEL EST STOCKÉ, décision de Julien du 2026-09-24.** `visuel_octets bytea` et `visuel_type
text`, nullables. Un brouillon qui perd l'image n'est pas un brouillon : on rouvre et il manque
précisément ce qu'on a mis le plus de temps à choisir. Deux gardes qui vont avec :

- **La LISTE ne sélectionne JAMAIS `visuel_octets`.** Une colonne de 5 Mo dans un `select *` transformerait
  l'écran d'accueil en transfert de plusieurs dizaines de mégaoctets. Seule la lecture d'UN brouillon la
  lit. C'est un contrat avec une requête précise, au même titre qu'un index partiel.
- **Le plafond est celui du formulaire** (`TAILLE_VISUEL_MAX`, 5 Mo), vérifié côté serveur comme à la
  création : un brouillon n'est pas une porte dérobée pour écrire n'importe quoi en base.

⚠️ **Aucune contrainte d'unicité sur le nom** : deux brouillons peuvent porter le même nom, ou aucun. Un
brouillon sert à ne pas perdre un travail en cours, pas à être bien rangé.

## Ce qui change à l'écran

### 1. Enregistrer et reprendre un brouillon

Le formulaire gagne « Enregistrer le brouillon », à côté de « Créer (en pause) ». Rien ne part chez Meta.
Rouvrir un brouillon remplit le formulaire, visuel compris.

🔴 **LE BROUILLON DISPARAÎT QUAND LA PUBLICITÉ EST CRÉÉE**, dans le même geste. Le laisser produirait deux
lignes pour une même intention, et le client corrigerait un jour le brouillon en croyant corriger la pub.

### 2. La liste en trois groupes

**Brouillons**, **En cours**, **Achevées**. Le compte publicitaire connecté reste où il est.

🔴 **« ACHEVÉE » SE DÉRIVE DE LA DATE DE FIN, décision de Julien du 2026-09-24.** Toute publicité de cet
écran a une date de fin obligatoire (c'est le garde-fou de dépense), donc la dérivation est totale et il
n'y a aucun état de plus à tenir juste. ⚠️ Ce qu'elle ne dit PAS, et que l'écran affiche à côté : une pub
en pause avant sa fin reste « en cours », avec son statut Meta. **On n'a jamais mesuré ce que Meta renvoie
comme `effective_status` sur une campagne terminée** : l'ajouter au critère serait inventer. À rouvrir
après l'essai réel, quand on l'aura vu.

### 3. Le détail : les trois chiffres en face

Au clic : **budget initial**, **dépensé à date**, **clics vers WhatsApp**, côte à côte, plus l'entonnoir
déjà présent. ⚠️ `null` veut dire « jamais relu chez Meta » et jamais zéro : c'est l'invariant que le lot 3
tient déjà, et il ne doit pas se perdre en réorganisant l'affichage.

### 4. L'écran élargi

L'écran de création passe au large. Il est déjà passé de `max-w-3xl` à `max-w-5xl` avec l'aperçu ; ce lot
finit le travail pour que les champs, l'aperçu et la liste respirent.

## Hors périmètre

Le ciblage par **ville et rayon** (le serveur sait le recevoir, l'écran ne l'offre pas, il demande un appel
de recherche de lieu chez Meta) ; la modification d'une publicité déjà créée ; l'import des pubs créées
ailleurs (lot 4 de la spec) ; tout ce que la spec § 10 écarte déjà.

## L'essai réel qui clôt ce lot

Rien n'est clos avant, et il appartient à Julien : **écrire un brouillon avec un visuel, fermer l'onglet,
revenir, le rouvrir et retrouver l'image**, puis le transformer en publicité et vérifier que le brouillon a
disparu de la liste. Puis, sur une publicité réelle qui a tourné, lire les trois chiffres et les comparer
au Gestionnaire de Meta.

⚠️ Ce lot ne remplace pas l'essai réel du lot 3, qui reste dû : première campagne créée depuis Engage Me,
un vrai clic, et les cinq mesures de la spec § 6.
