import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { OUTILS, outilsPour, type DepsMcp, type OutilMcp } from '../src/mcp/outils';
import { DELAI_ATTENTE_MS, PAS_ATTENTE_MS, rappelDeLAbonnement } from '../src/mcp/outils-numero';
import type { EtatDeLEspace } from '../src/stripe/abonnements.pg';
import { RefusOutil } from '../src/mcp/saisie';
import type { Issue } from '../src/lib/issue';
import { signLienNumero, verifyLienNumero, DUREE_LIEN_NUMERO_MS } from '../src/auth/token';
import { empreinteEtat, type EtatConnexion } from '../src/otp/etat-connexion';

/**
 * LES OUTILS DE LA CONNEXION DU NUMÉRO (lot 3c, livraison A, tâche 4). `start_whatsapp_connection` donne le lien qui
 * ouvre la page de connexion sans la console ; `watch_whatsapp_connection` attend le prochain changement (numéro
 * attribué, code, connexion) et rend le code pour que Claude l'affiche dans le terminal.
 */
const SECRET = randomBytes(32).toString('hex');
const PERSONNE = { userId: 'u-admin' };
const VIDE: EtatConnexion = { fourni: null, code: null, connecte: null, abonnement: null };
const outil = (nom: string): OutilMcp => OUTILS.find((o) => o.nom === nom)!;

/** Une horloge simulée : `attendre` avance le temps, et chaque lecture de l'état est comptée avec son heure. */
function monter(etats: (t: number) => EtatConnexion, o: { portail?: Issue<{ url: string }>; abonnement?: EtatDeLEspace | null } = {}) {
  let t = 1_000_000;
  const lectures: Array<{ tenant: string; t: number }> = [];
  const portails: Array<{ tenant: string; payeur: string }> = [];
  const paiements: Array<{ tenant: string; payeur: string }> = [];
  const couteux: string[] = [];
  const deps = {
    numero: {
      signerLien: (l: Parameters<typeof signLienNumero>[0]) => signLienNumero(l, SECRET),
      etat: async (tenant: string) => { lectures.push({ tenant, t }); return etats(t); },
      urlConsole: 'https://console.exemple.test',
      attendre: async (ms: number) => { t += ms; },
      maintenant: () => t,
      ouvrirPortail: async (tenant: string, payeur: string) => {
        portails.push({ tenant, payeur });
        return o.portail ?? { ok: true as const, valeur: { url: 'https://billing.stripe.com/p/session/x' } };
      },
      abonnement: async () => (o.abonnement === undefined ? null : o.abonnement),
      ouvrirAbonnement: async (tenant: string, payeur: string) => {
        paiements.push({ tenant, payeur });
        return { ok: true as const, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_reabo' } };
      },
    },
    couteux: { consommer: async (tenant: string) => { couteux.push(tenant); return { accepte: true, attenteMs: 0 }; } },
  } as unknown as DepsMcp;
  return { deps, lectures, debut: t, portails, couteux, paiements };
}

describe('start_whatsapp_connection', () => {
  it('rend un lien vers /brancher, le jeton APRÈS le #, signé pour cet espace, cette personne et ce mode', async () => {
    const { deps, debut } = monter(() => VIDE);
    const r = await outil('start_whatsapp_connection').executer(deps, 't1', { mode: 'fourni' }, PERSONNE) as Record<string, string>;
    const [base, jeton] = r.url!.split('#');
    expect(base).toBe('https://console.exemple.test/brancher');
    expect(await verifyLienNumero(jeton!, SECRET)).toEqual({ tenantId: 't1', userId: 'u-admin', mode: 'fourni' });
    expect(r.expire_le).toBe(new Date(debut + DUREE_LIEN_NUMERO_MS).toISOString());
    expect(typeof r.consigne).toBe('string');
  });

  it('le mode apporté est porté par le jeton, et sa consigne parle de l’application WhatsApp', async () => {
    const { deps } = monter(() => VIDE);
    const r = await outil('start_whatsapp_connection').executer(deps, 't1', { mode: 'apporte' }, PERSONNE) as Record<string, string>;
    expect((await verifyLienNumero(r.url!.split('#')[1]!, SECRET))?.mode).toBe('apporte');
    expect(outil('start_whatsapp_connection').description).toMatch(/application WhatsApp/);
  });

  it('🔴 refuse quand un numéro est déjà connecté, et un mode inconnu', async () => {
    const { deps } = monter(() => ({ ...VIDE, connecte: { chiffres: '33600000000', aActiver: false } }));
    await expect(outil('start_whatsapp_connection').executer(deps, 't1', { mode: 'fourni' }, PERSONNE)).rejects.toBeInstanceOf(RefusOutil);
    const vide = monter(() => VIDE).deps;
    await expect(outil('start_whatsapp_connection').executer(vide, 't1', { mode: 'autre' }, PERSONNE)).rejects.toBeInstanceOf(RefusOutil);
  });
});

describe('watch_whatsapp_connection', () => {
  const ATTRIBUE: EtatConnexion = { ...VIDE, fourni: '+441235619343' };
  const AVEC_CODE: EtatConnexion = { ...ATTRIBUE, code: { code: '123456', recuLe: '2026-10-06T08:53:01.000Z' } };

  it('sans état connu : rend tout de suite, une seule lecture', async () => {
    const { deps, lectures } = monter(() => ATTRIBUE);
    const r = await outil('watch_whatsapp_connection').executer(deps, 't1', {}, PERSONNE) as Record<string, unknown>;
    expect(lectures).toHaveLength(1);
    expect(r.change).toBe(true);
    expect(r.empreinte).toBe(empreinteEtat(ATTRIBUE));
  });

  it('rend dès que l’état change, avec le code en clair pour que Claude l’affiche', async () => {
    const { deps, debut } = monter((t) => (t >= 1_000_000 + 6_000 ? AVEC_CODE : ATTRIBUE));
    const r = await outil('watch_whatsapp_connection').executer(deps, 't1', { etat_connu: empreinteEtat(ATTRIBUE) }, PERSONNE) as Record<string, unknown>;
    expect(r.change).toBe(true);
    expect(r.code).toBe('123456');
    expect(r.empreinte).toBe(empreinteEtat(AVEC_CODE));
    expect(deps.numero.maintenant() - debut).toBe(6_000);
  });

  it(`🔴 sans changement : rend au plus tard à ${DELAI_ATTENTE_MS / 1000} s, sans aucune lecture au-delà`, async () => {
    const { deps, lectures, debut } = monter(() => ATTRIBUE);
    const r = await outil('watch_whatsapp_connection').executer(deps, 't1', { etat_connu: empreinteEtat(ATTRIBUE) }, PERSONNE) as Record<string, unknown>;
    expect(r.change).toBe(false);
    expect(lectures.every((l) => l.t - debut <= DELAI_ATTENTE_MS)).toBe(true);
    expect(deps.numero.maintenant() - debut).toBeLessThanOrEqual(DELAI_ATTENTE_MS);
    expect(lectures.length).toBe(Math.floor(DELAI_ATTENTE_MS / PAS_ATTENTE_MS) + 1);
    expect(lectures.every((l) => l.tenant === 't1')).toBe(true);
  });

  it('le délai passe sous les 45 s du proxy de l’API, avec de la marge', () => {
    expect(DELAI_ATTENTE_MS).toBeLessThanOrEqual(30_000);
  });

  it('🔴 relié mais pas encore activé par Meta : ni « connecté » ni « fini », et Claude le dit', async () => {
    const { deps } = monter(() => ({ ...ATTRIBUE, connecte: { chiffres: '441235619343', aActiver: true } }));
    const r = await outil('watch_whatsapp_connection').executer(deps, 't1', {}, PERSONNE) as Record<string, unknown>;
    expect(r.etat).toMatchObject({ connecte: false, a_activer: true });
    expect(String(r.suite)).toMatch(/activ/);
    expect(String(r.suite)).not.toMatch(/fini/);
  });

  it('le paiement confirmé réveille l’attente, et l’état dit l’abonnement et sa prochaine échéance', async () => {
    const PAYE: EtatConnexion = { ...VIDE, abonnement: { statut: 'actif', periodeFin: '2026-11-06T09:00:00.000Z' } };
    const { deps } = monter((t) => (t >= 1_000_000 + 4_000 ? PAYE : VIDE));
    const r = await outil('watch_whatsapp_connection').executer(deps, 't1', { etat_connu: empreinteEtat(VIDE) }, PERSONNE) as Record<string, unknown>;
    expect(r.change).toBe(true);
    expect(r.etat).toMatchObject({ abonnement: 'actif', prochaine_echeance: '2026-11-06T09:00:00.000Z' });
  });

  it('pas de code tant qu’il n’est pas arrivé ; le numéro connecté est dit', async () => {
    const { deps } = monter(() => ({ ...ATTRIBUE, connecte: { chiffres: '441235619343', aActiver: false } }));
    const r = await outil('watch_whatsapp_connection').executer(deps, 't1', {}, PERSONNE) as Record<string, unknown>;
    expect(r.code).toBeNull();
    expect(r.etat).toMatchObject({ numero_fourni: '+441235619343', numero_connecte: '+441235619343', connecte: true, a_activer: false });
  });
});

describe('les outils de l’abonnement du numéro (livraison B)', () => {
  it('get_number_subscription : le statut, la prochaine échéance, le numéro fourni ; et sans abonnement, null', async () => {
    const { deps } = monter(() => ({ ...VIDE, fourni: '+441235619343', abonnement: { statut: 'en_retard', periodeFin: '2026-11-06T09:00:00.000Z' } }));
    expect(await outil('get_number_subscription').executer(deps, 't1', {}, null))
      .toEqual({
        abonnement: 'en_retard', prochaine_echeance: '2026-11-06T09:00:00.000Z', numero_fourni: '+441235619343', prix: '3,50 € HT par mois',
        etat: null, fin_prevue: null, coupure_le: null, liberation_le: null,
      });
    const sans = monter(() => VIDE).deps;
    expect(await outil('get_number_subscription').executer(sans, 't1', {}, null)).toMatchObject({ abonnement: null, prochaine_echeance: null });
  });

  it('🔴 manage_number_subscription : le portail de Stripe au nom de la personne, compté dans les opérations lourdes', async () => {
    const { deps, portails, couteux } = monter(() => VIDE);
    expect(await outil('manage_number_subscription').executer(deps, 't1', {}, PERSONNE)).toEqual({ url: 'https://billing.stripe.com/p/session/x' });
    expect(portails).toEqual([{ tenant: 't1', payeur: 'u-admin' }]);
    expect(couteux).toEqual(['t1']);
    const refus = monter(() => VIDE, { portail: { ok: false, statut: 409, erreur: 'Cet espace n’a aucun abonnement à gérer.' } }).deps;
    await expect(outil('manage_number_subscription').executer(refus, 't1', {}, PERSONNE)).rejects.toBeInstanceOf(RefusOutil);
  });

  it('🔴 manage exige une personne ; get se lit avec une clé', () => {
    expect(outil('manage_number_subscription')).toMatchObject({ scope: 'mcp:write', exigePersonne: true });
    expect(outil('get_number_subscription')).toMatchObject({ scope: 'mcp:read' });
    expect(outil('get_number_subscription').exigePersonne).toBeUndefined();
  });
});

const DATE = (iso: string) => new Date(iso);
const etatAbo = (e: Partial<EtatDeLEspace>): EtatDeLEspace => ({
  abonnementId: 'sub_1', etat: 'actif', finPrevueLe: null, liberationLe: null, coupureLe: null, finiLe: null, libereLe: null, ...e,
});

describe('le lot 4 : l’état de l’abonnement pour Claude, et le réabonnement', () => {
  it('get_number_subscription dit l’état et ses dates (coupure, fin prévue, libération)', async () => {
    const { deps } = monter(() => VIDE, { abonnement: etatAbo({ etat: 'suspendu', finiLe: DATE('2026-10-06T15:14:51Z'), liberationLe: DATE('2026-10-13T15:14:51Z') }) });
    expect(await outil('get_number_subscription').executer(deps, 't1', {}, null)).toMatchObject({
      etat: 'suspendu', liberation_le: '2026-10-13T15:14:51.000Z', coupure_le: null, fin_prevue: null,
    });
  });

  it('🔴 resubscribe_number : abonnement FINI, numéro gardé -> un nouveau paiement, au nom de la personne, compté', async () => {
    const { deps, paiements, portails, couteux } = monter(() => VIDE, { abonnement: etatAbo({ etat: 'suspendu', finiLe: DATE('2026-10-06T15:14:51Z') }) });
    const r = await outil('resubscribe_number').executer(deps, 't1', {}, PERSONNE) as Record<string, string>;
    expect(r.url).toBe('https://checkout.stripe.com/c/pay/cs_reabo');
    expect(paiements).toEqual([{ tenant: 't1', payeur: 'u-admin' }]);
    expect(portails).toEqual([]);
    expect(couteux).toEqual(['t1']);
  });

  it('resubscribe_number : impayé (en retard ou suspendu sans fin) ou fin prévue -> le portail', async () => {
    for (const e of [etatAbo({ etat: 'en_retard' }), etatAbo({ etat: 'suspendu' }), etatAbo({ etat: 'fin_prevue', finPrevueLe: DATE('2026-11-06T00:00:00Z') })]) {
      const { deps, portails, paiements } = monter(() => VIDE, { abonnement: e });
      expect((await outil('resubscribe_number').executer(deps, 't1', {}, PERSONNE) as Record<string, string>).url).toBe('https://billing.stripe.com/p/session/x');
      expect([portails.length, paiements.length]).toEqual([1, 0]);
    }
  });

  it('resubscribe_number : actif, libéré, ou aucun abonnement -> un refus qui dit quoi faire', async () => {
    for (const [e, motif] of [[etatAbo({ etat: 'actif' }), /actif/], [etatAbo({ etat: 'libere' }), /start_whatsapp_connection/], [null, /start_whatsapp_connection/]] as const) {
      const { deps } = monter(() => VIDE, { abonnement: e });
      await expect(outil('resubscribe_number').executer(deps, 't1', {}, PERSONNE)).rejects.toThrow(motif);
    }
  });

  it('🔴 resubscribe_number exige une personne (le paiement est son geste)', () => {
    expect(outil('resubscribe_number')).toMatchObject({ scope: 'mcp:write', exigePersonne: true });
  });

  it('le rappel : en retard, avec la date de coupure ; suspendu, avec la libération si le numéro est gardé ; sinon rien', () => {
    expect(rappelDeLAbonnement(etatAbo({ etat: 'en_retard', coupureLe: DATE('2026-10-20T10:00:00Z') }))).toMatch(/2026-10-20/);
    expect(rappelDeLAbonnement(etatAbo({ etat: 'suspendu', finiLe: DATE('2026-10-06T15:14:51Z'), liberationLe: DATE('2026-10-13T15:14:51Z') }))).toMatch(/coupés[\s\S]*2026-10-13/);
    expect(rappelDeLAbonnement(etatAbo({ etat: 'suspendu' }))).toMatch(/resubscribe_number/);
    for (const e of [null, etatAbo({ etat: 'actif' }), etatAbo({ etat: 'fin_prevue' }), etatAbo({ etat: 'libere' })]) {
      expect(rappelDeLAbonnement(e)).toBeNull();
    }
  });

  it('🔴 en retard SANS date de coupure (un autre numéro envoie, rien ne sera coupé) : aucune date inventée', () => {
    const r = rappelDeLAbonnement(etatAbo({ etat: 'en_retard', coupureLe: null }));
    expect(r).toMatch(/resubscribe_number/);
    expect(r).not.toMatch(/coupés|bientôt/);
  });

  it('🔴 get_number_subscription répond même si la lecture de l’état échoue (jaune 7 de A)', async () => {
    const { deps } = monter(() => VIDE);
    deps.numero = { ...deps.numero, abonnement: async () => { throw new Error('pooler injoignable'); } };
    expect(await outil('get_number_subscription').executer(deps, 't1', {}, null)).toMatchObject({ etat: null, liberation_le: null });
  });
});

describe('les deux outils dans le catalogue', () => {
  it('🔴 écritures qui exigent une personne : invisibles avec une clé d’API', () => {
    for (const nom of ['start_whatsapp_connection', 'watch_whatsapp_connection']) {
      expect(outil(nom).scope).toBe('mcp:write');
      expect(outil(nom).exigePersonne).toBe(true);
    }
    const avecCle = outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null }).map((o) => o.nom);
    expect(avecCle).not.toContain('start_whatsapp_connection');
    expect(avecCle).not.toContain('watch_whatsapp_connection');
  });

  it('les bornes de l’empreinte sont annoncées dans le schéma', () => {
    const p = outil('watch_whatsapp_connection').entree.properties.etat_connu!;
    expect(p.maxLength).toBe(16);
    expect(p.pattern).toBe('^[0-9a-f]{16}$');
    expect(outil('start_whatsapp_connection').entree.properties.mode!.enum).toEqual(['fourni', 'apporte']);
  });
});
