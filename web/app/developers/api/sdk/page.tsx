'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, LienDoc, Liste, Section } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';

/**
 * LE SDK TYPESCRIPT (lot 16, livraison B) : l'installation, un premier appel, les erreurs et la vérification d'un
 * webhook. Le paquet vit dans son propre dépôt (`julienmessagingme/messagingme-sdk`), publié à la main après le
 * déploiement de l'API (`.github/workflows/sdk.yml`). Ses exemples reprennent ceux de `sdk/README.md` ; aucun test ne les
 * compile encore contre le SDK (`todo.md`, lot 16).
 *
 * ⚠️ LA VERSION EST CELLE DE `sdk/package.json` : `tests/sdk-contrat.test.ts` les compare, comme celle du README.
 * Monter la version du SDK sans toucher cette ligne ferait installer l'ancienne. Pas d'`export` : un fichier
 * `page.tsx` n'exporte que ce que Next attend d'une page, le build refuse le reste.
 */
const VERSION_SDK = '0.1.0';

export default function ApiSdkPage() {
  return <CadreDoc page="sdk">{() => <Contenu />}</CadreDoc>;
}

const INSTALLATION = `npm install github:julienmessagingme/messagingme-sdk#v${VERSION_SDK}`;

const PREMIER_APPEL = [
  "import { createClient } from '@messagingme/sdk';",
  '',
  'const api = createClient({ apiKey: process.env.MESSAGINGME_API_KEY! });',
  '',
  '// Créer une fiche, ou la mettre à jour si elle existe.',
  "const { contactId, status } = await api.POST('/v1/contacts', {",
  "  body: { phone: '+33612345678', name: 'Camille Roy', consent: 'opted_in', consentSource: 'formulaire-site' },",
  '});',
  '',
  '// Lire une fiche : les paramètres de chemin passent par path.',
  "const fiche = await api.GET('/v1/contacts/{contactId}', { path: { contactId } });",
  '',
  '// Les conversations qui attendent une réponse, par pages : query.',
  "const page = await api.GET('/v1/conversations', { query: { needsReply: true, limit: 20 } });",
  '',
  '// Un envoi, rejouable sans doublon avec la même clé d’idempotence. Ici un modèle sans variable :',
  '// avec variables, ajoutez params (voir Envois).',
  "const envoi = await api.POST('/v1/sends', {",
  '  body: {',
  "    target: { template: { name: 'confirmation_commande', language: 'fr' } },",
  "    recipients: [{ phone: '+33612345678' }],",
  '  },',
  "  idempotencyKey: 'commande-7781',",
  '});',
].join('\n');

const ERREURS = [
  "import { ApiError } from '@messagingme/sdk';",
  '',
  'try {',
  "  await api.POST('/v1/messages/whatsapp', { body: { contactId, text: 'Bonjour' } });",
  '} catch (e) {',
  '  if (e instanceof ApiError) {',
  "    if (e.code === 'window_closed') { /* la personne n’a pas écrit depuis 24 h : passer par un modèle */ }",
  '    if (e.status === 429 && e.retryAfter !== null) { /* attendre e.retryAfter secondes */ }',
  '  }',
  '  throw e;',
  '}',
].join('\n');

const WEBHOOK = [
  "import { verifyWebhook, WebhookVerificationError } from '@messagingme/sdk';",
  '',
  '// Une route qui reçoit les webhooks sortants (ici avec l’API Request standard).',
  'export async function POST(req: Request) {',
  '  const body = await req.text();',
  '  try {',
  '    const event = await verifyWebhook({ secret: process.env.MESSAGINGME_WEBHOOK_SECRET!, headers: req.headers, body });',
  "    if (event.type === 'message.received') console.log(event.data.text);",
  '    return new Response(null, { status: 204 });',
  '  } catch (e) {',
  '    if (e instanceof WebhookVerificationError) return new Response(null, { status: 401 });',
  '    throw e;',
  '  }',
  '}',
].join('\n');

function Contenu() {
  const t = useT();
  return (
    <>
      <EnTetePage page="sdk">
        <p>
          {t(
            'Le client TypeScript de l’API : des appels typés par chemin et par méthode, des erreurs typées, et la vérification de signature des webhooks sortants. Ses types sont générés depuis le ',
            'The TypeScript client of the API: calls typed by path and method, typed errors, and signature verification for outgoing webhooks. Its types are generated from the ',
          )}
          <LienDoc page="accueil" ancre="openapi">{t('contrat OpenAPI', 'OpenAPI contract')}</LienDoc>
          {t(
            ' : un chemin, un corps ou une réponse qui n’existent pas ne compilent pas.',
            ': a path, body or response that does not exist does not compile.',
          )}
        </p>
      </EnTetePage>

      <Section id="installation" titre={t('Installation', 'Installation')}>
        <Bloc legende={t('Installation', 'Installation')}>{INSTALLATION}</Bloc>
        <Liste>
          <li>{t('Aucune dépendance. Node 20 ou plus, Deno, Bun, et les environnements qui exposent fetch et Web Crypto.', 'No dependency. Node 20 or later, Deno, Bun, and runtimes that expose fetch and Web Crypto.')}</li>
          <li>{t('Paquet ESM seulement : il s’importe par import, pas par require.', 'ESM only: import it with import, not require.')}</li>
          <li>{t('L’installation depuis GitHub demande git sur la machine (une image Docker minimale ne l’a pas toujours).', 'Installing from GitHub needs git on the machine (a minimal Docker image does not always have it).')}</li>
          <li>{t('Une version publiée ne change plus : la version suit l’étiquette après le #.', 'A published version never changes: the version follows the tag after the #.')}</li>
        </Liste>
      </Section>

      <Section id="premier-appel" titre={t('Un premier appel', 'A first call')}>
        <p>
          {t('La clé d’API (', 'The API key (')}<C>mba_…</C>
          {t(') se crée dans la console, Developers > Clés d’API. Gardez-la côté serveur. Le client appelle l’API de production ; ', ') is created in the console, Developers > API keys. Keep it server-side. The client calls the production API; ')}
          <C>baseUrl</C>{t(' en désigne une autre.', ' points to another one.')}
        </p>
        <Bloc legende="TypeScript">{PREMIER_APPEL}</Bloc>
        <p className="text-sm text-ink-500">
          {t('Les droits de chaque route :', 'The scope of each route:')}{' '}
          <LienDoc page="reference" ancre="authentification">{t('Authentification, limites et erreurs', 'Authentication, limits and errors')}</LienDoc>.
        </p>
      </Section>

      <Section id="erreurs" titre={t('Les erreurs', 'Errors')}>
        <p>
          {t('Toute réponse hors 2xx lève ', 'Any non-2xx response throws ')}<C>ApiError</C>
          {t(', avec le statut, le code de l’API et, quand l’API le dit, le délai à attendre. Le SDK ne relance rien de lui-même.', ', with the status, the API code and, when the API says so, the delay to wait. The SDK retries nothing on its own.')}
        </p>
        <Bloc legende="TypeScript">{ERREURS}</Bloc>
        <Liste>
          <li><C>code</C>{t(' vaut null sur une panne générique (JSON illisible, erreur interne).', ' is null on a generic failure (unreadable JSON, internal error).')}</li>
          <li><C>upgradeUrl</C>{t(' est posé sur un 402 (plan_feature_unavailable, plan_limit_reached) : la page où l’offre se change.', ' is set on a 402 (plan_feature_unavailable, plan_limit_reached): the page where the plan is changed.')}</li>
        </Liste>
      </Section>

      <Section id="webhook" titre={t('Vérifier un webhook', 'Verifying a webhook')}>
        <p>
          {t('Passez le corps BRUT, tel que reçu : la signature porte sur ses octets. Le format est décrit dans ', 'Pass the RAW body, as received: the signature covers its bytes. The format is described in ')}
          <LienDoc page="webhooks" ancre="signature">{t('Webhooks sortants', 'Outgoing webhooks')}</LienDoc>.
        </p>
        <Bloc legende="TypeScript">{WEBHOOK}</Bloc>
        <Liste>
          <li>{t('Pendant une rotation de secret, l’ancien signe encore 24 h : passez les deux, secret: [nouveau, ancien].', 'During a secret rotation, the old one keeps signing for 24 h: pass both, secret: [new, old].')}</li>
          <li>{t('Un horodatage à plus de 5 minutes est refusé (toleranceSeconds pour changer).', 'A timestamp more than 5 minutes away is refused (toleranceSeconds to change it).')}</li>
          <li>{t('Un même événement peut arriver deux fois (réessai, rejeu) : dédoublonnez par event.id, égal à l’en-tête webhook-id.', 'The same event can arrive twice (retry, replay): deduplicate by event.id, equal to the webhook-id header.')}</li>
        </Liste>
        <Encadre sorte="obligatoire">
          {t(
            'Un secret vide ou illisible lève une TypeError : c’est une erreur de configuration, pas une signature fausse. Ne la transformez pas en 401.',
            'An empty or unreadable secret throws a TypeError: it is a configuration error, not a wrong signature. Do not turn it into a 401.',
          )}
        </Encadre>
      </Section>
    </>
  );
}
