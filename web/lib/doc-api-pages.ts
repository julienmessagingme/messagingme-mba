// web/lib/doc-api-pages.ts
import type { Bilingue } from './api-exemples';

/**
 * LA CARTE DE LA DOCUMENTATION PUBLIQUE : ses pages, leur place dans la navigation, leurs ancres, et la liste
 * FERMÉE des fichiers qui la composent (refonte du 2026-09-25, `docs/superpowers/plans/2026-09-25-refonte-doc-api.md`).
 *
 * 🔴 DÉCLARÉE ICI, UNE SEULE FOIS, ET LUE PAR TROIS FAMILLES DE CONSOMMATEURS : la navigation de la doc
 * (`components/doc-api/CadreDoc.tsx`), les gardes de source (`tests/api-exemples.test.ts`,
 * `tests/web-signaux-parite.test.ts`, `tests/web-risque-parite.test.ts`, `web/lib/api-base.test.ts`), et l'e2e
 * (`web/e2e/developers-api.spec.ts`), qui ouvre chaque page, et vérifie chaque ancre. Une page listée ici est
 * donc gardée partout ; une page posée dans `web/app/developers/api/` sans être listée ici fait tomber
 * `tests/api-exemples.test.ts`, qui compare cette liste au dossier.
 *
 * ⚠️ `/developers/api` et `/developers/mcp` sont publiées sur la vitrine (`site/index.html`) : elles restent
 * l'accueil de la doc et la page MCP, sans redirection.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : ce fichier est lu par le build de la console ET par la suite racine (la même
 * contrainte que `api-exemples.ts`, dont il ne tire qu'un type, effacé à la compilation).
 */

export type GroupeDoc = 'demarrer' | 'reference-api' | 'guides' | 'recettes' | 'plateforme';

/** Les groupes de la navigation, dans leur ordre d'affichage. « Référence » ne désigne plus que les ressources. */
export const GROUPES_DOC: ReadonlyArray<{ readonly cle: GroupeDoc; readonly titre: Bilingue }> = [
  { cle: 'demarrer', titre: ['Démarrer', 'Get started'] },
  { cle: 'reference-api', titre: ['Référence API', 'API reference'] },
  { cle: 'guides', titre: ['Guides', 'Guides'] },
  // Le code d'un cas d'usage, de bout en bout (lots 6 et 6 bis) : un guide du registre de la vitrine y est rangé.
  { cle: 'recettes', titre: ['Recettes', 'Recipes'] },
  { cle: 'plateforme', titre: ['Plateforme', 'Platform'] },
];

export interface PageDoc {
  readonly cle: string;
  readonly href: string;
  /** Le fichier qui rend la page, depuis la racine du dépôt. */
  readonly fichier: string;
  readonly groupe: GroupeDoc;
  /** Le libellé dans la navigation. */
  readonly nav: Bilingue;
  /** Le `h1` de la page, le seul. */
  readonly titre: Bilingue;
  /** Les ancres que les autres pages visent (`id` d'une section). L'e2e vérifie que chacune existe. */
  readonly ancres: readonly string[];
}

export const PAGES_DOC = [
  {
    cle: 'accueil', href: '/developers/api', fichier: 'web/app/developers/api/page.tsx', groupe: 'demarrer',
    nav: ['Accueil', 'Overview'], titre: ['API Messaging Me', 'Messaging Me API'],
    ancres: ['premier-appel', 'endpoints', 'adresse', 'openapi', 'authentification'],
  },
  {
    // De l'inscription au premier webhook vérifié (lot 17).
    cle: 'quickstart', href: '/developers/api/quickstart', fichier: 'web/app/developers/api/quickstart/page.tsx', groupe: 'demarrer',
    nav: ['Démarrer', 'Quickstart'], titre: ['Démarrer en dix minutes', 'Get started in ten minutes'],
    ancres: ['espace', 'cle', 'premier-envoi', 'webhook', 'ensuite'],
  },
  {
    // Le client TypeScript (lot 16, livraison B), publié dans son propre dépôt.
    cle: 'sdk', href: '/developers/api/sdk', fichier: 'web/app/developers/api/sdk/page.tsx', groupe: 'demarrer',
    nav: ['SDK TypeScript', 'TypeScript SDK'], titre: ['SDK TypeScript', 'TypeScript SDK'],
    ancres: ['installation', 'premier-appel', 'erreurs', 'webhook'],
  },
  {
    cle: 'contacts', href: '/developers/api/contacts', fichier: 'web/app/developers/api/contacts/page.tsx', groupe: 'reference-api',
    nav: ['Contacts', 'Contacts'], titre: ['Contacts', 'Contacts'],
    ancres: ['creer', 'lot', 'lire', 'rechercher', 'modifier', 'effacer', 'champs', 'creer-champ'],
  },
  {
    cle: 'messages', href: '/developers/api/messages', fichier: 'web/app/developers/api/messages/page.tsx', groupe: 'reference-api',
    nav: ['Messages', 'Messages'], titre: ['Messages', 'Messages'],
    ancres: ['messages-simples', 'message-whatsapp', 'message-meta', 'message-rcs'],
  },
  {
    // La lecture des fils (lot 13, domaine 1) : conversations, messages, statut, fichiers reçus.
    cle: 'conversations', href: '/developers/api/conversations', fichier: 'web/app/developers/api/conversations/page.tsx', groupe: 'reference-api',
    nav: ['Conversations', 'Conversations'], titre: ['Conversations', 'Conversations'],
    ancres: ['lister', 'lire', 'messages', 'message', 'media', 'pagination'],
  },
  {
    cle: 'sends', href: '/developers/api/sends', fichier: 'web/app/developers/api/sends/page.tsx', groupe: 'reference-api',
    nav: ['Envois', 'Sends'], titre: ['Envois', 'Sends'],
    ancres: ['envoi', 'cibles', 'destinataires', 'parametres', 'ouverture', 'categorie', 'suivi'],
  },
  {
    // Les modèles (lot 13, domaine 3) : créer au format de Meta, suivre la validation.
    cle: 'templates', href: '/developers/api/templates', fichier: 'web/app/developers/api/templates/page.tsx', groupe: 'reference-api',
    nav: ['Modèles', 'Templates'], titre: ['Modèles', 'Templates'],
    ancres: ['creer', 'statut'],
  },
  {
    // Les webhooks sortants gérés par une clé (lot 13, domaine 4). Le format des événements reste sur `webhooks`.
    cle: 'webhook-endpoints', href: '/developers/api/webhook-endpoints', fichier: 'web/app/developers/api/webhook-endpoints/page.tsx', groupe: 'reference-api',
    nav: ['Gérer les webhooks', 'Manage webhooks'], titre: ['Gérer les webhooks sortants', 'Manage outgoing webhooks'],
    ancres: ['lister', 'creer', 'lire', 'modifier', 'rotation', 'supprimer', 'essai', 'journal', 'rejeu', 'rejeu-echecs'],
  },
  {
    cle: 'catalogs', href: '/developers/api/catalogs', fichier: 'web/app/developers/api/catalogs/page.tsx', groupe: 'reference-api',
    nav: ['Catalogues', 'Catalogs'], titre: ['Catalogues', 'Catalogs'],
    ancres: ['templates', 'scenarios', 'messages-rcs'],
  },
  {
    cle: 'concepts', href: '/developers/api/concepts', fichier: 'web/app/developers/api/concepts/page.tsx', groupe: 'guides',
    nav: ['Concepts', 'Concepts'], titre: ['Concepts', 'Concepts'],
    ancres: ['identification', 'consentement', 'fenetre-24h', 'idempotence'],
  },
  {
    cle: 'per-contact', href: '/developers/api/guides/per-contact', fichier: 'web/app/developers/api/guides/per-contact/page.tsx', groupe: 'guides',
    nav: ['Un appel par contact', 'One call per contact'], titre: ['Brancher un outil qui appelle par contact', 'Connecting a tool that calls per contact'],
    ancres: ['cle'],
  },
  {
    // Ce que Meta impose et qui surprend (lot 17) ; chaque piège renvoie à son code dans le catalogue des erreurs.
    cle: 'meta-pitfalls', href: '/developers/api/guides/meta-pitfalls', fichier: 'web/app/developers/api/guides/meta-pitfalls/page.tsx', groupe: 'guides',
    nav: ['Pièges de Meta', 'Meta pitfalls'], titre: ['Les pièges de Meta', 'Meta pitfalls'],
    ancres: ['fenetre', 'modeles', 'facturation', 'paiement', 'consentement', 'qualite', 'debit', 'marketing', 'nom-affiche', 'injoignable', 'medias'],
  },
  {
    // La recette Next.js (lot 17) : un prompt à coller, et le code qu'il doit produire, compilé par la suite racine.
    cle: 'nextjs', href: '/developers/api/guides/nextjs', fichier: 'web/app/developers/api/guides/nextjs/page.tsx', groupe: 'recettes',
    nav: ['Recette Next.js', 'Next.js recipe'], titre: ['Recette : Next.js', 'Recipe: Next.js'],
    ancres: ['prompt', 'installation', 'client', 'envoi', 'webhook', 'essayer'],
  },
  {
    // Les rappels de rendez-vous (lot 6 bis) : le code de EXEMPLES_CAS.rappels, celui de la commande /messagingme:rappels.
    cle: 'appointment-reminders', href: '/developers/api/guides/appointment-reminders', fichier: 'web/app/developers/api/guides/appointment-reminders/page.tsx', groupe: 'recettes',
    nav: ['Rappels de rendez-vous', 'Appointment reminders'], titre: ['Recette : les rappels de rendez-vous', 'Recipe: appointment reminders'],
    ancres: ['prompt', 'modele', 'actions', 'code', 'webhook', 'essayer'],
  },
  {
    // La prise de rendez-vous (lot 6 bis) : le code de EXEMPLES_CAS['rendez-vous'], deux actions de l'agent IA.
    cle: 'appointment-booking', href: '/developers/api/guides/appointment-booking', fichier: 'web/app/developers/api/guides/appointment-booking/page.tsx', groupe: 'recettes',
    nav: ['Prise de rendez-vous', 'Appointment booking'], titre: ['Recette : la prise de rendez-vous', 'Recipe: appointment booking'],
    ancres: ['prompt', 'actions', 'code', 'webhook', 'essayer'],
  },
  {
    // L'accueil des utilisateurs d'un SaaS (lot 6 bis) : le code de EXEMPLES_CAS.accueil, un modèle MARKETING consenti.
    cle: 'saas-onboarding-activation', href: '/developers/api/guides/saas-onboarding-activation', fichier: 'web/app/developers/api/guides/saas-onboarding-activation/page.tsx', groupe: 'recettes',
    nav: ['Accueil des utilisateurs', 'User onboarding'], titre: ['Recette : l’accueil des utilisateurs d’un SaaS', 'Recipe: SaaS user onboarding'],
    ancres: ['prompt', 'modele', 'consentement', 'code', 'essayer'],
  },
  {
    // La relance d'un paiement échoué (lot 6 bis) : le code de EXEMPLES_CAS['relance-paiement'], dans le webhook Stripe.
    cle: 'failed-payment-recovery', href: '/developers/api/guides/failed-payment-recovery', fichier: 'web/app/developers/api/guides/failed-payment-recovery/page.tsx', groupe: 'recettes',
    nav: ['Paiement échoué', 'Failed payment'], titre: ['Recette : la relance d’un paiement échoué', 'Recipe: failed payment recovery'],
    ancres: ['prompt', 'modele', 'code', 'stripe', 'essayer'],
  },
  {
    // Les notifications de commande (lot 6 bis) : le code de EXEMPLES_CAS.notifications.
    cle: 'order-notifications', href: '/developers/api/guides/order-notifications', fichier: 'web/app/developers/api/guides/order-notifications/page.tsx', groupe: 'recettes',
    nav: ['Notifications de commande', 'Order notifications'], titre: ['Recette : les notifications de commande', 'Recipe: order notifications'],
    ancres: ['prompt', 'modele', 'code', 'webhook', 'reponse', 'essayer'],
  },
  {
    cle: 'events', href: '/developers/api/events', fichier: 'web/app/developers/api/events/page.tsx', groupe: 'plateforme',
    nav: ['Événements', 'Events'], titre: ['Événements', 'Events'],
    ancres: ['signaux'],
  },
  {
    // Les webhooks sortants (lot 12) : l'enveloppe, la signature, les réessais et chaque type.
    cle: 'webhooks', href: '/developers/api/webhooks', fichier: 'web/app/developers/api/webhooks/page.tsx', groupe: 'plateforme',
    nav: ['Webhooks sortants', 'Outgoing webhooks'], titre: ['Webhooks sortants', 'Outgoing webhooks'],
    ancres: ['enveloppe', 'signature', 'reessais', 'types'],
  },
  {
    // L'adresse garde « reference » : publiée le 2026-09-25 (lot 1), elle peut déjà être en favori. Seul le titre change.
    cle: 'reference', href: '/developers/api/reference', fichier: 'web/app/developers/api/reference/page.tsx', groupe: 'plateforme',
    nav: ['Authentification, limites et erreurs', 'Authentication, limits and errors'],
    titre: ['Authentification, limites et erreurs', 'Authentication, limits and errors'],
    ancres: ['authentification', 'debit', 'erreurs'],
  },
  {
    // Le catalogue des erreurs (lot 17) : nos codes et les erreurs de Meta, une ancre par code (hors liste ci-dessous :
    // les autres pages les visent par `LienErreur`, typé sur les deux listes de codes).
    cle: 'errors', href: '/developers/api/errors', fichier: 'web/app/developers/api/errors/page.tsx', groupe: 'plateforme',
    nav: ['Catalogue des erreurs', 'Error catalog'], titre: ['Catalogue des erreurs', 'Error catalog'],
    ancres: ['forme', 'codes', 'meta'],
  },
  {
    cle: 'mcp', href: '/developers/mcp', fichier: 'web/app/developers/mcp/page.tsx', groupe: 'plateforme',
    nav: ['Serveur MCP', 'MCP server'], titre: ['Serveur MCP', 'MCP server'],
    ancres: [],
  },
] as const satisfies readonly PageDoc[];

export type CleDePage = (typeof PAGES_DOC)[number]['cle'];

/**
 * UNE PHRASE PAR PAGE, pour le `llms.txt` de la console (lot 17) : ce qu'un modèle y trouvera. Un `Record` sur toutes les
 * pages : une page ajoutée à la carte ne compile pas sans sa phrase.
 */
export const RESUMES_PAGES: Readonly<Record<CleDePage, Bilingue>> = {
  accueil: ['L’API REST : son adresse, l’authentification par clé, un premier appel et l’index des routes.', 'The REST API: its address, key authentication, a first call and the route index.'],
  quickstart: ['De l’inscription au premier message envoyé par l’API : l’espace, la clé, un webhook reçu et vérifié, une réponse, puis un premier modèle.', 'From sign-up to the first message sent through the API: the workspace, the key, a webhook received and verified, a reply, then a first template.'],
  sdk: ['Le client TypeScript : installation, appels typés, erreurs typées, vérification des webhooks.', 'The TypeScript client: installation, typed calls, typed errors, webhook verification.'],
  contacts: ['Créer, lire, chercher, modifier et effacer des fiches, et leurs champs personnalisés.', 'Create, read, find, update and erase records, and their custom fields.'],
  messages: ['Écrire à une personne : texte simple, message au format de Meta, RCS.', 'Write to a person: plain text, message in Meta’s format, RCS.'],
  conversations: ['Lire les conversations, leurs messages, le statut d’un message et les fichiers reçus.', 'Read conversations, their messages, a message’s status and received files.'],
  sends: ['Envoyer un modèle, un scénario ou un message RCS à des destinataires, et suivre l’envoi.', 'Send a template, a scenario or an RCS message to recipients, and follow the send.'],
  templates: ['Créer un modèle WhatsApp au format de Meta et suivre sa validation.', 'Create a WhatsApp template in Meta’s format and follow its review.'],
  'webhook-endpoints': ['Gérer par l’API les adresses des webhooks sortants : créer, tester, lire le journal, rejouer.', 'Manage outgoing webhook endpoints through the API: create, test, read the log, replay.'],
  catalogs: ['Lister les modèles approuvés, les scénarios publiés et les messages RCS de l’espace.', 'List the workspace’s approved templates, published scenarios and RCS messages.'],
  concepts: ['Les règles communes : désigner une personne, consentement et STOP, fenêtre de 24 h, idempotence.', 'The common rules: identifying a person, consent and STOP, the 24-hour window, idempotency.'],
  'per-contact': ['Brancher un outil qui appelle l’API une fois par contact.', 'Connecting a tool that calls the API once per contact.'],
  'meta-pitfalls': ['Ce que Meta impose et qui surprend : fenêtre de 24 h, modèles, facturation, qualité, débit, consentement.', 'What Meta imposes and what surprises: the 24-hour window, templates, billing, quality, throughput, consent.'],
  nextjs: ['Une recette Next.js : envoyer un modèle et recevoir un webhook vérifié, avec le prompt à coller dans son assistant.', 'A Next.js recipe: send a template and receive a verified webhook, with the prompt to paste into your assistant.'],
  'appointment-reminders': ['Une recette : le rappel WhatsApp de la veille avec deux boutons, l’agent IA qui propose des créneaux, la route qui confirme ou déplace le rendez-vous.', 'A recipe: the WhatsApp reminder the evening before with two buttons, the AI agent offering slots, the route that confirms or moves the appointment.'],
  'appointment-booking': ['Une recette : le client demande un rendez-vous sur WhatsApp, l’agent IA note le motif et la ville, votre application propose trois créneaux et réserve.', 'A recipe: the customer asks for an appointment on WhatsApp, the AI agent notes the reason and the city, your app offers three slots and books.'],
  'saas-onboarding-activation': ['Une recette : le welcome message WhatsApp à l’inscription, un modèle marketing qui ne part qu’à qui a coché la case.', 'A recipe: the WhatsApp welcome at sign-up, a marketing template that only goes to those who ticked the box.'],
  'failed-payment-recovery': ['Une recette : le message WhatsApp quand Stripe signale un paiement échoué, avec le lien vers la facturation.', 'A recipe: the WhatsApp message when Stripe reports a failed payment, with the link to billing.'],
  'order-notifications': ['Une recette : le message WhatsApp d’expédition avec son lien de suivi, la route qui marque la commande livrée puis lue, l’agent IA qui répond.', 'A recipe: the WhatsApp shipping message with its tracking link, the route that marks the order delivered then read, the AI agent that answers.'],
  events: ['Les signaux que Messaging Me remonte vers un outil branché.', 'The signals Messaging Me sends up to a connected tool.'],
  webhooks: ['Le format des webhooks sortants : enveloppe, signature, réessais et types d’événements.', 'The format of outgoing webhooks: envelope, signature, retries and event types.'],
  reference: ['Authentification, droits des clés, limites de débit et quotas.', 'Authentication, key scopes, rate limits and quotas.'],
  errors: ['Chaque code d’erreur de l’API et les erreurs de Meta : quand elles arrivent, et quoi faire.', 'Every API error code and Meta’s errors: when they happen, and what to do.'],
  mcp: ['Le serveur MCP : brancher Claude ou un autre assistant sur un espace Messaging Me.', 'The MCP server: connecting Claude or another assistant to a Messaging Me workspace.'],
};
/** Les ancres déclarées d'une page : un lien vers une ancre qui n'y est pas déclarée ne compile pas. */
export type AncreDe<C extends CleDePage> = Extract<(typeof PAGES_DOC)[number], { cle: C }>['ancres'][number];

export function pageDoc(cle: CleDePage): PageDoc {
  // `find` ne peut pas échouer : `cle` est typée sur la liste elle-même.
  return PAGES_DOC.find((p) => p.cle === cle)!;
}

/** Une destination dans la doc : une page, et au besoin une de ses ancres DÉCLARÉES (une autre ne compile pas). */
export type LienVers = { [P in CleDePage]: { readonly page: P; readonly ancre?: AncreDe<P> } }[CleDePage];

export function hrefDe(lien: LienVers): string {
  const { href } = pageDoc(lien.page);
  return lien.ancre ? `${href}#${lien.ancre}` : href;
}

/**
 * LES ANCRES QUI ONT DÉMÉNAGÉ, page par page, et leur nouvelle adresse. Un favori ou un lien externe vers une
 * ancre partie mènerait sinon en haut de la page : `CadreDoc` lit l'ancre au montage et renvoie vers sa nouvelle
 * adresse. `web/e2e/developers-api.spec.ts` ouvre chacune.
 * - L'accueil porte celles de l'ancienne page unique (avant le 2026-09-25). `#authentification` n'y figure pas :
 *   l'accueil la porte encore.
 * - Messages porte celles des envois, partis sur leur propre page (lot 2 de la refonte).
 */
export const ANCRES_DEPLACEES: Partial<Record<CleDePage, Readonly<Record<string, LienVers>>>> = {
  accueil: {
    debit: { page: 'reference', ancre: 'debit' },
    identite: { page: 'concepts', ancre: 'identification' },
    contacts: { page: 'contacts' },
    'message-simple': { page: 'messages', ancre: 'messages-simples' },
    envoi: { page: 'sends', ancre: 'envoi' },
    catalogues: { page: 'catalogs' },
    outil: { page: 'per-contact' },
    erreurs: { page: 'reference', ancre: 'erreurs' },
    exemples: { page: 'messages' },
    signaux: { page: 'events', ancre: 'signaux' },
  },
  messages: {
    envoi: { page: 'sends', ancre: 'envoi' },
    ouverture: { page: 'sends', ancre: 'ouverture' },
    categorie: { page: 'sends', ancre: 'categorie' },
    suivi: { page: 'sends', ancre: 'suivi' },
  },
};

/** La nouvelle adresse d'une ancre qui a quitté cette page, ou `null`. `hasOwn` : `#constructor` n'est pas une ancre. */
export function ancreDeplacee(page: CleDePage, ancre: string): string | null {
  const table = ANCRES_DEPLACEES[page];
  return table && Object.hasOwn(table, ancre) ? hrefDe(table[ancre]!) : null;
}

/**
 * LES ENTRÉES DE LA NAVIGATION QUI NE SONT PAS DES PAGES : l'index des endpoints vit sur l'accueil, et la
 * navigation y mène directement. Chacune se place juste après la page qu'elle nomme.
 */
export const LIENS_NAV: ReadonlyArray<{ readonly apres: CleDePage; readonly libelle: Bilingue; readonly lien: LienVers }> = [
  { apres: 'accueil', libelle: ['Endpoints', 'Endpoints'], lien: { page: 'accueil', ancre: 'endpoints' } },
];

/**
 * LES FICHIERS DE LA DOCUMENTATION, LISTE FERMÉE : chaque page, les composants que seules ces pages montent, et
 * les modules dont elles affichent le texte. Les gardes de source lisent CETTE liste, jamais tout `web/` : elles
 * doivent pouvoir exiger qu'une chose y soit trouvée (un exemple affiché, l'adresse dérivée, la section du risque)
 * sans être noyées par le reste de la console. `tests/api-exemples.test.ts` compare aussi la liste au dossier
 * `web/components/doc-api/` : un composant posé là sans y être ajouté échapperait aux gardes.
 *
 * ⚠️ `web/lib/api-exemples.ts` n'y est pas : il a ses propres gardes, et la règle « chaque exemple est affiché »
 * doit se lire dans les pages, pas dans le module qui les définit.
 */
export const FICHIERS_DOC: readonly string[] = [
  ...PAGES_DOC.map((p) => p.fichier),
  'web/components/doc-api/CadreDoc.tsx',
  'web/components/doc-api/elements.tsx',
  'web/components/DocSignaux.tsx',
  'web/lib/doc-api-pages.ts',
  'web/lib/api-champs.ts',
  'web/lib/api-doc-endpoints.ts',
  'web/lib/signaux-dictionnaire.ts',
  'web/lib/mcp-outils.ts',
  // Le catalogue des erreurs et le code compilé que la doc montre (lot 17).
  'web/lib/erreurs-gestes.ts',
  'web/lib/erreurs-meta.ts',
  'web/lib/exemples-code.ts',
];
