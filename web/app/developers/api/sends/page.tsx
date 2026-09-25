'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  Bloc, C, Champs, Code, Encadre, EnTetePage, Erreurs, LienDoc, Liste, Refus, Route, Sous, SousSous, SurCettePage, Tableau, curl, curlGet, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, CODES_DOCUMENTES, EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';
import { CHAMPS, CIBLES, SOURCES_PARAM, type CibleDoc, type SourceDoc } from '@/lib/api-champs';

/**
 * LES ENVOIS : une cible (template, scénario, bloc ou message RCS) vers 1 à 50 destinataires, en tâche de fond,
 * et leur suivi. Séparés des messages simples au lot 2 de la refonte (2026-09-25) : les anciennes ancres de la page
 * Messages (`#envoi`, `#ouverture`, `#categorie`, `#suivi`) renvoient ici (`ANCRES_DEPLACEES`). L'idempotence et
 * le consentement vivent dans Concepts : on y renvoie.
 */
export default function ApiEnvoisPage() {
  return <CadreDoc page="sends">{() => <Envois />}</CadreDoc>;
}

function Envois() {
  const t = useT();
  const ecarts = CODES_DOCUMENTES.filter((c) => c.ecart);
  const refusees = <span>{t('Refusées (', 'Refused (')}<Refus c="invalid_body" />).</span>;
  const refuses = <span>{t('Refusés (', 'Refused (')}<Refus c="invalid_body" />).</span>;

  return (
    <>
      <EnTetePage page="sends">
        <p>
          {t(
            `Une cible (template, scénario, bloc ou message RCS) vers 1 à ${BORNES.destinatairesParEnvoi} destinataires, en tâche de fond. Chaque envoi apparaît dans Campagnes.`,
            `A target (template, scenario, block or RCS message) to 1 to ${BORNES.destinatairesParEnvoi} recipients, in the background. Every send shows in Campaigns.`,
          )}
        </p>
      </EnTetePage>
      <SurCettePage page="sends" />

      <Route ep="POST /v1/sends">
        <Encadre sorte="obligatoire">
          <p>
            {t('Une clé d’idempotence : en-tête Idempotency-Key ou champ idempotencyKey.', 'An idempotency key: Idempotency-Key header or idempotencyKey field.')}{' '}
            <LienDoc page="concepts" ancre="idempotence">{t('Idempotence', 'Idempotency')}</LienDoc>
          </p>
        </Encadre>
        <Sous>{t('Requête', 'Request')}</Sous>
        <Champs table={CHAMPS.envoi} />
        <Bloc legende={t('Commande : un template, une variable par destinataire', 'Command: a template, one variable per recipient')}>
          {curl('/v1/sends', EXEMPLES_CORPS.envoiTemplate.corps)}
        </Bloc>

        <SousSous id="cibles">{t('Types de cible', 'Target types')}</SousSous>
        <p>{t('target porte exactement une clé :', 'target carries exactly one key:')}</p>
        <Tableau
          entetes={[t('Clé', 'Key'), t('Valeur', 'Value'), t('Canal', 'Channel')]}
          lignes={CIBLES.map((c: CibleDoc) => ({ cle: c.nom, cellules: [<C key="c">{c.nom}</C>, t(...c.valeur), t(...c.canal)] }))}
        />

        <SousSous id="destinataires">{t('Destinataires', 'Recipients')}</SousSous>
        <p>{t('Chaque élément de recipients :', 'Each item of recipients:')}</p>
        <Champs table={CHAMPS.destinataire} />
        <Liste>
          <li>
            {t(
              'Destinataire inconnu avec un phone : fiche créée, sauf ouverture whatsapp_session. Sinon écarté',
              'Unknown recipient with a phone: record created, except with a whatsapp_session opening. Otherwise skipped',
            )}{' '}
            (<Code c="unknown_contact" />).
          </li>
          <li>
            {t('Destinataire mal formé : écarté (', 'Malformed recipient: skipped (')}<Code c="invalid_recipient" />, <Code c="invalid_phone" />
            {t('), l’envoi continue.', '), the send goes on.')}
          </li>
        </Liste>

        <SousSous id="parametres">{t('Paramètres et variables', 'Parameters and variables')}</SousSous>
        <p>{t('Chaque élément de params :', 'Each item of params:')}</p>
        <Champs table={CHAMPS.param} />
        <Tableau
          entetes={['source.type', t('Avec', 'With'), t('Lit', 'Reads')]}
          lignes={SOURCES_PARAM.map((s: SourceDoc) => ({
            cle: s.type,
            cellules: [
              <C key="t">{s.type}</C>,
              s.cle ? <span key="c"><C>{s.cle}</C>{s.valeurs && <> : {s.valeurs.map((v, i) => <span key={v}>{i > 0 ? ', ' : ''}<C>{v}</C></span>)}</>}</span> : '',
              t(...s.quoi),
            ],
          }))}
        />
        <p>{t('Selon la cible :', 'Depending on the target:')}</p>
        <Tableau
          entetes={[t('Cible', 'Target'), 'params', 'recipients[].variables']}
          lignes={[
            {
              cle: 'template',
              cellules: [
                'template',
                <span key="p">{t('Une entrée par variable du corps (GET /v1/templates). Autre nombre :', 'One entry per body variable (GET /v1/templates). Other count:')}{' '}<Refus c="unsendable_target" />.</span>,
                <span key="v">{t('Lues par la source variable. Absente et sans fallback : destinataire écarté', 'Read by the variable source. Missing and without fallback: recipient skipped')} (<Code c="missing_variable" />).</span>,
              ],
            },
            {
              cle: 'scenario-template',
              cellules: [
                t('scénario qui ouvre par un template', 'scenario opening with a template'),
                t('Paramètrent ce template (openingTemplate), toute source sauf variable.', 'Parameterize that template (openingTemplate), any source except variable.'),
                refusees,
              ],
            },
            {
              cle: 'node',
              cellules: [
                t('bloc, scénario qui ouvre en RCS', 'block, scenario opening with RCS'),
                <span key="p">{refuses} {t('Un bloc remplit son template avec les champs associés à ses variables dans la console.', 'A block fills its template with the fields associated with its variables in the console.')}</span>,
                refusees,
              ],
            },
            {
              cle: 'rcsMessage',
              cellules: [
                t('message RCS', 'RCS message'),
                refuses,
                <span key="v"><C>{'{{commande}}'}</C> {t(': variables.commande, sinon le champ de fiche commande, sinon vide.', ': variables.commande, otherwise the record field commande, otherwise empty.')}</span>,
              ],
            },
          ]}
        />

        <SousSous id="ouverture">{t('Message d’ouverture', 'Opening message')}</SousSous>
        <p>
          {t(
            'Le premier message que la cible fait partir décide des règles, pas le type du bloc visé. La réponse le rend dans opening.',
            'The first message the target sends decides the rules, not the type of the targeted block. The response returns it in opening.',
          )}
        </p>
        <Tableau
          entetes={[t('Premier envoi', 'First send'), 'opening', t('Règle', 'Rule')]}
          lignes={[
            { cle: 'template', cellules: [t('un template', 'a template'), <C key="o">whatsapp_template</C>, t('Part vers qui n’a pas écrit.', 'Goes to someone who has not written.')] },
            { cle: 'rcs', cellules: [t('un bloc RCS', 'an RCS block'), <C key="o">rcs</C>, <span key="r">{t('Part vers qui n’a pas écrit. Fiche sans numéro : écartée', 'Goes to someone who has not written. Record without a number: skipped')} (<Code c="no_phone" />).</span>] },
            { cle: 'session', cellules: [t('un message rapide, une question, un formulaire, un agent', 'a quick message, a question, a form, an agent'), <C key="o">whatsapp_session</C>, <span key="r">{t('Fenêtre de 24 h exigée par destinataire, sinon écarté', '24-hour window required per recipient, otherwise skipped')} (<Code c="window_closed" />).</span>] },
            { cle: 'aucun', cellules: [t('une attente avant tout envoi, rien, plusieurs templates possibles, un template sans nom', 'a wait before any send, nothing, several possible templates, an unnamed template'), t('(aucun)', '(none)'), <span key="r"><Refus c="unsendable_target" />{t(', raison dans le message.', ', reason in the message.')}</span>] },
          ]}
        />
        <Liste>
          <li>{t('Une seule branche capable d’un message de session : la fenêtre est exigée pour tous.', 'A single branch able to send a session message: the window is required for everyone.')}</li>
          <li>{t('Scénario en whatsapp_session : refusé. Viser son bloc d’entrée (cible node, code dans entryNode).', 'Scenario with whatsapp_session: refused. Target its entry block (node target, code in entryNode).')}</li>
          <li>{t('Un bloc admet les trois ouvertures.', 'A block accepts all three openings.')}</li>
          <li>{t('Un envoi joue la version publiée : un scénario jamais publié est refusé.', 'A send plays the published version: a never-published scenario is refused.')}</li>
        </Liste>

        <SousSous id="categorie">{t('Catégorie', 'Category')}</SousSous>
        <Tableau
          entetes={[t('Cible', 'Target'), 'category']}
          lignes={[
            {
              cle: 'template',
              cellules: [
                'template',
                <span key="c">{t('Refusée : lue chez Meta, marketing ou utility. Illisible ou autre :', 'Refused: read at Meta, marketing or utility. Unreadable or other:')}{' '}<Refus c="template_category_unknown" />.</span>,
              ],
            },
            {
              cle: 'autres',
              cellules: [
                t('scénario, bloc, message RCS', 'scenario, block, RCS message'),
                t('Obligatoire. Premier message en template marketing (scénario, bloc) : marketing, même déclaré utility.', 'Required. First message is a marketing template (scenario, block): marketing, even when declared utility.'),
              ],
            },
          ]}
        />
        <Tableau
          entetes={[t('Catégorie', 'Category'), t('Destinataires écartés', 'Recipients skipped')]}
          lignes={[
            { cle: 'marketing', cellules: [<C key="c">marketing</C>, <span key="e">{t('Tout destinataire qui n’est pas opted_in', 'Every recipient who is not opted_in')} (<Code c="no_consent" />).</span>] },
            { cle: 'utility', cellules: [<C key="c">utility</C>, t('Les désabonnés seulement.', 'Opted-out recipients only.')] },
          ]}
        />

        <Sous>{t('Réponse 201', '201 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.envoiCree)}</Bloc>
        <Tableau
          entetes={[t('Champ', 'Field'), t('Sens', 'Meaning')]}
          lignes={[
            { cle: 'opening', cellules: [<C key="c">opening</C>, <LienDoc key="l" page="sends" ancre="ouverture">{t('Message d’ouverture', 'Opening message')}</LienDoc>] },
            { cle: 'recipientCount', cellules: [<C key="c">recipientCount</C>, t('Destinataires retenus.', 'Recipients kept.')] },
            { cle: 'fiches', cellules: [<span key="c"><C>created</C>, <C>matched</C></span>, t('Fiches créées, fiches trouvées.', 'Records created, records found.')] },
            {
              cle: 'skipped',
              cellules: [
                <C key="c">skipped</C>,
                t(
                  `Un élément par destinataire écarté : index dans recipients et motif. ${BORNES.ecartsDetailles} au plus ; skippedTotal donne le total.`,
                  `One item per skipped recipient: index in recipients and reason. ${BORNES.ecartsDetailles} at most; skippedTotal gives the total.`,
                ),
              ],
            },
          ]}
        />
        <p>
          {t('Motifs d’écart :', 'Skip reasons:')}{' '}
          {ecarts.map((c, i) => <span key={c.code}>{i > 0 ? ', ' : ''}<Code c={c.code} /></span>)}.
        </p>

        <Sous>{t('Erreurs', 'Errors')}</Sous>
        <Erreurs
          lignes={[
            ['invalid_body', t('Corps, cible ou params mal formés ; category absente ou en trop ; phoneNumberId inconnu de l’espace.', 'Malformed body, target or params; category missing or not allowed; phoneNumberId unknown to the workspace.')],
            ['idempotency_key_required', t('Clé d’idempotence absente.', 'Idempotency key missing.')],
            ['idempotency_key_reused', t('Clé déjà utilisée pour un autre corps.', 'Key already used for another body.')],
            ['idempotency_in_progress', t('Envoi en cours avec cette clé.', 'Send in progress with this key.')],
            ['no_whatsapp_number', t('Aucun numéro WhatsApp sur l’espace (sauf message RCS).', 'No WhatsApp number on the workspace (except RCS message).')],
            ['number_unlinked', t('Numéro WhatsApp délié depuis l’Accueil, et premier message en WhatsApp. Rien n’est créé. Une cible qui ouvre en RCS part.', 'WhatsApp number unlinked from the Home page, and first message over WhatsApp. Nothing is created. A target opening with RCS goes out.')],
            ['template_not_found', t('Template absent, non approuvé, ou d’une autre langue.', 'Template missing, not approved, or in another language.')],
            ['template_category_unknown', t('Catégorie du template illisible, ou ni marketing ni utility.', 'Template category unreadable, or neither marketing nor utility.')],
            ['scenario_not_found', t('Scénario introuvable.', 'Scenario not found.')],
            ['scenario_ambiguous', t('Plusieurs scénarios portent ce nom : utiliser le code scn_.', 'Several scenarios have this name: use the scn_ code.')],
            ['node_not_found', t('Bloc introuvable dans les scénarios publiés.', 'Block not found in the published scenarios.')],
            ['rcs_message_not_found', t('Message RCS introuvable.', 'RCS message not found.')],
            ['rcs_not_enabled', t('Canal RCS inactif, cible rcsMessage.', 'RCS channel inactive, rcsMessage target.')],
            ['unsendable_target', t('La cible ne peut pas partir ainsi ; raison dans le message.', 'The target cannot go out like this; reason in the message.')],
          ]}
        />

        <Sous>{t('Exemples de cibles', 'Target examples')}</Sous>
        <Bloc legende={t('Corps : scénario qui ouvre par un template (ses deux params)', 'Body: scenario opening with a template (its two params)')}>{json(EXEMPLES_CORPS.envoiScenario.corps)}</Bloc>
        <Bloc legende={t('Corps : bloc, dans la fenêtre', 'Body: block, within the window')}>{json(EXEMPLES_CORPS.envoiBloc.corps)}</Bloc>
        <Bloc legende={t('Commande : message RCS de la bibliothèque', 'Command: RCS message from the library')}>{curl('/v1/sends', EXEMPLES_CORPS.envoiRcs.corps)}</Bloc>
      </Route>

      <Route ep="GET /v1/sends/{sendId}">
        <Sous>{t('Requête', 'Request')}</Sous>
        <p>{t('sendId, dans le chemin : celui de la réponse 201.', 'sendId, in the path: the one from the 201 response.')}</p>
        <Bloc legende={t('Commande', 'Command')}>{curlGet(`/v1/sends/${EXEMPLES_REPONSES.envoiSuivi.sendId}`)}</Bloc>
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.envoiSuivi)}</Bloc>
        <Tableau
          entetes={[t('Champ', 'Field'), t('Sens', 'Meaning')]}
          lignes={[
            { cle: 'status', cellules: [<C key="c">status</C>, t('État de l’envoi, dont running, paused et completed.', 'State of the send, including running, paused and completed.')] },
            { cle: 'counts', cellules: [<C key="c">counts</C>, t('Destinataires retenus, par statut. Les destinataires écartés à la création n’y figurent pas : seulement dans skipped et skippedTotal de la réponse 201.', 'Kept recipients, per status. Recipients skipped at creation are not counted here: only in skipped and skippedTotal of the 201 response.')] },
            { cle: 'recipients', cellules: [<C key="c">recipients</C>, t('Une ligne par destinataire retenu, 500 au plus ; recipientsTotal donne le total.', 'One row per kept recipient, 500 at most; recipientsTotal gives the total.')] },
            { cle: 'error', cellules: [<C key="c">error</C>, t('Sur une ligne failed : message et metaCode. failed couvre aussi un échec de livraison signalé après l’envoi.', 'On a failed row: message and metaCode. failed also covers a delivery failure reported after sending.')] },
            { cle: 'parcours', cellules: [<C key="c">channel</C>, t('Scénario ou bloc : la ligne décrit le départ du parcours. channel : son canal d’ouverture ; messageId et delivery : null. La suite se lit dans la console.', 'Scenario or block: the row describes the start of the journey. channel: its opening channel; messageId and delivery: null. The rest is read in the console.')] },
          ]}
        />
        <Sous>{t('Erreurs', 'Errors')}</Sous>
        <Erreurs lignes={[['send_not_found', t('Envoi inconnu.', 'Unknown send.')]]} />
      </Route>
    </>
  );
}
