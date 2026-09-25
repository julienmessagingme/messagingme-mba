'use client';

import Link from 'next/link';
import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { ADRESSE_API, Bloc, CLE_EXEMPLE, EnTetePage, LienDoc, Section, Sous, curl, json } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import type { Session } from '@/lib/session';
import { pageDoc, type CleDePage } from '@/lib/doc-api-pages';
import { EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * L'ACCUEIL DE LA DOCUMENTATION DE L'API : une phrase, l'adresse, la clé, un premier appel complet, et les
 * portes vers le reste. C'est l'adresse publiée sur la vitrine (`site/index.html`) : elle ne bouge pas.
 *
 * Tout le détail vit dans les pages de `@/lib/doc-api-pages`. Le cadre (public ou console) est `CadreDoc`.
 */
export default function ApiDocsPage() {
  return <CadreDoc page="accueil">{(session) => <Accueil session={session} />}</CadreDoc>;
}

/** Les quatre portes de l'accueil, chacune avec ce qu'on y trouve. */
const CARTES: ReadonlyArray<{ page: CleDePage; quoi: readonly [string, string] }> = [
  { page: 'contacts', quoi: ['Créer, lire, retrouver et modifier des fiches.', 'Create, read, find and update records.'] },
  { page: 'messages', quoi: ['Un message à une personne, ou un envoi vers une liste de destinataires.', 'One message to one person, or a send to a list of recipients.'] },
  { page: 'catalogs', quoi: ['Les templates, scénarios et messages RCS que vous pouvez envoyer.', 'The templates, scenarios and RCS messages you can send.'] },
  { page: 'events', quoi: ['Ce que la console remonte vers vos outils.', 'What the console sends back to your tools.'] },
];

function Accueil({ session }: { session: Session | null }) {
  const t = useT();
  return (
    <>
      <EnTetePage page="accueil">
        <p>
          {t(
            'Une API REST pour gérer vos contacts et envoyer des messages WhatsApp ou RCS depuis vos applications.',
            'A REST API to manage your contacts and send WhatsApp or RCS messages from your applications.',
          )}
        </p>
        {session ? (
          <p>
            <Link href="/developers/keys" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
              {t('Gérer les clés', 'Manage keys')}
            </Link>
          </p>
        ) : (
          <p className="text-sm text-ink-500">
            {t(
              'Les clés se créent dans la console, menu Developers > Clés d’API, avec un compte administrateur.',
              'Keys are created in the console, under Developers > API keys, with an admin account.',
            )}
          </p>
        )}
      </EnTetePage>

      <Section id="adresse" titre={t('Adresse de base', 'Base URL')}>
        <p>{t('Toutes les routes sont sous :', 'All routes live under:')}</p>
        <Bloc>{`${ADRESSE_API}/v1`}</Bloc>
      </Section>

      <Section id="authentification" titre={t('Authentification', 'Authentication')}>
        <p>
          {t(
            'Chaque appel porte sa clé dans l’en-tête Authorization :',
            'Every call carries its key in the Authorization header:',
          )}
        </p>
        <Bloc>{`Authorization: Bearer ${CLE_EXEMPLE}`}</Bloc>
        <p className="text-sm text-ink-500">
          {t('Les droits d’une clé et les refus :', 'A key’s scopes and refusals:')}{' '}
          <LienDoc page="reference" ancre="authentification">{t('Authentification et droits', 'Authentication and scopes')}</LienDoc>.
        </p>
      </Section>

      <Section id="premier-appel" titre={t('Premier appel', 'First call')}>
        <p>{t('Créer une fiche, ou la mettre à jour si elle existe :', 'Create a record, or update it if it exists:')}</p>
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/contacts', EXEMPLES_CORPS.contactCreer.corps)}</Bloc>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactEcrit)}</Bloc>
        <p className="text-sm text-ink-500">
          {t('Le détail de cette route :', 'The details of this route:')}{' '}
          <LienDoc page="contacts" ancre="creer">POST /v1/contacts</LienDoc>.
        </p>
      </Section>

      <Section titre={t('La suite', 'Next')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {CARTES.map((c) => (
            <Link
              key={c.page}
              href={pageDoc(c.page).href}
              className="group rounded-xl border border-ink-200 bg-white p-4 transition hover:border-brand-300 hover:shadow-mm-sm"
            >
              <h3 className="font-semibold text-ink-900 group-hover:text-brand-700">{t(...pageDoc(c.page).nav)}</h3>
              <p className="mt-1 text-sm text-ink-600">{t(c.quoi[0], c.quoi[1])}</p>
            </Link>
          ))}
        </div>
        <ul className="space-y-1.5 text-sm">
          <li>
            <LienDoc page="concepts">{t(...pageDoc('concepts').nav)}</LienDoc>
            {t(
              ' : désigner une personne, consentement et STOP, fenêtre de 24 h, idempotence.',
              ': identifying a person, consent and STOP, 24-hour window, idempotency.',
            )}
          </li>
          <li>
            <LienDoc page="reference">{t(...pageDoc('reference').nav)}</LienDoc>
            {t(' : authentification et droits, débit, erreurs.', ': authentication and scopes, rate limit, errors.')}
          </li>
          <li>
            <LienDoc page="per-contact">{t(...pageDoc('per-contact').titre)}</LienDoc>
            {t(' : le guide, étape par étape.', ': the step-by-step guide.')}
          </li>
        </ul>
      </Section>
    </>
  );
}
