import { describe, it, expect, beforeAll } from 'vitest';
import { sansPortailHubspot } from './hubspot';
import { GRILLE_DEFAUT } from '../src/stats/prix';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { SettingsRouteDeps } from '../src/http/settings';
import type { OutilComplet } from '../src/agent/catalog';
import { OutilNonActivable } from '../src/agent/catalog';
import type { ModeTransfert } from '../src/agent/disponibilite-equipe';
import { ajouterOutilsSurs, reglerModeTransfert, OUTILS_SURS, type OutilsSurs } from '../src/agent/reglages';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE } from './gestes';
import { reglagesDepInertes, reglagesInertes } from './routes-inertes';

/**
 * LES RÉGLAGES QU'UN AGENT TIERS PEUT POSER SUR UN AGENT IA (lot 8a, tâche 4).
 *
 * 🔴 `ajouterOutilsSurs` est la seule porte par laquelle Claude donne des outils à un agent : QUATRE codes, jamais
 * `envoyer_bloc` (irréversible) ni ce qui écrit sur une fiche de contact, et l'activation signée du nom de la personne,
 * comme à l'écran. `reglerModeTransfert` est la route de la console, sortie pour que l'outil la partage.
 */
const AG = '11111111-1111-4111-8111-111111111111';
const PERSONNE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const outil = (handler: string, actif: boolean): OutilComplet => ({
  ...SANS_MCP, ...AUCUN_GESTE(),
  id: `id-${handler}`, tenantId: 't1', origin: 'mba', name: `mba_${handler}`,
  title: handler, description: 'd', nePasUtiliser: '', params: [], binding: { handler },
  sourceId: null, requestId: null, nature: 'integre' as const, outputPaths: [], risk: 'read',
  timeoutMs: 8000, maxBytes: 16384, autonome: false, actif, activeLe: actif ? '2026-10-03T10:00:00.000Z' : null,
  autonomeLe: null, inappelable: null,
});

function catalogue(poses: OutilComplet[], o: { nonActivable?: string } = {}) {
  const cap = { ajouts: [] as string[], activations: [] as Array<{ id: string; par: string }> };
  const outils: OutilsSurs = {
    listToutes: async (_t, agentId) => (agentId === AG ? poses : []),
    ajouter: async (_t, agentId, o2) => {
      cap.ajouts.push(o2.handler);
      return agentId === AG ? outil(o2.handler, false) : null;
    },
    activer: async (_t, _a, id, actif, par) => {
      if (o.nonActivable) throw new OutilNonActivable(o.nonActivable);
      cap.activations.push({ id, par });
      return { ...outil(id.replace(/^id-/, ''), actif), id };
    },
  };
  return { cap, outils };
}

describe('🔴 ajouterOutilsSurs : quatre outils, ajoutés et activés au nom de la personne', () => {
  it('ajoute ce qui manque, active ce qui ne l’est pas, et signe chaque activation', async () => {
    const c = catalogue([outil('terminer', true), outil('chercher_connaissance', false)]);
    const r = await ajouterOutilsSurs(c.outils, 't1', AG, ['terminer', 'chercher_connaissance', 'lire_contact'], PERSONNE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valeur.map((x) => x.actif)).toEqual([true, true, true]);
    // `terminer`, déjà posé et actif, n'est ni recréé (409 sur son nom) ni réactivé.
    expect(c.cap.ajouts).toEqual(['lire_contact']);
    expect(c.cap.activations).toEqual([
      { id: 'id-chercher_connaissance', par: PERSONNE },
      { id: 'id-lire_contact', par: PERSONNE },
    ]);
  });

  it('🔴 tout code hors des quatre est REFUSÉ, et rien n’est écrit', async () => {
    for (const code of ['envoyer_bloc', 'poser_tag', 'ecrire_variable', 'inconnu']) {
      const c = catalogue([]);
      const r = await ajouterOutilsSurs(c.outils, 't1', AG, ['terminer', code], PERSONNE);
      expect(r, code).toMatchObject({ ok: false, statut: 400 });
      if (!r.ok) expect(r.erreur).toContain(OUTILS_SURS.join(', '));
      expect(c.cap.ajouts).toHaveLength(0);
      expect(c.cap.activations).toHaveLength(0);
    }
  });

  it('🔴 sans personne à nommer, rien n’est activé (la base exige l’activateur)', async () => {
    const c = catalogue([]);
    expect(await ajouterOutilsSurs(c.outils, 't1', AG, ['terminer'], '')).toMatchObject({ ok: false, statut: 403 });
    expect(c.cap.ajouts).toHaveLength(0);
  });

  it('un agent d’un autre espace : 404, et un refus du catalogue dit sa raison en 409', async () => {
    expect(await ajouterOutilsSurs(catalogue([]).outils, 't1', '99999999-9999-4999-8999-999999999999', ['terminer'], PERSONNE))
      .toMatchObject({ ok: false, statut: 404 });
    const refuse = await ajouterOutilsSurs(catalogue([], { nonActivable: 'schéma non représentable' }).outils, 't1', AG, ['terminer'], PERSONNE);
    expect(refuse).toMatchObject({ ok: false, statut: 409, erreur: 'schéma non représentable' });
  });

  it('une liste vide ou qui n’en est pas une : 400', async () => {
    const c = catalogue([]);
    expect(await ajouterOutilsSurs(c.outils, 't1', AG, [], PERSONNE)).toMatchObject({ ok: false, statut: 400 });
    expect(await ajouterOutilsSurs(c.outils, 't1', AG, 'terminer', PERSONNE)).toMatchObject({ ok: false, statut: 400 });
  });
});

describe('le mode de transfert de l’agent IA', () => {
  it('reglerModeTransfert écrit un mode connu, et refuse le reste en le DISANT', async () => {
    const ecrits: ModeTransfert[] = [];
    const reglages = { setAgentTransfertMode: async (_t: string, m: ModeTransfert) => { ecrits.push(m); } };
    expect(await reglerModeTransfert(reglages, 't1', 'business_hours')).toEqual({ ok: true, valeur: 'business_hours' });
    const r = await reglerModeTransfert(reglages, 't1', 'parfois');
    expect(r).toMatchObject({ ok: false, statut: 400, erreur: 'mode requis (always | business_hours | never)' });
    expect(ecrits).toEqual(['business_hours']);
  });

  describe('par la route de la console, inchangée', () => {
    const SECRET = 'test-secret';
    let adminTok = '';
    beforeAll(async () => { adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET); });
    const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
    const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

    function app() {
      const ecrits: ModeTransfert[] = [];
      const settings: SettingsRouteDeps = {
        ...reglagesInertes,
        hubspotPortalConnecte: sansPortailHubspot,
        reglages: {
          ...reglagesDepInertes,
          get: async () => ({
            mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
            controlHandbackSeconds: null, mbaHandoffMode: null, agentTransfertMode: null, agentsPeuventPrendre: false,
            hubspotActif: false, optoutRequestId: null, mentionIaFrequence: null,
            timezone: 'Europe/Paris', businessHours: {}, prix: GRILLE_DEFAUT,
          }),
          setMbaEnabled: async () => {},
          setHubspotListsEnabled: async () => {},
          setMbaHandoffMode: async () => {},
          setControlHandbackSeconds: async () => {},
          setTimezone: async () => {},
          setBusinessHours: async () => {},
          setAgentTransfertMode: async (_t, m) => { ecrits.push(m); },
        },
      };
      return { ecrits, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, settings }) };
    }

    it('200 avec le mode écrit, 400 avec la liste des modes, rien d’écrit sur un refus', async () => {
      const { ecrits, srv } = app();
      const url = '/tenants/t1/settings/transfert-agent';
      const ok = await srv.inject({ method: 'PATCH', url, ...h(adminTok), payload: { mode: 'never' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ mode: 'never' });
      const ko = await srv.inject({ method: 'PATCH', url, ...h(adminTok), payload: { mode: 'tantot' } });
      expect(ko.statusCode).toBe(400);
      expect(ko.json()).toEqual({ error: 'mode requis (always | business_hours | never)' });
      expect(ecrits).toEqual(['never']);
      await srv.close();
    });
  });
});
