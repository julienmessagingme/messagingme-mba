import { describe, it, expect } from 'vitest';
import { MbaClient } from '../src/mba/client';
import { MetaApiError } from '../src/meta/errors';

/** Faux fetch : enregistre les appels et rend des réponses scriptées. Un 204 rend un corps vide, comme Meta. */
function faux(reponses: Array<{ status?: number; body?: unknown }>) {
  const appels: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  let i = 0;
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const r = reponses[Math.min(i, reponses.length - 1)]!;
    i += 1;
    appels.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body), { status });
  };
  return { impl: impl as unknown as typeof fetch, appels };
}

const element = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `titre-${id}`, component_type: 'cta_url', status: 'enabled', instruction: 'Quand : ...',
  created_at: 1, updated_at: 2, ...extra,
});

describe('MbaClient : les messages interactifs (agent-ui-skills)', () => {
  it('liste sur /{pn}/agent-ui-skills, en-tête 2.0.0, sans agent_id', async () => {
    const { impl, appels } = faux([{ body: { data: [element('a')] } }]);
    const liste = await new MbaClient('tok', impl).listMessagesInteractifs('PN1');
    expect(liste.map((m) => m.id)).toEqual(['a']);
    expect(appels[0]!.url).toBe('https://api.facebook.com/PN1/agent-ui-skills?limit=25');
    expect(appels[0]!.headers['X-API-Version']).toBe('2.0.0');
    expect(appels[0]!.url).not.toContain('agent_id');
  });

  it('🔴 suit cursors.after jusqu’à la page qui n’en porte plus (forme mesurée le 2026-10-07)', async () => {
    const { impl, appels } = faux([
      { body: { data: [element('a'), element('b')], paging: { cursors: { after: 'CUR+1' } } } },
      { body: { data: [element('c')], paging: { cursors: { before: 'CUR0' } } } },
    ]);
    const liste = await new MbaClient('tok', impl).listMessagesInteractifs('PN1');
    expect(liste.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(appels).toHaveLength(2);
    expect(appels[1]!.url).toBe('https://api.facebook.com/PN1/agent-ui-skills?limit=25&after=CUR%2B1');
  });

  it('s’arrête à dix pages, même si Meta rend toujours un curseur', async () => {
    const { impl, appels } = faux([{ body: { data: [element('x')], paging: { cursors: { after: 'encore' } } } }]);
    await new MbaClient('tok', impl).listMessagesInteractifs('PN1');
    expect(appels).toHaveLength(10);
  });

  it('écarte un élément illisible (un type que Meta ajouterait) sans perdre les autres', async () => {
    const { impl } = faux([{ body: { data: [element('a'), element('b', { component_type: 'nouveau' })] } }]);
    expect((await new MbaClient('tok', impl).listMessagesInteractifs('PN1')).map((m) => m.id)).toEqual(['a']);
  });

  it('lève sur une PAGE illisible, plutôt que de rendre une liste vide qui mentirait', async () => {
    const { impl } = faux([{ body: { erreur: 'pas une page' } }]);
    await expect(new MbaClient('tok', impl).listMessagesInteractifs('PN1')).rejects.toThrow(/illisible/);
  });

  it('crée avec le corps de Meta et relit la réponse', async () => {
    const { impl, appels } = faux([{ status: 201, body: element('n', { component_type: 'flow', flow_id: 42 }) }]);
    const m = await new MbaClient('tok', impl).creerMessageInteractif('PN1', { titre: 't', type: 'flow', consigne: 'c', formulaireId: '42' });
    expect(appels[0]!.method).toBe('POST');
    expect(appels[0]!.body).toEqual({ title: 't', component_type: 'flow', status: 'enabled', instruction: 'c', flow_id: '42' });
    expect(m.formulaireId).toBe('42');
  });

  it('🔴 modifie sans jamais envoyer le type, sur l’identifiant encodé', async () => {
    const { impl, appels } = faux([{ body: element('pfbid0/x', { status: 'disabled' }) }]);
    const m = await new MbaClient('tok', impl).modifierMessageInteractif('PN1', 'pfbid0/x', { actif: false });
    expect(appels[0]!.method).toBe('PUT');
    expect(appels[0]!.url).toBe('https://api.facebook.com/PN1/agent-ui-skills/pfbid0%2Fx');
    expect(appels[0]!.body).toEqual({ status: 'disabled' });
    expect(m.actif).toBe(false);
  });

  it('supprime (204, corps vide)', async () => {
    const { impl, appels } = faux([{ status: 204 }]);
    await new MbaClient('tok', impl).supprimerMessageInteractif('PN1', 'abc');
    expect(appels[0]!.method).toBe('DELETE');
    expect(appels[0]!.url).toBe('https://api.facebook.com/PN1/agent-ui-skills/abc');
  });

  it('remonte le refus de Meta avec son detail (la publication du formulaire, mesurée)', async () => {
    const { impl } = faux([{ status: 400, body: { title: 'Bad Request', detail: 'A flow must be published before an enabled flow UI component can be created for it.' } }]);
    const err = await new MbaClient('tok', impl)
      .creerMessageInteractif('PN1', { titre: 't', type: 'flow', consigne: 'c', formulaireId: '42' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).userMessage).toContain('must be published');
  });
});

describe('🔴 une écriture acceptée par Meta ne lève jamais, même si sa réponse est illisible', () => {
  it('création : relit par la liste avec l’identifiant rendu', async () => {
    const { impl, appels } = faux([
      { status: 201, body: { id: 'n1' } },
      { body: { data: [element('n1', { title: 'boutons-rdv' })] } },
    ]);
    const m = await new MbaClient('tok', impl).creerMessageInteractif('PN1', { titre: 'boutons-rdv', type: 'cta_url', consigne: 'c', formulaireId: null });
    expect(m).toMatchObject({ id: 'n1', titre: 'boutons-rdv' });
    expect(appels.map((a) => a.method)).toEqual(['POST', 'GET']);
  });

  it('création : sans identifiant ni relecture possible, rend ce qui a été envoyé', async () => {
    const { impl } = faux([{ status: 201, body: { success: true } }]);
    const m = await new MbaClient('tok', impl).creerMessageInteractif('PN1', { titre: 'boutons-rdv', type: 'cta_url', consigne: 'c', formulaireId: null });
    expect(m).toMatchObject({ id: '', titre: 'boutons-rdv', type: 'cta_url', consigne: 'c' });
  });

  it('modification : une relecture qui échoue n’empêche pas de rendre le repli', async () => {
    const { impl } = faux([{ body: { success: true } }, { status: 500, body: { title: 'x' } }]);
    const m = await new MbaClient('tok', impl).modifierMessageInteractif('PN1', 'm1', { actif: false });
    expect(m).toMatchObject({ id: 'm1', actif: false });
  });
});
