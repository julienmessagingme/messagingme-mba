import { describe, it, expect } from 'vitest';
import { OUTILS, outilsPour, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { DROIT_RELAIS, DROITS_CLE_APPLICATION, VARIABLE_CLE } from '../web/lib/partage/droits-api';
import { PRIX_PRO_HT_CENTIMES } from '../src/offres/offres';
import type { PlafondCles } from '../src/auth/api-key-store.pg';
import type { PeriodicitePro } from '../src/stripe/pro';

/**
 * CE QU'UNE FREE FAIT DEPUIS CLAUDE CODE PLUTÔT QUE DANS LA CONSOLE (spec offres v2, livraison 4) : créer la clé de son
 * application, et payer le Pro. Les deux appellent la MÊME fonction que la console (`creerCleApi`, `ouvrirPro`, testées à
 * part) ; ce fichier tient ce que l'outil ajoute : la personne requise, le plafond des opérations lourdes, la clé montrée
 * une fois et dite comme telle, et le retour du paiement sur la page publique.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PERSONNE = { userId: 'u1' };
const outil = (nom: string) => OUTILS.find((o) => o.nom === nom)!;

function deps(o: { limiteCles?: number | null; creee?: boolean; couteuxAccepte?: boolean; pro?: 'ok' | 'entreprise' | 'portail' } = {}) {
  const cap = {
    creations: [] as Array<{ name: string; scopes: string[]; plafond: PlafondCles }>,
    audit: [] as Array<{ action: string; userId: string | null; detail: unknown }>,
    pro: [] as Array<{ periodicite: PeriodicitePro; payeur: string; retour: string }>,
  };
  const d = {
    cles: {
      cles: {
        creerSousPlafond: async (_t: string, name: string, scopes: string[], plafond: PlafondCles) => {
          cap.creations.push({ name, scopes, plafond });
          return o.creee === false ? null : { id: 'k1', key: 'mba_cle_montree_une_fois' };
        },
      },
      limiteCles: async () => (o.limiteCles === undefined ? 2 : o.limiteCles),
      audit: async (_t: string, acteur: { userId: string | null }, action: string, _c: unknown, detail: unknown) => {
        cap.audit.push({ action, userId: acteur.userId, detail });
      },
    },
    offre: {
      pro: {
        ouvrir: async (_t: string, periodicite: PeriodicitePro, payeur: string, retour: string) => {
          cap.pro.push({ periodicite, payeur, retour });
          return o.pro === 'entreprise'
            ? { ok: false as const, statut: 409 as const, erreur: 'Votre espace est en offre Entreprise : le Pro ne lui ajouterait rien.', details: { code: 'deja_entreprise' } }
            : o.pro === 'portail'
              ? { ok: true as const, valeur: { url: 'https://billing.stripe.com/p/session/portail', portail: true } }
              : { ok: true as const, valeur: { url: 'https://checkout.stripe.com/c/pay/cs_pro', portail: false } };
        },
      },
    },
    couteux: { consommer: async () => ({ accepte: o.couteuxAccepte ?? true, attenteMs: 3000 }) },
  } as unknown as DepsMcp;
  return { d, cap };
}

describe('les outils MCP d’une Free : la clé de son application et le Pro', () => {
  it('🔴 les deux exigent une personne (un consentement OAuth, donné par un administrateur) : une clé d’API ne les voit pas', () => {
    for (const nom of ['create_api_key', 'subscribe_pro']) {
      expect(outil(nom).exigePersonne, nom).toBe(true);
      expect(outil(nom).scope, nom).toBe('mcp:write');
      // Ouverts à toutes les offres : c'est la Free qui en a besoin.
      expect(outil(nom).fonction, nom).toBeNull();
    }
    const parCle = outilsPour({ scopes: ['mcp:read', 'mcp:write'], personne: null }).map((o) => o.nom);
    expect(parCle).not.toContain('create_api_key');
    expect(parCle).not.toContain('subscribe_pro');
  });

  it('🔴 create_api_key : la clé rendue une fois, avec la variable où la ranger, et la description qui dit qu’elle passe par la conversation', async () => {
    const { d, cap } = deps();
    const r = await outil('create_api_key').executer(d, T, { name: 'Mon application' }, PERSONNE) as Record<string, unknown>;
    expect(r).toMatchObject({ id: 'k1', key: 'mba_cle_montree_une_fois', name: 'Mon application', variable: VARIABLE_CLE });
    // Sans droits demandés : ceux de la clé d'une application (les mêmes que la page « Démarrer »).
    expect(cap.creations).toEqual([{ name: 'Mon application', scopes: [...DROITS_CLE_APPLICATION], plafond: { max: 2, horsDroit: DROIT_RELAIS } }]);
    expect(outil('create_api_key').description).toMatch(/shown ONCE/);
    expect(outil('create_api_key').description).toMatch(/passes through this conversation/);
    // L'audit signe la personne et l'origine, jamais la clé.
    expect(cap.audit).toEqual([{ action: 'cle_api.creee', userId: 'u1', detail: { scopes: [...DROITS_CLE_APPLICATION], via: 'mcp' } }]);
    expect(JSON.stringify(cap.audit)).not.toContain('mba_cle_montree_une_fois');
  });

  it('🔴 create_api_key : jamais le droit du relais, ni un droit inconnu ; la 3e clé d’une Free est refusée avec la phrase de l’offre', async () => {
    const { d, cap } = deps();
    await expect(outil('create_api_key').executer(d, T, { name: 'x', scopes: [DROIT_RELAIS] }, PERSONNE)).rejects.toBeInstanceOf(RefusOutil);
    await expect(outil('create_api_key').executer(d, T, { name: 'x', scopes: ['god:mode'] }, PERSONNE)).rejects.toBeInstanceOf(RefusOutil);
    // Une clé à droits LIMITÉS (spec) : ni le MCP, ni les webhooks, ni la suppression de contacts. Une consigne glissée
    // dans un message lu par Claude ne fabrique pas une clé qui survivrait à la révocation de Claude ; la console les crée.
    for (const large of ['mcp:read', 'mcp:write', 'webhooks:write', 'contacts:admin']) {
      await expect(outil('create_api_key').executer(d, T, { name: 'x', scopes: ['sends:create', large] }, PERSONNE), large)
        .rejects.toBeInstanceOf(RefusOutil);
    }
    expect(cap.creations).toEqual([]);
    const annonces = (outil('create_api_key').entree.properties as Record<string, { items?: { enum?: string[] } }>).scopes!.items!.enum!;
    expect([...annonces].sort()).toEqual(['contacts:read', 'contacts:write', 'conversations:read', 'sends:create', 'templates:write']);
    await outil('create_api_key').executer(d, T, { name: 'Lecture', scopes: ['contacts:read'] }, PERSONNE);
    expect(cap.creations.map((c) => c.scopes)).toEqual([['contacts:read']]);
    await expect(outil('create_api_key').executer(deps({ creee: false }).d, T, { name: 'x' }, PERSONNE))
      .rejects.toThrow(/Limite de votre offre atteinte : 2 clés d’API actives.*Passez en Pro/);
  });

  it('🔴 subscribe_pro : l’adresse de Stripe, le montant hors taxe de la grille, et le retour sur la page publique', async () => {
    const { d, cap } = deps();
    const r = await outil('subscribe_pro').executer(d, T, { periodicite: 'an' }, PERSONNE);
    expect(r).toMatchObject({
      url: 'https://checkout.stripe.com/c/pay/cs_pro', periodicite: 'an', portail: false, montant_ht_eur: PRIX_PRO_HT_CENTIMES.an / 100,
    });
    expect(cap.pro).toEqual([{ periodicite: 'an', payeur: 'u1', retour: 'claude' }]);
    await expect(outil('subscribe_pro').executer(d, T, { periodicite: 'semaine' }, PERSONNE)).rejects.toBeInstanceOf(RefusOutil);
    await expect(outil('subscribe_pro').executer(deps({ pro: 'entreprise' }).d, T, { periodicite: 'mois' }, PERSONNE))
      .rejects.toThrow(/offre Entreprise/);
    // Déjà en Pro : le portail de Stripe, et aucun montant que Claude annoncerait « à payer ».
    const portail = await outil('subscribe_pro').executer(deps({ pro: 'portail' }).d, T, { periodicite: 'mois' }, PERSONNE) as Record<string, unknown>;
    expect(portail).toMatchObject({ url: 'https://billing.stripe.com/p/session/portail', portail: true });
    expect(portail).not.toHaveProperty('montant_ht_eur');
    expect(portail).not.toHaveProperty('taxe');
  });

  it('🔴 les deux comptent dans les opérations lourdes : refusées, elles n’appellent ni la création ni Stripe', async () => {
    const { d, cap } = deps({ couteuxAccepte: false });
    await expect(outil('create_api_key').executer(d, T, { name: 'x' }, PERSONNE)).rejects.toBeInstanceOf(RefusOutil);
    await expect(outil('subscribe_pro').executer(d, T, { periodicite: 'mois' }, PERSONNE)).rejects.toBeInstanceOf(RefusOutil);
    expect([cap.creations, cap.pro]).toEqual([[], []]);
  });
});
