import type { AuditSink } from '../audit/journal';
import { tenter } from '../lib/tenter';

/**
 * Le consentement posé par une machine.
 *
 * L'upsert ne sait que promouvoir (un import n'écrase jamais un consentement) : un refus s'écrit par une
 * écriture dédiée, sur l'identifiant de la fiche, comme le `PATCH` de la console. `audit` est requis, et
 * reste best-effort à l'appel.
 *
 * 🔴 L'issue est rendue et l'appelant doit la lire : `absente` (fiche purgée entre-temps) n'a rien reçu ;
 * `refuse` est un `opted_in` sur une fiche `opted_out` : un STOP ne se lève pas par machine, seul un
 * opérateur ou la personne le peut, et l'appelant le rend en `opted_out`, jamais en succès. `inchange` garde
 * aussi la source d'origine d'un consentement déjà posé.
 */
export type ConsentementApi = 'opted_in' | 'opted_out';
export type IssueConsentement = 'change' | 'inchange' | 'refuse' | 'absente';

export interface DepsConsentement {
  ecrireConsentementParId(
    tenantId: string,
    contactId: string,
    statut: ConsentementApi,
    source: string,
  ): Promise<IssueConsentement>;
  audit: AuditSink;
}

/**
 * Les dépendances du consentement, construites ici et nulle part ailleurs (`/v1/contacts` et `/v1/sends`) :
 * deux constructions à la main divergeraient, et une route écrirait un consentement sans trace. La flèche
 * garde le `this` du dépôt.
 */
export function depsConsentementDe(contacts: Pick<DepsConsentement, 'ecrireConsentementParId'>, audit: AuditSink): DepsConsentement {
  return {
    ecrireConsentementParId: (tenantId, contactId, statut, source) => contacts.ecrireConsentementParId(tenantId, contactId, statut, source),
    audit,
  };
}

export async function appliquerConsentement(
  deps: DepsConsentement,
  tenantId: string,
  contactId: string,
  consent: 'opted_in' | 'opted_out',
  source: string,
): Promise<IssueConsentement> {
  const issue = await deps.ecrireConsentementParId(tenantId, contactId, consent, source);
  // Rien n'a bougé (même statut, STOP à respecter, ou fiche purgée entre-temps) : rien à consigner.
  if (issue !== 'change') return issue;
  await tenter('audit du consentement ignoré:', () => deps.audit(
    tenantId,
    // Une clé d'API n'est pas un compte : l'acteur reste vide, la source dit d'où vient la décision.
    { userId: null, email: null },
    consent === 'opted_in' ? 'contact.optin' : 'contact.optout',
    { kind: 'contact', id: contactId },
    { source: 'api', consentSource: source },
  ));
  return issue;
}
