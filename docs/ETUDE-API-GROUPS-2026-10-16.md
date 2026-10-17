# Étude : l'API Groups de WhatsApp (2026-10-16)

Décision de Julien le 2026-10-16 : **à garder au backlog**, rien à construire tant qu'aucun client ne présente un
cas réel. Ce document sert à ne pas refaire la recherche le jour où un client la demande.

## Ce que Meta propose

Lancée le 6 octobre 2025. Sources :
[vue d'ensemble](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups),
[démarrage](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started),
[référence](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/reference),
[messagerie](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging),
[tarifs](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/pricing),
[webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/groups/webhooks).

### Les trois contraintes qui décident de tout

- **8 participants au plus par groupe**, entreprise comprise. 10 000 groupes par numéro. Ce sont des salons, pas
  des communautés ni de la diffusion.
- **Compte certifié (Official Business Account, la coche verte) obligatoire**, numéro sur Cloud API. Les numéros
  de l'application WhatsApp Business et ceux en Coexistence sont exclus (Coexistence : déduit de la doc et confirmé
  par des fournisseurs tiers, pas écrit en toutes lettres par Meta).
- **On n'ajoute personne directement** : l'entrée se fait par un lien d'invitation, envoyé par un template « Group
  invite ». Mode d'approbation possible (`join_approval_mode: approval_required`).

### Les messages

- Envoi par `/messages` avec `recipient_type: "group"` et `to` = l'identifiant du groupe.
- Autorisés : texte, médias, templates texte et média. **Refusés : interactifs (boutons, listes, formulaires),
  authentification, commerce, éphémères, vue unique, appels.** Tous nos blocs à choix sont donc hors jeu.
- Épinglage : 3 messages au plus, de 1 à 30 jours.
- Fenêtre de 24 h : le message d'un seul participant l'ouvre pour tout le groupe ; texte libre, utilitaire et
  marketing y sont gratuits.
- Facturation : par livraison à chaque participant, au tarif du pays du destinataire (catégories `group_marketing`,
  `group_utility`, `group_service`). Les utilitaires de groupe n'ont pas de paliers de volume.
- Aucune modification ni suppression de message, liste des participants visible de tous, seul levier de modération :
  retirer un participant (il ne peut plus revenir par le lien). Meta peut suspendre un groupe.

### La gestion

- `POST /{phone-number-id}/groups` (sujet 128 caractères, description 2 048), réponse asynchrone par webhook avec le
  lien d'invitation.
- `GET` et `POST` (réinitialiser) `/{group-id}/invite_link`, `/{group-id}/join_requests` (approuver, rejeter),
  `DELETE /{group-id}/participants` (8 par appel), `DELETE /{group-id}`, `GET /{phone-number-id}/groups`.
- Quatre champs de webhook : `group_lifecycle_update`, `group_participants_update`, `group_settings_update`,
  `group_status_update`. Les messages entrants arrivent par le champ `messages` habituel avec un `group_id`, `from`
  étant le participant. ⚠️ Le nom de la clé du participant dans les statuts diffère selon les pages
  (`recipient_participant_id` ou `participant_recipient_id`) : à lire sur un vrai webhook.

## Ce qu'on pourrait en faire

Des salons de suivi à quelques personnes, où le contact ne parle plus seul à l'entreprise :

- un dossier à plusieurs intervenants : l'assuré, son juriste et l'avocat (protection juridique) ;
- l'onboarding d'un client B2B avec son équipe ;
- les co-titulaires d'un même contrat ou d'un même foyer.

## Ce que ça coûterait chez nous

Un chantier lourd : tout le produit est construit sur « une conversation = un contact » (fenêtre de 24 h, STOP,
Inbox, agent IA, scénarios). Il faudrait une notion de conversation de groupe dans le modèle de données, le
receiver (un `group_id` dans les messages entrants, quatre webhooks neufs), l'Inbox (plusieurs auteurs dans un fil),
la facturation par participant, et des scénarios privés de leurs blocs interactifs.

## Ce qui relancerait le sujet

Un client qui a déjà la coche verte, n'est pas en Coexistence, et apporte un cas réel à 8 personnes au plus. Première
brique alors : créer un salon, envoyer le lien d'invitation, recevoir les messages du groupe dans l'Inbox.
