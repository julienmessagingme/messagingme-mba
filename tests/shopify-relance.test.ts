import { describe, it, expect } from 'vitest';
import { relancerPaniers, type DepsRelance } from '../src/shopify/relance';
import type { PanierDu } from '../src/shopify/store.pg';
import type { RapportEnvoi, ResultatEnvoiPublic } from '../src/api/envoi-public';
import type { Emission } from '../src/emails-produit/emission';

/**
 * LA RELANCE DES PANIERS ABANDONNÉS (plan 2026-10-21, lot 2), un passage du balayage. La réclamation (une écriture
 * atomique en base) est prouvée par le test d'intégration ; ici, ce qu'un panier réclamé devient.
 */

const panier = (over: Partial<PanierDu> = {}): PanierDu => ({
  tenantId: 't1', jeton: 'jeton-1', telephone: '+33633921577', nom: 'Julien', lien: 'https://b.myshopify.com/1/checkouts/ac/x/recover?key=k',
  domaine: 'b.myshopify.com', modele: 'relance_panier', langue: 'fr', variables: ['first_name', 'checkout_url'], ...over,
});
const rapport = (over: Partial<RapportEnvoi> = {}): RapportEnvoi => ({
  sendId: 's1', opening: 'whatsapp_template', recipientCount: 1, created: 1, matched: 0, skipped: [], skippedTotal: 0, ...over,
});

function monter(
  paniers: PanierDu[], reponse: (corps: unknown) => Promise<ResultatEnvoiPublic> = async () => ({ statut: 201, corps: rapport() }),
  fermes: readonly string[] = [],
) {
  const journal = {
    limites: [] as number[], issues: [] as Array<[string, string]>, envois: [] as Array<{ corps: unknown; options: unknown }>,
    emails: [] as Emission[],
  };
  const deps: DepsRelance = {
    store: {
      reclamerPaniersDus: async (limite) => { journal.limites.push(limite); return paniers; },
      noterIssuePanier: async (_t, jeton, issue) => { journal.issues.push([jeton, issue]); },
      panierOuvert: async (_t, jeton) => !fermes.includes(jeton),
    },
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
  });
});
