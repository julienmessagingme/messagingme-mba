'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Code, Encadre, EnTetePage, LienDoc, Liste, Section, Tableau } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, EXEMPLES_CORPS } from '@/lib/api-exemples';

/**
 * LES RÈGLES TRANSVERSALES, CHACUNE À UN SEUL ENDROIT : désigner une personne, le consentement et STOP, la
 * fenêtre de 24 h, l'idempotence. Les pages de routes y renvoient par une ancre (`@/lib/doc-api-pages`) au lieu
 * de les répéter : une règle écrite deux fois finit par se contredire.
 */
export default function ApiConceptsPage() {
  return <CadreDoc page="concepts">{() => <Concepts />}</CadreDoc>;
}

function Concepts() {
  const t = useT();
  return (
    <>
      <EnTetePage page="concepts">
        <p>
          {t(
            'Les règles communes à plusieurs routes. Les pages de routes y renvoient.',
            'The rules shared by several routes. The route pages link here.',
          )}
        </p>
      </EnTetePage>

      <Section id="identification" titre={t('Désigner une personne', 'Identifying a person')}>
        <p>
          {t(
            'Une personne est une fiche. Vous la désignez par ce que vous avez, et ces clés ne servent qu’à la trouver :',
            'A person is a record. You designate it with whatever you have, and these keys only serve to find it:',
          )}
        </p>
        <Tableau
          entetes={[t('Clé', 'Key'), t('Ce que c’est', 'What it is')]}
          lignes={[
            { cle: 'contactId', cellules: [<C key="k">contactId</C>, t('L’identifiant de la fiche, créé avec elle. Il s’affiche sur la fiche du mini-CRM (« Identifiant API », avec un bouton Copier).', 'The record id, created with it. It shows on the mini-CRM record (“API identifier”, with a Copy button).')] },
            { cle: 'externalId', cellules: [<C key="k">externalId</C>, t(`L’identifiant de la personne dans votre outil (CRM, plateforme marketing), gardé sur la fiche. Unique par espace, ${BORNES.externalId} caractères au plus.`, `The person’s id in your tool (CRM, marketing platform), kept on the record. Unique per workspace, ${BORNES.externalId} characters at most.`)] },
            { cle: 'phone', cellules: [<C key="k">phone</C>, t('Le numéro, au format international (+33…). Un numéro sans indicatif est lu comme français.', 'The phone number, in international format (+33…). A number without a country code is read as French.')] },
            { cle: 'bsuid', cellules: [<C key="k">bsuid</C>, t('L’identifiant WhatsApp d’une personne qui écrit sous un nom d’utilisateur, sans numéro visible.', 'The WhatsApp id of a person writing under a username, with no visible number.')] },
          ]}
        />
        <Liste>
          <li>{t('Au moins une clé, sinon', 'At least one key, otherwise')} <Code c="invalid_recipient" /> ; {t('un numéro illisible :', 'an unreadable number:')} <Code c="invalid_phone" />.</li>
          <li>
            {t('Toutes les clés données désignent la même fiche, sinon', 'All the keys given must designate the same record, otherwise')}{' '}
            <Code c="identity_conflict" /> {t('et la fiche n’est pas modifiée.', 'and the record is not changed.')}
          </li>
          <li>
            {t(
              'Une clé que la fiche ne porte pas encore lui est rattachée : envoyer votre externalId avec le numéro suffit à le poser. contactId, lui, ne se rattache jamais : il existe, ou il est inconnu.',
              'A key the record does not carry yet is attached to it: sending your externalId along with the phone number is enough to set it. contactId is never attached: it exists, or it is unknown.',
            )}
          </li>
          <li>
            {t(
              'Aucune fiche trouvée : elle est créée seulement si la route crée, et si un phone ou un bsuid est donné. Sinon',
              'No record found: one is created only if the route creates records, and only if a phone or a bsuid is given. Otherwise',
            )}{' '}
            <Code c="unknown_contact" />.
          </li>
        </Liste>
        <Encadre sorte="note">
          <p>
            {t(
              'L’adresse d’envoi vient toujours de la fiche, jamais de la clé reçue : en WhatsApp, le numéro, sinon le BSUID ; en RCS, le numéro, toujours (une fiche sans numéro est refusée en',
              'The sending address always comes from the record, never from the key received: on WhatsApp, the phone number, otherwise the BSUID; on RCS, the phone number, always (a record without a number is refused with',
            )}{' '}
            <Code c="no_phone" />).
          </p>
        </Encadre>
      </Section>

      <Section id="consentement" titre={t('Consentement et STOP', 'Consent and STOP')}>
        <p>
          {t(
            'consent : opted_in ou opted_out, absent = inchangé. opted_out est un vrai désabonnement (statut, date, trace dans le journal d’audit). consentSource dit d’où vient le consentement.',
            'consent: opted_in or opted_out, absent = unchanged. opted_out is a real opt-out (status, date, audit log entry). consentSource says where the consent comes from.',
          )}
        </p>
        <Encadre sorte="attention">
          <p>
            {t('opted_in ne lève jamais un STOP : sur une fiche désabonnée, 409', 'opted_in never lifts a STOP: on an opted-out record, 409')}{' '}
            <Code c="opted_out" />
            {t(
              ', et rien n’est modifié ; seul un opérateur ou la personne elle-même peut la réabonner.',
              ', and nothing is changed; only an operator or the person themselves can re-subscribe them.',
            )}
          </p>
        </Encadre>
        <p>
          {t(
            'Dans un envoi (POST /v1/sends), consent se donne par destinataire : il est écrit sur la fiche avant le tri, avec le même sens que sur /v1/contacts. Un opted_out désabonne et écarte ce destinataire. consentSource absent vaut api.',
            'In a send (POST /v1/sends), consent is given per recipient: it is written on the record before filtering, with the same meaning as on /v1/contacts. An opted_out opts the record out and skips this recipient. A missing consentSource defaults to api.',
          )}
        </p>
        <p>
          {t('Ce que la catégorie d’un envoi exige (marketing ou utility) :', 'What a send’s category requires (marketing or utility):')}{' '}
          <LienDoc page="messages" ancre="categorie">{t('Catégorie, numéro, débit', 'Category, number, throughput')}</LienDoc>
          {t(' ; ce qu’exige un message RCS :', '; what an RCS message requires:')}{' '}
          <LienDoc page="messages" ancre="message-rcs">POST /v1/messages/rcs</LienDoc>.
        </p>
      </Section>

      <Section id="fenetre-24h" titre={t('La fenêtre de 24 h', 'The 24-hour window')}>
        <p>
          {t(
            'La fenêtre de 24 h est une règle de Meta : elle s’ouvre quand la personne vous écrit et se referme 24 h après son dernier message. Hors fenêtre, le seul chemin est un template (POST /v1/sends).',
            'The 24-hour window is a Meta rule: it opens when the person writes to you and closes 24 hours after their last message. Outside it, the only path is a template (POST /v1/sends).',
          )}
        </p>
        <p>
          {t('Où elle compte :', 'Where it applies:')}{' '}
          <LienDoc page="messages" ancre="message-whatsapp">POST /v1/messages/whatsapp</LienDoc>
          {t(', et un envoi qui ouvre par un message de session (', ', and a send that opens with a session message (')}
          <LienDoc page="messages" ancre="ouverture">{t('ce qu’un scénario ou un bloc envoie en premier', 'what a scenario or a block sends first')}</LienDoc>
          {t('). Fermée :', '). Closed:')} <Code c="window_closed" />. {t('Le RCS n’en a pas.', 'RCS has none.')}
        </p>
      </Section>

      <Section id="idempotence" titre={t('Idempotence', 'Idempotency')}>
        <p>
          {t('Seul un envoi (POST /v1/sends) porte une clé d’idempotence ; les messages simples n’en ont pas (', 'Only a send (POST /v1/sends) carries an idempotency key; plain messages have none (')}
          <LienDoc page="messages" ancre="messages-simples">{t('Messages simples', 'Plain messages')}</LienDoc>).
        </p>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'La clé est obligatoire, en en-tête (Idempotency-Key) ou dans le corps (idempotencyKey). Sans clé : 400',
              'The key is required, as a header (Idempotency-Key) or in the body (idempotencyKey). No key: 400',
            )}{' '}
            <Code c="idempotency_key_required" />.
          </p>
        </Encadre>
        <Bloc legende={t('En-tête', 'Header')}>{`Idempotency-Key: ${EXEMPLES_CORPS.envoiTemplate.corps.idempotencyKey}`}</Bloc>
        <Liste>
          <li>
            {t('Les deux présentes et différentes : 400', 'Both present and different: 400')} <Code c="invalid_body" />.
          </li>
          <li>
            {t(
              'La même clé avec le même corps rend le rapport du premier appel sans rien renvoyer : un nouvel essai réseau est sans danger. La même clé avec un autre corps : 422',
              'The same key with the same body returns the first call’s report without sending anything again: a network retry is safe. The same key with a different body: 422',
            )}{' '}
            <Code c="idempotency_key_reused" />. {t('Pendant que le premier appel s’exécute : 409', 'While the first call is running: 409')}{' '}
            <Code c="idempotency_in_progress" />.
          </li>
          <li>
            {t(
              `Une clé vit ${BORNES.dureeIdempotenceHeures} h (parfois un peu plus, jamais moins).`,
              `A key lives ${BORNES.dureeIdempotenceHeures} h (sometimes a little longer, never less).`,
            )}
          </li>
        </Liste>
        <p className="text-sm text-ink-500">
          {t('Composer la clé quand un outil appelle une fois par contact :', 'Building the key when a tool calls once per contact:')}{' '}
          <LienDoc page="per-contact" ancre="cle">{t('La clé d’idempotence', 'The idempotency key')}</LienDoc>.
        </p>
      </Section>
    </>
  );
}
