// tests/api-consentement.test.ts
import { describe, it, expect } from 'vitest';
import { appliquerConsentement, type DepsConsentement } from '../src/api/consentement';
import type { AuditSink } from '../src/audit/journal';

/**
 * LE CONSENTEMENT POSÉ PAR UNE MACHINE (`/v1/contacts`, et demain chaque destinataire d'un envoi).
 *
 * 🔴 UN CHANGEMENT S'ÉCRIT ET SE JOURNALISE ; UNE RÉPÉTITION NE LAISSE AUCUNE TRACE. Et le journal est
 * BEST-EFFORT : une panne d'écriture de log ne doit pas empêcher d'enregistrer un refus.
 */
function monter(issue: 'change' | 'inchange' | 'absente', auditLeve = false) {
  const ecrits: Array<{ contactId: string; statut: string; source: string }> = [];
  const audits: Array<{ acteur: unknown; action: string; cible: { kind: string; id: string }; detail: unknown }> = [];
  const audit: AuditSink = async (_t, acteur, action, cible, detail) => {
    if (auditLeve) throw new Error('journal indisponible');
    audits.push({ acteur, action, cible, detail });
  };
  const deps: DepsConsentement = {
    ecrireConsentementParId: async (_t, contactId, statut, source) => { ecrits.push({ contactId, statut, source }); return issue; },
    audit,
  };
  return { deps, ecrits, audits };
}
const ID = '00000000-0000-4000-8000-000000000001';

describe('appliquerConsentement', () => {
  it('🔴 un désabonnement qui change : écrit, puis une ligne `contact.optout` (source api, sans acteur humain)', async () => {
    const { deps, ecrits, audits } = monter('change');
    await appliquerConsentement(deps, 't1', ID, 'opted_out', 'formulaire-site');
    expect(ecrits).toEqual([{ contactId: ID, statut: 'opted_out', source: 'formulaire-site' }]);
    expect(audits).toEqual([{
      acteur: { userId: null, email: null }, action: 'contact.optout',
      cible: { kind: 'contact', id: ID }, detail: { source: 'api', consentSource: 'formulaire-site' },
    }]);
  });

  it('un consentement qui change : `contact.optin`', async () => {
    const { deps, audits } = monter('change');
    await appliquerConsentement(deps, 't1', ID, 'opted_in', 'api');
    expect(audits.map((a) => a.action)).toEqual(['contact.optin']);
  });

  it('⚠️ inchangé ou fiche absente : aucune ligne d’audit, et l’issue est RENDUE à l’appelant', async () => {
    for (const issue of ['inchange', 'absente'] as const) {
      const { deps, audits } = monter(issue);
      // `absente` doit remonter : l'appelant en fait `unknown_contact`, jamais « mis à jour ».
      expect(await appliquerConsentement(deps, 't1', ID, 'opted_out', 'api'), issue).toBe(issue);
      expect(audits, issue).toEqual([]);
    }
  });

  it('🔴 un journal en panne ne fait pas échouer l’écriture du consentement', async () => {
    const { deps, ecrits } = monter('change', true);
    await expect(appliquerConsentement(deps, 't1', ID, 'opted_out', 'api')).resolves.toBe('change');
    expect(ecrits).toHaveLength(1);
  });
});
