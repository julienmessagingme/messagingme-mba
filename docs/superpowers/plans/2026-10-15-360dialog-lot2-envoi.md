# Plan : 360dialog, lot 2 (un numéro 360dialog sert un espace comme un numéro Meta)

Suite du lot 1 (`7f446c3f`, la réception, prouvée en production le 2026-10-15). Cadrage de Julien le même jour :
périmètre **envois, médias, modèles ET Flows** ; rattachement **par `/ops`** (le bouton client est le lot 3) ;
sur un espace 360dialog, la console **masque** ce qui ne peut pas marcher. Le récit et les mesures : `brain/LEARNINGS.md`
(2026-10-15, « Un numéro 360dialog s'exploite par SA clé et SON hôte »).

## Ce qui est déjà mesuré, et ce qui doit l'être AVANT d'écrire la livraison qui en dépend

Mesuré avec la clé du numéro `1111567578708598` : `POST /messages` (modèle) et `POST /marketing_messages` (MM Lite)
livrent ; `GET /v1/configs/templates` liste ; `GET /health_status` rend numéro, WABA et portefeuille.

À mesurer, une requête chacun, sur le même numéro (rien d'irréversible, un message de test au plus) :
- médias : `POST /media` (envoi), `GET /{media_id}` puis le binaire sur `waba-v2.360dialog.io` à la place de
  `lookaside.fbsbx.com` (doc 360dialog) ; le lien de téléchargement que porte DÉJÀ un webhook entrant ;
- `POST /messages` avec `status: read` (accusé de lecture) et l'indicateur de saisie, si l'Inbox les envoie ;
- modèles : création d'un modèle à EN-TÊTE MÉDIA (quel `header_handle` ? notre envoi passe par l'upload résumable de
  l'appli Meta, qui n'a pas accès à cette WABA) ;
- Flows : liste, création, `assets`, publication (la doc ne montre qu'un drapeau `publish` à la création) ;
- l'arrivée des statuts de modèle : un événement de niveau WABA, que la route du lot 1 NE VERSE PAS (pas de numéro).

**Mesuré le 2026-10-15, avant la livraison A** (scripts de mesure hors dépôt, rien d'irréversible) :
- médias : `POST /media` rend un `id` ; `GET /{id}` rend une URL `lookaside.fbsbx.com` qui ne s'ouvre QUE réécrite sur
  `waba-v2.360dialog.io` avec la clé (binaire identique à l'octet ; en direct, 401) ; `DELETE /{id}` ;
- accusé de lecture et saisie : sans objet, notre code n'en envoie pas ;
- MM Lite avec la forme EXACTE de notre code (`product_policy: CLOUD_API_FALLBACK`, sans `language.policy`) : livré ;
- en-tête média d'un modèle : les modèles à image créés par UChat via 360dialog portent une simple URL publique en
  `header_handle`, sans upload résumable (livraison B) ;
- Flows : tout passe sous `/flows` (`/flows`, `/flows/{id}`, `/flows/{id}/assets` en lecture et en multipart,
  `DELETE /flows/{id}`) ; `publish` et `deprecate` existent sous `/flows/{id}/...` (refus de Meta relayé sur un
  identifiant inventé, pas de 404) ; jamais publié pour la mesure (irréversible) ;
- statuts de modèle : un modèle créé puis approuvé (18:10:04 UTC) n'a RIEN envoyé au webhook du numéro : la livraison B
  les RELÈVE par `GET /v1/configs/templates`, et la route du lot 1 reste telle quelle. Modèle de mesure supprimé ;
- le numéro affiché et le nom vérifié ne se lisent par aucune route avec la clé (404, 403) : facultatifs au rattachement.

## Tâches

**Livraison A : le socle, l'envoi, les médias, le rattachement.**
1. Migration (numéro lu par `npm run migrations` au moment de l'écrire : 0237 et 0238 sont déjà prises en base par le
   lot médias, sans être sur `main`) : `waba_credentials.fournisseur text not null default 'meta'`, CHECK
   `('meta','360dialog')`. Pour `360dialog`, `business_token_enc` porte la clé d'API du NUMÉRO, chiffrée comme un jeton.
   🔴 Une clé 360dialog vaut pour UN numéro : un second numéro sur une WABA 360dialog est refusé au rattachement.
   AVANT le code (le résolveur la lit).
2. Le résolveur (`src/meta/credentials.ts`) rend aussi le fournisseur ; JAMAIS de repli sur le jeton global pour un
   numéro 360dialog (le repli parlerait à Meta, qui refuse en `#200`).
3. La fabrique (`src/meta/factory.ts`) construit, pour `360dialog`, des clients qui implémentent les MÊMES contrats
   que les clients Meta (`MessageSender`, médias) : hôte `waba-v2.360dialog.io`, en-tête `D360-API-KEY`, chemins sans
   version ni `phone_number_id`, `sendMarketing` vers `/marketing_messages`. Les gardes de la fabrique (délié,
   suspendu, quota de modèles, frein de débit) restent communes, et l'intercepteur d'authentification s'applique
   (un 401 de 360dialog invalide la clé comme un 190 invalide un jeton).
4. Les médias : le client médias cesse d'être construit une fois sur le jeton global (`src/index.ts`) pour les
   numéros 360dialog ; téléchargement des médias reçus et envoi des nôtres par 360dialog.
5. 🔴 L'inventaire des chemins qui parlent à Meta POUR un numéro sans passer par l'envoi : statut et palier du numéro,
   paiement bloqué, chiffrage (`src/stats/chiffrage.ts`), liste de l'agent de Meta, `numero-delie`, Embedded Signup.
   Chacun saute un numéro 360dialog ou passe par lui, et un test d'inventaire le tient (comme
   `tests/lib-adresse-privee.test.ts`) : un balayage qui appellerait Meta pour ce numéro le marquerait en panne.
6. `/ops` : rattacher un numéro 360dialog à un espace (clé collée, lue par `GET /health_status` pour le numéro, la
   WABA et le portefeuille, jamais saisis à la main), puis poser son webhook par `/multi_webhook` en GARDANT les
   destinations existantes. Session d'exploitation, trace signée `par`.

Ce que la livraison A laisse FERMÉ pour un espace 360dialog, par construction (`CompteChez360dialog`) : la liste des
modèles (donc un modèle envoyé par un scénario ou une campagne, qui la lit : livraison B), les Flows (C), l'agent de
Meta, le statut du numéro (pastille grise « indisponible », sans alerte). La suppression d'un espace et « Déconnecter
le numéro » SAUTENT les gestes chez Meta et font le reste (purge, détachement), comme pour un jeton invalide ; notre
destination chez 360dialog reste posée (ses webhooks arrivent alors sur un numéro inconnu, rangés puis ignorés) : la
retirer est à décider avec D. L'essai de A ne porte donc que sur les messages libres et les médias reçus.

⚠️ Non mesuré, à mesurer avant d'attacher un VRAI client : que 360dialog ne rende pas un 401 pour un refus de
fonctionnalité sur `/marketing_messages` (compte sans MM Lite) ; l'intercepteur invaliderait alors la clé.

**Livraison B : les modèles.** Liste, création, suppression, statut par `/v1/configs/templates`, derrière le contrat
de `MetaTemplateClient`. Les statuts de modèle se RELÈVENT par `GET /v1/configs/templates` (la mesure a tranché :
le webhook du numéro ne les reçoit pas). L'en-tête média se pose par une URL publique en `header_handle`.

**Livraison C : les Flows**, derrière le contrat de `MetaFlowClient`, dans la limite de ce que la mesure montre.

**Livraison D : la console.** `fournisseur` exposé par l'API du compte ; sur un espace 360dialog, la console masque
l'agent de Meta, « Renouveler la connexion Meta » et la connexion par Embedded Signup. L'API d'abord, l'écran après
son déploiement (CLAUDE.md, « un écran qui appelle une route neuve casse dès le push »).

## Tests attendus

- Un espace 360dialog envoie texte, modèle et MM Lite vers `waba-v2.360dialog.io` avec `D360-API-KEY`, et
  AUCUN appel ne part vers `graph.facebook.com` (faux transport qui refuse ce domaine).
- Un espace Meta est inchangé (les tests existants de la fabrique, intacts).
- Le résolveur ne retombe jamais sur le jeton global pour un numéro 360dialog (vérifié dans les deux sens).
- Les gardes communes (STOP, délié, suspendu, quota) s'appliquent à un espace 360dialog.
- L'inventaire du point 5 casse si un chemin qui parle à Meta pour un numéro est ajouté sans décider du cas 360dialog.
- Le rattachement par `/ops` refuse une clé que 360dialog refuse, un numéro déjà rattaché, une seconde ligne sur une
  WABA 360dialog ; et il conserve la destination UChat.
- Auto-attaque : la route `/ops` neuve est de classe `session-ops`.

## Ordre de déploiement

Par livraison : migration A seule, appliquée et relue en base, AVANT le code qui la lit ; puis API et worker ; la
console (D) après l'API qui porte ses champs. Chaque livraison : CI lue job par job, `up`, essai réel.

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, livraison par livraison, avec UNE relecture indépendante en fin de
chaque livraison. Raison : c'est le chemin d'ENVOI de la production (un message parti ne se rappelle pas), avec une
migration, et des invariants que le compilateur ne voit pas (jamais de repli sur le jeton global, aucun balayage
qui parle à Meta pour un numéro 360dialog, la destination UChat conservée).

Aucune livraison n'est close sur des tests verts : chacune se termine par un essai réel sur le numéro
`1111567578708598`, avec le portable de Julien :

- A : le numéro `1111567578708598` rattaché par `/ops` à un espace de test SANS agent ni scénario actif ; Julien écrit
  depuis son portable, le message apparaît dans l'Inbox ; une réponse de l'Inbox (texte : l'Inbox n'envoie que du
  texte) arrive sur son portable ; une photo envoyée par Julien s'affiche dans l'Inbox. UChat reçoit toujours. L'envoi
  d'un média (`Media360dialogClient.uploadForSend`) n'est atteint que par le bloc « message rapide » d'un scénario :
  il s'essaie avec la livraison B, quand un scénario d'essai pourra tourner sur l'espace.
- B : un modèle créé depuis la console, approuvé, envoyé.
- C : un Flow publié et rempli depuis le portable de Julien.
- D : la console de l'espace de test ne montre ni l'agent de Meta ni « Renouveler la connexion Meta ».
