# Tout sur la fiche : l'analyse devient des champs du contact, et une seule liste des champs

**Date** : 2026-09-30. **Statut** : design validé par Julien le 2026-09-30, après une cartographie du code (cinq
lecteurs, lecture seule, sur origin/main `75a5e215`) et sept rondes de questions, puis AMENDÉ le même jour par
la cartographie qui a précédé le plan (§ « Les amendements du 2026-09-30 »). Plan :
`docs/superpowers/plans/2026-09-30-fiche-unique.md`.

## Le problème

Julien, le 2026-09-30 : « tout doit être lié à une fiche client ». Ce n'est pas le cas aujourd'hui.

1. **L'analyse vit sur la conversation, et meurt avec elle.** `conversation_analysis` a pour clé
   `conversation_id`, en `on delete cascade` (0027). La durée de conservation efface les conversations (0094),
   donc leur analyse. Tout ce qui lit l'analyse la relit DANS la conversation : les signaux (`completer.ts`,
   `PgSignauxStore.analyse`), la poussée HubSpot (`connector-push.ts`), et la donnée de connecteur ajoutée par
   `b4a62d3b` (`analyseDuContact`). Une conversation effacée ne laisse rien.
2. **La fiche ne porte presque rien de l'analyse.** Seul le risque de départ est une colonne de `contacts` (0178).
   Le résumé est relu dans la conversation à l'ouverture de la fiche. La satisfaction et l'urgence ne sont
   affichées nulle part sur un contact (`ContactConversationAnalysis` ne les porte pas).
3. **Au moins huit listes de champs**, chacune avec sa définition : variables de template
   (`src/crm/template.ts`), corps libres (`contactVars`, `src/crm/render.ts`), bloc Condition
   (`src/workflow/conditions.ts`, `ConditionBuilder.tsx`), bloc Action (`listUserFields`), filtres
   (`ContactFilters`), données d'un connecteur (`src/agent/variables.ts`, `champs-contact.ts`), API
   (`FicheApi`), MCP (`contactPublic`). Le nom du contact y porte trois clés : `name`, `profile_name`, `nom`.
4. **Trois définitions de « la dernière analyse »** qui ne concordent pas :

   | Où | Conversations prises | La « dernière » | Référence |
   |---|---|---|---|
   | Fiche et Historique | toutes celles du contact | dernier message le plus récent | `contact-history.pg.ts` |
   | Risque | analysées depuis 90 jours | `ca.created_at` le plus récent | `risque.pg.ts` |
   | Connecteur | le seul fil du `wa_id` | `cv.analyzed_at` le plus récent | `signaux/store.pg.ts` |

5. **Les filtres sur un champ personnalisé ne font que du texte** (égal, contient, vide) : pas de
   « satisfaction inférieure à 5 ».
6. **L'automation « conversation analysée » ne filtre que le sentiment et « non résolue »**, et son événement ne
   transporte que ces deux valeurs (`src/automation/match.ts`, `src/worker.ts`).

## Les décisions (Julien, 2026-09-30)

1. **Quand une conversation est effacée, les constats de l'analyse restent sur la fiche.**
2. **Tous les résultats deviennent des champs** : intention, sentiment, satisfaction, urgence, résolue, sujet,
   traitée par, action suggérée, plus la date de l'analyse.
3. **La dernière analyse seulement** : chaque analyse écrase la précédente sur la fiche. Le détail
   conversation par conversation reste dans l'onglet Historique, tant que les conversations existent.
4. **Le résumé part avec la conversation.** Il contient les propos du client : il n'est pas recopié sur la fiche.
5. **Lecture seule** : seule l'analyse écrit ces champs.
6. **Pas de reprise du passé** : les fiches se remplissent au fil des analyses.
7. **Analyse périmée** : les valeurs restent affichées et utilisables, avec « nouveaux messages depuis
   l'analyse ».
8. **Des colonnes dédiées sur `contacts`**, comme le risque, et pas le jsonb des champs personnalisés.
9. **La liste unique sert** aux connecteurs, aux filtres et au ciblage de campagne, au bloc Condition et aux
   automations, à l'API contacts, au MCP et aux signaux. **Pas aux variables de message.**
10. **Les valeurs d'analyse ne s'insèrent jamais dans un message envoyé au client.**
11. **Champs de base ajoutés à la liste** : l'identifiant externe et la date de création. Pas les tags, ni
    l'abonnement, ni la langue, ni la joignabilité, ni le risque complet (le niveau reste disponible comme
    aujourd'hui).
12. **Filtres complets** : intention, sentiment, traitée par et action suggérée en un ou plusieurs choix ;
    résolue en oui ou non ; satisfaction et urgence en seuils ; date en « analysée depuis moins de N jours ».
    Le sujet n'est pas filtrable.
    ⚠️ Correction apportée en écrivant cette spec : la ronde présentait l'action suggérée comme un texte libre.
    C'est une liste fermée de cinq valeurs (`creer_devis`, `rappeler`, `relancer`, `escalader`, `aucune`,
    `src/analysis/schema.ts`) : elle est donc filtrable comme l'intention.
13. **Un nouveau déclencheur « un champ d'analyse devient »** sur le sentiment, l'intention, un seuil de
    satisfaction ou d'urgence, et « résolue ». Anti-rebond de 7 jours par défaut, réglable. La première
    analyse d'un contact compte comme un changement.
14. **L'agent IA** reçoit les champs d'analyse, et le résumé s'il existe, par l'outil maison « Lire la fiche du
    contact », seulement si l'admin le lui a donné et quand il l'appelle. Rien de systématique.
15. **Le résumé sort par le MCP, pas par l'API contacts.** Les codes sortent par les deux.
16. **Les signaux posent les mêmes champs partout** : le sujet, « traitée par » et l'action suggérée deviennent
    des attributs de fiche, en plus de ceux qui existent.
17. **Livraison** : implémenteur par lot, relecture indépendante par lot, quatre lots dans l'ordre ci-dessous.

## La conception

### Lot 1 : les champs d'analyse sur la fiche

**Les colonnes** (noms indicatifs, le plan les fixe), toutes nullables SANS défaut : `null` veut dire « jamais
analysé », jamais 0 ni une chaîne vide.

| Colonne | Type | Contrainte |
|---|---|---|
| `analyse_intention` | text | CHECK sur `INTENTS` |
| `analyse_sentiment` | text | CHECK sur `SENTIMENTS` |
| `analyse_satisfaction` | smallint | CHECK entre `NOTE_MIN` et `NOTE_MAX` |
| `analyse_urgence` | smallint | idem |
| `analyse_resolue` | boolean | |
| `analyse_sujet` | text | 120 caractères au plus, comme `topic` |
| `analyse_traitee_par` | text | CHECK sur `HANDLED_BY` |
| `analyse_action` | text | CHECK sur `ACTIONS` |
| `analyse_le` | timestamptz | la date de l'analyse |
| `analyse_fenetre_fin` | timestamptz | le dernier message couvert, qui sert la règle « dernière » |
| `analyse_conversation_id` | uuid | `on delete set null` : le lien vers le résumé et la mention « périmée » |

Les listes fermées des CHECK recopient `src/analysis/schema.ts` : un test de parité les tient ensemble, comme
`tests/intentions-parite.test.ts` le fait déjà pour le CHECK de `conversation_analysis`. Ajouter une intention
demandera donc de relâcher DEUX CHECK, et le test le rappellera.

**L'écriture** se fait dans la transaction de `PgConversationAnalysisStore.save`, pour le contact de la conversation. Ce
contact se trouve par la règle de l'onglet Historique (`conversations.contact_id`, sinon les identités du
contact : chiffres du numéro, BSUID). **La règle « dernière », une seule pour tout le produit** : la copie ne se
fait que si la fenêtre de la nouvelle analyse (`windowEnd`) n'est pas plus ancienne que `analyse_fenetre_fin`.
Une vieille conversation analysée après coup (par exemple un fil ouvert sur le BSUID) n'écrase pas une analyse
plus récente. Le plan tranche le cas d'une fenêtre absente.

**Le résumé n'est pas recopié.** La règle écrite dans `contact-history.pg.ts` (jamais recopié dans la fiche, pour
ne pas survivre à la durée de conservation) reste vraie pour lui ; son commentaire doit dire que les CODES, eux,
sont recopiés délibérément (décision 1). Quand la conversation est effacée, `analyse_conversation_id` retombe à
`null`, le résumé disparaît de la fiche, les codes restent.

**Le risque de départ lit la copie** : la CTE `analyses` de `risque.pg.ts` lit les colonnes de la fiche
(`analyse_le` dans la fenêtre de 90 jours) au lieu de joindre les conversations. Une réclamation continue donc de
peser jusqu'à 90 jours, même si sa conversation est effacée avant.

**La purge RGPD** (`PgContactStore.purgeMany`) vide toutes les colonnes `analyse_*` : ce sont des jugements sur
une personne. Test d'intégration vérifié dans les deux sens.

**La promesse de conservation change, et elle s'écrit** : quand une conversation est effacée, ses messages et son
résumé partent, les constats de l'analyse (codes et notes) restent sur la fiche. Le lot relit ce que disent le
Centre de sécurité, `features.md` et la vitrine sur la durée de conservation, et les corrige.

**La console** : une section « Dernière analyse » sur l'onglet Fiche (`ContactDetail.tsx`), à côté du bloc du
résumé. Les huit valeurs avec leurs libellés français (les libellés existants, `web/lib/intentions.ts` et
voisins, jamais recopiés), la date, la mention « nouveaux messages depuis l'analyse » quand un message est plus
récent que `analyse_fenetre_fin`. Section absente tant que le contact n'a jamais été analysé, comme le résumé.
Lecture seule.

### Lot 2 : la liste unique des champs de la fiche

**Un seul module serveur** décrit chaque champ de la fiche : clé stable, libellés français et anglais,
provenance (base, personnalisé, analyse, risque), type (texte, note de 0 à 10, oui ou non, date, choix avec ses
valeurs), modifiable ou non, peut sortir chez un tiers quand un admin le choisit ou non, opérateurs de filtre,
sensible ou non. Les champs personnalisés s'y ajoutent depuis `user_fields`. La console reçoit cette liste de
l'API et ne recopie aucune liste ; un test tient la parité des libellés.

**Les consommateurs du lot 2 :**

- **Données envoyées d'un connecteur** : les champs de la liste qui peuvent sortir. Les variables déjà
  enregistrées (`contact:wa_id`, `contact:nom`, `champ:<clé>`, `systeme:analyse_*` de `b4a62d3b`) continuent de
  marcher sans reprise. Les valeurs d'analyse se lisent désormais sur la fiche : plus aucune lecture de la
  conversation. Invariants de sécurité conservés, tous écrits dans le code : le catalogue des origines reste
  fermé ; le numéro vient du tour, jamais du modèle ; rien ne part chez un tiers sans qu'un admin ait choisi ce
  champ précis ; jamais le jsonb `champs` entier vers un serveur tiers ; les colonnes techniques (jeton de
  suivi, identifiants internes, auteur d'un blocage) ne sont jamais proposées.
- **Filtres de la liste des contacts et ciblage de campagne** (même `ContactFilters`, même `buildContactWhere`,
  et une entrée dans `hasFilters` pour chaque filtre neuf, sinon il retombe sur la liste entière sans rien
  filtrer) : les opérateurs de la décision 12, en égalités nues et comparaisons sur colonnes. Les index
  partiels se construisent `CONCURRENTLY`, pour les seuls filtres dont le plan mesure le besoin ; chacun est un
  contrat avec sa requête. La console ne propose ces filtres que lorsque le serveur sait les appliquer, comme
  pour le risque.
- **Bloc Condition d'un scénario** : les mêmes tests sur les champs d'analyse (le contexte de condition lit les
  colonnes).

**Les clés sont réservées** : un champ personnalisé ne peut pas prendre la clé d'un champ de la liste (par un
ensemble séparé, pas `SYSTEM_FIELD_KEYS` : amendement 1). Sans ça, un import CSV avec une colonne « sentiment »
créerait un champ perso qui se confondrait avec le champ d'analyse.

### Lot 3 : les automations

- **« Conversation analysée »** reçoit les filtres de la liste sur tous les champs d'analyse, et son événement
  transporte toutes les valeurs. Les automations existantes (sentiment, « non résolue ») continuent de marcher
  sans reprise.
- **Nouveau déclencheur « un champ d'analyse devient »** : le champ (sentiment, intention, satisfaction qui
  passe sous un seuil, urgence qui passe au-dessus d'un seuil, résolue qui devient non) et la valeur visée. Il
  part quand la nouvelle copie sur la fiche correspond ET que la précédente ne correspondait pas ; une fiche
  jamais analysée compte comme « ne correspondait pas ». Le changement se constate à l'écriture du lot 1
  (ancienne et nouvelle valeurs dans la même transaction), pas par un balayage. C'est un démarrage unitaire, un
  événement par analyse d'un contact, jamais un chemin de masse. Anti-rebond par défaut de 7 jours, réglable par
  automation, sur le modèle de `antiRebondParDefaut` et du risque élevé.

### Lot 4 : les sorties

- **API contacts v1** : la fiche rendue porte les champs d'analyse, en lecture seule, jamais acceptés en
  écriture. Sans le résumé. La documentation Developers suit (ses tableaux sont tenus par des tests).
- **MCP** (`get_contact`, `search_contacts`) : les champs d'analyse et le résumé, tant que la conversation
  existe.
- **Signaux** : les attributs de fiche se lisent sur la fiche, donc survivent à l'effacement d'une conversation.
  Trois attributs de plus dans `NOMS_ATTRIBUTS` pour le sujet, « traitée par » et l'action suggérée (noms fixés
  au plan), la documentation Événements et l'adaptateur Batch suivent. La spec Salesforce dérive ses champs de
  `NOMS_ATTRIBUTS` : elle les reçoit sans rien changer.
- **Outil « Lire la fiche du contact »** de l'agent IA : il rend les champs d'analyse, et le résumé s'il existe.
  Sa description destinée au modèle le dit. Les consignes de l'agent ne changent pas.

## Hors chantier

- Les variables de message (templates, corps libres, blocs d'un scénario).
- Les tags, l'abonnement, la langue, la joignabilité et le risque complet dans la liste unique.
- La synchronisation HubSpot : le connecteur vit dans un autre dépôt et reçoit déjà l'analyse au moment où elle
  est faite.
- La purge RGPD des colonnes qui existent déjà et qu'elle oublie (tags, risque, langue, joignabilité) : tâche à
  part.
- La reprise des analyses passées, et tout historique des analyses sur la fiche.

## Les invariants à tenir

- `tenant_id = $1` sur chaque requête neuve ; `tests/signaux-isolation.test.ts` compte les requêtes de
  `PgSignauxStore`.
- Les champs d'analyse ne s'écrivent que par l'analyse : aucune route, aucun import, aucune écriture de l'API,
  aucun outil d'agent ne peut les toucher. Un test le tient.
- `null` n'est pas 0 : une satisfaction de 0 est une mesure valide, qui alarme.
- Une migration qui ajoute une colonne écrite par le code passe AVANT ce code ; un écran part APRÈS l'API qui
  porte sa route.

## Méthode de livraison

**Implémenteur par lot, relecture humaine du diff, une relecture indépendante par lot** (un rouge = ce qui casse
la production). La raison : le chantier emprunte des chemins de production (écriture de l'analyse, ciblage d'une
campagne, déclencheur d'automation, purge RGPD, migration avec index) et porte des invariants invisibles (index
partiels, CHECK recopiés, règle « dernière »).

Ordre : lot 1 (migration, puis API et worker, puis console), lot 2, lot 3, lot 4. Chaque lot se déploie avant que
le suivant commence.

## L'essai réel qui clôt le chantier

Sur l'espace d'essai, avec le téléphone de Julien :

1. Un message mécontent ; après l'analyse, la section « Dernière analyse » de la fiche montre les valeurs.
2. Le filtre « sentiment négatif, urgence ≥ 7 » trouve la fiche, dans la liste et dans le ciblage d'une campagne.
3. « Le sentiment devient négatif » part une fois, puis ne repart pas dans la semaine.
4. Un connecteur et les signaux envoient les vraies valeurs à l'outil branché.
5. L'agent IA qui a l'outil « Lire la fiche » sait que le contact est mécontent.
6. Une fois la conversation effacée, la fiche garde ses valeurs et le résumé disparaît.

## Les amendements du 2026-09-30

Apportés par la cartographie du code qui a précédé le plan (quatre lecteurs, un par lot, lecture seule). Plan :
`docs/superpowers/plans/2026-09-30-fiche-unique.md`.

1. **Les clés réservées ne passent PAS par `SYSTEM_FIELD_KEYS`.** Cette liste alimente les variables de message
   (qui ne doivent pas recevoir l'analyse), est tenue égale à la liste de la console par `tests/web-codes.test.ts`,
   ferait résoudre `fld_x_sys_analyse_sentiment` en champ texte écrit dans le jsonb, et rend 403 en suppression,
   ce qui rendrait indélébile un doublon déjà créé. Un ensemble séparé, consulté par la création de champ,
   l'import CSV et l'upsert de l'API.
2. **Le résumé suit `analyse_conversation_id` quand la copie existe, sinon la règle actuelle.** Sans ce repli,
   faute de reprise (décision 6), tous les résumés disparaîtraient de toutes les fiches au déploiement.
   `analyse_conversation_id` est gardée : sans elle, les codes et le résumé pourraient venir de deux analyses
   différentes.
3. **`analyse_conversation_id` porte un index partiel**, construit `CONCURRENTLY` dans une migration à part :
   sinon chaque conversation effacée (rétention, purge) parcourt `contacts` pour appliquer le `set null`.
4. **« Périmée » compare le plus récent message des fils du contact à `analyse_fenetre_fin`**, jamais
   `last_message_at`, posé par `now()` à chaque écriture : toutes les fiches paraîtraient périmées.
5. **`save` rend la copie faite (ancienne et nouvelle valeurs), ou `null`.** Le déclencheur « devient » du lot 3
   s'en sert, sans rouvrir une transaction de production déjà relue. Une fenêtre d'analyse absente : pas de copie.
6. **Les filtres d'analyse passent par `fieldFilters`**, avec six opérateurs neufs, et non par des membres neufs de
   `ContactFilters` : un membre inconnu serait IGNORÉ par un serveur plus ancien, donc l'audience d'une campagne
   deviendrait l'espace entier. Une valeur ou un opérateur invalide est refusé, jamais ignoré. La console garde les
   opérateurs neufs quand elle reprend un brouillon de campagne.
7. **Le bloc Condition lit l'analyse dans un membre SÉPARÉ du contexte**, jamais dans `fields`, que la fonction JS
   d'un scénario reçoit.
8. **Connecteurs** : une origine `fiche` ; les variables enregistrées (`contact:*`, `systeme:analyse_*`) sont
   réécrites à la lecture, sans reprise ; une lecture unique de la fiche remplace `analyseDuContact` et devient une
   dépendance REQUISE. `CHAMPS_CONTACT_AUTORISES` n'est pas élargie (paramètres d'outil et MCP la lisent).
9. **Une route neuve pour la liste** (`GET /tenants/:tenantId/champs-fiche`). `/user-fields` n'est pas enrichie :
   dix écrans l'appellent, dont les sélecteurs de variables de message.
10. **API** : `lastAnalysis` envoyé en écriture est ignoré comme `engagementRisk`, pas refusé : refuser casserait
    l'aller-retour lecture puis écriture d'un intégrateur.
11. **L'anti-rebond est réglable À L'ÉCRAN** : il ne l'est aujourd'hui que par l'API, et la décision 13 le veut
    réglable.
12. **L'agent IA reçoit l'analyse par une lecture propre à l'outil « Lire la fiche »**, pas par la projection du
    contact : la projection part aussi vers les connecteurs, qui ne doivent rien recevoir de plus.
13. **Nommer les trois nouveaux attributs de signaux avant le package Salesforce v0.1** : un package géré fige ses
    noms de champs une fois publié.
