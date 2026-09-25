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
            'Pour un outil (orchestration, CRM, marketing) qui appelle une fois par contact, avec un corps rempli par le profil. Six étapes ; les étapes 3 à 5 se règlent une fois.',
            'For a tool (orchestration, CRM, marketing) that calls once per contact, with a body filled from the profile. Six steps; steps 3 to 5 are set up once.',
          )}
        </p>
      </EnTetePage>

      <Etape n={1} titre={t('L’adresse et l’en-tête', 'The URL and the header')}>
        <Bloc legende={t('Adresse', 'URL')}>{`POST ${ADRESSE_API}/v1/sends`}</Bloc>
        <p>{t('En-tête identique pour tous les contacts ; clé avec le droit sends:create :', 'Same header for every contact; key with the sends:create scope:')}</p>
        <Bloc legende={t('En-tête', 'Header')}>{`Authorization: Bearer ${CLE_EXEMPLE}`}</Bloc>
      </Etape>

      <Etape n={2} titre={t('Le corps', 'The body')}>
        <p>
          {t(
            'Un destinataire par appel : externalId et numéro. L’externalId reste sur la fiche et la retrouve aux appels suivants.',
            'One recipient per call: externalId and phone number. The externalId stays on the record and finds it on later calls.',
          )}
        </p>
        <Bloc legende={t('Corps', 'Body')}>{json(EXEMPLES_CORPS.outilParContact.corps)}</Bloc>
      </Etape>

      <Etape n={3} id="cle" titre={t('La clé d’idempotence', 'The idempotency key')}>
        <p>
          {t(
            'Dans le corps (idempotencyKey), rempli contact par contact. Composition : identifiant du contact, plus ce qui rend ce passage unique (étape, date d’entrée dans le parcours).',
            'In the body (idempotencyKey), filled per contact. Composition: contact id, plus whatever makes this pass unique (step, journey entry date).',
          )}
        </p>
        <Encadre sorte="attention">
          <p>
            {t(
              'Clé faite du seul identifiant du contact : un second passage légitime est pris pour un rejeu, et ne part pas.',
              'Key built from the contact id alone: a second legitimate pass is taken for a replay, and does not go out.',
            )}
          </p>
        </Encadre>
        <p className="text-sm text-ink-500">
          <LienDoc page="concepts" ancre="idempotence">{t('Idempotence', 'Idempotency')}</LienDoc>
        </p>
      </Etape>

      <Etape n={4} titre={t('Le consentement', 'Consent')}>
        <p>
          {t(
            'consent et consentSource à chaque appel, depuis l’outil qui tient le consentement.',
            'consent and consentSource on every call, from the tool that holds the consent.',
          )}{' '}
          <LienDoc page="concepts" ancre="consentement">{t('Consentement et STOP', 'Consent and STOP')}</LienDoc>.
        </p>
      </Etape>

      <Etape n={5} titre={t('Les variables', 'Variables')}>
        <p>
          {t(
            'variables : les valeurs propres à ce contact (numéro de commande, produit). Rien n’est écrit sur la fiche.',
            'variables: the values specific to this contact (order number, product). Nothing is written on the record.',
          )}
        </p>
      </Etape>

      <Etape n={6} titre={t('Éprouver l’appel', 'Try the call')}>
        <p>
          {t(
            'Un refus se lit dans la réponse 201 (destinataire écarté) ou dans le code d’erreur (cible introuvable). Outil qui ne lit pas les réponses : un appel à la main d’abord.',
            'A refusal shows in the 201 response (skipped recipient) or in the error code (target not found). Tool that does not read responses: one call by hand first.',
          )}
        </p>
        <Bloc legende={t('Commande', 'Command')}>{curl('/v1/sends', EXEMPLES_CORPS.outilParContact.corps)}</Bloc>
        <p className="text-sm text-ink-500">
          <LienDoc page="sends" ancre="envoi">POST /v1/sends</LienDoc>
          {' · '}
          <LienDoc page="reference" ancre="erreurs">{t('Erreurs', 'Errors')}</LienDoc>
        </p>
      </Etape>
    </>
  );
}
