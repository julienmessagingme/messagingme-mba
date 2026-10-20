// scripts/vitrine/cas-textes.ts
// Les textes des pages de cas d'usage, en français et en anglais : la SEULE chose écrite à la main de ces pages
// (`scripts/vitrine/cas.ts` les assemble). Chaque nom d'outil, de route ou d'événement cité entre <code> doit exister
// dans le produit (`tests/vitrine-cas.test.ts`), et chaque chiffre d'offre porte `data-offre`.

export type Langue = 'fr' | 'en';

export interface TexteCas {
  /** <title>, 60 caractères au plus, et <meta description>, 155 au plus. */
  readonly titre: string;
  readonly description: string;
  /** La carte du carrefour : une phrase. */
  readonly resume: string;
  /** La ligne sous le titre dans le menu Solutions : 40 caractères environ. */
  readonly menu: string;
  readonly icone: string;
  /** Le H1 dit le problème, dans les mots de celui qui cherche (HTML). */
  readonly h1: string;
  readonly chapeau: string;
  readonly film: { readonly titre: string; readonly texte: string; readonly aria: string; readonly duree: string; readonly publie: string };
  readonly schema: { readonly titre: string; readonly legende: string; readonly horizontal: string; readonly vertical: string };
  readonly etapes: ReadonlyArray<{ readonly titre: string; readonly texte: string }>;
  readonly invite: { readonly titre: string; readonly texte: string; readonly phrase: string };
  readonly extrait: { readonly titre: string; readonly partie: string };
  readonly paie: readonly string[];
  readonly faq: ReadonlyArray<{ readonly question: string; readonly reponse: string }>;
  readonly appel: { readonly titre: string; readonly texte: string };
  /** Les liens de bas de page, vers des pages DE LA MÊME LANGUE (adresse, texte). */
  readonly liens: ReadonlyArray<readonly [string, string]>;
}

export const TEXTES_CARREFOUR: Record<Langue, { adresse: string; fil: string; titre: string; description: string; h1: string; chapeau: string }> = {
  fr: {
    adresse: '/cas-d-usage/', fil: 'Cas d’usage',
    titre: 'Cas d’usage WhatsApp pour votre app · Messaging Me',
    description: 'Rappels de rendez-vous, notifications, support, accueil des utilisateurs : ce que vous branchez sur WhatsApp avec Claude Code, cas par cas, avec le code.',
    h1: 'Ce que vous branchez sur WhatsApp, cas par cas.',
    chapeau: 'Chaque cas montre le film, le schéma, le vrai code et ce que vous payez. Aucun compte à créer pour commencer : le plugin Claude Code suffit.',
  },
  en: {
    adresse: '/en/use-cases/', fil: 'Use cases',
    titre: 'WhatsApp use cases for your app · Messaging Me',
    description: 'Appointment reminders, notifications, support, user onboarding: what you connect to WhatsApp with Claude Code, case by case, with the code.',
    h1: 'What you connect to WhatsApp, case by case.',
    chapeau: 'Each case shows the film, the diagram, the real code and what you pay. No account to create to start: the Claude Code plugin is all you need.',
  },
};

/** Un nœud du schéma : un rectangle, son titre et sa ligne de détail. */
const noeud = (x: number, y: number, w: number, h: number, titre: string, detail: string, app = false): string =>
  `<rect class="d-noeud${app ? ' d-app' : ''}" x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/>`
  + `<text class="d-t" x="${x + w / 2}" y="${y + h / 2 - 6}" text-anchor="middle">${titre}</text>`
  + `<text class="d-s" x="${x + w / 2}" y="${y + h / 2 + 18}" text-anchor="middle">${detail}</text>`;
const fleche = (d: string, id: string) => `<path class="d-fl" d="${d}" marker-end="url(#${id})"/>`;
const pointe = (id: string) => `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="d-pointe" d="M0 0L10 5L0 10z"/></marker></defs>`;
/** Une étiquette de flèche : la phrase, puis le nom de l'API qui la porte (absent quand rien ne revient à l'app). */
const etiquette = (x: number, y: number, texte: string, api: string, ancre = 'middle') =>
  `<text class="d-etiq" x="${x}" y="${y}" text-anchor="${ancre}">${texte}</text>`
  + (api ? `<text class="d-api" x="${x}" y="${y + 20}" text-anchor="${ancre}">${api}</text>` : '');

/** Les textes d'un schéma en fourche : l'app, le client, puis les deux suites possibles et leurs étiquettes. */
interface TextesFourche {
  readonly titre: string;
  readonly app: string; readonly veille: string; readonly wa: string; readonly boutons: string;
  readonly ok: string; readonly okD: string; readonly dep: string; readonly depD: string;
  readonly conf: string; readonly confApi: string; readonly dec: string; readonly decApi: string;
}

function schemaRappels(l: Langue): { horizontal: string; vertical: string } {
  return schemaFourche(l === 'fr'
    ? { app: 'Votre app', veille: 'la veille au soir', wa: 'Le client sur WhatsApp', boutons: 'le rappel, deux boutons', ok: 'Rendez-vous confirmé', okD: 'dans votre agenda', dep: 'Rendez-vous déplacé', depD: 'l’agent IA propose, l’app déplace', conf: '« Je confirme »', confApi: 'message.received', dec: '« Je décale »', decApi: 'agent.action', titre: 'Le rappel de la veille, et les deux réponses possibles' }
    : { app: 'Your app', veille: 'the evening before', wa: 'The customer on WhatsApp', boutons: 'the reminder, two buttons', ok: 'Appointment confirmed', okD: 'in your calendar', dep: 'Appointment moved', depD: 'the AI agent offers, the app moves', conf: '“Confirm”', confApi: 'message.received', dec: '“Reschedule”', decApi: 'agent.action', titre: 'The reminder the evening before, and the two possible answers' });
}

function schemaNotifications(l: Langue): { horizontal: string; vertical: string } {
  return schemaFourche(l === 'fr'
    ? { app: 'Votre boutique', veille: 'commande expédiée', wa: 'Le client sur WhatsApp', boutons: 'le suivi, un bouton', ok: 'Commande « Lue »', okD: 'dans votre admin', dep: 'L’agent IA répond', depD: 'votre politique de livraison', conf: 'Livré, puis lu', confApi: 'message.read', dec: 'Il répond', decApi: '', titre: 'Le message d’expédition, sa lecture, et la réponse du client' }
    : { app: 'Your shop', veille: 'order shipped', wa: 'The customer on WhatsApp', boutons: 'tracking, one button', ok: 'Order marked Read', okD: 'in your admin', dep: 'The AI agent answers', depD: 'your delivery policy', conf: 'Delivered, then read', confApi: 'message.read', dec: 'They reply', decApi: '', titre: 'The shipping message, its read receipt, and the customer’s reply' });
}

/**
 * Le schéma en boucle : le client écrit, l'agent IA déclenche l'action, votre app la reçoit et répond au client. Le
 * retour passe sous les trois nœuds, son étiquette au-dessus de lui, hors de tout trait.
 */
function schemaRendezVous(l: Langue): { horizontal: string; vertical: string } {
  const T = l === 'fr'
    ? { titre: 'La demande de rendez-vous, de WhatsApp à votre agenda, et la réponse', client: 'Le client sur WhatsApp', clientD: '« un devis à Lyon ? »', agent: 'L’agent IA', agentD: 'le motif et la ville', app: 'Votre app', appD: 'votre agenda', ecrit: 'il écrit', retour: 'Trois créneaux, puis la confirmation' }
    : { titre: 'The appointment request, from WhatsApp to your calendar, and the answer', client: 'The customer on WhatsApp', clientD: '“a quote in Lyon?”', agent: 'The AI agent', agentD: 'the reason and the city', app: 'Your app', appD: 'your calendar', ecrit: 'they write', retour: 'Three slots, then the confirmation' };
  const horizontal = `<svg class="dessin-h" viewBox="0 0 1160 320" role="img" aria-labelledby="schema-titre"><title id="schema-titre">${T.titre}</title>${pointe('pt-h')}`
    + noeud(10, 40, 300, 100, T.client, T.clientD)
    + fleche('M310 90H422', 'pt-h') + `<text class="d-etiq" x="366" y="78" text-anchor="middle">${T.ecrit}</text>`
    + noeud(430, 40, 300, 100, T.agent, T.agentD)
    + fleche('M730 90H842', 'pt-h') + `<text class="d-api" x="786" y="78" text-anchor="middle">agent.action</text>`
    + noeud(850, 40, 300, 100, T.app, T.appD, true)
    + fleche('M1000 140V256Q1000 276 980 276H180Q160 276 160 256V148', 'pt-h') + etiquette(580, 226, T.retour, 'POST /v1/messages/whatsapp')
    + '</svg>';
  const vertical = `<svg class="dessin-v" viewBox="0 0 360 524" aria-hidden="true">${pointe('pt-v')}`
    + noeud(60, 8, 280, 80, T.client, T.clientD)
    + fleche('M200 88V160', 'pt-v') + `<text class="d-etiq" x="210" y="130">${T.ecrit}</text>`
    + noeud(60, 168, 280, 80, T.agent, T.agentD)
    + fleche('M200 248V320', 'pt-v') + `<text class="d-api" x="210" y="290">agent.action</text>`
    + noeud(60, 328, 280, 80, T.app, T.appD, true)
    + fleche('M200 408V448Q200 462 186 462H38Q24 462 24 448V62Q24 48 38 48H52', 'pt-v') + etiquette(200, 492, T.retour, 'POST /v1/messages/whatsapp')
    + '</svg>';
  return { horizontal, vertical };
}

/** Les textes d'un schéma en ligne : trois nœuds, et l'étiquette de chacune des deux flèches (phrase, puis API). */
interface TextesLigne {
  readonly titre: string;
  readonly noeuds: readonly [readonly [string, string], readonly [string, string], readonly [string, string]];
  /** L'index du nœud qui est « votre app », bordé de la couleur d'action. */
  readonly app: number;
  readonly fleches: readonly [readonly [string, string], readonly [string, string]];
}

/** Trois nœuds en ligne ; chaque étiquette tient dans l'espace entre deux nœuds, au-dessus de sa flèche. */
function schemaLigne(T: TextesLigne): { horizontal: string; vertical: string } {
  const [a, b, c] = T.noeuds;
  const [f1, f2] = T.fleches;
  const horizontal = `<svg class="dessin-h" viewBox="0 0 1160 240" role="img" aria-labelledby="schema-titre"><title id="schema-titre">${T.titre}</title>${pointe('pt-h')}`
    + noeud(10, 70, 260, 100, a[0], a[1], T.app === 0)
    + fleche('M270 120H442', 'pt-h') + etiquette(360, f1[1] ? 86 : 106, f1[0], f1[1])
    + noeud(450, 70, 260, 100, b[0], b[1], T.app === 1)
    + fleche('M710 120H882', 'pt-h') + etiquette(800, f2[1] ? 86 : 106, f2[0], f2[1])
    + noeud(890, 70, 260, 100, c[0], c[1], T.app === 2)
    + '</svg>';
  const vertical = `<svg class="dessin-v" viewBox="0 0 360 416" aria-hidden="true">${pointe('pt-v')}`
    + noeud(40, 8, 280, 80, a[0], a[1], T.app === 0)
    + fleche('M180 88V160', 'pt-v') + etiquette(192, 118, f1[0], f1[1], 'start')
    + noeud(40, 168, 280, 80, b[0], b[1], T.app === 1)
    + fleche('M180 248V320', 'pt-v') + etiquette(192, 278, f2[0], f2[1], 'start')
    + noeud(40, 328, 280, 80, c[0], c[1], T.app === 2)
    + '</svg>';
  return { horizontal, vertical };
}

function schemaAccueil(l: Langue): { horizontal: string; vertical: string } {
  return schemaLigne(l === 'fr'
    ? { titre: 'La bienvenue, de l’inscription au premier usage', app: 0, noeuds: [['Votre app', 'l’inscription, case cochée'], ['Sur son WhatsApp', 'la bienvenue, un bouton'], ['Son premier usage', 'dans votre app']], fleches: [['consent opted_in', 'POST /v1/sends'], ['il touche le bouton', '']] }
    : { titre: 'The welcome, from sign-up to first use', app: 0, noeuds: [['Your app', 'sign-up, box ticked'], ['On their WhatsApp', 'the welcome, one button'], ['Their first use', 'in your app']], fleches: [['consent opted_in', 'POST /v1/sends'], ['they tap the button', '']] });
}

function schemaRelance(l: Langue): { horizontal: string; vertical: string } {
  return schemaLigne(l === 'fr'
    ? { titre: 'Le paiement échoué, de Stripe au message WhatsApp', app: 1, noeuds: [['Stripe', 'invoice.payment_failed'], ['Votre app', 'son webhook Stripe'], ['Sur son WhatsApp', 'le lien de facturation']], fleches: [['le paiement échoue', ''], ['une clé par facture', 'POST /v1/sends']] }
    : { titre: 'The failed payment, from Stripe to the WhatsApp message', app: 1, noeuds: [['Stripe', 'invoice.payment_failed'], ['Your app', 'its Stripe webhook'], ['On their WhatsApp', 'the billing link']], fleches: [['the payment fails', ''], ['one key per invoice', 'POST /v1/sends']] });
}

function schemaFourche(T: TextesFourche): { horizontal: string; vertical: string } {
  // Les deux suites partent d'une fourche à angles arrondis : chaque étiquette tient sur un segment droit, aucun trait
  // ne la traverse.
  const horizontal = `<svg class="dessin-h" viewBox="0 0 1160 320" role="img" aria-labelledby="schema-titre"><title id="schema-titre">${T.titre}</title>${pointe('pt-h')}`
    + noeud(10, 110, 200, 100, T.app, T.veille, true)
    + fleche('M210 160H368', 'pt-h') + `<text class="d-api" x="289" y="148" text-anchor="middle">POST /v1/sends</text>`
    + noeud(376, 110, 280, 100, T.wa, T.boutons)
    + fleche('M656 160H700Q720 160 720 140V80Q720 60 740 60H872', 'pt-h') + etiquette(806, 32, T.conf, T.confApi)
    + fleche('M656 160H700Q720 160 720 180V240Q720 260 740 260H872', 'pt-h') + etiquette(806, 288, T.dec, T.decApi)
    + noeud(880, 10, 270, 100, T.ok, T.okD, true)
    + noeud(880, 210, 270, 100, T.dep, T.depD, true)
    + '</svg>';
  // Au téléphone, un tronc à gauche et deux branches : l'étiquette de chaque réponse se pose au-dessus de son nœud.
  const vertical = `<svg class="dessin-v" viewBox="0 0 360 586" aria-hidden="true">${pointe('pt-v')}`
    + noeud(50, 8, 260, 80, T.app, T.veille, true)
    + fleche('M180 88V150', 'pt-v') + `<text class="d-api" x="190" y="124">POST /v1/sends</text>`
    + noeud(30, 158, 300, 80, T.wa, T.boutons)
    + fleche('M60 238V366Q60 380 74 380H88', 'pt-v') + etiquette(96, 296, T.conf, T.confApi, 'start')
    + noeud(96, 336, 256, 88, T.ok, T.okD, true)
    + fleche('M60 238V518Q60 532 74 532H88', 'pt-v') + etiquette(96, 452, T.dec, T.decApi, 'start')
    + noeud(96, 488, 256, 88, T.dep, T.depD, true)
    + '</svg>';
  return { horizontal, vertical };
}

export const TEXTES_CAS: Readonly<Record<string, Record<Langue, TexteCas>>> = {
  'rendez-vous': {
    fr: {
      titre: 'Prise de rendez-vous sur WhatsApp · Messaging Me',
      description: 'Le client demande un rendez-vous sur WhatsApp : l’agent IA note le motif et la ville, votre app propose trois créneaux et réserve.',
      resume: 'Le client demande sur WhatsApp, l’agent IA note le motif et la ville, votre app propose trois créneaux et réserve.',
      menu: 'Trois créneaux, un choix, réservé',
      icone: 'i-chat-circle-dots',
      h1: 'Vos clients prennent rendez-vous sur WhatsApp, et votre agenda se remplit.',
      chapeau: 'Un client écrit qu’il veut un rendez-vous. L’agent IA lui demande le motif et la ville, votre application lui propose trois créneaux libres de votre agenda, puis réserve celui qu’il choisit et le lui confirme.',
      film: {
        titre: 'La demande, les créneaux, la réservation : 38 secondes.',
        texte: 'De la demande dans Claude Code au rendez-vous réservé, sur une vraie conversation WhatsApp.',
        aria: 'Film : la prise de rendez-vous avec Messaging Me', duree: 'PT38S', publie: '2026-10-20T12:00:00+02:00',
      },
      schema: { titre: 'Comment ça circule.', legende: 'Le client écrit sur WhatsApp. L’agent IA note le motif et la ville, et déclenche agent.action vers votre app, qui lit votre agenda et répond par POST /v1/messages/whatsapp avec trois créneaux, puis avec la confirmation.', ...schemaRendezVous('fr') },
      etapes: [
        { titre: 'Les deux actions de l’agent', texte: 'Claude Code les pose par <code>set_agent_action</code>&nbsp;: «&nbsp;Appointment request&nbsp;», qui note le motif et la ville, et «&nbsp;Slot choice&nbsp;», qui note le créneau choisi. L’agent les déclenche de lui-même, au fil de la conversation.' },
        { titre: 'La demande arrive, signée', texte: 'Votre route, déclarée par <code>create_webhook_endpoint</code>, reçoit <code>agent.action</code> (décoché par défaut, on le coche exprès) et vérifie sa signature&nbsp;: une requête sans signature est refusée.' },
        { titre: 'Trois créneaux libres', texte: 'Votre application lit votre agenda près de la ville donnée et répond au client par <code>POST /v1/messages/whatsapp</code>&nbsp;: il vient d’écrire, la fenêtre de 24&nbsp;heures est ouverte, aucun modèle n’est nécessaire.' },
        { titre: 'Le créneau réservé', texte: 'Le client en choisit un&nbsp;; l’agent déclenche «&nbsp;Slot choice&nbsp;», et votre application réserve une seule fois par demande, puis confirme sur WhatsApp.' },
      ],
      invite: {
        titre: 'Ce que vous tapez dans Claude Code',
        texte: 'Le plugin installé, une phrase suffit&nbsp;: Claude Code règle l’agent, écrit la route et votre lien à l’agenda, et teste.',
        phrase: 'quand un client demande un rdv sur whatsapp, l’agent IA récupère le motif et la ville, mon app (route /api/webhooks/messagingme) lui propose 3 créneaux libres de l’agenda (lib/agenda.ts), et quand il en choisit un on le réserve et on confirme sur whatsapp',
      },
      extrait: { titre: 'La route, telle que Claude Code l’écrit', partie: 'webhook' },
      paie: [
        '<strong>L’offre Free suffit pour démarrer&nbsp;:</strong> <span data-offre="base.contacts">100</span> contacts, l’API et le serveur MCP compris&nbsp;; au-delà, le Pro.',
        '<strong>L’agent IA</strong> se paie sur le crédit IA prépayé, à la réponse.',
        '<strong>Meta facture directement</strong> chaque réponse envoyée dans la fenêtre de 24&nbsp;heures à votre entreprise, selon <a href="https://developers.facebook.com/docs/whatsapp/pricing">sa grille</a> et le pays du client.',
      ],
      faq: [
        { question: 'Faut-il un modèle approuvé par Meta&nbsp;?', reponse: 'Non&nbsp;: le client écrit le premier, et votre application lui répond dans la fenêtre de 24&nbsp;heures que son message ouvre.' },
        { question: 'Le même créneau peut-il être réservé deux fois&nbsp;?', reponse: 'Non&nbsp;: la réservation se fait une seule fois par demande (le même événement reçu deux fois ne réserve qu’une fois), et c’est votre agenda qui dit ce qui est libre.' },
        { question: 'Et si le client redemande le même jour&nbsp;?', reponse: 'Chaque action part une fois par jour au plus, par client et par action&nbsp;: une seconde demande le même jour n’atteint pas votre application, l’agent répond seul.' },
        { question: 'Combien ça coûte&nbsp;?', reponse: 'La Free inclut l’API et le serveur MCP. L’agent IA se paie sur le crédit IA prépayé, et Meta facture chaque réponse envoyée dans la fenêtre de 24&nbsp;heures, selon sa grille et le pays du client.' },
      ],
      appel: { titre: 'Ouvrez la prise de rendez-vous aujourd’hui.', texte: 'Le plugin en deux commandes, puis la phrase ci-dessus dans Claude Code. Aucun compte à créer.' },
      liens: [['/developpeurs/', 'Démarrer avec Claude Code'], ['/tarifs/', 'Les tarifs'], ['/cas-d-usage/', 'Tous les cas d’usage']],
    },
    en: {
      titre: 'Appointment booking on WhatsApp · Messaging Me',
      description: 'The customer asks for an appointment on WhatsApp: the AI agent notes the reason and the city, your app offers three slots and books.',
      resume: 'The customer asks on WhatsApp, the AI agent notes the reason and the city, your app offers three slots and books.',
      menu: 'Three slots, one pick, booked',
      icone: 'i-chat-circle-dots',
      h1: 'Your customers book appointments on WhatsApp, and your calendar fills up.',
      chapeau: 'A customer writes that they want an appointment. The AI agent asks for the reason and the city, your app offers three free slots from your calendar, then books the one they pick and confirms it.',
      film: {
        titre: 'The request, the slots, the booking: 38 seconds.',
        texte: 'From the request in Claude Code to the booked appointment, on a real WhatsApp conversation.',
        aria: 'Film: appointment booking with Messaging Me', duree: 'PT38S', publie: '2026-10-20T12:00:00+02:00',
      },
      schema: { titre: 'How it flows.', legende: 'The customer writes on WhatsApp. The AI agent notes the reason and the city, and triggers agent.action to your app, which reads your calendar and answers with POST /v1/messages/whatsapp with three slots, then with the confirmation.', ...schemaRendezVous('en') },
      etapes: [
        { titre: 'The agent’s two actions', texte: 'Claude Code sets them with <code>set_agent_action</code>: “Appointment request”, which notes the reason and the city, and “Slot choice”, which notes the slot picked. The agent triggers them on its own, as the conversation goes.' },
        { titre: 'The request arrives, signed', texte: 'Your route, declared with <code>create_webhook_endpoint</code>, receives <code>agent.action</code> (unchecked by default, you tick it on purpose) and checks its signature: a request without a signature is refused.' },
        { titre: 'Three free slots', texte: 'Your app reads your calendar near the city given and answers the customer with <code>POST /v1/messages/whatsapp</code>: they just wrote, the 24-hour window is open, no template is needed.' },
        { titre: 'The slot booked', texte: 'The customer picks one; the agent triggers “Slot choice”, and your app books once per request, then confirms on WhatsApp.' },
      ],
      invite: {
        titre: 'What you type in Claude Code',
        texte: 'With the plugin installed, one sentence is enough: Claude Code sets up the agent, writes the route and your calendar link, and tests.',
        phrase: 'when a customer asks for an appointment on whatsapp, the AI agent gets the reason and city, my app (route /api/webhooks/messagingme) offers 3 free slots from the calendar (lib/calendar.ts), and when they pick one we book it and confirm on whatsapp',
      },
      extrait: { titre: 'The route, as Claude Code writes it', partie: 'webhook' },
      paie: [
        '<strong>The Free plan is enough to start:</strong> <span data-offre="base.contacts">100</span> contacts, the API and the MCP server included; beyond that, Pro.',
        '<strong>The AI agent</strong> is paid from the prepaid AI credit, per answer.',
        '<strong>Meta bills your business directly</strong> for each reply sent in the 24-hour window, according to <a href="https://developers.facebook.com/docs/whatsapp/pricing">its rate card</a> and the customer’s country.',
      ],
      faq: [
        { question: 'Is a template approved by Meta needed?', reponse: 'No: the customer writes first, and your app answers within the 24-hour window their message opens.' },
        { question: 'Can the same slot be booked twice?', reponse: 'No: booking happens once per request (the same event received twice books once), and your calendar says what is free.' },
        { question: 'What if the customer asks again the same day?', reponse: 'Each action fires at most once a day, per customer and per action: a second request the same day does not reach your app, the agent answers on its own.' },
        { question: 'How much does it cost?', reponse: 'Free includes the API and the MCP server. The AI agent is paid from the prepaid AI credit, and Meta bills each reply sent in the 24-hour window, according to its rate card and the customer’s country.' },
      ],
      appel: { titre: 'Open appointment booking today.', texte: 'The plugin in two commands, then the sentence above in Claude Code. No account to create.' },
      liens: [['/en/developers/', 'Get started with Claude Code'], ['/en/pricing/', 'Pricing'], ['/en/use-cases/', 'All use cases']],
    },
  },
  rappels: {
    fr: {
      titre: 'Rappels de rendez-vous sur WhatsApp · Messaging Me',
      description: 'La veille de chaque rendez-vous, un rappel WhatsApp à deux boutons : le client confirme ou décale, et votre agenda suit. Branché depuis Claude Code.',
      resume: 'La veille, un rappel à deux boutons : le client confirme ou décale, et votre agenda suit.',
      menu: 'Un rappel la veille, deux boutons',
      icone: 'i-timer',
      h1: 'Moins de rendez-vous manqués, grâce à un rappel WhatsApp la veille.',
      chapeau: 'La veille, chaque client reçoit son rappel sur WhatsApp, avec deux boutons. Il confirme d’un geste&nbsp;; s’il décale, l’agent IA lui propose des créneaux libres et votre agenda déplace le rendez-vous.',
      film: {
        titre: 'Le rappel, la réponse, l’agenda : 38 secondes.',
        texte: 'De la demande dans Claude Code au rendez-vous déplacé, sur une vraie conversation WhatsApp.',
        aria: 'Film : les rappels de rendez-vous avec Messaging Me', duree: 'PT38S', publie: '2026-10-20T09:00:00+02:00',
      },
      schema: { titre: 'Comment ça circule.', legende: 'Votre app envoie le rappel la veille par POST /v1/sends. Le bouton « Je confirme » revient par message.received et confirme le rendez-vous ; le bouton « Je décale » passe par l’agent IA, qui déclenche agent.action, et votre app déplace le rendez-vous.', ...schemaRappels('fr') },
      etapes: [
        { titre: 'Le modèle de rappel', texte: 'Claude Code le crée par <code>create_template</code>&nbsp;: catégorie utilitaire, le prénom et l’heure, deux boutons de réponse rapide, «&nbsp;Je confirme&nbsp;» et «&nbsp;Je décale&nbsp;». Meta l’approuve, souvent en quelques minutes.' },
        { titre: 'La tâche de la veille', texte: 'Chaque soir, votre application envoie les rappels du lendemain par <code>POST /v1/sends</code>, avec une clé d’idempotence tirée du rendez-vous&nbsp;: relancée, elle n’envoie pas deux fois.' },
        { titre: 'Le bouton «&nbsp;Je confirme&nbsp;»', texte: 'Il revient dans l’événement <code>message.received</code>, par son libellé&nbsp;; votre route retrouve le dernier rappel du numéro et confirme le rendez-vous.' },
        { titre: 'Le bouton «&nbsp;Je décale&nbsp;»', texte: 'L’agent IA répond et déclenche une action posée par <code>set_agent_action</code>&nbsp;: votre application reçoit <code>agent.action</code>, propose des créneaux libres par <code>POST /v1/messages/whatsapp</code>, puis déplace celui que le client choisit.' },
      ],
      invite: {
        titre: 'Ce que vous tapez dans Claude Code',
        texte: 'Le plugin installé, une phrase suffit&nbsp;: Claude Code crée le modèle, règle l’agent, écrit le code et le teste.',
        phrase: 'la veille de chaque rendez-vous (lib/agenda.ts), envoie un rappel whatsapp avec deux boutons, je confirme et je décale. si le client décale, l’agent propose trois créneaux libres et mon app déplace le rendez-vous',
      },
      extrait: { titre: 'La tâche de la veille, telle que Claude Code l’écrit', partie: 'tache' },
      paie: [
        '<strong>L’offre Free suffit pour démarrer&nbsp;:</strong> <span data-offre="base.envois-modeles-mois">1&nbsp;000</span> modèles envoyés par mois et <span data-offre="base.contacts">100</span> contacts, l’API et le serveur MCP compris&nbsp;; au-delà, le Pro.',
        '<strong>L’agent IA</strong> se paie sur le crédit IA prépayé, à la réponse.',
        '<strong>Meta facture directement</strong> chaque modèle utilitaire à votre entreprise, selon <a href="https://developers.facebook.com/docs/whatsapp/pricing">sa grille</a> et le pays du client.',
      ],
      faq: [
        { question: 'Le client doit-il avoir accepté de recevoir des messages&nbsp;?', reponse: 'Meta demande que la personne ait accepté d’être contactée sur WhatsApp, par exemple en donnant son numéro à la prise de rendez-vous. Un client qui répond STOP ne reçoit plus rien.' },
        { question: 'Que se passe-t-il si le client ne répond pas&nbsp;?', reponse: 'Rien&nbsp;: le rendez-vous reste tel quel, et votre agenda montre qui a confirmé.' },
        { question: 'Combien coûte un rappel&nbsp;?', reponse: 'La Free inclut 1&nbsp;000 modèles par mois. Meta facture chaque modèle utilitaire à votre entreprise, selon sa grille et le pays du client.' },
        { question: 'Le client peut-il décaler plusieurs fois&nbsp;?', reponse: 'Une demande de report part une fois par jour au plus, par client et par action&nbsp;: l’agent propose des créneaux, le client en choisit un, votre application le réserve.' },
      ],
      appel: { titre: 'Branchez vos rappels aujourd’hui.', texte: 'Le plugin en deux commandes, puis la phrase ci-dessus dans Claude Code. Aucun compte à créer.' },
      liens: [['/developpeurs/', 'Démarrer avec Claude Code'], ['/tarifs/', 'Les tarifs'], ['/cas-d-usage/', 'Tous les cas d’usage']],
    },
    en: {
      titre: 'Appointment reminders on WhatsApp · Messaging Me',
      description: 'The evening before each appointment, a WhatsApp reminder with two buttons: the customer confirms or reschedules, and your calendar follows.',
      resume: 'The evening before, a reminder with two buttons: the customer confirms or reschedules, and your calendar follows.',
      menu: 'A reminder the evening before',
      icone: 'i-timer',
      h1: 'Fewer missed appointments, with a WhatsApp reminder the evening before.',
      chapeau: 'The evening before, each customer gets their reminder on WhatsApp, with two buttons. They confirm in one tap; if they reschedule, the AI agent offers free slots and your calendar moves the appointment.',
      film: {
        titre: 'The reminder, the answer, the calendar: 38 seconds.',
        texte: 'From the request in Claude Code to the moved appointment, on a real WhatsApp conversation.',
        aria: 'Film: appointment reminders with Messaging Me', duree: 'PT38S', publie: '2026-10-20T09:00:00+02:00',
      },
      schema: { titre: 'How it flows.', legende: 'Your app sends the reminder the evening before with POST /v1/sends. The Confirm button comes back through message.received and confirms the appointment; the Reschedule button goes through the AI agent, which triggers agent.action, and your app moves the appointment.', ...schemaRappels('en') },
      etapes: [
        { titre: 'The reminder template', texte: 'Claude Code creates it with <code>create_template</code>: utility category, the first name and the time, two quick reply buttons, “Confirm” and “Reschedule”. Meta approves it, often within minutes.' },
        { titre: 'The day-before job', texte: 'Every evening, your app sends the next day’s reminders with <code>POST /v1/sends</code>, with an idempotency key taken from the appointment: run again, it does not send twice.' },
        { titre: 'The “Confirm” button', texte: 'It comes back in the <code>message.received</code> event, by its label; your route finds the last reminder sent to the number and confirms the appointment.' },
        { titre: 'The “Reschedule” button', texte: 'The AI agent answers and triggers an action set with <code>set_agent_action</code>: your app receives <code>agent.action</code>, offers free slots with <code>POST /v1/messages/whatsapp</code>, then moves the one the customer picks.' },
      ],
      invite: {
        titre: 'What you type in Claude Code',
        texte: 'With the plugin installed, one sentence is enough: Claude Code creates the template, sets up the agent, writes the code and tests it.',
        phrase: 'the day before each appointment (lib/calendar.ts), send a whatsapp reminder with two buttons, confirm and reschedule. if the customer reschedules, the agent offers three free slots and my app moves the appointment',
      },
      extrait: { titre: 'The day-before job, as Claude Code writes it', partie: 'tache' },
      paie: [
        '<strong>The Free plan is enough to start:</strong> <span data-offre="base.envois-modeles-mois">1,000</span> templates sent a month and <span data-offre="base.contacts">100</span> contacts, the API and the MCP server included; beyond that, Pro.',
        '<strong>The AI agent</strong> is paid from the prepaid AI credit, per answer.',
        '<strong>Meta bills your business directly</strong> for each utility template, according to <a href="https://developers.facebook.com/docs/whatsapp/pricing">its rate card</a> and the customer’s country.',
      ],
      faq: [
        { question: 'Must the customer have agreed to receive messages?', reponse: 'Meta asks that the person agreed to be contacted on WhatsApp, for example by giving their number when booking. A customer who replies STOP receives nothing more.' },
        { question: 'What if the customer does not answer?', reponse: 'Nothing: the appointment stays as it is, and your calendar shows who confirmed.' },
        { question: 'How much does a reminder cost?', reponse: 'Free includes 1,000 templates a month. Meta bills each utility template to your business, according to its rate card and the customer’s country.' },
        { question: 'Can the customer reschedule several times?', reponse: 'A reschedule request goes out at most once a day, per customer and per action: the agent offers slots, the customer picks one, your app books it.' },
      ],
      appel: { titre: 'Set up your reminders today.', texte: 'The plugin in two commands, then the sentence above in Claude Code. No account to create.' },
      liens: [['/en/developers/', 'Get started with Claude Code'], ['/en/pricing/', 'Pricing'], ['/en/use-cases/', 'All use cases']],
    },
  },
  accueil: {
    fr: {
      titre: 'Accueil des utilisateurs sur WhatsApp · Messaging Me',
      description: 'À l’inscription, la bienvenue part sur WhatsApp, avec un bouton vers le premier usage de votre produit. Seulement à qui a coché la case.',
      resume: 'À l’inscription, la bienvenue sur WhatsApp, avec un bouton vers le premier usage. Seulement à qui a coché la case.',
      menu: 'La bienvenue, puis le premier usage',
      icone: 'i-smiley',
      h1: 'Vos nouveaux utilisateurs reçoivent leur bienvenue sur WhatsApp, et passent à l’action.',
      chapeau: 'À l’inscription, l’utilisateur qui a coché la case reçoit sa bienvenue sur WhatsApp, avec un bouton qui l’emmène à la première action dans votre produit. Là où il lit vraiment ses messages.',
      film: {
        titre: 'La bienvenue, puis la relance : 38 secondes.',
        texte: 'De la demande dans Claude Code au premier planning créé, sur une vraie conversation WhatsApp. Le même film montre ensuite la relance d’un paiement échoué.',
        aria: 'Film : l’accueil des utilisateurs d’un SaaS avec Messaging Me', duree: 'PT38S', publie: '2026-10-20T13:00:00+02:00',
      },
      schema: { titre: 'Comment ça circule.', legende: 'Votre app envoie la bienvenue par POST /v1/sends, avec consent opted_in, à l’utilisateur qui a coché la case ; il touche le bouton, et votre app s’ouvre sur son premier usage.', ...schemaAccueil('fr') },
      etapes: [
        { titre: 'Le modèle de bienvenue', texte: 'Claude Code le crée par <code>create_template</code>, en catégorie marketing&nbsp;: pour Meta, une bienvenue qui invite à utiliser le produit est du marketing. Le prénom, et un bouton vers la page qui lance l’utilisateur&nbsp;; <code>get_template_status</code> confirme l’approbation.' },
        { titre: 'La case du formulaire', texte: 'Le formulaire d’inscription porte une case «&nbsp;Recevoir mes conseils de démarrage sur WhatsApp&nbsp;», non cochée par défaut. Sans elle, rien ne part&nbsp;: un modèle marketing ne va qu’à qui a consenti.' },
        { titre: 'L’envoi à l’inscription', texte: 'Une fois le compte créé, votre application envoie le modèle par <code>POST /v1/sends</code>, avec le consentement et sa source&nbsp;: l’API les écrit sur le contact avant le tri marketing. Une clé d’idempotence tirée de l’utilisateur évite le doublon.' },
        { titre: 'Le premier usage', texte: 'L’utilisateur touche le bouton du message&nbsp;: votre application s’ouvre sur la page de sa première action, son premier planning, son premier projet.' },
      ],
      invite: {
        titre: 'Ce que vous tapez dans Claude Code',
        texte: 'Le plugin installé, une phrase suffit. Celle du film branche aussi la relance des paiements échoués&nbsp;: Claude Code crée les deux modèles, écrit le code et teste.',
        phrase: '/messagingme:demarrer à l’inscription (app/inscription.ts), un whatsapp de bienvenue avec le lien pour créer son premier planning. et quand stripe signale un paiement échoué, un whatsapp avec le lien pour mettre à jour la carte',
      },
      extrait: { titre: 'La bienvenue, telle que Claude Code l’écrit', partie: 'inscription' },
      paie: [
        '<strong>L’offre Free suffit pour démarrer&nbsp;:</strong> <span data-offre="base.envois-modeles-mois">1&nbsp;000</span> modèles envoyés par mois et <span data-offre="base.contacts">100</span> contacts, l’API et le serveur MCP compris&nbsp;; au-delà, le Pro.',
        '<strong>Meta facture directement</strong> chaque modèle marketing à votre entreprise, selon <a href="https://developers.facebook.com/docs/whatsapp/pricing">sa grille</a> et le pays de l’utilisateur.',
      ],
      faq: [
        { question: 'Pourquoi en marketing, et pas en utilitaire&nbsp;?', reponse: 'Meta classe en marketing tout modèle qui invite à utiliser le produit, et en utilitaire une alerte sur le compte, comme un paiement échoué. Un modèle déclaré utilitaire avec un texte marketing est reclassé par Meta.' },
        { question: 'Et l’utilisateur qui n’a pas coché la case&nbsp;?', reponse: 'Il ne reçoit rien&nbsp;: votre code ne l’envoie pas, et l’API refuserait un modèle marketing sans consentement.' },
        { question: 'Combien coûte une bienvenue&nbsp;?', reponse: 'La Free inclut 1&nbsp;000 modèles par mois. Meta facture chaque modèle marketing à votre entreprise, selon sa grille et le pays de l’utilisateur.' },
        { question: 'Peut-il ne plus rien recevoir&nbsp;?', reponse: 'Oui&nbsp;: un utilisateur qui répond STOP ne reçoit plus rien, et son refus est noté sur le contact.' },
      ],
      appel: { titre: 'Accueillez vos utilisateurs sur WhatsApp.', texte: 'Le plugin en deux commandes, puis la phrase ci-dessus dans Claude Code. Aucun compte à créer.' },
      liens: [['/developpeurs/', 'Démarrer avec Claude Code'], ['/tarifs/', 'Les tarifs'], ['/cas-d-usage/', 'Tous les cas d’usage']],
    },
    en: {
      titre: 'User onboarding on WhatsApp · Messaging Me',
      description: 'At sign-up, the welcome goes out on WhatsApp, with a button to the first use of your product. Only to those who ticked the box.',
      resume: 'At sign-up, the welcome on WhatsApp, with a button to the first use. Only to those who ticked the box.',
      menu: 'The welcome, then the first use',
      icone: 'i-smiley',
      h1: 'Your new users get their welcome on WhatsApp, and take action.',
      chapeau: 'At sign-up, the user who ticked the box gets their welcome on WhatsApp, with a button that takes them to the first action in your product. Where they actually read their messages.',
      film: {
        titre: 'The welcome, then the recovery: 38 seconds.',
        texte: 'From the request in Claude Code to the first schedule created, on a real WhatsApp conversation. The same film then shows a failed payment recovery.',
        aria: 'Film: SaaS user onboarding with Messaging Me', duree: 'PT38S', publie: '2026-10-20T13:00:00+02:00',
      },
      schema: { titre: 'How it flows.', legende: 'Your app sends the welcome with POST /v1/sends, with consent opted_in, to the user who ticked the box; they tap the button, and your app opens on their first use.', ...schemaAccueil('en') },
      etapes: [
        { titre: 'The welcome template', texte: 'Claude Code creates it with <code>create_template</code>, in the marketing category: for Meta, a welcome that invites people to use the product is marketing. The first name, and a button to the page that gets the user started; <code>get_template_status</code> confirms the approval.' },
        { titre: 'The form’s box', texte: 'The sign-up form carries a “Get my getting-started tips on WhatsApp” box, unticked by default. Without it, nothing goes out: a marketing template only goes to those who consented.' },
        { titre: 'The send at sign-up', texte: 'Once the account exists, your app sends the template with <code>POST /v1/sends</code>, with the consent and its source: the API writes them on the contact before the marketing filter. An idempotency key taken from the user prevents duplicates.' },
        { titre: 'The first use', texte: 'The user taps the message’s button: your app opens on the page of their first action, their first schedule, their first project.' },
      ],
      invite: {
        titre: 'What you type in Claude Code',
        texte: 'With the plugin installed, one sentence is enough. The film’s also wires the failed payment recovery: Claude Code creates both templates, writes the code and tests.',
        phrase: '/messagingme:demarrer at sign-up (app/signup.ts), a whatsapp welcome with the link to create their first schedule. and when stripe reports a failed payment, a whatsapp with the link to update their card',
      },
      extrait: { titre: 'The welcome, as Claude Code writes it', partie: 'inscription' },
      paie: [
        '<strong>The Free plan is enough to start:</strong> <span data-offre="base.envois-modeles-mois">1,000</span> templates sent a month and <span data-offre="base.contacts">100</span> contacts, the API and the MCP server included; beyond that, Pro.',
        '<strong>Meta bills your business directly</strong> for each marketing template, according to <a href="https://developers.facebook.com/docs/whatsapp/pricing">its rate card</a> and the user’s country.',
      ],
      faq: [
        { question: 'Why marketing, not utility?', reponse: 'Meta classifies as marketing any template that invites people to use the product, and as utility an alert on the account, like a failed payment. A template declared utility with a marketing text is reclassified by Meta.' },
        { question: 'What about the user who did not tick the box?', reponse: 'They receive nothing: your code does not send it, and the API would refuse a marketing template without consent.' },
        { question: 'How much does a welcome cost?', reponse: 'Free includes 1,000 templates a month. Meta bills each marketing template to your business, according to its rate card and the user’s country.' },
        { question: 'Can they stop receiving messages?', reponse: 'Yes: a user who replies STOP receives nothing more, and their refusal is recorded on the contact.' },
      ],
      appel: { titre: 'Welcome your users on WhatsApp.', texte: 'The plugin in two commands, then the sentence above in Claude Code. No account to create.' },
      liens: [['/en/developers/', 'Get started with Claude Code'], ['/en/pricing/', 'Pricing'], ['/en/use-cases/', 'All use cases']],
    },
  },
  'relance-paiement': {
    fr: {
      titre: 'Relance d’un paiement échoué sur WhatsApp · Messaging Me',
      description: 'Quand Stripe signale un paiement échoué, l’utilisateur reçoit sur WhatsApp le lien pour mettre à jour sa carte, avant de perdre l’accès.',
      resume: 'Stripe signale l’échec, l’utilisateur reçoit sur WhatsApp le lien pour mettre à jour sa carte.',
      menu: 'La carte refusée, le lien qui la répare',
      icone: 'i-wallet',
      h1: 'Moins d’abonnements perdus sur une carte refusée, grâce à un message WhatsApp.',
      chapeau: 'Quand Stripe signale un paiement échoué, votre application envoie à l’utilisateur un message WhatsApp avec le lien vers sa page de facturation. Il met à jour sa carte avant de perdre l’accès.',
      film: {
        titre: 'La bienvenue, puis la relance : 38 secondes.',
        texte: 'De la demande dans Claude Code au paiement réussi, sur une vraie conversation WhatsApp. Le même film montre d’abord la bienvenue à l’inscription.',
        aria: 'Film : la relance d’un paiement échoué avec Messaging Me', duree: 'PT38S', publie: '2026-10-20T13:00:00+02:00',
      },
      schema: { titre: 'Comment ça circule.', legende: 'Stripe envoie invoice.payment_failed au webhook de votre app, qui retrouve l’utilisateur et envoie le modèle par POST /v1/sends, avec une clé d’idempotence par facture.', ...schemaRelance('fr') },
      etapes: [
        { titre: 'Le modèle de paiement échoué', texte: 'Claude Code le crée par <code>create_template</code>, en catégorie utilitaire&nbsp;: une alerte sur le compte. Le prénom, et un bouton «&nbsp;Mettre à jour ma carte&nbsp;» vers votre page de facturation&nbsp;; <code>get_template_status</code> confirme l’approbation.' },
        { titre: 'Le webhook Stripe que vous avez déjà', texte: 'Sur l’événement invoice.payment_failed, et une fois la signature de Stripe vérifiée, votre application retrouve l’utilisateur derrière le client Stripe.' },
        { titre: 'L’envoi', texte: 'Elle envoie le modèle par <code>POST /v1/sends</code>, avec une clé d’idempotence tirée de la facture&nbsp;: un même événement livré deux fois dans les 24&nbsp;heures n’envoie qu’un message.' },
        { titre: 'La carte mise à jour', texte: 'L’utilisateur touche le bouton et met à jour sa carte sur votre page de facturation, avant de perdre l’accès.' },
      ],
      invite: {
        titre: 'Ce que vous tapez dans Claude Code',
        texte: 'Le plugin installé, une phrase suffit. Celle du film branche aussi la bienvenue à l’inscription&nbsp;: Claude Code crée les deux modèles, écrit le code et teste.',
        phrase: '/messagingme:demarrer à l’inscription (app/inscription.ts), un whatsapp de bienvenue avec le lien pour créer son premier planning. et quand stripe signale un paiement échoué, un whatsapp avec le lien pour mettre à jour la carte',
      },
      extrait: { titre: 'Le webhook Stripe, tel que Claude Code l’écrit', partie: 'stripe' },
      paie: [
        '<strong>L’offre Free suffit pour démarrer&nbsp;:</strong> <span data-offre="base.envois-modeles-mois">1&nbsp;000</span> modèles envoyés par mois et <span data-offre="base.contacts">100</span> contacts, l’API et le serveur MCP compris&nbsp;; au-delà, le Pro.',
        '<strong>Meta facture directement</strong> chaque modèle utilitaire à votre entreprise, selon <a href="https://developers.facebook.com/docs/whatsapp/pricing">sa grille</a> et le pays de l’utilisateur.',
      ],
      faq: [
        { question: 'Faut-il une adresse de webhook Messaging Me&nbsp;?', reponse: 'Non&nbsp;: tout part du webhook Stripe que votre application a déjà, et rien ne revient vers elle.' },
        { question: 'Et si Meta reclasse le modèle en marketing&nbsp;?', reponse: 'Il ne partirait plus qu’aux contacts qui ont consenti. Gardez un texte factuel&nbsp;: le paiement, la carte, l’accès.' },
        { question: 'Combien coûte une relance&nbsp;?', reponse: 'La Free inclut 1&nbsp;000 modèles par mois. Meta facture chaque modèle utilitaire à votre entreprise, selon sa grille et le pays de l’utilisateur.' },
        { question: 'Stripe peut-il envoyer deux fois le même événement&nbsp;?', reponse: 'Oui, et la clé d’idempotence tirée de la facture le couvre&nbsp;: dans les 24&nbsp;heures, un seul message part.' },
      ],
      appel: { titre: 'Relancez vos paiements échoués aujourd’hui.', texte: 'Le plugin en deux commandes, puis la phrase ci-dessus dans Claude Code. Aucun compte à créer.' },
      liens: [['/developpeurs/', 'Démarrer avec Claude Code'], ['/tarifs/', 'Les tarifs'], ['/cas-d-usage/', 'Tous les cas d’usage']],
    },
    en: {
      titre: 'Failed payment recovery on WhatsApp · Messaging Me',
      description: 'When Stripe reports a failed payment, the user gets on WhatsApp the link to update their card, before losing access.',
      resume: 'Stripe reports the failure, the user gets on WhatsApp the link to update their card.',
      menu: 'The declined card, the link that fixes it',
      icone: 'i-wallet',
      h1: 'Fewer subscriptions lost to a declined card, with a WhatsApp message.',
      chapeau: 'When Stripe reports a failed payment, your app sends the user a WhatsApp message with the link to their billing page. They update their card before losing access.',
      film: {
        titre: 'The welcome, then the recovery: 38 seconds.',
        texte: 'From the request in Claude Code to the successful payment, on a real WhatsApp conversation. The same film first shows the welcome at sign-up.',
        aria: 'Film: failed payment recovery with Messaging Me', duree: 'PT38S', publie: '2026-10-20T13:00:00+02:00',
      },
      schema: { titre: 'How it flows.', legende: 'Stripe sends invoice.payment_failed to your app’s webhook, which finds the user and sends the template with POST /v1/sends, with one idempotency key per invoice.', ...schemaRelance('en') },
      etapes: [
        { titre: 'The failed payment template', texte: 'Claude Code creates it with <code>create_template</code>, in the utility category: an alert on the account. The first name, and an “Update my card” button to your billing page; <code>get_template_status</code> confirms the approval.' },
        { titre: 'The Stripe webhook you already have', texte: 'On the invoice.payment_failed event, once Stripe’s signature is checked, your app finds the user behind the Stripe customer.' },
        { titre: 'The send', texte: 'It sends the template with <code>POST /v1/sends</code>, with an idempotency key taken from the invoice: the same event delivered twice within 24 hours sends one message.' },
        { titre: 'The card updated', texte: 'The user taps the button and updates their card on your billing page, before losing access.' },
      ],
      invite: {
        titre: 'What you type in Claude Code',
        texte: 'With the plugin installed, one sentence is enough. The film’s also wires the welcome at sign-up: Claude Code creates both templates, writes the code and tests.',
        phrase: '/messagingme:demarrer at sign-up (app/signup.ts), a whatsapp welcome with the link to create their first schedule. and when stripe reports a failed payment, a whatsapp with the link to update their card',
      },
      extrait: { titre: 'The Stripe webhook, as Claude Code writes it', partie: 'stripe' },
      paie: [
        '<strong>The Free plan is enough to start:</strong> <span data-offre="base.envois-modeles-mois">1,000</span> templates sent a month and <span data-offre="base.contacts">100</span> contacts, the API and the MCP server included; beyond that, Pro.',
        '<strong>Meta bills your business directly</strong> for each utility template, according to <a href="https://developers.facebook.com/docs/whatsapp/pricing">its rate card</a> and the user’s country.',
      ],
      faq: [
        { question: 'Is a Messaging Me webhook address needed?', reponse: 'No: everything starts from the Stripe webhook your app already has, and nothing comes back to it.' },
        { question: 'What if Meta reclassifies the template as marketing?', reponse: 'It would then only go to contacts who consented. Keep a factual text: the payment, the card, the access.' },
        { question: 'How much does a recovery message cost?', reponse: 'Free includes 1,000 templates a month. Meta bills each utility template to your business, according to its rate card and the user’s country.' },
        { question: 'Can Stripe send the same event twice?', reponse: 'Yes, and the idempotency key taken from the invoice covers it: within 24 hours, one message goes out.' },
      ],
      appel: { titre: 'Recover your failed payments today.', texte: 'The plugin in two commands, then the sentence above in Claude Code. No account to create.' },
      liens: [['/en/developers/', 'Get started with Claude Code'], ['/en/pricing/', 'Pricing'], ['/en/use-cases/', 'All use cases']],
    },
  },
  notifications: {
    fr: {
      titre: 'Notifications de commande sur WhatsApp · Messaging Me',
      description: 'Quand une commande part, le client reçoit son suivi sur WhatsApp et votre admin voit quand il l’a lu. S’il répond, l’agent IA prend la main.',
      resume: 'La commande part : le client reçoit son suivi sur WhatsApp, et votre admin voit quand il l’a lu.',
      menu: 'Le suivi de commande, lu ou non',
      icone: 'i-package',
      h1: 'Vos clients suivent leur commande sur WhatsApp, et vous savez qu’ils l’ont lu.',
      chapeau: 'Dès qu’une commande passe en expédiée, le client reçoit son message de suivi sur WhatsApp. Votre admin le voit livré, puis lu. S’il répond, l’agent IA prend la conversation.',
      film: {
        titre: 'L’expédition, le suivi, la lecture : 38 secondes.',
        texte: 'De la demande dans Claude Code à la commande marquée lue, sur une vraie conversation WhatsApp.',
        aria: 'Film : les notifications de commande avec Messaging Me', duree: 'PT38S', publie: '2026-10-20T11:00:00+02:00',
      },
      schema: { titre: 'Comment ça circule.', legende: 'Votre boutique envoie le message d’expédition par POST /v1/sends. Les accusés message.delivered puis message.read reviennent sur votre route, qui marque la commande lue ; si le client répond, l’agent IA prend la conversation.', ...schemaNotifications('fr') },
      etapes: [
        { titre: 'Le modèle d’expédition', texte: 'Claude Code le crée par <code>create_template</code>&nbsp;: catégorie utilitaire, le prénom et le numéro de commande, un bouton «&nbsp;Suivre mon colis&nbsp;» vers votre page de suivi. Meta l’approuve, souvent en quelques minutes, et <code>get_template_status</code> le confirme.' },
        { titre: 'L’envoi à l’expédition', texte: 'Quand une commande passe en expédiée, votre application envoie le modèle par <code>POST /v1/sends</code>, avec une clé d’idempotence tirée de la commande&nbsp;: rejoué dans les 24&nbsp;heures, il n’envoie pas deux fois. L’identifiant d’envoi rendu se range sur la commande.' },
        { titre: 'Livré, puis lu', texte: 'Votre route, déclarée par <code>create_webhook_endpoint</code>, reçoit <code>message.delivered</code> puis <code>message.read</code> (décochés par défaut, on les coche exprès)&nbsp;: elle retrouve la commande par l’identifiant d’envoi et l’affiche «&nbsp;Lu&nbsp;».' },
        { titre: 'S’il répond', texte: 'Sa réponse ouvre une conversation, que prend l’agent IA qui répond pour l’espace (<code>set_default_responder</code>), avec votre politique de livraison dans sa connaissance. En Pro, votre équipe peut reprendre la main dans l’Inbox de la console.' },
      ],
      invite: {
        titre: 'Ce que vous tapez dans Claude Code',
        texte: 'Le plugin installé, une phrase suffit&nbsp;: Claude Code crée le modèle, branche l’envoi et la route, et teste.',
        phrase: 'quand une commande passe en expédiée (lib/commandes.ts), envoie un whatsapp au client avec le suivi, et marque dans l’admin quand il l’a lu. s’il répond, l’agent IA prend la main',
      },
      extrait: { titre: 'L’envoi à l’expédition, tel que Claude Code l’écrit', partie: 'commandes' },
      paie: [
        '<strong>L’offre Free suffit pour démarrer&nbsp;:</strong> <span data-offre="base.envois-modeles-mois">1&nbsp;000</span> modèles envoyés par mois et <span data-offre="base.contacts">100</span> contacts, l’API et le serveur MCP compris&nbsp;; au-delà, le Pro.',
        '<strong>L’agent IA</strong> se paie sur le crédit IA prépayé, à la réponse.',
        '<strong>Meta facture directement</strong> chaque modèle utilitaire à votre entreprise, selon <a href="https://developers.facebook.com/docs/whatsapp/pricing">sa grille</a> et le pays du client.',
      ],
      faq: [
        { question: 'Le client doit-il avoir accepté de recevoir des messages&nbsp;?', reponse: 'Meta demande que la personne ait accepté d’être contactée sur WhatsApp, par exemple en le cochant à la commande. Un client qui répond STOP ne reçoit plus rien.' },
        { question: 'Et si le client a désactivé les confirmations de lecture&nbsp;?', reponse: 'WhatsApp n’envoie alors jamais la lecture&nbsp;: la commande reste «&nbsp;Livrée&nbsp;» dans votre admin.' },
        { question: 'Combien coûte une notification&nbsp;?', reponse: 'La Free inclut 1&nbsp;000 modèles par mois. Meta facture chaque modèle utilitaire à votre entreprise, selon sa grille et le pays du client.' },
        { question: 'Que se passe-t-il si l’envoi est rejoué&nbsp;?', reponse: 'Dans les 24&nbsp;heures, la même clé d’idempotence, tirée de la commande, rend le même envoi&nbsp;: le client ne reçoit qu’un message.' },
      ],
      appel: { titre: 'Branchez vos notifications aujourd’hui.', texte: 'Le plugin en deux commandes, puis la phrase ci-dessus dans Claude Code. Aucun compte à créer.' },
      liens: [['/developpeurs/', 'Démarrer avec Claude Code'], ['/tarifs/', 'Les tarifs'], ['/cas-d-usage/', 'Tous les cas d’usage']],
    },
    en: {
      titre: 'Order notifications on WhatsApp · Messaging Me',
      description: 'When an order ships, the customer gets their tracking on WhatsApp and your admin sees when they read it. If they reply, the AI agent takes over.',
      resume: 'The order ships: the customer gets their tracking on WhatsApp, and your admin sees when they read it.',
      menu: 'Order tracking, read or not',
      icone: 'i-package',
      h1: 'Your customers follow their order on WhatsApp, and you know they read it.',
      chapeau: 'As soon as an order moves to shipped, the customer gets their tracking message on WhatsApp. Your admin sees it delivered, then read. If they reply, the AI agent takes the conversation.',
      film: {
        titre: 'The shipment, the tracking, the read receipt: 38 seconds.',
        texte: 'From the request in Claude Code to the order marked read, on a real WhatsApp conversation.',
        aria: 'Film: order notifications with Messaging Me', duree: 'PT38S', publie: '2026-10-20T11:00:00+02:00',
      },
      schema: { titre: 'How it flows.', legende: 'Your shop sends the shipping message with POST /v1/sends. The message.delivered then message.read receipts come back to your route, which marks the order read; if the customer replies, the AI agent takes the conversation.', ...schemaNotifications('en') },
      etapes: [
        { titre: 'The shipping template', texte: 'Claude Code creates it with <code>create_template</code>: utility category, the first name and the order number, a “Track my parcel” button to your tracking page. Meta approves it, often within minutes, and <code>get_template_status</code> confirms it.' },
        { titre: 'The send on shipping', texte: 'When an order moves to shipped, your app sends the template with <code>POST /v1/sends</code>, with an idempotency key taken from the order: replayed within 24 hours, it does not send twice. The send identifier it returns is stored on the order.' },
        { titre: 'Delivered, then read', texte: 'Your route, declared with <code>create_webhook_endpoint</code>, receives <code>message.delivered</code> then <code>message.read</code> (unchecked by default, you tick them on purpose): it finds the order by the send identifier and shows it “Read”.' },
        { titre: 'If they reply', texte: 'Their reply opens a conversation, taken by the AI agent that answers for the workspace (<code>set_default_responder</code>), with your delivery policy in its knowledge. On Pro, your team can take over in the console’s Inbox.' },
      ],
      invite: {
        titre: 'What you type in Claude Code',
        texte: 'With the plugin installed, one sentence is enough: Claude Code creates the template, wires the send and the route, and tests.',
        phrase: 'when an order moves to shipped (lib/orders.ts), send the customer a whatsapp with tracking, and mark in the admin when they read it. if they reply, the AI agent takes over',
      },
      extrait: { titre: 'The send on shipping, as Claude Code writes it', partie: 'commandes' },
      paie: [
        '<strong>The Free plan is enough to start:</strong> <span data-offre="base.envois-modeles-mois">1,000</span> templates sent a month and <span data-offre="base.contacts">100</span> contacts, the API and the MCP server included; beyond that, Pro.',
        '<strong>The AI agent</strong> is paid from the prepaid AI credit, per answer.',
        '<strong>Meta bills your business directly</strong> for each utility template, according to <a href="https://developers.facebook.com/docs/whatsapp/pricing">its rate card</a> and the customer’s country.',
      ],
      faq: [
        { question: 'Must the customer have agreed to receive messages?', reponse: 'Meta asks that the person agreed to be contacted on WhatsApp, for example by ticking it at checkout. A customer who replies STOP receives nothing more.' },
        { question: 'What if the customer turned off read receipts?', reponse: 'WhatsApp then never sends the read receipt: the order stays “Delivered” in your admin.' },
        { question: 'How much does a notification cost?', reponse: 'Free includes 1,000 templates a month. Meta bills each utility template to your business, according to its rate card and the customer’s country.' },
        { question: 'What if the send is replayed?', reponse: 'Within 24 hours, the same idempotency key, taken from the order, returns the same send: the customer gets one message.' },
      ],
      appel: { titre: 'Set up your notifications today.', texte: 'The plugin in two commands, then the sentence above in Claude Code. No account to create.' },
      liens: [['/en/developers/', 'Get started with Claude Code'], ['/en/pricing/', 'Pricing'], ['/en/use-cases/', 'All use cases']],
    },
  },
};
