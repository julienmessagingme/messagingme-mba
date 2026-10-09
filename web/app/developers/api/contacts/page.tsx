'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  ADRESSE_API, Bloc, C, CLE_EXEMPLE, Champs, EnTetePage, Erreurs, LienDoc, Liste, Route, Sous, SurCettePage, Tableau, curl,
  curlGet, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';
import { CHAMPS } from '@/lib/api-champs';

/**
 * La recette d'import d'un fichier (décision de Julien du 2026-10-09) : pas de route d'import, le lot reste à
 * `BORNES.contactsParLot` (plus gros, il garderait la place lourde de l'API, partagée avec les envois de tous les
 * clients) ; un fichier s'envoie donc en lots, et un 429 se rejoue après Retry-After.
 */
const RECETTE_FICHIER = `import { readFileSync } from 'node:fs';

const lignes = readFileSync('contacts.csv', 'utf8').trim().split(/\\r?\\n/).slice(1);
const fiches = lignes.map((l) => { const [phone, name] = l.split(','); return { phone, name }; });

for (let i = 0; i < fiches.length; ) {
  const r = await fetch('${ADRESSE_API}/v1/contacts/batch', {
    method: 'POST',
    headers: { authorization: 'Bearer ${CLE_EXEMPLE}', 'content-type': 'application/json' },
    body: JSON.stringify({ contacts: fiches.slice(i, i + ${BORNES.contactsParLot}) }),
  });
  if (r.status === 429) {
    await new Promise((ok) => setTimeout(ok, Number(r.headers.get('retry-after') ?? 2) * 1000));
    continue;
  }
  if (!r.ok) throw new Error(await r.text());
  const { results } = await r.json();
  for (const e of results.filter((x) => x.status === 'error')) console.log(i + e.index, e.code, e.reason);
  i += ${BORNES.contactsParLot};
}`;

/**
 * LES CINQ ROUTES DES FICHES, chacune sur le patron de `Route` : phrase et droit (tirés de l'index des endpoints),
 * champs (`@/lib/api-champs`, tenus égaux au schéma du serveur), commande, réponse, erreurs propres, peu de notes.
 * Les règles communes (désigner une personne, le consentement) vivent dans Concepts : on y renvoie.
 */
export default function ApiContactsPage() {
  return <CadreDoc page="contacts">{() => <Contacts />}</CadreDoc>;
}

const ID_FICHE = EXEMPLES_REPONSES.contactLu.contactId;

function Contacts() {
  const t = useT();
  const requete = t('Requête', 'Request');
  const commande = t('Commande', 'Command');
  const reponse = t('Réponse 200', '200 response');
  const erreurs = t('Erreurs', 'Errors');
  const notes = t('Notes', 'Notes');
  return (
    <>
      <EnTetePage page="contacts">
        <p>
          {t('Une fiche se désigne par ses clés :', 'A record is designated by its keys:')}{' '}
          <LienDoc page="concepts" ancre="identification">{t('Désigner une personne', 'Identifying a person')}</LienDoc>.
        </p>
      </EnTetePage>
      <SurCettePage page="contacts" />

      <Route ep="POST /v1/contacts">
        <Sous>{requete}</Sous>
        <Champs table={CHAMPS.contact} />
        <Bloc legende={commande}>{curl('/v1/contacts', EXEMPLES_CORPS.contactCreer.corps)}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactEcrit)}</Bloc>
        <p>{t('status : created ou updated. Le statut HTTP est 200 dans les deux cas.', 'status: created or updated. The HTTP status is 200 in both cases.')}</p>
        <Sous>{erreurs}</Sous>
        <Erreurs
          clesDeFiche
          lignes={[
            ['invalid_body', t('Champ mal formé ou refusé, trop de champs ou de tags, champ ou tag inconnu de l’espace ; le message le nomme.', 'Malformed or refused field, too many fields or tags, field or tag unknown to the workspace; the message names it.')],
            ['unknown_contact', t('Aucune fiche trouvée, et ni phone ni bsuid pour en créer une (un externalId seul, par exemple).', 'No record found, and neither phone nor bsuid to create one (an externalId alone, for instance).')],
            ['opted_out', t('consent opted_in sur une fiche désabonnée. Rien n’est modifié.', 'consent opted_in on an opted-out record. Nothing is changed.')],
          ]}
        />
      </Route>

      <Route ep="POST /v1/contacts/batch">
        <Sous>{requete}</Sous>
        <Champs table={CHAMPS.lot} />
        <Bloc legende={commande}>{curl('/v1/contacts/batch', EXEMPLES_CORPS.contactsLot.corps)}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactsLot)}</Bloc>
        <Tableau
          entetes={[t('Champ', 'Field'), t('Sens', 'Meaning')]}
          lignes={[
            { cle: 'results', cellules: [<C key="c">results</C>, t('Un résultat par élément, dans l’ordre : index, status (created, updated ou error), et pour un refus code et reason.', 'One result per item, in order: index, status (created, updated or error), and for a refusal code and reason.')] },
            { cle: 'compteurs', cellules: [<span key="c"><C>created</C>, <C>updated</C>, <C>errors</C></span>, t('Le nombre de résultats de chaque status.', 'The number of results with each status.')] },
          ]}
        />
        <Sous>{erreurs}</Sous>
        <Erreurs lignes={[['invalid_body', t('contacts absent, vide, ou trop long.', 'contacts missing, empty, or too long.')]]} />
        <Sous>{notes}</Sous>
        <Liste>
          <li>{t('Un élément refusé (mal formé, trop de champs ou de tags, champ ou tag inconnu) n’arrête pas les autres.', 'A refused item (malformed, too many fields or tags, unknown field or tag) does not stop the others.')}</li>
          <li>{t('Les éléments qui désignent la même personne s’écrivent dans l’ordre du lot.', 'Items that designate the same person are written in the order of the list.')}</li>
          <li data-testid="doc-import-fichier">
            {t(
              `Importer un fichier : envoyez-le par lots de ${BORNES.contactsParLot}, comme ci-dessous (un module : fichier .mjs). Aux plafonds par défaut, ${BORNES.contactsParLot * BORNES.plafondEspaceMinute} fiches par minute, ${BORNES.contactsParLot * BORNES.plafondEspaceHeure} par heure et ${BORNES.quotaFichesJour} par jour. Un 429 n’a rien écrit : attendez Retry-After (jusqu’à minuit pour le quota du jour) et renvoyez le même lot. Un très gros fichier passe plus vite par l’import CSV de la console.`,
              `Importing a file: send it in batches of ${BORNES.contactsParLot}, as below (a module: .mjs file). At the default limits, ${BORNES.contactsParLot * BORNES.plafondEspaceMinute} records per minute, ${BORNES.contactsParLot * BORNES.plafondEspaceHeure} per hour and ${BORNES.quotaFichesJour} per day. A 429 wrote nothing: wait for Retry-After (until midnight for the daily quota) and send the same records again. A very large file goes faster through the console’s CSV import.`,
            )}
          </li>
        </Liste>
        <Bloc legende={t('Importer un CSV simple (phone,name), Node.js', 'Importing a simple CSV (phone,name), Node.js')}>{RECETTE_FICHIER}</Bloc>
      </Route>

      <Route ep="GET /v1/contacts/{contactId}">
        <Sous>{requete}</Sous>
        <p>{t('contactId, dans le chemin.', 'contactId, in the path.')}</p>
        <Bloc legende={commande}>{curlGet(`/v1/contacts/${ID_FICHE}`)}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactLu)}</Bloc>
        <Tableau
          entetes={[t('Champ', 'Field'), t('Sens', 'Meaning')]}
          lignes={[
            { cle: 'consent', cellules: [<C key="c">consent</C>, t('status : opted_in, opted_out ou unknown. source : son origine. optedOutAt : date du désabonnement.', 'status: opted_in, opted_out or unknown. source: its origin. optedOutAt: opt-out date.')] },
            { cle: 'rcs', cellules: [<C key="c">rcsOptedOutAt</C>, t('Date d’un STOP sur le canal RCS, sinon null.', 'Date of a STOP on the RCS channel, otherwise null.')] },
            { cle: 'blocked', cellules: [<C key="c">blocked</C>, t('true : un message vers la fiche est refusé, un envoi l’écarte.', 'true: a message to the record is refused, a send skips it.')] },
            { cle: 'reachability', cellules: [<C key="c">reachability</C>, t('true ou false quand un envoi l’a appris, null sinon.', 'true or false when a send has learned it, null otherwise.')] },
          ]}
        />
        {/* LE RISQUE DE DÉSENGAGEMENT (lot 7, spec § 19). Les codes sont écrits EN CLAIR, pas tirés d'un module :
            ils forment un contrat que l'intégrateur recopie, et `tests/web-risque-parite.test.ts` vérifie que
            ce paragraphe les cite tous. */}
        <p data-testid="doc-engagement-risk">
          <C>engagementRisk</C>
          {t(
            ' : risque de désengagement, recalculé chaque nuit sur les 90 derniers jours (réponses, clics, lectures, dernière conversation analysée, joignabilité, désabonnement, blocage). null s’il n’a jamais été calculé. level : ',
            ': disengagement risk, recomputed every night over the last 90 days (replies, clicks, reads, last analysed conversation, reachability, unsubscribe, block). null if never computed. level: ',
          )}
          <C>faible</C>{t(' (score 0 à 29), ', ' (score 0 to 29), ')}
          <C>moyen</C>{t(' (30 à 59), ', ' (30 to 59), ')}
          <C>eleve</C>{t(' (60 à 100), ', ' (60 to 100), ')}
          <C>inconnu</C>
          {t(
            ' (score null : aucun message délivré sur la période). Désabonnement ou blocage : eleve, score 100. reasons : 3 codes au plus, du plus lourd au plus léger, parmi ',
            ' (score null: no message delivered over the period). Unsubscribe or block: eleve, score 100. reasons: at most 3 codes, heaviest first, among ',
          )}
          <C>stop</C>, <C>bloque</C>, <C>silence_60j</C>, <C>silence_30j</C>, <C>sans_reponse</C>,{' '}
          <C>non_lu</C>, <C>reclamation</C>, <C>negatif</C>, <C>insatisfait</C>, <C>injoignable</C>
          {t(
            '. computedAt : date du passage à ce niveau ; elle ne change qu’avec le niveau, score et reasons sont toujours à jour.',
            '. computedAt: when the contact reached this level; it only changes with the level, while score and reasons are always current.',
          )}
        </p>
        <p data-testid="doc-last-analysis">
          <C>lastAnalysis</C>
          {t(
            ' : la dernière analyse de conversation du contact, recopiée sur sa fiche ; elle reste là quand la conversation est effacée. null s’il n’a jamais été analysé. Lecture seule : envoyée dans un POST ou un PATCH, elle est ignorée. intent : ',
            ': the contact’s latest conversation analysis, copied onto the record; it stays when the conversation is deleted. null if never analysed. Read-only: ignored when sent in a POST or a PATCH. intent: ',
          )}
          <C>demande_devis</C>, <C>sav</C>, <C>reclamation</C>, <C>information</C>, <C>prise_rdv</C>, <C>achat</C>,{' '}
          <C>suivi_commande</C>, <C>retour</C>, <C>autre</C>
          {t('. sentiment : ', '. sentiment: ')}
          <C>positif</C>, <C>neutre</C>, <C>negatif</C>
          {t(
            '. satisfaction et urgency : de 0 à 10, null quand l’analyse n’a pas pu les mesurer (0 est une vraie mesure). resolved : la conversation est-elle résolue. topic : son sujet, en clair. handledBy : ',
            '. satisfaction and urgency: from 0 to 10, null when the analysis could not measure them (0 is a real measure). resolved: whether the conversation is resolved. topic: its subject, in plain words. handledBy: ',
          )}
          <C>humain</C>, <C>automatise</C>, <C>mba</C>
          {t('. actionSuggestion : ', '. actionSuggestion: ')}
          <C>creer_devis</C>, <C>rappeler</C>, <C>relancer</C>, <C>escalader</C>, <C>aucune</C>
          {t(
            '. analyzedAt : la date de l’analyse. Le résumé de la conversation n’en fait pas partie : il reprend les propos du client.',
            '. analyzedAt: when the analysis ran. The conversation summary is not included: it quotes what the customer said.',
          )}
        </p>
        <Sous>{erreurs}</Sous>
        <Erreurs lignes={[['unknown_contact', t('Fiche inconnue ou supprimée.', 'Unknown or deleted record.')]]} />
      </Route>

      <Route ep="POST /v1/contacts/search">
        <Sous>{requete}</Sous>
        <Champs table={CHAMPS.recherche} />
        <Bloc legende={commande}>{curl('/v1/contacts/search', EXEMPLES_CORPS.contactRechercher.corps)}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactTrouve)}</Bloc>
        <p>
          {t(
            'contact : la fiche, sous la forme de GET /v1/contacts/{contactId}, ou null. Rien n’est créé ni rattaché.',
            'contact: the record, in the shape of GET /v1/contacts/{contactId}, or null. Nothing is created or attached.',
          )}
        </p>
        <Sous>{erreurs}</Sous>
        <Erreurs
          lignes={[
            ['invalid_body', t('Aucune clé, ou plusieurs.', 'No key, or several.')],
            ['invalid_phone', t('Numéro illisible.', 'Unreadable phone number.')],
          ]}
        />
      </Route>

      <Route ep="PATCH /v1/contacts/{contactId}">
        <Sous>{requete}</Sous>
        <p>{t('contactId, dans le chemin. Corps : au moins un champ.', 'contactId, in the path. Body: at least one field.')}</p>
        <Champs table={CHAMPS.modification} />
        <Bloc legende={commande}>{curl(`/v1/contacts/${ID_FICHE}`, EXEMPLES_CORPS.contactModifier.corps, 'PATCH')}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.contactModifie)}</Bloc>
        <Sous>{erreurs}</Sous>
        <Erreurs
          lignes={[
            ['invalid_body', t('Rien à modifier, trop de champs ou de tags, champ ou tag à ajouter inconnu de l’espace, ou valeur refusée.', 'Nothing to change, too many fields or tags, field or tag to add unknown to the workspace, or refused value.')],
            ['unknown_contact', t('Fiche inconnue.', 'Unknown record.')],
            ['identity_conflict', t('externalId déjà porté par une autre fiche.', 'externalId already carried by another record.')],
            ['opted_out', t('consent opted_in sur une fiche désabonnée.', 'consent opted_in on an opted-out record.')],
          ]}
        />
      </Route>

      <Route ep="DELETE /v1/contacts/{contactId}">
        <p>
          {t(
            'Avec le droit contacts:admin. Irréversible : la fiche, ses conversations, ses messages et son analyse sont effacés ; ce qui porte les compteurs est anonymisé. Dans la limite du jour de l’offre (10 en Free, sans limite en Pro et Entreprise). Une fiche désabonnée (STOP) laisse une empreinte de son numéro, illisible sans notre clé, gardée trois ans après le STOP : recréée, elle naît désabonnée.',
            'With the contacts:admin scope. Irreversible: the record, its conversations, messages and analysis are erased; what carries the counters is anonymised. Within the plan’s daily limit (10 on Free, unlimited on Pro and Enterprise). An opted-out record (STOP) leaves a fingerprint of its number, unreadable without our key, kept three years after the STOP: recreated, it is born opted out.',
          )}
        </p>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.ficheEffacee)}</Bloc>
        <Sous>{erreurs}</Sous>
        <Erreurs
          lignes={[
            ['unknown_contact', t('Fiche inconnue de cet espace, ou déjà effacée (la limite du jour n’est pas entamée).', 'Record unknown to this workspace, or already erased (the daily limit is not used).')],
            ['plan_limit_reached', t('Limite d’effacements du jour de l’offre atteinte.', 'The plan’s daily erase limit is reached.')],
            ['rate_limited', t('Trop d’opérations lourdes sur cet espace (10 par minute, comme la purge de la console) : réessayer après Retry-After.', 'Too many heavy operations on this workspace (10 per minute, like the console purge): retry after Retry-After.')],
          ]}
        />
      </Route>

      <Route ep="GET /v1/fields">
        <Bloc legende={commande}>{curlGet('/v1/fields')}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.champs)}</Bloc>
        <p>{t('key est la clé à utiliser dans fields d’une fiche ; type : text, number, date, datetime, boolean ou url.', 'key is the key to use in a record’s fields; type: text, number, date, datetime, boolean or url.')}</p>
      </Route>

      <Route ep="POST /v1/fields">
        <Bloc legende={commande}>{curl('/v1/fields', EXEMPLES_CORPS.champCree.corps)}</Bloc>
        <Sous>{t('Réponse 201', '201 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.champCree)}</Bloc>
        <p>{t('La clé vient du libellé (minuscules, sans accents, _ entre les mots) et ne change plus. Renommer ou supprimer un champ se fait dans la console.', 'The key comes from the label (lowercase, no accents, _ between words) and never changes. Renaming or deleting a field is done in the console.')}</p>
        <Sous>{erreurs}</Sous>
        <Erreurs
          lignes={[
            ['invalid_body', t('Libellé vide ou trop long (100), type inconnu.', 'Empty or too long label (100), unknown type.')],
            ['field_exists', t('Un champ porte déjà cette clé, ou c’est le libellé d’un champ de base (Nom, Téléphone…).', 'A field already has this key, or it is a base field’s label (Name, Phone…).')],
          ]}
        />
      </Route>
    </>
  );
}
