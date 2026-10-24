import { describe, it, expect } from 'vitest';
import { relancerPaniers, type DepsRelance } from '../src/shopify/relance';
import type { PanierDu } from '../src/shopify/store.pg';
import type { RapportEnvoi, ResultatEnvoiPublic } from '../src/api/envoi-public';
import type { Emission } from '../src/emails-produit/emission';
import type { Filiere } from '../src/application/comptes';
import type { DemandePremierMessage, ResultatPremier } from '../src/application/premier-message';

/**
 * LA RELANCE DES PANIERS ABANDONNÉS (plan 2026-10-21, lot 2), un passage du balayage. La réclamation (une écriture
 * atomique en base) est prouvée par le test d'intégration ; ici, ce qu'un panier réclamé devient.
 */

const panier = (over: Partial<PanierDu> = {}): PanierDu => ({
  // Un modèle, filière API : la relance d'avant le texte simple.
  tenantId: 't1', jeton: 'jeton-1', telephone: '+33633921577', nom: 'Julien', lien: 'https://b.myshopify.com/1/checkouts/ac/x/recover?key=k',
  domaine: 'b.myshopify.com', modele: 'relance_panier', texte: null, langue: 'fr', variables: ['first_name', 'checkout_url'], ...over,
});
const rapport = (over: Partial<RapportEnvoi> = {}): RapportEnvoi => ({
  sendId: 's1', opening: 'whatsapp_template', recipientCount: 1, created: 1, matched: 0, skipped: [], skippedTotal: 0, ...over,
});

/** Un numéro relié par QR code : la filière, les espaces à relance en texte due, leur reste du mois, la réponse de la porte. */
interface Application {
  filiere?: (tenantId: string) => Filiere | null;
  enTexte?: string[];
  reste?: Record<string, number | null>;
  premier?: (demande: DemandePremierMessage) => ResultatPremier;
}

function monter(
  paniers: PanierDu[], reponse: (corps: unknown) => Promise<ResultatEnvoiPublic> = async () => ({ statut: 201, corps: rapport() }),
  fermes: readonly string[] = [], app: Application = {},
) {
  const journal = {
    limites: [] as number[], issues: [] as Array<[string, string]>, envois: [] as Array<{ corps: unknown; options: unknown }>,
    emails: [] as Emission[], exclus: [] as string[][], liberes: [] as string[], premiers: [] as DemandePremierMessage[],
  };
  const deps: DepsRelance = {
    store: {
      // Comme la vraie réclamation : un espace exclu n'est pas examiné.
      reclamerPaniersDus: async (limite, exclus) => {
        journal.limites.push(limite);
        journal.exclus.push([...exclus]);
        return paniers.filter((p) => !exclus.includes(p.tenantId));
      },
      noterIssuePanier: async (_t, jeton, issue) => { journal.issues.push([jeton, issue]); },
      panierOuvert: async (_t, jeton) => !fermes.includes(jeton),
      espacesAPaniersDusEnTexte: async () => app.enTexte ?? [],
      libererPanier: async (_t, jeton) => { journal.liberes.push(jeton); },
    },
    // La filière API par défaut : les tests d'avant le texte simple (plan 2026-10-23) restent ceux de l'API.
    filiere: async (t) => (app.filiere ? app.filiere(t) : 'api'),
    ecrirePremier: async (demande) => {
      journal.premiers.push(demande);
      return app.premier ? app.premier(demande) : { ok: true, id: 'p1', prevuLe: new Date('2026-10-22T10:01:00Z'), dejaEnFile: false };
    },
    quota: { etatDuMois: async (t) => { const r = app.reste?.[t]; return r === undefined || r === null ? null : { max: 1000, reste: r }; } },
    envoyer: async (_t, corps, compter, options) => {
      journal.envois.push({ corps, options });
      expect(await compter(1)).toBe(true);
      return reponse(corps);
    },
    emails: { emettre: async (e) => { journal.emails.push(e); return {}; } },
    pageOffre: 'https://console.test/offre',
    maintenant: () => Date.parse('2026-10-22T10:00:00Z'),
  };
  return { deps, journal };
}

describe('la relance d’un panier réclamé', () => {
  it('🔴 part consentante (le marchand l’a affirmé), avec le lien de reprise et le prénom, sous sa clé métier', async () => {
    const { deps, journal } = monter([panier()]);
    const bilan = await relancerPaniers(deps);
    expect(bilan).toEqual({ reclames: 1, issues: { envoye: 1 } });
    expect(journal.envois[0]!.corps).toMatchObject({
      idempotencyKey: 'shopify:b.myshopify.com:checkouts/abandoned:jeton-1',
      target: { template: { name: 'relance_panier', language: 'fr' } },
      recipients: [{
        phone: '+33633921577', consent: 'opted_in', consentSource: 'shopify:b.myshopify.com',
        variables: { first_name: 'Julien', checkout_url: 'https://b.myshopify.com/1/checkouts/ac/x/recover?key=k' },
      }],
    });
    expect(journal.envois[0]!.options).toEqual({ nom: 'Shopify · panier abandonné', sansCampagneVide: true });
    expect(journal.issues).toEqual([['jeton-1', 'envoye']]);
  });

  it('🔴 un prénom absent (facultatif chez Shopify) : la relance part avec son mot de secours, dans la langue du modèle', async () => {
    const fr = monter([panier({ nom: null })]);
    await relancerPaniers(fr.deps);
    expect(fr.journal.issues).toEqual([['jeton-1', 'envoye']]);
    expect(fr.journal.envois[0]!.corps).toMatchObject({ recipients: [{ variables: { first_name: 'à vous' } }] });
    const en = monter([panier({ nom: null, langue: 'en_US' })]);
    await relancerPaniers(en.deps);
    expect(en.journal.envois[0]!.corps).toMatchObject({ recipients: [{ variables: { first_name: 'there' } }] });
  });

  it('une autre donnée absente (le lien du panier) alors que le modèle la demande : rien ne part, l’issue le dit', async () => {
    const { deps, journal } = monter([panier({ lien: '' })]);
    await relancerPaniers(deps);
    expect(journal.envois).toEqual([]);
    expect(journal.issues).toEqual([['jeton-1', 'donnee_manquante']]);
  });

  it('🔴 une panne en route : la relance est perdue mais notée, jamais renvoyée (une seule relance)', async () => {
    const { deps, journal } = monter([panier(), panier({ jeton: 'jeton-2' })], async (corps) => {
      if (JSON.stringify(corps).includes('jeton-1')) throw new Error('panne');
      return { statut: 201, corps: rapport() };
    });
    const bilan = await relancerPaniers(deps);
    expect(bilan.issues).toEqual({ erreur: 1, envoye: 1 });
    expect(journal.issues).toEqual([['jeton-1', 'erreur'], ['jeton-2', 'envoye']]);
  });

  it('un écart de l’envoi public devient l’issue (STOP, limite de contacts) ; une clé tenue ailleurs n’écrit rien', async () => {
    const ecarte = (reason: RapportEnvoi['skipped'][number]['reason']): ResultatEnvoiPublic =>
      ({ statut: 200, corps: rapport({ sendId: '', recipientCount: 0, skipped: [{ index: 0, reason }] }) });
    const stop = monter([panier()], async () => ecarte('opted_out'));
    await relancerPaniers(stop.deps);
    expect(stop.journal.issues).toEqual([['jeton-1', 'desabonne']]);
    const limite = monter([panier()], async () => ecarte('plan_limit_reached'));
    await relancerPaniers(limite.deps);
    expect(limite.journal.issues).toEqual([['jeton-1', 'limite_contacts']]);
    // La limite prévient les admins, une fois par mois civil (l'occasion), comme un message de commande.
    expect(limite.journal.emails).toMatchObject([{ cle: 'shopify_limite_contacts', a: 'admins', occasion: '2026-10', valeurs: { boutique: 'b.myshopify.com', lien_offre: 'https://console.test/offre' } }]);
    expect(stop.journal.emails).toEqual([]);
    const tenue = monter([panier()], async () => ({ statut: 409, corps: { code: 'idempotency_in_progress' } }));
    expect((await relancerPaniers(tenue.deps)).issues).toEqual({ en_cours: 1 });
    expect(tenue.journal.issues).toEqual([]);
  });

  it('🔴 un panier fermé depuis sa réclamation (une commande est arrivée entre-temps) ne part pas', async () => {
    const { deps, journal } = monter([panier(), panier({ jeton: 'jeton-2' })], undefined, ['jeton-1']);
    expect((await relancerPaniers(deps)).issues).toEqual({ ferme: 1, envoye: 1 });
    expect(journal.envois).toHaveLength(1);
    expect(journal.issues).toEqual([['jeton-1', 'ferme'], ['jeton-2', 'envoye']]);
  });

  it('le passage est borné, et rien de réclamé ne fait rien', async () => {
    const { deps, journal } = monter([]);
    expect(await relancerPaniers(deps, 7)).toEqual({ reclames: 0, issues: {} });
    expect(journal.limites).toEqual([7]);
    // Sans relance en texte due, aucun espace n'est exclu.
    expect(journal.exclus).toEqual([[]]);
  });
});

/**
 * LA RELANCE SUR UN NUMÉRO RELIÉ PAR QR CODE (plan 2026-10-23, tâche 5) : un texte, par la porte « écrire en premier »,
 * comptée dans les messages du mois. 🔴 Une limite atteinte ne consomme aucune relance : l'espace épuisé n'est pas
 * réclamé, et un panier refusé pendant le passage redevient dû.
 */
describe('la relance sur un numéro relié par QR code', () => {
  const QR = (t: string): Filiere | null => (t === 't-api' ? 'api' : 'application');
  const texte = (over: Partial<PanierDu> = {}) => panier({ modele: null, texte: 'Bonjour {{first_name}}, votre panier vous attend : {{checkout_url}}', ...over });

  it('🔴 enfile son texte, données remplies, la consigne STOP en dernière ligne, sous la clé et le jeton du panier', async () => {
    const { deps, journal } = monter([texte()], undefined, [], { filiere: QR });
    expect(await relancerPaniers(deps)).toEqual({ reclames: 1, issues: { en_file: 1 } });
    expect(journal.envois).toEqual([]);
    expect(journal.premiers).toEqual([{
      tenantId: 't1', cle: 'shopify:b.myshopify.com:checkouts/abandoned:jeton-1', telephone: '33633921577',
      texte: 'Bonjour Julien, votre panier vous attend : https://b.myshopify.com/1/checkouts/ac/x/recover?key=k\n\nRépondez STOP pour ne plus recevoir ces messages',
      origine: 'shopify_panier', reference: 'jeton-1', consentement: { mode: 'marchand', source: 'shopify:b.myshopify.com' },
    }]);
    expect(journal.premiers[0]!.texte.split('\n').at(-1)).toBe('Répondez STOP pour ne plus recevoir ces messages');
    expect(journal.issues).toEqual([['jeton-1', 'en_file']]);
    // En anglais, le pied et le prénom de secours suivent la langue.
    const en = monter([texte({ nom: null, langue: 'en_US', texte: 'Hello {{first_name}}: {{checkout_url}}' })], undefined, [], { filiere: QR });
    await relancerPaniers(en.deps);
    expect(en.journal.premiers[0]!.texte).toBe('Hello there: https://b.myshopify.com/1/checkouts/ac/x/recover?key=k\n\nReply STOP to stop these messages');
  });

  it('🔴 un croisement rend filiere_differente, sans rien envoyer, et le panier garde son issue', async () => {
    const texteSurApi = monter([texte({ tenantId: 't-api' })], undefined, [], { filiere: QR });
    await relancerPaniers(texteSurApi.deps);
    expect([texteSurApi.journal.premiers, texteSurApi.journal.envois, texteSurApi.journal.issues]).toEqual([[], [], [['jeton-1', 'filiere_differente']]]);
    const modeleSurQr = monter([panier()], undefined, [], { filiere: QR });
    await relancerPaniers(modeleSurQr.deps);
    expect([modeleSurQr.journal.premiers, modeleSurQr.journal.envois, modeleSurQr.journal.issues]).toEqual([[], [], [['jeton-1', 'filiere_differente']]]);
  });

  it('🔴 une relance refusée par la limite libère son panier : rien n’est noté, il redevient dû', async () => {
    const { deps, journal } = monter([texte(), texte({ jeton: 'jeton-2' })], undefined, [], {
      filiere: QR, premier: (d) => (d.reference === 'jeton-1' ? { ok: false, refus: 'limite_modeles' } : { ok: false, refus: 'desabonne' }),
    });
    expect((await relancerPaniers(deps)).issues).toEqual({ limite_modeles: 1, desabonne: 1 });
    expect(journal.liberes).toEqual(['jeton-1']);
    // Un autre refus de la porte, lui, consomme la relance avec son issue, comme un écart de l'envoi public.
    expect(journal.issues).toEqual([['jeton-2', 'desabonne']]);
    // Sur l'API, la limite des modèles garde son issue, comme avant : rien n'est libéré.
    const api = monter([panier()], async () => ({ statut: 402, corps: { code: 'plan_limit_reached', limite: 'envoisModelesMois' } }));
    await relancerPaniers(api.deps);
    expect([api.journal.liberes, api.journal.issues]).toEqual([[], [['jeton-1', 'limite_modeles']]]);
  });

  it('🔴 un espace sans reste du mois n’est pas réclamé ; un espace de l’API, ou au reste illisible, l’est', async () => {
    const { deps, journal } = monter(
      [texte({ tenantId: 't-vide', jeton: 'vide' }), texte({ tenantId: 't-reste', jeton: 'reste' }), texte({ tenantId: 't-illisible', jeton: 'illisible' }), panier({ tenantId: 't-api', jeton: 'api' })],
      undefined, [],
      { filiere: QR, enTexte: ['t-vide', 't-reste', 't-illisible', 't-api'], reste: { 't-vide': 0, 't-reste': 5, 't-illisible': null, 't-api': 0 } },
    );
    const bilan = await relancerPaniers(deps);
    expect(journal.exclus).toEqual([['t-vide']]);
    expect(bilan.reclames).toBe(3);
    expect(journal.premiers.map((p) => p.reference)).toEqual(['reste', 'illisible']);
    expect(journal.envois).toHaveLength(1);
    expect(journal.issues.map(([jeton]) => jeton)).not.toContain('vide');
  });
});
