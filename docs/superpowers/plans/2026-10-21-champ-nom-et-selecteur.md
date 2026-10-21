# Plan : le champ de base « Nom », et un sélecteur de champ rangé

Demande de Julien du 2026-10-21, sur « Enregistrer une information » : la liste des champs est « le bordel » (les champs
créés en vrac, avec les longues questions des formulaires), et « Nom » n'y est jamais, alors que c'est un champ de base.
Grill : un nouveau champ de base « Nom », jamais écrasé ; la liste en deux groupes, les champs de base puis les champs
créés ; partout où un outil d'agent choisit un champ.

**Le constat qui fixe la clé.** L'actuel « Nom » est le nom du profil WhatsApp (`contacts.profile_name`), réécrit par
chaque message entrant, et la clé `nom` le désigne déjà dans plusieurs couches (connecteurs `fiche:nom`, paramètres
d'outils, `{nom}` des adresses de boutons, `CHAMPS_FICHE_FIXES`). Le nouveau champ prend donc la clé `nom_de_famille`
(libellé « Nom »), rangé dans `contacts.fields` comme Prénom et Email ; l'ancien devient « Nom WhatsApp ». Le champ
perso « Nom de famille » de la sandbox, seul de cette clé en base (mesuré en lecture seule), devient ce champ de base.

## Méthode de livraison

**Implémenteur (moi) puis une relecture indépendante du diff.** Raison : les constantes des champs de base sont lues
par la fiche contact, les variables, les conditions, l'API et le MCP (rayon de souffle large, inventorié avant de coder),
et l'agent de Meta refuse aujourd'hui tout champ absent du mini-CRM. Un essai réel sur l'écran et un téléphone clôt la
feature (plus bas).

## Tâches

1. **Le champ** (`web/lib/partage/champs.ts`) : `nom_de_famille` entre dans `SYSTEM_FIELD_KEYS` et `SOCLE_FIELDS`
   (« Nom », « Last name ») ; `name` devient « Nom WhatsApp » / « WhatsApp name ». Sa source de variable
   (`web/lib/fields.ts`), son exemple, sa place dans les conditions (`ConditionBuilder`).
2. **La fiche contact** : une ligne « Nom » (le champ socle, éditable), et « Nom WhatsApp » pour le profil.
3. **Le sélecteur** (`CibleChamp`) : un groupe « Champs de base » (Prénom, Nom, Email, les seuls qu'un agent écrit),
   puis « Vos champs » par ordre alphabétique ; un champ de base n'est jamais « disparu ». Partout : agent IA, agent de
   Meta, questions de « Qualifier et transférer » et d'« Enchaîner des étapes », valeur fixe.
4. **Le type « Enregistrer une information » n'est plus grisé** (`ChoixTypeOutil`) : les champs de base existent toujours.
5. **L'agent de Meta accepte un champ de base** : à la création (`mba-outils.ts`), sur la ligne de l'onglet
   (`vue-outils.ts`) et à chaque appel (`executer-maison.ts`).
6. **Doc** : `features.md` et les fiches d'aide qui citent ces sections (empreintes, versions anglaises).

Hors du lot, au backlog : faire pointer « Nom de famille » des formulaires WhatsApp et de l'import CSV vers le nouveau
champ (cela changerait la destination de formulaires existants) ; le panneau Détail de l'Inbox, qui compose prénom et
nom WhatsApp ; `GET /v1/fields` et `list_fields`, qui décrivent le nom comme un attribut.

## Tests attendus

Les listes figées (`fields-reserves`, `mcp-champs`, `web-codes`…) suivent ; un test du sélecteur (groupes, ordre, base
jamais disparue) ; les gardes de l'agent de Meta acceptent `prenom`, `nom_de_famille`, `email` ; e2e : le type champ
proposé sans champ créé, les groupes de la liste.

## Ordre de déploiement

Aucune migration (`contacts.fields` est un jsonb, `user_fields` matérialise un socle à la première écriture). L'API
d'abord (les gardes de l'agent de Meta), puis la console suit seule au push ; dans l'intervalle, un outil de l'agent de
Meta sur un champ de base non encore créé est refusé comme aujourd'hui.

## Essai réel qui clôt la feature

L'essai réel, dans la sandbox : ouvrir « Enregistrer une information », voir Prénom, Nom, Email en tête puis les champs créés ; poser
un outil sur « Nom » ; depuis un téléphone, donner son nom à l'agent ; la fiche affiche « Nom » rempli, et « Nom
WhatsApp » inchangé au message suivant.
