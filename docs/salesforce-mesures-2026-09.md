# App Salesforce : les mesures du lot L0 (septembre 2026)

Document de travail daté. Il consigne ce que le lot L0 du plan
(`docs/superpowers/plans/2026-09-26-app-salesforce.md`) a mesuré sur de vraies orgs, les 26 et 27 septembre
2026, avant toute ligne de code de production. Il ne fait pas autorité sur le présent : la spec et le plan
reprennent ce qui en découle. Aucun secret ici.

## Les orgs

| Rôle | Org | Remarque |
|---|---|---|
| Dev Hub | Developer Edition `00Dg800000KLHAVEA5` | Dev Hub et packages de seconde génération activés. Limites : 3 scratch orgs actives, 6 par jour, 6 versions de package validées par jour, 15 000 appels d'API par jour. |
| Namespace | Developer Edition distincte | `engageme` était PRIS ; le repli convenu `engagemeapp` est réservé. |
| Client | Scratch org Enterprise `00DQL00000ch3nx2AA`, comptes personnels activés | Créée depuis le Dev Hub (choix de Julien : pas de troisième org), valable jusqu'au 2026-10-26. |

Le projet Salesforce de mesure est jetable et vit HORS du dépôt (dossier de travail temporaire).

## 🔴 Le blocage : le namespace ne se relie pas au Dev Hub

Le bouton « Lier un espace de noms » du Dev Hub ouvre une fenêtre OAuth vers `login.salesforce.com` SANS
paramètre `code_challenge`, et Salesforce la refuse aussitôt : `error=invalid_request&error_description=
missing required code challenge`, avant même de demander un identifiant.

- La demande est faite par l'application de connexion « SalesforceDX Namespace Registry », que Salesforce crée
  dans le Dev Hub à l'activation du Dev Hub.
- Sur cette application, « Demander l'extension PKCE » est cochée ET verrouillée (« Pour changer ce paramètre
  obligatoire, contactez le Support »). Le réglage PKCE de l'org est, lui, désactivé : il n'est pas en cause. Les
  politiques de l'application n'en portent aucun.
- La liaison ne se fait pas par l'API : l'objet `NamespaceRegistry` est créable, mais aucun de ses champs.

**Conclusion** : une incohérence de Salesforce entre sa fonction de liaison et l'exigence PKCE qu'il impose aux
orgs neuves. Nous ne pouvons pas la contourner. Une Developer Edition n'a pas de support par ticket : il faut
passer par la communauté Trailblazer ou par un contact Salesforce. **Sans cette liaison, aucun package géré
2GP n'est possible**, donc les mesures 1, 5 (protection du secret), 8 (promotion) et 10 restent ouvertes.

## Le message pour Salesforce

Prêt à poster sur la communauté Trailblazer, ou à envoyer à un contact chez Salesforce :

> **Link Namespace fails on a new Dev Hub: "missing required code challenge"**
> On a Developer Edition org created in September 2026, with Dev Hub and 2GP enabled, clicking "Link Namespace"
> in Namespace Registries opens a popup to `login.salesforce.com/services/oauth2/authorize` with no
> `code_challenge` parameter. It fails immediately with `error=invalid_request&error_description=missing required
> code challenge`, before any login prompt. The "SalesforceDX Namespace Registry" connected app auto-created in
> the Dev Hub has "Require PKCE" checked and locked ("contact Support to change this required setting"). The
> org-level PKCE setting is off. How can we link our namespace org, or can PKCE be relaxed on this app?

## Les résultats

### Recherche d'une fiche par téléphone (mesure 2) : la plus risquée, et résolue

Sept fiches (Contact et Lead) avec des numéros saisis en formats réels, cherchées par la recherche
plein texte de Salesforce (`FIND ... IN PHONE FIELDS`) sous quatre formes :

| Fiche (format saisi) | `+33…` | `33…` | `06…` | `6…` |
|---|---|---|---|---|
| `06 12 34 56 78` | non | non | OUI (après indexation) | n/d |
| `+33 6 12 34 56 79` | non | OUI | non | OUI |
| `+33612345680` | non | OUI | OUI | OUI |
| `0033 6 12 34 56 81` | non | OUI | non | non |
| `06.12.34.56.82` | non | non | OUI | OUI |
| `(06) 12-34-56-83` | non | non | OUI | OUI |
| `+33 (0)6 12 34 56 84` | non | OUI | OUI | OUI |

- **Aucune forme seule ne retrouve tout.** La requête combinée `FIND {"33XXXXXXXXX" OR "0XXXXXXXXX"}`
  retrouve les sept formats, sans exception : c'est l'algorithme de L2.
- **Le `+` est un caractère spécial** de la recherche : `+33…` ne retrouve jamais rien, même la fiche saisie
  exactement ainsi. Échappé (`\+33…`), il fonctionne, sans rien apporter de plus.
- **L'indexation n'est pas immédiate, et son délai varie** : 13 secondes pour une fiche neuve le 27 septembre,
  mais PLUS DE 10 MINUTES pour la toute première fiche de l'org la veille (retrouvée le lendemain). La recherche ne
  peut donc jamais servir seule à décider « inconnu, je crée ». C'est pourquoi le lien est écrit dès la première
  correspondance, et pourquoi l'upsert par External ID (mesure 9) est la vraie défense contre les doublons.
- Numéros étrangers : seule la France a été mesurée ; la construction des formes suit l'indicatif du numéro.

### Idempotence sous rejeu (mesure 9) : pas de table d'idempotence

- **Lead** par un champ External ID unique (`em_contact_id__c`) : deux upserts identiques rendent
  `created: true` puis `created: false`, une seule fiche.
- **Tâche** par un champ External ID posé sur l'objet Activity (`em_event_id__c`) : la plateforme accepte le champ,
  et l'upsert est idempotent de la même façon.
- Donc un job rejoué ne crée ni Lead ni tâche en double ; aucune table d'idempotence chez nous.

### Appel sortant et signature (mesures 6 et vecteur)

- **Le vecteur d'or de `src/lib/signature.ts`** (`tests/signature.test.ts`), recalculé en Apex
  (`Crypto.generateMac('HmacSHA256', ...)`), rend le même hex octet pour octet. On garde notre format, sans
  troisième schéma. Apex donne l'horodatage en millisecondes (`DateTime.now().getTime()`).
- **Une External Credential n'accepte PAS le protocole « NoAuthentication »** (refus au déploiement). Le mode
  « Custom », avec un principal nommé et aucun en-tête, fonctionne ; la Named Credential qui s'appuie dessus
  exige un jeu de permissions qui ouvre l'accès au principal.
- **L'appel Apex vers `https://api.messagingme.app/health`** (par la Named Credential comme par un site
  distant) rend 200 à travers Cloudflare, sans défi (départ depuis un centre de données de Salesforce aux
  États-Unis).

### Droits sur les champs (constat hors liste)

- Dans une org neuve, **`Lead.MobilePhone` n'est lisible par AUCUN profil**, administrateur compris : le champ
  existe mais n'apparaît pas dans la description de l'objet, et une insertion qui le cite échoue en bloc. Le jeu de
  permissions du package doit accorder explicitement la lecture et l'écriture des champs téléphone standards, et
  le code ne doit jamais supposer qu'un champ standard est visible.

### Statuts de membres de Campaign (mesure 7)

- L'insertion par l'API de `CampaignMemberStatus` (« Engage Me : envoyé », « Engage Me : a répondu » avec
  `HasResponded`) fonctionne, et un membre passé à « a répondu » est bien compté comme réponse.
- **Un libellé déjà présent est REFUSÉ** (`FIELD_INTEGRITY_EXCEPTION`) : l'idempotence se tient en lisant les statuts
  de la Campaign avant d'insérer.

### Attribution d'un Lead (mesure 3)

- SANS règle active, l'en-tête `Sforce-Auto-Assign: TRUE` laisse le Lead à l'utilisateur de l'API.
- AVEC une règle active (vers une file d'attente) : en-tête `TRUE` et **absence d'en-tête** donnent tous deux la
  file ; seul l'en-tête `FALSE` laisse le Lead à l'utilisateur de l'API. **L'API REST applique donc la règle active
  PAR DÉFAUT.** Conséquence pour L2 : avec une règle active, on n'écrit aucun propriétaire et on la laisse jouer ;
  sans règle active, on pose le propriétaire de repli.

### Comptes personnels (mesure 4)

- Avec les comptes personnels activés, un **Lead sans société est accepté**, et sa conversion crée un **compte
  personnel** (`IsPersonAccount = true`) dont le contact porte le mobile. La règle de la spec (société vide
  quand l'org a les comptes personnels) tient.

### Noms de champs et adresses (mesure 11)

- Les noms du dictionnaire se déploient tels quels comme noms de champs (le plus long mesuré :
  `em_last_inbound_whatsapp_at__c`).
- Adresses d'org constatées : `*.develop.my.salesforce.com` (Developer Edition) et `*.scratch.my.salesforce.com`
  (scratch) ; toutes finissent par `.my.salesforce.com`.
- **Ce que l'admin colle vraiment** : l'adresse de sa barre de navigation, pas son adresse My Domain. Constaté sur
  les deux orgs Developer Edition. Sur la première, l'interface Lightning montrait
  `orgfarm-83beb5a359-dev-ed.develop.lightning.force.com` pour une adresse My Domain
  `orgfarm-83beb5a359-dev-ed.develop.my.salesforce.com` ; sur la seconde, la Configuration montrait
  `orgfarm-274a3a52c9-dev-ed.develop.my.salesforce-setup.com` pour `orgfarm-274a3a52c9-dev-ed.develop.my.salesforce.com`.
  Même préfixe, même qualificatif, seul le domaine change : c'est la traduction que fait `lireMyDomain`
  (`src/salesforce/my-domain.ts`). Non mesuré : une org de production (sans qualificatif) et une sandbox.

## Ce qui reste ouvert

| Mesure | État |
|---|---|
| 1. Jeton client credentials avec l'app packagée, clé répliquée | Bloquée par la liaison du namespace |
| 5. Secret dans un paramètre protégé | Bloquée (un paramètre n'est « protégé » que dans un package géré) |
| 8. Promotion d'une version 2GP | Bloquée |
| 10. Métadonnées de l'app sans secret ; sandbox rafraîchie | Bloquée |
| Forme de la réponse du jeton (`expires_in`, renouvellement) | Avec la mesure 1 |
