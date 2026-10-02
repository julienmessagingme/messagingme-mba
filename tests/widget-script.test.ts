import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerWidgetPublic, type WidgetPublicRouteDeps } from '../src/http/widget-public';
import { construireScript, SCRIPT_INERTE, TEXTE_INDISPONIBLE, type ConfigScript } from '../src/widgets/script';
import { qrSvg } from '../src/widgets/qr';
import { RateLimiter } from '../src/auth/rate-limit';
import { modulesDeRoutes } from '../src/server';
import type { WidgetRow } from '../src/widgets/store.pg';
import type { PhoneNumberRecord } from '../src/account/types';
import { GardeUsageMemoire } from './aide/usage';

/**
 * Le script public de la bulle WhatsApp (lot 2 du plan `docs/superpowers/plans/2026-10-02-widget-whatsapp.md`).
 *
 * Deux moitiés. La route, montée seule avec des dépendances injectées (aucune base) : ce qu'elle rend pour chaque
 * état, et surtout ce qu'elle NE rend PAS. Puis le script lui-même, EXÉCUTÉ contre un faux DOM : un test qui
 * chercherait `textContent` dans le texte du script prouverait une orthographe ; celui-ci prouve que le libellé
 * hostile arrive dans `textContent`, que la bulle grisée n'a aucun gestionnaire de clic, et que l'ombre est fermée.
 */

const CODE = 'k7m2p3q4r5s6';
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** Une ligne COMPLÈTE, avec des valeurs reconnaissables : c'est ce qui donne un sens au test « aucun secret ». */
function widgetComplet(autre: Partial<WidgetRow> = {}): WidgetRow {
  return {
    id: 'aaaaaaaa-1111-4111-8111-000000000001',
    tenantId: 'bbbbbbbb-2222-4222-8222-000000000002',
    code: CODE,
    nom: 'Nom interne Zorglub jamais publie',
    phrase: 'Bonjour, je viens du site',
    devenir: 'agent',
    agentId: 'cccccccc-3333-4333-8333-000000000003',
    workflowId: null,
    couleur: '#123abc',
    position: 'bas_gauche',
    libelle: 'Une question ?',
    avatarUrl: 'https://exemple.test/avatar.png',
    badge: true,
    actif: true,
    maxParHeure: 987654,
    createdAt: '2026-10-01T10:11:12.000Z',
    updatedAt: '2026-10-01T13:14:15.000Z',
    ...autre,
  };
}

/** Un numéro tel que Meta l'affiche, relié, et en bonne santé. */
const NUMERO_SAIN: PhoneNumberRecord = {
  id: 'eeeeeeee-5555-4555-8555-000000000005',
  displayPhoneNumber: '+44 1887 593342',
  status: 'CONNECTED',
  qualityRating: 'GREEN',
  messagingLimitTier: 'TIER_1K',
  nameStatus: 'APPROVED',
  codeVerificationStatus: 'VERIFIED',
  throughputLevel: 'STANDARD',
  verifiedName: 'Exemple',
  wabaHealthStatus: 'AVAILABLE',
  accountReviewStatus: 'APPROVED',
  businessVerificationStatus: 'verified',
  marketingMessagesLiteApiStatus: null,
  ownerBusinessName: 'Exemple SAS',
  hubspotConnected: false,
  hubspotPausedAt: null,
  delieLe: null,
};

interface Montage {
  app: FastifyInstance;
  parCode: ReturnType<typeof vi.fn>;
  qr: ReturnType<typeof vi.fn>;
}

async function monter(options: {
  widget?: WidgetRow | null;
  parCode?: (code: string) => Promise<WidgetRow | null>;
  numero?: WidgetPublicRouteDeps['numero'];
  qr?: WidgetPublicRouteDeps['qrSvg'];
  budget?: RateLimiter;
} = {}): Promise<Montage> {
  const widget = options.widget === undefined ? widgetComplet() : options.widget;
  const parCode = vi.fn(options.parCode ?? (async () => widget));
  const qr = vi.fn(options.qr ?? qrSvg);
  const app = Fastify({ logger: false });
  registerWidgetPublic(app, {
    widgets: { parCode },
    numero: options.numero ?? (async () => NUMERO_SAIN),
    qrSvg: qr,
    // Désactivé par défaut : seul le cas du budget le règle.
    budgetInconnus: options.budget ?? new RateLimiter(0, 60_000),
  });
  await app.ready();
  return { app, parCode, qr };
}

const charger = (app: FastifyInstance, code = CODE) => app.inject({ method: 'GET', url: `/widget/${code}.js` });

/** Les données écrites dans le script, relues comme un navigateur les lirait (le JSON échappé reste du JSON). */
function donnees(script: string): Record<string, unknown> {
  const ligne = /^var D = (.*);$/m.exec(script);
  if (!ligne) throw new Error('aucune ligne de données dans le script');
  return JSON.parse(ligne[1]!) as Record<string, unknown>;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('🔴 aucun secret dans le script', () => {
  const sensibles = (w: WidgetRow): string[] => [
    w.id, w.tenantId, w.agentId!, String(w.maxParHeure), w.nom, w.createdAt, w.updatedAt,
    'tenantId', 'tenant_id', 'agentId', 'agent_id', 'workflowId', 'workflow_id', 'maxParHeure', 'max_par_heure',
    'devenir',
  ];

  it('un widget servi ne publie ni espace, ni agent, ni scénario, ni plafond, ni nom interne', async () => {
    const w = widgetComplet();
    const { app } = await monter({ widget: w });
    const res = await charger(app);
    expect(donnees(res.body).etat).toBe('servi');
    for (const s of sensibles(w)) expect(res.body, `« ${s} » apparaît dans le script public`).not.toContain(s);
    await app.close();
  });

  it('pareil pour un scénario désigné, et pour la bulle grisée', async () => {
    const w = widgetComplet({ devenir: 'scenario', agentId: null, workflowId: 'dddddddd-4444-4444-8444-000000000004' });
    for (const numero of [async () => NUMERO_SAIN, async () => null]) {
      const { app } = await monter({ widget: w, numero });
      const res = await charger(app);
      for (const s of [w.workflowId!, w.tenantId, w.nom, String(w.maxParHeure)]) expect(res.body).not.toContain(s);
      await app.close();
    }
  });

  it('la bulle grisée ne publie ni lien, ni phrase, ni libellé', async () => {
    const w = widgetComplet({ phrase: 'Phrase secrete du widget', libelle: 'Libelle visible' });
    const { app } = await monter({ widget: w, numero: async () => null });
    const res = await charger(app);
    expect(donnees(res.body)).toEqual({ etat: 'grise', position: 'bas_gauche' });
    for (const s of ['wa.me', 'Phrase', 'Libelle visible']) expect(res.body).not.toContain(s);
    await app.close();
  });
});

describe('🔴 des valeurs hostiles ressortent sérialisées et inertes', () => {
  const libelle = '<img src=x onerror=alert(1)>';
  const phrase = `Bonjour "</script><img src=x onerror=alert(1)>${LS}suite${PS}fin`;
  const avatarUrl = 'https://x.test/a.png" onerror="alert(1)</script>)';

  it('aucun chevron, aucune fin de script, aucun séparateur brut, et le script se compile', async () => {
    const { app } = await monter({ widget: widgetComplet({ libelle, phrase, avatarUrl }) });
    const res = await charger(app);
    const script = res.body;
    expect(script).not.toContain('<img');
    expect(script).not.toContain('</script');
    expect(script).not.toContain(LS);
    expect(script).not.toContain(PS);
    // Le JSON relu rend les valeurs EXACTES : elles sont des données, pas du code.
    const d = donnees(script);
    expect(d.libelle).toBe(libelle);
    expect(d.avatar).toBe(avatarUrl);
    // Compilé sans être exécuté : un séparateur ou un guillemet mal échappé casserait la syntaxe ici.
    expect(() => new Function(script)).not.toThrow();
    await app.close();
  });

  it('le script généré n’écrit jamais de HTML', () => {
    const servi = construireScript({
      etat: 'servi', lien: 'https://wa.me/1?text=a', svgQr: '<svg></svg>', couleur: '#25d366', position: 'bas_droite',
      libelle, avatarUrl, badge: true,
    });
    const grise = construireScript({ etat: 'grise', position: 'haut_gauche' });
    for (const script of [servi, grise]) {
      for (const interdit of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
        expect(script).not.toContain(interdit);
      }
    }
  });

  it('exécutés, le libellé arrive dans textContent et l’avatar dans img.src, tels quels', () => {
    const page = executer(construireScript({
      etat: 'servi', lien: 'https://wa.me/1?text=a', svgQr: null, couleur: '#123abc', position: 'bas_droite',
      libelle, avatarUrl, badge: false,
    }));
    const noeuds = page.noeuds();
    expect(noeuds.find((n) => n.tag === 'span' && n.textContent === libelle)).toBeDefined();
    expect(noeuds.find((n) => n.className === 'avatar')?.src).toBe(avatarUrl);
    // Aucun nœud n'a reçu le libellé comme balise : il n'existe que comme texte.
    expect(noeuds.some((n) => n.tag === 'img' && n.src === 'x')).toBe(false);
  });
});

describe('🔴 rien à afficher : 200 et le script inerte, jamais une 5xx', () => {
  it('code inconnu', async () => {
    const { app } = await monter({ widget: null });
    const res = await charger(app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SCRIPT_INERTE);
    expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    await app.close();
  });

  it('code vide et code mal formé : sans même lire la base', async () => {
    const { app, parCode } = await monter();
    for (const code of ['', 'abc', 'k7m2p3q4r5s6x', 'k7m2p3q4r5s!']) {
      const res = await charger(app, code);
      expect(res.statusCode, `code « ${code} »`).toBe(200);
      expect(res.body).toBe(SCRIPT_INERTE);
    }
    expect(parCode).not.toHaveBeenCalled();
    await app.close();
  });

  it('widget éteint : la même réponse qu’un code inconnu', async () => {
    const { app } = await monter({ widget: widgetComplet({ actif: false }) });
    const res = await charger(app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SCRIPT_INERTE);
    await app.close();
  });

  it('la lecture du widget lève : script inerte, sans cache, et l’erreur est journalisée', async () => {
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = await monter({ parCode: async () => { throw new Error('pool epuise'); } });
    const res = await charger(app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SCRIPT_INERTE);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(journal.mock.calls.map((c) => String(c[0])).join('\n')).toContain('widget_lecture_echouee');
    await app.close();
  });

  it('la lecture du numéro lève : script inerte, sans cache, journalisé', async () => {
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = await monter({ numero: async () => { throw new Error('connexion perdue'); } });
    const res = await charger(app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SCRIPT_INERTE);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(journal.mock.calls.map((c) => String(c[0])).join('\n')).toContain('widget_numero_illisible');
    await app.close();
  });

  it('le QR lève : la bulle est servie quand même, sans QR', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = await monter({ qr: async () => { throw new Error('trop long'); } });
    const res = await charger(app);
    const d = donnees(res.body);
    expect(d.etat).toBe('servi');
    expect(d.qr).toBeNull();
    await app.close();
  });
});

describe('🔴 grisée seulement sans numéro ou sur un numéro délié', () => {
  const etatPour = async (numero: PhoneNumberRecord | null): Promise<unknown> => {
    const { app } = await monter({ numero: async () => numero });
    const res = await charger(app);
    await app.close();
    expect(res.statusCode).toBe(200);
    return donnees(res.body).etat;
  };

  it('numéro sain : servie', async () => {
    expect(await etatPour(NUMERO_SAIN)).toBe('servi');
  });

  it('numéro délié : grisée', async () => {
    expect(await etatPour({ ...NUMERO_SAIN, delieLe: '2026-10-01T08:00:00.000Z' })).toBe('grise');
  });

  it('aucun numéro : grisée', async () => {
    expect(await etatPour(null)).toBe('grise');
  });

  it('un numéro sans aucun chiffre ne fabrique pas de lien : grisée', async () => {
    expect(await etatPour({ ...NUMERO_SAIN, displayPhoneNumber: null })).toBe('grise');
  });

  it('🔴 un compte BLOCKED n’est PAS grisé : il reçoit et répond dans la fenêtre de 24 h (mesuré le 2026-10-02)', async () => {
    expect(await etatPour({ ...NUMERO_SAIN, wabaHealthStatus: 'BLOCKED' })).toBe('servi');
    expect(await etatPour({
      ...NUMERO_SAIN, wabaHealthStatus: 'BLOCKED', accountReviewStatus: 'REJECTED', businessVerificationStatus: 'rejected',
    })).toBe('servi');
  });
});

describe('le lien wa.me et le QR', () => {
  it('fabriqué depuis le numéro tel que Meta l’affiche, la phrase encodée entière', async () => {
    const phrase = 'Bonjour, je viens du site été (promo) !';
    const { app, qr } = await monter({ widget: widgetComplet({ phrase }) });
    const res = await charger(app);
    const d = donnees(res.body);
    // Écrit à la main, pas recalculé par la fonction testée : espaces, accents et ponctuation finale encodés.
    const attendu = 'https://wa.me/441887593342?text=Bonjour%2C%20je%20viens%20du%20site%20%C3%A9t%C3%A9%20%28promo%29%20%21';
    expect(d.lien).toBe(attendu);
    // Le QR porte le MÊME lien, et c'est un SVG.
    expect(qr).toHaveBeenCalledWith(attendu);
    expect(String(d.qr).startsWith('<svg')).toBe(true);
    await app.close();
  });

  it('en-têtes d’une bulle servie', async () => {
    const { app } = await monter();
    const res = await charger(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    await app.close();
  });
});

describe('🔴 le chemin exact /widget/<code>.js', () => {
  it('est routé, et le paramètre est le code SANS .js', async () => {
    const chemins: string[] = [];
    const app = Fastify({ logger: false });
    app.addHook('onRoute', (r) => { chemins.push(r.url); });
    const parCode = vi.fn(async () => widgetComplet());
    registerWidgetPublic(app, {
      widgets: { parCode }, numero: async () => NUMERO_SAIN, qrSvg, budgetInconnus: new RateLimiter(0, 60_000),
    });
    await app.ready();
    expect(chemins).toContain('/widget/:code.js');
    expect((await charger(app)).statusCode).toBe(200);
    expect(parCode).toHaveBeenLastCalledWith(CODE);
    // Une majuscule dans l'adresse retrouve le même code ; sans le suffixe, la route n'existe pas.
    await charger(app, CODE.toUpperCase());
    expect(parCode).toHaveBeenLastCalledWith(CODE);
    expect((await app.inject({ method: 'GET', url: `/widget/${CODE}` })).statusCode).toBe(404);
    await app.close();
  });

  it('le registre le monte en classe code-url', () => {
    const toutPresent = new Proxy({}, { get: () => ({}) }) as never;
    const entree = modulesDeRoutes(toutPresent, new GardeUsageMemoire()).find((m) => m.nom === 'widgetPublic');
    expect(entree?.acces).toBe('code-url');
  });
});

describe('le frein des codes jamais vus', () => {
  it('un code inconnu au-delà du budget rend l’inerte sans lire la base ; un code déjà résolu passe', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connu = 'a1b2c3d4e5f6';
    const { app, parCode } = await monter({
      budget: new RateLimiter(1, 60_000),
      parCode: async (code) => (code === connu ? widgetComplet({ code: connu }) : null),
    });
    // Le budget (1) est pris par le premier code jamais vu, qui se résout.
    expect(donnees((await charger(app, connu)).body).etat).toBe('servi');
    // Un second code jamais vu : refusé avant la base, sans cache.
    const refuse = await charger(app, 'zzzzzzzzzzzz');
    expect(refuse.statusCode).toBe(200);
    expect(refuse.body).toBe(SCRIPT_INERTE);
    expect(refuse.headers['cache-control']).toBe('no-store');
    expect(parCode).toHaveBeenCalledTimes(1);
    // Le code résolu n'est plus soumis au budget.
    expect(donnees((await charger(app, connu)).body).etat).toBe('servi');
    expect(parCode).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('un widget ÉTEINT garde son laissez-passer : sa balise ne consomme pas le budget des autres', async () => {
    const { app, parCode } = await monter({ budget: new RateLimiter(1, 60_000), widget: widgetComplet({ actif: false }) });
    await charger(app);
    await charger(app);
    await charger(app);
    expect(parCode).toHaveBeenCalledTimes(3);
    await app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Le script EXÉCUTÉ, contre un faux DOM qui n'a que ce que le script utilise
// ---------------------------------------------------------------------------------------------------------

class Noeud {
  [cle: string]: unknown;
  readonly enfants: Noeud[] = [];
  readonly attributs: Record<string, string> = {};
  readonly ecouteurs: Record<string, Array<(e: unknown) => void>> = {};
  readonly style: Record<string, string> & { setProperty(cle: string, valeur: string): void };
  ombre: { mode: string; racine: Noeud } | null = null;
  constructor(readonly tag: string) {
    const style: Record<string, string> = {};
    this.style = Object.assign(style, { setProperty: (cle: string, valeur: string) => { style[cle] = valeur; } });
  }
  appendChild(n: Noeud): Noeud { this.enfants.push(n); return n; }
  setAttribute(cle: string, valeur: string): void { this.attributs[cle] = String(valeur); }
  addEventListener(type: string, f: (e: unknown) => void): void { (this.ecouteurs[type] ??= []).push(f); }
  attachShadow(options: { mode: string }): Noeud {
    const racine = new Noeud('#ombre');
    this.ombre = { mode: options.mode, racine };
    return racine;
  }
}

interface Page {
  body: Noeud;
  /** Tous les nœuds montés, ombre comprise. */
  noeuds(): Noeud[];
  /** Les écouteurs posés sur `document` (DOMContentLoaded). */
  ecouteursDocument: Record<string, Array<() => void>>;
}

function executer(script: string, options: { tactile?: boolean; etatDocument?: string } = {}): Page {
  const body = new Noeud('body');
  const ecouteursDocument: Record<string, Array<() => void>> = {};
  const document = {
    readyState: options.etatDocument ?? 'complete',
    body,
    createElement: (tag: string) => new Noeud(tag),
    createElementNS: (_ns: string, tag: string) => new Noeud(tag),
    addEventListener: (type: string, f: () => void) => { (ecouteursDocument[type] ??= []).push(f); },
  };
  const window = { matchMedia: () => ({ matches: options.tactile ?? false }) };
  // `document` et `window` sont des PARAMÈTRES : le script s'exécute sans toucher l'environnement du test.
  new Function('document', 'window', script)(document, window);
  const tous = (n: Noeud): Noeud[] => [n, ...n.enfants.flatMap(tous), ...(n.ombre ? tous(n.ombre.racine) : [])];
  return { body, noeuds: () => tous(body).slice(1), ecouteursDocument };
}

const SERVI: ConfigScript = {
  etat: 'servi', lien: 'https://wa.me/441887593342?text=Bonjour', svgQr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  couleur: '#123abc', position: 'bas_gauche', libelle: 'Une question ?', avatarUrl: null, badge: true,
};

describe('le script exécuté', () => {
  it('servi sur ordinateur : ombre FERMÉE, coin, couleur, et le clic ouvre le panneau au lieu de suivre le lien', () => {
    const page = executer(construireScript(SERVI));
    const hote = page.body.enfants[0]!;
    expect(hote.ombre?.mode).toBe('closed');
    expect(hote.style.position).toBe('fixed');
    expect(hote.style.bottom).toBe('20px');
    expect(hote.style.left).toBe('20px');
    const noeuds = page.noeuds();
    const ligne = noeuds.find((n) => n.className === 'ligne')!;
    expect(ligne.tag).toBe('a');
    expect(ligne.href).toBe(SERVI.lien);
    expect(ligne.target).toBe('_blank');
    expect(noeuds.find((n) => n.className === 'bulle')?.style.backgroundColor).toBe('#123abc');
    const panneau = noeuds.find((n) => n.className === 'panneau')!;
    expect(panneau.hidden).toBe(true);
    const qr = noeuds.find((n) => n.className === 'qr')!;
    expect(qr.tag).toBe('img');
    expect(String(qr.src)).toBe(`data:image/svg+xml,${encodeURIComponent(String(SERVI.etat === 'servi' && SERVI.svgQr))}`);
    const web = noeuds.find((n) => n.className === 'web')!;
    expect([web.href, web.target]).toEqual([SERVI.lien, '_blank']);
    expect(noeuds.find((n) => n.className === 'badge')?.textContent).toBe('Propulsé par Engage Me');

    const empecher = vi.fn();
    for (const f of ligne.ecouteurs.click ?? []) f({ preventDefault: empecher });
    expect(empecher).toHaveBeenCalled();
    expect(panneau.hidden).toBe(false);
    expect(ligne.attributs['aria-expanded']).toBe('true');
  });

  it('servi sur un téléphone : le clic suit le lien wa.me, aucun panneau', () => {
    const page = executer(construireScript(SERVI), { tactile: true });
    const noeuds = page.noeuds();
    const ligne = noeuds.find((n) => n.className === 'ligne')!;
    const empecher = vi.fn();
    for (const f of ligne.ecouteurs.click ?? []) f({ preventDefault: empecher });
    expect(empecher).not.toHaveBeenCalled();
    expect(noeuds.find((n) => n.className === 'panneau')?.hidden).toBe(true);
  });

  it('sans badge demandé, aucun badge', () => {
    const page = executer(construireScript({ ...SERVI, badge: false }));
    expect(page.noeuds().some((n) => n.className === 'badge')).toBe(false);
  });

  it('🔴 grisée : visible, sans lien ni gestionnaire de clic, avec title et aria-label, aucun texte visible', () => {
    const page = executer(construireScript({ etat: 'grise', position: 'haut_droite' }));
    const hote = page.body.enfants[0]!;
    expect(hote.style.top).toBe('20px');
    expect(hote.style.right).toBe('20px');
    const noeuds = page.noeuds();
    const bulle = noeuds.find((n) => n.className === 'bulle grise')!;
    expect(bulle.tag).toBe('span');
    expect(bulle.title).toBe(TEXTE_INDISPONIBLE);
    expect(bulle.attributs['aria-label']).toBe(TEXTE_INDISPONIBLE);
    expect(noeuds.some((n) => Object.keys(n.ecouteurs).length > 0)).toBe(false);
    expect(noeuds.some((n) => n.tag === 'a' || n.href !== undefined)).toBe(false);
    // Le seul contenu textuel est la feuille de style.
    expect(noeuds.filter((n) => n.textContent !== undefined).map((n) => n.tag)).toEqual(['style']);
  });

  it('attend DOMContentLoaded quand la page se charge encore', () => {
    const page = executer(construireScript(SERVI), { etatDocument: 'loading' });
    expect(page.body.enfants).toHaveLength(0);
    for (const f of page.ecouteursDocument.DOMContentLoaded ?? []) f();
    expect(page.body.enfants).toHaveLength(1);
  });
});
