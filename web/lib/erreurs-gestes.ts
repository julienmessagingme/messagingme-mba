// web/lib/erreurs-gestes.ts
import type { Bilingue, NomDeCode } from './api-exemples';

/**
 * LE GESTE QUI RÈGLE CHAQUE CODE DE L'API (lot 17) : ce que l'intégrateur fait quand il le reçoit. Le catalogue de la doc
 * (`/developers/api/errors`) le montre à côté du statut et du sens (`CODES_DOCUMENTES`).
 *
 * 🔴 UN `Record` SUR TOUS LES CODES DOCUMENTÉS : un code ajouté à la table du serveur, donc à `CODES_DOCUMENTES` (que
 * `tests/api-exemples.test.ts` tient égal à elle), ne compile pas ici tant que son geste n'est pas écrit. Le geste vit à
 * part du sens pour ne pas allonger la table que plusieurs tests et pages lisent déjà.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : lu par le build de la console ET par la suite racine.
 */
export const GESTES: Readonly<Record<NomDeCode, Bilingue>> = {
  invalid_body: ['Corriger le champ que le message nomme. Toujours envoyer Content-Type: application/json.', 'Fix the field the message names. Always send Content-Type: application/json.'],
  invalid_recipient: ['Désigner la personne par au moins une clé : contactId, externalId, phone ou bsuid.', 'Identify the person with at least one key: contactId, externalId, phone or bsuid.'],
  invalid_phone: ['Écrire le numéro au format international, indicatif compris (+33612345678).', 'Write the number in international format, with its country code (+33612345678).'],
  unauthorized: ['Vérifier l’en-tête Authorization: Bearer mba_… ; si la clé a été révoquée, en créer une dans Developers > Clés d’API.', 'Check the Authorization: Bearer mba_… header; if the key was revoked, create one in Developers > API keys.'],
  missing_scope: ['Créer une clé qui porte le droit de la route (la liste des droits est sur la page Authentification).', 'Create a key that carries the route’s scope (the scope list is on the Authentication page).'],
  tenant_locked: ['Inutile de refaire une clé : un admin regarde dans la console pourquoi l’espace est suspendu.', 'No need for a new key: an admin checks in the console why the workspace is suspended.'],
  unknown_contact: ['Créer la fiche d’abord (POST /v1/contacts), ou vérifier la clé donnée.', 'Create the record first (POST /v1/contacts), or check the key given.'],
  duplicate: ['Retirer le doublon de la liste des destinataires ; il n’a reçu qu’un message.', 'Remove the duplicate from the recipient list; it received only one message.'],
  identity_conflict: ['Ne donner qu’une clé, ou corriger l’identifiant externe porté par l’autre fiche : rien n’a été écrit.', 'Give a single key, or fix the external id carried by the other record: nothing was written.'],
  blocked_contact: ['Un admin débloque la fiche dans la console, s’il le faut.', 'An admin unblocks the record in the console, if needed.'],
  opted_out: ['Ne plus écrire à cette personne : elle a dit STOP. L’API ne la réabonne pas ; seuls un opérateur ou la personne elle-même le peuvent.', 'Stop writing to this person: they said STOP. The API does not resubscribe them; only an operator or the person themselves can.'],
  no_consent: ['Poser sur la fiche le consentement recueilli (consent, consentSource) avant un envoi marketing.', 'Set the collected consent on the record (consent, consentSource) before a marketing send.'],
  window_closed: ['Envoyer un modèle approuvé (POST /v1/sends) : un message libre ne part que dans les 24 h qui suivent le dernier message de la personne.', 'Send an approved template (POST /v1/sends): a free-form message only goes out within 24 hours of the person’s last message.'],
  missing_variable: ['Remplir la variable sur la fiche, ou donner une valeur de repli (fallback) au paramètre.', 'Fill the variable on the record, or give the parameter a fallback value.'],
  no_phone: ['Ajouter un numéro à la fiche.', 'Add a phone number to the record.'],
  rcs_unreachable: ['Le numéro n’a pas RCS : passer par WhatsApp.', 'The number has no RCS: use WhatsApp.'],
  rcs_not_enabled: ['Envoyer en WhatsApp, ou faire activer le RCS de l’espace.', 'Send over WhatsApp, or have RCS enabled on the workspace.'],
  no_whatsapp_number: ['Un admin connecte un numéro WhatsApp à l’espace depuis l’Accueil de la console.', 'An admin connects a WhatsApp number to the workspace from the console Home page.'],
  meta_rejected: ['Chercher metaCode dans les erreurs de Meta, plus bas sur cette page, et appliquer son geste.', 'Look up metaCode in Meta’s errors, further down this page, and apply its fix.'],
  invalid_header_media: ['Servir le fichier d’en-tête à une adresse https publique, au bon type et sous la taille admise.', 'Serve the header file at a public https address, with the right type and under the allowed size.'],
  template_rejected: ['Corriger le modèle selon le motif donné, puis le recréer.', 'Fix the template according to the reason given, then create it again.'],
  meta_auth_failed: ['Un admin clique « Renouveler la connexion Meta » sur l’Accueil de la console.', 'An admin clicks “Renew the Meta connection” on the console Home page.'],
  webhook_not_found: ['Vérifier l’identifiant de l’adresse (GET /v1/webhooks).', 'Check the endpoint id (GET /v1/webhooks).'],
  delivery_not_found: ['Vérifier l’identifiant dans le journal de l’adresse (GET /v1/webhooks/{webhookId}/deliveries).', 'Check the id in the endpoint’s log (GET /v1/webhooks/{webhookId}/deliveries).'],
  delivery_not_replayable: ['Attendre la fin des réessais ; un essai ne se rejoue pas.', 'Wait for the retries to end; a test is never replayed.'],
  webhooks_unavailable: ['Réessayer plus tard.', 'Retry later.'],
  field_exists: ['Réutiliser le champ existant (GET /v1/fields), ou choisir un autre libellé.', 'Reuse the existing field (GET /v1/fields), or pick another label.'],
  number_unlinked: ['Un admin relie le numéro depuis l’Accueil de la console.', 'An admin relinks the number from the console Home page.'],
  number_suspended: ['Régler l’abonnement du numéro dans la console : les envois repartent au paiement.', 'Settle the number subscription in the console: sends resume on payment.'],
  scenario_not_found: ['Lire le catalogue (GET /v1/scenarios) et utiliser un code de scénario existant.', 'Read the catalog (GET /v1/scenarios) and use an existing scenario code.'],
  node_not_found: ['Lire le catalogue (GET /v1/scenarios) : le bloc n’existe pas dans la version publiée du scénario.', 'Read the catalog (GET /v1/scenarios): the block does not exist in the scenario’s published version.'],
  template_not_found: ['Lire le catalogue (GET /v1/templates) ; un modèle en attente de Meta n’y figure qu’une fois approuvé.', 'Read the catalog (GET /v1/templates); a template pending at Meta only appears once approved.'],
  rcs_message_not_found: ['Lire la bibliothèque (GET /v1/rcs-messages) et utiliser un nom existant.', 'Read the library (GET /v1/rcs-messages) and use an existing name.'],
  send_not_found: ['Vérifier le sendId rendu par POST /v1/sends.', 'Check the sendId returned by POST /v1/sends.'],
  conversation_not_found: ['Vérifier l’identifiant (GET /v1/conversations).', 'Check the id (GET /v1/conversations).'],
  message_not_found: ['Vérifier l’identifiant du message (GET /v1/conversations/{conversationId}/messages).', 'Check the message id (GET /v1/conversations/{conversationId}/messages).'],
  invalid_cursor: ['Renvoyer tel quel le nextCursor de la page précédente.', 'Send back the previous page’s nextCursor as is.'],
  no_media: ['Lire le type du message avant de demander son fichier.', 'Read the message type before asking for its file.'],
  media_expired: ['Trop tard pour ce fichier : le télécharger dès l’événement message.received.', 'Too late for this file: download it as soon as the message.received event arrives.'],
  media_unavailable: ['Réessayer un peu plus tard.', 'Retry a little later.'],
  scenario_ambiguous: ['Désigner le scénario par son code scn_… plutôt que par son nom.', 'Designate the scenario by its scn_… code rather than by its name.'],
  unsendable_target: ['Lire le motif, puis choisir une cible envoyable : un modèle approuvé, un scénario publié.', 'Read the reason, then pick a sendable target: an approved template, a published scenario.'],
  template_category_unknown: ['Réessayer plus tard ; si cela dure, vérifier le modèle dans le WhatsApp Manager.', 'Retry later; if it persists, check the template in WhatsApp Manager.'],
  idempotency_key_required: ['Ajouter l’en-tête Idempotency-Key (ou idempotencyKey dans le corps).', 'Add the Idempotency-Key header (or idempotencyKey in the body).'],
  idempotency_in_progress: ['Attendre la fin du premier appel, puis rejouer avec la même clé : il rendra le même résultat.', 'Wait for the first call to finish, then replay with the same key: it returns the same result.'],
  idempotency_key_reused: ['Prendre une clé neuve pour un corps différent.', 'Use a new key for a different body.'],
  rate_limited: ['Attendre retry-after secondes, puis réessayer.', 'Wait retry-after seconds, then retry.'],
  quota_exceeded: ['Attendre la remise à zéro que donne retry-after (minuit, heure de Paris), ou envoyer un lot plus petit.', 'Wait for the reset that retry-after gives (midnight, Paris time), or send fewer items in one call.'],
  plan_feature_unavailable: ['Changer d’offre sur la page que donne upgradeUrl.', 'Change plan on the page upgradeUrl gives.'],
  plan_limit_reached: ['Changer d’offre sur la page que donne upgradeUrl, ou attendre la remise à zéro de la limite.', 'Change plan on the page upgradeUrl gives, or wait for the limit to reset.'],
  route_not_found: ['Vérifier la méthode et le chemin dans le contrat OpenAPI (GET /openapi.json).', 'Check the method and path in the OpenAPI contract (GET /openapi.json).'],
  internal_error: ['Réessayer, avec un délai qui grandit ; un envoi se rejoue sans doublon avec la même clé d’idempotence.', 'Retry, with a growing delay; a send is replayed without duplicates using the same idempotency key.'],
};
