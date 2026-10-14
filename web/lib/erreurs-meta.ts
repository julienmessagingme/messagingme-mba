// web/lib/erreurs-meta.ts
import type { Bilingue } from './api-exemples';

/**
 * LES ERREURS DE META QUI NOUS CONCERNENT (lot 17) : le catalogue de la doc (`/developers/api/errors`) les montre après
 * nos propres codes, une ancre par code (`#meta-131047`).
 *
 * 🔴 LA LISTE N'EST PAS TIRÉE DE NOTRE TRAFIC : le 2026-10-12, la production n'avait vu aucune erreur de Meta. Elle croise
 * la page officielle de Meta (« Error codes » de la Cloud API, lue le 2026-10-12) et les codes que notre code NOMME
 * (`src/meta/errors.ts` et ailleurs) : `tests/doc-erreurs-meta.test.ts` exige que chacun de ceux-là soit ici.
 *
 * `chezNous` dit ce que Messaging Me fait déjà de lui-même (un réessai, une pause de campagne) : l'intégrateur n'a pas à
 * le refaire. Absent quand nous ne faisons rien de particulier.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : lu par le build de la console ET par la suite racine.
 */

export type GroupeErreurMeta = 'compte' | 'debit' | 'destinataire' | 'modele' | 'contenu' | 'numero' | 'passagere';

export const GROUPES_ERREURS_META: ReadonlyArray<{ readonly cle: GroupeErreurMeta; readonly titre: Bilingue }> = [
  { cle: 'destinataire', titre: ['Le destinataire', 'The recipient'] },
  { cle: 'modele', titre: ['Les modèles', 'Templates'] },
  { cle: 'contenu', titre: ['Le contenu et les fichiers', 'Content and files'] },
  { cle: 'debit', titre: ['Le débit et la qualité', 'Throughput and quality'] },
  { cle: 'compte', titre: ['Le compte et la connexion', 'The account and the connection'] },
  { cle: 'numero', titre: ['L’enregistrement du numéro', 'Number registration'] },
  { cle: 'passagere', titre: ['Les pannes passagères', 'Temporary failures'] },
];

export interface ErreurMeta {
  readonly code: number;
  readonly groupe: GroupeErreurMeta;
  /** Ce que Meta veut dire, en une phrase. */
  readonly sens: Bilingue;
  /** Le geste qui règle, du côté de l'intégrateur ou de l'admin de l'espace. */
  readonly geste: Bilingue;
  /** Ce que Messaging Me fait déjà de lui-même. */
  readonly chezNous?: Bilingue;
}

const REJOUEE: Bilingue = [
  'Messaging Me la rejoue seul plusieurs fois avant d’annoncer l’échec.',
  'Messaging Me retries it on its own several times before reporting the failure.',
];

export const ERREURS_META = [
  // Le destinataire.
  {
    code: 131047, groupe: 'destinataire',
    sens: ['Plus de 24 h depuis le dernier message de la personne : la fenêtre est fermée.', 'More than 24 hours since the person’s last message: the window is closed.'],
    geste: ['Envoyer un modèle approuvé (POST /v1/sends) au lieu d’un message libre.', 'Send an approved template (POST /v1/sends) instead of a free-form message.'],
    chezNous: ['Quand elle le sait, l’API refuse avant Meta : window_closed.', 'When it knows, the API refuses before Meta: window_closed.'],
  },
  {
    code: 131026, groupe: 'destinataire',
    sens: ['Message non délivrable : le numéro n’est pas sur WhatsApp, la personne n’a pas accepté les conditions de WhatsApp, ou son application est trop ancienne.', 'Undeliverable message: the number is not on WhatsApp, the person has not accepted WhatsApp’s terms, or their app is too old.'],
    geste: ['Passer par un autre canal (RCS, e-mail), ou demander à la personne de mettre WhatsApp à jour.', 'Use another channel (RCS, email), or ask the person to update WhatsApp.'],
    chezNous: ['Une campagne à plusieurs canaux passe au suivant. Sinon, quand le réessai est actif (la case de la campagne, ou le réglage de l’espace pour un envoi de l’API), elle retente une fois, puis marque le contact injoignable sur WhatsApp.', 'A multi-channel campaign moves to the next channel. Otherwise, when retry is on (the campaign box, or the workspace setting for an API send), it retries once, then marks the contact unreachable on WhatsApp.'],
  },
  {
    code: 131049, groupe: 'destinataire',
    sens: ['Message marketing non délivré : Meta limite le marketing que chaque personne reçoit, pour préserver l’engagement.', 'Marketing message not delivered: Meta limits the marketing each person receives, to preserve engagement.'],
    geste: ['Ne pas réessayer tout de suite : attendre au moins 24 h. Meta ne dit pas quand la limite se lève.', 'Do not retry right away: wait at least 24 hours. Meta does not say when the limit lifts.'],
    chezNous: ['Quand le réessai est actif (la case de la campagne, ou le réglage de l’espace pour un envoi de l’API), il est retenté le lendemain matin.', 'When retry is on (the campaign box, or the workspace setting for an API send), it is tried again the next morning.'],
  },
  {
    code: 131050, groupe: 'destinataire',
    sens: ['La personne a refusé, dans WhatsApp, les messages marketing de votre entreprise.', 'The person has opted out, in WhatsApp, of your business’s marketing messages.'],
    geste: ['Ne pas réessayer, et ne plus lui envoyer de marketing.', 'Do not retry, and stop sending them marketing.'],
  },
  {
    code: 131021, groupe: 'destinataire',
    sens: ['L’expéditeur et le destinataire sont le même numéro.', 'The sender and the recipient are the same number.'],
    geste: ['Envoyer à un autre numéro que celui de l’espace.', 'Send to a number other than the workspace’s own.'],
  },
  {
    code: 130497, groupe: 'destinataire',
    sens: ['Le compte ne peut pas écrire aux personnes de ce pays.', 'The account cannot message people in this country.'],
    geste: ['Ce destinataire n’est pas joignable par ce compte : vérifier les pays autorisés dans la politique de Meta.', 'This recipient cannot be reached by this account: check the allowed countries in Meta’s policy.'],
  },
  // Les modèles.
  {
    code: 132000, groupe: 'modele',
    sens: ['Le nombre de paramètres ne correspond pas au modèle.', 'The number of parameters does not match the template.'],
    geste: ['Donner une valeur à chaque {{n}} du modèle, ni plus ni moins (params de POST /v1/sends).', 'Give a value to each {{n}} of the template, no more, no less (params of POST /v1/sends).'],
  },
  {
    code: 132001, groupe: 'modele',
    sens: ['Le modèle n’existe pas dans cette langue, ou il n’est pas approuvé.', 'The template does not exist in this language, or it is not approved.'],
    geste: ['Vérifier le nom, la langue et le statut du modèle (GET /v1/templates/{name}).', 'Check the template name, language and status (GET /v1/templates/{name}).'],
  },
  {
    code: 132012, groupe: 'modele',
    sens: ['Un paramètre n’a pas le format que le modèle attend.', 'A parameter does not have the format the template expects.'],
    geste: ['Respecter le format défini dans le modèle : texte, devise, date, fichier de l’en-tête.', 'Follow the format defined in the template: text, currency, date, header file.'],
  },
  {
    code: 132015, groupe: 'modele',
    sens: ['Modèle mis en pause par Meta pour mauvaise qualité.', 'Template paused by Meta for low quality.'],
    geste: ['Le modifier pour améliorer sa qualité, puis renvoyer une fois réapprouvé. L’événement template.status_changed le signale.', 'Edit it to improve its quality, then send again once re-approved. The template.status_changed event reports it.'],
  },
  {
    code: 132016, groupe: 'modele',
    sens: ['Modèle désactivé pour de bon, après des pauses répétées.', 'Template permanently disabled, after repeated pauses.'],
    geste: ['Créer un nouveau modèle, au contenu différent.', 'Create a new template, with different content.'],
  },
  {
    code: 132018, groupe: 'modele',
    sens: ['Les paramètres du modèle ne passent pas la validation de Meta.', 'The template parameters fail Meta’s validation.'],
    geste: ['Lire le détail de l’erreur, corriger les paramètres et renvoyer. Un modèle accepté à la création peut encore être refusé ainsi à l’envoi.', 'Read the error detail, fix the parameters and send again. A template accepted at creation can still be refused this way when sent.'],
  },
  {
    code: 134100, groupe: 'modele',
    sens: ['La Marketing Messages API n’accepte que les modèles de catégorie marketing.', 'The Marketing Messages API only accepts marketing category templates.'],
    geste: ['Renvoyer : le modèle a sans doute été reclassé par Meta entre la lecture de sa catégorie et l’envoi.', 'Send again: Meta probably reclassified the template between the reading of its category and the send.'],
    chezNous: ['Messaging Me lit la catégorie du modèle chez Meta et n’envoie par cette API que les modèles marketing.', 'Messaging Me reads the template category at Meta and only sends marketing templates through this API.'],
  },
  {
    code: 134101, groupe: 'modele',
    sens: ['Le modèle a été créé, ou réutilisé après 7 jours sans envoi, il y a moins de 10 minutes : Meta le synchronise encore.', 'The template was created, or reused after 7 days without sending, less than 10 minutes ago: Meta is still syncing it.'],
    geste: ['Attendre 10 minutes, puis renvoyer.', 'Wait 10 minutes, then send again.'],
    chezNous: ['Messaging Me renvoie aussitôt le message par la Cloud API, au même prix : vous ne le verrez que si ce second envoi échoue aussi.', 'Messaging Me immediately sends the message through the Cloud API instead, at the same price: you only see it if that second send fails too.'],
  },
  {
    code: 134102, groupe: 'modele',
    sens: ['Le modèle est indisponible pour la Marketing Messages API : sa synchronisation a échoué, ou le compte n’y est pas éligible.', 'The template is unavailable for the Marketing Messages API: its sync failed, or the account is not eligible.'],
    geste: ['Vérifier l’éligibilité du compte WhatsApp dans WhatsApp Manager, puis contacter le support de Meta si elle est bonne.', 'Check the WhatsApp account eligibility in WhatsApp Manager, then contact Meta support if it is fine.'],
  },
  // Le contenu et les fichiers.
  {
    code: 100, groupe: 'contenu',
    sens: ['Paramètre invalide dans la demande.', 'Invalid parameter in the request.'],
    geste: ['Lire le message de Meta, qui nomme le champ, et corriger la demande.', 'Read Meta’s message, which names the field, and fix the request.'],
  },
  {
    code: 131008, groupe: 'contenu',
    sens: ['Paramètre obligatoire manquant.', 'Required parameter missing.'],
    geste: ['Compléter le corps selon le format de Meta (POST /v1/messages).', 'Complete the body following Meta’s format (POST /v1/messages).'],
  },
  {
    code: 131009, groupe: 'contenu',
    sens: ['Valeur de paramètre non valide : un titre de bouton trop long, une adresse mal formée…', 'Invalid parameter value: a button title too long, a malformed URL…'],
    geste: ['Lire le message de Meta, qui nomme la valeur, et la corriger.', 'Read Meta’s message, which names the value, and fix it.'],
  },
  {
    code: 131051, groupe: 'contenu',
    sens: ['Type de message non pris en charge.', 'Unsupported message type.'],
    geste: ['Utiliser un type que WhatsApp accepte : texte, image, document, modèle…', 'Use a type WhatsApp accepts: text, image, document, template…'],
  },
  {
    code: 131052, groupe: 'contenu',
    sens: ['Le fichier envoyé par la personne n’a pas pu être téléchargé.', 'The file sent by the person could not be downloaded.'],
    geste: ['Demander à la personne de le renvoyer.', 'Ask the person to send it again.'],
  },
  {
    code: 131053, groupe: 'contenu',
    sens: ['Le dépôt d’un fichier chez Meta a échoué : type ou taille refusés.', 'Uploading a file to Meta failed: type or size refused.'],
    geste: ['Vérifier le type et la taille du fichier, puis renvoyer.', 'Check the file type and size, then send again.'],
  },
  // Le débit et la qualité.
  {
    code: 130429, groupe: 'debit',
    sens: ['Débit d’envoi du numéro dépassé.', 'The number’s sending throughput is exceeded.'],
    geste: ['Étaler les envois et réessayer quelques secondes plus tard.', 'Spread out sends and retry a few seconds later.'],
    chezNous: ['Rejouée seule ; une campagne se met en pause et repart d’elle-même.', 'Retried on its own; a campaign pauses and resumes by itself.'],
  },
  {
    code: 131048, groupe: 'debit',
    sens: ['Envois restreints pour ce numéro : trop de messages bloqués ou signalés comme spam.', 'Sending restricted for this number: too many messages blocked or reported as spam.'],
    geste: ['Regarder la qualité du numéro dans le WhatsApp Manager, revoir le ciblage et le contenu avant de relancer.', 'Check the number’s quality in WhatsApp Manager, review targeting and content before resuming.'],
    chezNous: ['Une campagne se met en pause qualité, que rien ne lève automatiquement.', 'A campaign goes into a quality pause that nothing lifts automatically.'],
  },
  {
    code: 131056, groupe: 'debit',
    sens: ['Trop de messages du même numéro vers le même destinataire en peu de temps.', 'Too many messages from the same number to the same recipient in a short time.'],
    geste: ['Attendre avant de réécrire à ce destinataire ; les autres ne sont pas touchés.', 'Wait before writing to this recipient again; the others are not affected.'],
    chezNous: REJOUEE,
  },
  {
    code: 4, groupe: 'debit',
    sens: ['Le plafond d’appels de l’application chez Meta est atteint.', 'The app’s call limit at Meta is reached.'],
    geste: ['Ralentir, puis réessayer plus tard.', 'Slow down, then retry later.'],
    chezNous: REJOUEE,
  },
  {
    code: 80007, groupe: 'debit',
    sens: ['Le plafond d’appels du compte WhatsApp est atteint.', 'The WhatsApp account’s call limit is reached.'],
    geste: ['Ralentir, puis réessayer plus tard.', 'Slow down, then retry later.'],
  },
  // Le compte et la connexion.
  {
    code: 190, groupe: 'compte',
    sens: ['Le jeton d’accès de l’espace a expiré ou a été révoqué.', 'The workspace’s access token has expired or been revoked.'],
    geste: ['Un admin clique « Renouveler la connexion Meta » sur l’Accueil de la console.', 'An admin clicks “Renew the Meta connection” on the console Home page.'],
    chezNous: ['Par l’API, il sort en 409 meta_auth_failed, sur toute route.', 'Through the API, it comes out as 409 meta_auth_failed, on every route.'],
  },
  {
    code: 10, groupe: 'compte',
    sens: ['Une permission manque ou a été retirée sur le compte WhatsApp.', 'A permission is missing or was removed on the WhatsApp account.'],
    geste: ['Renouveler la connexion Meta en acceptant toutes les permissions demandées.', 'Renew the Meta connection, accepting all the permissions requested.'],
  },
  {
    code: 131042, groupe: 'compte',
    sens: ['Problème de moyen de paiement sur le compte WhatsApp.', 'Payment method problem on the WhatsApp account.'],
    geste: ['Ajouter ou corriger la carte dans le Business Manager (Facturation) : Meta l’exige pour ce qu’il facture, à commencer par les modèles, quelle que soit l’offre Messaging Me.', 'Add or fix the card in Business Manager (Billing): Meta requires it for what it charges, starting with templates, whatever the Messaging Me plan.'],
  },
  {
    code: 368, groupe: 'compte',
    sens: ['Compte restreint ou désactivé pour non-respect des règles de Meta.', 'Account restricted or disabled for breaking Meta’s rules.'],
    geste: ['Lire l’avis dans le WhatsApp Manager et faire appel si besoin : rien ne repartira avant la levée.', 'Read the notice in WhatsApp Manager and appeal if needed: nothing will go out until it is lifted.'],
  },
  {
    code: 131031, groupe: 'compte',
    sens: ['Compte verrouillé par Meta, ou vérification échouée (code PIN à deux étapes faux).', 'Account locked by Meta, or verification failed (wrong two-step PIN).'],
    geste: ['Vérifier l’état du compte dans le WhatsApp Manager ; pour le PIN, le reposer.', 'Check the account status in WhatsApp Manager; for the PIN, set it again.'],
  },
  // L'enregistrement du numéro (le parcours de connexion de la console).
  {
    code: 133006, groupe: 'numero',
    sens: ['Le numéro doit être vérifié avant d’être enregistré.', 'The number must be verified before it is registered.'],
    geste: ['Finir la vérification du numéro (code par SMS ou par appel) depuis la console.', 'Finish verifying the number (code by SMS or call) from the console.'],
  },
  {
    code: 133016, groupe: 'numero',
    sens: ['Trop de tentatives d’enregistrement du numéro en peu de temps.', 'Too many registration attempts for the number in a short time.'],
    geste: ['Attendre le déblocage, jusqu’à 72 h, avant de réessayer.', 'Wait until it is unblocked, up to 72 hours, before retrying.'],
  },
  {
    code: 136024, groupe: 'numero',
    sens: ['Le numéro est déjà vérifié : Meta refuse une nouvelle demande de code.', 'The number is already verified: Meta refuses a new code request.'],
    geste: ['Passer directement à l’enregistrement, sans redemander de code.', 'Go straight to registration, without asking for another code.'],
  },
  // Les pannes passagères.
  {
    code: 131000, groupe: 'passagere',
    sens: ['Échec inconnu chez Meta.', 'Unknown failure at Meta.'],
    geste: ['Réessayer ; s’il persiste sur le même message, changer le contenu.', 'Retry; if it persists on the same message, change the content.'],
    chezNous: ['Le dépôt d’un fichier est réessayé seul : environ un sur dix échoue ainsi.', 'A file upload is retried on its own: about one in ten fails this way.'],
  },
  {
    code: 131016, groupe: 'passagere',
    sens: ['Service de Meta momentanément indisponible.', 'Meta’s service is temporarily unavailable.'],
    geste: ['Réessayer plus tard.', 'Retry later.'],
    chezNous: REJOUEE,
  },
  {
    code: 1, groupe: 'passagere',
    sens: ['Erreur inconnue de l’API de Meta, souvent passagère.', 'Unknown Meta API error, often temporary.'],
    geste: ['Réessayer plus tard.', 'Retry later.'],
    chezNous: REJOUEE,
  },
  {
    code: 2, groupe: 'passagere',
    sens: ['Service de l’API de Meta momentanément indisponible.', 'Meta API service temporarily unavailable.'],
    geste: ['Réessayer dans quelques minutes.', 'Retry in a few minutes.'],
    chezNous: REJOUEE,
  },
] as const satisfies readonly ErreurMeta[];

/** L'ancre d'un code de Meta dans le catalogue. */
export function ancreErreurMeta(code: number): string {
  return `meta-${code}`;
}
