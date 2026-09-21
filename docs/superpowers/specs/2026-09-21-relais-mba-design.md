# Le relais du Meta Business Agent : Meta appelle Engage Me, Engage Me appelle le client

**Date** : 2026-09-21. **Statut** : design validé par Julien le 2026-09-21, spec à relire.

## Le problème

Julien a exposé à l'agent de Meta l'outil `add_tag` (« Le client demande à rajouter une étiquette »),
bâti sur l'appel `testadd` : `POST /subscriber/add-tag`, corps `{"user_ns":"{{user}}","tag_ns":"{{tag}}"}`,
la valeur `tag` venant du champ `tag_ns` du mini-CRM. À la demande « ajoute-moi une étiquette », l'agent de
Meta a répondu qu'il ne pouvait pas le faire, puis a transféré à l'équipe.

Deux causes, la seconde étant la vraie :

1. La publication n'envoyait chez Meta que `{method, path}`. L'outil y existait SANS corps. (Correctif
   immédiat livré et déployé le même jour, `e5b660b` : un tel outil n'est plus publié.)
2. Meta appelle le système du client EN DIRECT, depuis l'adresse de base du connecteur. Il ne lit pas notre
   mini-CRM et ne sait remplir une valeur que de trois façons : extraction par son modèle, valeur fixe, ou
   l'une de trois macros (`WHATSAPP_PHONE_NUMBER`, `WHATSAPP_IDENTITY_HASH`, `WHATSAPP_CURRENT_STATUS_ID`).
   Aucune ne donne un champ personnalisé du contact.

## Le principe (arbitré par Julien le 2026-09-21)

**Tools > Connecteurs API reste le SEUL endroit où l'on déclare un appel.** Quand on présente un outil à
l'agent de Meta, la publication change sa destination : Meta appelle Engage Me, et Engage Me fait l'appel
tel qu'il est déclaré, exactement comme pour un agent IA.

Ce que ça apporte en plus de la réparation :

- **Le secret du client ne quitte plus notre serveur.** Aujourd'hui la clé UChat de Julien est posée chez
  Meta, dans le connecteur `testUCHAT`.
- **Les appels du MBA passent par les mêmes gardes et le même journal** que ceux d'un agent IA.
- Les outils MCP deviennent présentables au MBA plus tard, par la même route (hors de ce chantier).

## Les arbitrages

| Question | Décision de Julien |
|---|---|
| Périmètre | Les appels de Tools > Connecteurs API seulement. Les outils MCP viendront dans un chantier suivant. |
| Ce que l'agent de Meta lit de la réponse | **La réponse entière**, bornée en taille. Julien craint qu'un modèle qui ne voit rien conclue à un échec et transfère à un humain. La réponse porte en plus un `succes: true` explicite, pour qu'une réponse vide (un 204) ne se lise jamais comme un échec. |
| Bascule des outils déjà exposés | Aucune mécanique : Julien retire l'outil assigné au MBA, et le réassignera une fois le relais en production. La réconciliation fait le reste. |
| La clé que Meta présente | Une **clé d'API de l'espace**, visible dans sa liste sous le nom « Agent de Meta », créée automatiquement à la publication. |

## 1. Ce qui part chez Meta

### Un connecteur par espace, plus un par source

Les connecteurs cessent de suivre les sources. Un espace qui a AU MOINS un outil exposé au MBA reçoit
**un seul connecteur chez Meta**, nommé `EngageMe` (le nom doit passer `NOM_CONNECTEUR_META_RE`, lettres,
chiffres et tiret bas) :

- `base_url` = `PUBLIC_API_URL` suivi de `/mba/relais` (en production `https://api.messagingme.app/mba/relais`).
  `PUBLIC_API_URL` vide : la publication refuse en 409, en le disant, plutôt que de publier une adresse fausse.
- `auth_type: API_KEY`, `auth_config.api_key.headers` = `Authorization`, préfixe `Bearer `, valeur = la clé
  « Agent de Meta » (section 2).

Un espace sans aucun outil exposé n'a AUCUN connecteur chez Meta. Les connecteurs actuels (un par source,
`testUCHAT` chez Julien) ne portent pas le nom `EngageMe` : la réconciliation par nom les supprime, avec
leurs outils, et l'écran le confirme avant (comportement existant). C'est ce qui retire la clé UChat de
chez Meta.

### Un outil chez Meta par outil exposé

Chaque outil exposé au MBA (`origin: 'http'`, requête présente, consommateur `mba:<numéro>` actif) devient :

- `name` : le nom de l'outil chez nous. `description` : `descriptionPourMeta` (inchangée).
- `request_definition.method` : `POST`, toujours. `path` : `/outils/<id de l'outil>`, un chemin FIXE, sans
  placeholder.
- `request_definition.headers` : un seul, `X-Contact-WhatsApp`, de type `string`, avec
  `binding: { kind: 'macro', macro: 'WHATSAPP_PHONE_NUMBER' }`. C'est Meta qui le remplit : le modèle ne
  peut ni le choisir ni l'inventer.
- `request_definition.body` : `content_type: 'application/json'`, `params` = une entrée par variable
  d'origine `modele` de la requête (type repris tel quel, `string` / `number` / `integer` / `boolean`,
  tous acceptés par un `BodyNode` ; description reprise), `required` = les variables `modele` requises.
  Aucune variable `modele` : `body` est omis.
- **Les valeurs permises (`enum`) n'ont pas de champ chez Meta** : elles s'écrivent à la fin de la
  description du paramètre (« Valeurs possibles : a, b, c. »), et le relais les vérifie.
- Les variables `champ`, `contact`, `systeme` et `fixe` n'apparaissent JAMAIS chez Meta : c'est nous qui
  les remplissons.
- `user_auth_required: false`.

### Ce qui disparaît

`pertesChezMeta`, `OutilNonPubliable` et le champ `nonPubliables` de la route, livrés le matin même : tout
appel HTTP devient publiable. Le bloc « Pas envoyés chez Meta » de l'écran part avec eux (la console le
tolère déjà absent, puisqu'elle est déployée avant l'API).

### La comparaison du plan

`aChange` compare désormais toute la `request_definition` que nous envoyons (méthode, chemin, en-têtes,
corps), normalisée : on ne compare que les clés que nous envoyons, et une valeur `null` rendue par Meta
vaut une clé absente. ⚠️ La spec de Meta dit « roundtripped » sans garantir la forme rendue : **la
propriété « publier deux fois ne produit aucun geste » se vérifie sur le vrai compte à l'essai réel**, pas
seulement en test.

## 2. La clé « Agent de Meta »

- Une ligne de `api_keys` (mécanisme de l'API publique, migration 0035), nommée « Agent de Meta », avec le
  seul droit **`mba:relais`**. Stockée hachée comme toutes les autres, visible et révocable dans la liste des
  clés de l'espace.
- 🔴 **`mba:relais` n'est PAS attribuable depuis l'écran ni par la route d'administration des clés.** Avec
  une telle clé, on appelle les outils de l'espace au nom de n'importe lequel de ses contacts, puisque c'est
  l'en-tête qui désigne le contact. Seule la publication en crée une. Les droits proposés au client restent
  `VALID_API_SCOPES`.
- **On retient quelle clé est posée chez Meta**, parce que Meta ne rend jamais un secret et que nous ne
  gardons que l'empreinte : colonne `tenant_settings.mba_relais_cle_id` (`uuid`, nullable, clé étrangère
  vers `api_keys(id)`, `on delete set null`). Même principe que `secretPublie` (0129).
- Le plan pose la clé (geste `cle_poser`) quand la colonne est vide ou désigne une clé révoquée. Le geste,
  dans cet ordre : créer la nouvelle clé, modifier le connecteur chez Meta avec elle, écrire la colonne
  APRÈS l'accusé de Meta, révoquer l'ancienne. Si Meta refuse, la nouvelle clé est révoquée tout de suite
  (rien d'orphelin). La création du connecteur porte sa clé de la même façon.

## 3. Le relais

`POST /mba/relais/outils/:outilId`, monté dans un module de classe **`cle-api`** : il passe par
`makeRequireApiKey` (format, empreinte, espace verrouillé, plafond par clé `API_KEY_RATE_LIMIT_MAX`), puis
exige le droit `mba:relais`.

Dans l'ordre :

1. **L'espace** vient de la clé (`req.auth.tenantId`), jamais de l'adresse ni du corps.
2. **L'outil** : `outilId` doit être un outil de CET espace, `origin: 'http'`, avec sa requête, et exposé ET
   actif pour `mba:<numéro de l'espace>` (`listActifsConsommateur`). Sinon, refus.
3. **Le contact** : l'en-tête `X-Contact-WhatsApp`, ramené à ses chiffres (un `+`, des espaces ou des
   tirets sont retirés ; une valeur qui n'a pas la forme d'un numéro est gardée telle quelle, c'est peut-être
   un BSUID). Recherche par `getContactStateByWaId`, qui sait déjà trouver `+33...`, `33...` et un BSUID. En-tête
   absent ou contact introuvable : refus. **On n'appelle jamais le système du client sans contact identifié.**
4. **Les valeurs du modèle** : le corps JSON est validé par Zod (`safeParse`) contre les variables `modele`
   déclarées : type, valeurs permises, requises. Une clé inconnue est ignorée. Un corps invalide : refus qui
   nomme la variable fautive.
5. **L'appel** passe par `creerAppelConnecteur`, construit comme pour l'agent IA (sources, requêtes,
   `derniereSaisie`, `fuseau`), avec : le contact projeté `{nom, tags, champs}`, `args` = les valeurs du
   modèle, `maxBytes` et `timeoutMs` de l'outil, et `journal: { source: 'mba', nom, sessionId: null, toolId }`.
6. **La lecture** : un nouveau mode `{ nature: 'entier' }` dans `AppelConnecteur.lecture`, qui rend le corps
   entier, borné à `maxBytes`. C'est le seul ajout au point de passage partagé ; les trois autres appelants
   n'en changent pas.
7. **La réponse à Meta**, toujours en JSON :
   - succès : `200 { succes: true, statut: <code HTTP du client>, reponse: <corps, JSON ou texte> }` ;
   - échec métier (outil non exposé, contact inconnu, valeur invalide, refus ou panne du système du client) :
     `200 { succes: false, erreur: "<phrase claire, en français>" }`, pour que le modèle de Meta sache quoi
     dire au client au lieu de rencontrer une erreur de transport ;
   - clé absente, fausse ou sans le droit : le `401` / `403` de la vérification existante.

Ce que le relais ne fait pas, délibérément, parce que l'agent IA ne le fait pas non plus : pas de garde
opt-out sur un appel de connecteur (elle garde les ENVOIS), pas de validation humaine sur une action
irréversible (Meta n'a pas ce réglage, et l'écran le dit déjà).

## 4. Ce qui se mesure au premier essai réel

Aucun de ces points ne se tranche sur papier ; la documentation de Meta est muette sur les trois.

- **Le contenu de `WHATSAPP_PHONE_NUMBER`** : avec ou sans `+`, rempli ou non pour un client qui n'a qu'un
  nom d'utilisateur WhatsApp, rempli ou non dans le bac à sable de Meta. Le relais journalise la FORME de
  l'en-tête (longueur, présence d'un `+`, chiffres seuls ou non), **jamais sa valeur**, jusqu'à ce que la
  mesure soit faite ; la ligne est retirée ensuite.
- **Ce que Meta fait d'une réponse `succes: false`** : la transmet-il à son modèle ? C'est la raison du
  choix du 200.
- **L'idempotence sur le vrai compte** (section 1).

Si la macro n'est jamais remplie, le relais refuse tous les appels en le disant, et rien d'autre ne casse :
c'est le seul scénario d'impasse, et il se voit au premier essai.

## 5. Données

Migration **0161** (le numéro fait foi dans `CLAUDE.md`, la base tranche), à appliquer AVANT le
déploiement :

- `agent_tool_calls_source_check` accepte `'mba'`. Elle RELÂCHE un CHECK : l'ancien code y survit.
- `tenant_settings.mba_relais_cle_id uuid null references api_keys(id) on delete set null`. Le nouveau code
  l'écrit.

`SOURCES_APPEL` (`src/agent/catalog.ts`) gagne `'mba'`, pour que le journal des erreurs le lise.

## 6. L'écran

- Le formulaire « outil pour l'agent de Meta » (`OutilPourMba`) dit ce qu'Engage Me remplira lui-même
  (`resumeEnvoi` sur la requête choisie), et ce que l'agent de Meta devra demander au client (les variables
  `modele`). Pas de question « pousse ou intègre » : la réponse entière est transmise (arbitrage).
- Le commentaire qui affirme « Meta appelle le système du client EN DIRECT » devient faux et est réécrit.
- La liste des clés d'API affiche « Agent de Meta » avec un libellé lisible pour `mba:relais`.

## 7. Tests

- **Pur** : normalisation du numéro, validation des valeurs du modèle, construction du corps d'outil Meta
  (en-tête lié à la macro, variables `modele` seules, valeurs permises dans la description), mode de lecture
  `entier`, plan (connecteur unique, suppression des anciens, `cle_poser`, idempotence).
- **Route, avec des faux qui refusent ce que le vrai refuse** : pas de clé, mauvais droit, outil d'un autre
  espace, outil non exposé, en-tête absent, contact inconnu, valeur invalide, succès, échec du client.
  🔴 L'isolation entre espaces se prouve par un outil d'un AUTRE espace appelé avec une clé valide.
- **Intégration (CI seulement)** : la colonne, le CHECK élargi, une ligne de journal `source = 'mba'` écrite
  et relue.
- Chaque garde vérifiée par mutation, câblage compris.

## 8. Méthode de livraison et essai réel

**Implémentation par lot, avec revue du diff** : une porte publique neuve, une publication chez Meta et des
appels au système du client, avec un invariant d'isolation entre espaces.

1. **Lot 1** : migration 0161, `source: 'mba'`, lecture `entier`, droit `mba:relais`, le module du relais et
   ses tests. Déployable seul : personne ne l'appelle encore.
2. **Lot 2** : la publication traduite (connecteur unique, cycle de vie de la clé, corps d'outil, comparaison)
   et le retrait de `pertesChezMeta`.
3. **Lot 3** : l'écran, la documentation (`features.md`, `documentation.md`, fiche d'aide si elle parle de
   la publication).

**L'essai qui clôt le chantier**, par Julien : réassigner `add_tag` à l'agent de Meta, cliquer « Envoyer »
(la confirmation doit montrer la suppression de `testUCHAT` et la création d'`EngageMe`), puis demander sur
WhatsApp « ajoute-moi l'étiquette X ». L'étiquette doit apparaître sur sa fiche UChat, et l'appel dans le
journal sous l'appelant `mba`. Puis un second « Envoyer » qui ne doit produire aucun geste.
