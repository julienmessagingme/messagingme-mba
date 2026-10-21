import { describe, expect, it, vi } from 'vitest';
import type { AuditAction } from '../src/audit/store.pg';
import type { ContactRow } from '../src/crm/contact-store.pg';
import {
  creerEditionFicheOperateur,
  type ContactsEditionOperateur,
  type DepsEditionFicheOperateur,
} from '../src/crm/editer-fiche-operateur';
import type { UserFieldDef } from '../src/crm/types';

const CONTACT: ContactRow = {
  id: 'c1', phoneE164: '+33611', bsuid: null, externalId: null, profileName: 'Marc', optInStatus: 'opted_in',
  fields: { prenom: 'Marc' }, tags: ['vip'], createdAt: '2026-07-10T00:00:00.000Z', blockedAt: null,
  whatsappJoignable: null, whatsappJoignableLe: null, risque: null,
};

type Edits = Parameters<ContactsEditionOperateur['applyEdits']>[2];

function montage(options: { contact?: ContactRow | null; consentementChange?: boolean; apresPoseLeve?: boolean } = {}) {
  let defs: UserFieldDef[] = [
    { key: 'age', label: 'Âge', type: 'number' },
    { key: 'consent', label: 'Consentement', type: 'boolean' },
  ];
  const ecritures: Edits[] = [];
  const crees: Array<{ key: string; label: string; type: string }> = [];
  const audits: Array<{ action: AuditAction; userId: string | null; detail: Record<string, unknown> | undefined }> = [];
  const poses: Array<{ posees: readonly string[]; nouvelles: readonly string[] }> = [];
  const deps: DepsEditionFicheOperateur = {
    champs: { list: async () => defs },
    ensureSocleField: async (_tenantId, key, label, type) => {
      crees.push({ key, label, type });
      defs = [...defs, { key, label, type }];
    },
    contacts: {
      applyEdits: async (_tenantId, _contactId, edits) => {
        ecritures.push(edits);
        const contact = options.contact === undefined ? CONTACT : options.contact;
        if (!contact) return null;
        const tags = [...new Set([...contact.tags, ...edits.addTags])].filter((tag) => !edits.removeTags.includes(tag));
        return {
          contact: { ...contact, tags },
          addedTags: edits.addTags.filter((tag) => !contact.tags.includes(tag) && tags.includes(tag)),
          consentementChange: options.consentementChange ?? edits.optInStatus !== undefined,
        };
      },
    },
    audit: async (_tenantId, actor, action, _target, detail) => {
      audits.push({ action, userId: actor.userId, detail });
    },
    etiquettes: {
      apresPose: async (_tenantId, _contactId, pose) => {
        poses.push(pose);
        if (options.apresPoseLeve) throw new Error('file indisponible');
      },
    },
  };
  return { edition: creerEditionFicheOperateur(deps), ecritures, crees, audits, poses };
}

describe('édition opérateur d’une fiche', () => {
  it('prépare une seule écriture, puis trace le consentement et propage les nouvelles étiquettes', async () => {
    const m = montage();
    const issue = await m.edition.editer({
      tenantId: 't1', contactId: 'c1', acteur: { userId: 'u1', email: null },
      entree: {
        fields: { age: ' 42 ', consent: 'oui' }, removeFields: [' ancien ', '', 'ancien'],
        addTags: [' nouveau ', 'vip'], removeTags: ['fantome'], profileName: ' Alice ', optInStatus: 'opted_out',
      },
    });

    expect(issue.statut).toBe('modifiee');
    expect(m.ecritures).toEqual([{
      fields: { age: '42', consent: 'true' }, removeFields: ['ancien'], addTags: ['nouveau', 'vip'],
      removeTags: ['fantome'], profileName: 'Alice', optInStatus: 'opted_out',
    }]);
    expect(m.audits).toEqual([{ action: 'contact.optout', userId: 'u1', detail: { source: 'fiche' } }]);
    expect(m.poses).toEqual([{ posees: ['nouveau', 'vip'], nouvelles: ['nouveau'] }]);
  });

  it('refuse un champ inconnu ou une valeur invalide avant toute écriture', async () => {
    const m = montage();
    const inconnu = await m.edition.editer({
      tenantId: 't1', contactId: 'c1', acteur: { userId: 'u1', email: null }, entree: { fields: { prnom: 'Alice' } },
    });
    const invalide = await m.edition.editer({
      tenantId: 't1', contactId: 'c1', acteur: { userId: 'u1', email: null }, entree: { fields: { age: 'beaucoup' } },
    });
    expect(inconnu).toEqual({ statut: 'invalide', erreur: 'champ inconnu : prnom' });
    expect(invalide).toEqual({ statut: 'invalide', erreur: 'valeur invalide pour « Âge » (number)' });
    expect(m.ecritures).toEqual([]);
  });

  it('matérialise un champ socle absent avant de le canonicaliser', async () => {
    const m = montage();
    const issue = await m.edition.editer({
      tenantId: 't1', contactId: 'c1', acteur: { userId: 'u1', email: null }, entree: { fields: { prenom: '  Alice  ' } },
    });
    expect(issue.statut).toBe('modifiee');
    expect(m.crees).toEqual([{ key: 'prenom', label: 'Prénom', type: 'text' }]);
    expect(m.ecritures[0]?.fields).toEqual({ prenom: 'Alice' });
  });

  it('un contact inconnu ne laisse ni trace ni publication', async () => {
    const m = montage({ contact: null });
    const issue = await m.edition.editer({
      tenantId: 't1', contactId: 'absent', acteur: { userId: 'u1', email: null },
      entree: { addTags: ['nouveau'], optInStatus: 'opted_in' },
    });
    expect(issue).toEqual({ statut: 'inconnue' });
    expect(m.audits).toEqual([]);
    expect(m.poses).toEqual([]);
  });

  it('un consentement déjà en place ne crée pas de fausse trace', async () => {
    const m = montage({ consentementChange: false });
    const issue = await m.edition.editer({
      tenantId: 't1', contactId: 'c1', acteur: { userId: 'u1', email: null }, entree: { optInStatus: 'opted_in' },
    });
    expect(issue.statut).toBe('modifiee');
    expect(m.audits).toEqual([]);
  });

  it('une publication d’étiquette en panne reste best-effort après l’écriture', async () => {
    const erreur = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = montage({ apresPoseLeve: true });
    const issue = await m.edition.editer({
      tenantId: 't1', contactId: 'c1', acteur: { userId: 'u1', email: null }, entree: { addTags: ['nouveau'] },
    });
    expect(issue.statut).toBe('modifiee');
    expect(m.ecritures).toHaveLength(1);
    expect(erreur).toHaveBeenCalledWith(expect.stringContaining('ignorée (best-effort)'), 'file indisponible');
    erreur.mockRestore();
  });
});
