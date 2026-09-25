'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  Bloc, C, Code, Encadre, EnTetePage, LienDoc, Liste, Route, Section, Sous, SousSous, Tableau, curl, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, CODES_DOCUMENTES, EXEMPLES_CORPS, EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * LES DEUX FAMILLES DE ROUTES QUI FONT PARTIR QUELQUE CHOSE : le message simple (un texte, une personne, tout de
 * suite) et l'envoi (une cible, jusqu'à cinquante destinataires, en tâche de fond). Le tableau d'en-tête les
 * distingue ; l'idempotence, le consentement et la fenêtre de 24 h vivent dans Concepts.
 */
export default function ApiMessagesPage() {
  return <CadreDoc page="messages">{() => <Messages />}</CadreDoc>;
}

function Messages() {
  const t = useT();
  const ecarts = CODES_DOCUMENTES.filter((c) => c.ecart);

  return (
    <>
      <EnTetePage page="messages">
        <p>
          {t(
            'Deux familles de routes : envoyer un message simple (un texte, à une personne, tout de suite), ou déclencher un envoi (un template, un scénario ou un message RCS, vers une liste de destinataires).',
            'Two families of routes: send a plain message (one text, to one person, right away), or trigger a send (a template, a scenario or an RCS message, to a list of recipients).',
          )}
        </p>
      </EnTetePage>

      <Tableau
        entetes={['', t('Message simple', 'Plain message'), t('Envoi', 'Send')]}
        lignes={[
          { cle: 'qui', cellules: [t('Destinataires', 'Recipients'), t('Une personne', 'One person'), t(`Jusqu’à ${BORNES.destinatairesParEnvoi} destinataires`, `Up to ${BORNES.destinatairesParEnvoi} recipients`)] },
          { cle: 'quoi', cellules: [t('Contenu', 'Content'), t('Un texte, tout de suite', 'One text, right away'), t('Un template, un scénario, un bloc ou un message RCS', 'A template, a scenario, a block or an RCS message')] },
          { cle: 'quand', cellules: [t('Traitement', 'Processing'), t('Synchrone : la réponse 200 porte le message', 'Synchronous: the 200 response carries the message'), t('Asynchrone : suivi par GET /v1/sends/{sendId}', 'Asynchronous: followed with GET /v1/sends/{sendId}')] },
          { cle: 'rejeu', cellules: [t('Idempotence', 'Idempotency'), t('Non : rejouer l’appel envoie un second message', 'No: replaying the call sends a second message'), <LienDoc key="i" page="concepts" ancre="idempotence">{t('Oui, clé obligatoire', 'Yes, key required')}</LienDoc>] },
          { cle: 'routes', cellules: [t('Routes', 'Routes'), <span key="r">POST /v1/messages/whatsapp, POST /v1/messages/rcs</span>, <span key="r">POST /v1/sends, GET /v1/sends/{'{sendId}'}</span>] },
        ]}
      />

      <Section id="messages-simples" titre={t('Messages simples', 'Plain messages')}>
        <p>
          {t(
            'Un texte, à une personne, tout de suite. Le message apparaît dans l’Inbox, et écrire prend le fil : le scénario cesse d’avancer seul, l’agent de Meta cesse de répondre. La personne doit déjà avoir une fiche : ces routes n’en créent pas.',
            'One text, to one person, right away. The message shows in the Inbox, and writing takes the thread: the scenario stops advancing on its own, the Meta agent stops replying. The person must already have a record: these routes do not create one.',
          )}
        </p>
        <Encadre sorte="attention">
          <p>
            {t('Pas de clé d’idempotence : rejouer l’appel envoie un second message.', 'No idempotency key: replaying the call sends a second message.')}{' '}
            <LienDoc page="concepts" ancre="idempotence">{t('Idempotence', 'Idempotency')}</LienDoc>
          </p>
        </Encadre>
        <Sous>{t('Réponse 200 des deux routes', '200 response of both routes')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.messageEnvoye)}</Bloc>
        <p>
          {t(
            'conversationId vaut null dans un seul cas, en RCS : le message est parti, mais la fiche a été bloquée ou supprimée entre-temps et aucune conversation ne l’accueille. En WhatsApp, il est toujours renseigné.',
            'conversationId is null in one case only, over RCS: the message was sent, but the record was blocked or deleted in the meantime and no conversation holds it. Over WhatsApp, it is always set.',
          )}
        </p>
      </Section>

      <Route id="message-whatsapp" methode="POST" chemin="/v1/messages/whatsapp" droit="sends:create">
        <Sous>{t('Requête', 'Request')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_CORPS.messageWhatsapp.corps)}</Bloc>
        <p>
          {t(
            `Une clé de fiche, et un texte de ${BORNES.texteWhatsapp} caractères au plus.`,
            `A record key, and a text of ${BORNES.texteWhatsapp} characters at most.`,
          )}
        </p>
        <Bloc legende={t('Commande : un message WhatsApp dans la fenêtre', 'Command: a WhatsApp message within the window')}>
          {curl('/v1/messages/whatsapp', EXEMPLES_CORPS.messageWhatsapp.corps)}
        </Bloc>
        <Sous>{t('Erreurs', 'Errors')}</Sous>
        <p>{t('Les refus, dans l’ordre :', 'Refusals, in order:')}</p>
        <Tableau
          entetes={[t('Cas', 'Case'), t('Réponse', 'Response')]}
          lignes={[
            { cle: 'fiche', cellules: [t('Fiche inconnue', 'Unknown record'), <span key="r">404 <Code c="unknown_contact" /></span>] },
            { cle: 'bloque', cellules: [t('Bloquée ou sans adresse WhatsApp', 'Blocked or without a WhatsApp address'), <span key="r">409 <Code c="blocked_contact" /></span>] },
            { cle: 'fenetre', cellules: [t('Fenêtre de 24 h fermée', '24-hour window closed'), <span key="r">422 <Code c="window_closed" /></span>] },
            { cle: 'desabonne', cellules: [t('Désabonnée', 'Opted out'), <span key="r">409 <Code c="opted_out" /></span>] },
            { cle: 'numero', cellules: [t('Espace sans numéro WhatsApp', 'Workspace without a WhatsApp number'), <span key="r">409 <Code c="no_whatsapp_number" /></span>] },
            { cle: 'delie', cellules: [t('Numéro délié depuis l’Accueil', 'Number unlinked from the Home page'), <span key="r">409 <Code c="number_unlinked" /></span>] },
          ]}
        />
        <Sous>{t('Notes', 'Notes')}</Sous>
        <p>
          {t('Hors de la fenêtre de 24 h, le seul chemin est un template :', 'Outside the 24-hour window, the only path is a template:')}{' '}
          <LienDoc page="concepts" ancre="fenetre-24h">{t('La fenêtre de 24 h', 'The 24-hour window')}</LienDoc>.
        </p>
      </Route>

      <Route id="message-rcs" methode="POST" chemin="/v1/messages/rcs" droit="sends:create">
        <Sous>{t('Requête', 'Request')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_CORPS.messageRcs.corps)}</Bloc>
        <p>
          {t(
            `Même corps, texte de ${BORNES.texteRcs} caractères au plus, et pas de fenêtre.`,
            `Same body, text of ${BORNES.texteRcs} characters at most, and no window.`,
          )}
        </p>
        <Bloc legende={t('Commande : un message RCS', 'Command: an RCS message')}>{curl('/v1/messages/rcs', EXEMPLES_CORPS.messageRcs.corps)}</Bloc>
        <Sous>{t('Erreurs', 'Errors')}</Sous>
        <p>{t('Les conditions, dans l’ordre :', 'The conditions, in order:')}</p>
        <Tableau
          entetes={[t('Condition', 'Condition'), t('Sinon', 'Otherwise')]}
          lignes={[
            { cle: 'fiche', cellules: [t('La fiche existe', 'The record exists'), <span key="r">404 <Code c="unknown_contact" /></span>] },
            { cle: 'numero', cellules: [t('Elle porte un numéro', 'It carries a phone number'), <span key="r">422 <Code c="no_phone" /></span>] },
            { cle: 'bloque', cellules: [t('Elle n’est pas bloquée', 'It is not blocked'), <span key="r">409 <Code c="blocked_contact" /></span>] },
            { cle: 'desabonne', cellules: [t('Elle n’est pas désabonnée, ni en général ni du RCS', 'It is not opted out, neither in general nor from RCS'), <span key="r">409 <Code c="opted_out" /></span>] },
            { cle: 'consentement', cellules: [t('Elle a consenti (opted_in), ou elle vous a déjà écrit', 'It consented (opted_in), or it already wrote to you'), <span key="r">409 <Code c="no_consent" /></span>] },
            { cle: 'canal', cellules: [t('Le canal RCS est actif sur l’espace', 'The RCS channel is active on the workspace'), <span key="r">409 <Code c="rcs_not_enabled" /></span>] },
            { cle: 'joignable', cellules: [t('Elle n’est pas connue comme injoignable en RCS', 'It is not known as unreachable over RCS'), <span key="r">422 <Code c="rcs_unreachable" /></span>] },
          ]}
        />
        <Sous>{t('Notes', 'Notes')}</Sous>
        <p>
          {t(
            'La joignabilité RCS ne se connaît qu’après coup : le premier message vers un numéro sans RCS est accepté, son échec est enregistré (visible dans Sécurité > Journal des erreurs), et le suivant est refusé en',
            'RCS reachability is only known afterwards: the first message to a number without RCS is accepted, its failure is recorded (visible in Security > Error log), and the next one is refused with',
          )}{' '}
          <Code c="rcs_unreachable" />.
        </p>
      </Route>

      <Route id="envoi" methode="POST" chemin="/v1/sends" droit="sends:create">
        <p>
          {t(
            `Un envoi est un lot : ${BORNES.destinatairesParEnvoi} destinataires au plus, asynchrone, idempotent, visible dans Campagnes, et suivi par GET /v1/sends/{sendId}.`,
            `A send is a list: ${BORNES.destinatairesParEnvoi} recipients at most, asynchronous, idempotent, visible in Campaigns, and followed with GET /v1/sends/{sendId}.`,
          )}
        </p>
        <Sous>{t('Requête', 'Request')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_CORPS.envoiTemplate.corps)}</Bloc>
        <Bloc legende={t('Commande : un template, avec une variable par destinataire', 'Command: a template, with one variable per recipient')}>
          {curl('/v1/sends', EXEMPLES_CORPS.envoiTemplate.corps)}
        </Bloc>
        <Encadre sorte="obligatoire">
          <p>
            {t(
              'Une clé d’idempotence, en en-tête (Idempotency-Key) ou dans le corps (idempotencyKey).',
              'An idempotency key, as a header (Idempotency-Key) or in the body (idempotencyKey).',
            )}{' '}
            <LienDoc page="concepts" ancre="idempotence">{t('Idempotence', 'Idempotency')}</LienDoc>
          </p>
        </Encadre>

        <SousSous>{t('La cible, et le canal qu’elle donne', 'The target, and the channel it gives')}</SousSous>
        <Tableau
          entetes={[t('Cible', 'Target'), t('Désignée par', 'Designated by'), t('Canal', 'Channel')]}
          lignes={[
            { cle: 'template', cellules: [<C key="c">template</C>, t('le nom et la langue d’un template approuvé (GET /v1/templates)', 'the name and language of an approved template (GET /v1/templates)'), 'WhatsApp'] },
            { cle: 'scenario', cellules: [<C key="c">scenario</C>, t('son code scn_ ou son nom (GET /v1/scenarios)', 'its scn_ code or its name (GET /v1/scenarios)'), t('celui de son premier envoi', 'that of its first send')] },
            { cle: 'node', cellules: [<C key="c">node</C>, t('le code nod_ d’un bloc (Contenu > Blocs, ou entryNode dans GET /v1/scenarios)', 'the nod_ code of a block (Content > Blocks, or entryNode in GET /v1/scenarios)'), t('celui de son premier envoi', 'that of its first send')] },
            { cle: 'rcsMessage', cellules: [<C key="c">rcsMessage</C>, t('le nom d’un message de Contenu > Messages RCS (GET /v1/rcs-messages)', 'the name of a message in Content > RCS messages (GET /v1/rcs-messages)'), 'RCS'] },
          ]}
        />

        <SousSous id="ouverture">{t('Ce qu’un scénario ou un bloc envoie en premier', 'What a scenario or a block sends first')}</SousSous>
        <p>
          {t(
            'Ce n’est pas le type du bloc visé qui compte, c’est le premier message qu’il fait partir. La réponse le rend dans opening :',
            'What counts is not the type of the targeted block, it is the first message it sends. The response returns it in opening:',
          )}
        </p>
        <Tableau
          entetes={[t('Premier envoi atteint', 'First send reached'), 'opening', t('Règle', 'Rule')]}
          lignes={[
            { cle: 'template', cellules: [t('un template', 'a template'), <C key="o">whatsapp_template</C>, t('part vers quelqu’un qui n’a pas écrit', 'goes to someone who has not written')] },
            { cle: 'rcs', cellules: [t('un bloc RCS', 'an RCS block'), <C key="o">rcs</C>, <span key="r">{t('part vers quelqu’un qui n’a pas écrit ; une fiche sans numéro est écartée', 'goes to someone who has not written; a record without a number is skipped')} <Code c="no_phone" /></span>] },
            { cle: 'session', cellules: [t('un message rapide, une question, un formulaire, un agent', 'a quick message, a question, a form, an agent'), <C key="o">whatsapp_session</C>, <span key="r">{t('fenêtre de 24 h exigée pour chaque destinataire, sinon', '24-hour window required for each recipient, otherwise')} <Code c="window_closed" /></span>] },
            { cle: 'aucun', cellules: [t('une attente avant tout envoi, rien, plusieurs templates possibles, un template sans nom', 'a wait before any send, nothing, several possible templates, an unnamed template'), t('(aucun)', '(none)'), <span key="r">{t('refusé avant l’envoi : 422', 'refused before sending: 422')} <Code c="unsendable_target" />{t(', la raison dans le message', ', the reason in the message')}</span>] },
          ]}
        />
        <Liste>
          <li>
            {t(
              'Un scénario dont l’ouverture est whatsapp_session est refusé : pour parler à quelqu’un dans sa fenêtre, visez son bloc d’entrée (cible node, le code est dans entryNode). Un scénario jamais publié est refusé aussi : un envoi joue la version publiée.',
              'A scenario whose opening is whatsapp_session is refused: to talk to someone within their window, target its entry block (node target, the code is in entryNode). A never-published scenario is refused too: a send plays the published version.',
            )}
          </li>
          <li>{t('Un bloc admet les trois ouvertures.', 'A block accepts all three openings.')}</li>
        </Liste>
        <Encadre sorte="attention">
          <p>{t('Si une branche, même une seule, peut envoyer un message de session, la fenêtre est exigée pour tous.', 'If any branch, even a single one, can send a session message, the window is required for everyone.')}</p>
        </Encadre>

        <SousSous>{t('Les destinataires', 'Recipients')}</SousSous>
        <Liste>
          <li>
            {t(
              `recipients : ${BORNES.destinatairesParEnvoi} au plus, chacun avec ses clés de fiche (contactId, externalId, phone, bsuid), et en option consent, consentSource et variables.`,
              `recipients: ${BORNES.destinatairesParEnvoi} at most, each with its record keys (contactId, externalId, phone, bsuid), and optionally consent, consentSource and variables.`,
            )}
          </li>
          <li>
            {t(
              'L’envoi crée la fiche d’un destinataire inconnu qui porte un phone (un template ou un RCS part vers quelqu’un qui n’a pas écrit), sauf pour une ouverture whatsapp_session, où il est écarté faute de fenêtre possible. Un inconnu qui ne porte qu’un bsuid est écarté aussi :',
              'The send creates the record of an unknown recipient carrying a phone (a template or an RCS goes to someone who has not written), except for a whatsapp_session opening, where it is skipped since no window is possible. An unknown recipient carrying only a bsuid is skipped too:',
            )}{' '}
            <Code c="unknown_contact" />.
          </li>
          <li>
            {t('consent par destinataire :', 'Per-recipient consent:')}{' '}
            <LienDoc page="concepts" ancre="consentement">{t('Consentement et STOP', 'Consent and STOP')}</LienDoc>.
          </li>
          <li>
            {t('Un destinataire mal formé est écarté (', 'A malformed recipient is skipped (')}<Code c="invalid_recipient" />, <Code c="invalid_phone" />
            {t('), il ne fait pas tomber l’envoi.', '), it does not sink the send.')}
          </li>
          <li>
            {t(
              'Aucune perte silencieuse : chaque destinataire écarté l’est avec son motif et son index dans recipients. Les motifs :',
              'No silent loss: every skipped recipient comes with its reason and its index in recipients. The reasons:',
            )}{' '}
            {ecarts.map((c, i) => <span key={c.code}>{i > 0 ? ', ' : ''}<Code c={c.code} /></span>)}.
          </li>
        </Liste>

        <SousSous>{t('Les paramètres et les variables', 'Parameters and variables')}</SousSous>
        <Liste>
          <li>
            {t(
              'params : une entrée par variable du template qui part, positions 1 à N sans trou. Sa source : un champ de la fiche (field), un attribut (attribute : name, phone, bsuid ou wa_id), la date du jour (now), un texte fixe (literal) ou une variable du destinataire (variable) ; en option, une valeur de repli (fallback). Il en faut exactement autant que le corps du template a de variables : GET /v1/templates les liste, sinon 422',
              'params: one entry per variable of the template that goes out, positions 1 to N with no gap. Its source: a record field (field), an attribute (attribute: name, phone, bsuid or wa_id), today’s date (now), a fixed text (literal) or a recipient variable (variable); optionally, a fallback value (fallback). There must be exactly as many as the template body has variables: GET /v1/templates lists them, otherwise 422',
            )}{' '}
            <Code c="unsendable_target" />.
          </li>
          <li>{t('variables : un objet clé vers texte, propre à ce destinataire, jamais écrit sur la fiche.', 'variables: a key to text object, specific to this recipient, never written on the record.')}</li>
          <li>
            {t('Template : la source de paramètre', 'Template: the parameter source')}{' '}
            <C>{JSON.stringify(EXEMPLES_CORPS.envoiTemplate.corps.params[1].source)}</C>{' '}
            {t('lit variables.commande. Absente et sans valeur de repli, le destinataire est écarté', 'reads variables.commande. Missing and without a fallback value, the recipient is skipped with')}{' '}
            <Code c="missing_variable" />.
          </li>
          <li>
            {t(
              'Scénario qui ouvre par un template : params paramètre ce template (openingTemplate dans GET /v1/scenarios), avec toute source sauf variable (400',
              'Scenario that opens with a template: params parameterizes that template (openingTemplate in GET /v1/scenarios), with any source except variable (400',
            )}{' '}
            <Code c="invalid_body" />).
          </li>
          <li>
            {t(
              'Bloc, et scénario qui ouvre en RCS : params est refusé (400',
              'Block, and scenario that opens with RCS: params is refused (400',
            )}{' '}
            <Code c="invalid_body" />
            {t(
              '). Un bloc qui envoie un template le remplit avec les champs associés à ses variables dans la console.',
              '). A block that sends a template fills it with the fields associated with its variables in the console.',
            )}
          </li>
          <li>
            {t('Scénario et bloc : les variables par destinataire sont refusées (400', 'Scenario and block: per-recipient variables are refused (400')}{' '}
            <Code c="invalid_body" />
            {t(') : un parcours n’a pas d’endroit où les ranger.', '): a journey has nowhere to store them.')}
          </li>
          <li>
            {t('Message RCS :', 'RCS message:')} <C>{'{{commande}}'}</C>{' '}
            {t(
              'prend variables.commande en priorité, puis le champ de fiche du même nom ; absente des deux, elle est remplacée par un texte vide.',
              'takes variables.commande first, then the record field of the same name; missing from both, it is replaced with empty text.',
            )}
          </li>
        </Liste>

        <SousSous id="categorie">{t('Catégorie, numéro, débit', 'Category, number, throughput')}</SousSous>
        <Liste>
          <li>
            {t('Template : la catégorie est lue chez Meta, vous ne la donnez pas (le champ category est refusé). Illisible : 422', 'Template: the category is read at Meta, you do not give it (the category field is refused). Unreadable: 422')}{' '}
            <Code c="template_category_unknown" />. {t('Template absent ou non approuvé : 404', 'Template missing or not approved: 404')} <Code c="template_not_found" />.
          </li>
          <li>
            {t(
              'Scénario, bloc, message RCS : category (marketing ou utility) est obligatoire. marketing écarte tout destinataire qui n’est pas opted_in',
              'Scenario, block, RCS message: category (marketing or utility) is required. marketing skips every recipient who is not opted_in',
            )}{' '}
            (<Code c="no_consent" />)
            {t(
              ' ; utility n’écarte que les désabonnés. Un scénario qui ouvre par un template marketing part en marketing, même déclaré utility.',
              '; utility only skips opted-out recipients. A scenario that opens with a marketing template goes out as marketing, even when declared utility.',
            )}
          </li>
          <li>
            {t(
              'Numéro WhatsApp : phoneNumberId est optionnel, absent c’est le numéro par défaut de l’espace. Un template, un scénario ou un bloc exige un numéro WhatsApp ; un message RCS part de l’agent RCS de l’espace et n’en demande pas (un phoneNumberId donné avec une cible rcsMessage est ignoré).',
              'WhatsApp number: phoneNumberId is optional, when absent the workspace’s default number is used. A template, a scenario or a block requires a WhatsApp number; an RCS message goes out from the workspace’s RCS agent and needs none (a phoneNumberId given with an rcsMessage target is ignored).',
            )}
          </li>
          <li>
            {t(
              `ratePerMinute : un entier de 1 à ${BORNES.debitParMinute}, sinon 400. Le plafond réel du canal s’applique ensuite, il peut être plus bas.`,
              `ratePerMinute: an integer from 1 to ${BORNES.debitParMinute}, otherwise 400. The channel’s real cap applies afterwards, and may be lower.`,
            )}
          </li>
        </Liste>

        <Sous>{t('Réponse 201', '201 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.envoiCree)}</Bloc>
        <p>
          {t(
            `Chaque écart porte l’index du destinataire dans recipients, quelle que soit la clé utilisée. La liste est tronquée à ${BORNES.ecartsDetailles} entrées ; skippedTotal donne le compte réel.`,
            `Each skip carries the recipient’s index in recipients, whatever key was used. The list is capped at ${BORNES.ecartsDetailles} entries; skippedTotal gives the real count.`,
          )}
        </p>

        <Sous>{t('Les autres cibles', 'The other targets')}</Sous>
        <p>
          {t(
            'Un scénario qui ouvre par un template (ses deux params), un bloc dans la fenêtre, un message RCS de la bibliothèque :',
            'A scenario that opens with a template (its two params), a block within the window, an RCS message from the library:',
          )}
        </p>
        <Bloc legende={t('Scénario', 'Scenario')}>{json(EXEMPLES_CORPS.envoiScenario.corps)}</Bloc>
        <Bloc legende={t('Bloc', 'Block')}>{json(EXEMPLES_CORPS.envoiBloc.corps)}</Bloc>
        <Bloc legende={t('Message RCS', 'RCS message')}>{json(EXEMPLES_CORPS.envoiRcs.corps)}</Bloc>
        <Bloc legende={t('Commande : un message RCS de la bibliothèque', 'Command: an RCS message from the library')}>
          {curl('/v1/sends', EXEMPLES_CORPS.envoiRcs.corps)}
        </Bloc>
      </Route>

      <Route id="suivi" methode="GET" chemin="/v1/sends/{sendId}" droit="sends:create">
        <Sous>{t('Réponse 200', '200 response')}</Sous>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.envoiSuivi)}</Bloc>
        <p>
          {t(
            'Le statut de l’envoi, ses compteurs, et une ligne par destinataire (recipientsTotal donne leur nombre quand la liste est tronquée). error vaut un objet message et metaCode quand un envoi a échoué. Pour un scénario ou un bloc, la ligne décrit le départ du parcours et channel son canal d’ouverture ; la suite se lit dans la console.',
            'The send’s status, its counters, and one row per recipient (recipientsTotal gives their number when the list is capped). error is an object with message and metaCode when a send failed. For a scenario or a block, the row describes the start of the journey and channel its opening channel; the rest is read in the console.',
          )}
        </p>
        <Sous>{t('Erreurs', 'Errors')}</Sous>
        <p>{t('Envoi inconnu : 404', 'Unknown send: 404')} <Code c="send_not_found" />.</p>
      </Route>
    </>
  );
}
