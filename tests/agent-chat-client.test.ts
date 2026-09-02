import { describe, it, expect } from 'vitest';
import { GatewayChatClient } from '../src/agent/llm/chat-client';
import { LlmApiError } from '../src/llm/errors';
import type { HttpResponse, HttpTransport } from '../src/meta/http';

/**
 * Corps de réponse OBSERVÉ EN DIRECT sur le Vercel AI Gateway le 2026-08-27 (appel réel avec une clé), et
 * non recopié d'une documentation. C'est ce qui donne sa valeur à ces tests : ils sont calqués sur ce que
 * l'API renvoie vraiment, pas sur ce qu'on croit qu'elle renvoie.
 *
 * Les deux pièges qu'ils verrouillent : `usage` est à la RACINE du corps (pas sur le message), et
 * `provider_metadata.gateway` est SUR LE MESSAGE (pas à la racine), avec un `cost` en chaîne décimale.
 */
const REPONSE_REELLE = {
  id: 'gen_01M11BXW3YAX7FXCKZ8EAX7DFN',
  object: 'chat.completion',
  model: 'google/gemini-3.1-flash-lite',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: 'ok',
      provider_metadata: {
        vertex: { usageMetadata: { promptTokenCount: 5 } },
        gateway: { cost: '0.00000275', marketCost: '0.00000275', generationId: 'gen_01M11BXW3YAX7FXCKZ8EAX7DFN' },
      },
    },
    finish_reason: 'length',
  }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 0.00000275 },
};

class FauxTransport implements HttpTransport {
  public readonly appels: Array<{ url: string; body: unknown; headers: Record<string, string>; opts?: { signal?: AbortSignal } }> = [];
  constructor(private readonly reponses: HttpResponse[]) {}
  async post(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse> {
    this.appels.push({ url, body, headers, ...(opts ? { opts } : {}) });
    return this.reponses[Math.min(this.appels.length - 1, this.reponses.length - 1)]!;
  }
}

const ok = (json: unknown): HttpResponse => ({ status: 200, json });
const ko = (status: number, json: unknown = { error: { message: 'boom' } }): HttpResponse => ({ status, json });

describe('GatewayChatClient (tâche 14)', () => {
  it('lit la réponse RÉELLE : texte, usage à la racine, coût sur le message', async () => {
    const t = new FauxTransport([ok(REPONSE_REELLE)]);
    const r = await new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [{ role: 'user', content: 'salut' }] });
    expect(r.texte).toBe('ok');
    expect(r.usage.tokensIn).toBe(5);
    expect(r.usage.tokensOut).toBe(1);
    expect(r.usage.coutDollars).toBeCloseTo(0.00000275, 10);
    expect(r.generationId).toBe('gen_01M11BXW3YAX7FXCKZ8EAX7DFN');
    expect(r.finish).toBe('length');
    expect(r.appelsOutils).toEqual([]);
  });

  it('🔴 envoie les outils sous function.parameters (forme Chat Completions, pas Responses)', async () => {
    // Se tromper de forme fait refuser le corps en 400 par le Gateway.
    const t = new FauxTransport([ok(REPONSE_REELLE)]);
    await new GatewayChatClient('cle', t).completer({
      modele: 'm',
      messages: [{ role: 'user', content: 'x' }],
      outils: [{ name: 'chercher', description: 'cherche', parameters: { type: 'object', properties: {} } }],
    });
    const corps = t.appels[0]?.body as { tools?: Array<{ type?: string; function?: { name?: string; parameters?: unknown } }> };
    expect(corps.tools?.[0]?.type).toBe('function');
    expect(corps.tools?.[0]?.function?.name).toBe('chercher');
    expect(corps.tools?.[0]?.function?.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('sans outil, la clé tools est ABSENTE du corps (et non un tableau vide)', async () => {
    const t = new FauxTransport([ok(REPONSE_REELLE)]);
    await new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(t.appels[0]?.body).not.toHaveProperty('tools');
  });

  it('lit les appels d outils décidés par le modèle', async () => {
    const avecOutil = {
      choices: [{
        finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'chercher', arguments: '{"q":"prix"}' } }] },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    };
    const t = new FauxTransport([ok(avecOutil)]);
    const r = await new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [] });
    expect(r.texte).toBeNull();
    expect(r.finish).toBe('tool_calls');
    expect(r.appelsOutils).toEqual([{ id: 'call_1', nom: 'chercher', argumentsJson: '{"q":"prix"}' }]);
  });

  it('l authentification part en Bearer sur la bonne URL', async () => {
    const t = new FauxTransport([ok(REPONSE_REELLE)]);
    await new GatewayChatClient('ma-cle', t).completer({ modele: 'm', messages: [] });
    expect(t.appels[0]?.url).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
    expect(t.appels[0]?.headers.authorization).toBe('Bearer ma-cle');
  });

  it('transmet le signal d annulation au transport', async () => {
    // Sans lui, un fournisseur qui pend immobilise un slot de worker pendant des minutes, sans trace.
    const t = new FauxTransport([ok(REPONSE_REELLE)]);
    const ac = new AbortController();
    await new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [], signal: ac.signal });
    expect(t.appels[0]?.opts?.signal).toBe(ac.signal);
  });

  it('🔴 400 est TERMINAL : un seul appel, pas de rejeu', async () => {
    // Un schéma d'outil refusé ne devient pas valide en le renvoyant : rejouer paierait 3 fois la même
    // erreur de configuration.
    const t = new FauxTransport([ko(400)]);
    await expect(new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [] })).rejects.toBeInstanceOf(LlmApiError);
    expect(t.appels).toHaveLength(1);
  });

  it('401, 403 et 404 sont terminaux eux aussi (clé, aucun fournisseur, modèle inconnu)', async () => {
    for (const status of [401, 403, 404]) {
      const t = new FauxTransport([ko(status)]);
      await expect(new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [] })).rejects.toBeInstanceOf(LlmApiError);
      expect(t.appels, `status ${status}`).toHaveLength(1);
    }
  });

  it('🔴 429 est REJOUÉ, puis réussit', async () => {
    const t = new FauxTransport([ko(429), ok(REPONSE_REELLE)]);
    const r = await new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [] });
    expect(r.texte).toBe('ok');
    expect(t.appels.length).toBeGreaterThan(1);
  });

  it('les tentatives sont BORNÉES à 3 appels au total (2 rejeux), pas les 5 par défaut', async () => {
    // Le défaut de withRetry est maxRetries: 4 et maxDelayMs: 30000, ce qui consommerait à lui seul tout le
    // budget de temps d'un tour d'agent.
    const t = new FauxTransport([ko(503)]);
    await expect(new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [] })).rejects.toBeInstanceOf(LlmApiError);
    expect(t.appels).toHaveLength(3);
  });

  it('un corps vide ou inattendu ne fait pas lever : texte null, compteurs à zéro', async () => {
    const t = new FauxTransport([ok(null)]);
    const r = await new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [] });
    expect(r.texte).toBeNull();
    expect(r.usage).toEqual({ tokensIn: 0, tokensOut: 0, tokensCaches: 0, coutDollars: 0 });
    expect(r.appelsOutils).toEqual([]);
  });

  /**
   * 🔴 LES TOKENS SERVIS DEPUIS UN CACHE (2026-09-02). Le champ arrivait dans la réponse et personne ne le
   * lisait, donc on ne SAVAIT pas si le cache tournait. C'est la mesure la moins chère du chantier IA et elle
   * décide de la suite : la partie constante de chaque appel (prompt système + définitions d'outils) est
   * renvoyée à chaque aller-retour, jusqu'à six par tour. Cachée, elle n'est payée qu'une fois.
   */
  it('🔴 lit prompt_tokens_details.cached_tokens', async () => {
    const t = new FauxTransport([ok({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4000, completion_tokens: 20, cost: 0.01, prompt_tokens_details: { cached_tokens: 3200 } },
    })]);
    const r = await new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [] });
    expect(r.usage.tokensCaches).toBe(3200);
    expect(r.usage.tokensIn).toBe(4000);
  });

  it('un fournisseur qui ne rend PAS ce champ donne zéro, sans rien casser', async () => {
    // ⚠️ Et zéro veut alors dire deux choses différentes : « pas de cache » ou « champ non rendu ». Les
    // distinguer demande de regarder si le nombre reste nul sur un préfixe long RÉPÉTÉ, ce qu'aucun test
    // unitaire ne peut faire à notre place.
    const t = new FauxTransport([ok({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4000, completion_tokens: 20 },
    })]);
    const r = await new GatewayChatClient('cle', t).completer({ modele: 'm', messages: [] });
    expect(r.usage.tokensCaches).toBe(0);
    expect(r.usage.tokensIn).toBe(4000);
  });
});
