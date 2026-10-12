'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, LienDoc, LienErreur, Liste, Section } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { ENV_NEXTJS, PROMPT_NEXTJS, RECETTE_NEXTJS, VERSION_SDK } from '@/lib/exemples-code';

/**
 * LA RECETTE NEXT.JS (lot 17, décision de Julien du 2026-10-12 : un prompt à coller, plus le code qu'il doit produire).
 * Le code vient de `RECETTE_NEXTJS`, que `tests/doc-exemples-compiles.test.ts` compile contre le SDK : la page l'affiche,
 * elle ne l'écrit pas.
 */
export default function ApiRecetteNextjsPage() {
  return <CadreDoc page="nextjs">{() => <Recette />}</CadreDoc>;
}

function Recette() {
  const t = useT();
  const prompt = t(PROMPT_NEXTJS[0], PROMPT_NEXTJS[1]).replace('{VERSION}', VERSION_SDK);
  return (
    <>
      <EnTetePage page="nextjs">
        <p>
          {t(
            'Un projet Next.js (App Router) qui envoie un modèle WhatsApp et reçoit les webhooks sortants, signature vérifiée. Collez le prompt dans votre assistant de code, ou recopiez les trois fichiers.',
            'A Next.js project (App Router) that sends a WhatsApp template and receives outgoing webhooks, signature verified. Paste the prompt into your coding assistant, or copy the three files.',
          )}
        </p>
      </EnTetePage>

      <Section id="prompt" titre={t('Le prompt à coller', 'The prompt to paste')}>
        <p>
          {t(
            'Dans Claude Code, Cursor ou un autre assistant, ouvert sur votre projet. Il renvoie l’assistant vers cette recette et vers le contrat de l’API : il n’a rien à deviner.',
            'In Claude Code, Cursor or another assistant, opened on your project. It points the assistant to this recipe and to the API contract: it has nothing to guess.',
          )}
        </p>
        <Bloc legende={t('Prompt', 'Prompt')}>{prompt}</Bloc>
      </Section>

      <Section id="installation" titre={t('Installation', 'Installation')}>
        <Bloc legende={t('Commande', 'Command')}>{`npm install github:julienmessagingme/messagingme-sdk#v${VERSION_SDK}`}</Bloc>
        <p>
          {t('Deux variables dans ', 'Two variables in ')}<C>.env.local</C>
          {t(
            ' : la clé d’API (Developers > Clés d’API, droit sends:create) et le secret de l’adresse de webhook, donné une seule fois à sa création.',
            ': the API key (Developers > API keys, sends:create scope) and the webhook endpoint secret, shown only once when it is created.',
          )}
        </p>
        <Bloc legende=".env.local">{ENV_NEXTJS}</Bloc>
      </Section>

      <Section id="client" titre={t('Le client', 'The client')}>
        <Bloc legende={RECETTE_NEXTJS.client.fichier}>{RECETTE_NEXTJS.client.code}</Bloc>
      </Section>

      <Section id="envoi" titre={t('Envoyer un modèle', 'Sending a template')}>
        <p>
          {t('Le modèle doit être approuvé par Meta (', 'The template must be approved by Meta (')}
          <LienDoc page="templates" ancre="statut">GET /v1/templates/{'{name}'}</LienDoc>
          {t('). La clé d’idempotence tirée du numéro de commande empêche un doublon pendant 24 h, même si la route est rappelée.', '). The idempotency key taken from the order number prevents a duplicate for 24 hours, even if the route is called again.')}
        </p>
        <Bloc legende={RECETTE_NEXTJS.envoi.fichier}>{RECETTE_NEXTJS.envoi.code}</Bloc>
        <Liste>
          <li>
            {t('Un destinataire désabonné ou sans consentement n’est pas une erreur : il revient dans ', 'An opted-out recipient or one without consent is not an error: they come back in ')}
            <C>skipped</C>{t(', avec son motif.', ', with the reason.')}
          </li>
          <li>
            {t('Une erreur porte ', 'An error carries ')}<C>code</C>{t(' (le catalogue : ', ' (the catalog: ')}
            <LienDoc page="errors" ancre="codes">{t('codes de l’API', 'API codes')}</LienDoc>{t(') et, sur ', ') and, on ')}
            <LienErreur code="meta_rejected" />{t(', un champ ', ', a ')}<C>metaCode</C>{t(' dans son corps (e.body).', ' field in its body (e.body).')}
          </li>
        </Liste>
      </Section>

      <Section id="webhook" titre={t('Recevoir les webhooks', 'Receiving webhooks')}>
        <p>
          {t('Déclarez l’adresse ', 'Declare the endpoint ')}<C>https://votre-domaine/api/webhooks/messagingme</C>
          {t(' dans la console (Developers > Webhooks sortants) ou par ', ' in the console (Developers > Outgoing webhooks) or with ')}
          <LienDoc page="webhook-endpoints" ancre="creer">POST /v1/webhooks</LienDoc>
          {t(', et cochez message.failed : il est décoché par défaut.', ', and tick message.failed: it is unticked by default.')}
        </p>
        <Bloc legende={RECETTE_NEXTJS.webhook.fichier}>{RECETTE_NEXTJS.webhook.code}</Bloc>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'Lisez le corps BRUT (req.text()), jamais req.json() avant la vérification : la signature porte sur les octets reçus. Répondez en moins de 10 s, sinon l’envoi est réessayé.',
              'Read the RAW body (req.text()), never req.json() before verification: the signature covers the bytes received. Answer within 10 s, otherwise the delivery is retried.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section id="essayer" titre={t('Essayer', 'Trying it')}>
        <Liste>
          <li>{t('Envoyez un événement d’essai depuis la console, ou par ', 'Send a test event from the console, or with ')}<LienDoc page="webhook-endpoints" ancre="essai">POST /v1/webhooks/{'{webhookId}'}/test</LienDoc>{t(' : la route doit répondre 204.', ': the route must answer 204.')}</li>
          <li>{t('Appelez POST /api/confirmation avec votre propre numéro : le modèle arrive sur votre téléphone.', 'Call POST /api/confirmation with your own number: the template arrives on your phone.')}</li>
          <li>{t('Répondez depuis votre téléphone : la route reçoit message.received.', 'Reply from your phone: the route receives message.received.')}</li>
        </Liste>
      </Section>
    </>
  );
}
