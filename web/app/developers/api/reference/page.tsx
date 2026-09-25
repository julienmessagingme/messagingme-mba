'use client';

import { CadreDoc } from '@/components/doc-api/CadreDoc';
import {
  ADRESSE_API, Bloc, C, CLE_EXEMPLE, Code, Encadre, EnTetePage, Liste, Section, Tableau, json,
} from '@/components/doc-api/elements';
import { useT } from '@/lib/i18n';
import { BORNES, CODES_DOCUMENTES, EXEMPLES_REPONSES } from '@/lib/api-exemples';

/**
 * CE QUI VAUT POUR TOUTES LES ROUTES, À CONSULTER : l'authentification et les droits, le débit, et le catalogue
 * complet des codes d'erreur (tiré de `CODES_DOCUMENTES`, tenu égal aux codes du serveur par la suite racine).
 */
export default function ApiReferencePage() {
  return <CadreDoc page="reference">{() => <Reference />}</CadreDoc>;
}

function Reference() {
  const t = useT();
  return (
    <>
      <EnTetePage page="reference">
        <p>{t('Authentification et droits, débit, erreurs : ce qui vaut pour toutes les routes.', 'Authentication and scopes, rate limit, errors: what applies to every route.')}</p>
      </EnTetePage>

      <Section id="authentification" titre={t('Authentification et droits', 'Authentication and scopes')}>
        <p>{t('Toutes les routes sont sous :', 'All routes live under:')}</p>
        <Bloc>{`${ADRESSE_API}/v1`}</Bloc>
        <p>
          {t(
            'Chaque appel porte sa clé dans l’en-tête Authorization. L’espace est déduit de la clé : aucune adresse ne porte d’identifiant d’espace.',
            'Every call carries its key in the Authorization header. The workspace is derived from the key: no URL ever carries a workspace id.',
          )}
        </p>
        <Bloc>{`Authorization: Bearer ${CLE_EXEMPLE}`}</Bloc>
        <p>
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
        <Encadre sorte="note">
          <p>
            {t(
              'Les droits d’une clé se fixent à sa création : pour un droit de plus, créez une clé neuve.',
              'A key’s scopes are set when it is created: for an extra scope, create a new key.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section id="debit" titre={t('Débit', 'Rate limit')}>
        <p>
          {t(
            `Par défaut ${BORNES.plafondEspaceMinute} requêtes par minute et ${BORNES.plafondEspaceHeure} par heure, par espace : le plafond est commun à toutes les clés de votre espace et au serveur MCP. Un appel compte pour un, quel que soit son volume (un lot de ${BORNES.contactsParLot} fiches est un appel). Chaque réponse comptée porte l’état du compteur le plus proche de son plafond :`,
            `By default ${BORNES.plafondEspaceMinute} requests per minute and ${BORNES.plafondEspaceHeure} per hour, per workspace: the limit is shared by all the keys of your workspace and by the MCP server. A call counts as one whatever its size (sending ${BORNES.contactsParLot} records at once is one call). Every counted response carries the state of the counter closest to its limit:`,
          )}
        </p>
        <Bloc>{`x-ratelimit-limit: ${BORNES.plafondEspaceMinute}\nx-ratelimit-remaining: 57\nx-ratelimit-reset: 1790000000`}</Bloc>
        <p>
          {t('Au dépassement : 429', 'On overflow: 429')} <Code c="rate_limited" />{' '}
          {t(
            'avec un en-tête retry-after (en secondes) : le temps jusqu’à la remise à zéro de la fenêtre pleine, minute ou heure, et le message dit laquelle. Un appel refusé ne compte pas. x-ratelimit-reset est l’heure de remise à zéro, en secondes depuis 1970. Une clé inconnue (401) ne porte aucun de ces en-têtes. Sur demande, un espace peut recevoir un plafond différent.',
            'with a retry-after header (seconds): the time until the full window, minute or hour, resets, and the message says which. A refused call does not count. x-ratelimit-reset is the reset time, in seconds since 1970. An unknown key (401) carries none of these headers. On request, a workspace can get a different limit.',
          )}
        </p>
        <Encadre sorte="note">
          <p>
            {t(
              'Le compteur est tenu en mémoire du serveur : il repart à zéro à chaque redéploiement.',
              'The counter is held in server memory: it resets on every redeploy.',
            )}
          </p>
        </Encadre>
      </Section>

      <Section id="erreurs" titre={t('Erreurs', 'Errors')}>
        <p>{t('Un refus de l’API a cette forme :', 'A refusal from the API has this shape:')}</p>
        <Bloc legende="JSON">{json(EXEMPLES_REPONSES.erreur)}</Bloc>
        <p>
          {t(
            'error est une phrase en français, pour un humain ; code est un identifiant stable, pour un programme. Un même refus porte le même code partout, qu’il arrive en erreur ou en motif d’écart d’un envoi. Un défaut de forme d’un corps JSON lisible est invalid_body, avec le champ fautif dans le message ; une clé de fiche absente ou illisible a ses propres codes (invalid_recipient, invalid_phone).',
            'error is a sentence in French, for a human; code is a stable identifier, for a program. The same refusal carries the same code everywhere, whether it comes as an error or as a skip reason in a send. A shape defect in a readable JSON body is invalid_body, with the faulty field in the message; a missing or unreadable record key has its own codes (invalid_recipient, invalid_phone).',
          )}
        </p>
        <Encadre sorte="attention">
          <p>{t('Trois cas n’ont pas de code, dites-les à votre programme :', 'Three cases have no code, tell your program about them:')}</p>
          <Liste>
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
          </Liste>
        </Encadre>
        <p>
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
