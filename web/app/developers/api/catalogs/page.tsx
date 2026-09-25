'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import { Bloc, Code, Encadre, EnTetePage, LienDoc, Liste, Route, Sous, json } from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { EXEMPLES_REPONSES } from '@/lib/api-exemples';

/** CE QUE VOUS POUVEZ ENVOYER : les trois lectures qui servent à construire un appel sans ouvrir la console. */
export default function ApiCataloguesPage() {
  return <CadreDoc page="catalogs">{() => <Catalogues />}</CadreDoc>;
}

function Catalogues() {
  const t = useT();
  return (
    <>
      <EnTetePage page="catalogs">
        <p>
          {t(
            'Ce que vous pouvez envoyer. Trois lectures, droit sends:create, pour construire un appel sans ouvrir la console. Chaque template et chaque message RCS listé peut partir par POST /v1/sends ; un scénario listé dit, par opening, s’il le peut et comment.',
            'What you can send. Three reads, sends:create scope, to build a call without opening the console. Every template and every RCS message listed can go out through POST /v1/sends; a listed scenario says, through opening, whether it can and how.',
          )}
        </p>
      </EnTetePage>

      <Route id="templates" methode="GET" chemin="/v1/templates" droit="sends:create">
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.templates)}</Bloc>
        <p>
          {t(
            'Les templates WhatsApp approuvés qu’un envoi sait faire partir. N’y figurent pas ceux qu’un envoi refuserait, ni ceux que Meta refuserait faute d’une valeur que rien ne fournit :',
            'The approved WhatsApp templates a send can deliver. Left out are those a send would refuse, and those Meta would refuse for lack of a value nothing provides:',
          )}
        </p>
        <Liste>
          <li>{t('une catégorie autre que marketing ou utility ;', 'a category other than marketing or utility;')}</li>
          <li>{t('un en-tête de localisation ou un en-tête texte à variable ;', 'a location header or a text header with a variable;')}</li>
          <li>{t('un bouton de lien dont l’adresse porte une variable (hors liens de suivi des clics posés par la console) ;', 'a link button whose URL carries a variable (except the click-tracking links the console sets);')}</li>
          <li>{t('un carrousel dont une carte ou un lien porte une variable ;', 'a carousel whose card or link carries a variable;')}</li>
          <li>{t('un visuel (d’en-tête ou de carte) que nous ne pouvons pas relire.', 'a visual (header or card) we cannot read back.')}</li>
        </Liste>
        <p>
          {t(
            'variables liste chaque variable du corps, donc chaque entrée attendue dans params ; source est le champ que la console lui associe quand elle le connaît (null sinon), et il se recopie tel quel dans params. Un carrousel a ses visuels par carte : son header vaut none.',
            'variables lists each variable of the body, hence each entry expected in params; source is the field the console associates with it when known (null otherwise), and it can be copied as is into params. A carousel has its visuals per card: its header is none.',
          )}
        </p>
        <Encadre sorte="note">
          <p>
            {t('Cette lecture interroge Meta : une panne y rend une erreur, jamais une liste vide.', 'This read queries Meta: an outage returns an error, never an empty list.')}{' '}
            <LienDoc page="reference" ancre="erreurs">{t('Erreurs', 'Errors')}</LienDoc>
          </p>
        </Encadre>
      </Route>

      <Route id="scenarios" methode="GET" chemin="/v1/scenarios" droit="sends:create">
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.scenarios)}</Bloc>
        <Liste>
          <li>
            {t(
              'Les scénarios publiés, qu’ils puissent partir ou non. opening est calculé par la même règle que POST /v1/sends : null, il ne peut partir ni par son code ou son nom, ni par son bloc d’entrée (un autre de ses blocs, visé en cible node, est jugé pour lui-même) ; whatsapp_session, il se vise par son bloc d’entrée ; rcs ou whatsapp_template, il se vise par son code ou son nom.',
              'The published scenarios, whether they can go out or not. opening is computed by the same rule as POST /v1/sends: null, it cannot go out by its code or its name, nor through its entry block (another of its blocks, targeted with a node target, is judged on its own); whatsapp_session, it is targeted through its entry block; rcs or whatsapp_template, it is targeted by its code or its name.',
            )}{' '}
            <LienDoc page="messages" ancre="ouverture">{t('Ce qu’un scénario ou un bloc envoie en premier', 'What a scenario or a block sends first')}</LienDoc>
          </li>
          <li>
            {t(
              'openingTemplate : pour une ouverture whatsapp_template, le template que params paramètre ; null sinon. Son nombre de variables se lit dans GET /v1/templates, à la ligne du même nom et de la même langue : params doit en décrire exactement autant, sinon 422',
              'openingTemplate: for a whatsapp_template opening, the template that params parameterizes; null otherwise. Its number of variables is read in GET /v1/templates, on the row with the same name and language: params must describe exactly as many, otherwise 422',
            )}{' '}
            <Code c="unsendable_target" />.
          </li>
          <li>
            {t(
              'entryNode : le code nod_ du bloc d’entrée, à viser en cible node (le seul chemin d’une ouverture whatsapp_session). Le viser rend la même ouverture que le scénario. null quand ce bloc n’a pas de code public.',
              'entryNode: the nod_ code of the entry block, to target with a node target (the only path for a whatsapp_session opening). Targeting it gives the same opening as the scenario. null when that block has no public code.',
            )}
          </li>
          <li>
            {t(
              'publishedAt vaut null pour un scénario mis en ligne avant que cette date soit suivie.',
              'publishedAt is null for a scenario put online before that date was tracked.',
            )}
          </li>
        </Liste>
      </Route>

      <Route id="messages-rcs" methode="GET" chemin="/v1/rcs-messages" droit="sends:create">
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.messagesRcs)}</Bloc>
        <p>
          {t(
            'Les messages de Contenu > Messages RCS, désignés par leur nom dans la cible rcsMessage. kind vaut text, card ou carousel ; variables liste les noms entre doubles accolades qu’ils utilisent.',
            'The messages of Content > RCS messages, designated by their name in the rcsMessage target. kind is text, card or carousel; variables lists the names between double braces they use.',
          )}
        </p>
      </Route>
    </>
  );
}
