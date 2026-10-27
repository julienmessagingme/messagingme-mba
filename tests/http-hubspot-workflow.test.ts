import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signRequest } from '../src/lib/signature';
import { RELANCE_EN_COURS_SEC, RELANCE_META_SEC, VARIABLES_WORKFLOW_MAX, type HubspotWorkflowDeps } from '../src/http/hubspot-workflow';
import { cleDuWorkflow, valeursDuWorkflow } from '../src/hubspot-workflow/envoi';
import { plafondsDesWorkflows, type VerdictPlafonds } from '../src/hubspot-workflow/plafonds';
import { DUREE_CLE_IDEMPOTENCE_MS } from '../src/api/idempotence';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import { COMPTEUR_ENVOI_REFUSE, type OptionsEnvoiPublic, type ResultatEnvoiPublic } from '../src/api/envoi-public';
import type { EtatLigneHubspot } from '../src/http/hubspot-conversation';
import type { Fonction } from '../src/offres/offres';
import type { Filiere } from '../src/application/comptes';
import type { TemplateSummary } from '../src/meta/templates';

/**
 * L'ACTION DE WORKFLOW HUBSPOT « ENVOYER UN MODÈLE WHATSAPP » (cadrage du 2026-10-27, lot 1). Une porte d'ENVOI ouverte à
 * la masse : chaque refus de la route est vérifié par ce qui n'est PAS parti ni compté. Le cœur d'envoi est faux ici (il
 * compte, puis rend la réponse demandée) ; l'adaptateur passe par le vrai dans `tests/v1-sends.test.ts`, où se voit ce
 * que le cœur compte vraiment.
 */
const SECRET = 'secret-partage-avec-le-connecteur-hubspot';
const NOW = 1_786_000_000_000;
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T_MAJ = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

function tpl(name: string, category: string, body: string, extra: Partial<TemplateSummary> = {}): TemplateSummary {
  return { id: name, name, status: 'APPROVED', category, language: 'fr', body, headerFormat: null, isCarousel: false, ...extra } as TemplateSummary;
}

const CATALOGUE: TemplateSummary[] = [
  tpl('suivi_devis', 'UTILITY', 'Bonjour {{1}}, votre devis {{2}} est prêt. {{1}}'),
  tpl('offre_rentree', 'MARKETING', 'Bonjour {{1}}, découvrez notre offre.'),
  tpl('carrousel_suivi', 'UTILITY', 'Vos commandes', { isCarousel: true }),
  tpl('brouillon', 'UTILITY', 'Pas encore approuvé', { status: 'PENDING' }),
  tpl('onze', 'UTILITY', Array.from({ length: VARIABLES_WORKFLOW_MAX + 1 }, (_, i) => `{{${i + 1}}}`).join(' ')),
  tpl('entete_variable', 'UTILITY', 'Bonjour {{1}}', { headerFormat: 'TEXT', headerText: 'Devis {{1}}' }),
  tpl('saut', 'UTILITY', '{{1}} puis {{3}}'),
  tpl('rappel_rdv', 'UTILITY', 'Votre rendez-vous est confirmé.', { language: 'en' }),
];

interface Options {
  fonctions?: Fonction[];
  branche?: boolean;
  ligne?: EtatLigneHubspot;
  filiere?: Filiere | null;
  /** La réponse du cœur d'envoi, une fois le compteur passé (défaut : un envoi créé). */
  reponse?: ResultatEnvoiPublic;
  plafonds?: VerdictPlafonds;
  /** Le catalogue lève (Meta ne répond pas). */
  catalogueLeve?: boolean;
}

function app(o: Options = {}) {
  const lus: Array<[string, string]> = [];
  const envois: Array<{ t: string; corps: unknown; options: OptionsEnvoiPublic }> = [];
  const comptes: string[] = [];
  const lire = <T>(quoi: string, v: T) => async (t: string): Promise<T> => { lus.push([quoi, t]); return v; };
  const deps: HubspotWorkflowDeps = {
    secret: SECRET,
    fonctions: lire('fonctions', new Set<Fonction>(o.fonctions ?? ['crm'])),
    workflowsBranches: lire('reglage', o.branche ?? true),
    ligneHubspot: lire('ligne', o.ligne ?? 'reliee'),
    filiere: lire('filiere', o.filiere === undefined ? 'api' : o.filiere),
    catalogue: async (t) => { lus.push(['catalogue', t]); if (o.catalogueLeve) throw new Error('Graph 503'); return CATALOGUE; },
    envoyer: async (t, corps, compter, options) => {
      if (!(await compter(1))) return COMPTEUR_ENVOI_REFUSE;
      envois.push({ t, corps, options });
      return o.reponse ?? { statut: 201, corps: { sendId: 'envoi-1', recipientCount: 1, skipped: [] } };
    },
    plafonds: async (t) => { comptes.push(t); return o.plafonds ?? { accepte: true }; },
    now: () => NOW,
  };
  const server = buildServer({ queue: new FakeQueue(), hubspotWorkflow: deps });
  return { server, lus, envois, comptes };
}

/** Signe un corps comme le connecteur (même format canonique, même chemin). */
function appel(route: 'modeles' | 'modele', body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const path = `/hubspot/workflow/${route}`;
  const sig = signRequest(secret, { ts: NOW, nonce: randomBytes(8).toString('hex'), method: 'POST', path, body: raw });
  return { method: 'POST' as const, url: path, headers: { 'content-type': 'application/json', 'x-mm-service-signature': sig }, payload: raw };
}

const ENVOI = { tenantId: T1, telephone: '06 12 34 56 78', modele: 'suivi_devis', langue: 'fr', valeurs: ['Julien', 'D-1002'], workflowId: '1234567' };
const corpsDe = (route: 'modeles' | 'modele') => (route === 'modele' ? ENVOI : { tenantId: T1 });

describe('les deux routes de l’action de workflow : la porte', () => {
  it.each(['modeles', 'modele'] as const)('🔴 %s : signature absente ou d’un autre secret, 401, rien n’est lu ni envoyé', async (route) => {
    const { server, lus, envois } = app();
    const sans = await server.inject({ method: 'POST', url: `/hubspot/workflow/${route}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(corpsDe(route)) });
    const autre = await server.inject(appel(route, corpsDe(route), 'un-autre-secret-de-meme-longueur-000'));
    expect([sans.statusCode, autre.statusCode]).toEqual([401, 401]);
    expect([lus, envois]).toEqual([[], []]);
    expect((await server.inject(appel(route, corpsDe(route)))).statusCode).toBe(200);
    await server.close();
  });

  it('un corps hors contrat : 400, rien n’est lu', async () => {
    const { server, lus } = app();
    for (const corps of [
      { ...ENVOI, consent: 'opted_in' },
      { ...ENVOI, tenantId: 'pas-un-uuid' },
      { ...ENVOI, valeurs: Array.from({ length: VARIABLES_WORKFLOW_MAX + 1 }, () => 'x') },
      { ...ENVOI, workflowId: '12/../34' },
      { ...ENVOI, modele: '' },
    ]) expect((await server.inject(appel('modele', corps))).statusCode, JSON.stringify(corps)).toBe(400);
    expect(lus).toEqual([]);
    await server.close();
  });

  it.each(['modeles', 'modele'] as const)('🔴 %s : une offre sans HubSpot rend 402 avant même de lire le réglage', async (route) => {
    const { server, lus, envois } = app({ fonctions: ['inbox'] });
    const res = await server.inject(appel(route, corpsDe(route)));
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'plan_feature_unavailable', fonction: 'crm' });
    expect(lus).toEqual([['fonctions', T1]]);
    expect(envois).toEqual([]);
    await server.close();
  });

  it.each(['modeles', 'modele'] as const)('🔴 %s : le réglage « Workflows HubSpot » éteint rend 403, rien ne part', async (route) => {
    const { server, envois, comptes } = app({ branche: false });
    const res = await server.inject(appel(route, corpsDe(route)));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'workflows_hubspot_eteints' });
    expect([envois, comptes]).toEqual([[], []]);
    await server.close();
  });

  it('🔴 la ligne non reliée à HubSpot, ou la filière de l’application : 409 définitif, rien ne part ni n’est compté', async () => {
    for (const [o, code] of [[{ ligne: 'pause' as const }, 'ligne_non_reliee'], [{ filiere: 'application' as const }, 'whatsapp_app_no_template']] as const) {
      const { server, envois, comptes } = app(o);
      const res = await server.inject(appel('modele', ENVOI));
      expect(res.statusCode, code).toBe(409);
      expect(res.json(), code).toMatchObject({ code });
      expect([envois, comptes], code).toEqual([[], []]);
      await server.close();
    }
  });

  it('🔴 l’espace lu est celui du corps signé, à chaque dépendance, ramené en minuscules', async () => {
    const { server, lus, envois, comptes } = app();
    expect((await server.inject(appel('modele', { ...ENVOI, tenantId: T2 }))).statusCode).toBe(200);
    expect(new Set(lus.map(([, t]) => t))).toEqual(new Set([T2]));
    expect(envois.map((e) => e.t)).toEqual([T2]);
    expect(comptes).toEqual([T2]);
    await server.close();
    const maj = app();
    expect((await maj.server.inject(appel('modele', { ...ENVOI, tenantId: T_MAJ }))).statusCode).toBe(200);
    expect(new Set([...maj.lus.map(([, t]) => t), ...maj.comptes, ...maj.envois.map((e) => e.t)])).toEqual(new Set([T_MAJ.toLowerCase()]));
    await maj.server.close();
  });
});

describe('POST /hubspot/workflow/modeles : ce qu’un workflow peut envoyer', () => {
  it('🔴 le jugement de `/v1/sends`, puis Service seulement, sans carrousel, dix variables au plus', async () => {
    const { server } = app();
    const res = await server.inject(appel('modeles', { tenantId: T1 }));
    expect(res.statusCode).toBe(200);
    // Ni Marketing, ni carrousel, ni brouillon, ni onze variables, ni un en-tête texte à variable (que rien ne remplit).
    // Les variables sont le max des positions, comme l'envoi les compte : `saut` en attend 3.
    expect(res.json()).toEqual({
      modeles: [
        { name: 'suivi_devis', language: 'fr', texte: 'Bonjour {{1}}, votre devis {{2}} est prêt. {{1}}', variables: 2 },
        { name: 'saut', language: 'fr', texte: '{{1}} puis {{3}}', variables: 3 },
        { name: 'rappel_rdv', language: 'en', texte: 'Votre rendez-vous est confirmé.', variables: 0 },
      ],
    });
    await server.close();
  });

  it('Meta ne répond pas : 503 avec l’attente, jamais une liste vide', async () => {
    const { server } = app({ catalogueLeve: true });
    const res = await server.inject(appel('modeles', { tenantId: T1 }));
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(RELANCE_META_SEC));
    expect(res.json()).toMatchObject({ code: 'meta_indisponible' });
    await server.close();
  });
});

describe('POST /hubspot/workflow/modele : l’envoi', () => {
  it('🔴 le corps donné au cœur : le numéro en E.164, les valeurs dans l’ordre, AUCUN consentement, Service seulement', async () => {
    const { server, envois } = app();
    const res = await server.inject(appel('modele', ENVOI));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issue: 'envoye', sendId: 'envoi-1' });
    expect(envois).toHaveLength(1);
    expect(envois[0]!.corps).toEqual({
      idempotencyKey: 'hubspot-workflow:33612345678:suivi_devis:fr',
      target: { template: { name: 'suivi_devis', language: 'fr' } },
      params: [
        { position: 1, source: { type: 'variable', key: 'v1' } },
        { position: 2, source: { type: 'variable', key: 'v2' } },
      ],
      recipients: [{ phone: '+33612345678', variables: { v1: 'Julien', v2: 'D-1002' } }],
    });
    expect(envois[0]!.options).toEqual({ nom: 'HubSpot · workflow 1234567', sansCampagneVide: true, serviceSeulement: true });
    await server.close();
  });

  it('un numéro étranger rangé sans « + » (le format d’un outil WhatsApp) est lu comme `/v1/sends` le lit', async () => {
    const { server, envois } = app();
    const res = await server.inject(appel('modele', { ...ENVOI, telephone: '447911123456' }));
    expect(res.json()).toMatchObject({ issue: 'envoye' });
    expect(envois[0]!.corps).toMatchObject({ recipients: [{ phone: '+447911123456' }] });
    await server.close();
  });

  it('🔴 un numéro vide ou illisible, une ligne fixe, une valeur refusée : une issue en 200, rien ne part ni n’est compté', async () => {
    for (const [corps, issue] of [
      [{ ...ENVOI, telephone: '' }, 'sans_numero'],
      [{ ...ENVOI, telephone: 'pas un numéro' }, 'sans_numero'],
      [{ ...ENVOI, telephone: '01 42 68 53 00' }, 'fixe'],
      [{ ...ENVOI, telephone: '09 70 12 34 56' }, 'fixe'],
      [{ ...ENVOI, valeurs: ['Julien', '', 'D-1002'] }, 'valeur_invalide'],
      [{ ...ENVOI, valeurs: ['Julien', 'x'.repeat(1025)] }, 'valeur_invalide'],
      [{ ...ENVOI, valeurs: ['Julien', 'x'.repeat(5000)] }, 'valeur_invalide'],
    ] as const) {
      const { server, envois, comptes } = app();
      const res = await server.inject(appel('modele', corps));
      expect(res.statusCode, issue).toBe(200);
      expect(res.json(), issue).toEqual({ issue });
      expect([envois, comptes], issue).toEqual([[], []]);
      await server.close();
    }
  });

  it('🔴 le modèle jugé comme la liste, AVANT la clé : Marketing, absent, carrousel, variable vide en fin de liste ne comptent rien', async () => {
    for (const [corps, issue] of [
      [{ ...ENVOI, modele: 'offre_rentree', valeurs: ['Julien'] }, 'marketing_refuse'],
      [{ ...ENVOI, modele: 'supprime' }, 'modele_refuse'],
      [{ ...ENVOI, modele: 'suivi_devis', langue: 'en' }, 'modele_refuse'],
      [{ ...ENVOI, modele: 'carrousel_suivi', valeurs: [] }, 'modele_refuse'],
      [{ ...ENVOI, modele: 'entete_variable', valeurs: ['Julien'] }, 'modele_refuse'],
      // La propriété liée à « Variable 2 » est vide pour ce contact : le champ de fin est retiré, il manque une valeur.
      [{ ...ENVOI, valeurs: ['Julien', '', '', '', ''] }, 'valeur_invalide'],
      // Une valeur de trop (« Variable 3 » liée sur un modèle à deux variables).
      [{ ...ENVOI, valeurs: ['Julien', 'D-1002', 'en trop'] }, 'valeur_invalide'],
    ] as const) {
      const { server, envois, comptes } = app();
      const res = await server.inject(appel('modele', corps));
      expect([res.statusCode, res.json()], issue).toEqual([200, { issue }]);
      expect([envois, comptes], issue).toEqual([[], []]);
      await server.close();
    }
  });

  it('🔴 Meta ne répond pas (le catalogue, ou la catégorie relue par le cœur) : 503 relancé par HubSpot, jamais un refus définitif', async () => {
    const lecture = app({ catalogueLeve: true });
    const r1 = await lecture.server.inject(appel('modele', ENVOI));
    expect([r1.statusCode, r1.headers['retry-after'], r1.json().code]).toEqual([503, String(RELANCE_META_SEC), 'meta_indisponible']);
    expect([lecture.envois, lecture.comptes]).toEqual([[], []]);
    await lecture.server.close();
    const coeur = app({ reponse: { statut: 422, corps: { code: 'template_category_unknown' } } });
    const r2 = await coeur.server.inject(appel('modele', ENVOI));
    expect([r2.statusCode, r2.json().code]).toEqual([503, 'meta_indisponible']);
    await coeur.server.close();
  });

  it('🔴 le plafond par minute : 429 avec l’attente (HubSpot relance), rien ne part', async () => {
    const { server, envois, comptes } = app({ plafonds: { accepte: false, fenetre: 'minute', attenteMs: 12_300 } });
    const res = await server.inject(appel('modele', ENVOI));
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('13');
    expect(res.json()).toMatchObject({ code: 'rate_limited', retryAfterSec: 13 });
    expect([envois, comptes]).toEqual([[], [T1]]);
    await server.close();
  });

  it('🔴 le plafond du jour : un refus en 200 (`plafond_jour`, visible dans l’historique du workflow), rien ne part', async () => {
    const { server, envois } = app({ plafonds: { accepte: false, fenetre: 'jour', attenteMs: 3_600_000 } });
    const res = await server.inject(appel('modele', ENVOI));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issue: 'plafond_jour' });
    expect(envois).toEqual([]);
    await server.close();
  });

  it('🔴 le même envoi en vol : 429 `en_cours` avec une attente courte (une relance, jamais le 409 des refus définitifs)', async () => {
    const { server } = app({ reponse: { statut: 409, corps: { code: 'idempotency_in_progress' } } });
    const res = await server.inject(appel('modele', ENVOI));
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe(String(RELANCE_EN_COURS_SEC));
    expect(res.json()).toMatchObject({ code: 'en_cours' });
    await server.close();
  });

  it('les refus du cœur deviennent des issues lisibles', async () => {
    const cas: Array<[ResultatEnvoiPublic, string]> = [
      [{ statut: 200, corps: { sendId: '', recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }] } }, 'stop'],
      [{ statut: 200, corps: { sendId: '', recipientCount: 0, skipped: [{ index: 0, reason: 'blocked_contact' }] } }, 'bloque'],
      [{ statut: 200, corps: { sendId: '', recipientCount: 0, skipped: [{ index: 0, reason: 'plan_limit_reached' }] } }, 'limite_contacts'],
      [{ statut: 422, corps: { code: 'template_rejected', categorie: 'marketing' } }, 'marketing_refuse'],
      [{ statut: 422, corps: { code: 'idempotency_key_reused' } }, 'deja_envoye'],
      [{ statut: 404, corps: { code: 'template_not_found' } }, 'modele_refuse'],
      [{ statut: 402, corps: { code: 'plan_limit_reached', limite: 'envoisModelesMois' } }, 'limite_modeles'],
      [{ statut: 409, corps: { code: 'number_unlinked' } }, 'numero_indisponible'],
      [{ statut: 500, corps: { code: 'internal' } }, 'refuse'],
    ];
    for (const [reponse, issue] of cas) {
      const { server } = app({ reponse });
      const res = await server.inject(appel('modele', ENVOI));
      expect([res.statusCode, res.json()], issue).toEqual([200, { issue }]);
      await server.close();
    }
  });
});

describe('les plafonds de l’action : minute et jour de Paris, comptés ensemble', () => {
  // 2026-10-27 à 22 h 30 UTC : 23 h 30 à Paris (heure d'hiver), donc le jour de Paris finit dans 30 minutes.
  const SOIR = Date.UTC(2026, 9, 27, 22, 30);

  it('🔴 la minute et le jour pleins ensemble : le jour l’emporte (relancer dans la minute ne servirait à rien)', async () => {
    const compteur = new CompteurDebitMemoire(() => SOIR);
    const plafonds = plafondsDesWorkflows(compteur, { parMinute: 2, parJour: 2, maintenant: () => SOIR });
    expect(await plafonds(T1)).toEqual({ accepte: true });
    expect(await plafonds(T1)).toEqual({ accepte: true });
    for (let i = 0; i < 4; i++) expect(await plafonds(T1)).toMatchObject({ accepte: false, fenetre: 'jour' });
    // Le jour repart à minuit de Paris, pas à minuit UTC : 30 minutes d'attente.
    expect(await plafonds(T1)).toEqual({ accepte: false, fenetre: 'jour', attenteMs: 30 * 60_000 });
    // Un autre espace a les siens.
    expect(await plafonds(T2)).toEqual({ accepte: true });
  });

  it('la minute pleine : refus `minute` avec l’attente de la fin de sa fenêtre', async () => {
    // Le compteur en mémoire aligne une fenêtre sans origine sur sa création (la base, sur l'époque) : une minute entière.
    const plafonds = plafondsDesWorkflows(new CompteurDebitMemoire(() => SOIR), { parMinute: 1, parJour: 100, maintenant: () => SOIR });
    expect(await plafonds(T1)).toEqual({ accepte: true });
    expect(await plafonds(T1)).toEqual({ accepte: false, fenetre: 'minute', attenteMs: 60_000 });
  });

  it('0 désactive ; une base muette laisse passer', async () => {
    const jamais = { compter: async () => { throw new Error('base muette'); } } as unknown as CompteurDebitMemoire;
    expect(await plafondsDesWorkflows(jamais, { parMinute: 0, parJour: 0 })(T1)).toEqual({ accepte: true });
    expect(await plafondsDesWorkflows(jamais, { parMinute: 60, parJour: 2000 })(T1)).toEqual({ accepte: true });
  });
});

describe('les valeurs et la clé de l’action', () => {
  it('🔴 la clé : le numéro, le modèle, la langue (sa vie de 24 h borne la répétition), jamais le workflow', () => {
    expect(cleDuWorkflow('+33612345678', 'suivi_devis', 'fr')).toBe('hubspot-workflow:33612345678:suivi_devis:fr');
  });

  it('🔴 la vie d’une clé tient au moins 24 h : la garde « pas deux fois en 24 h » et le `trop_tard` à 20 h du connecteur en dépendent', () => {
    expect(DUREE_CLE_IDEMPOTENCE_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('un retour à la ligne ou une tabulation devient une espace, les champs vides de la fin sont retirés', () => {
    expect(valeursDuWorkflow(['12 rue de la Paix\r\n75002 Paris', 'a\tb', '  c        d ', '', ''])).toEqual(['12 rue de la Paix 75002 Paris', 'a b', 'c    d']);
    expect(valeursDuWorkflow(['', '', ''])).toEqual([]);
  });

  it('un vide au milieu ou une valeur trop longue : `null`', () => {
    expect(valeursDuWorkflow(['a', '  ', 'b'])).toBeNull();
    expect(valeursDuWorkflow(['x'.repeat(1025)])).toBeNull();
    expect(valeursDuWorkflow(['x'.repeat(1024)])).toEqual(['x'.repeat(1024)]);
  });
});
