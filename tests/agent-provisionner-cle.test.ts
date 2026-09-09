import { describe, it, expect } from 'vitest';
import { assurerCleGateway, remonterPlafondApresRecharge, CreditInsuffisantPourCle, type DepsProvisionCle } from '../src/agent/provisionner-cle';
import type { CleGatewayEspace } from '../src/agent/cles-gateway.pg';
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

/** Faux dépôt de clés, en mémoire, qui note ce qu'on lui écrit. */
function fauxCles(initial?: CleGatewayEspace) {
  let etat = initial ?? null;
  const ecritures: Array<{ cleId: string; plafondMicroEur: number }> = [];
  const plafondsNotes: number[] = [];
  return {
    ecritures,
    plafondsNotes,
    lire: async () => etat,
    enregistrer: async (_t: string, o: { cleId: string; cle: string; plafondMicroEur: number }) => {
      ecritures.push({ cleId: o.cleId, plafondMicroEur: o.plafondMicroEur });
      etat = { cleId: o.cleId, cle: o.cle, plafondMicroEur: o.plafondMicroEur };
      return etat;
    },
    noterPlafond: async (_t: string, p: number) => { plafondsNotes.push(p); if (etat) etat.plafondMicroEur = p; },
  };
}

function deps(o: { cles: ReturnType<typeof fauxCles>; solde: number; transport: HttpTransportPatch & HttpTransportSuppression }): DepsProvisionCle {
  return {
    cles: o.cles,
    solde: async () => o.solde,
    nomEspace: async () => 'Demo',
    transport: o.transport,
    jetonCompte: 'jeton',
    teamId: 'team_x',
    cleGatewayMaison: 'vck_maison',
    tauxEurParDollar: TAUX,
  };
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
});

describe('remonterPlafondApresRecharge', () => {
  it('🔴 le plafond MONTE du montant acheté, il ne recopie pas le solde', async () => {
    // Le solde DESCEND à chaque tour d'agent ; le compteur de Vercel, lui, MONTE. Recopier le solde
    // couperait un client bien avant qu'il ait consommé ce qu'il a payé.
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    const t = new FauxTransport([{ status: 200, json: {} }]);
    expect(await remonterPlafondApresRecharge(deps({ cles, solde: 2 * MICRO, transport: t }), 't1', 20 * MICRO)).toBe(true);

    // 10 achetés + 20 rechargés = 30 €, soit 32,60 $ au taux de 0,92, donc 33 (arrondi au supérieur).
    expect(t.appels[0]!.body).toEqual({ limitAmount: 33, refreshPeriod: 'none' });
    expect(cles.plafondsNotes).toEqual([30 * MICRO]);
  });

  it('🔴 un rechargement NUL n’appelle pas Vercel', async () => {
    // Le solde bouge à chaque tour d'agent. Suivre le solde ferait un appel réseau par tour, pour réécrire
    // le même nombre : on compare donc au dernier plafond POSÉ.
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    const t = new FauxTransport([]);
    expect(await remonterPlafondApresRecharge(deps({ cles, solde: 1, transport: t }), 't1', 0)).toBe(false);
    expect(t.appels).toHaveLength(0);
  });

  it('un espace SANS clé ne déclenche rien', async () => {
    const cles = fauxCles();
    const t = new FauxTransport([]);
    expect(await remonterPlafondApresRecharge(deps({ cles, solde: 50 * MICRO, transport: t }), 't1', 50 * MICRO)).toBe(false);
    expect(t.appels).toHaveLength(0);
  });

  it('🔴 un échec chez Vercel NE FAIT PAS échouer le rechargement', async () => {
    // Un client vient de payer. Lui rendre une erreur parce qu'un tiers est indisponible serait le pire
    // moment : son crédit est déjà crédité chez nous, son plafond rattrapera au prochain mouvement.
    const cles = fauxCles({ cleId: 'key_a', cle: 'vck_a', plafondMicroEur: 10 * MICRO });
    const t = new FauxTransport([{ status: 500, json: {} }]);
    const vus: string[] = [];
    expect(await remonterPlafondApresRecharge(deps({ cles, solde: 0, transport: t }), 't1', 20 * MICRO, (m) => vus.push(m)))
      .toBe(false);
    // Et le plafond n'est PAS noté : sinon on croirait l'avoir posé, et on ne réessaierait jamais.
    expect(cles.plafondsNotes).toEqual([]);
    expect(vus).toHaveLength(1);
  });
});
