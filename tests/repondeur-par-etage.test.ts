import { describe, it, expect, vi, afterEach } from 'vitest';
import { problemeDeChaine, problemeDeRepondeur, REPONDEURS_ETAGE, type RepondeurDeLaReponse } from '../src/campaign/etages';
import { preparerCampagne, type PreparationCampagneDeps } from '../src/http/preparation-campagne';
import type { FicheAgent, StatutAgent } from '../src/agent/agent-store';
import { campagnesInertes } from './routes-inertes';
import { bancDuFil, ESPACE, type OptionsBanc } from './banc-du-fil';

/**
 * LE RÉPONDEUR D'UN ÉTAGE DE CAMPAGNE (plan `docs/superpowers/plans/2026-10-30-repondeur-par-etage.md`, livraison A) :
 * « le répondeur automatique prend la main » dit désormais LEQUEL, l'agent de Meta ou un agent IA de l'espace.
 *
 *  1. La validation, une seule règle (`problemeDeRepondeur`) pour le premier étage, la chaîne et l'outil MCP, et l'agent
 *     vérifié ACTIF et de CET espace par une lecture scopée (la clé étrangère de 0263 ne scope pas l'espace).
 *  2. La remise « personne ne suit » (`src/inbox/fil.ts`), sur le VRAI contrôle du fil (`bancDuFil`) : ses gardes
 *     d'abord, inchangées et dans leur ordre, puis le répondeur désigné REMPLACE le mode de l'espace pour ce message.
 *
 * Ce que la lecture rend en base (la plus récente campagne, la première réponse, l'isolation, l'agent supprimé) :
 * `tests/integration/repondeur-par-etage.integration.test.ts`. Que le lancement d'un agent IA retire le contact de la
 * liste de l'agent de Meta AVANT qu'il ne parle : `tests/repondeur-demarrer.test.ts` (jamais deux voix).
 */

afterEach(() => { vi.restoreAllMocks(); });

const T = 't1';
const AUTRE = 't2';
const AG = '11111111-1111-4111-8111-111111111111';
const AG_AUTRE_ESPACE = '22222222-2222-4222-8222-222222222222';
const AG_BROUILLON = '33333333-3333-4333-8333-333333333333';
const MODELE_MAIL = '44444444-4444-4444-8444-444444444444';

describe('la règle d’un répondeur d’étage (`problemeDeRepondeur`)', () => {
  it('rien de désigné : le répondeur de l’espace, comme avant (null vaut absent)', () => {
    expect(problemeDeRepondeur({})).toBeNull();
    expect(problemeDeRepondeur({ devenir: 'inbox' })).toBeNull();
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: null, repondeurAgentId: null })).toBeNull();
  });

  it('les deux répondeurs, quand le répondeur automatique prend la main', () => {
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'mba' })).toBeNull();
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG })).toBeNull();
    expect([...REPONDEURS_ETAGE]).toEqual(['mba', 'agent']);
  });

  it('🔴 refusés en phrase, jamais par le CHECK (un 500) : valeur inconnue, sans « prend la main », agent sans identifiant ou orphelin', () => {
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'humain' })).toMatch(/Répondeur d'étage inconnu/);
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 3 })).toMatch(/Répondeur d'étage inconnu/);
    // Le piège du NULL, côté code : un étage sans devenir ne choisit pas de répondeur.
    expect(problemeDeRepondeur({ repondeur: 'mba' })).toMatch(/répondeur automatique prend la main/);
    expect(problemeDeRepondeur({ devenir: 'inbox', repondeur: 'agent', repondeurAgentId: AG })).toMatch(/répondeur automatique prend la main/);
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'agent' })).toMatch(/il faut le choisir/);
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'agent', repondeurAgentId: 'pas-un-uuid' })).toMatch(/il faut le choisir/);
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'mba', repondeurAgentId: AG })).toMatch(/répondeur « agent »/);
    expect(problemeDeRepondeur({ devenir: 'mba', repondeurAgentId: AG })).toMatch(/répondeur « agent »/);
  });

  it('la chaîne la porte pour chacun de ses étages (un étage WhatsApp second, derrière un premier étage RCS)', () => {
    const chaine = (deux: Record<string, unknown>) => [{ rang: 1, canal: 'rcs' as const }, { rang: 2, canal: 'whatsapp' as const, ...deux }];
    expect(problemeDeChaine(chaine({ devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG }), 'rcs')).toBeNull();
    expect(problemeDeChaine(chaine({ repondeur: 'mba' }), 'rcs')).toMatch(/répondeur automatique prend la main/);
    expect(problemeDeChaine(chaine({ devenir: 'mba', repondeur: 'robot' }), 'rcs')).toMatch(/Répondeur d'étage inconnu/);
  });

  /**
   * 🔴 WHATSAPP SEULEMENT (relecture de la livraison B) : une réponse RCS ou e-mail ne passe jamais par la remise, le
   * répondeur désigné sur un tel étage ne répondrait jamais. Refusé, au premier étage comme dans la chaîne.
   */
  it('🔴 un répondeur sur un étage RCS ou e-mail est refusé : sa réponse ne passe jamais par la remise', () => {
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'mba', canal: 'rcs' })).toMatch(/étage WhatsApp/);
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG, canal: 'email' })).toMatch(/étage WhatsApp/);
    expect(problemeDeRepondeur({ devenir: 'mba', repondeur: 'mba', canal: 'whatsapp' })).toBeNull();
    const versEmail = [{ rang: 1, canal: 'whatsapp' as const }, { rang: 2, canal: 'email' as const, devenir: 'mba', repondeur: 'mba' }];
    expect(problemeDeChaine(versEmail, 'whatsapp')).toMatch(/étage WhatsApp/);
  });
});

/** Le magasin des agents, scopé comme `PgAgentStore.byId` (`tenant_id = $1`) : les appels sont notés. */
function agentsDe(fiches: Array<{ tenant: string; id: string; status: StatutAgent }>) {
  const appels: Array<[string, string]> = [];
  const agents: PreparationCampagneDeps['agents'] = {
    byId: async (tenant, id) => {
      appels.push([tenant, id]);
      const f = fiches.find((x) => x.tenant === tenant && x.id === id);
      return f ? ({ id: f.id, tenantId: f.tenant, status: f.status } as unknown as FicheAgent) : null;
    },
  };
  return { agents, appels };
}

const FICHES = [
  { tenant: T, id: AG, status: 'active' as const },
  { tenant: AUTRE, id: AG_AUTRE_ESPACE, status: 'active' as const },
  { tenant: T, id: AG_BROUILLON, status: 'draft' as const },
];

function lecteurs(agents: PreparationCampagneDeps['agents']): PreparationCampagneDeps {
  return {
    repo: { phoneNumberBelongsToTenant: async () => true },
    contacts: { contactIdsForTarget: async () => ['c1'] },
    identifiantsDeTousLesContacts: async () => ['c1'],
    plafondDestinataires: 10,
    rcs: { belongsToTenant: async () => true },
    emailTemplateBelongsToTenant: async () => true,
    webhookUsableByTenant: async () => true,
    getWorkflowGraph: async () => null,
    offres: campagnesInertes.offres,
    agents,
  };
}

const CORPS = { phoneNumberId: 'pn1', name: 'Rentrée', category: 'marketing', templateName: 'rentree', templateLanguage: 'fr', paramMapping: [] };
/** Un étage 2 en e-mail : le canal le plus simple à valider, le répondeur se juge pareil sur tous. */
const ETAGE_2 = { rang: 2, canal: 'email', emailTemplateId: MODELE_MAIL, emailChamp: 'email' };
/** Une campagne RCS d'abord, repliée sur WhatsApp : le seul cas où un étage SUIVANT peut désigner un répondeur. */
const CORPS_RCS = { name: 'Rentrée', category: 'marketing', channel: 'rcs', rcsAgentId: 'rcs-1', rcsMessage: { kind: 'text', text: 'Bonjour' }, phoneNumberId: 'pn1' };
const ETAGE_2_WA = { rang: 2, canal: 'whatsapp', templateName: 'rentree', templateLanguage: 'fr' };

describe('la préparation d’une campagne (`preparerCampagne`), console et MCP', () => {
  it('🔴 le premier étage confie ses réponses à un agent ACTIF de CET espace : lu par le magasin scopé, porté par l’entrée', async () => {
    const { agents, appels } = agentsDe(FICHES);
    const r = await preparerCampagne({ ...CORPS, devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG }, T, lecteurs(agents));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input).toMatchObject({ devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG });
    // L'espace de la requête, jamais un autre : c'est la lecture scopée qui fait le contrôle.
    expect(appels).toEqual([[T, AG]]);
  });

  it('🔴 un agent d’un AUTRE espace (identifiant recopié), un brouillon ou un agent inconnu : refusés en 422', async () => {
    for (const id of [AG_AUTRE_ESPACE, AG_BROUILLON, '55555555-5555-4555-8555-555555555555']) {
      const { agents } = agentsDe(FICHES);
      const r = await preparerCampagne({ ...CORPS, devenir: 'mba', repondeur: 'agent', repondeurAgentId: id }, T, lecteurs(agents));
      expect(r, id).toEqual({ ok: false, status: 422, body: { error: "Cette campagne confie ses réponses à un agent IA qui n'est pas un agent actif de cet espace." } });
    }
  });

  it('l’agent de Meta, sans identifiant ni lecture ; rien de désigné, l’entrée n’en dit rien', async () => {
    const { agents, appels } = agentsDe(FICHES);
    const meta = await preparerCampagne({ ...CORPS, devenir: 'mba', repondeur: 'mba' }, T, lecteurs(agents));
    expect(meta.ok && meta.input.repondeur).toBe('mba');
    expect(meta.ok && 'repondeurAgentId' in meta.input).toBe(false);
    const rien = await preparerCampagne({ ...CORPS, devenir: 'mba' }, T, lecteurs(agents));
    expect(rien.ok && 'repondeur' in rien.input).toBe(false);
    expect(appels).toEqual([]);
  });

  /**
   * 🔴 L'AGENT DE META HORS DE L'OFFRE EST REFUSÉ À LA PRÉPARATION (relecture de la livraison A) : en Pro, sans `agent_meta`,
   * il serait accepté puis replié à CHAQUE réponse (frise, puis l'équipe). Premier étage comme étage de la chaîne ; un agent
   * IA, lui, ne dépend d'aucune offre.
   */
  it('🔴 l’agent de Meta désigné alors que l’offre ne le comprend pas : refusé en 402, au premier étage comme dans la chaîne', async () => {
    const pro = { offreDe: async () => ({ droits: { fonctions: new Set(['inbox', 'scenarios', 'statistiques', 'email', 'console']) } }) } as unknown as PreparationCampagneDeps['offres'];
    const { agents } = agentsDe(FICHES);
    const deps = { ...lecteurs(agents), offres: pro };
    const premier = await preparerCampagne({ ...CORPS, devenir: 'mba', repondeur: 'mba' }, T, deps);
    expect(premier.ok === false && premier.status).toBe(402);
    const chaine = await preparerCampagne({
      ...CORPS_RCS, chaine: [{ rang: 1, canal: 'rcs' }, { ...ETAGE_2_WA, devenir: 'mba', repondeur: 'mba' }],
    }, T, deps);
    expect(chaine.ok === false && chaine.status).toBe(402);
    const agentIa = await preparerCampagne({ ...CORPS, devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG }, T, deps);
    expect(agentIa.ok, 'un agent IA ne dépend d’aucune offre').toBe(true);
  });

  it('les refus de la règle, en 422 : sans « prend la main », valeur inconnue, agent sans identifiant', async () => {
    const { agents, appels } = agentsDe(FICHES);
    for (const corps of [
      { ...CORPS, repondeur: 'mba' },
      { ...CORPS, devenir: 'inbox', repondeur: 'agent', repondeurAgentId: AG },
      { ...CORPS, devenir: 'mba', repondeur: 'robot' },
      { ...CORPS, devenir: 'mba', repondeur: 'agent' },
      { ...CORPS, devenir: 'mba', repondeurAgentId: AG },
    ]) {
      const r = await preparerCampagne(corps, T, lecteurs(agents));
      expect(r.ok, JSON.stringify(corps)).toBe(false);
      if (!r.ok) expect(r.status, JSON.stringify(corps)).toBe(422);
    }
    // Rien n'est lu pour une règle qui refuse déjà : un identifiant mal formé n'atteint jamais la base (22P02).
    expect(appels).toEqual([]);
  });

  it('🔴 un étage de la chaîne : la même règle, et le même contrôle d’espace sur son agent', async () => {
    const { agents, appels } = agentsDe(FICHES);
    const ok = await preparerCampagne({
      ...CORPS_RCS, chaine: [{ rang: 1, canal: 'rcs' }, { ...ETAGE_2_WA, devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG }],
    }, T, lecteurs(agents));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.input.chaine?.find((e) => e.rang === 2)).toMatchObject({ devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG });
    expect(appels).toEqual([[T, AG]]);

    const ailleurs = await preparerCampagne({
      ...CORPS_RCS, chaine: [{ rang: 1, canal: 'rcs' }, { ...ETAGE_2_WA, devenir: 'mba', repondeur: 'agent', repondeurAgentId: AG_AUTRE_ESPACE }],
    }, T, lecteurs(agents));
    expect(ailleurs).toEqual({ ok: false, status: 422, body: { error: "L'étage 2 confie ses réponses à un agent IA qui n'est pas un agent actif de cet espace." } });

    const sansDevenir = await preparerCampagne({
      ...CORPS_RCS, chaine: [{ rang: 1, canal: 'rcs' }, { ...ETAGE_2_WA, repondeur: 'mba' }],
    }, T, lecteurs(agents));
    expect(sansDevenir.ok).toBe(false);
  });
});

const W = '33611223344';
const MSG = 'Oui, je suis intéressé';
const AG_ESPACE = 'ag-espace';
const PAR_AGENT: RepondeurDeLaReponse = { nom: 'Rentrée', cible: 'agent', agentId: AG };
const PAR_META: RepondeurDeLaReponse = { nom: 'Rentrée', cible: 'mba' };
const CAUSE = 'automatique : campagne Rentrée';
const libre = { conversations: { [W]: { owner: 'app_workflow' as const } } };

const remettre = (b: ReturnType<typeof bancDuFil>, o: { redelivre?: boolean; reactionsSeules?: boolean } = {}) =>
  b.fil.remettreSiPersonneNeSuit(ESPACE, W, MSG, { rouverte: false, messageDeclencheur: 'wamid.1', ...o });

/** Les cinq modes de l'espace, montés comme le banc le permet ; l'agent de Meta allumé en veille hors du mode `mba`. */
const MODES: Array<{ nom: string; o: OptionsBanc }> = [
  { nom: 'équipe (agent de Meta en veille)', o: { mode: 'equipe', mbaEnabled: true } },
  { nom: 'agent IA de l’espace', o: { mode: 'agent', repondeurAgentId: AG_ESPACE, mbaEnabled: true } },
  { nom: 'scénario', o: { mode: 'scenario', repondeurWorkflowId: 'wf-1', mbaEnabled: true } },
  { nom: 'agent de Meta répondeur', o: { mode: 'mba', mbaEnabled: true } },
  { nom: 'mon application', o: { mode: 'application', repondeurAdresseId: 'ad-1', mbaEnabled: true } },
];

describe('🔴 la remise : l’agent IA désigné par la campagne répond, après les gardes de l’espace', () => {
  for (const m of MODES) {
    it(`🔴 espace en mode ${m.nom} : l’agent choisi démarre avec SON identifiant, aucun autre répondeur ne part`, async () => {
      const b = bancDuFil({ ...libre, ...m.o, campagne: PAR_AGENT });
      await remettre(b);
      expect(b.demarrages).toEqual([{ waId: W, agentId: AG, messageDeclencheur: 'wamid.1' }]);
      expect(b.reclamations).toEqual([]);
      expect(b.lancementsScenario).toEqual([]);
      expect(b.demandesApplication).toEqual([]);
      // L'agent de Meta n'est ni confié, ni prévenu : une seule voix.
      expect(b.appels).toEqual([]);
      expect(b.evenements).toEqual([]);
      expect(b.etat(W)?.owner, 'le fil reste aux robots, hors d’« À traiter »').toBe('app_workflow');
    });
  }

  it('l’agent choisi ne peut pas répondre (désactivé depuis, modèle absent, crédit épuisé) : à l’équipe, comme le mode agent IA', async () => {
    for (const [demarrage, cause] of [
      ['indisponible', 'automatique : le répondeur automatique ne peut pas répondre'],
      ['credit_epuise', 'automatique : crédit IA épuisé, le répondeur automatique ne peut pas répondre'],
    ] as const) {
      const b = bancDuFil({ ...libre, mode: 'equipe', mbaEnabled: false, campagne: PAR_AGENT, demarrage });
      await remettre(b);
      expect(b.etat(W)?.owner, demarrage).toBe('app_human');
      expect(b.ecritures.at(-1)?.opts, demarrage).toMatchObject({ par: { cause }, ouvreUneDemande: true });
    }
  });

  it('🔴 un fil de l’équipe au délai ÉCOULÉ revient aux robots, PUIS l’agent choisi démarre (la règle du mode agent IA)', async () => {
    const b = bancDuFil({ mode: 'agent', repondeurAgentId: AG_ESPACE, conversations: { [W]: { owner: 'app_human', changedAt: null } }, campagne: PAR_AGENT });
    await remettre(b);
    expect(b.ecritures.map((e) => e.owner)).toEqual(['app_workflow']);
    expect(b.demarrages.map((d) => d.agentId)).toEqual([AG]);
  });
});

describe('🔴 la remise : l’agent de Meta désigné par la campagne', () => {
  it('🔴 allumé, en veille (espace en mode « Équipe ») : il prend la conversation et il est prévenu ; la frise nomme la campagne', async () => {
    const b = bancDuFil({ ...libre, mode: 'equipe', mbaEnabled: true, campagne: PAR_META });
    await remettre(b);
    expect(b.appels).toEqual([`ajout:${W}`, `release:${W}`, `evenement:${W}`]);
    expect(b.etat(W)?.owner).toBe('mba');
    expect(b.ecritures).toMatchObject([{ owner: 'mba', opts: { par: { cause: CAUSE }, only: ['app_workflow', 'mba'] } }]);
    expect(b.demarrages).toEqual([]);
    expect(b.indisponibles).toEqual([]);
  });

  it('allumé, dans un espace dont un agent IA est le répondeur : l’agent de Meta répond, l’agent IA de l’espace ne démarre pas', async () => {
    const b = bancDuFil({ ...libre, mode: 'agent', repondeurAgentId: AG_ESPACE, mbaEnabled: true, campagne: PAR_META });
    await remettre(b);
    expect(b.appels).toEqual([`ajout:${W}`, `release:${W}`, `evenement:${W}`]);
    expect(b.demarrages).toEqual([]);
  });

  it('🔴 éteint : la frise le dit, l’équipe prend la conversation avec une demande et la marque collante, jamais personne', async () => {
    const b = bancDuFil({ ...libre, mode: 'equipe', mbaEnabled: false, campagne: PAR_META });
    await remettre(b);
    expect(b.indisponibles).toEqual([{ waId: W, cause: CAUSE }]);
    expect(b.etat(W)?.owner).toBe('app_human');
    expect(b.etat(W)?.escaladeeLe).not.toBeNull();
    expect(b.ecritures).toMatchObject([{ owner: 'app_human', opts: { par: { cause: CAUSE }, only: ['app_workflow', 'mba'], ouvreUneDemande: true, escalade: true } }]);
    expect(b.appels, 'aucun appel à Meta pour un agent éteint').toEqual([]);
  });

  it('🔴 allumé mais HORS de l’offre (Pro, sans `agent_meta`) : le même repli, les réglages se lisant sous l’offre', async () => {
    const b = bancDuFil({ ...libre, mode: 'equipe', mbaEnabled: true, offre: 'pro', campagne: PAR_META });
    await remettre(b);
    expect(b.indisponibles).toEqual([{ waId: W, cause: CAUSE }]);
    expect(b.etat(W)?.owner).toBe('app_human');
    expect(b.appels).toEqual([]);
  });

  it('éteint, et le fil est à l’équipe (délai écoulé) : il lui reste, sans frise ni seconde demande', async () => {
    const b = bancDuFil({ mode: 'agent', repondeurAgentId: AG_ESPACE, mbaEnabled: false, conversations: { [W]: { owner: 'app_human', changedAt: null } }, campagne: PAR_META });
    await remettre(b);
    expect(b.ecritures).toEqual([]);
    expect(b.indisponibles).toEqual([]);
    expect(b.etat(W)?.owner).toBe('app_human');
  });
});

describe('🔴 la remise : ce qui ne part pas, quoi que la campagne ait choisi', () => {
  /**
   * Les gardes d'un robot, après la lecture : le contact muet et le fil de test pour les trois issues ; la redélivrance
   * et la réaction seule pour l'agent IA (`unRobotPeutPartir`) et pour le repli de l'agent de Meta éteint (les exceptions
   * du mode « Équipe »). Allumé, l'agent de Meta suit la branche `mba` telle qu'elle est : elle ne les filtre pas, et un
   * pouce n'y déclenche aucun événement (`prevenir` se tait sur un texte vide, ce que la remise lui passe).
   */
  const MUETS: Array<{ nom: string; o: OptionsBanc; e?: { redelivre?: boolean; reactionsSeules?: boolean }; aussiMbaAllume: boolean }> = [
    { nom: 'le contact a dit STOP', o: { desabonnes: [W] }, aussiMbaAllume: true },
    { nom: 'le contact est bloqué', o: { bloques: [W] }, aussiMbaAllume: true },
    { nom: 'une conversation de test', o: { conversations: { [W]: { owner: 'app_workflow', test: true } } }, aussiMbaAllume: true },
    // 🔴 L'agent de Meta allumé aussi (relecture de la livraison A) : un pouce ne le fait pas entrer dans sa liste.
    { nom: 'un message redélivré par Meta', o: {}, e: { redelivre: true }, aussiMbaAllume: true },
    { nom: 'rien que des réactions', o: {}, e: { reactionsSeules: true }, aussiMbaAllume: true },
  ];
  for (const g of MUETS) {
    for (const [nom, campagne, mbaEnabled] of [
      ['l’agent IA choisi', PAR_AGENT, true],
      ...(g.aussiMbaAllume ? [['l’agent de Meta choisi, allumé', PAR_META, true] as const] : []),
      ['l’agent de Meta choisi, éteint', PAR_META, false],
    ] as const) {
      it(`🔴 ${g.nom} : ${nom} ne part pas, rien n’est écrit`, async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const b = bancDuFil({ ...libre, mode: 'equipe', mbaEnabled, campagne, ...g.o });
        await remettre(b, g.e);
        expect(b.lecturesCampagne, 'la campagne est lue : c’est la garde du répondeur désigné qui arrête').toEqual([W]);
        expect(b.demarrages).toEqual([]);
        expect(b.ecritures).toEqual([]);
        expect(b.indisponibles).toEqual([]);
        expect(b.evenements, 'l’agent de Meta n’est pas prévenu').toEqual([]);
      });
    }
  }

  /**
   * 🔴 LES GARDES DE L'ESPACE PASSENT AVANT, et la lecture de la campagne n'est pas même faite : un opérateur dans son
   * délai garde le fil, un parcours qui attend garde le message, un numéro bloqué ne laisse partir aucun robot.
   */
  const GARDES: Array<{ nom: string; o: OptionsBanc }> = [
    { nom: 'un opérateur tient le fil, dans son délai', o: { conversations: { [W]: { owner: 'app_human' } } } },
    { nom: 'le client attend l’équipe (escalade sans réponse), délai écoulé', o: { conversations: { [W]: { owner: 'app_human', changedAt: null, escaladeeLe: new Date() } } } },
    { nom: 'un parcours attend la réponse du contact', o: { ...libre, enAttente: true } },
    { nom: 'le numéro de l’espace est bloqué', o: { ...libre, numeroBloque: true } },
  ];
  for (const g of GARDES) {
    it(`🔴 ${g.nom} : ni l’agent choisi ni l’agent de Meta, et la campagne n’est pas lue`, async () => {
      for (const campagne of [PAR_AGENT, PAR_META]) {
        const b = bancDuFil({ mode: 'agent', repondeurAgentId: AG_ESPACE, mbaEnabled: true, campagne, ...g.o });
        const avant = b.etat(W)?.owner;
        await remettre(b);
        expect(b.lecturesCampagne, campagne.cible).toEqual([]);
        expect(b.demarrages, campagne.cible).toEqual([]);
        expect(b.appels, campagne.cible).toEqual([]);
        expect(b.etat(W)?.owner, campagne.cible).toBe(avant);
      }
    });
  }

  /**
   * 🔴 EN MODE « ÉQUIPE », LE FIL DE L'ÉQUIPE REVIENT AU RÉPONDEUR DÉSIGNÉ UNE FOIS LE DÉLAI ÉCOULÉ (relecture de la
   * livraison A, 2026-10-30). La remise de ce mode passe chaque message à l'équipe (`app_human`), et le balayage ne le
   * rend aux robots qu'à son passage. Entre les deux, la première réponse (la seule qui décide) restait à l'équipe.
   */
  it('🔴 en mode « Équipe », un fil de l’équipe au délai ÉCOULÉ revient à l’agent choisi, et l’agent de Meta choisi le prend', async () => {
    const agent = bancDuFil({ mode: 'equipe', mbaEnabled: true, conversations: { [W]: { owner: 'app_human', changedAt: null } }, campagne: PAR_AGENT });
    await remettre(agent);
    expect(agent.lecturesCampagne, 'lue une seule fois, par la garde qui en dépend').toEqual([W]);
    expect(agent.ecritures.map((e) => e.owner)).toEqual(['app_workflow']);
    expect(agent.demarrages.map((d) => d.agentId)).toEqual([AG]);

    const meta = bancDuFil({ mode: 'equipe', mbaEnabled: true, conversations: { [W]: { owner: 'app_human', changedAt: null } }, campagne: PAR_META });
    await remettre(meta);
    expect(meta.lecturesCampagne).toEqual([W]);
    expect(meta.appels).toEqual([`ajout:${W}`, `release:${W}`, `evenement:${W}`]);
    expect(meta.etat(W)?.owner).toBe('mba');
  });

  it('en mode « Équipe », sans campagne qui désigne, un fil de l’équipe lui reste même délai écoulé, comme avant', async () => {
    const b = bancDuFil({ mode: 'equipe', mbaEnabled: true, conversations: { [W]: { owner: 'app_human', changedAt: null } }, campagne: null });
    await remettre(b);
    expect(b.lecturesCampagne).toEqual([W]);
    expect(b.ecritures).toEqual([]);
    expect(b.demarrages).toEqual([]);
    expect(b.appels).toEqual([]);
    expect(b.etat(W)?.owner).toBe('app_human');
  });

  it('🔴 en mode « Équipe », un opérateur dans son délai ou un client qui attend l’équipe la gardent, et la campagne n’est pas lue', async () => {
    for (const conversation of [{ owner: 'app_human' as const }, { owner: 'app_human' as const, changedAt: null, escaladeeLe: new Date() }]) {
      for (const campagne of [PAR_AGENT, PAR_META]) {
        const b = bancDuFil({ mode: 'equipe', mbaEnabled: true, conversations: { [W]: conversation }, campagne });
        await remettre(b);
        expect(b.lecturesCampagne, campagne.cible).toEqual([]);
        expect(b.demarrages, campagne.cible).toEqual([]);
        expect(b.appels, campagne.cible).toEqual([]);
        expect(b.etat(W)?.owner, campagne.cible).toBe('app_human');
      }
    }
  });
});

describe('🔴 seule la première réponse décide : la suivante suit le réglage de l’espace', () => {
  /** Comme la vraie lecture : la campagne décide de la première réponse depuis l'envoi, plus de la seconde. */
  const premiereSeulement = (r: RepondeurDeLaReponse) => (lecture: number) => (lecture === 0 ? r : null);

  it('🔴 espace en mode « Équipe » : l’agent choisi répond au premier message ; une fois qu’il a clos, le suivant va à l’équipe', async () => {
    const b = bancDuFil({ ...libre, mode: 'equipe', mbaEnabled: true, campagne: premiereSeulement(PAR_AGENT) });
    await remettre(b);
    expect(b.demarrages.map((d) => d.agentId)).toEqual([AG]);
    // L'agent a clos son parcours (aucun n'attend plus le contact), le fil est resté aux robots.
    await remettre(b);
    expect(b.demarrages, 'l’agent choisi ne repart pas').toHaveLength(1);
    expect(b.etat(W)?.owner).toBe('app_human');
    expect(b.ecritures.at(-1)?.opts).toMatchObject({ par: { cause: 'automatique : le contact écrit, l’équipe répond' }, escalade: true });
    expect(b.lecturesCampagne).toEqual([W, W]);
  });

  it('espace dont un agent IA est le répondeur : le premier message à l’agent de la campagne, le suivant à celui de l’espace', async () => {
    const b = bancDuFil({ ...libre, mode: 'agent', repondeurAgentId: AG_ESPACE, campagne: premiereSeulement(PAR_AGENT) });
    await remettre(b);
    await remettre(b);
    expect(b.demarrages.map((d) => d.agentId)).toEqual([AG, AG_ESPACE]);
  });

  /**
   * Aucune campagne ne désigne (le cas courant, et l'agent désigné supprimé depuis, que la lecture rend comme rien) : la
   * lecture est faite, puis le mode de l'espace décide, avec SES causes. Le reste du comportement de chaque mode est tenu
   * par ses propres fichiers (`tests/repondeur-modes.test.ts`, `tests/repondeur-demarrer.test.ts`, `tests/fil.test.ts`),
   * qui montent tous le banc sans campagne.
   */
  it('aucune campagne ne désigne : la lecture est faite, et le mode de l’espace décide avec ses propres causes', async () => {
    const equipe = bancDuFil({ ...libre, mode: 'equipe', mbaEnabled: true, campagne: null });
    await remettre(equipe);
    expect(equipe.lecturesCampagne).toEqual([W]);
    expect(equipe.ecritures).toMatchObject([{ owner: 'app_human', opts: { par: { cause: 'automatique : le contact écrit, l’équipe répond' }, escalade: true } }]);
    expect(equipe.appels).toEqual([]);

    const agent = bancDuFil({ ...libre, mode: 'agent', repondeurAgentId: AG_ESPACE, campagne: null });
    await remettre(agent);
    expect(agent.demarrages.map((d) => d.agentId)).toEqual([AG_ESPACE]);

    // La frise dit « personne ne suit » quand aucune campagne n'a choisi l'agent de Meta : la cause d'une campagne ne s'y
    // glisse pas.
    const meta = bancDuFil({ ...libre, mode: 'mba', mbaEnabled: true, campagne: null });
    await remettre(meta);
    expect(meta.appels).toEqual([`ajout:${W}`, `release:${W}`, `evenement:${W}`]);
    expect(meta.ecritures).toMatchObject([{ owner: 'mba', opts: { par: { cause: 'automatique : le contact écrit et personne ne suit la conversation' } } }]);
  });
});
