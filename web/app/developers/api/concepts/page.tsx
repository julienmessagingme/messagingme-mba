'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Code, Encadre, EnTetePage, LienDoc, Liste, Refus, Section, Tableau } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, EXEMPLES_CORPS } from '@/lib/api-exemples';

/**
 * LES RÈGLES TRANSVERSALES, CHACUNE À UN SEUL ENDROIT : désigner une personne (et quelle route crée une fiche),
 * le consentement et STOP, la fenêtre de 24 h, l'idempotence. Les pages de routes y renvoient par une ancre
 * (`@/lib/doc-api-pages`) au lieu de les répéter : une règle écrite deux fois finit par se contredire.
 */
export default function ApiConceptsPage() {
  return <CadreDoc page="concepts">{() => <Concepts />}</CadreDoc>;
}

function Concepts() {
  const t = useT();
  return (
    <>
      <EnTetePage page="concepts">
        <p>{t('Les règles communes à plusieurs routes.', 'The rules shared by several routes.')}</p>
      </EnTetePage>

      <Section id="identification" titre={t('Désigner une personne', 'Identifying a person')}>
        <p>{t('Une personne est une fiche. Quatre clés la désignent :', 'A person is a record. Four keys designate it:')}</p>
        <Tableau
          entetes={[t('Clé', 'Key'), t('Ce que c’est', 'What it is')]}
          lignes={[
            { cle: 'contactId', cellules: [<C key="k">contactId</C>, t('Identifiant de la fiche, créé avec elle. Affiché sur la fiche du mini-CRM (« Identifiant API », bouton Copier).', 'Record id, created with it. Shown on the mini-CRM record (“API identifier”, Copy button).')] },
            { cle: 'externalId', cellules: [<C key="k">externalId</C>, t(`Identifiant de la personne dans votre outil (CRM, plateforme marketing), gardé sur la fiche. Unique par espace, ${BORNES.externalId} caractères au plus.`, `The person’s id in your tool (CRM, marketing platform), kept on the record. Unique per workspace, ${BORNES.externalId} characters at most.`)] },
            { cle: 'phone', cellules: [<C key="k">phone</C>, t('Numéro au format international (+33…). Sans indicatif : lu comme français.', 'Phone number in international format (+33…). Without a country code: read as French.')] },
            { cle: 'bsuid', cellules: [<C key="k">bsuid</C>, t('Identifiant WhatsApp d’une personne qui écrit sous un nom d’utilisateur, sans numéro visible.', 'WhatsApp id of a person writing under a username, with no visible number.')] },
          ]}
        />
        <Liste>
          <li>{t('Au moins une clé, sinon', 'At least one key, otherwise')} <Code c="invalid_recipient" />{t('. Numéro illisible :', '. Unreadable number:')} <Code c="invalid_phone" />.</li>
          <li>
            {t('Toutes les clés données désignent la même fiche, sinon', 'All the keys given designate the same record, otherwise')}{' '}
            <Code c="identity_conflict" />{t(' et rien n’est modifié.', ' and nothing is changed.')}
          </li>
          <li>
            {t(
              'Une clé que la fiche ne porte pas encore lui est rattachée : un externalId envoyé avec le numéro se pose sur la fiche.',
              'A key the record does not carry yet is attached to it: an externalId sent with the phone number is set on the record.',
            )}
          </li>
          <li>{t('contactId ne se rattache jamais : il existe, ou il est inconnu.', 'contactId is never attached: it exists, or it is unknown.')}</li>
        </Liste>
        <Tableau
          entetes={[t('Route', 'Route'), t('Aucune fiche ne correspond', 'No record matches')]}
          lignes={[
            { cle: 'contacts', cellules: ['POST /v1/contacts, POST /v1/contacts/batch', t('Fiche créée avec un phone ou un bsuid.', 'Record created with a phone or a bsuid.')] },
            { cle: 'sends', cellules: ['POST /v1/sends', t('Fiche créée avec un phone, sauf ouverture whatsapp_session.', 'Record created with a phone, except with a whatsapp_session opening.')] },
            { cle: 'autres', cellules: [t('Autres routes', 'Other routes'), t('Aucune création.', 'Nothing created.')] },
          ]}
        />
        <p>{t('Pas de création possible :', 'No creation possible:')} <Code c="unknown_contact" />.</p>
        <Encadre sorte="note">
          <p>
            {t(
              'L’adresse d’envoi vient de la fiche, jamais de la clé reçue. WhatsApp : le numéro, sinon le BSUID. RCS : le numéro (fiche sans numéro :',
              'The sending address comes from the record, never from the key received. WhatsApp: the phone number, otherwise the BSUID. RCS: the phone number (record without one:',
            )}{' '}
            <Code c="no_phone" />).
          </p>
        </Encadre>
      </Section>

      <Section id="consentement" titre={t('Consentement et STOP', 'Consent and STOP')}>
        <Tableau
          entetes={[t('Champ', 'Field'), t('Effet', 'Effect')]}
          lignes={[
            { cle: 'in', cellules: [<span key="c"><C>consent</C> = <C>opted_in</C></span>, t('Enregistre le consentement.', 'Records the consent.')] },
            { cle: 'out', cellules: [<span key="c"><C>consent</C> = <C>opted_out</C></span>, t('Désabonne : statut, date, ligne au journal d’audit.', 'Opts out: status, date, audit log entry.')] },
            { cle: 'absent', cellules: [<span key="c"><C>consent</C> {t('absent', 'missing')}</span>, t('Aucun changement.', 'No change.')] },
            { cle: 'source', cellules: [<C key="c">consentSource</C>, t('Origine du consentement. Absent : api.', 'Origin of the consent. Missing: api.')] },
          ]}
        />
        <Encadre sorte="attention">
          <p>
            {t('opted_in ne lève jamais un STOP : sur une fiche désabonnée,', 'opted_in never lifts a STOP: on an opted-out record,')}{' '}<Refus c="opted_out" />
            {t(
              ', rien n’est modifié. Seuls un opérateur ou la personne elle-même peuvent la réabonner.',
              ', nothing is changed. Only an operator or the person themselves can re-subscribe them.',
            )}
          </p>
        </Encadre>
        <Liste>
          <li>
            {t(
              'POST /v1/sends : consent par destinataire, même effet, écrit sur la fiche avant le tri. opted_out écarte le destinataire.',
              'POST /v1/sends: consent per recipient, same effect, written on the record before filtering. opted_out skips the recipient.',
            )}
          </li>
          <li>
            {t('Exigences d’une catégorie d’envoi :', 'Requirements of a send category:')}{' '}
            <LienDoc page="sends" ancre="categorie">{t('Catégorie', 'Category')}</LienDoc>
            {t(' ; d’un message RCS :', '; of an RCS message:')}{' '}
            <LienDoc page="messages" ancre="message-rcs">POST /v1/messages/rcs</LienDoc>.
          </li>
        </Liste>
      </Section>

      <Section id="fenetre-24h" titre={t('La fenêtre de 24 h', 'The 24-hour window')}>
        <Liste>
          <li>{t('Règle de Meta : s’ouvre quand la personne écrit, se ferme 24 h après son dernier message.', 'Meta rule: opens when the person writes, closes 24 hours after their last message.')}</li>
          <li>{t('Hors fenêtre, seul un template peut partir (POST /v1/sends).', 'Outside the window, only a template can go out (POST /v1/sends).')}</li>
          <li>
            {t('S’applique à', 'Applies to')} <LienDoc page="messages" ancre="message-whatsapp">POST /v1/messages/whatsapp</LienDoc>
            {t(' et aux envois qui ouvrent en whatsapp_session (', ' and to sends opening with whatsapp_session (')}
            <LienDoc page="sends" ancre="ouverture">{t('Message d’ouverture', 'Opening message')}</LienDoc>
            {t('). Fermée :', '). Closed:')} <Code c="window_closed" />.
          </li>
          <li>{t('Pas de fenêtre en RCS.', 'No window over RCS.')}</li>
        </Liste>
      </Section>

      <Section id="idempotence" titre={t('Idempotence', 'Idempotency')}>
        <p>
          {t('Seul POST /v1/sends porte une clé d’idempotence. Les messages n’en ont pas (', 'Only POST /v1/sends carries an idempotency key. Messages have none (')}
          <LienDoc page="messages" ancre="messages-simples">{t('Message ou envoi', 'Message or send')}</LienDoc>).
        </p>
        <Encadre sorte="obligatoire">
          <p>
            {t('Clé obligatoire : en-tête Idempotency-Key ou champ idempotencyKey. Absente :', 'Key required: Idempotency-Key header or idempotencyKey field. Missing:')}{' '}<Refus c="idempotency_key_required" />.
          </p>
        </Encadre>
        <Bloc legende={t('En-tête', 'Header')}>{`Idempotency-Key: ${EXEMPLES_CORPS.envoiTemplate.corps.idempotencyKey}`}</Bloc>
        <Tableau
          entetes={[t('Cas', 'Case'), t('Réponse', 'Response')]}
          lignes={[
            { cle: 'rejeu', cellules: [t('Même clé, même corps', 'Same key, same body'), t('Le rapport 201 du premier appel, tel quel, même si la cible a changé depuis. Rien n’est renvoyé.', 'The first call’s 201 report, as is, even if the target has changed since. Nothing is sent again.')] },
            { cle: 'autre', cellules: [t('Même clé, autre corps', 'Same key, different body'), <span key="r"><Refus c="idempotency_key_reused" /></span>] },
            { cle: 'cours', cellules: [t('Premier appel encore en cours', 'First call still running'), <span key="r"><Refus c="idempotency_in_progress" /></span>] },
            { cle: 'deux', cellules: [t('En-tête et champ présents et différents', 'Header and field present and different'), <span key="r"><Refus c="invalid_body" /></span>] },
            { cle: 'refus', cellules: [t('Envoi refusé (cible introuvable, numéro absent…)', 'Send refused (target not found, number missing…)'), t('Clé libérée : l’appel corrigé repart avec la même.', 'Key released: the fixed call goes out with the same one.')] },
          ]}
        />
        <p>
          {t(
            `Durée de vie d’une clé : ${BORNES.dureeIdempotenceHeures} h au moins.`,
            `Key lifetime: at least ${BORNES.dureeIdempotenceHeures} h.`,
          )}{' '}
          {t('Composer la clé pour un outil qui appelle par contact :', 'Building the key for a tool that calls per contact:')}{' '}
          <LienDoc page="per-contact" ancre="cle">{t('La clé d’idempotence', 'The idempotency key')}</LienDoc>.
        </p>
      </Section>
    </>
  );
}
