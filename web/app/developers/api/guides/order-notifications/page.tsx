'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, LienDoc, Liste, Section } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { ENV_NEXTJS, EXEMPLES_CAS, PROMPT_NOTIFICATIONS, VERSION_SDK } from '@/lib/exemples-code';

/**
 * LA RECETTE DES NOTIFICATIONS DE COMMANDE (lot 6 bis, cas « notifications ») : le prompt à coller, le modèle, le code
 * de l'envoi et la route des accusés. Le code vient de `EXEMPLES_CAS.notifications`, compilé contre le SDK publié par
 * `tests/doc-exemples-compiles.test.ts` : la page l'affiche, elle ne l'écrit pas.
 */
export default function ApiRecetteNotificationsPage() {
  return <CadreDoc page="order-notifications">{() => <Recette />}</CadreDoc>;
}

function Recette() {
  const t = useT();
  const cas = EXEMPLES_CAS.notifications;
  const prompt = t(PROMPT_NOTIFICATIONS[0], PROMPT_NOTIFICATIONS[1]).replace('{VERSION}', VERSION_SDK);
  return (
    <>
      <EnTetePage page="order-notifications">
        <p>
          {t(
            'Quand une commande passe en expédiée, votre application envoie au client un message WhatsApp avec son lien de suivi. Les accusés de Meta reviennent sur votre route : la commande s’affiche livrée, puis lue. Si le client répond, la conversation part à l’agent IA.',
            'When an order moves to shipped, your app sends the customer a WhatsApp message with their tracking link. Meta’s receipts come back to your route: the order shows delivered, then read. If the customer replies, the conversation goes to the AI agent.',
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

      <Section id="modele" titre={t('Le modèle d’expédition', 'The shipping template')}>
        <p>
          {t('Un modèle UTILITY à deux variables (le prénom, puis le numéro de commande) et un bouton URL vers votre page de suivi. Créez-le par ', 'A UTILITY template with two variables (the first name, then the order number) and a URL button to your tracking page. Create it with ')}
          <C>create_template</C>
          {t(' (serveur MCP) ou par ', ' (MCP server) or with ')}
          <LienDoc page="templates" ancre="creer">POST /v1/templates</LienDoc>
          {t(', puis attendez l’approbation de Meta, souvent en quelques minutes (le code l’appelle order_shipped, en anglais : gardez ce nom et cette langue, ou changez-les dans le code) ; ', ', then wait for Meta’s approval, often within minutes (the code calls it order_shipped, in English: keep that name and language, or change them in the code); ')}
          <C>get_template_status</C>
          {t(' la confirme.', ' confirms it.')}
        </p>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'L’adresse du bouton est fixe : elle mène à votre page de suivi, et le numéro de commande voyage dans le corps du message.',
              'The button’s address is fixed: it leads to your tracking page, and the order number travels in the message body.',
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
        <p>
          {t('L’envoi, appelé quand une commande passe en expédiée. Il part par ', 'The send, called when an order moves to shipped. It goes through ')}
          <LienDoc page="sends" ancre="envoi">POST /v1/sends</LienDoc>
          {t(
            ', avec une clé d’idempotence tirée de la commande : rejoué dans les 24 heures, il n’envoie pas deux fois. L’identifiant d’envoi rendu se range sur la commande, c’est lui que portent les accusés.',
            ', with an idempotency key taken from the order: replayed within 24 hours, it does not send twice. The send identifier it returns is stored on the order: the receipts carry it.',
          )}
        </p>
        <Bloc legende={cas.commandes.fichier}>{cas.commandes.code}</Bloc>
      </Section>

      <Section id="webhook" titre={t('La route qui reçoit les accusés', 'The route that receives the receipts')}>
        <p>
          {t('Déclarez son adresse par ', 'Declare its address with ')}<C>create_webhook_endpoint</C>{t(' ou par ', ' or with ')}
          <LienDoc page="webhook-endpoints" ancre="creer">POST /v1/webhooks</LienDoc>
          {t(', avec les types message.delivered et message.read : ils sont décochés par défaut.', ', with the types message.delivered and message.read: they are unticked by default.')}
        </p>
        <Bloc legende={cas.webhook.fichier}>{cas.webhook.code}</Bloc>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'Un client qui a désactivé les confirmations de lecture dans WhatsApp n’envoie jamais message.read : sa commande reste livrée. Un accusé peut arriver en retard ou deux fois : le statut ne fait qu’avancer, un « livré » tardif n’efface pas « lu ». Pour voir un échec de remise, abonnez aussi message.failed, décoché par défaut.',
              'A customer who turned off read receipts in WhatsApp never sends message.read: their order stays delivered. A receipt can arrive late or twice: the status only moves forward, a late “delivered” never erases “read”. To see a delivery failure, also subscribe to message.failed, unticked by default.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section id="reponse" titre={t('Si le client répond', 'If the customer replies')}>
        <p>
          {t('Sa réponse ouvre une conversation. L’agent IA qui répond pour l’espace (', 'Their reply opens a conversation. The AI agent that answers for the workspace (')}
          <C>set_default_responder</C>
          {t(') la prend, avec votre politique de livraison dans sa connaissance (', ') takes it, with your delivery policy in its knowledge (')}
          <C>add_knowledge</C>
          {t(') ; en Pro, votre équipe peut reprendre la main dans l’Inbox de la console. La route n’a rien à faire.', '); on Pro, your team can take over in the console’s Inbox. The route has nothing to do.')}
        </p>
      </Section>

      <Section id="essayer" titre={t('Essayer', 'Trying it')}>
        <Liste>
          <li>{t('Envoyez un événement d’essai par ', 'Send a test event with ')}<C>send_test_event</C>{t(' ou par ', ' or with ')}<LienDoc page="webhook-endpoints" ancre="essai">POST /v1/webhooks/{'{webhookId}'}/test</LienDoc>{t(' : la route doit répondre 2xx.', ': the route must answer 2xx.')}</li>
          <li>{t('Passez une commande avec votre propre numéro, marquez-la expédiée, ouvrez le message sur votre téléphone : la commande s’affiche livrée, puis lue.', 'Place an order with your own number, mark it shipped, open the message on your phone: the order shows delivered, then read.')}</li>
        </Liste>
      </Section>
    </>
  );
}
