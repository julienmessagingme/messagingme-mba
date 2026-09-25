'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, C, Code, EnTetePage, LienDoc, Liste, Route, Sous, json } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * LES CINQ ROUTES DES FICHES. Les règles qui valent pour toutes les routes (désigner une personne, le
 * consentement) vivent dans Concepts : on y renvoie, on ne les répète pas.
 */
export default function ApiContactsPage() {
  return <CadreDoc page="contacts">{() => <Contacts />}</CadreDoc>;
}

function Contacts() {
  const t = useT();
  return (
    <>
      <EnTetePage page="contacts">
        <p>
          {t('Les cinq routes des fiches. Une fiche se désigne par ses clés :', 'The five record routes. A record is designated by its keys:')}{' '}
          <LienDoc page="concepts" ancre="identification">{t('Désigner une personne', 'Identifying a person')}</LienDoc>.
        </p>
      </EnTetePage>

      <Route id="creer" methode="POST" chemin="/v1/contacts" droit="contacts:write">
        <Sous>{t('Requête', 'Request')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_CORPS.contactCreer.corps)}</Bloc>
        <Liste>
          <li>
            {t(
              'La fiche se trouve par les règles de',
              'The record is found by the rules of',
            )}{' '}
            <LienDoc page="concepts" ancre="identification">{t('Désigner une personne', 'Identifying a person')}</LienDoc>
            {t(
              ', et cette route crée : une fiche neuve exige phone ou bsuid.',
              ', and this route creates records: a new record requires phone or bsuid.',
            )}
          </li>
          <li>{t('fields : adressés par clé technique ou par code fld_. Un champ inconnu est créé en texte.', 'fields: addressed by technical key or by fld_ code. An unknown field is created as text.')}</li>
          <li>{t('tags : ils s’ajoutent, n’en retirent jamais (pour retirer, PATCH).', 'tags: they are added, never removed (to remove, use PATCH).')}</li>
          <li>
            {t('consent : opted_in ou opted_out, absent = inchangé. Ce que fait chaque valeur :', 'consent: opted_in or opted_out, absent = unchanged. What each value does:')}{' '}
            <LienDoc page="concepts" ancre="consentement">{t('Consentement et STOP', 'Consent and STOP')}</LienDoc>.
          </li>
        </Liste>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactEcrit)}</Bloc>
        <Sous>{t('Erreurs', 'Errors')}</Sous>
        <Liste>
          <li>{t('Un externalId seul et inconnu rend 404', 'An unknown externalId alone returns 404')} <Code c="unknown_contact" />.</li>
          <li>
            {t('consent opted_in sur une fiche désabonnée : 409', 'consent opted_in on an opted-out record: 409')} <Code c="opted_out" />
            {t(', et rien n’est modifié.', ', and nothing is changed.')}
          </li>
        </Liste>
      </Route>

      <Route id="lot" methode="POST" chemin="/v1/contacts/batch" droit="contacts:write">
        <Sous>{t('Requête', 'Request')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_CORPS.contactsLot.corps)}</Bloc>
        <p>
          {t(
            `${BORNES.contactsParLot} fiches au plus par appel, le même corps par élément.`,
            `${BORNES.contactsParLot} records at most per call, the same body per item.`,
          )}
        </p>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactsLot)}</Bloc>
        <p>
          {t(
            'Un élément refusé ne fait pas tomber les autres : chaque résultat porte l’index de son élément, et un refus porte son code et sa raison.',
            'A refused item does not sink the others: each result carries its item’s index, and a refusal carries its code and reason.',
          )}
        </p>
      </Route>

      <Route id="lire" methode="GET" chemin="/v1/contacts/{contactId}" droit="contacts:read">
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactLu)}</Bloc>
        <p>
          {t(
            'reachability : true ou false quand on le sait (un envoi l’a appris), null sinon.',
            'reachability: true or false when known (a send taught us), null otherwise.',
          )}
        </p>
        {/* LE RISQUE DE DÉSENGAGEMENT (lot 7, spec § 19). Les codes sont écrits EN CLAIR, pas tirés d'un module :
            ils forment un contrat que l'intégrateur recopie, et `tests/web-risque-parite.test.ts` vérifie que
            ce paragraphe les cite tous. */}
        <p data-testid="doc-engagement-risk">
          <C>engagementRisk</C>
          {t(
            ' : le risque que la personne se désengage, recalculé chaque nuit à partir des 90 derniers jours (réponses, clics, lectures, dernière conversation analysée, joignabilité, désabonnement, blocage). Il vaut null tant qu’il n’a jamais été calculé. level vaut ',
            ': the risk that the person disengages, recomputed every night from the last 90 days (replies, clicks, reads, last analysed conversation, reachability, unsubscribe, block). It is null as long as it has never been computed. level is ',
          )}
          <C>faible</C>, <C>moyen</C>, <C>eleve</C>
          {t(' (score de 0 à 29, 30 à 59, 60 à 100) ou ', ' (score 0 to 29, 30 to 59, 60 to 100) or ')}
          <C>inconnu</C>
          {t(
            ', toujours avec score null : aucun message ne lui a été délivré sur la période. reasons porte au plus trois codes, du plus lourd au plus léger : ',
            ', always with a null score: no message was delivered to them over the period. reasons carries at most three codes, heaviest first: ',
          )}
          <C>stop</C>, <C>bloque</C>, <C>silence_60j</C>, <C>silence_30j</C>, <C>sans_reponse</C>,{' '}
          <C>non_lu</C>, <C>reclamation</C>, <C>negatif</C>, <C>insatisfait</C>, <C>injoignable</C>
          {t(
            '. Un désabonnement ou un blocage donne eleve à 100. computedAt est la date à laquelle le contact est passé à ce niveau : le calcul repasse chaque nuit, mais cette date ne bouge que si le niveau change (le score et les raisons, eux, sont toujours à jour).',
            '. An unsubscribe or a block gives eleve at 100. computedAt is when the contact reached this level: the computation runs every night, but this date only moves when the level changes (score and reasons are always current).',
          )}
        </p>
        <Sous>{t('Erreurs', 'Errors')}</Sous>
        <p>{t('Une fiche inconnue ou supprimée rend 404', 'An unknown or deleted record returns 404')} <Code c="unknown_contact" />.</p>
      </Route>

      <Route id="rechercher" methode="POST" chemin="/v1/contacts/search" droit="contacts:read">
        <Sous>{t('Requête', 'Request')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_CORPS.contactRechercher.corps)}</Bloc>
        <p>
          {t(
            'Exactement une clé parmi phone, bsuid, externalId : c’est une recherche, rien n’est rattaché. Le numéro voyage dans le corps, jamais dans l’adresse, qui s’inscrirait dans les journaux d’accès.',
            'Exactly one key among phone, bsuid, externalId: it is a lookup, nothing is attached. The phone number travels in the body, never in the URL, which would end up in access logs.',
          )}
        </p>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <p>{t('contact vaut null quand rien ne correspond :', 'contact is null when nothing matches:')}</p>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactTrouve)}</Bloc>
      </Route>

      <Route id="modifier" methode="PATCH" chemin="/v1/contacts/{contactId}" droit="contacts:write">
        <Sous>{t('Requête', 'Request')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_CORPS.contactModifier.corps)}</Bloc>
        <Liste>
          <li>{t('Tout est optionnel : name, fields, addTags, removeTags, consent, consentSource, externalId.', 'Everything is optional: name, fields, addTags, removeTags, consent, consentSource, externalId.')}</li>
          <li>{t('Dans fields, une valeur null vide le champ ; les autres se fusionnent.', 'In fields, a null value clears the field; the others are merged.')}</li>
          <li>{t('externalId se pose ou se remplace.', 'externalId is set or replaced.')}</li>
          <li>{t('Le numéro et le BSUID ne se modifient pas ici : ils portent les conversations.', 'The phone number and BSUID cannot be changed here: they carry the conversations.')}</li>
        </Liste>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactModifie)}</Bloc>
        <Sous>{t('Erreurs', 'Errors')}</Sous>
        <p>{t('externalId déjà porté par une autre fiche : 409', 'externalId already carried by another record: 409')} <Code c="identity_conflict" />.</p>
      </Route>
    </>
  );
}
