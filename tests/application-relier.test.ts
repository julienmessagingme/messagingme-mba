import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { signLienNumero, verifyLienNumero } from '../src/auth/token';
import { empreinteEtat, lireEtatConnexion, type EtatConnexion } from '../src/otp/etat-connexion';
import { qrApplication, relierApplication, type DepsConnexionApplication } from '../src/application/connexion';
import type { CompteApplication, StatutCompte } from '../src/application/comptes';
import type { ClientApplication } from '../src/application/client';
import { OUTILS, type DepsMcp, type OutilMcp } from '../src/mcp/outils';
import { etatMiseEnService, type LecturesMiseEnService } from '../src/mcp/mise-en-service';

/**
 * RELIER, FILIÈRE APPLICATION (plan 2026-10-22, tâche 6) : depuis Claude (`start_whatsapp_connection` avec
 * `filiere: application`) et la page du lien, par QR code. Le parcours de l'API ne change pas d'un octet.
 */
const T = 'bbbbbbbb-0000-4000-8000-000000000002';
const COMPTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const SECRET = randomBytes(32).toString('hex');

const compte = (statut: StatutCompte, numero = '447700900000'): CompteApplication => ({
  id: COMPTE, tenantId: T, numero, jid: null, statut, fourniId: null, relieLe: null, dernierMessageLe: null, statutChangeLe: new Date(0),
});

describe('le jeton du lien', () => {
  it('🔴 sans filière, le jeton est exactement celui d’aujourd’hui', async () => {
    const jeton = await signLienNumero({ tenantId: T, userId: 'u1', mode: 'fourni' }, SECRET);
    expect(await verifyLienNumero(jeton, SECRET)).toEqual({ tenantId: T, userId: 'u1', mode: 'fourni' });
  });

  it('la filière application voyage dans le jeton', async () => {
    const jeton = await signLienNumero({ tenantId: T, userId: 'u1', mode: 'apporte', filiere: 'application' }, SECRET);
    expect(await verifyLienNumero(jeton, SECRET)).toEqual({ tenantId: T, userId: 'u1', mode: 'apporte', filiere: 'application' });
  });
});

const depsEtat = (c: CompteApplication | null) => ({
  numeros: { numeroDeLEspace: async () => null, codeDeLEspace: async () => null },
  numeroConnecte: async () => null,
  abonnements: { deLEspace: async () => null },
  pro: { vivant: async () => false },
  application: { comptes: { parEspace: async () => c } },
});

describe('l’état de la connexion', () => {
  it('🔴 un compte relié est connecté, sous son numéro ; en attente, il ne l’est pas', async () => {
    const relie = await lireEtatConnexion(depsEtat(compte('relie')), T);
    expect(relie.connecte).toEqual({ chiffres: '447700900000', aActiver: false });
    expect(relie.application).toEqual({ statut: 'relie', numero: '447700900000' });
    const attente = await lireEtatConnexion(depsEtat(compte('en_attente')), T);
    expect(attente.connecte).toBeNull();
    expect(empreinteEtat(attente)).not.toBe(empreinteEtat(relie));
  });

  it('sans compte de l’application, l’état est celui d’aujourd’hui', async () => {
    expect(await lireEtatConnexion(depsEtat(null), T)).toEqual({ fourni: null, code: null, connecte: null, abonnement: null, inclusDansLePro: false });
  });
});

function banc(o: { compte?: CompteApplication | null; fourni?: { id: string; numero: string } | null; client?: Partial<ClientApplication> | null; qr?: string | null } = {}) {
  const traces: string[] = [];
  let actuel = o.compte ?? null;
  const client: ClientApplication | null = o.client === null ? null : {
    relier: async (id) => { traces.push(`relier:${id}`); return { ok: true }; },
    qr: async () => ({ ok: true, qr: o.qr ?? 'QR-TEXTE', ouverte: false, statut: 'en_attente' }),
    envoyer: async () => ({ ok: false, raison: 'refuse' }),
    sommeil: async () => ({ ok: true }), retirer: async () => ({ ok: true }),
    ...o.client,
  };
  const d: DepsConnexionApplication = {
    comptes: {
      parEspace: async () => actuel,
      preparer: async (_t, e) => { traces.push(`preparer:${e.numero}:${e.fourniId}`); actuel = compte('en_attente', e.numero); return { ok: true, compte: actuel }; },
    },
    client,
    numeroFourni: async () => o.fourni ?? null,
    offrirCredit: async (t) => { traces.push(`credit:${t}`); },
    qrEnImage: async (texte) => `data:image/svg+xml;base64,${Buffer.from(texte).toString('base64')}`,
  };
  return { d, traces };
}

describe('relier depuis la page du lien', () => {
  it('le numéro de l’utilisateur, préparé par Claude : la session s’ouvre, le QR code suit', async () => {
    const { d, traces } = banc({ compte: compte('en_attente') });
    expect(await relierApplication(d, T)).toEqual({ ok: true, valeur: { compteId: COMPTE } });
    expect(traces).toEqual([`relier:${COMPTE}`]);
  });

  it('un numéro fourni attribué se prépare avec sa réserve, puis se relie', async () => {
    const { d, traces } = banc({ fourni: { id: 'f1', numero: '441234567890' } });
    expect((await relierApplication(d, T)).ok).toBe(true);
    expect(traces).toEqual(['preparer:441234567890:f1', `relier:${COMPTE}`]);
  });

  it('un compte déjà relié ne se relie pas deux fois ; sans numéro, le refus dit quoi faire', async () => {
    expect(await relierApplication(banc({ compte: compte('relie') }).d, T)).toMatchObject({ ok: false, statut: 409 });
    const rien = await relierApplication(banc().d, T);
    expect(rien).toMatchObject({ ok: false, statut: 409 });
    expect(rien.ok ? '' : rien.erreur).toMatch(/Claude/);
  });

  it('sans service de connexions, un refus 503 lisible', async () => {
    expect(await relierApplication(banc({ compte: compte('en_attente'), client: null }).d, T)).toMatchObject({ ok: false, statut: 503 });
  });

  it('le QR code arrive en image ; un compte relié n’en a plus, et son crédit offert est servi', async () => {
    const attente = banc({ compte: compte('en_attente') });
    const q = await qrApplication(attente.d, T);
    expect(q).toMatchObject({ statut: 'en_attente', relie: false });
    expect(q.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    const relie = banc({ compte: compte('relie') });
    expect(await qrApplication(relie.d, T)).toEqual({ statut: 'relie', qr: null, relie: true });
    expect(relie.traces).toEqual([`credit:${T}`]);
  });
});

const outil = (nom: string): OutilMcp => OUTILS.find((x) => x.nom === nom)!;
const VIDE: EtatConnexion = { fourni: null, code: null, connecte: null, abonnement: null, inclusDansLePro: false };

function mcp(o: { etat?: EtatConnexion; preparer?: Awaited<ReturnType<DepsConnexionApplication['comptes']['preparer']>> } = {}) {
  const prepares: string[] = [];
  const deps = {
    numero: {
      signerLien: (l: Parameters<typeof signLienNumero>[0]) => signLienNumero(l, SECRET),
      etat: async () => o.etat ?? VIDE,
      urlConsole: 'https://console.exemple.test',
      attendre: async () => {},
      maintenant: () => 1_000_000,
      comptesApplication: {
        preparer: async (t: string, e: { numero: string; fourniId: string | null }) => {
          prepares.push(`${t}:${e.numero}`);
          return o.preparer ?? { ok: true as const, compte: compte('en_attente', e.numero) };
        },
      },
    },
  } as unknown as DepsMcp;
  return { deps, prepares };
}

describe('start_whatsapp_connection, filière application', () => {
  it('🔴 son propre numéro : Claude le donne, le compte se prépare, et le lien porte la filière', async () => {
    const { deps, prepares } = mcp();
    const r = await outil('start_whatsapp_connection').executer(deps, T, { mode: 'apporte', filiere: 'application', numero: '+44 7700 900000' }, { userId: 'u1' }) as Record<string, string>;
    expect(prepares).toEqual([`${T}:447700900000`]);
    expect(await verifyLienNumero(r.url!.split('#')[1]!, SECRET)).toMatchObject({ mode: 'apporte', filiere: 'application' });
    expect(r.consigne).toMatch(/QR/);
  });

  it('son propre numéro sans numéro : refusé, sans rien préparer', async () => {
    const { deps, prepares } = mcp();
    await expect(outil('start_whatsapp_connection').executer(deps, T, { mode: 'apporte', filiere: 'application' }, { userId: 'u1' })).rejects.toThrow(/numero/);
    expect(prepares).toEqual([]);
  });

  it('un numéro déjà tenu par un autre espace est refusé avec une phrase', async () => {
    const { deps } = mcp({ preparer: { ok: false, raison: 'numero_pris' } });
    await expect(outil('start_whatsapp_connection').executer(deps, T, { mode: 'apporte', filiere: 'application', numero: '447700900000' }, { userId: 'u1' }))
      .rejects.toThrow(/déjà/);
  });

  it('un numéro fourni : rien ne se prépare avant son attribution, le lien porte la filière', async () => {
    const { deps, prepares } = mcp();
    const r = await outil('start_whatsapp_connection').executer(deps, T, { mode: 'fourni', filiere: 'application' }, { userId: 'u1' }) as Record<string, string>;
    expect(prepares).toEqual([]);
    expect(await verifyLienNumero(r.url!.split('#')[1]!, SECRET)).toMatchObject({ mode: 'fourni', filiere: 'application' });
  });

  it('watch_whatsapp_connection dit l’état du compte et demande de scanner le QR code', async () => {
    const { deps } = mcp({ etat: { ...VIDE, application: { statut: 'en_attente', numero: '447700900000' } } });
    const r = await outil('watch_whatsapp_connection').executer(deps, T, {}, { userId: 'u1' }) as { etat: Record<string, unknown>; suite: string };
    expect(r.etat).toMatchObject({ filiere: 'application', compte_application: 'en_attente', connecte: false });
    expect(r.suite).toMatch(/QR/);
  });
});

describe('get_setup_state, filière application', () => {
  const lectures = (application: EtatConnexion['application'], connecte: EtatConnexion['connecte']): LecturesMiseEnService => ({
    offre: { offre: 'free', fonctions: [] }, soldeMicroEur: 1_000_000,
    numero: { ...VIDE, connecte, ...(application ? { application } : {}) },
    agents: [], reglages: { mbaEnabled: false, repondeurMode: 'equipe', repondeurAgentId: null, repondeurWorkflowId: null, repondeurAdresseId: null },
    widgets: [],
  });

  it('🔴 un compte relié passe à l’étape suivante, et la filière se lit', () => {
    const e = etatMiseEnService(lectures({ statut: 'relie', numero: '447700900000' }, { chiffres: '447700900000', aActiver: false }));
    expect(e.etape_suivante).toBe('creer_agent');
    expect(e.numero).toMatchObject({ connecte: true, filiere: 'application' });
  });

  it('🔴 un numéro coupé par WhatsApp ou un appareil retiré : l’avertissement le dit, et l’étape revient au numéro', () => {
    for (const statut of ['banni', 'deconnecte'] as const) {
      const e = etatMiseEnService(lectures({ statut, numero: '447700900000' }, null));
      expect(e.avertissements).toContain('numero_coupe');
      expect(e.etape_suivante).toBe('connecter_numero');
    }
  });

  it('un compte endormi : l’avertissement le dit', () => {
    expect(etatMiseEnService(lectures({ statut: 'sommeil', numero: '447700900000' }, null)).avertissements).toContain('numero_en_sommeil');
  });

  it('la filière API se lit api', () => {
    expect(etatMiseEnService(lectures(undefined, { chiffres: '33612345678', aActiver: false })).numero).toMatchObject({ filiere: 'api' });
  });
});
