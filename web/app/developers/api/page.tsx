'use client';

import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { BASE } from '@/lib/http';
import { BORNES, CODES_DOCUMENTES, EXEMPLES_CORPS, EXEMPLES_REPONSES, type NomDeCode } from '@/lib/api-exemples';
import { DocSignaux } from '@/components/DocSignaux';

/**
 * L'adresse PUBLIQUE de l'API, telle qu'un intégrateur doit la taper.
 *
 * ⚠️ Dérivée de la MÊME source que les appels de la console (`BASE`), jamais réécrite à la main : une adresse
 * en dur, recopiée par un intégrateur après une bascule d'hébergement, l'aurait mené sur un chemin mort qu'il
 * aurait découvert en production, chez lui. `web/lib/api-base.test.ts` le garde.
 *
 * Le repli conserve l'adresse historique tant que la variable n'est pas posée : le préfixe `/api/backend` est
 * alors juste, puisque c'est bien le proxy qui sert l'API.
 */
const ADRESSE_API = BASE.startsWith('http') ? BASE : 'https://mba.messagingme.app/api/backend';

/**
 * Documentation de l'API publique /v1 (réécrite le 2026-09-25, lot 4 de la spec de l'API cohérente).
 *
 * 🔴 LES EXEMPLES NE S'ÉCRIVENT PAS ICI. Chaque corps et chaque réponse vient de `@/lib/api-exemples`, et
 * `tests/api-exemples.test.ts` passe chaque corps aux règles de SA route : la page ne peut plus montrer un corps
 * que le serveur refuse. Le même test refuse un objet JSON écrit en dur dans ce fichier.
 *
 * 🔴 AUCUN OUTIL TIERS NOMMÉ (décision de Julien du 2026-09-24) : cette page sert à tous les intégrateurs. La
 * suite racine le vérifie sur la source, `web/e2e/developers-api.spec.ts` sur la page rendue.
 *
 * ⚠️ Le TEXTE reste écrit à la main à partir des routes (`src/http/v1-*.ts`) : une règle qui change côté
 * serveur ne change pas ici toute seule. Les codes cités passent par `<Code>`, typé sur la table des codes :
 * un code inventé ne compile pas. Deux comportements qu'elle décrit attendent une décision ou un correctif
 * (`todo.md`) : le refus de Meta sans `code`, et le corps JSON illisible lu comme un objet vide.
 */
export default function ApiDocsPage() {
  return <AppShell active="api-docs">{() => <DocsInner />}</AppShell>;
}

const codeCls = 'overflow-x-auto rounded-lg bg-ink-900 px-4 py-3 font-mono text-xs leading-relaxed text-ink-50';
const inlineCls = 'rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.8em] text-ink-800';
const CLE_EXEMPLE = 'mba_xxxxxxxxxxxxxxxx';

/** Un exemple du module, indenté pour être lu. */
const json = (v: unknown): string => JSON.stringify(v, null, 2);

/**
 * Une commande prête à copier. Le corps part entre apostrophes droites : la suite refuse donc toute
 * apostrophe droite dans un exemple, qui fermerait la chaîne du shell au milieu du JSON.
 */
function curl(chemin: string, corps: unknown): string {
  return [
    `curl -X POST ${ADRESSE_API}${chemin} \\`,
    `  -H "Authorization: Bearer ${CLE_EXEMPLE}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify(corps)}'`,
  ].join('\n');
}

function Section({ id, titre, children }: { id: string; titre: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{titre}</h3>
      <div className="mt-3 space-y-3 text-sm text-ink-700">{children}</div>
    </section>
  );
}

function SousTitre({ children }: { children: React.ReactNode }) {
  return <h4 className="pt-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{children}</h4>;
}

function Verb({ method, path, droit }: { method: 'GET' | 'POST' | 'PATCH'; path: string; droit: string }) {
  return (
    <p className="font-mono text-xs">
      <span className="rounded bg-brand-50 px-1.5 py-0.5 font-semibold text-brand-700">{method}</span>
      <span className="ml-2 text-ink-800">{path}</span>
      <span className="ml-2 text-ink-400">{droit}</span>
    </p>
  );
}

function C({ children }: { children: React.ReactNode }) {
  return <code className={inlineCls}>{children}</code>;
}

/** Un code d'erreur cité dans le texte : typé sur la table des codes, donc un code inventé ne compile pas. */
function Code({ c }: { c: NomDeCode }) {
  return <code className={inlineCls}>{c}</code>;
}

function Bloc({ children }: { children: string }) {
  return <pre className={codeCls}>{children}</pre>;
}

function Tableau({ entetes, lignes }: { entetes: string[]; lignes: Array<{ cle: string; cellules: React.ReactNode[] }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-ink-100">
            {entetes.map((e) => <th key={e} className="py-2 pr-4 text-xs font-semibold text-ink-500">{e}</th>)}
          </tr>
        </thead>
        <tbody>
          {lignes.map((l) => (
            <tr key={l.cle} className="border-b border-ink-50 last:border-0">
              {l.cellules.map((c, i) => <td key={i} className="py-2 pr-4 align-top text-ink-700">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocsInner() {
  const t = useT();
  const ecarts = CODES_DOCUMENTES.filter((c) => c.ecart);

  // `doc-api` borne les vérifications de l'e2e au CONTENU de la page : la barre latérale de la console nomme
  // d'autres écrans (dont des intégrations), et ne doit pas faire échouer la règle « aucun outil tiers ».
  return (
    <div className="max-w-3xl space-y-4" data-testid="doc-api">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Documentation API', 'API documentation')}</h2>
        <p className="mt-1 text-sm text-ink-500">
          {t(
            'Une API REST pour tenir vos fiches à jour et faire partir des messages depuis vos propres outils.',
            'A REST API to keep your contact records up to date and send messages from your own tools.',
          )}{' '}
          <Link href="/developers/keys" className="text-brand-600 hover:underline">{t('Gérer les clés', 'Manage keys')}</Link>
        </p>
        <p className="mt-2 text-sm text-ink-500">
          {t(
            'Deux familles de routes : envoyer un message simple (un texte, à une personne, tout de suite), ou déclencher un envoi (un template, un scénario ou un message RCS, vers une liste de destinataires).',
            'Two families of routes: send a plain message (one text, to one person, right away), or trigger a send (a template, a scenario or an RCS message, to a list of recipients).',
          )}
        </p>
      </div>

      <Section id="authentification" titre={t('Adresse et authentification', 'Base URL and authentication')}>
        <p>{t('Toutes les routes sont sous :', 'All routes live under:')}</p>
        <Bloc>{`${ADRESSE_API}/v1`}</Bloc>
        <p>
          {t(
            'Chaque appel porte sa clé dans l’en-tête Authorization. L’espace est déduit de la clé : aucune adresse ne porte d’identifiant d’espace.',
            'Every call carries its key in the Authorization header. The workspace is derived from the key: no URL ever carries a workspace id.',
          )}
        </p>
        <Bloc>{`Authorization: Bearer ${CLE_EXEMPLE}`}</Bloc>
        <p className="text-ink-500">
          {t(
            'Une valeur qui ne commence pas par mba_ est refusée sans être comparée en base. Clé absente ou invalide : 401',
            'A value not starting with mba_ is refused without being checked against the database. Missing or invalid key: 401',
          )}{' '}
          <Code c="unauthorized" />{t(' ; droit manquant : 403 ', '; missing scope: 403 ')}<Code c="missing_scope" />
          {t(' ; espace suspendu : 403 ', '; workspace suspended: 403 ')}<Code c="tenant_locked" />
          {t(' (la clé reste bonne : inutile d’en refaire une).', ' (the key is still valid: no need to create a new one).')}
        </p>
        <Tableau
          entetes={[t('Droit', 'Scope'), t('Ce qu’il ouvre', 'What it opens')]}
          lignes={[
            { cle: 'contacts:write', cellules: [<C key="d">contacts:write</C>, t('Créer et modifier des fiches : POST /v1/contacts, POST /v1/contacts/batch, PATCH /v1/contacts/{contactId}.', 'Create and update records: POST /v1/contacts, POST /v1/contacts/batch, PATCH /v1/contacts/{contactId}.')] },
            { cle: 'contacts:read', cellules: [<C key="d">contacts:read</C>, t('Lire et retrouver une fiche : GET /v1/contacts/{contactId}, POST /v1/contacts/search.', 'Read and find a record: GET /v1/contacts/{contactId}, POST /v1/contacts/search.')] },
            { cle: 'sends:create', cellules: [<C key="d">sends:create</C>, t('Envoyer, suivre un envoi, et lire ce qu’on peut envoyer : /v1/messages/whatsapp, /v1/messages/rcs, /v1/sends, /v1/templates, /v1/scenarios, /v1/rcs-messages.', 'Send, follow a send, and read what can be sent: /v1/messages/whatsapp, /v1/messages/rcs, /v1/sends, /v1/templates, /v1/scenarios, /v1/rcs-messages.')] },
          ]}
        />
        <p className="text-ink-500">
          {t(
            'Les droits d’une clé se fixent à sa création : pour un droit de plus, créez une clé neuve.',
            'A key’s scopes are set when it is created: for an extra scope, create a new key.',
          )}
        </p>
      </Section>

      <Section id="debit" titre={t('Débit', 'Rate limit')}>
        <p>
          {t(
            `Par défaut ${BORNES.debitParCle} requêtes par minute et par clé. Chaque réponse comptée sur votre clé porte l’état de son compteur :`,
            `By default ${BORNES.debitParCle} requests per minute per key. Every response counted against your key carries its counter state:`,
          )}
        </p>
        <Bloc>{`x-ratelimit-limit: ${BORNES.debitParCle}\nx-ratelimit-remaining: 57\nx-ratelimit-reset: 1790000000`}</Bloc>
        <p>
          {t('Au dépassement : 429', 'On overflow: 429')} <Code c="rate_limited" />{' '}
          {t(
            'avec un en-tête retry-after (en secondes). x-ratelimit-reset est l’heure de remise à zéro, en secondes depuis 1970. Une clé inconnue (401) ne porte aucun de ces en-têtes. Le compteur est tenu en mémoire du serveur : il repart à zéro à chaque redéploiement.',
            'with a retry-after header (seconds). x-ratelimit-reset is the reset time, in seconds since 1970. An unknown key (401) carries none of these headers. The counter is held in server memory: it resets on every redeploy.',
          )}
        </p>
      </Section>

      <Section id="identite" titre={t('Désigner une personne', 'Identifying a person')}>
        <p>
          {t(
            'Une personne est une FICHE. Vous la désignez par ce que vous avez, et ces clés ne servent qu’à la trouver :',
            'A person is a RECORD. You designate it with whatever you have, and these keys only serve to find it:',
          )}
        </p>
        <Tableau
          entetes={[t('Clé', 'Key'), t('Ce que c’est', 'What it is')]}
          lignes={[
            { cle: 'contactId', cellules: [<C key="k">contactId</C>, t('L’identifiant de la fiche, créé avec elle. Il s’affiche sur la fiche du mini-CRM (« Identifiant API », avec un bouton Copier).', 'The record id, created with it. It shows on the mini-CRM record (“API identifier”, with a Copy button).')] },
            { cle: 'externalId', cellules: [<C key="k">externalId</C>, t(`L’identifiant de la personne dans VOTRE outil (CRM, plateforme marketing), gardé sur la fiche. Unique par espace, ${BORNES.externalId} caractères au plus.`, `The person’s id in YOUR tool (CRM, marketing platform), kept on the record. Unique per workspace, ${BORNES.externalId} characters at most.`)] },
            { cle: 'phone', cellules: [<C key="k">phone</C>, t('Le numéro, au format international (+33…). Un numéro sans indicatif est lu comme français.', 'The phone number, in international format (+33…). A number without a country code is read as French.')] },
            { cle: 'bsuid', cellules: [<C key="k">bsuid</C>, t('L’identifiant WhatsApp d’une personne qui écrit sous un nom d’utilisateur, sans numéro visible.', 'The WhatsApp id of a person writing under a username, with no visible number.')] },
          ]}
        />
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('Au moins une clé, sinon', 'At least one key, otherwise')} <Code c="invalid_recipient" /> ; {t('un numéro illisible :', 'an unreadable number:')} <Code c="invalid_phone" />.</li>
          <li>
            {t('Toutes les clés données désignent LA MÊME fiche, sinon', 'All the keys given must designate THE SAME record, otherwise')}{' '}
            <Code c="identity_conflict" /> {t('et la fiche n’est pas modifiée.', 'and the record is not changed.')}
          </li>
          <li>
            {t(
              'Une clé que la fiche ne porte pas encore lui est RATTACHÉE : envoyer votre externalId avec le numéro suffit à le poser. contactId, lui, ne se rattache jamais : il existe, ou il est inconnu.',
              'A key the record does not carry yet is ATTACHED to it: sending your externalId along with the phone number is enough to set it. contactId is never attached: it exists, or it is unknown.',
            )}
          </li>
          <li>
            {t(
              'Aucune fiche trouvée : elle est créée seulement si la route crée, et si un phone ou un bsuid est donné. Sinon',
              'No record found: one is created only if the route creates records, and only if a phone or a bsuid is given. Otherwise',
            )}{' '}
            <Code c="unknown_contact" />.
          </li>
          <li>
            {t(
              'L’adresse d’envoi vient toujours de la FICHE, jamais de la clé reçue : en WhatsApp, le numéro, sinon le BSUID ; en RCS, le numéro, toujours (une fiche sans numéro est refusée en',
              'The sending address always comes from the RECORD, never from the key received: on WhatsApp, the phone number, otherwise the BSUID; on RCS, the phone number, always (a record without a number is refused with',
            )}{' '}
            <Code c="no_phone" />).
          </li>
        </ul>
      </Section>

      <Section id="contacts" titre={t('Contacts', 'Contacts')}>
        <Verb method="POST" path="/v1/contacts" droit="contacts:write" />
        <Bloc>{json(EXEMPLES_CORPS.contactCreer.corps)}</Bloc>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'La fiche se trouve par les règles ci-dessus, et cette route CRÉE : une fiche neuve exige phone ou bsuid. Un externalId seul et inconnu rend 404',
              'The record is found by the rules above, and this route CREATES records: a new record requires phone or bsuid. An unknown externalId alone returns 404',
            )}{' '}
            <Code c="unknown_contact" />.
          </li>
          <li>{t('fields : adressés par clé technique ou par code fld_. Un champ inconnu est créé en texte.', 'fields: addressed by technical key or by fld_ code. An unknown field is created as text.')}</li>
          <li>{t('tags : ils s’AJOUTENT, n’en retirent jamais (pour retirer, PATCH).', 'tags: they are ADDED, never removed (to remove, use PATCH).')}</li>
          <li>
            {t(
              'consent : opted_in ou opted_out, absent = inchangé. opted_out est un vrai désabonnement (statut, date, trace dans le journal d’audit). opted_in ne lève JAMAIS un STOP : sur une fiche désabonnée, 409',
              'consent: opted_in or opted_out, absent = unchanged. opted_out is a real opt-out (status, date, audit log entry). opted_in NEVER lifts a STOP: on an opted-out record, 409',
            )}{' '}
            <Code c="opted_out" />
            {t(
              ', et rien n’est modifié ; seul un opérateur ou la personne elle-même peut la réabonner. consentSource dit d’où vient le consentement.',
              ', and nothing is changed; only an operator or the person themselves can re-subscribe them. consentSource says where the consent comes from.',
            )}
          </li>
        </ul>
        <p>{t('Réponse 200 :', '200 response:')}</p>
        <Bloc>{json(EXEMPLES_REPONSES.contactEcrit)}</Bloc>

        <Verb method="POST" path="/v1/contacts/batch" droit="contacts:write" />
        <Bloc>{json(EXEMPLES_CORPS.contactsLot.corps)}</Bloc>
        <p>
          {t(
            `${BORNES.contactsParLot} fiches au plus par appel, le même corps par élément. Un élément refusé ne fait pas tomber les autres : chaque résultat porte l’index de son élément, et un refus porte son code et sa raison. Réponse 200 :`,
            `${BORNES.contactsParLot} records at most per call, the same body per item. A refused item does not sink the others: each result carries its item’s index, and a refusal carries its code and reason. 200 response:`,
          )}
        </p>
        <Bloc>{json(EXEMPLES_REPONSES.contactsLot)}</Bloc>

        <Verb method="GET" path="/v1/contacts/{contactId}" droit="contacts:read" />
        <Bloc>{json(EXEMPLES_REPONSES.contactLu)}</Bloc>
        <p>
          {t(
            'reachability : true ou false quand on le sait (un envoi l’a appris), null sinon. Une fiche inconnue ou supprimée rend 404',
            'reachability: true or false when known (a send taught us), null otherwise. An unknown or deleted record returns 404',
          )}{' '}
          <Code c="unknown_contact" />.
        </p>

        <Verb method="POST" path="/v1/contacts/search" droit="contacts:read" />
        <Bloc>{json(EXEMPLES_CORPS.contactRechercher.corps)}</Bloc>
        <p>
          {t(
            'Exactement une clé parmi phone, bsuid, externalId : c’est une recherche, rien n’est rattaché. Le numéro voyage dans le corps, jamais dans l’adresse, qui s’inscrirait dans les journaux d’accès. Réponse 200, contact vaut null quand rien ne correspond :',
            'Exactly one key among phone, bsuid, externalId: it is a lookup, nothing is attached. The phone number travels in the body, never in the URL, which would end up in access logs. 200 response, contact is null when nothing matches:',
          )}
        </p>
        <Bloc>{json(EXEMPLES_REPONSES.contactTrouve)}</Bloc>

        <Verb method="PATCH" path="/v1/contacts/{contactId}" droit="contacts:write" />
        <Bloc>{json(EXEMPLES_CORPS.contactModifier.corps)}</Bloc>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('Tout est optionnel : name, fields, addTags, removeTags, consent, consentSource, externalId.', 'Everything is optional: name, fields, addTags, removeTags, consent, consentSource, externalId.')}</li>
          <li>{t('Dans fields, une valeur null VIDE le champ ; les autres se fusionnent.', 'In fields, a null value CLEARS the field; the others are merged.')}</li>
          <li>
            {t('externalId se pose ou se remplace ; déjà porté par une autre fiche : 409', 'externalId is set or replaced; already carried by another record: 409')}{' '}
            <Code c="identity_conflict" />.
          </li>
          <li>{t('Le numéro et le BSUID ne se modifient pas ici : ils portent les conversations.', 'The phone number and BSUID cannot be changed here: they carry the conversations.')}</li>
        </ul>
        <p>{t('Réponse 200 :', '200 response:')}</p>
        <Bloc>{json(EXEMPLES_REPONSES.contactModifie)}</Bloc>
      </Section>

      <Section id="message-simple" titre={t('Envoyer un message simple', 'Send a plain message')}>
        <p>
          {t(
            'Un TEXTE, à UNE personne, tout de suite. Le message apparaît dans l’Inbox, et écrire PREND le fil : le scénario cesse d’avancer seul, l’agent de Meta cesse de répondre. La personne doit déjà avoir une fiche : ces routes n’en créent pas. Pas de clé d’idempotence : rejouer l’appel envoie un second message.',
            'One TEXT, to ONE person, right away. The message shows in the Inbox, and writing TAKES the thread: the scenario stops advancing on its own, the Meta agent stops replying. The person must already have a record: these routes do not create one. No idempotency key: replaying the call sends a second message.',
          )}
        </p>
        <p>{t('Réponse 200 des deux routes :', '200 response of both routes:')}</p>
        <Bloc>{json(EXEMPLES_REPONSES.messageEnvoye)}</Bloc>

        <SousTitre>WhatsApp</SousTitre>
        <Verb method="POST" path="/v1/messages/whatsapp" droit="sends:create" />
        <Bloc>{json(EXEMPLES_CORPS.messageWhatsapp.corps)}</Bloc>
        <p>
          {t(
            `Une clé de fiche, et un texte de ${BORNES.texteWhatsapp} caractères au plus. Les refus, dans l’ordre : fiche inconnue 404`,
            `A record key, and a text of ${BORNES.texteWhatsapp} characters at most. Refusals, in order: unknown record 404`,
          )}{' '}
          <Code c="unknown_contact" />, {t('bloquée ou sans adresse WhatsApp 409', 'blocked or without a WhatsApp address 409')} <Code c="blocked_contact" />,{' '}
          {t('fenêtre de 24 h fermée 422', '24-hour window closed 422')} <Code c="window_closed" />, {t('désabonnée 409', 'opted out 409')} <Code c="opted_out" />,{' '}
          {t('espace sans numéro WhatsApp 409', 'workspace without a WhatsApp number 409')} <Code c="no_whatsapp_number" />.
        </p>
        <p className="text-ink-500">
          {t(
            'La fenêtre de 24 h est une règle de Meta : elle s’ouvre quand la personne vous écrit et se referme 24 h après son dernier message. Hors fenêtre, le seul chemin est un template (POST /v1/sends).',
            'The 24-hour window is a Meta rule: it opens when the person writes to you and closes 24 hours after their last message. Outside it, the only path is a template (POST /v1/sends).',
          )}
        </p>

        <SousTitre>RCS</SousTitre>
        <Verb method="POST" path="/v1/messages/rcs" droit="sends:create" />
        <Bloc>{json(EXEMPLES_CORPS.messageRcs.corps)}</Bloc>
        <p>
          {t(
            `Même corps, texte de ${BORNES.texteRcs} caractères au plus, et pas de fenêtre. Les conditions, dans l’ordre :`,
            `Same body, text of ${BORNES.texteRcs} characters at most, and no window. The conditions, in order:`,
          )}
        </p>
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
        <p className="text-ink-500">
          {t(
            'La joignabilité RCS ne se connaît qu’après coup : le premier message vers un numéro sans RCS est accepté, son échec est enregistré (visible dans Sécurité > Journal des erreurs), et le suivant est refusé en',
            'RCS reachability is only known afterwards: the first message to a number without RCS is accepted, its failure is recorded (visible in Security > Error log), and the next one is refused with',
          )}{' '}
          <Code c="rcs_unreachable" />.
        </p>
      </Section>

      <Section id="envoi" titre={t('Déclencher un envoi', 'Trigger a send')}>
        <p>
          {t(
            `Un envoi est un LOT : ${BORNES.destinatairesParEnvoi} destinataires au plus, asynchrone, idempotent, visible dans Campagnes, et suivi par GET /v1/sends/{sendId}.`,
            `A send is a LIST: ${BORNES.destinatairesParEnvoi} recipients at most, asynchronous, idempotent, visible in Campaigns, and followed with GET /v1/sends/{sendId}.`,
          )}
        </p>
        <Verb method="POST" path="/v1/sends" droit="sends:create" />
        <Bloc>{json(EXEMPLES_CORPS.envoiTemplate.corps)}</Bloc>

        <SousTitre>{t('La cible, et le canal qu’elle donne', 'The target, and the channel it gives')}</SousTitre>
        <Tableau
          entetes={[t('Cible', 'Target'), t('Désignée par', 'Designated by'), t('Canal', 'Channel')]}
          lignes={[
            { cle: 'template', cellules: [<C key="c">template</C>, t('le nom et la langue d’un template approuvé (GET /v1/templates)', 'the name and language of an approved template (GET /v1/templates)'), 'WhatsApp'] },
            { cle: 'scenario', cellules: [<C key="c">scenario</C>, t('son code scn_ ou son nom (GET /v1/scenarios)', 'its scn_ code or its name (GET /v1/scenarios)'), t('celui de son premier envoi', 'that of its first send')] },
            { cle: 'node', cellules: [<C key="c">node</C>, t('le code nod_ d’un bloc (Contenu > Blocs, ou entryNode dans GET /v1/scenarios)', 'the nod_ code of a block (Content > Blocks, or entryNode in GET /v1/scenarios)'), t('celui de son premier envoi', 'that of its first send')] },
            { cle: 'rcsMessage', cellules: [<C key="c">rcsMessage</C>, t('le nom d’un message de Contenu > Messages RCS (GET /v1/rcs-messages)', 'the name of a message in Content > RCS messages (GET /v1/rcs-messages)'), 'RCS'] },
          ]}
        />

        <SousTitre>{t('Ce qu’un scénario ou un bloc envoie en premier', 'What a scenario or a block sends first')}</SousTitre>
        <p>
          {t(
            'Ce n’est pas le type du bloc visé qui compte, c’est le PREMIER message qu’il fait partir. La réponse le rend dans opening :',
            'What counts is not the type of the targeted block, it is the FIRST message it sends. The response returns it in opening:',
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
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'Un SCÉNARIO dont l’ouverture est whatsapp_session est refusé : pour parler à quelqu’un dans sa fenêtre, visez son bloc d’entrée (cible node, le code est dans entryNode). Un scénario jamais publié est refusé aussi : un envoi joue la version publiée.',
              'A SCENARIO whose opening is whatsapp_session is refused: to talk to someone within their window, target its entry block (node target, the code is in entryNode). A never-published scenario is refused too: a send plays the published version.',
            )}
          </li>
          <li>{t('Un BLOC admet les trois ouvertures.', 'A BLOCK accepts all three openings.')}</li>
          <li>{t('Prudence : si UNE branche peut envoyer un message de session, la fenêtre est exigée pour tous.', 'Caution: if ONE branch can send a session message, the window is required for everyone.')}</li>
        </ul>

        <SousTitre>{t('Les destinataires', 'Recipients')}</SousTitre>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              `recipients : ${BORNES.destinatairesParEnvoi} au plus, chacun avec ses clés de fiche (contactId, externalId, phone, bsuid), et en option consent, consentSource et variables.`,
              `recipients: ${BORNES.destinatairesParEnvoi} at most, each with its record keys (contactId, externalId, phone, bsuid), and optionally consent, consentSource and variables.`,
            )}
          </li>
          <li>
            {t(
              'L’envoi CRÉE la fiche d’un destinataire inconnu qui porte un phone (un template ou un RCS part vers quelqu’un qui n’a pas écrit), sauf pour une ouverture whatsapp_session, où il est écarté faute de fenêtre possible. Un inconnu qui ne porte qu’un bsuid est écarté aussi :',
              'The send CREATES the record of an unknown recipient carrying a phone (a template or an RCS goes to someone who has not written), except for a whatsapp_session opening, where it is skipped since no window is possible. An unknown recipient carrying only a bsuid is skipped too:',
            )}{' '}
            <Code c="unknown_contact" />.
          </li>
          <li>
            {t(
              'consent par destinataire : écrit sur la fiche AVANT le tri, avec le même sens que sur /v1/contacts. Un opted_out désabonne et écarte ce destinataire. consentSource absent vaut api.',
              'Per-recipient consent: written on the record BEFORE filtering, with the same meaning as on /v1/contacts. An opted_out opts the record out and skips this recipient. A missing consentSource defaults to api.',
            )}
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
        </ul>

        <SousTitre>{t('Les paramètres et les variables', 'Parameters and variables')}</SousTitre>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'params : une entrée par variable du template qui part, positions 1 à N sans trou. Sa source : un champ de la fiche (field), un attribut (attribute : name, phone, bsuid ou wa_id), la date du jour (now), un texte fixe (literal) ou une variable du destinataire (variable) ; en option, une valeur de repli (fallback). Il en faut EXACTEMENT autant que le corps du template a de variables : GET /v1/templates les liste, sinon 422',
              'params: one entry per variable of the template that goes out, positions 1 to N with no gap. Its source: a record field (field), an attribute (attribute: name, phone, bsuid or wa_id), today’s date (now), a fixed text (literal) or a recipient variable (variable); optionally, a fallback value (fallback). There must be EXACTLY as many as the template body has variables: GET /v1/templates lists them, otherwise 422',
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
              'Scénario qui ouvre par un template : params paramètre CE template (openingTemplate dans GET /v1/scenarios), avec toute source sauf variable (400',
              'Scenario that opens with a template: params parameterizes THAT template (openingTemplate in GET /v1/scenarios), with any source except variable (400',
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
        </ul>

        <SousTitre>{t('Catégorie, numéro, débit', 'Category, number, throughput')}</SousTitre>
        <ul className="list-disc space-y-1 pl-5">
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
        </ul>

        <SousTitre>{t('Idempotence', 'Idempotency')}</SousTitre>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'La clé est OBLIGATOIRE, en en-tête (Idempotency-Key) OU dans le corps (idempotencyKey). Les deux présentes et différentes : 400',
              'The key is REQUIRED, as a header (Idempotency-Key) OR in the body (idempotencyKey). Both present and different: 400',
            )}{' '}
            <Code c="invalid_body" />. {t('Sans clé : 400', 'No key: 400')} <Code c="idempotency_key_required" />.
          </li>
          <li>
            {t(
              'La même clé avec le même corps rend le rapport du premier appel sans rien renvoyer : un nouvel essai réseau est sans danger. La même clé avec un AUTRE corps : 422',
              'The same key with the same body returns the first call’s report without sending anything again: a network retry is safe. The same key with a DIFFERENT body: 422',
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
        </ul>
        <Bloc>{`Idempotency-Key: ${EXEMPLES_CORPS.envoiTemplate.corps.idempotencyKey}`}</Bloc>

        <SousTitre>{t('La réponse 201', 'The 201 response')}</SousTitre>
        <Bloc>{json(EXEMPLES_REPONSES.envoiCree)}</Bloc>
        <p>
          {t(
            `Chaque écart porte l’index du destinataire dans recipients, quelle que soit la clé utilisée. La liste est tronquée à ${BORNES.ecartsDetailles} entrées ; skippedTotal donne le compte réel.`,
            `Each skip carries the recipient’s index in recipients, whatever key was used. The list is capped at ${BORNES.ecartsDetailles} entries; skippedTotal gives the real count.`,
          )}
        </p>

        <Verb method="GET" path="/v1/sends/{sendId}" droit="sends:create" />
        <Bloc>{json(EXEMPLES_REPONSES.envoiSuivi)}</Bloc>
        <p>
          {t(
            'Le statut de l’envoi, ses compteurs, et une ligne par destinataire (recipientsTotal donne leur nombre quand la liste est tronquée). error vaut un objet message et metaCode quand un envoi a échoué. Pour un scénario ou un bloc, la ligne décrit le DÉPART du parcours et channel son canal d’ouverture ; la suite se lit dans la console. Envoi inconnu : 404',
            'The send’s status, its counters, and one row per recipient (recipientsTotal gives their number when the list is capped). error is an object with message and metaCode when a send failed. For a scenario or a block, the row describes the START of the journey and channel its opening channel; the rest is read in the console. Unknown send: 404',
          )}{' '}
          <Code c="send_not_found" />.
        </p>

        <SousTitre>{t('Les autres cibles', 'The other targets')}</SousTitre>
        <p>
          {t(
            'Un scénario qui ouvre par un template (ses deux params), un bloc dans la fenêtre, un message RCS de la bibliothèque :',
            'A scenario that opens with a template (its two params), a block within the window, an RCS message from the library:',
          )}
        </p>
        <Bloc>{json(EXEMPLES_CORPS.envoiScenario.corps)}</Bloc>
        <Bloc>{json(EXEMPLES_CORPS.envoiBloc.corps)}</Bloc>
        <Bloc>{json(EXEMPLES_CORPS.envoiRcs.corps)}</Bloc>
      </Section>

      <Section id="catalogues" titre={t('Ce que vous pouvez envoyer', 'What you can send')}>
        <p>
          {t(
            'Trois lectures, droit sends:create, pour construire un appel sans ouvrir la console. Chaque template et chaque message RCS listé peut partir par POST /v1/sends ; un scénario listé dit, par opening, s’il le peut et comment.',
            'Three reads, sends:create scope, to build a call without opening the console. Every template and every RCS message listed can go out through POST /v1/sends; a listed scenario says, through opening, whether it can and how.',
          )}
        </p>
        <Verb method="GET" path="/v1/templates" droit="sends:create" />
        <Bloc>{json(EXEMPLES_REPONSES.templates)}</Bloc>
        <p>
          {t(
            'Les templates WhatsApp APPROUVÉS qu’un envoi sait faire partir. N’y figurent pas ceux qu’un envoi refuserait, ni ceux que Meta refuserait faute d’une valeur que rien ne fournit : une catégorie autre que marketing ou utility, un en-tête de localisation ou un en-tête texte à variable, un bouton de lien dont l’adresse porte une variable (hors liens de suivi des clics posés par la console), un carrousel dont une carte ou un lien porte une variable, un visuel (d’en-tête ou de carte) que nous ne pouvons pas relire. variables liste chaque variable du corps, donc chaque entrée attendue dans params ; source est le champ que la console lui associe quand elle le connaît (null sinon), et il se recopie tel quel dans params. Un carrousel a ses visuels par carte : son header vaut none. Cette lecture interroge Meta : une panne y rend une erreur, jamais une liste vide (voir Erreurs).',
            'The APPROVED WhatsApp templates a send can deliver. Left out are those a send would refuse, and those Meta would refuse for lack of a value nothing provides: a category other than marketing or utility, a location header or a text header with a variable, a link button whose URL carries a variable (except the click-tracking links the console sets), a carousel whose card or link carries a variable, a visual (header or card) we cannot read back. variables lists each variable of the body, hence each entry expected in params; source is the field the console associates with it when known (null otherwise), and it can be copied as is into params. A carousel has its visuals per card: its header is none. This read queries Meta: an outage returns an error, never an empty list (see Errors).',
          )}
        </p>
        <Verb method="GET" path="/v1/scenarios" droit="sends:create" />
        <Bloc>{json(EXEMPLES_REPONSES.scenarios)}</Bloc>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'Les scénarios PUBLIÉS, qu’ils puissent partir ou non. opening est calculé par la même règle que POST /v1/sends : null, il ne peut partir ni par son code ou son nom, ni par son bloc d’entrée (un autre de ses blocs, visé en cible node, est jugé pour lui-même) ; whatsapp_session, il se vise par son bloc d’entrée ; rcs ou whatsapp_template, il se vise par son code ou son nom.',
              'The PUBLISHED scenarios, whether they can go out or not. opening is computed by the same rule as POST /v1/sends: null, it cannot go out by its code or its name, nor through its entry block (another of its blocks, targeted with a node target, is judged on its own); whatsapp_session, it is targeted through its entry block; rcs or whatsapp_template, it is targeted by its code or its name.',
            )}
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
        </ul>
        <Verb method="GET" path="/v1/rcs-messages" droit="sends:create" />
        <Bloc>{json(EXEMPLES_REPONSES.messagesRcs)}</Bloc>
        <p>
          {t(
            'Les messages de Contenu > Messages RCS, désignés par leur nom dans la cible rcsMessage. kind vaut text, card ou carousel ; variables liste les noms entre doubles accolades qu’ils utilisent.',
            'The messages of Content > RCS messages, designated by their name in the rcsMessage target. kind is text, card or carousel; variables lists the names between double braces they use.',
          )}
        </p>
      </Section>

      <Section id="outil" titre={t('Brancher un outil qui appelle par contact', 'Connecting a tool that calls per contact')}>
        <p>
          {t(
            'Une plateforme d’orchestration, un CRM ou un outil marketing appelle souvent un service UNE FOIS PAR CONTACT, avec un corps rempli par les données du profil. Voici l’appel type.',
            'An orchestration platform, a CRM or a marketing tool often calls a service ONCE PER CONTACT, with a body filled from the profile data. Here is the typical call.',
          )}
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('Adresse :', 'URL:')} <C>{`POST ${ADRESSE_API}/v1/sends`}</C></li>
          <li>
            {t('En-tête :', 'Header:')} <C>{`Authorization: Bearer ${CLE_EXEMPLE}`}</C>
            {t(', avec le droit sends:create. Il est le même pour tous les contacts.', ', with the sends:create scope. It is the same for every contact.')}
          </li>
          <li>
            {t(
              'Corps : un destinataire par appel, désigné par VOTRE identifiant (externalId) et son numéro. Nous gardons l’identifiant sur la fiche : c’est lui qui la retrouve aux appels suivants.',
              'Body: one recipient per call, designated by YOUR id (externalId) and their phone number. We keep the id on the record: it is what finds the record on later calls.',
            )}
          </li>
        </ul>
        <Bloc>{json(EXEMPLES_CORPS.outilParContact.corps)}</Bloc>
        <p>{t('Trois points à régler une fois :', 'Three things to set up once:')}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {t(
              'La clé d’idempotence va dans le CORPS (idempotencyKey) : beaucoup d’outils remplissent le corps contact par contact, pas les en-têtes. Composez-la de l’identifiant du contact ET de ce qui rend CE passage unique (l’étape, la date d’entrée dans le parcours). Faite du seul identifiant du contact, elle ferait prendre le second passage légitime d’un même contact pour un rejeu : il ne partirait pas.',
              'The idempotency key goes in the BODY (idempotencyKey): many tools fill the body per contact, not the headers. Build it from the contact id AND whatever makes THIS pass unique (the step, the journey entry date). Built from the contact id alone, it would make a second legitimate pass of the same contact look like a replay: it would not go out.',
            )}
          </li>
          <li>
            {t(
              'Le consentement vit souvent dans votre outil : passez-le à chaque appel (consent, consentSource). Il est écrit sur la fiche avant le tri ; un opted_out désabonne la fiche et écarte l’envoi.',
              'Consent often lives in your tool: pass it on every call (consent, consentSource). It is written on the record before filtering; an opted_out opts the record out and skips the send.',
            )}
          </li>
          <li>
            {t(
              'variables porte ce qui est propre à ce contact (un numéro de commande, un produit). Rien n’en est écrit sur la fiche.',
              'variables carries what is specific to this contact (an order number, a product). None of it is written on the record.',
            )}
          </li>
        </ul>
        <p>
          {t(
            'Un refus (destinataire écarté, cible introuvable) se lit dans la réponse 201 ou dans le code d’erreur. Si votre outil ne lit pas les réponses, éprouvez l’appel une fois à la main :',
            'A refusal (skipped recipient, target not found) shows in the 201 response or in the error code. If your tool does not read responses, try the call once by hand:',
          )}
        </p>
        <Bloc>{curl('/v1/sends', EXEMPLES_CORPS.outilParContact.corps)}</Bloc>
      </Section>

      <Section id="erreurs" titre={t('Erreurs', 'Errors')}>
        <p>{t('Un refus de l’API a cette forme :', 'A refusal from the API has this shape:')}</p>
        <Bloc>{json(EXEMPLES_REPONSES.erreur)}</Bloc>
        <p>
          {t(
            'error est une phrase en français, pour un humain ; code est un identifiant stable, pour un programme. Un même refus porte le même code partout, qu’il arrive en erreur ou en motif d’écart d’un envoi. Un défaut de forme d’un corps JSON lisible est invalid_body, avec le champ fautif dans le message ; une clé de fiche absente ou illisible a ses propres codes (invalid_recipient, invalid_phone).',
            'error is a sentence in French, for a human; code is a stable identifier, for a program. The same refusal carries the same code everywhere, whether it comes as an error or as a skip reason in a send. A shape defect in a readable JSON body is invalid_body, with the faulty field in the message; a missing or unreadable record key has its own codes (invalid_recipient, invalid_phone).',
          )}
        </p>
        <p className="text-ink-500">
          {t(
            'Trois cas n’ont PAS de code, dites-les à votre programme :',
            'Three cases have NO code, tell your program about them:',
          )}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-ink-500">
          <li>
            {t(
              'Un refus de Meta lui-même, pendant la lecture de GET /v1/templates ou l’envoi de POST /v1/messages/whatsapp : 422, et le corps ne porte que error, une phrase qui commence par « Meta: ».',
              'A refusal from Meta itself, while GET /v1/templates is being read or POST /v1/messages/whatsapp is being sent: 422, and the body only carries error, a sentence starting with “Meta:”.',
            )}
          </li>
          <li>
            {t(
              'Une panne (Meta injoignable, ou une erreur de notre côté) : 500, un corps sans code, qui peut arriver sous la forme d’une page d’erreur générique. Réessayez dans un instant ; un envoi se rejoue avec la même clé d’idempotence.',
              'An outage (Meta unreachable, or an error on our side): 500, a body without a code, which may come as a generic error page. Retry in a moment; a send is replayed with the same idempotency key.',
            )}
          </li>
          <li>
            {t(
              'Un corps qui n’est pas du JSON : envoyez toujours Content-Type: application/json. Un autre type de corps peut être refusé avant nos règles (415, sans code), et un JSON illisible est aujourd’hui lu comme un objet vide : le refus nomme alors ce qui manque, pas la syntaxe.',
              'A body that is not JSON: always send Content-Type: application/json. Another body type may be refused before our rules (415, no code), and an unreadable JSON is currently read as an empty object: the refusal then names what is missing, not the syntax.',
            )}
          </li>
        </ul>
        <p className="text-ink-500">
          {t(
            'Les statuts : 400 corps invalide ; 401 et 403 la clé ; 404 introuvable ; 409 l’état de la fiche ou de l’espace l’interdit ; 422 la demande est juste mais ne peut pas partir ainsi ; 429 le débit.',
            'Statuses: 400 invalid body; 401 and 403 the key; 404 not found; 409 the state of the record or workspace forbids it; 422 the request is valid but cannot go out like this; 429 rate limit.',
          )}
        </p>
        <Tableau
          entetes={[t('Code', 'Code'), t('Erreur', 'Error'), t('Motif d’écart', 'Skip reason'), t('Ce que ça veut dire', 'Meaning')]}
          lignes={CODES_DOCUMENTES.map((c) => ({
            cle: c.code,
            cellules: [
              <code key="c" data-testid={`code-${c.code}`} className={inlineCls}>{c.code}</code>,
              c.statut === null ? '' : String(c.statut),
              c.ecart ? t('oui', 'yes') : '',
              t(c.quoi[0], c.quoi[1]),
            ],
          }))}
        />
      </Section>

      <Section id="exemples" titre={t('Exemples complets', 'Full examples')}>
        <SousTitre>{t('Un message WhatsApp dans la fenêtre', 'A WhatsApp message within the window')}</SousTitre>
        <Bloc>{curl('/v1/messages/whatsapp', EXEMPLES_CORPS.messageWhatsapp.corps)}</Bloc>
        <SousTitre>{t('Un message RCS', 'An RCS message')}</SousTitre>
        <Bloc>{curl('/v1/messages/rcs', EXEMPLES_CORPS.messageRcs.corps)}</Bloc>
        <SousTitre>{t('Un template, avec une variable par destinataire', 'A template, with one variable per recipient')}</SousTitre>
        <Bloc>{curl('/v1/sends', EXEMPLES_CORPS.envoiTemplate.corps)}</Bloc>
        <SousTitre>{t('Un message RCS de la bibliothèque', 'An RCS message from the library')}</SousTitre>
        <Bloc>{curl('/v1/sends', EXEMPLES_CORPS.envoiRcs.corps)}</Bloc>
      </Section>

      {/* LES SIGNAUX QUE LA CONSOLE REMONTE VERS L'OUTIL DU CLIENT (lot 6), en dernier : c'est l'autre sens du
          branchement. Sa liste est tenue au dictionnaire du serveur par `tests/web-signaux-parite.test.ts`. */}
      <DocSignaux />
    </div>
  );
}
