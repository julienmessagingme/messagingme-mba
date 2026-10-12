'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Code, Encadre, EnTetePage, LienDoc, Liste, Section, Sous, SousSous, json } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { CODES_DOCUMENTES, EXEMPLES_REPONSES } from '@/lib/api-exemples';
import { GESTES } from '@/lib/erreurs-gestes';
import { ERREURS_META, GROUPES_ERREURS_META, ancreErreurMeta } from '@/lib/erreurs-meta';

/**
 * LE CATALOGUE DES ERREURS (lot 17) : chacun de nos codes, avec son statut, quand il arrive et le geste qui le règle ;
 * puis les erreurs de Meta qui nous concernent. Une ancre par code (`#window_closed`, `#meta-131047`), que les autres
 * pages visent par `LienErreur`.
 *
 * Les codes viennent de `CODES_DOCUMENTES` (tenu égal à la table du serveur), leurs gestes de `GESTES` (un `Record` sur
 * tous les codes), les erreurs de Meta de `ERREURS_META` (tenu par `tests/doc-erreurs-meta.test.ts`). Rien n'est écrit
 * ici à la main, sauf l'introduction.
 */
export default function ApiErreursPage() {
  return <CadreDoc page="errors">{() => <Catalogue />}</CadreDoc>;
}

function Catalogue() {
  const t = useT();
  return (
    <>
      <EnTetePage page="errors">
        <p>
          {t(
            'Toute réponse d’erreur de l’API porte un corps JSON avec error, une phrase en français pour un humain, et code, un identifiant stable pour un programme. Branchez-vous sur code, jamais sur la phrase.',
            'Every error response of the API carries a JSON body with error, a French sentence for a human, and code, a stable identifier for a program. Rely on code, never on the sentence.',
          )}
        </p>
      </EnTetePage>

      <Section id="forme" titre={t('La forme d’une erreur', 'The shape of an error')}>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.erreur)}</Bloc>
        <Liste>
          <li>
            <C>metaCode</C>
            {t(
              ' : sur meta_rejected seulement, le numéro d’erreur de Meta (voir plus bas), ou null quand Meta n’en donne pas.',
              ': on meta_rejected only, Meta’s error number (see below), or null when Meta gives none.',
            )}
          </li>
          <li>
            <C>upgradeUrl</C>
            {t(' : sur un 402, la page où l’offre de l’espace se change.', ': on a 402, the page where the workspace plan is changed.')}
          </li>
          <li>
            <C>retry-after</C>
            {t(' : sur un 429, l’en-tête qui dit combien de secondes attendre.', ': on a 429, the header that says how many seconds to wait.')}
          </li>
        </Liste>
        <Encadre sorte="attention">
          <p>
            {t(
              'Un 5xx peut arriver sans ce corps : une page d’erreur générique le remplace parfois en chemin. Traitez-le comme internal_error : réessayez avec un délai qui grandit, et rejouez un envoi avec la même clé d’idempotence.',
              'A 5xx may arrive without this body: a generic error page sometimes replaces it on the way. Treat it as internal_error: retry with a growing delay, and replay a send with the same idempotency key.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section id="codes" titre={t('Les codes de l’API', 'API codes')}>
        <p>
          {t(
            'Un même refus porte le même code partout. Certains arrivent aussi en motif d’écart d’un destinataire de ',
            'A given refusal carries the same code everywhere. Some also come as the skip reason of a recipient of ',
          )}
          <LienDoc page="sends" ancre="envoi">POST /v1/sends</LienDoc>
          {t(' : l’envoi part pour les autres.', ': the send goes out for the others.')}
        </p>
        {CODES_DOCUMENTES.map((c) => (
          <div key={c.code} className="space-y-1.5">
            <Sous id={c.code}>
              <Code c={c.code} testid={`catalogue-${c.code}`} />
              <span className="ml-2 text-sm font-normal text-ink-500">
                {c.statut === null ? t('motif d’écart seulement', 'skip reason only') : String(c.statut)}
                {c.statut !== null && c.ecart ? t(', aussi motif d’écart', ', also a skip reason') : ''}
              </span>
            </Sous>
            <p>{t(c.quoi[0], c.quoi[1])}</p>
            <p>
              <span className="font-semibold">{t('Que faire : ', 'What to do: ')}</span>
              {t(GESTES[c.code][0], GESTES[c.code][1])}
            </p>
          </div>
        ))}
      </Section>

      <Section id="meta" titre={t('Les erreurs de Meta', 'Meta errors')}>
        <p>
          {t(
            'Meta refuse parfois un message pour une raison qui lui est propre. Son numéro d’erreur arrive à quatre endroits :',
            'Meta sometimes refuses a message for a reason of its own. Its error number arrives in four places:',
          )}
        </p>
        <Liste>
          <li><C>metaCode</C>{t(' d’un refus 422 meta_rejected, quand Meta refuse sur le moment ;', ' of a 422 meta_rejected refusal, when Meta refuses on the spot;')}</li>
          <li><C>data.meta_code</C>{t(' de l’événement message.failed, quand le message échoue après être parti ;', ' of the message.failed event, when the message fails after it went out;')}</li>
          <li><C>error.code</C>{t(' d’un message lu par GET /v1/messages/{messageId} ;', ' of a message read with GET /v1/messages/{messageId};')}</li>
          <li><C>error.metaCode</C>{t(' d’un destinataire dans le suivi d’un envoi (GET /v1/sends/{sendId}).', ' of a recipient in a send’s follow-up (GET /v1/sends/{sendId}).')}</li>
        </Liste>
        <p className="text-sm text-ink-500">
          {t(
            'Les codes ci-dessous sont ceux qui concernent un espace Messaging Me. La liste complète est dans la documentation de la Cloud API de Meta.',
            'The codes below are the ones that concern a Messaging Me workspace. The full list is in Meta’s Cloud API documentation.',
          )}
        </p>
        {GROUPES_ERREURS_META.map((g) => (
          <div key={g.cle} className="space-y-4">
            <Sous>{t(g.titre[0], g.titre[1])}</Sous>
            {ERREURS_META.filter((e) => e.groupe === g.cle).map((e) => (
              <div key={e.code} className="space-y-1.5">
                <SousSous id={ancreErreurMeta(e.code)}><C>{String(e.code)}</C></SousSous>
                <p>{t(e.sens[0], e.sens[1])}</p>
                <p>
                  <span className="font-semibold">{t('Que faire : ', 'What to do: ')}</span>
                  {t(e.geste[0], e.geste[1])}
                </p>
                {'chezNous' in e && (
                  <p className="text-sm text-ink-500">
                    <span className="font-semibold">{t('Ce que Messaging Me fait déjà : ', 'What Messaging Me already does: ')}</span>
                    {t(e.chezNous[0], e.chezNous[1])}
                  </p>
                )}
              </div>
            ))}
          </div>
        ))}
      </Section>
    </>
  );
}
