'use client';

import { AppShell } from '@/components/AppShell';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { BASE } from '@/lib/http';

/**
 * L'adresse PUBLIQUE de l'API, telle qu'un intégrateur doit la taper.
 *
 * ⚠️ Dérivée de la MÊME source que les appels de la console (`BASE`), et surtout pas réécrite à la main : ces
 * deux lignes portaient `https://mba.messagingme.app/api/backend/v1` en dur. Un intégrateur qui aurait copié
 * cette adresse après la bascule aurait construit son intégration sur un chemin mort, et l'aurait découvert
 * en production, chez lui.
 *
 * Le repli conserve l'adresse historique tant que la variable n'est pas posée : le préfixe `/api/backend` est
 * alors juste, puisque c'est bien le proxy qui sert l'API.
 */
const ADRESSE_API = BASE.startsWith('http') ? BASE : 'https://mba.messagingme.app/api/backend';

/**
 * Documentation de l'API publique /v1.
 *
 * Le contenu est ECRIT A LA MAIN a partir du code des routes (`src/http/v1-contacts.ts`, `src/http/v1-sends.ts`,
 * `src/auth/api-key.ts`) : bornes, messages d'erreur et codes de statut sont ceux que le serveur renvoie
 * vraiment. Si une route change, cette page ment jusqu'a ce qu'on la corrige, il n'y a pas de generation
 * automatique derriere. C'est le compromis assume : une page lisible plutot qu'un Swagger brut.
 */
export default function ApiDocsPage() {
  return <AppShell active="api-docs">{() => <DocsInner />}</AppShell>;
}

const codeCls = 'overflow-x-auto rounded-lg bg-ink-900 px-4 py-3 font-mono text-xs leading-relaxed text-ink-50';
const inlineCls = 'rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.8em] text-ink-800';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{title}</h3>
      <div className="mt-3 space-y-3 text-sm text-ink-700">{children}</div>
    </section>
  );
}
function Verb({ method, path }: { method: string; path: string }) {
  return (
    <p className="font-mono text-xs">
      <span className="rounded bg-brand-50 px-1.5 py-0.5 font-semibold text-brand-700">{method}</span>
      <span className="ml-2 text-ink-800">{path}</span>
    </p>
  );
}

function DocsInner() {
  const t = useT();
  const C = ({ children }: { children: React.ReactNode }) => <code className={inlineCls}>{children}</code>;

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Documentation API', 'API documentation')}</h2>
        <p className="mt-1 text-sm text-ink-500">
          {t(
            'API REST pour créer des contacts et déclencher des envois depuis tes propres outils.',
            'REST API to create contacts and trigger sends from your own tools.',
          )}{' '}
          <Link href="/developers/keys" className="text-brand-600 hover:underline">{t('Gérer les clés', 'Manage keys')}</Link>
        </p>
      </div>

      <Section title={t('Adresse et authentification', 'Base URL and authentication')}>
        <p>{t('Toutes les routes sont sous :', 'All routes live under:')}</p>
        <pre className={codeCls}>{`${ADRESSE_API}/v1`}</pre>
        <p>
          {t(
            'Chaque appel porte sa clé dans l\'en-tête Authorization. Le compte est déduit de la clé : il n\'y a jamais d\'identifiant de compte dans l\'URL.',
            'Every call carries its key in the Authorization header. The account is derived from the key: there is never an account id in the URL.',
          )}
        </p>
        <pre className={codeCls}>Authorization: Bearer mba_xxxxxxxxxxxxxxxx</pre>
        <p className="text-ink-500">
          {t(
            'Une valeur qui ne commence pas par mba_ est refusée sans même être comparée en base. Clé absente ou invalide : 401.',
            'A value not starting with mba_ is refused without even being checked against the database. Missing or invalid key: 401.',
          )}
        </p>
      </Section>

      <Section title={t('Débit', 'Rate limit')}>
        <p>
          {t(
            'Par défaut 60 requêtes par minute et par clé. Chaque réponse comptée sur votre clé porte l\'état de son compteur :',
            'By default 60 requests per minute per key. Every response counted against your key carries its counter state:',
          )}
        </p>
        <pre className={codeCls}>{`x-ratelimit-limit: 60
x-ratelimit-remaining: 57
x-ratelimit-reset: 1750000000`}</pre>
        <p>
          {t(
            'Au dépassement : 429 avec un en-tête retry-after (en secondes). Une clé inconnue (401) ne porte aucun de ces en-têtes. Le compteur est tenu en mémoire du serveur : il repart à zéro à chaque redéploiement.',
            'On overflow: 429 with a retry-after header (seconds). An unknown key (401) carries none of these headers. The counter is held in server memory: it resets on every redeploy.',
          )}
        </p>
      </Section>

      <Section title={t('Créer ou mettre à jour un contact', 'Create or update a contact')}>
        <p className="text-ink-500">{t('Droit requis', 'Required scope')} : <C>contacts:write</C></p>
        <Verb method="POST" path="/v1/contacts" />
        <pre className={codeCls}>{`{
  "phone": "+33612345678",
  "name": "Camille Roy",
  "fields": { "ville": "Lyon" },
  "tags": ["prospect"],
  "optIn": true
}`}</pre>
        <p>
          {t('Seul', 'Only')} <C>phone</C> {t('est obligatoire. Réponse 200 :', 'is required. 200 response:')}{' '}
          <C>{'{ "contactId": "...", "status": "created" | "updated" }'}</C>
        </p>
        <p className="text-ink-500">
          {t(
            'Un champ inconnu dans fields est créé automatiquement en champ texte. Les champs s\'adressent par leur clé technique.',
            'An unknown key in fields is auto-created as a text field. Fields are addressed by their technical key.',
          )}
        </p>
        <Verb method="POST" path="/v1/contacts/batch" />
        <pre className={codeCls}>{`{ "contacts": [ { "phone": "+33612345678" }, { "phone": "+33698765432" } ] }`}</pre>
        <p>
          {t('500 contacts maximum par lot. Réponse 200 :', 'Maximum 500 contacts per batch. 200 response:')}{' '}
          <C>{'{ results, created, updated, errors }'}</C>
          {t(
            ", où chaque résultat porte son index d'origine et, en cas d'échec, sa raison. Un contact en erreur n'empêche pas les autres de passer.",
            ', where each result carries its original index and, on failure, its reason. One failing contact does not stop the others.',
          )}
        </p>
      </Section>

      <Section title={t('Déclencher un envoi', 'Trigger a send')}>
        <p className="text-ink-500">{t('Droit requis', 'Required scope')} : <C>sends:create</C></p>
        <Verb method="POST" path="/v1/sends" />
        <p>
          {t('L\'en-tête', 'The')} <C>Idempotency-Key</C>{' '}
          {t(
            'est OBLIGATOIRE. Rejouer le même appel avec la même clé ne renvoie pas un second envoi : il renvoie le rapport du premier. C\'est ce qui rend un retry réseau sans danger.',
            'header is REQUIRED. Replaying the same call with the same key does not produce a second send: it returns the first one\'s report. That is what makes a network retry safe.',
          )}
        </p>
        <pre className={codeCls}>{`POST /v1/sends
Authorization: Bearer mba_...
Idempotency-Key: commande-8412

{
  "target": { "template": { "name": "confirmation", "language": "fr" } },
  "category": "utility",
  "recipients": ["+33612345678"],
  "params": [{ "position": 1, "source": { "type": "attribute", "key": "name" } }],
  "ratePerMinute": 20
}`}</pre>
        <p>{t('Trois cibles possibles :', 'Three possible targets:')}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li><C>{'{ "template": { "name": "...", "language": "fr" } }'}</C> {t('un template approuvé', 'an approved template')}</li>
          <li><C>{'{ "scenario": "scn_..." }'}</C> {t('un scénario, par code ou par nom', 'a scenario, by code or by name')}</li>
          <li>
            <C>{'{ "node": "nod_..." }'}</C>{' '}
            {t(
              'un bloc précis d\'un scénario. Réservé à la fenêtre de 24 h : un contact qui n\'a pas écrit récemment est écarté en out_of_window, jamais forcé.',
              'a specific block of a scenario. Restricted to the 24-hour window: a contact who has not written recently is skipped as out_of_window, never forced.',
            )}
          </li>
        </ul>
        <p>{t('50 destinataires maximum par appel. Réponse 201 :', 'Maximum 50 recipients per call. 201 response:')}</p>
        <pre className={codeCls}>{`{
  "sendId": "...",
  "recipientCount": 2,
  "created": 1,
  "matched": 1,
  "skipped": [{ "phone": "+33698765432", "reason": "not_opted_in" }],
  "skippedTotal": 1
}`}</pre>
        <p>
          {t(
            'Un numéro écarté est toujours motivé, jamais perdu en silence. Motifs :',
            'A skipped number always carries a reason, never silently dropped. Reasons:',
          )}{' '}
          <C>not_opted_in</C>, <C>invalid_phone</C>, <C>out_of_window</C>, <C>unknown_contact</C>, <C>missing_variable</C>.
          {' '}
          {t(
            'La liste détaillée est tronquée à 200 entrées ; skippedTotal donne le compte réel.',
            'The detailed list is capped at 200 entries; skippedTotal gives the real count.',
          )}
        </p>
        <Verb method="GET" path="/v1/sends/:sendId" />
        <p>
          {t(
            'Suivi d\'un envoi : statut global et une ligne par destinataire (statut, identifiant de message, erreur, état de livraison).',
            'Follow-up on a send: overall status plus one row per recipient (status, message id, error, delivery state).',
          )}
        </p>
      </Section>

      <Section title={t('Envoyer un simple message', 'Send a plain message')}>
        <p className="text-ink-500">{t('Droit requis', 'Required scope')} : <C>sends:create</C></p>
        <Verb method="POST" path="/v1/messages" />
        <p>
          {t(
            'Un texte, a une personne, dans la fenetre de service de 24 h : c\'est le pendant exact de la barre de reponse de l\'Inbox. Pas de template a faire approuver, pas de scenario.',
            'One text, to one person, inside the 24-hour service window: the exact counterpart of the Inbox reply bar. No template to get approved, no scenario.',
          )}
        </p>
        <pre className={codeCls}>{`{ "to": "+33612345678", "text": "Votre commande est prete." }`}</pre>
        <p>
          {t('Reponse 200 :', '200 response:')}{' '}
          <C>{'{ "messageId": "wamid...", "conversationId": "..." }'}</C>
          {t(
            ". Le message apparait dans l'Inbox comme n'importe quel envoi, et prendre la parole PREND le fil : le scenario cesse d'avancer seul et l'agent de Meta cesse de repondre sur cette conversation.",
            ". The message shows up in the Inbox like any other send, and speaking TAKES the thread: the scenario stops advancing on its own and the Meta agent stops replying on that conversation.",
          )}
        </p>
        <p className="text-ink-500">
          {t(
            'La fenetre de 24 h est une regle de Meta, pas une regle du produit : elle s\'ouvre quand la personne vous ecrit et se referme 24 h apres son dernier message. Hors fenetre, la reponse est un 422 portant le code window_closed, et le seul chemin restant est un template (POST /v1/sends).',
            'The 24-hour window is a Meta rule, not a product rule: it opens when the person writes to you and closes 24 hours after their last message. Outside it, the answer is a 422 carrying code window_closed, and the only remaining path is a template (POST /v1/sends).',
          )}
        </p>
        <p className="text-ink-500">
          {t(
            'Trois refus explicites plutot qu\'un envoi silencieux : 404 contact_inconnu (ce numero n\'a jamais ecrit), 409 contact_indisponible (contact bloque ou supprime), 409 contact_desabonne (il a demande a ne plus recevoir de messages). Cette derniere garde vaut pour l\'API comme pour tout appel automatise, jamais pour un operateur qui repond a la main.',
            'Three explicit refusals rather than a silent send: 404 contact_inconnu (this number never wrote), 409 contact_indisponible (contact blocked or deleted), 409 contact_desabonne (they asked to stop receiving messages). That last guard applies to the API as to any automated call, never to an operator replying by hand.',
          )}
        </p>
        <p className="text-ink-500">
          {t(
            'Pas d\'en-tete Idempotency-Key ici, a la difference des envois : un message de session est un geste unitaire, comme un operateur qui appuie sur Envoyer. Rejouer l\'appel envoie un second message.',
            'No Idempotency-Key header here, unlike sends: a session message is a single gesture, like an operator pressing Send. Replaying the call sends a second message.',
          )}
        </p>
      </Section>

      <Section title={t('Codes d\'erreur', 'Error codes')}>
        <table className="w-full text-left text-sm">
          <tbody>
            {[
              ['400', t('Requête invalide. Le corps porte le motif exact en français.', 'Invalid request. The body carries the exact reason.')],
              ['401', t('Clé absente, mal formée, inconnue ou révoquée.', 'Key missing, malformed, unknown or revoked.')],
              ['403', t('La clé n\'a pas le droit demandé (message : scope requis : ...).', 'The key lacks the required scope (message: scope requis: ...).')],
              ['404', t('Scénario ou bloc introuvable ; envoi inconnu.', 'Scenario or block not found; unknown send.')],
              ['409', t('Envoi identique déjà en cours, nom de scénario ambigu (utilise le code scn_), ou contact bloqué / désabonné.', 'Identical send already in flight, ambiguous scenario name (use the scn_ code), or blocked / unsubscribed contact.')],
              ['422', t('Fenêtre de 24 h fermée (code window_closed) : passe par un template.', 'The 24-hour window is closed (code window_closed): use a template instead.')],
              ['429', t('Débit dépassé. Attends la durée de retry-after.', 'Rate limit exceeded. Wait for retry-after.')],
            ].map(([code, desc]) => (
              <tr key={code} className="border-b border-ink-50 last:border-0">
                <td className="py-2 pr-4 align-top font-mono text-xs font-semibold text-ink-800">{code}</td>
                <td className="py-2 text-ink-600">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={t('Exemple : un simple message', 'Example: a plain message')}>
        <pre className={codeCls}>{`curl -X POST ${ADRESSE_API}/v1/messages \\
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{ "to": "+33612345678", "text": "Votre commande est prete." }'`}</pre>
      </Section>

      <Section title={t('Exemple complet', 'Full example')}>
        <pre className={codeCls}>{`curl -X POST ${ADRESSE_API}/v1/sends \\
  -H "Authorization: Bearer mba_xxxxxxxxxxxxxxxx" \\
  -H "Idempotency-Key: commande-8412" \\
  -H "Content-Type: application/json" \\
  -d '{
    "target": { "template": { "name": "confirmation", "language": "fr" } },
    "category": "utility",
    "recipients": ["+33612345678"]
  }'`}</pre>
      </Section>
    </div>
  );
}
