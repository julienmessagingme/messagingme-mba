'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  Bloc, C, CLE_EXEMPLE, Code, Encadre, EnTetePage, Erreurs, LienDoc, Liste, Refus, Section, Tableau, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, CODES_DOCUMENTES, EXEMPLES_REPONSES } from '@/lib/api-exemples';
import { ENDPOINTS, type Droit } from '@/lib/api-doc-endpoints';

/**
 * AUTHENTIFICATION, LIMITES ET ERREURS : ce qui vaut pour toutes les routes. Le tableau des droits se dérive de
 * l'index des endpoints (`@/lib/api-doc-endpoints`, tenu égal aux gardes du serveur) ; le catalogue des codes
 * vient de `CODES_DOCUMENTES`, tenu égal aux codes du serveur. L'adresse garde `reference` (publiée au lot 1).
 *
 * ⚠️ LE TEXTE EST ÉCRIT À LA MAIN d'après les routes (`src/http/v1-*.ts`) : une règle qui change côté serveur ne
 * change pas ici toute seule. Les codes cités passent par `<Code>`, typé sur la table des codes : un code inventé
 * ne compile pas. Deux comportements décrits ici attendent une décision ou un correctif (`todo.md`) : le refus de
 * Meta sans `code`, et le corps JSON illisible lu comme un objet vide. Les corriger, c'est corriger cette page dans
 * le même commit.
 */
export default function ApiReferencePage() {
  return <CadreDoc page="reference">{() => <Reference />}</CadreDoc>;
}

const DROITS: ReadonlyArray<{ droit: Droit; quoi: readonly [string, string] }> = [
  { droit: 'contacts:write', quoi: ['Créer et modifier des fiches.', 'Create and update records.'] },
  { droit: 'contacts:read', quoi: ['Lire et chercher des fiches.', 'Read and find records.'] },
  { droit: 'sends:create', quoi: ['Envoyer, suivre un envoi, lire les catalogues.', 'Send, follow a send, read the catalogs.'] },
];

function Reference() {
  const t = useT();
  return (
    <>
      <EnTetePage page="reference">
        <p>{t('Valable pour toutes les routes.', 'Applies to every route.')}</p>
      </EnTetePage>

      <Section id="authentification" titre={t('Authentification et droits', 'Authentication and scopes')}>
        <Liste>
          <li>{t('Une clé par appel, dans l’en-tête Authorization. Elle commence par mba_.', 'One key per call, in the Authorization header. It starts with mba_.')}</li>
          <li>{t('L’espace se déduit de la clé : aucune adresse ne porte d’identifiant d’espace.', 'The workspace is derived from the key: no URL carries a workspace id.')}</li>
          <li>
            {t('Adresse de base :', 'Base URL:')} <LienDoc page="accueil" ancre="adresse">{t('Accueil', 'Overview')}</LienDoc>.
          </li>
        </Liste>
        <Bloc legende={t('En-tête', 'Header')}>{`Authorization: Bearer ${CLE_EXEMPLE}`}</Bloc>
        <Tableau
          entetes={[t('Droit', 'Scope'), t('Ouvre', 'Opens'), t('Routes', 'Routes')]}
          lignes={DROITS.map((d) => ({
            cle: d.droit,
            cellules: [
              <C key="d">{d.droit}</C>,
              t(d.quoi[0], d.quoi[1]),
              <span key="r" className="flex flex-col gap-0.5">
                {ENDPOINTS.filter((e) => e.droit === d.droit).map((e) => (
                  <span key={`${e.methode} ${e.chemin}`} className="whitespace-nowrap font-mono text-xs">{e.methode} {e.chemin}</span>
                ))}
              </span>,
            ],
          }))}
        />
        <Erreurs
          lignes={[
            ['unauthorized', t('Clé absente, mal formée, inconnue ou révoquée.', 'Key missing, malformed, unknown or revoked.')],
            ['missing_scope', t('Droit manquant.', 'Scope missing.')],
            ['tenant_locked', t('Espace suspendu. La clé reste valide.', 'Workspace suspended. The key remains valid.')],
          ]}
        />
        <Encadre sorte="note">
          <p>{t('Les droits d’une clé se fixent à sa création. Pour un droit de plus : une nouvelle clé.', 'A key’s scopes are set at creation. For an extra scope: a new key.')}</p>
        </Encadre>
      </Section>

      <Section id="debit" titre={t('Débit', 'Rate limit')}>
        <Tableau
          entetes={[t('Plafond par défaut, par espace', 'Default limit, per workspace'), t('Valeur', 'Value')]}
          lignes={[
            { cle: 'minute', cellules: [t('Requêtes par minute', 'Requests per minute'), String(BORNES.plafondEspaceMinute)] },
            { cle: 'heure', cellules: [t('Requêtes par heure', 'Requests per hour'), String(BORNES.plafondEspaceHeure)] },
          ]}
        />
        <Liste>
          <li>{t('Partagé par toutes les clés de l’espace et le serveur MCP.', 'Shared by all the workspace’s keys and the MCP server.')}</li>
          <li>{t(`Un appel compte pour un, quel que soit son volume (${BORNES.contactsParLot} fiches en un lot : un appel).`, `A call counts as one whatever its size (${BORNES.contactsParLot} records at once: one call).`)}</li>
          <li>{t('Plafond différent pour un espace : sur demande.', 'Different limit for a workspace: on request.')}</li>
        </Liste>
        <p>{t('Chaque réponse comptée porte le compteur le plus proche de son plafond :', 'Every counted response carries the counter closest to its limit:')}</p>
        <Bloc legende={t('En-têtes de réponse', 'Response headers')}>{`x-ratelimit-limit: ${BORNES.plafondEspaceMinute}\nx-ratelimit-remaining: 57\nx-ratelimit-reset: 1790000000`}</Bloc>
        <Tableau
          entetes={[t('En-tête', 'Header'), t('Sens', 'Meaning')]}
          lignes={[
            { cle: 'reset', cellules: [<C key="c">x-ratelimit-reset</C>, t('Heure de remise à zéro, en secondes depuis 1970.', 'Reset time, in seconds since 1970.')] },
            { cle: 'retry', cellules: [<C key="c">retry-after</C>, t('Sur un 429 : secondes avant la remise à zéro de la fenêtre pleine (minute ou heure, nommée dans le message).', 'On a 429: seconds until the full window resets (minute or hour, named in the message).')] },
          ]}
        />
        <Liste>
          <li>{t('Au dépassement :', 'On overflow:')}{' '}<Refus c="rate_limited" />{t('. Un appel refusé ne compte pas.', '. A refused call does not count.')}</li>
          <li>{t('Clé inconnue (401) : aucun de ces en-têtes.', 'Unknown key (401): none of these headers.')}</li>
        </Liste>
        <Encadre sorte="note">
          <p>{t('Compteur tenu en mémoire du serveur : il repart à zéro à chaque déploiement.', 'Counter held in server memory: it resets on every deploy.')}</p>
        </Encadre>
      </Section>

      <Section id="erreurs" titre={t('Erreurs', 'Errors')}>
        <p>{t('Forme d’un refus :', 'Shape of a refusal:')}</p>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.erreur)}</Bloc>
        <Liste>
          <li>{t('error : phrase en français, pour un humain. code : identifiant stable, pour un programme.', 'error: sentence in French, for a human. code: stable identifier, for a program.')}</li>
          <li>{t('Un refus porte le même code partout, en erreur comme en motif d’écart d’un envoi.', 'A refusal carries the same code everywhere, as an error or as a skip reason in a send.')}</li>
          <li>
            {t(
              'Corps JSON lisible mais mal formé : invalid_body, champ fautif dans le message. Clé de fiche absente ou illisible : invalid_recipient, invalid_phone.',
              'Readable but malformed JSON body: invalid_body, faulty field in the message. Missing or unreadable record key: invalid_recipient, invalid_phone.',
            )}
          </li>
        </Liste>
        <Tableau
          entetes={[t('Statut', 'Status'), t('Sens', 'Meaning')]}
          lignes={[
            { cle: '400', cellules: ['400', t('Corps invalide.', 'Invalid body.')] },
            { cle: '401', cellules: ['401', t('Clé absente ou invalide.', 'Key missing or invalid.')] },
            { cle: '403', cellules: ['403', t('Droit manquant, ou espace suspendu.', 'Scope missing, or workspace suspended.')] },
            { cle: '404', cellules: ['404', t('Fiche, envoi ou cible introuvable.', 'Record, send or target not found.')] },
            { cle: '409', cellules: ['409', t('L’état de la fiche ou de l’espace interdit l’opération : désabonnée, bloquée, sans consentement, clés contradictoires, canal ou numéro absent, nom de scénario ambigu, clé d’idempotence en cours.', 'The state of the record or workspace forbids the operation: opted out, blocked, no consent, contradictory keys, channel or number missing, ambiguous scenario name, idempotency key in use.')] },
            { cle: '422', cellules: ['422', t('Corps valide, mais l’envoi est impossible en l’état : fenêtre fermée, cible non envoyable, catégorie illisible, fiche sans numéro, numéro injoignable en RCS, clé d’idempotence déjà utilisée, refus de Meta.', 'Valid body, but sending is impossible as things stand: window closed, unsendable target, unreadable category, record without a number, number unreachable over RCS, idempotency key already used, Meta refusal.')] },
            { cle: '429', cellules: ['429', t('Débit dépassé.', 'Rate limit exceeded.')] },
          ]}
        />
        <Encadre sorte="attention">
          <p>{t('Ces réponses n’ont pas encore de champ code :', 'These responses have no code field yet:')}</p>
          <Liste>
            <li>
              {t(
                'Refus de Meta (lecture de GET /v1/templates, envoi de POST /v1/messages/whatsapp) : 422, error seul, commençant par « Meta: ».',
                'Meta refusal (reading GET /v1/templates, sending POST /v1/messages/whatsapp): 422, error only, starting with “Meta:”.',
              )}
            </li>
            <li>
              {t(
                'Panne (Meta injoignable, erreur de l’API) : 500, parfois une page d’erreur générique. Réessayer ; un envoi se rejoue avec la même clé d’idempotence.',
                'Outage (Meta unreachable, API error): 500, sometimes a generic error page. Retry; a send is replayed with the same idempotency key.',
              )}
            </li>
            <li>
              {t(
                'Corps non JSON : 415 possible. Toujours envoyer Content-Type: application/json. Un JSON illisible est lu comme un objet vide : le refus nomme ce qui manque, pas la syntaxe.',
                'Non-JSON body: 415 possible. Always send Content-Type: application/json. An unreadable JSON is read as an empty object: the refusal names what is missing, not the syntax.',
              )}
            </li>
          </Liste>
        </Encadre>
        <Tableau
          entetes={[t('Code', 'Code'), t('Statut', 'Status'), t('Motif d’écart', 'Skip reason'), t('Sens', 'Meaning')]}
          lignes={CODES_DOCUMENTES.map((c) => ({
            cle: c.code,
            cellules: [
              <Code key="c" c={c.code} testid={`code-${c.code}`} />,
              c.statut === null ? '' : String(c.statut),
              c.ecart ? t('oui', 'yes') : '',
              t(c.quoi[0], c.quoi[1]),
            ],
          }))}
        />
      </Section>
    </>
  );
}
