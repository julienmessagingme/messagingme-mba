'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, LienDoc, Liste, Section } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { ENV_NEXTJS, EXEMPLES_CAS, PROMPT_RENDEZ_VOUS, VERSION_SDK } from '@/lib/exemples-code';

/**
 * LA RECETTE DE LA PRISE DE RENDEZ-VOUS (lot 6 bis, cas « rendez-vous ») : le prompt à coller, les deux actions de
 * l'agent IA et le code. Le code vient de `EXEMPLES_CAS['rendez-vous']`, compilé contre le SDK publié par
 * `tests/doc-exemples-compiles.test.ts` : la page l'affiche, elle ne l'écrit pas.
 */
export default function ApiRecetteRendezVousPage() {
  return <CadreDoc page="appointment-booking">{() => <Recette />}</CadreDoc>;
}

function Recette() {
  const t = useT();
  const cas = EXEMPLES_CAS['rendez-vous'];
  const prompt = t(PROMPT_RENDEZ_VOUS[0], PROMPT_RENDEZ_VOUS[1]).replace('{VERSION}', VERSION_SDK);
  return (
    <>
      <EnTetePage page="appointment-booking">
        <p>
          {t(
            'Un client demande un rendez-vous sur WhatsApp. L’agent IA note le motif et la ville, votre application lui propose trois créneaux libres de votre agenda, puis réserve celui qu’il choisit et le confirme sur WhatsApp.',
            'A customer asks for an appointment on WhatsApp. The AI agent notes the reason and the city, your app offers three free slots from your calendar, then books the one they pick and confirms it on WhatsApp.',
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

      <Section id="actions" titre={t('Les deux actions de l’agent IA', 'The two AI agent actions')}>
        <p>
          {t('Sur l’agent qui répond, ajoutez deux actions par ', 'On the agent that answers, add two actions with ')}<C>set_agent_action</C>
          {t(
            ' : « Appointment request », avec deux champs texte codés reason et city (consigne : la déclencher une fois la ville connue, et dire qu’on regarde les créneaux libres), et « Slot choice », avec un champ texte codé slot (dire qu’on bloque le créneau). Votre application reçoit agent.action, une fois par jour au plus par contact et par action, avec les champs connus à ce moment. L’agent doit être allumé (activate_agent) et répondre pour l’espace (set_default_responder) : sinon aucune action ne part, sans erreur.',
            ': “Appointment request”, with two text fields coded reason and city (instruction: trigger it once the city is known, and say you are checking the free slots), and “Slot choice”, with a text field coded slot (say you are holding the slot). Your app receives agent.action, at most once a day per contact and per action, with the fields known at that moment. The agent must be on (activate_agent) and answer for the workspace (set_default_responder): otherwise no action fires, with no error.',
          )}
        </p>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'Le code lit action.name et fields par leur nom exact : gardez les mêmes noms d’actions et les mêmes codes de champs dans l’agent et dans la route. Et slot est ce que l’agent a compris du client : votre agenda le recoupe avec les créneaux proposés, et ne réserve qu’un créneau encore libre, deux clients pouvant choisir le même.',
              'The code reads action.name and fields by their exact name: keep the same action names and field codes in the agent and in the route. And slot is what the agent understood from the customer: your calendar matches it against the slots offered, and books only a slot still free, since two customers can pick the same.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section id="code" titre={t('Le code', 'The code')}>
        <p>
          {t('Installez le SDK, puis les variables dans ', 'Install the SDK, then the variables in ')}<C>.env.local</C>
          {t(' et dans celles de votre hébergeur.', ' and in your host’s.')}
        </p>
        <Bloc legende={t('Commande', 'Command')}>{`npm install github:julienmessagingme/messagingme-sdk#v${VERSION_SDK}`}</Bloc>
        <Bloc legende=".env.local">{ENV_NEXTJS}</Bloc>
        <Bloc legende={cas.client.fichier}>{cas.client.code}</Bloc>
        <p>{t('Ce que le cas attend de votre agenda : reliez ces deux fonctions à votre base.', 'What the case needs from your calendar: wire these two functions to your database.')}</p>
        <Bloc legende={cas.agenda.fichier}>{cas.agenda.code}</Bloc>
      </Section>

      <Section id="webhook" titre={t('La route qui reçoit les actions', 'The route that receives the actions')}>
        <p>
          {t('Déclarez son adresse par ', 'Declare its address with ')}<C>create_webhook_endpoint</C>{t(' ou par ', ' or with ')}
          <LienDoc page="webhook-endpoints" ancre="creer">POST /v1/webhooks</LienDoc>
          {t(', avec le type agent.action : il est décoché par défaut. La route répond au client par ', ', with the type agent.action: it is unticked by default. The route answers the customer with ')}
          <LienDoc page="messages" ancre="message-whatsapp">POST /v1/messages/whatsapp</LienDoc>
          {t(' : il vient d’écrire, la fenêtre de 24 heures est ouverte.', ': they just wrote, the 24-hour window is open.')}
        </p>
        <Bloc legende={cas.webhook.fichier}>{cas.webhook.code}</Bloc>
      </Section>

      <Section id="essayer" titre={t('Essayer', 'Trying it')}>
        <Liste>
          <li>{t('Envoyez un événement d’essai par ', 'Send a test event with ')}<C>send_test_event</C>{t(' ou par ', ' or with ')}<LienDoc page="webhook-endpoints" ancre="essai">POST /v1/webhooks/{'{webhookId}'}/test</LienDoc>{t(' : la route doit répondre 2xx.', ': the route must answer 2xx.')}</li>
          <li>{t('Depuis votre téléphone, écrivez au numéro de l’espace que vous voulez un rendez-vous, donnez une ville, puis choisissez un des créneaux proposés.', 'From your phone, write to the workspace number that you want an appointment, give a city, then pick one of the slots offered.')}</li>
        </Liste>
      </Section>
    </>
  );
}
