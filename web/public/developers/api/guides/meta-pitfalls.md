<!-- Version Markdown de https://console.messagingme.app/developers/api/guides/meta-pitfalls, générée depuis la page (npm run doc:md). English: https://console.messagingme.app/developers/api/guides/meta-pitfalls.en.md -->

# Les pièges de Meta

Messaging Me passe par la plateforme officielle de Meta pour WhatsApp. Ses règles s’appliquent à chaque message, quel que soit l’outil qui l’envoie : les voici, avec le code que vous recevrez quand l’une d’elles bloque.

<a id="fenetre"></a>

## La fenêtre de 24 h

Un message libre (texte, image, boutons) ne part que dans les 24 h qui suivent le dernier message de la personne. Passé ce délai, seul un modèle approuvé par Meta peut partir. Quand elle le sait, l’API refuse avant Meta : [`window_closed`](https://console.messagingme.app/developers/api/errors.md#window_closed) ; sinon Meta répond [`131047`](https://console.messagingme.app/developers/api/errors.md#meta-131047).

Une conversation dit si sa fenêtre est ouverte : [GET /v1/conversations/{conversationId}](https://console.messagingme.app/developers/api/conversations.md#lire). [La règle en détail](https://console.messagingme.app/developers/api/concepts.md#fenetre-24h).

<a id="modeles"></a>

## Les modèles et leur validation

- Meta valide chaque modèle, en quelques minutes ou jusqu’à 24 h. Seul un modèle approuvé part.
- Trois catégories : marketing, utility (transactionnel) et authentication. Meta peut changer la catégorie que vous avez choisie, et le prix change avec elle.
- Un modèle peut être mis en pause pour mauvaise qualité ([`132015`](https://console.messagingme.app/developers/api/errors.md#meta-132015)), puis désactivé pour de bon s’il recommence ([`132016`](https://console.messagingme.app/developers/api/errors.md#meta-132016)).
- Les paramètres d’un envoi doivent correspondre au modèle, en nombre ([`132000`](https://console.messagingme.app/developers/api/errors.md#meta-132000)) et en format ([`132012`](https://console.messagingme.app/developers/api/errors.md#meta-132012)).
- Suivre le statut : [GET /v1/templates/{name}](https://console.messagingme.app/developers/api/templates.md#statut), ou l’événement `template.status_changed`.

<a id="facturation"></a>

## Ce que Meta facture

Meta facture les messages de modèle selon leur catégorie et le pays du destinataire. Les messages de service (les réponses dans la fenêtre de 24 h) ont leurs propres conditions, qui ont changé le 1er octobre 2026. Messaging Me ne fixe pas ces prix : la grille officielle de Meta fait foi.

[La grille de prix de Meta](https://developers.facebook.com/docs/whatsapp/pricing)

<a id="paiement"></a>

## La carte dans le Business Manager

Meta exige un moyen de paiement valide sur le compte WhatsApp pour ce qu’il facture, à commencer par les modèles, quelle que soit l’offre Messaging Me. Sans lui : [`131042`](https://console.messagingme.app/developers/api/errors.md#meta-131042).

<a id="consentement"></a>

## Le consentement et STOP

Meta demande un consentement avant d’écrire en premier à quelqu’un. Messaging Me le garde sur la fiche et refuse un envoi marketing sans lui ([`no_consent`](https://console.messagingme.app/developers/api/errors.md#no_consent)). Une personne qui répond STOP est désabonnée ([`opted_out`](https://console.messagingme.app/developers/api/errors.md#opted_out)) : l’API ne la réabonne jamais.

La personne peut aussi refuser le marketing de votre entreprise dans WhatsApp même : [`131050`](https://console.messagingme.app/developers/api/errors.md#meta-131050). [La règle en détail](https://console.messagingme.app/developers/api/concepts.md#consentement).

<a id="qualite"></a>

## La qualité du numéro

Meta note la qualité de chaque numéro selon les blocages et les signalements qu’il reçoit, et elle décide du nombre de personnes différentes qu’il peut joindre par 24 h. Une qualité basse restreint les envois ([`131048`](https://console.messagingme.app/developers/api/errors.md#meta-131048)) : une campagne Messaging Me se met alors en pause, et rien ne la relance seule. Écrivez à des personnes qui l’ont accepté, avec un contenu qu’elles attendent.

<a id="debit"></a>

## Le débit

- Un numéro a un débit d’envoi maximal : [`130429`](https://console.messagingme.app/developers/api/errors.md#meta-130429).
- Trop de messages vers la même personne en peu de temps : [`131056`](https://console.messagingme.app/developers/api/errors.md#meta-131056). Les autres destinataires ne sont pas touchés.
- L’API a aussi ses propres limites, par minute et par jour : [`rate_limited`](https://console.messagingme.app/developers/api/errors.md#rate_limited), [`quota_exceeded`](https://console.messagingme.app/developers/api/errors.md#quota_exceeded) (attendre `retry-after`). [Les limites](https://console.messagingme.app/developers/api/reference.md#debit).

<a id="marketing"></a>

## La limite marketing par personne

Meta limite le nombre de messages marketing qu’une personne reçoit, toutes entreprises confondues. Au-delà, votre message n’est pas délivré ([`131049`](https://console.messagingme.app/developers/api/errors.md#meta-131049)), sans que vous ayez rien fait de travers. Ne réessayez pas aussitôt : attendez au moins 24 h.

<a id="nom-affiche"></a>

## Le nom affiché

Le nom que la personne voit en face du numéro passe par la validation de Meta. Suivez son état dans le WhatsApp Manager avant de lancer des envois, et corrigez-le là s’il est refusé.

<a id="injoignable"></a>

## Le numéro injoignable

Un numéro qui n’est pas sur WhatsApp, une personne qui n’a pas accepté les conditions de WhatsApp ou dont l’application est trop ancienne : [`131026`](https://console.messagingme.app/developers/api/errors.md#meta-131026). Passez par un autre canal (RCS, e-mail).

<a id="medias"></a>

## Les fichiers

- Meta ne garde un fichier reçu que 7 jours : téléchargez-le dès l’événement `message.received` ([GET /v1/messages/{messageId}/media](https://console.messagingme.app/developers/api/conversations.md#media)). Après : [`media_expired`](https://console.messagingme.app/developers/api/errors.md#media_expired).
- Un fichier envoyé doit avoir un type et une taille que WhatsApp accepte : [`131053`](https://console.messagingme.app/developers/api/errors.md#meta-131053).

> **Note**
>
> Tous les codes, et ce que Messaging Me fait déjà de lui-même : [les erreurs de Meta](https://console.messagingme.app/developers/api/errors.md#meta).
