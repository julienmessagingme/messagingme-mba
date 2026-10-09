'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  Bloc, C, Encadre, EnTetePage, Erreurs, LienDoc, Liste, Route, Sous, SurCettePage, Tableau, curl, curlGet, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * LES MODÈLES (lot 13, domaine 3) : créer un modèle au format de Meta et suivre sa validation. Le catalogue des modèles
 * envoyables reste sur sa page (`catalogs`) ; l'envoi passe par `sends`.
 */
export default function ApiModelesPage() {
  return <CadreDoc page="templates">{() => <Modeles />}</CadreDoc>;
}

function Modeles() {
  const t = useT();
  const commande = t('Commande', 'Command');
  const erreurs = t('Erreurs', 'Errors');
  const notes = t('Notes', 'Notes');
  const ordre = t('Dans l’ordre où elles sont vérifiées :', 'In the order they are checked:');

  return (
    <>
      <EnTetePage page="templates">
        <p>
          {t(
            'Créer un modèle WhatsApp et suivre sa validation par Meta, avec le droit templates:write. Une fois approuvé, il part par',
            'Create a WhatsApp template and follow its review by Meta, with the templates:write right. Once approved, it goes out through',
          )}{' '}
          <LienDoc page="sends">{t('Envois', 'Sends')}</LienDoc>.
        </p>
      </EnTetePage>
      <SurCettePage page="templates" />

      <Route ep="POST /v1/templates">
        <p>
          {t(
            'Le corps de Meta (Cloud API, modèles de message) : name, language, category, components. Il passe par la création de l’écran Modèles : ses liens sont tracés et ses gardes s’appliquent.',
            'Meta’s body (Cloud API, message templates): name, language, category, components. It goes through the Templates screen’s creation: its links are tracked and its checks apply.',
          )}
        </p>
        <Tableau
          entetes={[t('Champ', 'Field'), t('Sens', 'Meaning')]}
          lignes={[
            { cle: 'name', cellules: [<C key="c">name</C>, t('Minuscules, chiffres et _, comme chez Meta.', 'Lowercase letters, digits and _, as at Meta.')] },
            { cle: 'category', cellules: [<C key="c">category</C>, t('UTILITY ou MARKETING. Meta peut reclasser : la réponse dit la sienne.', 'UTILITY or MARKETING. Meta may reclassify: the response gives its own.')] },
            { cle: 'header', cellules: [<C key="c">HEADER</C>, t('format TEXT avec text, sans variable ; ou IMAGE, VIDEO, DOCUMENT avec example.header_url : l’adresse https du fichier.', 'format TEXT with text, no variable; or IMAGE, VIDEO, DOCUMENT with example.header_url: the file’s https address.')] },
            { cle: 'body', cellules: [<C key="c">BODY</C>, t('Obligatoire. Variables {{1}}, {{2}}… contiguës, une valeur d’exemple chacune dans example.body_text.', 'Required. Variables {{1}}, {{2}}… in sequence, one sample value each in example.body_text.')] },
            { cle: 'footer', cellules: [<C key="c">FOOTER</C>, t('Texte court, sans variable.', 'Short text, no variable.')] },
            { cle: 'buttons', cellules: [<C key="c">BUTTONS</C>, t('QUICK_REPLY, ou URL (2 au plus) : l’adresse est tracée par nous, sans {{1}}.', 'QUICK_REPLY, or URL (2 at most): the address is tracked by us, without {{1}}.')] },
          ]}
        />
        <Bloc legende={commande}>{curl('/v1/templates', EXEMPLES_CORPS.modeleMeta.corps)}</Bloc>
        <Sous>{t('Réponse 201', '201 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.modeleCree)}</Bloc>
        <Sous>{erreurs}</Sous>
        <p>{ordre}</p>
        <Erreurs
          lignes={[
            ['invalid_body', t('Corps hors du format, avec le champ fautif.', 'Body outside the format, naming the field.')],
            ['no_whatsapp_number', t('Espace sans compte WhatsApp.', 'Workspace without a WhatsApp account.')],
            ['invalid_header_media', t('Fichier d’en-tête introuvable, trop lourd, ou d’un autre type.', 'Header file not found, too large, or of another type.')],
            ['template_rejected', t('Un lien n’a pas pu être tracé.', 'A link could not be tracked.')],
            ['meta_rejected', t('Meta refuse le modèle (nom déjà pris dans cette langue, contenu) : son motif suit.', 'Meta refuses the template (name already taken in this language, content): its reason follows.')],
          ]}
        />
        <Sous>{notes}</Sous>
        <Liste>
          <li>{t('Bornes de Meta : corps 1 024 caractères, en-tête et pied 60, texte de bouton 25, 10 boutons.', 'Meta’s bounds: body 1,024 characters, header and footer 60, button text 25, 10 buttons.')}</li>
          <li>{t('Fichier d’en-tête : image JPEG ou PNG jusqu’à 5 Mo, vidéo MP4 ou document PDF jusqu’à 16 Mo. L’adresse ne doit pas rediriger.', 'Header file: JPEG or PNG image up to 5 MB, MP4 video or PDF document up to 16 MB. The address must not redirect.')}</li>
          <li>{t('Hors de cette route : carrousel, authentification, Flow, variables nommées.', 'Not on this route: carousel, authentication, Flow, named variables.')}</li>
        </Liste>
        <Encadre sorte="attention">
          <p>{t('Pas d’idempotence : rejouer l’appel avec le même nom est refusé par Meta.', 'No idempotency: replaying the call with the same name is refused by Meta.')}</p>
        </Encadre>
      </Route>

      <Route ep="GET /v1/templates/{name}">
        <p>
          {t(
            'Le statut de chaque langue chez Meta : pending, approved, rejected, paused… La validation prend de quelques minutes à quelques heures.',
            'Each language’s status at Meta: pending, approved, rejected, paused… Review takes a few minutes to a few hours.',
          )}
        </p>
        <Bloc legende={commande}>{curlGet('/v1/templates/commande_prete?language=fr')}</Bloc>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.statutModele)}</Bloc>
        <Liste>
          <li>{t('language (facultatif) : une seule langue. Absent : toutes.', 'language (optional): a single language. Absent: all.')}</li>
          <li>{t('rejectedReason : le motif de Meta pour un refus, null sinon.', 'rejectedReason: Meta’s reason for a rejection, null otherwise.')}</li>
        </Liste>
        <Sous>{erreurs}</Sous>
        <Erreurs
          lignes={[
            ['invalid_body', t('Langue hors de la liste WhatsApp.', 'Language outside the WhatsApp list.')],
            ['no_whatsapp_number', t('Espace sans compte WhatsApp.', 'Workspace without a WhatsApp account.')],
            ['template_not_found', t('Aucun modèle de ce nom, ou pas dans cette langue.', 'No template with this name, or not in this language.')],
          ]}
        />
      </Route>
    </>
  );
}
