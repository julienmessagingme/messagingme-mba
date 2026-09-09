import { describe, it, expect } from 'vitest';
import { creerCleGateway, majPlafondCleGateway, estPlafondAtteint, CleGatewayError } from '../src/agent/llm/cles-gateway';
import type { HttpResponse, HttpTransportPatch } from '../src/meta/http';

/**
 * LE CLIENT DE PROVISIONNEMENT des clés AI Gateway (2026-09-09).
 *
 * 🔴 CE QUE CES TESTS TIENNENT, ET QUE RIEN D'AUTRE NE PEUT VOIR. Les deux appels de ce module partent vers
 * des HÔTES DIFFÉRENTS, avec des AUTHENTIFICATIONS DIFFÉRENTES, et le second exige un préfixe sur son
 * identifiant d'entité. Trois façons indépendantes de se tromper, et aucune ne produit d'erreur de
 * compilation : les trois donnent un 401 ou un 404 en production, au moment précis où un client crée son
 * premier agent. Ces tests les figent.
 */

/** Transport de test qui note ce qu'on lui a demandé et rend une réponse programmée. */
class FauxTransport implements HttpTransportPatch {
  readonly appels: Array<{ methode: 'POST' | 'PATCH'; url: string; body: unknown; headers: Record<string, string> }> = [];
  constructor(private readonly reponses: HttpResponse[]) {}

  post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.appels.push({ methode: 'POST', url, body, headers });
    return this.suivante();
  }

  patch(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    this.appels.push({ methode: 'PATCH', url, body, headers });
    return this.suivante();
  }

  private suivante(): Promise<HttpResponse> {
    const r = this.reponses.shift();
    if (!r) throw new Error('faux transport : appel non prevu');
    return Promise.resolve(r);
  }
}

/** Transport qui échoue au réseau, pour le cas « on ne connaît même pas le statut ». */
class TransportCasse implements HttpTransportPatch {
  post(): Promise<HttpResponse> { return Promise.reject(new Error('ECONNRESET')); }
  patch(): Promise<HttpResponse> { return Promise.reject(new Error('ECONNRESET')); }
}

const OK_CREATION: HttpResponse = { status: 200, json: { id: 'key_abc', apiKeyString: 'vck_secret' } };

describe('Créer une clé AI Gateway', () => {
  it('🔴 frappe api.vercel.com avec le JETON DE COMPTE et le teamId en paramètre', async () => {
    const t = new FauxTransport([OK_CREATION]);
    await creerCleGateway(t, { jetonCompte: 'jeton', teamId: 'team_x', nom: 'Demo (t1)', plafondDollars: 10 });

    const a = t.appels[0]!;
    expect(a.methode).toBe('POST');
    expect(a.url).toBe('https://api.vercel.com/v1/api-keys?teamId=team_x');
    // Le JETON DE COMPTE, pas la clé Gateway maison : c'est le seul des deux qui sait fabriquer des clés.
    expect(a.headers.authorization).toBe('Bearer jeton');
  });

  it('🔴 le plafond est POSÉ À LA CRÉATION, et il ne se recharge JAMAIS tout seul', async () => {
    // `refreshPeriod: none` et non `monthly` : le crédit est PRÉPAYÉ. Un plafond mensuel redonnerait au
    // client, le premier de chaque mois, un budget qu'il n'a pas acheté.
    const t = new FauxTransport([OK_CREATION]);
    await creerCleGateway(t, { jetonCompte: 'j', teamId: 'tm', nom: 'n', plafondDollars: 42 });

    expect(t.appels[0]!.body).toEqual({
      purpose: 'ai-gateway',
      name: 'n',
      aiGatewayQuota: { limitAmount: 42, refreshPeriod: 'none' },
    });
  });

  it('rend l’identifiant ET le secret', async () => {
    const t = new FauxTransport([OK_CREATION]);
    expect(await creerCleGateway(t, { jetonCompte: 'j', teamId: 'tm', nom: 'n', plafondDollars: 1 }))
      .toEqual({ id: 'key_abc', cle: 'vck_secret' });
  });

  it('🔴 un 200 au corps ILLISIBLE échoue, il ne devine pas', async () => {
    // Deviner un nom de champ ici ferait enregistrer `undefined` comme clé d'un client : tous ses appels
    // partiraient ensuite en 401, et la cause serait cherchée partout sauf ici.
    const t = new FauxTransport([{ status: 200, json: { key: 'vck_x' } }]);
    await expect(creerCleGateway(t, { jetonCompte: 'j', teamId: 'tm', nom: 'n', plafondDollars: 1 }))
      .rejects.toThrow(CleGatewayError);
  });

  it('un statut d’échec lève, en portant le statut', async () => {
    const t = new FauxTransport([{ status: 403, json: { error: 'forbidden' } }]);
    await expect(creerCleGateway(t, { jetonCompte: 'j', teamId: 'tm', nom: 'n', plafondDollars: 1 }))
      .rejects.toMatchObject({ operation: 'creation', status: 403 });
  });

  it('une panne réseau lève AUSSI, avec un statut nul', async () => {
    await expect(creerCleGateway(new TransportCasse(), { jetonCompte: 'j', teamId: 'tm', nom: 'n', plafondDollars: 1 }))
      .rejects.toMatchObject({ operation: 'creation', status: null });
  });

  it('🔴 le message d’erreur ne porte JAMAIS le corps de la réponse', async () => {
    // Le corps d'une création réussie contient le SECRET, et ces messages finissent dans les journaux.
    const t = new FauxTransport([{ status: 500, json: { apiKeyString: 'vck_ce_secret_ne_doit_pas_fuiter' } }]);
    const err = await creerCleGateway(t, { jetonCompte: 'j', teamId: 'tm', nom: 'n', plafondDollars: 1 }).catch((e) => e);
    expect(String(err)).not.toContain('vck_ce_secret_ne_doit_pas_fuiter');
  });
});

describe('Déplacer le plafond d’une clé existante', () => {
  it('🔴 AUTRE hôte, AUTRE authentification, et l’entité porte le préfixe api_key_id_', async () => {
    // Les trois pièges du fichier, en un seul test. Chacune se devine de travers isolément, et aucune ne se
    // voit à la compilation : la conséquence est un 401 ou un 404 le jour d'un rechargement.
    const t = new FauxTransport([{ status: 200, json: {} }]);
    await majPlafondCleGateway(t, { cleGatewayMaison: 'vck_maison', cleId: 'key_abc', plafondDollars: 25 });

    const a = t.appels[0]!;
    expect(a.methode).toBe('PATCH');
    expect(a.url).toBe('https://ai-gateway.vercel.sh/v1/quotas?quotaEntityId=api_key_id_key_abc');
    expect(a.headers.authorization).toBe('Bearer vck_maison');
    expect(a.body).toEqual({ limitAmount: 25, refreshPeriod: 'none' });
  });

  it('un échec lève, en se nommant', async () => {
    const t = new FauxTransport([{ status: 404, json: {} }]);
    await expect(majPlafondCleGateway(t, { cleGatewayMaison: 'k', cleId: 'x', plafondDollars: 5 }))
      .rejects.toMatchObject({ operation: 'plafond', status: 404 });
  });
});

describe('Reconnaître un plafond atteint', () => {
  it('🔴 se lit sur le TYPE, jamais sur le message', () => {
    // Le message porte des montants qui changent à chaque appel ; le type est stable. Confondre les deux
    // ferait rejouer un refus commercial comme s'il était une panne, donc échouer en boucle et facturer.
    expect(estPlafondAtteint({ error: { type: 'quota_for_entity_exceeded', message: 'Current spend: $10.00' } })).toBe(true);
  });

  it('une autre erreur n’est PAS un plafond', () => {
    expect(estPlafondAtteint({ error: { type: 'invalid_request', message: 'quota limit exceeded' } })).toBe(false);
    expect(estPlafondAtteint(null)).toBe(false);
    expect(estPlafondAtteint({})).toBe(false);
  });
});
