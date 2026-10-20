'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, LienDoc, Liste, Section } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { ENV_NEXTJS, EXEMPLES_CAS, PROMPT_RAPPELS, VERSION_SDK } from '@/lib/exemples-code';

/**
 * LA RECETTE DES RAPPELS DE RENDEZ-VOUS (lot 6 bis, cas « rappels ») : le prompt à coller, le modèle, les deux actions de
 * l'agent et le code. Le code vient de `EXEMPLES_CAS.rappels`, compilé contre le SDK publié par
 * `tests/doc-exemples-compiles.test.ts`, et recopié dans la commande `/messagingme:rappels` du plugin : la page
 * l'affiche, elle ne l'écrit pas.
 */
export default function ApiRecetteRappelsPage() {
  return <CadreDoc page="appointment-reminders">{() => <Recette />}</CadreDoc>;
}

function Recette() {
  const t = useT();
  const cas = EXEMPLES_CAS.rappels;
  const prompt = t(PROMPT_RAPPELS[0], PROMPT_RAPPELS[1]).replace('{VERSION}', VERSION_SDK);
  return (
    <>
      <EnTetePage page="appointment-reminders">
        <p>
          {t(
            'La veille de chaque rendez-vous, votre application envoie un rappel WhatsApp avec deux boutons. « Je confirme » marque le rendez-vous confirmé ; « Je décale » passe la main à l’agent IA, qui propose des créneaux libres, et votre application déplace le rendez-vous choisi.',
            'The evening before each appointment, your app sends a WhatsApp reminder with two buttons. Confirm marks the appointment as confirmed; Reschedule hands over to the AI agent, which offers free slots, and your app moves the appointment to the one chosen.',
          )}
        </p>
      </EnTetePage>

      <Section id="prompt" titre={t('Le prompt à coller', 'The prompt to paste')}>
        <p>
          {t(
            'Dans Claude Code, ouvert sur votre projet, avec le serveur MCP de Messaging Me branché. Il renvoie l’assistant vers cette recette : il n’a rien à deviner.',
            'In Claude Code, opened on your project, with the Messaging Me MCP server connected. It points the assistant to this recipe: it has nothing to guess.',
          )}
        </p>
        <Bloc legende={t('Prompt', 'Prompt')}>{prompt}</Bloc>
      </Section>

      <Section id="modele" titre={t('Le modèle de rappel', 'The reminder template')}>
        <p>
          {t('Un modèle UTILITY à deux variables (le prénom, puis l’heure) et deux boutons de réponse rapide, 25 caractères au plus chacun. Créez-le par ', 'A UTILITY template with two variables (the first name, then the time) and two quick reply buttons, 25 characters at most each. Create it with ')}
          <C>create_template</C>
          {t(' (serveur MCP) ou par ', ' (MCP server) or with ')}
          <LienDoc page="templates" ancre="creer">POST /v1/templates</LienDoc>
          {t(
            ', puis attendez l’approbation de Meta, souvent en quelques minutes. Le code l’appelle appointment_reminder, en anglais (en) : gardez ce nom et cette langue, ou changez-les dans le code.',
            ', then wait for Meta’s approval, often within minutes. The code calls it appointment_reminder, in English (en): keep that name and language, or change them in the code.',
          )}
        </p>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'Un bouton touché arrive dans message.received par son LIBELLÉ (data.button), sans dire à quel message il répond. Le code compare ce libellé et retrouve le dernier rappel envoyé au numéro : gardez le même libellé dans le modèle et dans la route.',
              'A tapped button arrives in message.received by its LABEL (data.button), without saying which message it answers. The code compares that label and finds the last reminder sent to the number: keep the same label in the template and in the route.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section id="actions" titre={t('Les deux actions de l’agent IA', 'The two AI agent actions')}>
        <p>
          {t('Sur l’agent qui répond, ajoutez deux actions par ', 'On the agent that answers, add two actions with ')}<C>set_agent_action</C>
          {t(' : « Reschedule request », sans champ (dire qu’on regarde les créneaux libres), et « Slot choice », avec un champ texte codé slot (dire qu’on bloque le créneau). Votre application reçoit agent.action, une fois par jour au plus par contact et par action. L’agent doit être allumé (', ': “Reschedule request”, with no field (say you are checking the free slots), and “Slot choice”, with a text field coded slot (say you are holding the slot). Your app receives agent.action, at most once a day per contact and per action. The agent must be on (')}
          <C>activate_agent</C>
          {t(') et répondre pour l’espace (', ') and answer for the workspace (')}
          <C>set_default_responder</C>
          {t(') : sinon aucune action ne part, sans erreur.', '): otherwise no action fires, with no error.')}
        </p>
      </Section>

      <Section id="code" titre={t('Le code', 'The code')}>
        <p>
          {t('Installez le SDK, puis les variables dans ', 'Install the SDK, then the variables in ')}<C>.env.local</C>
          {t(' et dans celles de votre hébergeur.', ' and in your host’s.')}
        </p>
        <Bloc legende={t('Commande', 'Command')}>{`npm install github:julienmessagingme/messagingme-sdk#v${VERSION_SDK}`}</Bloc>
        <Bloc legende=".env.local">{ENV_NEXTJS}</Bloc>
        <Bloc legende={cas.client.fichier}>{cas.client.code}</Bloc>
        <p>{t('Ce que le cas attend de votre agenda : reliez ces fonctions à votre base.', 'What the case needs from your calendar: wire these functions to your database.')}</p>
        <Bloc legende={cas.agenda.fichier}>{cas.agenda.code}</Bloc>
        <p>
          {t('La tâche de la veille, lancée chaque soir par le planificateur de votre hébergeur. Elle envoie par ', 'The day-before job, run every evening by your host’s scheduler. It sends through ')}
          <LienDoc page="sends" ancre="envoi">POST /v1/sends</LienDoc>
          {t(
            ', avec une clé d’idempotence tirée du rendez-vous et de son heure : relancée le même soir, elle n’envoie pas deux fois. Un destinataire écarté (STOP, limite de l’offre) n’est pas une erreur, il revient dans skipped avec sa raison ; une erreur sur un rendez-vous n’arrête pas les autres, un débit dépassé (rate_limited) attend le délai que l’API indique, et le quota du jour atteint (quota_exceeded) arrête la tâche jusqu’au lendemain.',
            ', with an idempotency key taken from the appointment and its time: run again the same evening, it does not send twice. A recipient set aside (STOP, plan limit) is not an error, it comes back in skipped with its reason; an error on one appointment does not stop the others, an exceeded rate (rate_limited) waits the delay the API gives, and the daily quota reached (quota_exceeded) stops the job until the next day.',
          )}
        </p>
        <Bloc legende={cas.tache.fichier}>{cas.tache.code}</Bloc>
      </Section>

      <Section id="webhook" titre={t('La route qui reçoit les réponses', 'The route that receives the replies')}>
        <p>
          {t('Déclarez son adresse par ', 'Declare its address with ')}<C>create_webhook_endpoint</C>{t(' ou par ', ' or with ')}
          <LienDoc page="webhook-endpoints" ancre="creer">POST /v1/webhooks</LienDoc>
          {t(
            ', avec les types message.received, coché par défaut, et agent.action, décoché par défaut : cochez-le.',
            ', with the types message.received, ticked by default, and agent.action, unticked by default: tick it.',
          )}
        </p>
        <Bloc legende={cas.webhook.fichier}>{cas.webhook.code}</Bloc>
      </Section>

      <Section id="essayer" titre={t('Essayer', 'Trying it')}>
        <Liste>
          <li>{t('Envoyez un événement d’essai par ', 'Send a test event with ')}<C>send_test_event</C>{t(' ou par ', ' or with ')}<LienDoc page="webhook-endpoints" ancre="essai">POST /v1/webhooks/{'{webhookId}'}/test</LienDoc>{t(' : la route doit répondre 2xx.', ': the route must answer 2xx.')}</li>
          <li>{t('Prenez un rendez-vous demain avec votre propre numéro, lancez la tâche, puis touchez « Je décale » sur votre téléphone.', 'Book an appointment tomorrow with your own number, run the job, then tap Reschedule on your phone.')}</li>
        </Liste>
      </Section>
    </>
  );
}
