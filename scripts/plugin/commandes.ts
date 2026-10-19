/**
 * LE TEXTE ÉCRIT À LA MAIN DES COMMANDES DE CAS DU PLUGIN (lot 6 bis, livraison D ; spec
 * `docs/superpowers/specs/2026-10-16-cas-d-usage-par-profil-design.md`, « Le dépôt du plugin »).
 *
 * Une commande par cas qui s'écrit dans l'application du client (`chemin: 'code'` au registre) : `/messagingme:<nom>`.
 * `npm run plugin:generer` écrit son dossier (`plugin/skills/<nom>/`) : le `SKILL.md` à partir de ce texte, `code/` à
 * partir de `EXEMPLES_CAS` (le code compilé contre le SDK publié) et `.env.example`. Le texte est en anglais, comme tout
 * le plugin (il se lit sur GitHub), et Claude répond dans la langue de la personne.
 *
 * ⚠️ Une commande publiée ne se renomme pas (la personne l'a dans ses habitudes, sa doc, ses scripts).
 * ⚠️ Un nom en code (entre accents graves) doit exister : outil du catalogue, argument, code de refus
 * (`tests/plugin.test.ts`). Un nom de modèle ou d'action s'écrit donc entre guillemets.
 */
export interface TexteCommande {
  /** La description de la skill : ce que la commande branche, pour la liste de `/` dans Claude Code. */
  readonly description: string;
  readonly titre: string;
  /** Le corps, en Markdown : la demande, puis les étapes. La liste des fichiers de `code/` est ajoutée à la génération. */
  readonly corps: readonly string[];
}

export const COMMANDES: Readonly<Record<string, TexteCommande>> = {
  rappels: {
    description: 'Appointment reminders on WhatsApp the evening before, with Confirm and Reschedule buttons; the AI agent '
      + 'offers free slots and your app moves the appointment. Run it in your app\'s project.',
    titre: 'Appointment reminders on WhatsApp',
    corps: [
      'The user wants their app to remind each appointment on WhatsApp the evening before, with two quick reply buttons,',
      'Confirm and Reschedule. Confirm marks the appointment as confirmed in their calendar; Reschedule hands over to the AI',
      'agent, which offers free slots, and the app moves the appointment to the one the person picks.',
      '',
      'Speak the user\'s language. Every send follows the `regles-whatsapp` skill of this plugin.',
      '',
      '1. Call `get_setup_state`. The workspace needs a connected WhatsApp number and an AI agent that answers customers. If',
      '   either is missing, tell the user to run /messagingme:demarrer first, and stop there.',
      '2. Read the project: its framework (the code below is Next.js App Router), where appointments are stored, how a job',
      '   can run once a day (the host\'s cron), and the public address of the deployed app.',
      '3. Create the reminder template with `create_template`: category UTILITY, a body with two variables, the first name',
      '   then the time ("Hello {{1}}, a reminder of your appointment tomorrow at {{2}}."), and two QUICK_REPLY buttons,',
      '   Confirm and Reschedule, in the user\'s language (25 characters at most each). Meta reviews it, usually within',
      '   minutes: check it with `get_template_status`.',
      '4. On the agent that answers, add two actions with `set_agent_action`: "Reschedule request", with no field (instruction:',
      '   when the person wants to move their appointment, say you are checking the free slots), and "Slot choice", with a',
      '   text field coded slot (instruction: when the person picks one of the offered slots, say you are holding it).',
      '5. Copy the files below into the project and adapt them: wire the functions of lib/calendar.ts to the project\'s',
      '   calendar, and keep the template name, the Confirm button label and the two action names exactly as created in',
      '   steps 3 and 4 (the route compares them). A button reply carries its label only: the route ties it to the last',
      '   reminder sent to the number, which is why the job saves each send.',
      '6. Create an API key with `create_api_key`, and a webhook address with `create_webhook_endpoint` on the route\'s',
      '   public URL, with the types message.received and agent.action (both are unchecked by default). Put the key in',
      '   MESSAGINGME_API_KEY and the secret in MESSAGINGME_WEBHOOK_SECRET, in the host\'s environment variables, never in',
      '   the code: .env.example lists them.',
      '7. Schedule dayBeforeReminders() every evening with the host\'s cron, typecheck, deploy, then call `send_test_event`',
      '   on the address: the route must answer 2xx. Suggest a real test: an appointment tomorrow on the user\'s own phone.',
    ],
  },
};

/**
 * Les commandes que le registre annonce et qui ne sont pas encore publiées, avec ce qu'elles attendent. Un test exige
 * que chaque commande du registre (hors `demarrer`) soit générée ou nommée ici : aucune ne disparaît en silence.
 */
export const COMMANDES_EN_ATTENTE: Readonly<Record<string, string>> = {
  accueil: 'son code et son texte : la bienvenue est un modèle MARKETING (consentement à l\'inscription), relevé du 2026-10-19',
  'relance-paiement': 'son code et son texte',
  agence: 'le geste produit de Julien : changer d\'espace dans Claude Code sans autoriser de nouveau',
};
