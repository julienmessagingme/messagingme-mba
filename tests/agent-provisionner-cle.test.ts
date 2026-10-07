import { describe, it, expect } from 'vitest';
import { assurerCleGateway, creerAssureurDeCle, remonterPlafondApresRecharge, revoquerCleGateway, CreditInsuffisantPourCle, CleIllisible, EspaceVerrouillePourCle, REPIT_APRES_ECHEC_MS, type DepsProvisionCle } from '../src/agent/provisionner-cle';
import type { CleGatewayEspace, LectureCleGateway } from '../src/agent/cles-gateway.pg';
import type { HttpResponse, HttpTransportPatch } from '../src/meta/http';
import type { HttpTransportSuppression } from '../src/agent/llm/cles-gateway';

/**
 * LE PROVISIONNEMENT d'une clé de modèle par espace (2026-09-09, demande de Julien).
 *
 * 🔴 CE QUI SE JOUE ICI EST DE L'ARGENT, et les défauts de ce module sont tous SILENCIEUX. Une clé créée
 * deux fois facture deux fois ; un plafond aligné sur le solde coupe un client qui a payé ; un
 * provisionnement qui n'écrit pas laisse chez Vercel une clé que personne ne peut plus ni lire ni révoquer.
 * Aucun de ces trois-là ne lève d'exception nulle part.
 */

const TAUX = 0.92; // euros par dollar, le défaut du dépôt
const MICRO = 1_000_000;

class FauxTransport implements HttpTransportPatch, HttpTransportSuppression {
  readonly appels: Array<{ methode: string; url: string; body: unknown }> = [];
  constructor(private readonly reponses: HttpResponse[]) {}
  post(url: string, body: unknown): Promise<HttpResponse> { return this.note('POST', url, body); }
  patch(url: string, body: unknown): Promise<HttpResponse> { return this.note('PATCH', url, body); }
  delete(url: string): Promise<{ status: number }> { this.appels.push({ methode: 'DELETE', url, body: null }); return Promise.resolve({ status: 204 }); }
  private note(m: string, url: string, body: unknown): Promise<HttpResponse> {
    this.appels.push({ methode: m, url, body });
    const r = this.reponses.shift();
    if (!r) throw new Error('appel non prevu');
    return Promise.resolve(r);
  }
}

/**
 * Faux dépôt de clés, en mémoire, qui note ce qu'on lui écrit. `'illisible'` : une ligne existe et ne se déchiffre
 * pas (`lire` rend alors `null`, comme le vrai dépôt, et seul `lireEtat` le distingue d'une absence).
 *
 * `ajusterPlafond` rend la CIBLE que la base calculerait (le cumul crédité depuis l'ouverture de la clé) : ici un
 * nombre que le test pose (`cible`). Le calcul SQL et le verrou de la ligne, eux, sont tenus par
 * `tests/integration/cle-plafond.integration.test.ts`, en CI. Les appels sont sérialisés comme le verrou le fait.
 */
function fauxCles(initial?: CleGatewayEspace | 'illisible') {
  let illisible = initial === 'illisible';
  let etat = initial === 'illisible' ? null : initial ?? null;
  /** L'identifiant d'une ligne illisible : en clair dans sa colonne, comme en base. */
  let idIllisible: string | null = initial === 'illisible' ? 'key_illisible' : null;
  const ecritures: Array<{ cleId: string; plafondMicroEur: number }> = [];
  const plafondsNotes: number[] = [];
  const oublis: boolean[] = [];
  let file: Promise<unknown> = Promise.resolve();
  const f = {
    ecritures,
    plafondsNotes,
    oublis,
    /** Ce que la base calculerait comme cible. Par défaut : le plafond déjà noté, donc rien à remonter. */
    cible: null as number | null,
    lire: async () => etat,
    lireEtat: async (): Promise<LectureCleGateway> => {
      if (illisible) return { etat: 'illisible' };
      return etat ? { etat: 'lue', cle: etat } : { etat: 'absente' };
    },
    idDe: async () => (illisible ? idIllisible : etat?.cleId ?? null),
    reparer: () => { illisible = false; },
    enregistrer: async (_t: string, o: { cleId: string; cle: string; plafondMicroEur: number }) => {
      ecritures.push({ cleId: o.cleId, plafondMicroEur: o.plafondMicroEur });
      etat = { cleId: o.cleId, cle: o.cle, plafondMicroEur: o.plafondMicroEur };
      return etat;
    },
    ajusterPlafond: (_t: string, poser: (cle: { cleId: string; plafondMicroEur: number }, cible: number) => Promise<number | null>): Promise<boolean> => {
      const tour = file.then(async () => {
        if (!etat) return false;
        const pose = await poser({ cleId: etat.cleId, plafondMicroEur: etat.plafondMicroEur }, f.cible ?? etat.plafondMicroEur);
        if (pose === null) return false;
        plafondsNotes.push(pose);
        etat.plafondMicroEur = pose;
        return true;
      });
      file = tour.catch(() => undefined);
      return tour;
    },
    oublier: async (_t: string) => {
      const y = etat !== null || idIllisible !== null;
      etat = null;
      idIllisible = null;
      illisible = false;
      oublis.push(true);
      return y;
    },
  };
  return f;
}

function deps(o: { cles: ReturnType<typeof fauxCles>; solde: number; transport: HttpTransportPatch & HttpTransportSuppression; journal?: string[]; verrouille?: boolean }): DepsProvisionCle {
  return {
    cles: o.cles,
    espaceVerrouille: async () => o.verrouille ?? false,
    credits: { solde: async () => o.solde },
    nomEspace: async () => 'Demo',
    transport: o.transport,
    jetonCompte: 'jeton',
    teamId: 'team_x',
    cleGatewayMaison: 'vck_maison',
    tauxEurParDollar: TAUX,
    journal: (msg) => { o.journal?.push(msg); },
  };
}

/** Les travaux que l'arrêt attend : ceux-ci ne font que noter ce qu'on leur confie. */
function travauxNotes() {
  const suivis: Array<Promise<unknown>> = [];
  return { suivis, suivre: <T>(p: Promise<T>): Promise<T> => { suivis.push(p); return p; } };
}

// La forme REELLE de Vercel (mesuree le 2026-09-09) : `apiKeyString` a la racine, l'identifiant sous `apiKey`.
const OK = { status: 200, json: { apiKeyString: 'vck_neuf', apiKey: { id: 'key_neuf' } } };

describe('assurerCleGateway', () => {
  it('🔴 une clé qui EXISTE n’en fait pas créer une seconde', async () => {
    // La garde la plus chère du module : sans elle, chaque création d'agent d'un même espace ouvrirait une
    // clé de plus chez Vercel. Elles factureraient toutes, et une seule serait connue de la base.
    const cles = fauxCles({ cleId: 'key_deja', cle: 'vck_deja', plafondMicroEur: 10 * MICRO });
    const t = new FauxTransport([]);
    const r = await assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1');

    expect(r.cleId).toBe('key_deja');
    expect(t.appels).toHaveLength(0);
    expect(cles.ecritures).toHaveLength(0);
  });

  it('🔴 une clé ILLISIBLE en base n’en fait PAS ouvrir une autre : refus, et Vercel n’est pas appelé', async () => {
    // Sans cette garde, l'absence et l'illisible se confondaient : on créait une clé chez Vercel, l'enregistrement
    // tombait sur la ligne existante (qu'on ne sait pas lire), on supprimait la neuve, et on recommençait.
    const cles = fauxCles('illisible');
    const t = new FauxTransport([OK]);
    await expect(assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1')).rejects.toBeInstanceOf(CleIllisible);
    expect(t.appels).toHaveLength(0);
    expect(cles.ecritures).toHaveLength(0);
  });

  it('🔴 un espace VERROUILLÉ n’ouvre aucune clé, quel que soit son crédit : Vercel n’est pas appelé', async () => {
    // RC8 : le verrou est le premier geste de la suppression d'un espace. Sans cette garde, une création d'agent en vol
    // rouvrait une clé derrière la révocation, et la purge en perdait l'identifiant (une clé qui facture à vie).
    const cles = fauxCles();
    const t = new FauxTransport([OK]);
    await expect(assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t, verrouille: true }), 't1'))
      .rejects.toBeInstanceOf(EspaceVerrouillePourCle);
    expect(t.appels).toHaveLength(0);
    expect(cles.ecritures).toHaveLength(0);
  });

  it('🔴 sans crédit suffisant : REFUS, et Vercel n’est même pas appelé', async () => {
    // « Pas de crédit, pas de clé, donc pas d'agent » est la conséquence assumée du refus choisi par Julien.
    // Appeler Vercel avant de le constater créerait une clé pour un agent qu'on va refuser de créer.
    const cles = fauxCles();
    const t = new FauxTransport([]);
    // 0,50 € : sous le minimum de 1 $ de Vercel, donc aucune clé n'est possible.
    await expect(assurerCleGateway(deps({ cles, solde: 500_000, transport: t }), 't1'))
      .rejects.toBeInstanceOf(CreditInsuffisantPourCle);
    expect(t.appels).toHaveLength(0);
  });

  it('🔴 le plafond envoyé COUVRE le crédit acheté, il ne le rogne pas', async () => {
    // 10 € au taux de 0,92 valent 10,87 $, donc 11. Arrondir vers le bas donnait 10, atteint à 9,20 €
    // consommés : le client était coupé avant d'avoir dépensé ce qu'il avait payé, et notre propre garde
    // (`solde <= 0`) ne servait plus jamais.
    const cles = fauxCles();
    const t = new FauxTransport([OK]);
    await assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1');

    expect(t.appels[0]!.body).toMatchObject({ aiGatewayQuota: { limitAmount: 11, refreshPeriod: 'none' } });
  });

  it('enregistre le plafond en MICRO-EUROS, pas en dollars', async () => {
    // Les deux unités se ressemblent dans une signature et pas dans une base : la colonne sert à savoir quoi
    // ajouter au prochain rechargement, elle doit donc parler la même langue que le solde.
    const cles = fauxCles();
    await assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: new FauxTransport([OK]) }), 't1');
    expect(cles.ecritures).toEqual([{ cleId: 'key_neuf', plafondMicroEur: 10 * MICRO }]);
  });

  it('🔴 si l’enregistrement échoue, la clé est SUPPRIMÉE chez Vercel', async () => {
    // Sinon elle existe chez eux et nulle part chez nous : elle facture, personne ne peut s'en servir, et le
    // client qui réessaie en fabrique une deuxième. Une base indisponible une minute laissait autant de clés
    // orphelines que de tentatives.
    const cles = fauxCles();
    cles.enregistrer = async () => { throw new Error('base indisponible'); };
    const t = new FauxTransport([OK]);
    await expect(assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1')).rejects.toThrow('base indisponible');

    const suppression = t.appels.find((a) => a.methode === 'DELETE');
    expect(suppression).toBeDefined();
    expect(suppression!.url).toContain('key_neuf');
  });

  it('🔴 l’erreur D’ORIGINE est relevée, pas celle de la suppression', async () => {
    // On est déjà dans un chemin qui échoue : masquer la cause par une seconde erreur ferait chercher au
    // mauvais endroit. La suppression ne lève jamais et son résultat n'est pas testé.
    const cles = fauxCles();
    cles.enregistrer = async () => { throw new Error('base indisponible'); };
    const t = new FauxTransport([OK]);
    t.delete = () => Promise.reject(new Error('vercel aussi est casse'));
    await expect(assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1')).rejects.toThrow('base indisponible');
  });

  it('🔴 le PERDANT d’une course supprime la clé qu’il vient de créer', async () => {
    // `enregistrer` rend ce qui est en base : sur conflit, c'est la clé du GAGNANT. La nôtre ne sera jamais
    // lue par personne et facturerait quand même. Aucune exception ne se lève sur ce chemin, c'est
    // précisément pourquoi il se voyait moins que l'échec d'écriture.
    const cles = fauxCles();
    cles.enregistrer = async () => ({ cleId: 'key_du_gagnant', cle: 'vck_gagnant', plafondMicroEur: 10 * MICRO });
    const t = new FauxTransport([OK]);
    const r = await assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1');

    expect(r.cleId).toBe('key_du_gagnant');
    const suppression = t.appels.find((a) => a.methode === 'DELETE');
    expect(suppression, 'la cle perdante doit etre supprimee').toBeDefined();
    expect(suppression!.url).toContain('key_neuf');
  });

  it('🔴 le GAGNANT ne supprime rien : la preuve inverse', async () => {
    // Sans ce cas, une suppression inconditionnelle passerait le test ci-dessus tout en détruisant la clé
    // qu'on vient d'enregistrer, ce qui casserait tous les agents de l'espace au tour suivant.
    const cles = fauxCles();
    const t = new FauxTransport([OK]);
    await assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1');
    expect(t.appels.find((a) => a.methode === 'DELETE')).toBeUndefined();
  });

  it('🔴 Vercel est appelé AVANT l’enregistrement, jamais après', async () => {
    // Vercel ne rend le secret QU'UNE FOIS. Enregistrer d'abord (avec quoi ?) est impossible ; appeler puis
    // faire autre chose avant d'enregistrer est ce qui perdrait la clé. L'enregistrement est donc le dernier
    // geste, et ce test fige l'ordre.
    const ordre: string[] = [];
    const cles = fauxCles();
    const enregistrer = cles.enregistrer;
    cles.enregistrer = async (t, o) => { ordre.push('enregistre'); return enregistrer(t, o); };
    const t = new FauxTransport([OK]);
    const d = deps({ cles, solde: 10 * MICRO, transport: t });
    const post = t.post.bind(t);
    t.post = (u, b) => { ordre.push('vercel'); return post(u, b); };

    await assurerCleGateway(d, 't1');
    expect(ordre).toEqual(['vercel', 'enregistre']);
  });

  it('🔴 un crédit arrivé PENDANT l’ouverture n’est pas perdu : le plafond est recalculé une fois la clé enregistrée', async () => {
    // Relecture du 2026-09-29. La clé naît au solde lu AVANT l'appel à Vercel (10 €). Un achat de 50 € écrit pendant
    // l'appel tente de remonter un plafond qui n'existe pas encore (aucune ligne), et ne fait rien : sans le recalcul
    // qui suit l'enregistrement, la clé resterait à 10 € et Vercel couperait un client qui en a payé 60.
    const cles = fauxCles();
    const t = new FauxTransport([OK, { status: 200, json: {} }]);
    const post = t.post.bind(t);
    t.post = async (u, b) => {
      const r = await post(u, b);
      cles.cible = 60 * MICRO; // l'achat arrive pendant que Vercel ouvre la clé
      return r;
    };
    await assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1');
    expect(cles.ecritures).toEqual([{ cleId: 'key_neuf', plafondMicroEur: 10 * MICRO }]);
    // 60 € au taux de 0,92 valent 65,22 $ : 66.
    expect(t.appels.find((a) => a.methode === 'PATCH')!.body).toEqual({ limitAmount: 66, refreshPeriod: 'none' });
    expect(cles.plafondsNotes).toEqual([60 * MICRO]);
  });

  it('sans crédit pendant l’ouverture, le recalcul n’appelle PAS Vercel une seconde fois', async () => {
    const cles = fauxCles();
    const t = new FauxTransport([OK]);
    await assurerCleGateway(deps({ cles, solde: 10 * MICRO, transport: t }), 't1');
    expect(t.appels.map((a) => a.methode)).toEqual(['POST']);
  });
});

describe('remonterPlafondApresRecharge', () => {
  it('🔴 le plafond monte jusqu’à la CIBLE recalculée (le cumul crédité), il ne recopie pas le solde', async () => {
    // Le solde DESCEND à chaque tour d'agent ; le compteur de Vercel, lui, MONTE. Recopier le solde (2 €) couperait
    // un client bien avant qu'il ait consommé ce qu'il a payé. La cible, calculée par la base, vaut ici 30 €.
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    cles.cible = 30 * MICRO;
    const t = new FauxTransport([{ status: 200, json: {} }]);
    expect(await remonterPlafondApresRecharge(deps({ cles, solde: 2 * MICRO, transport: t }), 't1')).toBe(true);

    // 30 €, soit 32,60 $ au taux de 0,92, donc 33 (arrondi au supérieur).
    expect(t.appels[0]!.body).toEqual({ limitAmount: 33, refreshPeriod: 'none' });
    expect(cles.plafondsNotes).toEqual([30 * MICRO]);
  });

  it('🔴 DEUX remontées simultanées convergent vers la cible : aucune ne perd l’achat de l’autre', async () => {
    // Relecture du 2026-09-29 : l'ancienne remontée ajoutait le montant de SON achat au plafond qu'elle avait lu.
    // Deux achats (50 et 100 €) remontés ensemble lisaient tous deux 10 €, et la seconde écriture (110 €) écrasait la
    // première (60 €) : 160 € payés, 110 € de plafond. La cible ne dépend plus du montant de l'achat.
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    cles.cible = 160 * MICRO;
    const t = new FauxTransport([{ status: 200, json: {} }, { status: 200, json: {} }]);
    const d = deps({ cles, solde: 160 * MICRO, transport: t });
    await Promise.all([remonterPlafondApresRecharge(d, 't1'), remonterPlafondApresRecharge(d, 't1')]);
    expect(cles.plafondsNotes).toEqual([160 * MICRO]);
    // La seconde voit le plafond noté par la première : Vercel n'est appelé qu'une fois.
    expect(t.appels).toHaveLength(1);
  });

  it('🔴 une cible qui ne dépasse pas le plafond posé n’appelle pas Vercel', async () => {
    // Le solde bouge à chaque tour d'agent. Suivre le solde ferait un appel réseau par tour, pour réécrire
    // le même nombre : on compare donc au dernier plafond POSÉ, et on ne descend jamais.
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    cles.cible = 8 * MICRO;
    const t = new FauxTransport([]);
    expect(await remonterPlafondApresRecharge(deps({ cles, solde: 1, transport: t }), 't1')).toBe(false);
    expect(t.appels).toHaveLength(0);
    expect(cles.plafondsNotes).toEqual([]);
  });

  it('un espace SANS clé ne déclenche rien', async () => {
    const cles = fauxCles();
    cles.cible = 50 * MICRO;
    const t = new FauxTransport([]);
    expect(await remonterPlafondApresRecharge(deps({ cles, solde: 50 * MICRO, transport: t }), 't1')).toBe(false);
    expect(t.appels).toHaveLength(0);
  });

  it('🔴 un échec chez Vercel NE FAIT PAS échouer le crédit, et se journalise', async () => {
    // Un client vient de payer. Lui rendre une erreur parce qu'un tiers est indisponible serait le pire
    // moment : son crédit est déjà crédité chez nous, son plafond rattrapera à la remontée suivante.
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    cles.cible = 30 * MICRO;
    const t = new FauxTransport([{ status: 500, json: {} }]);
    const vus: string[] = [];
    expect(await remonterPlafondApresRecharge(deps({ cles, solde: 0, transport: t, journal: vus }), 't1')).toBe(false);
    // Et le plafond n'est PAS noté : sinon on croirait l'avoir posé, et on ne réessaierait jamais.
    expect(cles.plafondsNotes).toEqual([]);
    expect(vus).toHaveLength(1);
  });
});

/**
 * RÉVOQUER la clé d'un espace (2026-09-09, question de Julien : « s'il supprime cet agent IA, la clé est-elle
 * bien désactivée ? »).
 *
 * 🔴 CE QUE CETTE FONCTION EMPÊCHE. `agent_gateway_keys.tenant_id` porte un `on delete cascade` : le jour où
 * un ESPACE sera supprimé, notre ligne partira avec lui et la clé survivra chez Vercel avec son identifiant
 * PERDU. Elle resterait facturable, et personne ne pourrait plus la révoquer.
 */
describe('revoquerCleGateway', () => {
  it('🔴 supprime chez VERCEL d’abord, chez nous ensuite', async () => {
    // L'ordre est l'inverse de l'intuition, et c'est le contrôle : commencer par notre ligne perdrait
    // l'identifiant si Vercel échouait, ce qui est exactement la panne qu'on veut éviter.
    const ordre: string[] = [];
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    const oublier = cles.oublier;
    cles.oublier = async (t: string) => { ordre.push('oublie'); return oublier(t); };
    const t = new FauxTransport([]);
    const del = t.delete.bind(t);
    t.delete = (u) => { ordre.push('vercel'); return del(u); };

    expect(await revoquerCleGateway(deps({ cles, solde: 0, transport: t }), 't1')).toBe(true);
    expect(ordre).toEqual(['vercel', 'oublie']);
  });

  it('🔴 Vercel refuse : la ligne est GARDÉE, seul moyen de réessayer', async () => {
    // Oublier la ligne ici perdrait l'identifiant pour toujours, et la clé continuerait de facturer sans que
    // personne puisse la retrouver.
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    const t = new FauxTransport([]);
    t.delete = () => Promise.resolve({ status: 500 });
    await expect(revoquerCleGateway(deps({ cles, solde: 0, transport: t }), 't1')).rejects.toThrow();
    expect(cles.oublis).toHaveLength(0);
  });

  it('un espace SANS clé rend `false` sans rien appeler', async () => {
    const cles = fauxCles();
    const t = new FauxTransport([]);
    expect(await revoquerCleGateway(deps({ cles, solde: 0, transport: t }), 't1')).toBe(false);
    expect(t.appels).toHaveLength(0);
  });

  it('🔴 une clé ILLISIBLE se révoque quand même : son identifiant est en clair', async () => {
    // RC8 : la révocation lisait la clé DÉCHIFFRÉE, et une clé illisible passait pour « pas de clé ». La suppression de
    // l'espace aurait alors purgé la ligne, et la clé aurait facturé à vie chez Vercel, identifiant perdu.
    const cles = fauxCles('illisible');
    const t = new FauxTransport([]);
    expect(await revoquerCleGateway(deps({ cles, solde: 0, transport: t }), 't1')).toBe(true);
    expect(t.appels).toEqual([expect.objectContaining({ methode: 'DELETE', url: expect.stringContaining('key_illisible') })]);
    expect(cles.oublis).toHaveLength(1);
  });
});

/**
 * LA CLÉ AU PREMIER USAGE (2026-09-28) : la traduction l'ouvre aussi, plus seulement la création d'un agent. Un
 * espace sans agent ne pouvait pas traduire, quel que soit son crédit.
 *
 * 🔴 Ce chemin est appelé à chaque rafraîchissement du fil (4 s) par chaque opérateur qui le lit : l'ouverture ne se
 * fait pas attendre (elle part en arrière-plan, une par espace), et un échec chez Vercel ne doit pas se changer en
 * appels de création en rafale.
 */
describe('creerAssureurDeCle', () => {
  function assureur(o: { cles: ReturnType<typeof fauxCles>; solde: number; transport: FauxTransport; provision?: false; now?: () => number; verrouille?: boolean }) {
    const journal: string[] = [];
    const travaux = travauxNotes();
    const assurer = creerAssureurDeCle({
      cles: o.cles,
      provision: o.provision === false ? null : deps({ cles: o.cles, solde: o.solde, transport: o.transport, verrouille: o.verrouille ?? false }),
      journal: (msg) => { journal.push(msg); },
      travaux,
      ...(o.now ? { now: o.now } : {}),
    });
    return { assurer, journal, travaux };
  }

  it('🔴 l’ouverture en arrière-plan est confiée aux travaux que l’arrêt du processus attend', async () => {
    // Relecture du 2026-09-29 : personne n'attendait cette promesse. L'arrêt d'une copie de l'API fermait le pool
    // pendant qu'elle attendait Vercel, et la clé créée chez Vercel ne s'enregistrait jamais chez nous.
    const cles = fauxCles();
    const t = new FauxTransport([OK]);
    const { assurer, travaux } = assureur({ cles, solde: 5 * MICRO, transport: t });
    expect(await assurer('t1')).toBe('en_preparation');
    expect(travaux.suivis).toHaveLength(1);
    await Promise.all(travaux.suivis);
    expect(cles.ecritures).toHaveLength(1);
    // Une clé déjà là n'ouvre rien, donc ne confie rien.
    expect(await assurer('t1')).toBe('prete');
    expect(travaux.suivis).toHaveLength(1);
  });

  it('une clé qui existe est rendue sans appeler Vercel', async () => {
    const cles = fauxCles({ cleId: 'key_deja', cle: 'vck_deja', plafondMicroEur: 10 * MICRO });
    const t = new FauxTransport([]);
    expect(await assureur({ cles, solde: 10 * MICRO, transport: t }).assurer('t1')).toBe('prete');
    expect(t.appels).toHaveLength(0);
  });

  it('🔴 un espace SANS clé mais AVEC du crédit en obtient une, plafonnée à son crédit', async () => {
    const cles = fauxCles();
    const t = new FauxTransport([OK]);
    const { assurer } = assureur({ cles, solde: 5 * MICRO, transport: t });
    // L'ouverture part en arrière-plan : la demande ne l'attend pas.
    expect(await assurer('t1')).toBe('en_preparation');
    await assurer.enVol('t1');
    expect(await assurer('t1')).toBe('prete');
    expect(cles.ecritures).toEqual([{ cleId: 'key_neuf', plafondMicroEur: 5 * MICRO }]);
    // 5 € offerts au taux de 0,92 valent 5,43 $ : plafond de 6.
    expect(t.appels[0]!.body).toMatchObject({ aiGatewayQuota: { limitAmount: 6 } });
  });

  it('🔴 la demande N’ATTEND PAS Vercel, et une seule ouverture part par espace', async () => {
    // Le défaut relevé par la relecture du lot 1 : l'ouverture était sur le chemin du GET du fil, qui attendait
    // jusqu'à 30 s qu'un Vercel lent réponde. Ici Vercel ne répond JAMAIS pendant le test.
    const cles = fauxCles();
    const t = new FauxTransport([]);
    let relacher: (r: { status: number; json: unknown }) => void = () => {};
    t.post = (url, body) => {
      t.appels.push({ methode: 'POST', url, body });
      return new Promise((r) => { relacher = r; });
    };
    const { assurer } = assureur({ cles, solde: 5 * MICRO, transport: t });
    expect(await assurer('t1')).toBe('en_preparation');
    // Les rafraîchissements suivants, et les autres opérateurs, voient l'ouverture en cours sans en lancer d'autre.
    expect(await Promise.all([assurer('t1'), assurer('t1')])).toEqual(['en_preparation', 'en_preparation']);
    expect(t.appels.filter((a) => a.methode === 'POST')).toHaveLength(1);
    relacher(OK);
    await assurer.enVol('t1');
    expect(await assurer('t1')).toBe('prete');
    expect(assurer.enVol('t1')).toBeUndefined();
  });

  it('provisionnement éteint : seule une clé existante sert, et Vercel n’est jamais appelé', async () => {
    const t = new FauxTransport([]);
    expect(await assureur({ cles: fauxCles(), solde: 10 * MICRO, transport: t, provision: false }).assurer('t1')).toBe('indisponible');
    expect(t.appels).toHaveLength(0);
  });

  it('🔴 un espace VERROUILLÉ : `indisponible`, aucune ouverture en vol, Vercel jamais appelé (la traduction ne rouvre rien)', async () => {
    // Le défaut connu de `todo.md` : la révocation d'une clé était défaite par la traduction suivante. Le verrou,
    // premier geste de la suppression d'un espace (RC8), l'empêche désormais.
    const t = new FauxTransport([OK]);
    const { assurer, travaux } = assureur({ cles: fauxCles(), solde: 10 * MICRO, transport: t, verrouille: true });
    expect(await assurer('t1')).toBe('indisponible');
    expect(travaux.suivis).toHaveLength(0);
    expect(t.appels).toHaveLength(0);
  });

  it('🔴 un crédit trop bas pour une clé rend `credit_insuffisant` TOUT DE SUITE, et ne bloque pas l’essai suivant', async () => {
    // Lu avant de partir en arrière-plan : l'écran doit pouvoir dire « recharger » dès ce rafraîchissement. Pas de
    // répit ici : Vercel n'a pas été appelé, et un espace qui vient de recharger doit traduire tout de suite.
    const cles = fauxCles();
    let solde = 500_000;
    const t = new FauxTransport([OK]);
    const a = creerAssureurDeCle({
      cles,
      provision: { ...deps({ cles, solde: 0, transport: t }), credits: { solde: async () => solde } },
      journal: () => {},
      travaux: travauxNotes(),
    });
    expect(await a('t1')).toBe('credit_insuffisant');
    expect(t.appels).toHaveLength(0);
    solde = 10 * MICRO;
    expect(await a('t1')).toBe('en_preparation');
    await a.enVol('t1');
    expect(await a('t1')).toBe('prete');
  });

  it('🔴 un échec chez Vercel se journalise, et ouvre un RÉPIT avant le prochain appel', async () => {
    let maintenant = 1_000_000;
    const cles = fauxCles();
    const t = new FauxTransport([{ status: 500, json: {} }, OK]);
    const { assurer, journal } = assureur({ cles, solde: 10 * MICRO, transport: t, now: () => maintenant });

    expect(await assurer('t1')).toBe('en_preparation');
    await assurer.enVol('t1');
    expect(journal).toHaveLength(1);
    // Juste après : Vercel n'est pas rappelé, le fil qui se rafraîchit n'y change rien.
    maintenant += REPIT_APRES_ECHEC_MS - 1;
    expect(await assurer('t1')).toBe('indisponible');
    expect(t.appels).toHaveLength(1);
    // Le répit passé, on réessaie, et cette fois ça marche.
    maintenant += 1;
    expect(await assurer('t1')).toBe('en_preparation');
    await assurer.enVol('t1');
    expect(await assurer('t1')).toBe('prete');
    expect(t.appels).toHaveLength(2);
  });

  it('le répit est PAR ESPACE : la panne d’un espace ne bloque pas les autres', async () => {
    const maintenant = 1_000_000;
    const cles = fauxCles();
    const t = new FauxTransport([{ status: 500, json: {} }, OK]);
    const { assurer } = assureur({ cles, solde: 10 * MICRO, transport: t, now: () => maintenant });
    expect(await assurer('t1')).toBe('en_preparation');
    await assurer.enVol('t1');
    expect(await assurer('t1')).toBe('indisponible');
    expect(await assurer('t2')).toBe('en_preparation');
    await assurer.enVol('t2');
    expect(await assurer('t2')).toBe('prete');
  });

  it('🔴 une clé ILLISIBLE n’ouvre rien, et se journalise UNE fois par répit', async () => {
    // Le défaut relevé par la relecture du lot 1 : lue comme une absence, elle faisait créer puis supprimer une clé
    // chez Vercel une fois par minute, pour chaque espace touché.
    let maintenant = 1_000_000;
    const cles = fauxCles('illisible');
    const t = new FauxTransport([OK, OK]);
    const { assurer, journal } = assureur({ cles, solde: 10 * MICRO, transport: t, now: () => maintenant });
    expect(await assurer('t1')).toBe('indisponible');
    expect(await assurer('t1')).toBe('indisponible');
    expect(t.appels).toHaveLength(0);
    expect(journal).toHaveLength(1);
    maintenant += REPIT_APRES_ECHEC_MS;
    expect(await assurer('t1')).toBe('indisponible');
    expect(journal).toHaveLength(2);
    expect(t.appels).toHaveLength(0);
  });
});
