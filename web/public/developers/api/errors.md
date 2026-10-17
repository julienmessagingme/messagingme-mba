<!-- Version Markdown de https://console.messagingme.app/developers/api/errors, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/errors.en.md -->

# Catalogue des erreurs

Toute réponse d’erreur de l’API porte un corps JSON avec error, une phrase en français pour un humain, et code, un identifiant stable pour un programme. Branchez-vous sur code, jamais sur la phrase.

<a id="forme"></a>

## La forme d’une erreur

_JSON_

```
{
  "error": "fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).",
  "code": "window_closed"
}
```

- `metaCode` : sur meta_rejected seulement, le numéro d’erreur de Meta (voir plus bas), ou null quand Meta n’en donne pas.
- `upgradeUrl` : sur un 402, la page où l’offre de l’espace se change.
- `retry-after` : sur un 429, l’en-tête qui dit combien de secondes attendre.

> **Attention**
>
> Un 5xx peut arriver sans ce corps : une page d’erreur générique le remplace parfois en chemin. Traitez-le comme internal_error : réessayez avec un délai qui grandit, et rejouez un envoi avec la même clé d’idempotence.

<a id="codes"></a>

## Les codes de l’API

Un même refus porte le même code partout. Certains arrivent aussi en motif d’écart d’un destinataire de [POST /v1/sends](https://console.messagingme.app/developers/api/sends.md#envoi) : l’envoi part pour les autres.

<a id="invalid_body"></a>

### `invalid_body` 400

Corps mal formé. Le message nomme le champ fautif.

Que faire : Corriger le champ que le message nomme. Toujours envoyer Content-Type: application/json.

<a id="invalid_recipient"></a>

### `invalid_recipient` 400, aussi motif d’écart

Aucune clé de fiche (contactId, externalId, phone, bsuid).

Que faire : Désigner la personne par au moins une clé : contactId, externalId, phone ou bsuid.

<a id="invalid_phone"></a>

### `invalid_phone` 400, aussi motif d’écart

Numéro illisible.

Que faire : Écrire le numéro au format international, indicatif compris (+33612345678).

<a id="unauthorized"></a>

### `unauthorized` 401

Clé absente, mal formée, inconnue ou révoquée.

Que faire : Vérifier l’en-tête Authorization: Bearer mba_… ; si la clé a été révoquée, en créer une dans Developers > Clés d’API.

<a id="missing_scope"></a>

### `missing_scope` 403

La clé n’a pas le droit que la route exige.

Que faire : Créer une clé qui porte le droit de la route (la liste des droits est sur la page Authentification).

<a id="tenant_locked"></a>

### `tenant_locked` 403

Espace suspendu : la clé est valide, mais l’espace ne peut plus rien lire ni envoyer par l’API. Inutile de refaire une clé.

Que faire : Inutile de refaire une clé : un admin regarde dans la console pourquoi l’espace est suspendu.

<a id="unknown_contact"></a>

### `unknown_contact` 404, aussi motif d’écart

Aucune fiche ne correspond, et la route n’en crée pas.

Que faire : Créer la fiche d’abord (POST /v1/contacts), ou vérifier la clé donnée.

<a id="duplicate"></a>

### `duplicate` motif d’écart seulement

Le même destinataire figure deux fois dans l’envoi.

Que faire : Retirer le doublon de la liste des destinataires ; il n’a reçu qu’un message.

<a id="identity_conflict"></a>

### `identity_conflict` 409, aussi motif d’écart

Les clés données désignent deux fiches différentes, ou cet identifiant externe est déjà porté par une autre fiche. Rien n’est écrit.

Que faire : Ne donner qu’une clé, ou corriger l’identifiant externe porté par l’autre fiche : rien n’a été écrit.

<a id="blocked_contact"></a>

### `blocked_contact` 409, aussi motif d’écart

Fiche bloquée.

Que faire : Un admin débloque la fiche dans la console, s’il le faut.

<a id="opted_out"></a>

### `opted_out` 409, aussi motif d’écart

Désabonné, en général, ou du RCS pour un envoi RCS.

Que faire : Ne plus écrire à cette personne : elle a dit STOP. L’API ne la réabonne pas ; seuls un opérateur ou la personne elle-même le peuvent.

<a id="no_consent"></a>

### `no_consent` 409, aussi motif d’écart

Consentement manquant : envoi marketing vers qui n’est pas opted_in, ou RCS libre vers qui n’a ni consenti ni écrit.

Que faire : Poser sur la fiche le consentement recueilli (consent, consentSource) avant un envoi marketing.

<a id="window_closed"></a>

### `window_closed` 422, aussi motif d’écart

Fenêtre de 24 h fermée : seul un template peut partir.

Que faire : Envoyer un modèle approuvé (POST /v1/sends) : un message libre ne part que dans les 24 h qui suivent le dernier message de la personne.

<a id="missing_variable"></a>

### `missing_variable` motif d’écart seulement

Une variable manque pour ce destinataire, sans valeur de repli.

Que faire : Remplir la variable sur la fiche, ou donner une valeur de repli (fallback) au paramètre.

<a id="no_phone"></a>

### `no_phone` 422, aussi motif d’écart

Fiche sans numéro, alors que le RCS l’exige.

Que faire : Ajouter un numéro à la fiche.

<a id="rcs_unreachable"></a>

### `rcs_unreachable` 422

Ce numéro n’est pas joignable en RCS (appris d’un envoi précédent).

Que faire : Le numéro n’a pas RCS : passer par WhatsApp.

<a id="rcs_not_enabled"></a>

### `rcs_not_enabled` 409

Le canal RCS n’est pas actif sur cet espace.

Que faire : Envoyer en WhatsApp, ou faire activer le RCS de l’espace.

<a id="no_whatsapp_number"></a>

### `no_whatsapp_number` 409

Aucun numéro WhatsApp sur cet espace.

Que faire : Un admin connecte un numéro WhatsApp à l’espace depuis l’Accueil de la console.

<a id="number_unlinked"></a>

### `number_unlinked` 409

Le numéro WhatsApp de l’espace est délié depuis l’Accueil : rien ne part par WhatsApp tant qu’un administrateur ne l’a pas relié. Rendu par POST /v1/messages/whatsapp, et par POST /v1/sends quand le premier message part en WhatsApp.

Que faire : Un admin relie le numéro depuis l’Accueil de la console.

<a id="number_suspended"></a>

### `number_suspended` 409

L’abonnement du numéro WhatsApp fourni est impayé depuis 7 jours, ou terminé : rien ne part par WhatsApp tant qu’il n’est pas renouvelé. Rendu par POST /v1/messages/whatsapp, et par POST /v1/sends quand le premier message part en WhatsApp.

Que faire : Régler l’abonnement du numéro dans la console : les envois repartent au paiement.

<a id="scenario_not_found"></a>

### `scenario_not_found` 404

Scénario introuvable.

Que faire : Lire le catalogue (GET /v1/scenarios) et utiliser un code de scénario existant.

<a id="node_not_found"></a>

### `node_not_found` 404

Bloc introuvable.

Que faire : Lire le catalogue (GET /v1/scenarios) : le bloc n’existe pas dans la version publiée du scénario.

<a id="template_not_found"></a>

### `template_not_found` 404

Template absent, ou pas encore approuvé.

Que faire : Lire le catalogue (GET /v1/templates) ; un modèle en attente de Meta n’y figure qu’une fois approuvé.

<a id="rcs_message_not_found"></a>

### `rcs_message_not_found` 404

Message RCS introuvable dans la bibliothèque.

Que faire : Lire la bibliothèque (GET /v1/rcs-messages) et utiliser un nom existant.

<a id="send_not_found"></a>

### `send_not_found` 404

Envoi inconnu.

Que faire : Vérifier le sendId rendu par POST /v1/sends.

<a id="meta_rejected"></a>

### `meta_rejected` 422

Meta a refusé la demande : son motif suit « Meta: », et metaCode porte le numéro d’erreur de Meta (null s’il n’en donne pas).

Que faire : Chercher metaCode dans les erreurs de Meta, plus bas sur cette page, et appliquer son geste.

<a id="invalid_header_media"></a>

### `invalid_header_media` 422

Le fichier d’en-tête d’un modèle n’a pas pu être pris à son adresse : son motif suit.

Que faire : Servir le fichier d’en-tête à une adresse https publique, au bon type et sous la taille admise.

<a id="meta_auth_failed"></a>

### `meta_auth_failed` 409

Meta refuse le jeton de l’espace : reconnectez le compte WhatsApp depuis la console.

Que faire : Un admin clique « Renouveler la connexion Meta » sur l’Accueil de la console.

<a id="field_exists"></a>

### `field_exists` 409

Un champ porte déjà cette clé, ou le libellé est celui d’un champ de base.

Que faire : Réutiliser le champ existant (GET /v1/fields), ou choisir un autre libellé.

<a id="webhook_not_found"></a>

### `webhook_not_found` 404

Adresse de webhook inconnue de cet espace.

Que faire : Vérifier l’identifiant de l’adresse (GET /v1/webhooks).

<a id="delivery_not_found"></a>

### `delivery_not_found` 404

Envoi de webhook inconnu.

Que faire : Vérifier l’identifiant dans le journal de l’adresse (GET /v1/webhooks/{webhookId}/deliveries).

<a id="delivery_not_replayable"></a>

### `delivery_not_replayable` 409

Envoi inconnu de cet espace, encore en cours, ou un essai : rien à rejouer.

Que faire : Attendre la fin des réessais ; un essai ne se rejoue pas.

<a id="webhooks_unavailable"></a>

### `webhooks_unavailable` 503

L’instance ne sait pas chiffrer les secrets : réessayez plus tard.

Que faire : Réessayer plus tard.

<a id="template_rejected"></a>

### `template_rejected` 422

Le modèle est refusé avant Meta (un lien n’a pas pu être tracé) : son motif suit.

Que faire : Corriger le modèle selon le motif donné, puis le recréer.

<a id="conversation_not_found"></a>

### `conversation_not_found` 404

Conversation inconnue de cet espace.

Que faire : Vérifier l’identifiant (GET /v1/conversations).

<a id="message_not_found"></a>

### `message_not_found` 404

Message inconnu de cet espace.

Que faire : Vérifier l’identifiant du message (GET /v1/conversations/{conversationId}/messages).

<a id="invalid_cursor"></a>

### `invalid_cursor` 400

Curseur illisible : renvoyez tel quel le nextCursor d’une page.

Que faire : Renvoyer tel quel le nextCursor de la page précédente.

<a id="no_media"></a>

### `no_media` 404

Ce message ne porte aucun fichier reçu.

Que faire : Lire le type du message avant de demander son fichier.

<a id="media_expired"></a>

### `media_expired` 410

Meta ne garde un fichier reçu que 7 jours.

Que faire : Trop tard pour ce fichier : le télécharger dès l’événement message.received.

<a id="media_unavailable"></a>

### `media_unavailable` 422

Meta n’a pas rendu le fichier, ou il est trop lourd : réessayez.

Que faire : Réessayer un peu plus tard.

<a id="scenario_ambiguous"></a>

### `scenario_ambiguous` 409

Plusieurs scénarios portent ce nom : utilisez le code scn_.

Que faire : Désigner le scénario par son code scn_… plutôt que par son nom.

<a id="unsendable_target"></a>

### `unsendable_target` 422

La cible ne peut pas partir ainsi. Le message dit pourquoi.

Que faire : Lire le motif, puis choisir une cible envoyable : un modèle approuvé, un scénario publié.

<a id="template_category_unknown"></a>

### `template_category_unknown` 422

Catégorie du template illisible chez Meta : l’envoi est refusé plutôt que deviné.

Que faire : Réessayer plus tard ; si cela dure, vérifier le modèle dans le WhatsApp Manager.

<a id="idempotency_key_required"></a>

### `idempotency_key_required` 400

Clé d’idempotence absente (en-tête ou corps).

Que faire : Ajouter l’en-tête Idempotency-Key (ou idempotencyKey dans le corps).

<a id="idempotency_in_progress"></a>

### `idempotency_in_progress` 409

Un envoi avec cette clé est en cours.

Que faire : Attendre la fin du premier appel, puis rejouer avec la même clé : il rendra le même résultat.

<a id="idempotency_key_reused"></a>

### `idempotency_key_reused` 422

Cette clé a déjà servi pour un autre corps.

Que faire : Prendre une clé neuve pour un corps différent.

<a id="rate_limited"></a>

### `rate_limited` 429

Débit dépassé, ici ou chez Meta (limite ou panne passagère de Meta) : attendez la durée de retry-after.

Que faire : Attendre retry-after secondes, puis réessayer.

<a id="quota_exceeded"></a>

### `quota_exceeded` 429

Quota quotidien de l’espace atteint (modèles, réponses ou fiches écrites), ou dépassé par ce lot : retry-after donne l’attente jusqu’à minuit, heure de Paris. Un lot plus petit peut encore passer.

Que faire : Attendre la remise à zéro que donne retry-after (minuit, heure de Paris), ou envoyer un lot plus petit.

<a id="plan_feature_unavailable"></a>

### `plan_feature_unavailable` 402

Cette fonction n’est pas comprise dans l’offre de l’espace : upgradeUrl mène à la page de l’offre.

Que faire : Changer d’offre sur la page que donne upgradeUrl.

<a id="plan_limit_reached"></a>

### `plan_limit_reached` 402, aussi motif d’écart

Une limite de l’offre de l’espace est atteinte (contacts créés, modèles du mois…) : upgradeUrl mène à la page de l’offre. Les réponses dans la fenêtre de 24 h ne sont jamais concernées.

Que faire : Changer d’offre sur la page que donne upgradeUrl, ou attendre la remise à zéro de la limite.

<a id="route_not_found"></a>

### `route_not_found` 404

Aucune route à cette adresse pour cette méthode : vérifiez la méthode et le chemin dans le contrat OpenAPI.

Que faire : Vérifier la méthode et le chemin dans le contrat OpenAPI (GET /openapi.json).

<a id="internal_error"></a>

### `internal_error` 500

Panne de notre côté, ou Meta injoignable. Réessayez ; un envoi se rejoue avec la même clé d’idempotence. Un 5xx peut arriver sans ce corps (page d’erreur générique).

Que faire : Réessayer, avec un délai qui grandit ; un envoi se rejoue sans doublon avec la même clé d’idempotence.

<a id="meta"></a>

## Les erreurs de Meta

Meta refuse parfois un message pour une raison qui lui est propre. Son numéro d’erreur arrive à quatre endroits :

- `metaCode` d’un refus 422 meta_rejected, quand Meta refuse sur le moment ;
- `data.meta_code` de l’événement message.failed, quand le message échoue après être parti ;
- `error.code` d’un message lu par GET /v1/messages/{messageId} ;
- `error.metaCode` d’un destinataire dans le suivi d’un envoi (GET /v1/sends/{sendId}).

Les codes ci-dessous sont ceux qui concernent un espace Messaging Me. La liste complète est dans la documentation de la Cloud API de Meta.

### Le destinataire

<a id="meta-131047"></a>

#### `131047`

Plus de 24 h depuis le dernier message de la personne : la fenêtre est fermée.

Que faire : Envoyer un modèle approuvé (POST /v1/sends) au lieu d’un message libre.

Ce que Messaging Me fait déjà : Quand elle le sait, l’API refuse avant Meta : window_closed.

<a id="meta-131026"></a>

#### `131026`

Message non délivrable : le numéro n’est pas sur WhatsApp, la personne n’a pas accepté les conditions de WhatsApp, ou son application est trop ancienne.

Que faire : Passer par un autre canal (RCS, e-mail), ou demander à la personne de mettre WhatsApp à jour.

Ce que Messaging Me fait déjà : Une campagne à plusieurs canaux passe au suivant. Sinon, quand le réessai est actif (la case de la campagne, ou le réglage de l’espace pour un envoi de l’API), elle retente une fois, puis marque le contact injoignable sur WhatsApp.

<a id="meta-131049"></a>

#### `131049`

Message marketing non délivré : Meta limite le marketing que chaque personne reçoit, pour préserver l’engagement.

Que faire : Ne pas réessayer tout de suite : attendre au moins 24 h. Meta ne dit pas quand la limite se lève.

Ce que Messaging Me fait déjà : Quand le réessai est actif (la case de la campagne, ou le réglage de l’espace pour un envoi de l’API), il est retenté le lendemain matin.

<a id="meta-131050"></a>

#### `131050`

La personne a refusé, dans WhatsApp, les messages marketing de votre entreprise.

Que faire : Ne pas réessayer, et ne plus lui envoyer de marketing.

<a id="meta-131021"></a>

#### `131021`

L’expéditeur et le destinataire sont le même numéro.

Que faire : Envoyer à un autre numéro que celui de l’espace.

<a id="meta-130497"></a>

#### `130497`

Le compte ne peut pas écrire aux personnes de ce pays.

Que faire : Ce destinataire n’est pas joignable par ce compte : vérifier les pays autorisés dans la politique de Meta.

### Les modèles

<a id="meta-132000"></a>

#### `132000`

Le nombre de paramètres ne correspond pas au modèle.

Que faire : Donner une valeur à chaque {{n}} du modèle, ni plus ni moins (params de POST /v1/sends).

<a id="meta-132001"></a>

#### `132001`

Le modèle n’existe pas dans cette langue, ou il n’est pas approuvé.

Que faire : Vérifier le nom, la langue et le statut du modèle (GET /v1/templates/{name}).

<a id="meta-132012"></a>

#### `132012`

Un paramètre n’a pas le format que le modèle attend.

Que faire : Respecter le format défini dans le modèle : texte, devise, date, fichier de l’en-tête.

<a id="meta-132015"></a>

#### `132015`

Modèle mis en pause par Meta pour mauvaise qualité.

Que faire : Le modifier pour améliorer sa qualité, puis renvoyer une fois réapprouvé. L’événement template.status_changed le signale.

<a id="meta-132016"></a>

#### `132016`

Modèle désactivé pour de bon, après des pauses répétées.

Que faire : Créer un nouveau modèle, au contenu différent.

<a id="meta-132018"></a>

#### `132018`

Les paramètres du modèle ne passent pas la validation de Meta.

Que faire : Lire le détail de l’erreur, corriger les paramètres et renvoyer. Un modèle accepté à la création peut encore être refusé ainsi à l’envoi.

<a id="meta-134100"></a>

#### `134100`

La Marketing Messages API n’accepte que les modèles de catégorie marketing.

Que faire : Renvoyer : le modèle a sans doute été reclassé par Meta entre la lecture de sa catégorie et l’envoi.

Ce que Messaging Me fait déjà : Messaging Me lit la catégorie du modèle chez Meta et n’envoie par cette API que les modèles marketing.

<a id="meta-134101"></a>

#### `134101`

Le modèle a été créé, ou réutilisé après 7 jours sans envoi, il y a moins de 10 minutes : Meta le synchronise encore.

Que faire : Attendre 10 minutes, puis renvoyer.

Ce que Messaging Me fait déjà : Messaging Me renvoie aussitôt le message par la Cloud API, au même prix : vous ne le verrez que si ce second envoi échoue aussi.

<a id="meta-134102"></a>

#### `134102`

Le modèle est indisponible pour la Marketing Messages API : sa synchronisation a échoué, ou le compte n’y est pas éligible.

Que faire : Vérifier l’éligibilité du compte WhatsApp dans WhatsApp Manager, puis contacter le support de Meta si elle est bonne.

### Le contenu et les fichiers

<a id="meta-100"></a>

#### `100`

Paramètre invalide dans la demande.

Que faire : Lire le message de Meta, qui nomme le champ, et corriger la demande.

<a id="meta-131008"></a>

#### `131008`

Paramètre obligatoire manquant.

Que faire : Compléter le corps selon le format de Meta (POST /v1/messages).

<a id="meta-131009"></a>

#### `131009`

Valeur de paramètre non valide : un titre de bouton trop long, une adresse mal formée…

Que faire : Lire le message de Meta, qui nomme la valeur, et la corriger.

<a id="meta-131051"></a>

#### `131051`

Type de message non pris en charge.

Que faire : Utiliser un type que WhatsApp accepte : texte, image, document, modèle…

<a id="meta-131052"></a>

#### `131052`

Le fichier envoyé par la personne n’a pas pu être téléchargé.

Que faire : Demander à la personne de le renvoyer.

<a id="meta-131053"></a>

#### `131053`

Le dépôt d’un fichier chez Meta a échoué : type ou taille refusés.

Que faire : Vérifier le type et la taille du fichier, puis renvoyer.

### Le débit et la qualité

<a id="meta-130429"></a>

#### `130429`

Débit d’envoi du numéro dépassé.

Que faire : Étaler les envois et réessayer quelques secondes plus tard.

Ce que Messaging Me fait déjà : Rejouée seule ; une campagne se met en pause et repart d’elle-même.

<a id="meta-131048"></a>

#### `131048`

Envois restreints pour ce numéro : trop de messages bloqués ou signalés comme spam.

Que faire : Regarder la qualité du numéro dans le WhatsApp Manager, revoir le ciblage et le contenu avant de relancer.

Ce que Messaging Me fait déjà : Une campagne se met en pause qualité, que rien ne lève automatiquement.

<a id="meta-131056"></a>

#### `131056`

Trop de messages du même numéro vers le même destinataire en peu de temps.

Que faire : Attendre avant de réécrire à ce destinataire ; les autres ne sont pas touchés.

Ce que Messaging Me fait déjà : Messaging Me la rejoue seul plusieurs fois avant d’annoncer l’échec.

<a id="meta-4"></a>

#### `4`

Le plafond d’appels de l’application chez Meta est atteint.

Que faire : Ralentir, puis réessayer plus tard.

Ce que Messaging Me fait déjà : Messaging Me la rejoue seul plusieurs fois avant d’annoncer l’échec.

<a id="meta-80007"></a>

#### `80007`

Le plafond d’appels du compte WhatsApp est atteint.

Que faire : Ralentir, puis réessayer plus tard.

### Le compte et la connexion

<a id="meta-190"></a>

#### `190`

Le jeton d’accès de l’espace a expiré ou a été révoqué.

Que faire : Un admin clique « Renouveler la connexion Meta » sur l’Accueil de la console.

Ce que Messaging Me fait déjà : Par l’API, il sort en 409 meta_auth_failed, sur toute route.

<a id="meta-10"></a>

#### `10`

Une permission manque ou a été retirée sur le compte WhatsApp.

Que faire : Renouveler la connexion Meta en acceptant toutes les permissions demandées.

<a id="meta-131042"></a>

#### `131042`

Problème de moyen de paiement sur le compte WhatsApp.

Que faire : Ajouter ou corriger la carte dans le Business Manager (Facturation) : Meta l’exige pour ce qu’il facture, à commencer par les modèles, quelle que soit l’offre Messaging Me.

<a id="meta-368"></a>

#### `368`

Compte restreint ou désactivé pour non-respect des règles de Meta.

Que faire : Lire l’avis dans le WhatsApp Manager et faire appel si besoin : rien ne repartira avant la levée.

<a id="meta-131031"></a>

#### `131031`

Compte verrouillé par Meta, ou vérification échouée (code PIN à deux étapes faux).

Que faire : Vérifier l’état du compte dans le WhatsApp Manager ; pour le PIN, le reposer.

### L’enregistrement du numéro

<a id="meta-133006"></a>

#### `133006`

Le numéro doit être vérifié avant d’être enregistré.

Que faire : Finir la vérification du numéro (code par SMS ou par appel) depuis la console.

<a id="meta-133016"></a>

#### `133016`

Trop de tentatives d’enregistrement du numéro en peu de temps.

Que faire : Attendre le déblocage, jusqu’à 72 h, avant de réessayer.

<a id="meta-136024"></a>

#### `136024`

Le numéro est déjà vérifié : Meta refuse une nouvelle demande de code.

Que faire : Passer directement à l’enregistrement, sans redemander de code.

### Les pannes passagères

<a id="meta-131000"></a>

#### `131000`

Échec inconnu chez Meta.

Que faire : Réessayer ; s’il persiste sur le même message, changer le contenu.

Ce que Messaging Me fait déjà : Le dépôt d’un fichier est réessayé seul : environ un sur dix échoue ainsi.

<a id="meta-131016"></a>

#### `131016`

Service de Meta momentanément indisponible.

Que faire : Réessayer plus tard.

Ce que Messaging Me fait déjà : Messaging Me la rejoue seul plusieurs fois avant d’annoncer l’échec.

<a id="meta-1"></a>

#### `1`

Erreur inconnue de l’API de Meta, souvent passagère.

Que faire : Réessayer plus tard.

Ce que Messaging Me fait déjà : Messaging Me la rejoue seul plusieurs fois avant d’annoncer l’échec.

<a id="meta-2"></a>

#### `2`

Service de l’API de Meta momentanément indisponible.

Que faire : Réessayer dans quelques minutes.

Ce que Messaging Me fait déjà : Messaging Me la rejoue seul plusieurs fois avant d’annoncer l’échec.
