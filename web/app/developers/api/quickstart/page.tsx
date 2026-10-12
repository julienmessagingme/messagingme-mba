'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, LienDoc, LienErreur, Liste, Section, curl, curlGet } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { EXEMPLES_CORPS } from '@/lib/api-exemples';

/**
 * DÉMARRER (lot 17, décision de Julien du 2026-10-12 : depuis l'inscription). Le chemin complet d'un inconnu : l'espace et
 * le numéro par le tunnel `/demarrer` (lot 19), la clé, l'adresse de webhook, puis le premier envoi.
 *
 * 🔴 LE PREMIER ENVOI EST UNE RÉPONSE, PAS UN MODÈLE : un modèle neuf attend la validation de Meta (minutes, jusqu'à
 * 24 h), et un compte neuf n'en a parfois aucun (vérifié le 2026-10-12). Écrire au numéro depuis son téléphone ouvre la
 * fenêtre de 24 h : la réponse par l'API part tout de suite. Le modèle vient ensuite, pour écrire en premier.
 */
export default function ApiDemarrerPage() {
  return <CadreDoc page="quickstart">{() => <Demarrer />}</CadreDoc>;
}

function Demarrer() {
  const t = useT();
  return (
    <>
      <EnTetePage page="quickstart">
        <p>
          {t(
            'De l’inscription au premier message envoyé par l’API, avec votre propre téléphone pour vérifier chaque étape. Il vous faut un numéro WhatsApp (le vôtre, ou un numéro que nous fournissons) et un serveur qui reçoit des requêtes HTTPS.',
            'From sign-up to the first message sent through the API, with your own phone to check each step. You need a WhatsApp number (yours, or one we provide) and a server that receives HTTPS requests.',
          )}
        </p>
      </EnTetePage>

      <Section id="espace" titre={t('1. Créer son espace et brancher son numéro', '1. Create your workspace and connect your number')}>
        <p>
          {t('Inscrivez-vous sur ', 'Sign up at ')}<C>https://console.messagingme.app/signup</C>
          {t(
            '. La console enchaîne : connecter un numéro WhatsApp (le vôtre, par la fenêtre de Meta, ou un numéro fourni), puis une page qui donne la commande pour brancher Claude Code et le premier message à lui écrire.',
            '. The console chains the steps: connect a WhatsApp number (yours, through Meta’s window, or a provided number), then a page with the command to connect Claude Code and the first message to write to it.',
          )}
        </p>
        <p className="text-sm text-ink-500">
          {t('Sans numéro branché, rien ne part : ', 'With no number connected, nothing goes out: ')}<LienErreur code="no_whatsapp_number" />.
        </p>
      </Section>

      <Section id="cle" titre={t('2. Créer une clé d’API', '2. Create an API key')}>
        <p>
          {t(
            'Dans la console, Developers > Clés d’API. Cochez au moins sends:create (envoyer) et conversations:read (lire les fils). La clé (mba_…) n’est montrée qu’une fois : gardez-la côté serveur, dans une variable d’environnement.',
            'In the console, Developers > API keys. Tick at least sends:create (send) and conversations:read (read threads). The key (mba_…) is shown only once: keep it server-side, in an environment variable.',
          )}
        </p>
        <Bloc legende={t('Vérifier la clé', 'Check the key')}>{curlGet('/v1/templates')}</Bloc>
        <p className="text-sm text-ink-500">
          {t('Une liste, même vide, veut dire que la clé marche. Sinon : ', 'A list, even empty, means the key works. Otherwise: ')}
          <LienErreur code="unauthorized" />, <LienErreur code="missing_scope" />.
        </p>
      </Section>

      <Section id="webhook" titre={t('3. Recevoir les événements', '3. Receive events')}>
        <p>
          {t(
            'Déclarez l’adresse de votre serveur dans la console (Developers > Webhooks sortants), ou par l’API avec une clé qui porte webhooks:write. Le secret (whsec_…) n’est montré qu’une fois : il sert à vérifier chaque signature.',
            'Declare your server’s address in the console (Developers > Outgoing webhooks), or through the API with a key that carries webhooks:write. The secret (whsec_…) is shown only once: it is used to verify each signature.',
          )}
        </p>
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/webhooks', EXEMPLES_CORPS.webhookCree.corps)}</Bloc>
        <p>
          {t('Vérifiez la signature sur le corps brut, avec le ', 'Verify the signature on the raw body, with the ')}
          <LienDoc page="sdk" ancre="webhook">SDK</LienDoc>
          {t(' ou à la main (', ' or by hand (')}<LienDoc page="webhooks" ancre="signature">{t('le format', 'the format')}</LienDoc>
          {t('), puis répondez 2xx en moins de 10 s.', '), then answer 2xx within 10 s.')}
        </p>
      </Section>

      <Section id="premier-envoi" titre={t('4. Un premier envoi', '4. A first send')}>
        <p>
          {t(
            'Le plus rapide : depuis votre téléphone, écrivez au numéro de l’espace. Votre serveur reçoit message.received, avec la fiche créée pour vous. Pendant 24 h, l’API peut vous répondre par un message libre :',
            'The fastest: from your phone, write to the workspace’s number. Your server receives message.received, with the record created for you. For 24 hours, the API can answer you with a free-form message:',
          )}
        </p>
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/messages/whatsapp', EXEMPLES_CORPS.premiereReponse.corps)}</Bloc>
        <p>
          {t(
            'Pour écrire en premier, il faut un modèle approuvé par Meta : créez-le dans la console (Contenu > WhatsApp > Templates) ou par ',
            'To write first, you need a template approved by Meta: create it in the console (Content > WhatsApp > Templates) or with ',
          )}
          <LienDoc page="templates" ancre="creer">POST /v1/templates</LienDoc>
          {t(', attendez son approbation (de quelques minutes à 24 h), puis envoyez-le :', ', wait for its approval (from a few minutes to 24 hours), then send it:')}
        </p>
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/sends', EXEMPLES_CORPS.premierModele.corps)}</Bloc>
        <Liste>
          <li>{t('Fenêtre fermée : ', 'Window closed: ')}<LienErreur code="window_closed" />{t(' ; passez par un modèle.', '; use a template.')}</li>
          <li>{t('Pas de carte dans le Business Manager : ', 'No card in Business Manager: ')}<LienErreur meta={131042} />.</li>
          <li>{t('Le numéro n’est pas sur WhatsApp : ', 'The number is not on WhatsApp: ')}<LienErreur meta={131026} />.</li>
        </Liste>
      </Section>

      <Section id="ensuite" titre={t('Ensuite', 'Next')}>
        <Liste>
          <li><LienDoc page="meta-pitfalls">{t('Les pièges de Meta', 'Meta pitfalls')}</LienDoc>{t(' : ce que Meta impose, avant votre premier envoi en nombre.', ': what Meta imposes, before your first bulk send.')}</li>
          <li><LienDoc page="nextjs">{t('La recette Next.js', 'The Next.js recipe')}</LienDoc>{t(' : les mêmes étapes dans un projet, avec un prompt à coller.', ': the same steps in a project, with a prompt to paste.')}</li>
          <li><LienDoc page="errors">{t('Le catalogue des erreurs', 'The error catalog')}</LienDoc>{t(' : chaque code et quoi faire.', ': every code and what to do.')}</li>
        </Liste>
        <Encadre sorte="note">
          <p>
            {t('Avec Claude Code, tout ceci se fait aussi en conversation : ', 'With Claude Code, all of this can also be done in conversation: ')}
            <LienDoc page="mcp">{t('le serveur MCP', 'the MCP server')}</LienDoc>.
          </p>
        </Encadre>
      </Section>
    </>
  );
}
