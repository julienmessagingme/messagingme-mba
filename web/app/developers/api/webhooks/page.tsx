'use client';

import Link from 'next/link';
import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Encadre, EnTetePage, Liste, Section, Tableau } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { TYPES_DOCUMENTES } from '@/lib/evenements-dictionnaire';

/**
 * LES WEBHOOKS SORTANTS (lot 12) : l'enveloppe, la signature, les réessais et chaque type. Les types et leurs champs
 * sont tenus au contrat du serveur (`src/evenements/types.ts`) par `tests/web-evenements-parite.test.ts`.
 */
export default function ApiWebhooksPage() {
  return <CadreDoc page="webhooks">{() => <Contenu />}</CadreDoc>;
}

/** L'enveloppe d'exemple : un objet sérialisé, jamais du JSON écrit à la main (`tests/api-exemples.test.ts`). */
const ENVELOPPE = JSON.stringify({
  id: 'evt_5f0c2b9e8d7a4c1b9e3f6a2d4c8b1e07',
  type: 'message.received',
  created_at: '2026-10-08T14:03:11.000Z',
  workspace_id: '3f2a9c1e-…',
  data: {
    contact: { id: '8b1e07c4-…', phone: '+33612345678', name: 'Claire', external_id: null, opted_out: { whatsapp: false, rcs: false } },
    channel: 'whatsapp',
    message_id: 'wamid.…',
    message_type: 'text',
    text: 'Bonjour, où en est ma commande ?',
    transcription: null,
    button: null,
  },
}, null, 2);

/** La réponse de l'application à `conversation.needs_reply`, sérialisée elle aussi. */
const REPONSE = JSON.stringify({ contactId: '8b1e07c4-…', text: 'Bonjour Claire, votre commande part demain.' }, null, 2);

const VERIFICATION = [
  "import crypto from 'node:crypto';",
  '',
  '// Le corps BRUT reçu (une chaîne), jamais l’objet déjà analysé : la signature porte sur ces octets-là.',
  'export function verifier(corpsBrut, entetes, secret = process.env.MESSAGINGME_WEBHOOK_SECRET) {',
  "  const id = entetes['webhook-id'];",
  "  const horodatage = entetes['webhook-timestamp'];",
  '  // Refuser un envoi de plus de 5 minutes : un rejeu d’un message intercepté ne passe pas.',
  '  if (Math.abs(Date.now() / 1000 - Number(horodatage)) > 300) return false;',
  "  const cle = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');",
  "  const attendue = crypto.createHmac('sha256', cle).update(id + '.' + horodatage + '.' + corpsBrut).digest('base64');",
  "  // Plusieurs signatures pendant une rotation du secret, séparées par une espace : une seule suffit.",
  "  return entetes['webhook-signature'].split(' ').some((s) => {",
  "    const [version, valeur] = s.split(',');",
  "    return version === 'v1' && valeur.length === attendue.length",
  '      && crypto.timingSafeEqual(Buffer.from(valeur), Buffer.from(attendue));',
  '  });',
  '}',
].join('\n');

function Contenu() {
  const t = useT();
  return (
    <>
      <EnTetePage page="webhooks">
        <p>
          {t(
            'Votre application reçoit en direct ce qui se passe sur WhatsApp : chaque événement part en POST vers l’adresse que vous inscrivez, signé et horodaté. Les adresses se gèrent dans ',
            'Your app receives what happens on WhatsApp as it happens: each event is POSTed to the address you register, signed and timestamped. Addresses are managed in ',
          )}
          <Link href="/developers/evenements" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
            {t('Developers > Webhooks sortants', 'Developers > Outgoing webhooks')}
          </Link>
          {t(', ou depuis Claude Code par l’outil MCP create_webhook_endpoint.', ', or from Claude Code with the create_webhook_endpoint MCP tool.')}
        </p>
      </EnTetePage>

      <Section id="enveloppe" titre={t('L’enveloppe', 'The envelope')}>
        <p>{t('Le même format pour tous les événements : seul data change selon type.', 'The same format for every event: only data changes with type.')}</p>
        <Bloc legende={t('Corps reçu', 'Received body')}>{ENVELOPPE}</Bloc>
        <Liste>
          <li>{t('id est stable : le même au réessai et au rejeu. Gardez les id déjà traités pour ignorer un doublon (la livraison est « au moins une fois »).', 'id is stable: the same on retry and replay. Keep processed ids to ignore a duplicate (delivery is “at least once”).')}</li>
          <li>{t('Aucun ordre n’est garanti entre deux événements : un message lu peut arriver avant le message livré.', 'No ordering is guaranteed between two events: a read message may arrive before the delivered one.')}</li>
          <li>{t('Le contenu est figé au moment de l’événement : un réessai renvoie exactement le même corps.', 'The content is frozen when the event happens: a retry sends exactly the same body.')}</li>
        </Liste>
      </Section>

      <Section id="signature" titre={t('Vérifier la signature', 'Verifying the signature')}>
        <p>
          {t('Le format est celui de Standard Webhooks : trois en-têtes, ', 'The format is Standard Webhooks: three headers, ')}
          <C>webhook-id</C>, <C>webhook-timestamp</C>, <C>webhook-signature</C>
          {t(', et une signature HMAC-SHA256 de ', ', and an HMAC-SHA256 signature of ')}<C>id.timestamp.corps</C>
          {t(' avec la clé qui suit whsec_ dans votre secret. Les bibliothèques Standard Webhooks de tous les langages la vérifient telles quelles.', ' with the key after whsec_ in your secret. Standard Webhooks libraries in every language verify it as is.')}
        </p>
        <Bloc legende={t('Vérification en Node.js', 'Verification in Node.js')}>{VERIFICATION}</Bloc>
        <Encadre sorte="obligatoire">
          {t(
            'Rangez le secret dans une variable d’environnement de votre application, jamais dans le code ni dans un fichier suivi par git. Il n’est montré qu’une fois ; un secret perdu se renouvelle (l’ancien signe encore 24 h).',
            'Store the secret in an environment variable of your app, never in the code nor in a file tracked by git. It is shown only once; a lost secret is rotated (the old one keeps signing for 24 h).',
          )}
        </Encadre>
      </Section>

      <Section id="reessais" titre={t('Réponse et réessais', 'Response and retries')}>
        <Liste>
          <li>{t('Répondez 2xx dans les 10 secondes : l’événement est livré. Traitez le travail long après avoir répondu.', 'Answer 2xx within 10 seconds: the event is delivered. Do long work after answering.')}</li>
          <li>{t('Toute autre réponse, ou aucune, fait réessayer : 30 s, 2 min, 10 min, 30 min, puis toutes les heures, pendant 24 h.', 'Any other answer, or none, triggers a retry: 30 s, 2 min, 10 min, 30 min, then hourly, for 24 h.')}</li>
          <li>{t('410 Gone arrête les réessais de cet événement. Les redirections ne sont pas suivies.', '410 Gone stops retrying that event. Redirects are not followed.')}</li>
          <li>{t('Chaque envoi se lit dans le journal de l’adresse (corps envoyé, réponse, tentatives) et se rejoue d’un clic.', 'Each delivery is visible in the address log (body sent, response, attempts) and can be replayed in one click.')}</li>
        </Liste>
      </Section>

      <Section id="types" titre={t('Les événements', 'The events')}>
        <p>{t('Chaque adresse choisit ses types. Les accusés de livraison sont décochés par défaut : une campagne en produit jusqu’à trois par destinataire.', 'Each address picks its types. Delivery receipts are unchecked by default: a campaign produces up to three per recipient.')}</p>
        <Tableau
          entetes={[t('Type', 'Type'), t('Quand', 'When'), t('Champs de data', 'data fields')]}
          lignes={TYPES_DOCUMENTES.map((d) => ({
            cle: d.type,
            cellules: [
              <C key="t">{d.type}</C>,
              <span key="q">{t(d.quand[0], d.quand[1])}{d.decocheParDefaut ? ` ${t('(décoché par défaut)', '(unchecked by default)')}` : ''}</span>,
              <span key="c" className="font-mono text-xs">{d.champs.join(', ')}</span>,
            ],
          }))}
        />
        <p>{t('Le contact porte son id, son numéro (phone), son nom, son identifiant externe et ses désabonnements.', 'The contact carries its id, number (phone), name, external id and opt-outs.')}</p>
      </Section>

      <Section id="repondre" titre={t('Mon application répond', 'My app answers')}>
        <p>
          {t(
            'Désignez une adresse dans « Qui répond au client » (Accueil), ou par l’outil MCP set_default_responder en mode application : chaque message que personne ne tient lui arrive en ',
            'Pick an address in “Who answers the customer” (Home), or with the set_default_responder MCP tool in application mode: each message nobody handles reaches it as ',
          )}
          <C>conversation.needs_reply</C>
          {t(', sans abonnement à cocher, devant les autres envois. Votre application répond par l’API, avec la clé d’API de l’espace :', ', with no type to check, ahead of other deliveries. Your app answers through the API, with the workspace API key:')}
        </p>
        <Bloc legende="POST /v1/messages/whatsapp">{REPONSE}</Bloc>
        <Liste>
          <li>{t('Répondez 2xx tout de suite au webhook, puis envoyez la réponse : la conversation reste à votre application, hors de la file « À traiter » de l’équipe.', 'Answer the webhook 2xx right away, then send the reply: the conversation stays with your app, out of the team’s “To handle” queue.')}</li>
          <li>{t('La fenêtre de 24 h s’applique : la réponse part tant que le client a écrit dans les 24 dernières heures.', 'The 24-hour window applies: the reply goes out as long as the customer wrote in the last 24 hours.')}</li>
          <li>{t('Répondez à conversation.needs_reply seulement : si l’adresse reçoit aussi message.received, le même message y arrive deux fois, et une réponse aux deux partirait deux fois. La clé d’API doit porter le droit sends:create.', 'Answer conversation.needs_reply only: if the address also receives message.received, the same message arrives twice, and answering both would reply twice. The API key needs the sends:create scope.')}</li>
          <li>{t('Ces réponses ne comptent pas dans le quota quotidien d’envois de l’API ; le plafond par minute s’applique.', 'These replies do not count toward the API daily send quota; the per-minute cap applies.')}</li>
          <li>{t('Aucun repli : si votre application ne répond pas, personne ne le fait à sa place. Une adresse en pause, supprimée ou au-delà de votre offre rend les messages à l’équipe.', 'No fallback: if your app does not answer, nobody does in its place. A paused or deleted address, or one beyond your plan, hands the messages back to the team.')}</li>
        </Liste>
      </Section>
    </>
  );
}
