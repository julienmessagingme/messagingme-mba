import { describe, it, expect, vi, afterEach } from 'vitest';
import { CATALOGUE, LANGUES, modeleDe, variablesCitees, variablesDe, variablesInconnues, type TexteEmail } from '../src/emails-produit/catalogue';
import { dateLisible, rendre, valeursExemple } from '../src/emails-produit/rendu';
import { jetonDesinscription, lienDesinscription, lireJetonDesinscription } from '../src/emails-produit/desinscription';
import { creerEmetteurEmails, type JobEmail } from '../src/emails-produit/emission';
import { creerTravailEmail, DELAIS_REESSAI_MS, reprendreLesEnvois, type DepsTravailEmail } from '../src/emails-produit/envoi';
import type { EnvoiAFaire } from '../src/emails-produit/store.pg';
import { ResendError } from '../src/support/resend';

/**
 * LES E-MAILS DU PRODUIT (lot 7, spec `docs/superpowers/specs/2026-10-14-emails-produit-design.md`) : le catalogue, le
 * rendu, le lien de désinscription, l'émission et le travail de la file. Ce que la base fait vraiment (contrainte unique,
 * prise d'une tentative, cascade) : `tests/integration/emails-produit.integration.test.ts`, en CI.
 */

afterEach(() => { vi.restoreAllMocks(); });

const ID = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const SECRET = 'secret-de-test-des-sessions';

describe('le catalogue', () => {
  it('🔴 chaque modèle a ses deux langues, ne cite que ses variables, et jamais de tiret long', () => {
    const cles = CATALOGUE.map((m) => m.cle);
    expect(new Set(cles).size).toBe(cles.length);
    for (const m of CATALOGUE) {
      for (const l of LANGUES) {
        const t: TexteEmail = m.textes[l];
        expect(variablesInconnues(m, t), `${m.cle} ${l}`).toEqual([]);
        expect(`${t.sujet}${t.corps}${t.bouton?.libelle ?? ''}`, `${m.cle} ${l}`).not.toMatch(/[\u2013\u2014]/);
        if (t.bouton) expect(t.bouton.lien, `${m.cle} ${l}`).toMatch(/^\{\{[a-z_]+\}\}$|^https:\/\//);
      }
      // Les deux langues citent les mêmes variables : une traduction ne perd pas une date ou un lien.
      expect(variablesCitees(m.textes.en).sort(), m.cle).toEqual(variablesCitees(m.textes.fr).sort());
    }
  });

  it('une variable inconnue se repère, une commune est permise', () => {
    const m = modeleDe('credit_epuise')!;
    expect(variablesInconnues(m, { sujet: '{{espace}} {{ lien_credit }}', corps: '{{solde}}', bouton: { libelle: 'x', lien: '{{pirate}}' } }))
      .toEqual(['solde', 'pirate']);
    expect(Object.keys(variablesDe(m)).sort()).toEqual(['espace', 'lien_credit']);
    expect(modeleDe('inconnu')).toBeNull();
  });
});

describe('le rendu', () => {
  const m = modeleDe('numero_suspendu_fin')!;
  const valeurs = { espace: 'Atelier <Martin>', date_liberation: '2026-10-13T15:14:51Z', lien_numero: 'https://console.test/connecter', _fuseau: 'Europe/Paris' };

  it('🔴 les valeurs ET le texte sont échappés : ni balise ni attribut injectés', () => {
    const t: TexteEmail = { sujet: 'Bonjour {{espace}}', corps: '<script>alert(1)</script>\n\n{{espace}} "quote"', bouton: { libelle: 'Ouvrir', lien: '{{lien_numero}}' } };
    const r = rendre(m, t, valeurs, 'fr');
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<Martin>');
    expect(r.html).toContain('Atelier &lt;Martin&gt;');
    expect(r.sujet).toBe('Bonjour Atelier <Martin>');
    expect(r.html).toContain('href="https://console.test/connecter"');
  });

  it('les dates dans la langue et le fuseau ; une variable sans valeur s’écrit vide ; le sujet sur une ligne', () => {
    expect(dateLisible('2026-10-13T23:30:00Z', 'fr', 'Europe/Paris')).toBe('14 octobre 2026');
    expect(dateLisible('2026-10-13T23:30:00Z', 'en', 'Europe/Paris')).toBe('14 October 2026');
    expect(dateLisible('pas une date', 'fr', 'Europe/Paris')).toBe('pas une date');
    const r = rendre(m, { sujet: 'A\nB {{date_liberation}}', corps: 'X{{inconnue}}Y', bouton: null }, valeurs, 'en');
    expect(r.sujet).toBe('A B 13 October 2026');
    expect(r.text).toBe('XY');
  });

  it('🔴 un bouton dont le lien est vide ou n’est pas une adresse ne s’affiche pas', () => {
    const r = rendre(m, { sujet: 's', corps: 'c', bouton: { libelle: 'Ouvrir', lien: '{{lien_numero}}' } }, { ...valeurs, lien_numero: 'javascript:alert(1)' }, 'fr');
    expect(r.html).not.toContain('javascript:');
    expect(r.text).not.toContain('Ouvrir');
  });

  it('le lien de désinscription en pied et en clair quand il est donné, la langue du document', () => {
    const r = rendre(m, m.textes.en, valeurs, 'en', { desinscription: 'https://api.test/e/desinscription/x' });
    expect(r.html).toContain('lang="en"');
    expect(r.html).toContain('href="https://api.test/e/desinscription/x"');
    expect(r.text).toContain('Stop receiving these e-mails: https://api.test/e/desinscription/x');
    expect(rendre(m, m.textes.fr, valeurs, 'fr').html).not.toContain('desinscription');
  });

  it('l’aperçu : chaque modèle se rend avec ses valeurs d’exemple, sans accolade restante', () => {
    for (const mod of CATALOGUE) {
      for (const l of LANGUES) {
        const r = rendre(mod, mod.textes[l], { ...valeursExemple(mod), espace: 'Atelier' }, l);
        expect(`${r.sujet}${r.text}${r.html}`, `${mod.cle} ${l}`).not.toMatch(/\{\{|\}\}/);
      }
    }
  });
});

describe('le lien de désinscription', () => {
  it('🔴 signé pour une personne et une catégorie : ni un autre secret, ni une autre catégorie, ni une autre personne', () => {
    const jeton = jetonDesinscription(ID, 'commercial', SECRET);
    expect(lireJetonDesinscription(jeton, SECRET)).toEqual({ identityId: ID, categorie: 'commercial' });
    expect(lireJetonDesinscription(jeton, 'autre-secret')).toBeNull();
    expect(lireJetonDesinscription(jeton.replace('.commercial.', '.transfert.'), SECRET)).toBeNull();
    expect(lireJetonDesinscription(jeton.replace(ID.slice(0, 8), 'ffffffff'), SECRET)).toBeNull();
    expect(lireJetonDesinscription(`${ID}.service.${jeton.split('.')[2]}`, SECRET)).toBeNull();
    expect(lireJetonDesinscription(jeton, '')).toBeNull();
    expect(lireJetonDesinscription('n.importe.quoi', SECRET)).toBeNull();
    expect(() => jetonDesinscription(ID, 'commercial', '')).toThrow();
    expect(lienDesinscription('https://api.test/', jeton)).toBe(`https://api.test/e/desinscription/${encodeURIComponent(jeton)}`);
  });
});

describe('l’émission', () => {
  it('🔴 une ligne par personne, le fuseau figé avec les valeurs, une mise en file ratée ne lève pas', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reservees: Array<{ identites: string[]; valeurs: Record<string, string> }> = [];
    const jobs: JobEmail[] = [];
    const e = creerEmetteurEmails({
      adminsConnectes: async () => [],
      reserver: async (r) => { reservees.push(r); return r.identites.map((_, i) => `00000000-0000-4000-8000-00000000000${i}`); },
      fuseau: async () => 'Asia/Tokyo',
      enfiler: async (j) => { if (j.envoiId.endsWith('1')) throw new Error('file'); jobs.push(j); },
    });
    const issue = await e.emettre({ cle: 'numero_libere', tenantId: ID, occasion: 'o', valeurs: { lien_numero: 'x' }, a: { identites: ['i1', 'i2', 'i1'] } });
    expect(issue).toEqual({ destinataires: 2, reserves: 2 });
    expect(reservees[0]).toMatchObject({ identites: ['i1', 'i2'], valeurs: { lien_numero: 'x', _fuseau: 'Asia/Tokyo' } });
    expect(jobs).toEqual([{ envoiId: '00000000-0000-4000-8000-000000000000', tenantId: ID, tentative: 0 }]);
  });
});

describe('le travail de la file', () => {
  const envoi = (o: Partial<EnvoiAFaire> = {}): EnvoiAFaire => ({
    id: '11111111-1111-4111-8111-111111111111', tenantId: ID, cle: 'credit_epuise', statut: 'a_envoyer', tentatives: 0,
    valeurs: { lien_credit: 'https://console.test/credit', _fuseau: 'Europe/Paris' }, identityId: ID, email: 'admin@client.test',
    langue: 'fr', espace: 'Atelier', membreActif: true, desinscriptions: [], ...o,
  });
  const job = (tentative = 0) => ({ envoiId: '11111111-1111-4111-8111-111111111111', tenantId: ID, tentative });

  function monter(o: { e?: EnvoiAFaire | null; actif?: boolean; prendre?: boolean; envoyer?: DepsTravailEmail['envoyer']; texte?: TexteEmail | null } = {}) {
    const notes: string[] = [];
    const envois: Array<Parameters<NonNullable<DepsTravailEmail['envoyer']>>[0]> = [];
    const d: DepsTravailEmail = {
      pourEnvoi: async () => (o.e === undefined ? envoi() : o.e),
      prendre: async () => o.prendre ?? true,
      noterEnvoye: async (_t, _id, resendId) => { notes.push(`envoye:${resendId}`); },
      noterEchec: async (_t, _id, raison, le) => { notes.push(`echec:${le === null ? 'definitif' : le.toISOString()}:${raison}`); },
      noterIgnore: async (_t, _id, raison) => { notes.push(`ignore:${raison}`); },
      actif: async () => o.actif ?? true,
      texteModifie: async () => o.texte ?? null,
      envoyer: o.envoyer === undefined ? async (m) => { envois.push(m); return { id: 're_1' }; } : o.envoyer,
      secretDesinscription: SECRET,
      baseApi: 'https://api.test',
      now: () => new Date('2026-10-14T10:00:00.000Z'),
    };
    return { travail: creerTravailEmail(d), notes, envois };
  }

  it('🔴 un envoi de service part à son adresse, dans sa langue, sans lien de désinscription, et se note avec l’identifiant Resend', async () => {
    const m = monter();
    await m.travail(job());
    expect(m.notes).toEqual(['envoye:re_1']);
    expect(m.envois[0]).toMatchObject({ to: 'admin@client.test', tags: [{ name: 'modele', value: 'credit_epuise' }] });
    expect(m.envois[0]!.subject).toMatch(/Crédit IA épuisé/);
    expect(m.envois[0]!.html).toContain('Atelier');
    expect(m.envois[0]!.headers).toBeUndefined();
    expect(m.envois[0]!.cleIdempotence).toBe('emails-produit/11111111-1111-4111-8111-111111111111');
  });

  it('🔴 une exception après la prise (secret absent, rendu) finit en échec compté, jamais sous bail sans fin', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = monter({ texte: null });
    const sansSecret = creerTravailEmail({
      pourEnvoi: async () => envoi({ cle: 'numero_libere' }), prendre: async () => true,
      noterEnvoye: async () => { m.notes.push('envoye'); }, noterEchec: async (_t, _i, raison, le) => { m.notes.push(`echec:${le === null ? 'definitif' : 'plus_tard'}:${raison}`); },
      noterIgnore: async () => {}, actif: async () => true, texteModifie: async () => { throw new Error('base injoignable'); },
      envoyer: async () => ({ id: 're' }), secretDesinscription: SECRET, baseApi: 'https://api.test',
    });
    await sansSecret(job());
    expect(m.notes).toEqual(['echec:plus_tard:base injoignable']);
  });

  it('🔴 relu au moment d’envoyer : un modèle coupé, une personne qui n’est plus membre, Resend absent : ignoré, rien ne part', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [o, raison] of [
      [{ actif: false }, 'modele_coupe'],
      [{ e: envoi({ membreActif: false }) }, 'plus_membre'],
      [{ envoyer: null }, 'sans_resend'],
      [{ e: envoi({ cle: 'disparu' }) }, 'modele_inconnu'],
    ] as const) {
      const m = monter(o);
      await m.travail(job());
      expect(m.notes, raison).toEqual([`ignore:${raison}`]);
      expect(m.envois).toEqual([]);
    }
  });

  it('🔴 une désinscription ne coupe jamais une alerte de service', async () => {
    const m = monter({ e: envoi({ desinscriptions: ['commercial', 'transfert'] }) });
    await m.travail(job());
    expect(m.notes).toEqual(['envoye:re_1']);
  });

  it('🔴 périmé ou déjà pris : rien ne part (un doublon de job n’envoie pas deux fois)', async () => {
    for (const o of [{ e: null }, { e: envoi({ statut: 'envoye' }) }, { e: envoi({ tentatives: 1 }) }, { prendre: false }]) {
      const m = monter(o);
      await m.travail(job());
      expect(m.envois).toEqual([]);
      expect(m.notes).toEqual([]);
    }
    const illisible = monter();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await illisible.travail({ envoiId: 'pas-un-uuid' });
    expect(illisible.envois).toEqual([]);
  });

  it('le texte modifié dans /ops et la langue de la personne', async () => {
    const m = monter({ e: envoi({ langue: 'en' }), texte: { sujet: 'Modifié {{espace}}', corps: 'Corps', bouton: null } });
    await m.travail(job());
    expect(m.envois[0]!.subject).toBe('Modifié Atelier');
    expect(m.envois[0]!.html).toContain('lang="en"');
  });

  it('🔴 un échec passager se réessaie à l’heure dite, un refus définitif ou le dernier essai est un échec', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const passager = monter({ envoyer: async () => { throw new ResendError(429, 'trop'); } });
    await passager.travail(job());
    expect(passager.notes).toEqual([`echec:${new Date(Date.parse('2026-10-14T10:00:00.000Z') + DELAIS_REESSAI_MS[0]!).toISOString()}:resend 429 : trop`]);
    const reseau = monter({ envoyer: async () => { throw new Error('ECONNRESET'); } });
    await reseau.travail(job());
    expect(reseau.notes[0]).toMatch(/^echec:2026-10-14T10:05:00.000Z:ECONNRESET/);
    const definitif = monter({ envoyer: async () => { throw new ResendError(422, 'adresse invalide'); } });
    await definitif.travail(job());
    expect(definitif.notes).toEqual(['echec:definitif:resend 422 : adresse invalide']);
    const dernier = monter({ e: envoi({ tentatives: DELAIS_REESSAI_MS.length }), envoyer: async () => { throw new ResendError(500, 'panne'); } });
    await dernier.travail(job(DELAIS_REESSAI_MS.length));
    expect(dernier.notes).toEqual(['echec:definitif:resend 500 : panne']);
  });

  it('la reprise remet en file chaque envoi avec son numéro de tentative', async () => {
    const jobs: JobEmail[] = [];
    const n = await reprendreLesEnvois({
      aReprendre: async () => [{ id: 'a', tenantId: ID, tentatives: 2 }],
      enfiler: async (j) => { jobs.push(j); },
    });
    expect(n).toBe(1);
    expect(jobs).toEqual([{ envoiId: 'a', tenantId: ID, tentative: 2 }]);
  });
});
