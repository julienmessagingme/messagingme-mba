import { describe, it, expect } from 'vitest';
import { MbaClient, fusionnerBusinessInfo, modifierSettings } from '../src/mba/client';
import { MetaApiError } from '../src/meta/errors';

/** Faux fetch : enregistre les appels et rend des réponses scriptées. Aucun réseau. */
function faux(reponses: Array<{ status?: number; body: unknown }>) {
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
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl: impl as unknown as typeof fetch, appels };
}

describe('MbaClient : la surface MBA n’est pas Graph', () => {
  it('tape api.facebook.com SANS version dans le chemin, avec X-API-Version', async () => {
    const { impl, appels } = faux([{ body: { is_eligible: true } }]);
    const c = new MbaClient('tok', impl);
    expect(await c.isEligible('PN1')).toBe(true);
    expect(appels[0]!.url).toBe('https://api.facebook.com/PN1/agent_eligibility');
    expect(appels[0]!.url).not.toContain('graph.facebook.com');
    expect(appels[0]!.url).not.toMatch(/\/v\d+\.\d+\//); // pas de version dans le chemin
    expect(appels[0]!.headers['X-API-Version']).toBe('2.0.0');
    expect(appels[0]!.headers.Authorization).toBe('Bearer tok');
  });

  it('getSettings dénoue le TABLEAU que Meta renvoie', async () => {
    const { impl } = faux([{ body: [{ agent_id: 'a1', rollout: { enabled: false } }] }]);
    const s = await new MbaClient('tok', impl).getSettings('PN1');
    expect(s?.agent_id).toBe('a1');
  });

  it('🔴 remonte le `detail` de Meta, qui porte la marche à suivre', async () => {
    const { impl } = faux([{
      status: 400,
      body: { title: 'Cannot enable Meta Business Agent', detail: 'A payment method is required. Add one in the Billing Hub: https://x' },
    }]);
    const c = new MbaClient('tok', impl);
    // Sans normalisation, cette forme d'erreur (propre à MBA) donnerait « erreur inconnue » à l'écran.
    await expect(c.getSettings('PN1')).rejects.toThrow(MetaApiError);
    const err = (await c.getSettings('PN1').catch((e: unknown) => e)) as MetaApiError;
    expect(err.userMessage).toContain('Billing Hub');
    expect(err.message).toContain('Cannot enable');
  });

  it('accepte aussi la forme d’erreur classique de Graph', async () => {
    const { impl } = faux([{ status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } }]);
    const err = (await new MbaClient('tok', impl).getSettings('PN1').catch((e: unknown) => e)) as MetaApiError;
    expect(err.code).toBe(100);
  });

  it('les skills passent TOUJOURS agent_id explicitement', async () => {
    const { impl, appels } = faux([{ body: [] }, { body: { id: 's1' } }]);
    const c = new MbaClient('tok', impl);
    await c.listSkills('PN1', 'AG1');
    await c.createSkill('PN1', 'AG1', { title: 't', description: 'd', skill: 's' });
    // Sans agent_id, Meta écrit sous « les settings les plus récemment créés » : pas forcément les nôtres.
    expect(appels[0]!.url).toContain('agent_id=AG1');
    expect(appels[1]!.url).toContain('agent_id=AG1');
  });
});

describe('fusionnerBusinessInfo : le PUT est un remplacement complet', () => {
  it('🔴 préserve les champs absents du patch', async () => {
    const existant = { business_description: 'Réseau de bus', purchase_info: 'En agence', contact_info: { email: 'a@b.c' } };
    const { impl, appels } = faux([{ body: existant }, { body: existant }]);
    await fusionnerBusinessInfo(new MbaClient('tok', impl), 'PN1', { return_policy: 'Aucune' });
    const envoye = appels[1]!.body as Record<string, unknown>;
    expect(envoye.return_policy).toBe('Aucune');
    expect(envoye.business_description).toBe('Réseau de bus'); // aurait été effacé par un PUT naïf
    expect(envoye.purchase_info).toBe('En agence');
    expect(envoye.contact_info).toEqual({ email: 'a@b.c' });
  });

  it('fusionne contact_info champ par champ', async () => {
    const { impl, appels } = faux([{ body: { contact_info: { email: 'a@b.c', address: 'Auxerre' } } }, { body: {} }]);
    await fusionnerBusinessInfo(new MbaClient('tok', impl), 'PN1', { contact_info: { email: 'neuf@b.c' } });
    expect((appels[1]!.body as { contact_info: unknown }).contact_info).toEqual({ email: 'neuf@b.c', address: 'Auxerre' });
  });
});

describe('modifierSettings : survivre à un champ que Meta ajouterait', () => {
  it('🔴 repasse les clés INCONNUES telles quelles', async () => {
    const actuel = {
      agent_id: 'a1',
      rollout: { enabled: false },
      never_say_phrases: ['jamais ça'],
      followup: { enabled: true, followup_interval_in_seconds: 3600 },
      champ_invente_par_meta_demain: { garde: 'moi' },
    };
    const { impl, appels } = faux([{ body: [actuel] }, { body: {} }]);
    await modifierSettings(new MbaClient('tok', impl), 'PN1', { ai_audience: 'ALLOWLISTED_ONLY' });
    const envoye = appels[1]!.body as Record<string, unknown>;
    expect(envoye.ai_audience).toBe('ALLOWLISTED_ONLY');
    expect(envoye.never_say_phrases).toEqual(['jamais ça']);
    expect(envoye.followup).toEqual({ enabled: true, followup_interval_in_seconds: 3600 });
    // Le point du test : un modèle typé fermé aurait supprimé ce champ inconnu au passage.
    expect(envoye.champ_invente_par_meta_demain).toEqual({ garde: 'moi' });
  });

  it('🔴 retire agent_id et channel du CORPS et repasse agent_id en QUERY', async () => {
    // Ces deux champs sont dans la réponse du GET mais pas dans le schéma de requête : les renvoyer tels
    // quels expose à un 400. Et sans `agent_id` en query, le PUT bascule en « create-or-fetch » : on ne sait
    // plus quelle configuration on écrit.
    const { impl, appels } = faux([{ body: [{ agent_id: 'a1', channel: 'whatsapp', rollout: { enabled: false } }] }, { body: {} }]);
    await modifierSettings(new MbaClient('tok', impl), 'PN1', { rollout: { enabled: true } });
    expect(appels[1]!.url).toBe('https://api.facebook.com/PN1/agent_config/settings?agent_id=a1');
    const envoye = appels[1]!.body as Record<string, unknown>;
    expect(envoye).not.toHaveProperty('agent_id');
    expect(envoye).not.toHaveProperty('channel');
    expect(envoye.rollout).toEqual({ enabled: true });
  });

  it('fusionne rollout sans perdre les autres clés du sous-objet', async () => {
    const { impl, appels } = faux([{ body: [{ rollout: { enabled: false, autre: 1 } }] }, { body: {} }]);
    await modifierSettings(new MbaClient('tok', impl), 'PN1', { rollout: { enabled: true } });
    expect((appels[1]!.body as { rollout: unknown }).rollout).toEqual({ enabled: true, autre: 1 });
  });
});
