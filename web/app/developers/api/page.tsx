'use client';

import { AppShell } from '@/components/AppShell';
import Link from 'next/link';
import { useT } from '@/lib/i18n';

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
        <pre className={codeCls}>https://mba.messagingme.app/api/backend/v1</pre>
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
            'Par défaut 60 requêtes par minute et par clé. Chaque réponse porte l\'état du compteur :',
            'By default 60 requests per minute per key. Every response carries the counter state:',
          )}
        </p>
        <pre className={codeCls}>{`x-ratelimit-limit: 60
x-ratelimit-remaining: 57
x-ratelimit-reset: 1750000000`}</pre>
        <p>
          {t(
            'Au dépassement : 429 avec un en-tête retry-after (en secondes). Le compteur est tenu en mémoire du serveur : il repart à zéro à chaque redéploiement.',
            'On overflow: 429 with a retry-after header (seconds). The counter is held in server memory: it resets on every redeploy.',
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

      <Section title={t('Codes d\'erreur', 'Error codes')}>
        <table className="w-full text-left text-sm">
          <tbody>
            {[
              ['400', t('Requête invalide. Le corps porte le motif exact en français.', 'Invalid request. The body carries the exact reason.')],
              ['401', t('Clé absente, mal formée, inconnue ou révoquée.', 'Key missing, malformed, unknown or revoked.')],
              ['403', t('La clé n\'a pas le droit demandé (message : scope requis : ...).', 'The key lacks the required scope (message: scope requis: ...).')],
              ['404', t('Scénario ou bloc introuvable ; envoi inconnu.', 'Scenario or block not found; unknown send.')],
              ['409', t('Envoi identique déjà en cours, ou nom de scénario ambigu (utilise le code scn_).', 'Identical send already in flight, or ambiguous scenario name (use the scn_ code).')],
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

      <Section title={t('Exemple complet', 'Full example')}>
        <pre className={codeCls}>{`curl -X POST https://mba.messagingme.app/api/backend/v1/sends \\
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
