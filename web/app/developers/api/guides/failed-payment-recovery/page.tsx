'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, LienDoc, Liste, Section } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { ENV_NEXTJS, EXEMPLES_CAS, PROMPT_RELANCE, VERSION_SDK } from '@/lib/exemples-code';

/**
 * LA RECETTE DE LA RELANCE D'UN PAIEMENT ÉCHOUÉ (lot 6 bis, cas « relance-paiement ») : le prompt à coller, le modèle
 * et le code branché dans le webhook Stripe. Le code vient de `EXEMPLES_CAS['relance-paiement']`, compilé contre le SDK
 * publié par `tests/doc-exemples-compiles.test.ts` : la page l'affiche, elle ne l'écrit pas.
 */
export default function ApiRecetteRelancePage() {
  return <CadreDoc page="failed-payment-recovery">{() => <Recette />}</CadreDoc>;
}

function Recette() {
  const t = useT();
  const cas = EXEMPLES_CAS['relance-paiement'];
  const prompt = t(PROMPT_RELANCE[0], PROMPT_RELANCE[1]).replace('{VERSION}', VERSION_SDK);
  return (
    <>
      <EnTetePage page="failed-payment-recovery">
        <p>
          {t(
            'Quand Stripe signale un paiement échoué, votre application envoie à l’utilisateur un message WhatsApp avec le lien vers sa page de facturation, pour qu’il mette à jour sa carte avant de perdre l’accès.',
            'When Stripe reports a failed payment, your app sends the user a WhatsApp message with the link to their billing page, so they update their card before losing access.',
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

      <Section id="modele" titre={t('Le modèle de paiement échoué', 'The failed payment template')}>
        <p>
          {t('Un modèle UTILITY à une variable (le prénom) et un bouton URL vers votre page de facturation : une alerte sur le compte de l’utilisateur. Créez-le par ', 'A UTILITY template with one variable (the first name) and a URL button to your billing page: an alert on the user’s account. Create it with ')}
          <C>create_template</C>
          {t(' (serveur MCP) ou par ', ' (MCP server) or with ')}
          <LienDoc page="templates" ancre="creer">POST /v1/templates</LienDoc>
          {t(', puis attendez l’approbation de Meta ; ', ', then wait for Meta’s approval; ')}
          <C>get_template_status</C>
          {t(' la confirme.', ' confirms it.')}
        </p>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'Gardez le texte factuel : le paiement, la carte, l’accès. Un modèle que Meta reclasse en marketing ne part plus qu’aux contacts qui ont consenti.',
              'Keep the text factual: the payment, the card, the access. A template Meta reclassifies as marketing then only goes to contacts who consented.',
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
        <p>{t('Ce que le cas attend de votre facturation : reliez ces deux fonctions à Stripe et à vos utilisateurs.', 'What the case needs from your billing: wire these two functions to Stripe and to your users.')}</p>
        <Bloc legende={cas.facturation.fichier}>{cas.facturation.code}</Bloc>
      </Section>

      <Section id="stripe" titre={t('Le webhook Stripe', 'The Stripe webhook')}>
        <p>
          {t('Dans le webhook Stripe que votre application a déjà, sur invoice.payment_failed. L’envoi part par ', 'In the Stripe webhook your app already has, on invoice.payment_failed. The send goes through ')}
          <LienDoc page="sends" ancre="envoi">POST /v1/sends</LienDoc>
          {t(
            ', avec une clé d’idempotence tirée de la facture : un même événement livré deux fois dans les 24 heures n’envoie qu’un message. Aucune adresse de webhook Messaging Me n’est nécessaire.',
            ', with an idempotency key taken from the invoice: the same event delivered twice within 24 hours sends one message. No Messaging Me webhook address is needed.',
          )}
        </p>
        <Bloc legende={cas.stripe.fichier}>{cas.stripe.code}</Bloc>
      </Section>

      <Section id="essayer" titre={t('Essayer', 'Trying it')}>
        <Liste>
          <li>{t('Avec la CLI de Stripe, déclenchez invoice.payment_failed pour un client relié à votre propre numéro : le message arrive, et son bouton ouvre votre page de facturation.', 'With the Stripe CLI, trigger invoice.payment_failed for a customer tied to your own number: the message arrives, and its button opens your billing page.')}</li>
          <li>{t('Ou envoyez le modèle par ', 'Or send the template with ')}<C>send_template_to_contact</C>{t(' à votre numéro, avant de brancher Stripe.', ' to your number, before wiring Stripe.')}</li>
        </Liste>
      </Section>
    </>
  );
}
