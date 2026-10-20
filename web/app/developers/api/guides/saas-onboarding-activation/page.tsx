'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, LienDoc, Liste, Section } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { ENV_NEXTJS, EXEMPLES_CAS, PROMPT_ACCUEIL, VERSION_SDK } from '@/lib/exemples-code';

/**
 * LA RECETTE DE L'ACCUEIL DES UTILISATEURS D'UN SAAS (lot 6 bis, cas « accueil ») : le prompt à coller, le modèle de
 * bienvenue, la case de consentement et le code. Le code vient de `EXEMPLES_CAS.accueil`, compilé contre le SDK publié
 * par `tests/doc-exemples-compiles.test.ts` : la page l'affiche, elle ne l'écrit pas.
 */
export default function ApiRecetteAccueilPage() {
  return <CadreDoc page="saas-onboarding-activation">{() => <Recette />}</CadreDoc>;
}

function Recette() {
  const t = useT();
  const cas = EXEMPLES_CAS.accueil;
  const prompt = t(PROMPT_ACCUEIL[0], PROMPT_ACCUEIL[1]).replace('{VERSION}', VERSION_SDK);
  return (
    <>
      <EnTetePage page="saas-onboarding-activation">
        <p>
          {t(
            'À l’inscription, votre application envoie la bienvenue sur WhatsApp, avec un bouton qui mène à la première action dans votre produit. Elle ne part qu’à l’utilisateur qui a coché la case WhatsApp du formulaire.',
            'At sign-up, your app sends the welcome on WhatsApp, with a button that leads to the first action in your product. It only goes to the user who ticked the WhatsApp box on the form.',
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

      <Section id="modele" titre={t('Le modèle de bienvenue', 'The welcome template')}>
        <p>
          {t('Un modèle MARKETING à une variable (le prénom) et un bouton URL vers la page qui lance l’utilisateur. Créez-le par ', 'A MARKETING template with one variable (the first name) and a URL button to the page that gets the user started. Create it with ')}
          <C>create_template</C>
          {t(' (serveur MCP) ou par ', ' (MCP server) or with ')}
          <LienDoc page="templates" ancre="creer">POST /v1/templates</LienDoc>
          {t(', puis attendez l’approbation de Meta (le code l’appelle welcome, en anglais : gardez ce nom et cette langue, ou changez-les dans le code) ; ', ', then wait for Meta’s approval (the code calls it welcome, in English: keep that name and language, or change them in the code); ')}
          <C>get_template_status</C>
          {t(' la confirme.', ' confirms it.')}
        </p>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'Une bienvenue qui invite à utiliser le produit est du marketing pour Meta, pas de l’utilitaire. Un modèle marketing ne part qu’à un contact qui a consenti : sans la case cochée, le destinataire est écarté, et il revient dans skipped avec la raison no_consent.',
              'A welcome that invites people to use the product is marketing for Meta, not utility. A marketing template only goes to a contact who consented: without the ticked box, the recipient is set aside, and comes back in skipped with the reason no_consent.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section id="consentement" titre={t('La case de consentement', 'The consent box')}>
        <p>
          {t(
            'Ajoutez au formulaire d’inscription une case « Recevoir mes conseils de démarrage sur WhatsApp », non cochée par défaut. L’envoi transmet consent opted_in et la source du consentement : l’API les écrit sur le contact avant le tri des modèles marketing.',
            'Add to the sign-up form a “Get my getting-started tips on WhatsApp” box, unticked by default. The send passes consent opted_in and the consent source: the API writes them on the contact before the marketing filter.',
          )}
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
        <p>
          {t('La bienvenue, appelée une fois le compte créé. Elle part par ', 'The welcome, called once the account exists. It goes through ')}
          <LienDoc page="sends" ancre="envoi">POST /v1/sends</LienDoc>
          {t(', avec une clé d’idempotence tirée de l’utilisateur : rejouée dans les 24 heures, elle n’envoie pas deux fois.', ', with an idempotency key taken from the user: replayed within 24 hours, it does not send twice.')}
        </p>
        <Bloc legende={cas.inscription.fichier}>{cas.inscription.code}</Bloc>
      </Section>

      <Section id="essayer" titre={t('Essayer', 'Trying it')}>
        <Liste>
          <li>{t('Inscrivez-vous avec votre propre numéro en cochant la case : la bienvenue arrive, et son bouton ouvre votre application.', 'Sign up with your own number, ticking the box: the welcome arrives, and its button opens your app.')}</li>
          <li>{t('Inscrivez-vous sans cocher la case : rien ne part.', 'Sign up without ticking the box: nothing is sent.')}</li>
        </Liste>
      </Section>
    </>
  );
}
