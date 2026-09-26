# L'app Salesforce d'Engage Me : le pendant de HubSpot pour le CRM « core »

**Date** : 2026-09-26. **Statut** : design validé par Julien le 2026-09-26 (cinq rondes de questions, trois
sections validées une à une), puis AMENDÉ le même jour après la cartographie du code qui a précédé le plan
(sept lecteurs, lecture seule) : dix arbitrages de plus (§ « Les amendements du 2026-09-26 ») et deux
affirmations corrigées. Plan : `docs/superpowers/plans/2026-09-26-app-salesforce.md`.

## Le problème

Engage Me a une intégration HubSpot complète (le connecteur `mm-hubspot`) et une intégration Batch (le
dictionnaire de signaux, `src/signaux/`). Il n'a rien pour Salesforce, qui est le CRM des grands comptes que
la prospection vise. Julien veut « un truc un peu comme HubSpot » : une offre de prospection, sans client
signé à ce jour, donc générique dès le départ.

**On parle du Salesforce « core »** (Sales Cloud, Service Cloud : Leads, Contacts, Opportunités, Campaigns).
Salesforce Marketing Cloud (SFMC) est un AUTRE produit, avec une autre API et une autre clé (un Installed
Package) : c'est le connecteur Journey Builder d'EDH (`messagingme-sfmc-connector`), hors de cette spec.

## Ce qui a été vérifié, et qui corrige la conversation « Intégration Batch »

Cette conversation (2026-09-25) concluait « External Client App, JWT, aucun partenariat, rien à installer ».
Le premier et le dernier point sont faux depuis Spring '26, vérifié le 2026-09-25 :

1. **Plus de Connected App neuve.** Spring '26 interdit leur création, par l'interface comme par l'API, sauf
   pendant l'installation d'un package ; le support peut encore la rouvrir, et ne le pourra plus dans les
   versions suivantes. Les Connected Apps existantes continuent de marcher.
2. **Une External Client App est fermée par défaut.** Une app « locale » ne sert que dans l'org qui l'a créée.
   Pour qu'une org cliente l'utilise, elle doit y être INSTALLÉE, par un package géré de deuxième génération
   (2GP) : l'app est créée dans notre Dev Hub, sa clé globale est répliquée par Salesforce vers les orgs
   abonnées, et le client ne copie jamais ni clé ni secret.
3. **Aucun partenariat n'est requis pour ça.** Le programme ISV et la security review ne servent qu'à être
   LISTÉ sur l'AppExchange. Un package s'installe aussi par un lien privé.
4. **Il y a donc toujours un geste de l'admin Salesforce chez le client**, contrairement à HubSpot.
5. **Prérequis côté client** : édition Enterprise, Unlimited ou Performance (Professional seulement avec l'option
   API payante, Essentials jamais).
6. **Une licence « Salesforce Integration »** (utilisateur limité à l'API, sans accès à l'interface) est offerte
   en cinq exemplaires en Enterprise, Unlimited et Performance.
7. **Un Rapport lu par l'API s'arrête aux 2 000 premières lignes.** Une Campaign (ses membres en SOQL) et une vue
   de liste (l'API rend sa requête SOQL) n'ont pas cette limite.

Sources : [création des Connected Apps en Spring '26](https://help.salesforce.com/s/articleView?id=005228017&language=en_US&type=1),
[External Client Apps](https://help.salesforce.com/s/articleView?language=en_US&id=xcloud.external_client_apps.htm&type=5),
[packager une External Client App](https://help.salesforce.com/s/articleView?id=xcloud.configure_packageable_external_client_apps.htm&language=en_US&type=5),
[comparatif Connected App / External Client App](https://www.concret.io/blog/salesforce-connected-app-vs-external-client-app),
[External Client App en 2GP](https://sliick.com/articles/salesforce-external-client-app-2gp-packaging-guide/),
[licences Salesforce Integration](https://www.salesforceben.com/salesforce-release-5-free-integration-user-licenses/),
[utilisateur d'intégration et client credentials](https://developer.salesforce.com/blogs/2024/02/invoke-rest-apis-with-the-salesforce-integration-user-and-oauth-client-credentials),
[limites de l'API Rapports](https://developer.salesforce.com/docs/atlas.en-us.api_analytics.meta/api_analytics/sforce_analytics_rest_api_limits_limitations.htm).

## Les décisions de Julien

| Question | Décision |
|---|---|
| Qui tire le chantier | Une offre de prospection, sans client signé : générique dès le V1. |
| Périmètre V1 | Les quatre capacités : remonter le quali, segment vers campagne, étape vers scénario, carte sur la fiche. |
| Contact inconnu | **Toujours un Lead**, sans réglage. |
| Installation | **Un package Engage Me** (2GP, namespace `engageme`), installé par lien. |
| Historique dans Salesforce | Une activité (tâche terminée) par conversation analysée. L'état courant vit dans des champs. |
| Actions de la carte | Voir la conversation, créer une opportunité, planifier un rappel, envoyer un WhatsApp. |
| Sources de segment | Campaign, vue de liste, rapport (plafonné à 2 000 lignes). |
| Consentement d'un segment | Lu dans un champ Salesforce désigné par le client ; sans champ, jamais présumé. Un STOP chez nous gagne toujours. ⚠️ C'est une règle NEUVE : HubSpot, lui, présume l'opt-in (`importHubspotList` pose `optIn: true`), contrairement à ce que disait la première version de cette ligne. |
| Déclencheurs | Étape d'opportunité, statut de Lead, statut de membre de Campaign. |
| Identité dans l'org | **Un utilisateur d'intégration dédié**, en client credentials. Jamais l'admin qui clique. |
| Envoi depuis la fiche | Une liste autorisée par l'admin Engage Me (templates et scénarios). |
| AppExchange | Lien privé au V1, package écrit pour passer la review ; listing dans un lot ultérieur. |
| Réponses à un envoi depuis la fiche | Dans l'Inbox (affectée au membre qui a l'e-mail du commercial) et une tâche « a répondu » dans Salesforce. |
| Historique à la connexion | Rien de rétroactif : seules les conversations analysées après la connexion remontent. |
| STOP | Écrit aussi dans le champ de consentement du client. |
| Propriétaire d'un Lead créé | La règle d'attribution active de l'org ; sans règle active, un propriétaire de repli choisi dans Engage Me. |
| Statuts de membres de Campaign | Oui : « WhatsApp envoyé » et « A répondu » (ce dernier compté comme réponse). |
| Sens Salesforce vers Engage Me | **Salesforce appelle notre API** (voir ci-dessous). |
| Emplacement | **Dans Engage Me**, données dans un schéma à part, extractible. |
| Namespace | `engageme` (repli `engagemeapp` s'il est pris). |

### Les amendements du 2026-09-26

La cartographie du code a montré des endroits où la première version contredisait le dépôt. Julien a tranché
ceux qui changent le produit ; les autres sont des décisions techniques, écrites ici pour qu'on ne les
retrouve pas en revue.

| Question | Décision |
|---|---|
| Moment de lecture d'un segment | **À la création**, comme HubSpot (étape Audience), et non plus au lancement : tout le moteur fige les destinataires à la création, lire au lancement aurait été un mécanisme neuf. Une campagne planifiée part avec les membres du jour de sa création. |
| Envoi depuis la fiche | **Une file dédiée** aux envois un par un, hors de `campaign-run` (sérialisée par espace) : sans elle, le message du commercial attendrait la fin d'une campagne en cours. |
| « Non » dans le champ de consentement | **N'écrit rien chez nous** : le contact reste sans consentement, donc exclu du marketing. Aucun nouveau chemin d'opt-out, aucun écho. |
| Résumé de conversation dans l'activité | **Une option décochée par défaut**, comme Batch (propos du client). |
| Consentement et déclencheurs | **Comme les autres déclencheurs** : seul un STOP bloque un scénario démarré par une transition. |
| Purge RGPD d'un contact | **Notre côté seulement** : on oublie le lien et nos journaux ; rien n'est touché dans le Salesforce du client. |
| Journal des erreurs | **Il nomme l'outil**, pour Salesforce ET pour Batch (Julien : « et pour Batch pareil alors »). La documentation publique des signaux, elle, continue de ne nommer aucun outil. |
| Campagnes nées d'un envoi depuis la fiche | **Visibles**, préfixées « [Salesforce] », comme « [API] ». |
| Plafond des appels entrants | **60 par minute et par org**, compté à part pour les notifications et pour les envois ; 0 le désactive. |
| Statuts de membres de Campaign | **« Engage Me : envoyé » et « Engage Me : a répondu »** (ce dernier compté comme réponse). |

Décisions techniques prises sans arbitrage :

- **L'interrupteur d'espace** vit dans `tenant_settings.salesforce_actif`, comme `hubspot_actif` (0179) : c'est un
  réglage de l'espace, et `salesforce.orgs` n'a pas de ligne avant la connexion.
- **Les déclencheurs Apex ignorent les modifications faites par l'utilisateur d'intégration.** Sans ça, nos propres
  statuts de membres relanceraient une automation par destinataire : un chemin de masse qui émet, interdit.
- **Une opportunité CRÉÉE à une étape surveillée ne déclenche rien** : seul un changement d'étape compte.
- **La signature réutilise `verifyRequest`** (`src/lib/signature.ts`), sans troisième format ; le plafond par org se
  prend APRÈS une signature valide (l'identifiant d'org n'est pas un secret, il se voit partout dans Salesforce).
- **Un envoi depuis la fiche porte une clé d'idempotence par clic** : une requête signée rejouée dans la fenêtre de
  5 minutes n'envoie pas deux fois.
- **« A répondu »** (membre de Campaign comme envoi depuis la fiche) suit la règle du funnel : 7 jours, le dernier
  envoi gagne (`FENETRE_IMPUTATION`, `src/stats/store.pg.ts`).
- **Un STOP RCS n'écrit pas** le champ de consentement WhatsApp du client (seulement notre champ RCS).
- **Le statut délivré / lu / échec** d'une activité n'est suivi que pour un template ; pour un scénario, l'activité
  dit « scénario démarré » (un scénario parti par campagne n'a pas de wamid rattachable).
- **Un déclencheur sur un membre de Campaign vise UNE Campaign** : les statuts de membres sont définis par Campaign.

### Salesforce appelle notre API : ce que le choix achète et ce qu'il coûte

La recommandation était l'inverse (Salesforce publie un événement, Engage Me s'abonne par la Pub/Sub API).
Julien a retenu l'appel direct. **Ce qu'il achète** : l'envoi depuis la fiche est SYNCHRONE, le commercial lit
« parti » ou le motif du refus dans la seconde, et Engage Me n'a aucun processus d'écoute à tenir. **Ce qu'il
coûte, et que cette spec paie explicitement** :

- un **secret par org** vit chez le client, dans un paramètre PROTÉGÉ du package (illisible même par l'admin) ;
- une **boîte d'envoi Apex** dans l'org, sans laquelle une panne de notre API perdrait des changements d'étape.

### Dans Engage Me, pas dans un `mm-salesforce`

`mm-hubspot` est un service séparé pour des raisons d'époque, et il le paie : Engage Me lit ses tables en
cross-schema (`src/account/store.pg.ts`, `mmhs.tenant_portals`), et son contrat d'ingestion transporte
l'analyse sans la valider. Le §8 de `docs/ARCHITECTURE-CIBLE.md` pose que **le grain du coût est le
programme, pas le client** : un programme de plus tient ses connexions même quand personne ne s'en sert. Mis
dans Engage Me, Salesforce n'ajoute aucun programme, donc un espace sans Salesforce ne coûte rien, par
construction.

« Stocker à part » (demande de Julien) veut dire trois choses, et aucune ne demande une machine de plus
aujourd'hui :

1. **Les données** vivent dans un schéma `salesforce`, lues et écrites SEULEMENT par le store du connecteur :
   aucune jointure depuis le cœur, aucune lecture croisée, aucune clé étrangère vers `public`. Le store reçoit
   son pool par constructeur : c'est la COUTURE, posée dès le V1. ⚠️ **La première version promettait qu'une
   variable suffirait, « sans changer une ligne de code » : c'est faux.** Le runner de migrations n'applique
   que `DATABASE_URL`, et la connexion chiffrée à la base est globale : le jour de l'extraction (règle du §8,
   quand des clients réels le justifient), il faudra un `pg_dump --schema=salesforce`, un moyen de migrer
   l'autre base et une variable de pool. On ne pose donc PAS cette variable maintenant.
2. **Le travail** passe par des files à lui, à concurrence bornée : ce qui remonte vers Salesforce appartient
   au futur worker d'analyse (personne ne l'attend), ce qui envoie un message au worker principal (§5 du même
   document).
3. **L'allocation d'API du client** : chaque appel consomme le quota Salesforce DU CLIENT. Écritures groupées
   (collections de 200 fiches par appel), lectures paginées, et un compteur par org lu dans l'en-tête
   `Sforce-Limit-Info` de chaque réponse, qui ralentit la remontée avant l'épuisement.

## L'architecture

### 1. Le package Salesforce (`salesforce/`, projet sfdx, package géré 2GP)

- **L'External Client App packagée** : notre clé, répliquée par Salesforce, jamais copiée chez le client ;
  politique client credentials, dont l'admin désigne l'utilisateur « Run As ».
- **Un jeu de permissions** pour l'utilisateur d'intégration : lecture et écriture des champs Engage Me,
  création de Lead et de tâche, mise à jour des membres de Campaign, lecture des Opportunités, rôles de
  contact, Campaigns, vues de liste et rapports. Rien de plus.
- **Les champs Engage Me sur Lead et Contact** : l'état courant, un champ par attribut du dictionnaire
  (`NOMS_ATTRIBUTS`, `src/signaux/types.ts`), plus l'identifiant de la conversation et la date du dernier
  message entrant WhatsApp (pour que la carte sache si la fenêtre de 24 h est ouverte).
- **Un objet de configuration** que seul Engage Me écrit : la liste autorisée (templates et scénarios, avec
  leurs variables) et les transitions surveillées. La carte et les déclencheurs le lisent sans nous appeler.
- **Les déclencheurs** sur Opportunity, Lead et CampaignMember. Ils ne réagissent qu'aux transitions
  surveillées (lues dans l'objet de configuration), sont écrits pour le traitement par lots de 200, et
  résolvent eux-mêmes le téléphone et la valeur de consentement (pour une opportunité, par le contact
  principal).
- **La boîte d'envoi** : chaque notification de déclencheur y attend ; un job Apex asynchrone les envoie par
  lots, les marque parties, et un job planifié rejoue celles qui ont échoué pendant 72 h, puis les marque
  expirées. Un envoi depuis la carte n'y passe pas : il est synchrone, et c'est le commercial qui réessaie.
- **Le secret de l'org**, dans un paramètre protégé du package, posé par Engage Me à la connexion à travers
  une ressource Apex REST du package. Chaque appel vers Engage Me est signé avec lui.
- **La carte** (composant LWC) sur les fiches Lead, Contact et Opportunité : dernière analyse, fenêtre de 24 h,
  lien vers la conversation, et les quatre actions. « Créer une opportunité » (ou rattacher l'ouverte, jamais
  en doublon) et « Planifier un rappel » s'exécutent dans l'org avec les droits du commercial ; « Envoyer un
  WhatsApp » appelle Engage Me.

### 2. Le connecteur, dans Engage Me (`src/salesforce/`)

- **Le client REST** : jeton client credentials par org, mis en cache jusqu'à expiration, sur l'adresse My
  Domain de l'org. Le quota lu à chaque réponse.
- **Le second adaptateur du dictionnaire de signaux.** L'émetteur reçoit déjà une liste de destinations
  (`DestinationSignaux`, `src/signaux/emetteur.ts`) : Salesforce en ajoute une, avec sa file et les espaces
  qui l'ont branché. Comme l'adaptateur Batch, il ne renomme ni n'étend rien du dictionnaire.
- **La source de campagne « Salesforce »** : Campaign, vue de liste, rapport.
- **Un type de déclencheur d'automation** `salesforce_transition` (objet, champ, valeur visée), à côté de
  `hubspot_deal_stage` dans `AUTOMATION_TRIGGER_KINDS`, alimenté par la file `automation-event`.
- **Les routes appelées par Salesforce** (`/salesforce/v1/notifications`, `/salesforce/v1/envois`) : elles
  vérifient la signature, valident, puis créent ou retrouvent le contact et publient l'événement d'automation
  (notifications, sur le modèle du webhook entrant) ou décident et mettent en file (envoi). Aucune ne parle à
  Meta pendant la requête.

### 3. Les écrans

- **Paramètres > Intégrations > Salesforce** (admin) : l'interrupteur d'espace, le guide, les liens
  d'installation, la connexion, les réglages (champ de consentement par objet, propriétaire de repli), la
  liste autorisée, la déconnexion.
- **La source « Salesforce » d'une campagne**, visible seulement quand une org est connectée (même règle que
  HubSpot depuis le 2026-09-23 : une intégration non reliée ne s'affiche pas).
- **Le déclencheur « Salesforce »** dans l'écran Automation, avec les étapes et statuts lus dans l'org (choix
  par libellé, stockage par valeur API).
- **Une page tuto** « Configurer Salesforce avec Engage Me », sur le modèle de `web/app/tuto-hubspot`.

## Les données (schéma `salesforce`)

Chaque requête porte `tenant_id = $1` : la connexion est superuser, le filtrage en code est le seul contrôle.

- **`orgs`** : `tenant_id` (unique), `org_id` (unique, 18 caractères), `my_domain`, `sandbox`, `etat`
  (`connexion`, `connectee`, `en_pause`, `coupee`), le motif d'une coupure, `secret_entrant` (chiffré par
  `ENCRYPTION_KEY` : le HMAC exige le secret en clair, donc un chiffrement et pas une empreinte),
  `utilisateur_integration` (pour que les déclencheurs ignorent ses modifications), `version_package`,
  `quota_utilise`, `quota_max`, `quota_releve_le`, `champ_consentement_lead`, `champ_consentement_contact` (et,
  pour une liste de sélection, la valeur « oui » ET la valeur « non », que le STOP écrit), `envoyer_resume`
  (faux par défaut), `proprietaire_repli`, `connectee_le`, `connectee_par`. **Une org, un espace, dans les deux
  sens** au V1 ; une sandbox est une autre org. La déconnexion SUPPRIME la ligne, ce qui libère l'org pour un
  autre espace.
- **`campagnes`** et **`membres`** : la Campaign Salesforce d'où vient une campagne, et pour chaque membre la date
  d'envoi, la date de réponse et ce qui a déjà été poussé (L3).
- **`envois`** : chaque envoi depuis la fiche (campagne d'un destinataire, fiche, commercial, clé d'idempotence,
  identifiant de la tâche Salesforce, statut monotone, date de réponse) : c'est lui qui relie un accusé et une
  réponse à l'activité (L5).
- **`fiches`** : `tenant_id`, `contact_id` (Engage Me), `sf_type` (`Lead` ou `Contact`), `sf_id`, `lie_le`.
  Un Lead converti fait basculer la ligne sur le Contact créé (`ConvertedContactId`).
- **`modeles_autorises`** : `tenant_id`, le template ou le scénario, son libellé, ses variables.
- **`notifications_recues`** : l'identifiant de chaque notification de la boîte d'envoi, pour ignorer un rejeu ;
  purgé après 7 jours.
- **`echecs`** : ce que Salesforce a refusé (objet, fiche, code, message de Salesforce), lu par l'écran
  Sécurité > Erreurs à travers le store du connecteur, sans jointure.

## Les flux

### Ce qui remonte (Engage Me vers Salesforce)

**Retrouver la fiche**, dans cet ordre : le lien connu (`fiches`) ; sinon une recherche par téléphone (Contact
prioritaire sur Lead, le plus récemment modifié en cas de doublon, doublon journalisé) ; sinon la création d'un
Lead. Le lien est enregistré dès la première correspondance, ce qui neutralise le délai d'indexation de la
recherche de Salesforce sur les fiches qu'on vient de créer.

**Créer un Lead** : nom WhatsApp (à défaut, « WhatsApp » suivi du numéro), mobile en E.164, en-tête
`Sforce-Auto-Assign` quand l'org a une règle d'attribution active, sinon le propriétaire de repli. La société
est laissée vide si l'org a les comptes personnels (le Lead se convertira en particulier), sinon elle reçoit le
nom de la personne. L'origine du Lead n'est écrite que si la valeur existe dans la liste de l'org.

| Signal | Écriture Salesforce |
|---|---|
| `em_conversation_analyzed` | Les champs d'état courant ; une tâche TERMINÉE (intention, satisfaction, lien vers le fil, et le résumé seulement si l'espace a coché l'option) ; une tâche OUVERTE pour le propriétaire quand une action est suggérée. |
| `em_opted_out` | Notre champ, et, pour un STOP WhatsApp seulement, le champ de consentement désigné du client mis à « non ». |
| `em_risk_changed` | Les champs de risque. |
| Injoignable (deux échecs, mécanisme existant) | Le champ de joignabilité. |
| Accusé d'un envoi DEPUIS LA FICHE | Le statut de l'activité « WhatsApp envoyé » (délivré, lu, échec). |
| `em_replied` après un envoi depuis la fiche | Une tâche « a répondu » pour le commercial ; le fil est affecté dans l'Inbox au membre qui a son e-mail, s'il existe. |
| Campagne partie vers une Campaign Salesforce | Les statuts de membres « Engage Me : envoyé », puis « Engage Me : a répondu ». |

**Ne remontent pas** : les accusés et les clics des campagnes, message par message. Une activité par message
noierait la timeline et brûlerait le quota du client.

### Ce qui descend (Salesforce vers Engage Me)

- **Notification de transition** : déclencheur Apex, boîte d'envoi, `POST /salesforce/v1/notifications` (lots
  de 200 au plus). Engage Me ignore un identifiant déjà reçu, crée ou retrouve le contact par son téléphone,
  applique la valeur de consentement, et publie un événement `salesforce_transition` sur la file
  `automation-event`. L'automation correspondante démarre son scénario, avec les garde-fous existants
  (anti-rebond, plafond horaire, opt-out).
- **Envoi depuis la carte** : appel synchrone `POST /salesforce/v1/envois` (fiche, téléphone, consentement,
  template ou scénario, variables, e-mail et identifiant du commercial). Engage Me vérifie la liste autorisée,
  le consentement, la fenêtre de 24 h pour ce qui n'est pas un template, et la qualité du numéro (refus sur une
  note rouge), exactement par le même code que l'API publique (`/v1/sends`, dont le pipeline est extrait pour
  être partagé), puis répond « accepté » ou le motif du refus, jamais en 5xx ni en 401. L'envoi part par une
  file dédiée. Engage Me écrit ensuite lui-même l'activité « WhatsApp envoyé », au nom du commercial : un seul
  écrivain pour ce qu'Engage Me pose dans Salesforce.

### Les segments

Lus **à la création**, à l'étape Audience, comme une liste HubSpot (amendement du 2026-09-26) :

- **Campaign** : les membres (Leads et Contacts) en SOQL, page par page ;
- **Vue de liste** : sa requête, obtenue par l'API de description de la vue, rejouée page par page ;
- **Rapport** : exécuté avec ses lignes de détail ; refusé s'il dépasse 2 000 lignes ou n'a pas de colonne
  téléphone, avec le motif à l'écran.

Chaque personne devient un contact Engage Me taggé `Salesforce: <nom>`, lié à sa fiche, avec l'opt-in lu dans
le champ désigné : « oui » pose `opted_in` (source `salesforce`), « non » ou l'absence de champ ne pose rien.
**Un `opted_out` n'est jamais relevé** par un import. La campagne vise les identifiants EXACTS rendus par la
lecture, pas le filtre de tag : les tags ne se retirent jamais, et viser le tag enverrait aussi aux anciens
membres d'une Campaign relue. Le plafond de 20 000 destinataires s'applique tel quel.

### Les erreurs

- **Passagères** (verrou de ligne, quota momentané, 5xx) : rejouées avec un délai croissant.
- **Définitives** (champ obligatoire, règle de validation, doublon bloqué par une règle du client, droit
  manquant) : aucun rejeu, une ligne dans `echecs` avec le message de Salesforce, borné et nettoyé (il peut
  citer une valeur de fiche, et le journal est ouvert aux managers), visible dans l'écran des erreurs, qui
  nomme Salesforce.
- **Jeton refusé** (utilisateur désactivé, package désinstallé, app bloquée) : l'org passe `coupee`, l'Accueil
  le dit, plus rien ne part jusqu'à reconnexion.
- **Quota proche de l'épuisement** : la remontée ralentit, puis s'arrête avant la limite, et reprend quand le
  compteur redescend. Un envoi depuis la carte n'est jamais refusé pour ça (le clic ne consomme aucun appel
  vers Salesforce) ; c'est l'activité qui le trace qui attend, avec le reste de la remontée.

## La connexion

1. L'admin Engage Me allume l'interrupteur Salesforce de l'espace. L'écran montre le guide et deux liens
   d'installation (production et sandbox).
2. Dans Salesforce, guidé par la page tuto : installer le package ; créer l'utilisateur d'intégration (licence
   gratuite, profil minimal limité à l'API) ; lui attribuer notre jeu de permissions et le droit d'écrire son
   champ de consentement ; le désigner comme « Run As » de l'app.
3. Dans Engage Me, il colle l'adresse de son org et clique « Connecter ». Engage Me obtient un jeton, lit
   l'identifiant et l'édition de l'org, vérifie le package (présence et version) et les droits (chaque manque
   est dit en clair, avec l'étape du guide qui le règle), génère le secret et le pose dans le package, écrit
   la configuration. L'état passe à `connectee`.
4. Réglages : champ de consentement par objet (choisi dans une liste lue dans l'org : case à cocher ou liste de
   sélection), propriétaire de repli.
5. Déconnexion : le secret est effacé dans l'org, puis la ligne chez nous. Si l'org est injoignable (package
   désinstallé, jeton refusé), on oublie quand même chez nous et l'écran le dit : l'org ne peut plus rien
   signer d'utile, et refuser d'oublier bloquerait l'espace.

## La sécurité

- **Notre clé d'app** (identifiant et secret de l'External Client App) : deux variables du serveur, jamais dans
  le dépôt (public) ni dans le package.
- **Appels entrants** : signature HMAC-SHA256 du corps et d'un horodatage avec le secret de l'org, comparée en
  temps constant ; horodatage refusé au-delà de 5 minutes ; l'identifiant d'org de l'en-tête doit être celui de
  l'espace ; `safeParse` sur chaque corps, jamais de `as`. Une nouvelle classe d'accès `signature-salesforce`
  entre dans le registre `modulesDeRoutes` de `src/server.ts`, que `tests/scope-tenant.test.ts` tient.
- **Plafond de débit** propre à ces routes : 60 appels par minute et par org, compté à part pour les notifications
  et pour les envois, pris APRÈS une signature valide ; un budget commun et silencieux pour les orgs inconnues ;
  0 le désactive. Distinct du plafond par utilisateur.
- **Le package est écrit pour la security review** : aucun secret hors du paramètre protégé ; les actions de la
  carte en mode utilisateur (droits du commercial, champs inaccessibles retirés) ; l'utilisateur d'intégration
  ne reçoit que ce que le jeu de permissions liste ; appel sortant uniquement vers `api.messagingme.app`, par
  une Named Credential du package.

## Ce que le lot L0 doit mesurer avant d'écrire le code

Chaque point est une hypothèse de cette spec, à confirmer sur de vraies orgs :

1. Une org abonnée obtient un jeton client credentials avec notre clé répliquée, sans rien copier.
2. **La recherche par téléphone** sur des formats réels (« 06 12 34 56 78 », « +33 6… », « 0033… », avec et sans
   espaces), et son délai d'indexation après création. C'est le point où naissent les doublons.
3. `Sforce-Auto-Assign` avec et sans règle d'attribution active.
4. Les comptes personnels : un Lead sans société qui se convertit en particulier, et les Contacts personnels
   rendus par la recherche.
5. L'écriture du paramètre protégé par une ressource Apex REST du package, appelée par l'utilisateur
   d'intégration.
6. L'appel sortant Apex vers `api.messagingme.app` par une Named Credential packagée.
7. L'ajout de statuts de membres à une Campaign par l'API.
8. La disponibilité du namespace `engageme`, et ce qu'exige la promotion d'une version 2GP (couverture Apex).
9. L'idempotence sous rejeu : un champ Engage Me marqué External ID sur Lead et Contact permet-il un upsert (pas
   de Lead en double si un job est rejoué), et un champ personnalisé d'activité peut-il l'être (pas de tâche en
   double) ?
10. Les métadonnées de l'External Client App récupérées par l'outillage Salesforce ne portent pas le secret de
    l'app (le dépôt est public), et une sandbox rafraîchie copie-t-elle le paramètre protégé ?
11. La longueur des noms de champs (préfixe du namespace compris) pour les noms du dictionnaire, et la liste des
    suffixes d'adresse My Domain à accepter.

## Les lots

| Lot | Contenu |
|---|---|
| **L0 Mesures** | Deux orgs Developer Edition gratuites, créées par Julien (une pour le Dev Hub et le namespace, une qui joue le client). Les mesures ci-dessus, consignées. Aucun code de production. |
| **L1 Socle** | Package v0.1 (app, jeu de permissions, champs, objet de configuration, paramètre protégé et sa ressource REST). Migration du schéma `salesforce`. Client REST, connexion, guide, déconnexion, interrupteur d'espace. |
| **L2 Remonter** | L'adaptateur de signaux : fiche retrouvée ou Lead créé, champs, activités, tâches, STOP vers le champ du client, joignabilité, écran des erreurs, compteur de quota. |
| **L3 Segments** | La source « Salesforce » d'une campagne (Campaign, vue de liste, rapport), le consentement lu, les statuts de membres. |
| **L4 Déclencheurs** | Déclencheurs Apex et boîte d'envoi, route de notifications, le type `salesforce_transition` et son écran. |
| **L5 Carte** | La carte, la liste autorisée, la route d'envoi synchrone et sa file dédiée, les accusés, les réponses et l'affectation dans l'Inbox. |
| **Hors V1** | Listing AppExchange et security review. |

## Méthode de livraison

**En direct pour L0** (des mesures, aucun code de production). **Implémenteur par lot et revue humaine du diff
pour L1 à L5** : la production emprunte ces chemins (envois, appels entrants, migrations, écritures chez le
client), et le code porte des invariants invisibles (consentement, doublons de fiche, quota du client, un
seul écrivain par objet).

**Ordre de déploiement** : pour chaque lot, l'API d'abord, puis les écrans, cachés derrière l'interrupteur
d'espace éteint par défaut (leçon du 2026-09-21 : un écran qui appelle une route neuve casse dès le push). La
migration du schéma passe avant le code qui la lit.

**L'essai réel qui clôt la feature**, sur une org qui n'est pas la nôtre (un essai Enterprise ou la sandbox d'un
prospect) : quelqu'un installe le package en suivant SEULEMENT le guide ; Julien envoie un WhatsApp depuis la
carte vers son téléphone, répond, et voit l'analyse arriver en activité ; il passe une opportunité à l'étape
surveillée et le scénario part ; il lance une campagne sur une Campaign Salesforce et voit les statuts de
membres bouger.

## Hors périmètre

- SFMC (autre produit, autre connecteur) et Marketing Cloud Growth ou Data Cloud.
- Répondre depuis Salesforce (une mini-Inbox dans la carte) : un chantier à lui seul.
- La remontée de l'historique à la connexion.
- Les accusés et les clics des campagnes en activités Salesforce.
- Plusieurs orgs par espace, ou plusieurs espaces par org.
- Le listing AppExchange.
- La migration de `mm-hubspot` sur le même modèle : c'est la direction que cette spec rend possible, pas un
  lot de cette spec.
