'use client';

import Link from 'next/link';
import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  ADRESSE_API, Bloc, CLE_EXEMPLE, EnTetePage, IndexEndpoints, LienDoc, Section, curl, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import type { Session } from '@/lib/session';
import { EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * L'ACCUEIL DE LA DOCUMENTATION DE L'API : une phrase, le premier appel complet AVANT toute explication, l'index
 * de tous les endpoints (`@/lib/api-doc-endpoints`), puis l'adresse et la clé. Court par construction : le détail
 * vit dans les pages de `@/lib/doc-api-pages`. C'est l'adresse publiée sur la vitrine (`site/index.html`) : elle
 * ne bouge pas. Le cadre (public ou console) est `CadreDoc`, qui renvoie aussi les ancres de l'ancienne page
 * unique vers leur nouvelle adresse.
 */
export default function ApiDocsPage() {
  return <CadreDoc page="accueil">{(session) => <Accueil session={session} />}</CadreDoc>;
}

function Accueil({ session }: { session: Session | null }) {
  const t = useT();
  return (
    <>
      <EnTetePage page="accueil">
        <p>{t('API REST : contacts, messages WhatsApp et RCS, envois.', 'REST API: contacts, WhatsApp and RCS messages, sends.')}</p>
      </EnTetePage>

      <Section id="premier-appel" titre={t('Premier appel', 'First call')}>
        <p>{t('Créer une fiche, ou la mettre à jour si elle existe :', 'Create a record, or update it if it exists:')}</p>
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/contacts', EXEMPLES_CORPS.contactCreer.corps)}</Bloc>
        <Bloc legende={t('Réponse 200', '200 response')}>{json(EXEMPLES_REPONSES.contactEcrit)}</Bloc>
        <p className="text-sm text-ink-500">
          {t('Détail :', 'Details:')} <LienDoc page="contacts" ancre="creer">POST /v1/contacts</LienDoc>.
        </p>
      </Section>

      <Section id="endpoints" titre={t('Tous les endpoints', 'All endpoints')}>
        <IndexEndpoints />
      </Section>

      <Section id="adresse" titre={t('Adresse de base', 'Base URL')}>
        <Bloc legende={t('Adresse de base', 'Base URL')}>{`${ADRESSE_API}/v1`}</Bloc>
      </Section>

      <Section id="authentification" titre={t('Authentification', 'Authentication')}>
        <p>{t('Une clé d’API dans l’en-tête Authorization de chaque appel :', 'An API key in the Authorization header of every call:')}</p>
        <Bloc legende={t('En-tête', 'Header')}>{`Authorization: Bearer ${CLE_EXEMPLE}`}</Bloc>
        <p>
          {session ? (
            <Link href="/developers/keys" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
              {t('Gérer les clés', 'Manage keys')}
            </Link>
          ) : (
            t(
              'Les clés se créent dans la console (Developers > Clés d’API), avec un compte administrateur.',
              'Keys are created in the console (Developers > API keys), with an admin account.',
            )
          )}
        </p>
        <p className="text-sm text-ink-500">
          {t('Droits, débit et erreurs :', 'Scopes, rate limit and errors:')}{' '}
          <LienDoc page="reference">{t('Authentification, limites et erreurs', 'Authentication, limits and errors')}</LienDoc>.
        </p>
      </Section>
    </>
  );
}
