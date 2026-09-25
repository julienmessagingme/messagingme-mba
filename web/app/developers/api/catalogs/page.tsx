'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  Bloc, C, Encadre, EnTetePage, LienDoc, Liste, Refus, Route, Sous, SurCettePage, Tableau, curlGet, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * LES TROIS LECTURES QUI SERVENT À CONSTRUIRE UN ENVOI sans ouvrir la console. Sans corps, donc sans tableau de
 * champs : chaque route montre sa commande, sa réponse et le sens de ses champs.
 */
export default function ApiCataloguesPage() {
  return <CadreDoc page="catalogs">{() => <Catalogues />}</CadreDoc>;
}

function Catalogues() {
  const t = useT();
  const commande = t('Commande', 'Command');
  const reponse = t('Réponse 200', '200 response');
  const entetes = [t('Champ', 'Field'), t('Sens', 'Meaning')];
  return (
    <>
      <EnTetePage page="catalogs">
        <p>
          {t(
            'Ce qu’un envoi (POST /v1/sends) peut faire partir. Chaque template et message RCS listé est envoyable ; un scénario le dit par opening.',
            'What a send (POST /v1/sends) can deliver. Every listed template and RCS message is sendable; a scenario says so through opening.',
          )}
        </p>
      </EnTetePage>
      <SurCettePage page="catalogs" />

      <Route ep="GET /v1/templates">
        <Bloc legende={commande}>{curlGet('/v1/templates')}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.templates)}</Bloc>
        <Tableau
          entetes={entetes}
          lignes={[
            {
              cle: 'variables',
              cellules: [
                <C key="c">variables</C>,
                t(
                  'Une entrée par variable du corps, donc par entrée attendue dans params. source : le champ associé dans la console, à recopier tel quel dans params ; null sinon.',
                  'One entry per body variable, hence per entry expected in params. source: the field associated in the console, to copy as is into params; null otherwise.',
                ),
              ],
            },
            { cle: 'header', cellules: [<C key="c">header</C>, t('Type d’en-tête. Carrousel : none (visuels par carte).', 'Header type. Carousel: none (visuals per card).')] },
          ]}
        />
        <p>{t('Absents de la liste, car un envoi ou Meta les refuserait :', 'Left out, because a send or Meta would refuse them:')}</p>
        <Liste>
          <li>{t('catégorie autre que marketing ou utility ;', 'category other than marketing or utility;')}</li>
          <li>{t('en-tête de localisation, ou en-tête texte à variable ;', 'location header, or text header with a variable;')}</li>
          <li>{t('bouton de lien à variable dans l’adresse (hors liens de suivi des clics de la console) ;', 'link button with a variable in its URL (except the console’s click-tracking links);')}</li>
          <li>{t('carrousel dont une carte ou un lien porte une variable ;', 'carousel whose card or link carries a variable;')}</li>
          <li>{t('visuel d’en-tête ou de carte illisible par la console.', 'header or card visual the console cannot read back.')}</li>
        </Liste>
        <Encadre sorte="note">
          <p>
            {t('Lecture en direct chez Meta : une panne rend une erreur, jamais une liste vide.', 'Live read at Meta: an outage returns an error, never an empty list.')}{' '}
            <LienDoc page="reference" ancre="erreurs">{t('Erreurs', 'Errors')}</LienDoc>
          </p>
        </Encadre>
      </Route>

      <Route ep="GET /v1/scenarios">
        <Bloc legende={commande}>{curlGet('/v1/scenarios')}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.scenarios)}</Bloc>
        <Tableau
          entetes={entetes}
          lignes={[
            {
              cle: 'opening',
              cellules: [
                <C key="c">opening</C>,
                <span key="s">
                  {t(
                    'Même règle que POST /v1/sends. rcs ou whatsapp_template : cible scenario (code ou nom). whatsapp_session : cible node sur entryNode. null : aucune des deux ; un autre bloc du scénario, en cible node, est jugé pour lui-même.',
                    'Same rule as POST /v1/sends. rcs or whatsapp_template: scenario target (code or name). whatsapp_session: node target on entryNode. null: neither; another block of the scenario, as a node target, is judged on its own.',
                  )}{' '}
                  <LienDoc page="sends" ancre="ouverture">{t('Message d’ouverture', 'Opening message')}</LienDoc>
                </span>,
              ],
            },
            {
              cle: 'openingTemplate',
              cellules: [
                <C key="c">openingTemplate</C>,
                <span key="s">
                  {t(
                    'Ouverture whatsapp_template : le template que params paramètre ; null sinon. Ses variables : GET /v1/templates, même nom et même langue. Autre nombre dans params :',
                    'whatsapp_template opening: the template that params parameterizes; null otherwise. Its variables: GET /v1/templates, same name and language. Other count in params:',
                  )}{' '}
                  <Refus c="unsendable_target" />.
                </span>,
              ],
            },
            {
              cle: 'entryNode',
              cellules: [
                <C key="c">entryNode</C>,
                t(
                  'Code nod_ du bloc d’entrée, pour une cible node : même ouverture que le scénario. Seul chemin d’une ouverture whatsapp_session. null si le bloc n’a pas de code public.',
                  'nod_ code of the entry block, for a node target: same opening as the scenario. Only path for a whatsapp_session opening. null if the block has no public code.',
                ),
              ],
            },
            { cle: 'publishedAt', cellules: [<C key="c">publishedAt</C>, t('null pour un scénario publié avant que cette date soit enregistrée.', 'null for a scenario published before this date was recorded.')] },
          ]}
        />
      </Route>

      <Route ep="GET /v1/rcs-messages">
        <Bloc legende={commande}>{curlGet('/v1/rcs-messages')}</Bloc>
        <Sous>{reponse}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.messagesRcs)}</Bloc>
        <Tableau
          entetes={entetes}
          lignes={[
            { cle: 'name', cellules: [<C key="c">name</C>, t('Valeur de la cible rcsMessage.', 'Value of the rcsMessage target.')] },
            { cle: 'kind', cellules: [<C key="c">kind</C>, <span key="k"><C>text</C>, <C>card</C>{t(' ou ', ' or ')}<C>carousel</C>.</span>] },
            { cle: 'variables', cellules: [<C key="c">variables</C>, t('Noms entre doubles accolades utilisés par le message.', 'Names between double braces used by the message.')] },
          ]}
        />
      </Route>
    </>
  );
}
