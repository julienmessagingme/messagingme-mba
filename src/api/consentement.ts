// src/api/consentement.ts
import type { AuditSink } from '../audit/journal';

/**
 * LE CONSENTEMENT POSÉ PAR UNE MACHINE (spec de l'API publique, § 2 et § 3).
 *
 * 🔴 L'UPSERT NE SAIT QUE PROMOUVOIR, et c'est une bonne garde qu'on garde (un import n'écrase jamais un
 * consentement) : un refus s'écrit donc par une écriture DÉDIÉE, sur l'identifiant de la fiche, comme la
 * route `PATCH` de la fiche dans la console. Les deux sens passent par elle, parce que la fiche peut avoir
 * été trouvée par un identifiant externe, sans numéro.
 *
 * ⚠️ `audit` EST REQUIS : un consentement posé par une machine sans trace ne se justifie plus. Il reste
 * BEST-EFFORT à l'appel, comme partout : une panne d'écriture de log n'empêche pas d'enregistrer un refus.
 *
 * 🔴 L'ISSUE EST RENDUE, et l'appelant DOIT lire `absente` : une fiche purgée entre la résolution et cette
 * écriture n'a rien reçu. Répondre « mis à jour » ferait croire à l'intégrateur un désabonnement enregistré.
 * ⚠️ `inchange` couvre aussi la SOURCE : sur une fiche déjà `opted_in`, un `opted_in` d'une autre source ne
 * réécrit rien, la source d'origine du consentement est gardée (décision du lot 1, spec § 2).
 *
 * 🔴 `refuse` : un `opted_in` sur une fiche `opted_out`. UN STOP NE SE LÈVE PAS PAR MACHINE (décision de
 * Julien du 2026-09-24) ; seul un opérateur ou la personne elle-même le peut. L'appelant le rend en
 * `opted_out`, jamais en succès.
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
 * LES DÉPENDANCES DU CONSENTEMENT, CONSTRUITES ICI ET NULLE PART AILLEURS : `creerServiceContactsV1`
 * (`/v1/contacts`) et le câblage de `/v1/sends` (`src/index.ts`) passent par elle. Deux constructions
 * écrites à la main divergeraient, et une route journaliserait un consentement que l'autre écrirait sans trace.
 *
 * ⚠️ La flèche garde le `this` du dépôt : passer `contacts.ecrireConsentementParId` tel quel le perdrait sur
 * une instance de `PgContactStore`.
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
  try {
    await deps.audit(
      tenantId,
      // Une clé d'API n'est pas un compte : l'acteur reste vide, la SOURCE dit d'où vient la décision.
      { userId: null, email: null },
      consent === 'opted_in' ? 'contact.optin' : 'contact.optout',
      { kind: 'contact', id: contactId },
      { source: 'api', consentSource: source },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('audit du consentement ignoré:', err instanceof Error ? err.message : err);
  }
  return issue;
}
