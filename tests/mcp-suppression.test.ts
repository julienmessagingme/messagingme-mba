import { describe, it, expect } from 'vitest';
import { OUTILS, outilsPour, RefusOutil, type DepsMcp } from '../src/mcp/outils';
import type { BulkTarget, ContactFilters, FicheASupprimer } from '../src/crm/contact-store.pg';
import { codeBienForme, codeDeSuppression, empreinteDesFiches, verifierCodeDeSuppression } from '../src/crm/code-suppression';
import { LONGUEUR_MAX_CODE_SUPPRESSION } from '../src/mcp/outils-suppression';
import { FICHES_DE_L_APERCU, MAX_FICHES_PAR_SUPPRESSION } from '../web/lib/partage/catalogue-mcp';
import { MAX_IDENTIFIANTS_CIBLE } from '../src/mcp/cible';
import { DUREE_CODE_MS } from '../src/campaign/confirmation';
import { MESSAGE_OPERATIONS_LOURDES } from '../src/auth/plafond-partage';
import { creerTravauxEnVol } from '../src/lib/en-vol';
import { QuotaSuppressions } from '../src/offres/compteurs';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import { DROITS } from '../src/offres/offres';

/**
 * LA SUPPRESSION DE CONTACTS EN MASSE DEPUIS CLAUDE (plan `docs/superpowers/plans/2026-10-26-free-au-dela-de-100-contacts.md`).
 * Ce que les outils ajoutent à l'effacement partagé (`effacerContacts`, dont la limite du jour a ses tests dans
 * `tests/offres-compteurs.test.ts`) : lire la sélection et la refuser plutôt que l'élargir, montrer avant d'effacer, et
 * n'effacer que les fiches montrées. Ce que la REQUÊTE de la sélection fait vraiment (l'espace, les fiches supprimées,
 * l'ordre) : `tests/contact-selection-suppression.test.ts` pour sa forme, et
 * `tests/integration/contacts-suppression.integration.test.ts`, en CI, sur une vraie base.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const AUTRE = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const MOI = { userId: '99999999-9999-4999-8999-999999999999' };
const SECRET = 'secret-de-test-des-suppressions';
const outil = (nom: string) => OUTILS.find((o) => o.nom === nom)!;
const preparer = outil('prepare_contacts_deletion');
const supprimer = outil('delete_contacts');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Une fiche du faux magasin. */
interface Fiche {
  id: string; tenant: string; nom: string | null; tel: string | null; creeLe: string; tags: string[]; optIn: string; supprimee: boolean;
}

function fiche(n: number, o: Partial<Fiche> = {}): Fiche {
  return {
    id: id(n), tenant: T, nom: `Client ${n}`, tel: `+336123456${String(n).padStart(2, '0')}`,
    creeLe: `2026-01-${String(1 + (n % 28)).padStart(2, '0')}T10:00:00.000Z`, tags: [], optIn: 'unknown', supprimee: false,
    ...o,
  };
}

/** Les filtres de la cible, comme le sélecteur de l'action en masse les applique. */
function correspond(f: Fiche, filtres: ContactFilters): boolean {
  const tags = filtres.tags ?? [];
  if (tags.length > 0 && !(filtres.tagMode === 'or' ? tags.some((t) => f.tags.includes(t)) : tags.every((t) => f.tags.includes(t)))) return false;
  return filtres.optIn === undefined || f.optIn === filtres.optIn;
}

/** Un faux magasin : les règles de `selectionAEffacer` (espace, fiches vivantes, cible, ordre total, limite). */
function monter(fiches: Fiche[], o: { quota?: { ok: true } | { ok: false; max: number }; couteuxAccepte?: boolean } = {}) {
  const traces = {
    lectures: [] as Array<{ tenant: string; cible: BulkTarget; limite: number }>,
    purges: [] as Array<{ tenant: string; ids: string[] }>,
    quota: [] as Array<{ tenant: string; n: number }>,
    plafond: 0,
    audit: [] as Array<{ tenant: string; userId: string | null; action: string; cible: string; detail: unknown }>,
  };
  const versFiche = (f: Fiche): FicheASupprimer => ({ id: f.id, profileName: f.nom, phoneE164: f.tel, bsuid: null, createdAt: f.creeLe });
  const d = {
    couteux: { consommer: async () => { traces.plafond += 1; return { accepte: o.couteuxAccepte ?? true, attenteMs: 2000 }; } },
    inbox: { contactIdsDesConversations: async () => { throw new Error('les conversations ne sont pas un critère de suppression'); } },
    contacts: {
      // Comme le vrai : DANS l'espace, fiches supprimées comprises (c'est la sélection qui les écarte).
      contactIdsForTarget: async (tenant: string, cible: BulkTarget) => ('ids' in cible ? fiches.filter((f) => f.tenant === tenant && cible.ids.includes(f.id)).map((f) => f.id) : []),
    },
    suppression: {
      selection: async (tenant: string, cible: BulkTarget, limite: number) => {
        traces.lectures.push({ tenant, cible, limite });
        const vivantes = fiches.filter((f) => f.tenant === tenant && !f.supprimee);
        const visees = 'ids' in cible ? vivantes.filter((f) => cible.ids.includes(f.id)) : vivantes.filter((f) => correspond(f, cible.filters));
        return [...visees].sort((a, b) => a.creeLe.localeCompare(b.creeLe) || a.id.localeCompare(b.id)).slice(0, limite).map(versFiche);
      },
      effacement: {
        contacts: {
          purgeMany: async (tenant: string, ids: readonly string[]) => {
            traces.purges.push({ tenant, ids: [...ids] });
            let purges = 0;
            for (const f of fiches) if (f.tenant === tenant && ids.includes(f.id) && !f.supprimee) { f.supprimee = true; purges += 1; }
            return { purges, conversations: purges, messages: 2 * purges, analyses: 0, listeAgent: [] };
          },
        },
        suppressionsDuJour: { consommer: async (tenant: string, n: number) => { traces.quota.push({ tenant, n }); return o.quota ?? { ok: true as const }; } },
        listeDeLAgent: { oublierChezMeta: async () => {} },
        enVol: creerTravauxEnVol(),
      },
      audit: async (tenant: string, actor: { userId: string | null }, action: string, cible: { id: string }, detail?: unknown) => {
        traces.audit.push({ tenant, userId: actor.userId, action, cible: cible.id, detail });
      },
      secret: SECRET,
    },
  } as unknown as DepsMcp;
  return { d, traces };
}

/** Un aperçu, puis le code qu'il rend. */
async function apercu(d: DepsMcp, args: Record<string, unknown>, tenant = T) {
  return await preparer.executer(d, tenant, args, MOI) as {
    count: number; sample: Array<{ name: string | null; phone: string; created_at: string }>; confirmation_code: string; code_expires_at: string;
  };
}

describe('les deux outils : qui, quelle offre, quels indices', () => {
  it('🔴 ouverts à toutes les offres, au nom d’une personne, jamais d’une clé d’API ; destructeurs', () => {
    for (const o of [preparer, supprimer]) {
      expect(o.fonction, o.nom).toBeNull();
      expect(o.scope, o.nom).toBe('mcp:write');
      expect(o.exigePersonne, o.nom).toBe(true);
      expect(o.annotations, o.nom).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    }
    // La purge retire aussi les contacts de la liste de l'agent de Meta, chez Meta : monde ouvert. L'aperçu, non.
    expect(supprimer.annotations.openWorldHint).toBe(true);
    expect(preparer.annotations.openWorldHint).toBe(false);
    const parCle = outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null }).map((o) => o.nom);
    expect(parCle).not.toContain('prepare_contacts_deletion');
    expect(parCle).not.toContain('delete_contacts');
  });

  it('🔴 les bornes appliquées sont annoncées : schéma fermé, oldest, contact_ids et le code ; aucune inactivité', () => {
    for (const o of [preparer, supprimer]) {
      const p = o.entree.properties;
      expect(o.entree.additionalProperties, o.nom).toBe(false);
      expect(p.oldest, o.nom).toMatchObject({ type: 'integer', minimum: 1, maximum: MAX_FICHES_PAR_SUPPRESSION });
      expect(p.contact_ids, o.nom).toMatchObject({ maxItems: MAX_IDENTIFIANTS_CIBLE });
      // Ni l'analyse, ni les conversations, ni l'inactivité : la sélection ne les accepte pas, le schéma ne les annonce pas.
      expect(Object.keys(p).sort(), o.nom).toEqual([...(o === supprimer ? ['confirmation_code'] : []), 'contact_ids', 'oldest', 'opt_in', 'tag_mode', 'tags'].sort());
      expect(`${o.description}${JSON.stringify(p)}`, o.nom).not.toMatch(/inactive|inactivity/);
    }
    expect(MAX_FICHES_PAR_SUPPRESSION).toBe(1000);
    expect(supprimer.entree.required).toEqual(['confirmation_code']);
    expect(supprimer.entree.properties.confirmation_code).toMatchObject({ minLength: 1, maxLength: LONGUEUR_MAX_CODE_SUPPRESSION });
  });
});

describe('la sélection', () => {
  it('par étiquettes : le compte, dix fiches au plus, les plus anciennes d’abord, numéro masqué, et un code de 30 minutes', async () => {
    const fiches = Array.from({ length: 15 }, (_, i) => fiche(i + 1, { tags: ['ancien'] }));
    const { d, traces } = monter(fiches);
    const avant = Date.now();
    const r = await apercu(d, { tags: ['ancien'] });
    expect(r.count).toBe(15);
    expect(r.sample).toHaveLength(FICHES_DE_L_APERCU);
    const attendues = [...fiches].sort((a, b) => a.creeLe.localeCompare(b.creeLe) || a.id.localeCompare(b.id)).slice(0, FICHES_DE_L_APERCU);
    expect(r.sample.map((s) => s.created_at)).toEqual(attendues.map((f) => f.creeLe));
    expect(r.sample[0]!.phone).toMatch(/^\+33 •• •• •• \d\d$/);
    expect(JSON.stringify(r.sample)).not.toMatch(/\+336123456\d\d/);
    expect(codeBienForme(r.confirmation_code)).toBe(true);
    const echeance = Date.parse(r.code_expires_at);
    expect(echeance).toBeGreaterThan(avant + DUREE_CODE_MS - 2000);
    expect(echeance).toBeLessThanOrEqual(Date.now() + DUREE_CODE_MS);
    // Rien n'est effacé, rien n'est compté dans la limite du jour ; le plafond des opérations lourdes, une fois.
    expect([traces.purges, traces.quota, traces.audit]).toEqual([[], [], []]);
    expect(traces.plafond).toBe(1);
    expect(traces.lectures[0]).toEqual({ tenant: T, cible: { filters: { tags: ['ancien'] }, excludeIds: [] }, limite: MAX_FICHES_PAR_SUPPRESSION + 1 });
  });

  it('chaque critère seul : tags (tous ou l’un), consentement, liste, les plus anciennes', async () => {
    const fiches = [
      fiche(1, { tags: ['a', 'b'], optIn: 'opted_out' }),
      fiche(2, { tags: ['a'], optIn: 'opted_in' }),
      fiche(3, { tags: ['b'], optIn: 'unknown' }),
      fiche(4, { tags: [], optIn: 'opted_in' }),
    ];
    const { d } = monter(fiches);
    const compte = async (args: Record<string, unknown>) => (await apercu(d, args)).count;
    expect(await compte({ tags: ['a', 'b'] })).toBe(1);
    expect(await compte({ tags: ['a', 'b'], tag_mode: 'any' })).toBe(3);
    expect(await compte({ opt_in: 'opted_in' })).toBe(2);
    expect(await compte({ contact_ids: [id(2), id(4)] })).toBe(2);
    expect(await compte({ oldest: 2 })).toBe(2);
  });

  it('les critères se combinent, et oldest garde les plus anciennes de la sélection, à date égale par identifiant', async () => {
    const meme = '2026-01-05T10:00:00.000Z';
    const fiches = [
      fiche(9, { tags: ['x'], creeLe: meme }), fiche(7, { tags: ['x'], creeLe: meme }), fiche(8, { tags: ['x'], creeLe: meme }),
      fiche(1, { tags: ['x'], creeLe: '2026-03-01T10:00:00.000Z' }), fiche(2, { tags: [], creeLe: '2026-01-01T10:00:00.000Z' }),
      fiche(3, { tags: ['x'], creeLe: '2026-01-02T10:00:00.000Z' }),
    ];
    const { d, traces } = monter(fiches);
    const r = await apercu(d, { tags: ['x'], oldest: 3 });
    // La fiche 2, plus ancienne, n'a pas l'étiquette ; la 3 l'a et passe d'abord ; puis, à date égale, 7 puis 8.
    expect(r.count).toBe(3);
    expect(traces.lectures.at(-1)).toMatchObject({ limite: 3 });
    expect((await apercu(d, { contact_ids: [id(1), id(3), id(9)], oldest: 2 })).count).toBe(2);
    // Le code de « tags x, les trois plus anciennes » est celui des fiches 3, 7 et 8, dans n'importe quel ordre.
    expect(verifierCodeDeSuppression(SECRET, r.confirmation_code, T, empreinteDesFiches([id(8), id(3), id(7)]), Date.now())).toBe('ok');
    expect(verifierCodeDeSuppression(SECRET, r.confirmation_code, T, empreinteDesFiches([id(9), id(3), id(7)]), Date.now())).toBe('invalide');
  });

  it('🔴 une fiche supprimée n’est jamais comptée ni rendue, même nommée par son identifiant', async () => {
    const { d } = monter([fiche(1), fiche(2, { supprimee: true })]);
    expect((await apercu(d, { contact_ids: [id(1), id(2)] })).count).toBe(1);
    await expect(apercu(d, { contact_ids: [id(2)] })).rejects.toThrow(/aucun contact de cet espace ne correspond/);
  });

  it('🔴 un autre espace n’est jamais touché : ses fiches ne se désignent pas, ni par critère ni par identifiant', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] }), fiche(2, { tenant: AUTRE, tags: ['a'] })]);
    expect((await apercu(d, { tags: ['a'] })).count).toBe(1);
    await expect(apercu(d, { contact_ids: [id(2)] })).rejects.toThrow(/aucun de ces contacts n’existe dans cet espace/);
    expect(traces.lectures.every((l) => l.tenant === T)).toBe(true);
  });

  it('🔴 une sélection sans aucun critère est refusée, sans rien lire ni entamer le plafond', async () => {
    const { d, traces } = monter([fiche(1)]);
    for (const args of [{}, { tag_mode: 'any' }, { oldest: null }]) {
      await expect(apercu(d, args), JSON.stringify(args)).rejects.toThrow(RefusOutil);
    }
    expect([traces.lectures, traces.plafond]).toEqual([[], 0]);
  });

  it('🔴 plus de 1 000 contacts : refusé, jamais tronqué ; oldest la ramène sous le plafond', async () => {
    const fiches = Array.from({ length: MAX_FICHES_PAR_SUPPRESSION + 1 }, (_, i) => fiche(i + 1));
    const { d } = monter(fiches);
    await expect(apercu(d, { opt_in: 'unknown' })).rejects.toThrow(/plus de 1000 contacts/);
    expect((await apercu(d, { oldest: MAX_FICHES_PAR_SUPPRESSION })).count).toBe(MAX_FICHES_PAR_SUPPRESSION);
    // Pile au plafond, sans oldest : accepté.
    fiches[0]!.supprimee = true;
    expect((await apercu(d, { opt_in: 'unknown' })).count).toBe(MAX_FICHES_PAR_SUPPRESSION);
  });

  /**
   * 🔴 L'INACTIVITÉ N'EST PAS UN CRITÈRE (relecture du lot, 2026-10-26) : les fils qui datent un dernier message partent avec
   * la conservation et la déconnexion du numéro, et un client qui a écrit il y a trois mois paraîtrait « jamais actif ».
   * Une clé `inactive_days` est donc refusée comme toute clé inconnue : ignorée, elle élargirait la sélection à tout ce
   * que ses autres critères désignent.
   */
  it('🔴 inactive_days est REFUSÉ comme une clé inconnue, seul ou avec d’autres critères, avant toute lecture', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] })]);
    for (const args of [{ inactive_days: 90 }, { tags: ['a'], inactive_days: 90 }, { oldest: 10, inactive_days: 90 }]) {
      await expect(apercu(d, args), JSON.stringify(args)).rejects.toThrow(/paramètre inconnu : inactive_days/);
      await expect(supprimer.executer(d, T, { ...args, confirmation_code: `abcdefg.${'a'.repeat(22)}` }, MOI), JSON.stringify(args))
        .rejects.toThrow(/paramètre inconnu : inactive_days/);
    }
    expect([traces.lectures, traces.purges, traces.plafond]).toEqual([[], [], 0]);
  });

  it('🔴 ce qui élargirait ou ne se lit pas est REFUSÉ, jamais ignoré ni ramené : analyse, conversations, bornes', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] })]);
    const refus = [
      { tags: ['a'], analysis: [{ field: 'sentiment', op: 'in', value: 'negatif' }] },
      { conversation_ids: [id(1)] },
      { tags: ['a'], confirmation_code: 'x' },
      { tags: [] },
      { oldest: 0 }, { oldest: MAX_FICHES_PAR_SUPPRESSION + 1 }, { oldest: 2.5 }, { oldest: '30' },
      { contact_ids: [id(1)], tags: ['a'] },
    ];
    for (const args of refus) await expect(apercu(d, args), JSON.stringify(args)).rejects.toThrow(RefusOutil);
    expect(traces.lectures).toEqual([]);
  });

  it('🔴 l’aperçu compte dans les opérations lourdes, comme prepare_campaign : refusé par le plafond, rien n’est lu', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] })], { couteuxAccepte: false });
    await expect(apercu(d, { tags: ['a'] })).rejects.toThrow(MESSAGE_OPERATIONS_LOURDES);
    expect([traces.lectures, traces.plafond]).toEqual([[], 1]);
  });

  it('sans personne : refusé avant toute lecture', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] })]);
    await expect(preparer.executer(d, T, { tags: ['a'] }, null)).rejects.toThrow(/connexion OAuth requise/);
    await expect(supprimer.executer(d, T, { tags: ['a'], confirmation_code: 'abc' }, null)).rejects.toThrow(/connexion OAuth requise/);
    expect([traces.lectures, traces.purges, traces.plafond]).toEqual([[], [], 0]);
  });
});

describe('la confirmation', () => {
  it('🔴 avec le code de l’aperçu et la même sélection : efface ces fiches-là, par l’effacement partagé, audité au nom de la personne', async () => {
    const fiches = [fiche(1, { tags: ['vieux'] }), fiche(2, { tags: ['vieux'] }), fiche(3, { tags: ['neuf'] })];
    const { d, traces } = monter(fiches);
    const { confirmation_code } = await apercu(d, { tags: ['vieux'] });
    expect(await supprimer.executer(d, T, { tags: ['vieux'], confirmation_code }, MOI)).toEqual({ deleted: 2, conversations: 2, messages: 4 });
    expect(traces.purges).toEqual([{ tenant: T, ids: [id(1), id(2)] }]);
    expect(traces.quota).toEqual([{ tenant: T, n: 2 }]);
    // Une opération lourde pour l'aperçu, une pour l'effacement.
    expect(traces.plafond).toBe(2);
    expect(traces.audit).toEqual([id(1), id(2)].map((c) => ({
      tenant: T, userId: MOI.userId, action: 'contact.purged', cible: c, detail: { lot: 2, via: 'mcp' },
    })));
    expect(fiches.map((f) => f.supprimee)).toEqual([true, true, false]);
  });

  it('🔴 déjà servi : le même code, rejoué, est refusé, et rien de plus n’est effacé', async () => {
    const fiches = Array.from({ length: 6 }, (_, i) => fiche(i + 1));
    const { d, traces } = monter(fiches);
    const { confirmation_code } = await apercu(d, { oldest: 3 });
    await supprimer.executer(d, T, { oldest: 3, confirmation_code }, MOI);
    // Les trois plus anciennes suivantes ne sont pas celles que l'aperçu a montrées.
    await expect(supprimer.executer(d, T, { oldest: 3, confirmation_code }, MOI)).rejects.toThrow(/ne correspond pas à cette sélection/);
    expect(traces.purges).toHaveLength(1);
    expect(fiches.filter((f) => f.supprimee)).toHaveLength(3);
  });

  it('🔴 la sélection a changé depuis l’aperçu (une fiche de plus porte l’étiquette) : refusé, rien n’est effacé', async () => {
    const fiches = [fiche(1, { tags: ['vieux'] }), fiche(2)];
    const { d, traces } = monter(fiches);
    const { confirmation_code } = await apercu(d, { tags: ['vieux'] });
    fiches[1]!.tags = ['vieux'];
    await expect(supprimer.executer(d, T, { tags: ['vieux'], confirmation_code }, MOI)).rejects.toThrow(/ne correspond pas à cette sélection/);
    expect([traces.purges, traces.quota, traces.audit]).toEqual([[], [], []]);
  });

  it('🔴 une autre sélection que celle de l’aperçu : refusé ; une sélection qui désigne les mêmes fiches : accepté', async () => {
    const fiches = [fiche(1, { tags: ['a'] }), fiche(2, { tags: ['a', 'b'] }), fiche(3, { tags: ['b'] })];
    const { d, traces } = monter(fiches);
    const { confirmation_code } = await apercu(d, { tags: ['a'] });
    await expect(supprimer.executer(d, T, { tags: ['b'], confirmation_code }, MOI)).rejects.toThrow(/ne correspond pas/);
    expect(traces.purges).toEqual([]);
    // Ce qui compte est ce qui a été montré : les fiches 1 et 2, désignées autrement.
    expect(await supprimer.executer(d, T, { contact_ids: [id(2), id(1)], confirmation_code }, MOI)).toMatchObject({ deleted: 2 });
  });

  it('🔴 un code d’un autre espace est refusé, même pour une sélection qui y désigne les mêmes identifiants', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] }), fiche(2, { tenant: AUTRE, tags: ['a'] })]);
    const { confirmation_code } = await apercu(d, { tags: ['a'] }, AUTRE);
    await expect(supprimer.executer(d, T, { tags: ['a'], confirmation_code }, MOI)).rejects.toThrow(/ne correspond pas/);
    expect(traces.purges).toEqual([]);
    // Signé pour l'autre espace avec l'empreinte des fiches d'ICI : toujours refusé.
    const forge = codeDeSuppression(SECRET, AUTRE, empreinteDesFiches([id(1)]), Date.now()).code;
    await expect(supprimer.executer(d, T, { tags: ['a'], confirmation_code: forge }, MOI)).rejects.toThrow(/ne correspond pas/);
    expect(traces.purges).toEqual([]);
  });

  it('🔴 un code périmé est refusé, et le dit ; rien n’est effacé', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] })]);
    const perime = codeDeSuppression(SECRET, T, empreinteDesFiches([id(1)]), Date.now() - DUREE_CODE_MS - 60_000).code;
    await expect(supprimer.executer(d, T, { tags: ['a'], confirmation_code: perime }, MOI)).rejects.toThrow(/expiré \(30 minutes\)/);
    expect(traces.purges).toEqual([]);
  });

  it('🔴 sans code valide, rien n’est effacé : un code mal formé est refusé avant toute lecture, sans entamer le plafond', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] })]);
    for (const code of ['ABC123', 'n.importe.quoi', `${'x'.repeat(10)}.${'y'.repeat(21)}`]) {
      await expect(supprimer.executer(d, T, { tags: ['a'], confirmation_code: code }, MOI), code).rejects.toThrow(/ne correspond pas/);
    }
    await expect(supprimer.executer(d, T, { tags: ['a'] }, MOI)).rejects.toThrow(/confirmation_code/);
    expect([traces.lectures, traces.purges, traces.plafond]).toEqual([[], [], 0]);
  });

  it('🔴 la limite du jour refuse (une Free sous sa limite de contacts) : refus de l’offre, rien n’est effacé ni audité', async () => {
    const { d, traces } = monter([fiche(1, { tags: ['a'] }), fiche(2, { tags: ['a'] })], { quota: { ok: false, max: 10 } });
    const { confirmation_code } = await apercu(d, { tags: ['a'] });
    await expect(supprimer.executer(d, T, { tags: ['a'], confirmation_code }, MOI)).rejects.toThrow(/10/);
    expect([traces.purges, traces.audit]).toEqual([[], []]);
  });

  it('🔴 par l’outil et la VRAIE limite du jour : une Free au-delà de sa limite supprime 50 contacts d’un coup ; sous elle, 11 sont refusés', async () => {
    const fiches = [
      ...Array.from({ length: 50 }, (_, i) => fiche(i + 1, { tags: ['vieux'] })),
      ...Array.from({ length: 11 }, (_, i) => fiche(i + 100, { tags: ['autre'] })),
    ];
    const etat = { comptees: 3000, limite: 100 as number | null };
    const { d, traces } = monter(fiches);
    // La limite du jour de la console et de l'API, sur un compteur en mémoire, et les fiches comptées que l'on fait varier.
    d.suppression.effacement.suppressionsDuJour = new QuotaSuppressions({
      offres: { offreDe: async () => ({ offre: 'base', droits: DROITS.base, retourEnBaseLe: null }) },
      compteur: new CompteurDebitMemoire(), contacts: { placesContacts: async () => ({ ...etat }) },
    });
    const vieux = await apercu(d, { tags: ['vieux'] });
    expect(await supprimer.executer(d, T, { tags: ['vieux'], confirmation_code: vieux.confirmation_code }, MOI)).toMatchObject({ deleted: 50 });
    // Revenue sous sa limite : le plafond de dix par jour reprend, et une purge qui le dépasserait est refusée en entier.
    etat.comptees = 42;
    const autres = await apercu(d, { tags: ['autre'] });
    await expect(supprimer.executer(d, T, { tags: ['autre'], confirmation_code: autres.confirmation_code }, MOI)).rejects.toThrow(/10/);
    expect(traces.purges).toHaveLength(1);
    expect(fiches.filter((f) => f.supprimee)).toHaveLength(50);
  });

  it('une sélection qui ne désigne plus personne : refusée, et le refus dit pourquoi', async () => {
    const fiches = [fiche(1, { tags: ['a'] })];
    const { d } = monter(fiches);
    const { confirmation_code } = await apercu(d, { tags: ['a'] });
    fiches[0]!.supprimee = true;
    await expect(supprimer.executer(d, T, { tags: ['a'], confirmation_code }, MOI)).rejects.toThrow(/ne désigne plus aucun contact/);
  });
});

describe('le code de confirmation', () => {
  const E = empreinteDesFiches([id(1), id(2)]);
  const MAINTENANT = Date.parse('2026-10-26T10:00:00Z');

  it('🔴 lié à l’espace, aux fiches, au secret ; l’ordre des fiches n’y change rien', () => {
    const { code, expireLe } = codeDeSuppression(SECRET, T, E, MAINTENANT);
    expect(expireLe.getTime()).toBe(MAINTENANT + DUREE_CODE_MS);
    expect(code.length).toBeLessThanOrEqual(LONGUEUR_MAX_CODE_SUPPRESSION);
    expect(verifierCodeDeSuppression(SECRET, code, T, empreinteDesFiches([id(2), id(1)]), MAINTENANT)).toBe('ok');
    expect(verifierCodeDeSuppression(SECRET, code, AUTRE, E, MAINTENANT)).toBe('invalide');
    expect(verifierCodeDeSuppression(SECRET, code, T, empreinteDesFiches([id(1)]), MAINTENANT)).toBe('invalide');
    expect(verifierCodeDeSuppression('autre-secret', code, T, E, MAINTENANT)).toBe('invalide');
    expect(verifierCodeDeSuppression('', code, T, E, MAINTENANT)).toBe('invalide');
  });

  it('🔴 30 minutes, pas une de plus ; une échéance retouchée ne se vérifie plus', () => {
    const { code } = codeDeSuppression(SECRET, T, E, MAINTENANT);
    expect(verifierCodeDeSuppression(SECRET, code, T, E, MAINTENANT + DUREE_CODE_MS)).toBe('ok');
    expect(verifierCodeDeSuppression(SECRET, code, T, E, MAINTENANT + DUREE_CODE_MS + 1000)).toBe('expire');
    const [echeance, sig] = code.split('.') as [string, string];
    const prolonge = `${(parseInt(echeance, 36) + 3600).toString(36)}.${sig}`;
    expect(verifierCodeDeSuppression(SECRET, prolonge, T, E, MAINTENANT + DUREE_CODE_MS + 1000)).toBe('invalide');
  });

  it('un secret vide ne signe rien', () => {
    expect(() => codeDeSuppression('', T, E, MAINTENANT)).toThrow();
  });
});
