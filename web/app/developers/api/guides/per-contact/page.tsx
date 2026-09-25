'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { ADRESSE_API, Bloc, CLE_EXEMPLE, Encadre, EnTetePage, LienDoc, curl, json } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { EXEMPLES_CORPS } from '@/lib/api-exemples';

/**
 * LE GUIDE « UN APPEL PAR CONTACT », EN RECETTE NUMÉROTÉE : l'appel type d'une plateforme d'orchestration, d'un
 * CRM ou d'un outil marketing, qui appelle un service une fois par contact. Les règles qu'il applique vivent
 * dans Concepts ; ici, seulement ce qu'il faut régler dans l'outil.
 */
export default function ApiGuideParContactPage() {
  return <CadreDoc page="per-contact">{() => <Guide />}</CadreDoc>;
}

function Etape({ n, id, titre, children }: { n: number; id?: string; titre: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-4 border-t border-ink-200 pt-8">
      <h2 className="flex items-center gap-3 text-xl font-semibold tracking-tight text-ink-900">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">{n}</span>{' '}
        {titre}
      </h2>
      <div className="space-y-4 text-[15px] leading-relaxed text-ink-700">{children}</div>
    </section>
  );
}

function Guide() {
  const t = useT();
  return (
    <>
      <EnTetePage page="per-contact">
        <p>
          {t(
            'Une plateforme d’orchestration, un CRM ou un outil marketing appelle souvent un service une fois par contact, avec un corps rempli par les données du profil. Voici l’appel type, en six étapes ; les étapes 3 à 5 se règlent une fois.',
            'An orchestration platform, a CRM or a marketing tool often calls a service once per contact, with a body filled from the profile data. Here is the typical call, in six steps; steps 3 to 5 are set up once.',
          )}
        </p>
      </EnTetePage>

      <Etape n={1} titre={t('L’adresse et l’en-tête', 'The URL and the header')}>
        <p>{t('Adresse :', 'URL:')}</p>
        <Bloc>{`POST ${ADRESSE_API}/v1/sends`}</Bloc>
        <p>{t('En-tête, avec le droit sends:create. Il est le même pour tous les contacts :', 'Header, with the sends:create scope. It is the same for every contact:')}</p>
        <Bloc>{`Authorization: Bearer ${CLE_EXEMPLE}`}</Bloc>
      </Etape>

      <Etape n={2} titre={t('Le corps', 'The body')}>
        <p>
          {t(
            'Un destinataire par appel, désigné par votre identifiant (externalId) et son numéro. Nous gardons l’identifiant sur la fiche : c’est lui qui la retrouve aux appels suivants.',
            'One recipient per call, designated by your id (externalId) and their phone number. We keep the id on the record: it is what finds the record on later calls.',
          )}
        </p>
        <Bloc legende="JSON">{json(EXEMPLES_CORPS.outilParContact.corps)}</Bloc>
      </Etape>

      <Etape n={3} id="cle" titre={t('La clé d’idempotence', 'The idempotency key')}>
        <p>
          {t(
            'La clé d’idempotence va dans le corps (idempotencyKey) : beaucoup d’outils remplissent le corps contact par contact, pas les en-têtes. Composez-la de l’identifiant du contact et de ce qui rend ce passage unique (l’étape, la date d’entrée dans le parcours).',
            'The idempotency key goes in the body (idempotencyKey): many tools fill the body per contact, not the headers. Build it from the contact id and whatever makes this pass unique (the step, the journey entry date).',
          )}
        </p>
        <Encadre sorte="attention">
          <p>
            {t(
              'Faite du seul identifiant du contact, elle ferait prendre le second passage légitime d’un même contact pour un rejeu : il ne partirait pas.',
              'Built from the contact id alone, it would make a second legitimate pass of the same contact look like a replay: it would not go out.',
            )}
          </p>
        </Encadre>
        <p className="text-sm text-ink-500">
          {t('Les règles de la clé :', 'The key’s rules:')} <LienDoc page="concepts" ancre="idempotence">{t('Idempotence', 'Idempotency')}</LienDoc>.
        </p>
      </Etape>

      <Etape n={4} titre={t('Le consentement', 'Consent')}>
        <p>
          {t(
            'Le consentement vit souvent dans votre outil : passez-le à chaque appel (consent, consentSource). Ce qu’il fait sur la fiche et sur l’envoi :',
            'Consent often lives in your tool: pass it on every call (consent, consentSource). What it does to the record and to the send:',
          )}{' '}
          <LienDoc page="concepts" ancre="consentement">{t('Consentement et STOP', 'Consent and STOP')}</LienDoc>.
        </p>
      </Etape>

      <Etape n={5} titre={t('Les variables', 'Variables')}>
        <p>
          {t(
            'variables porte ce qui est propre à ce contact (un numéro de commande, un produit). Rien n’en est écrit sur la fiche.',
            'variables carries what is specific to this contact (an order number, a product). None of it is written on the record.',
          )}
        </p>
      </Etape>

      <Etape n={6} titre={t('Éprouver l’appel', 'Try the call')}>
        <p>
          {t(
            'Un refus (destinataire écarté, cible introuvable) se lit dans la réponse 201 ou dans le code d’erreur. Si votre outil ne lit pas les réponses, éprouvez l’appel une fois à la main :',
            'A refusal (skipped recipient, target not found) shows in the 201 response or in the error code. If your tool does not read responses, try the call once by hand:',
          )}
        </p>
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/sends', EXEMPLES_CORPS.outilParContact.corps)}</Bloc>
        <p className="text-sm text-ink-500">
          <LienDoc page="messages" ancre="envoi">POST /v1/sends</LienDoc>
          {' · '}
          <LienDoc page="reference" ancre="erreurs">{t('Erreurs', 'Errors')}</LienDoc>
        </p>
      </Etape>
    </>
  );
}
