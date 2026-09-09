import type { HttpGet } from '../../lib/http-get';
import type { ModeleGateway } from '../modeles';

/**
 * LE CATALOGUE DU VERCEL AI GATEWAY, lu chez lui.
 *
 * 373 modèles au 2026-09-09, dont 235 gèrent les outils. On ne s'en sert que pour DEUX choses : savoir ce qui
 * existe encore, et savoir ce que ça coûte. Le choix, lui, est fait dans `src/agent/modeles.ts` : le Gateway
 * ne sait pas lequel parle bien français.
 *
 * 🔴 IL RÉPOND EN DOLLARS PAR JETON (`"0.00000007"`), pas en dollars par million. C'est le même piège d'unité
 * que la dette D1 (`src/agent/devise.ts`), qui avait fait additionner des dollars dans une colonne d'euros :
 * la conversion vit en UN seul endroit, `prixParMillion`, et pas ici.
 *
 * ⚠️ Une lecture en échec rend une liste VIDE, jamais une exception : l'appelant propose alors nos modèles
 * sans tarif plutôt que de vider le menu, et un client peut toujours changer de modèle pendant que le
 * catalogue est injoignable.
 */
const URL_MODELES = 'https://ai-gateway.vercel.sh/v1/models';

/** Échéance de la lecture. Elle sert une requête d'un utilisateur devant son écran : au-delà, il vaut mieux
 *  un menu sans tarif tout de suite qu'un menu complet dans quinze secondes. */
const TIMEOUT_MS = 6_000;

export async function lireCatalogueGateway(transport: HttpGet, apiKey: string): Promise<ModeleGateway[]> {
  if (apiKey.trim() === '') return [];
  try {
    const res = await transport.get(URL_MODELES, { authorization: `Bearer ${apiKey}` }, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status < 200 || res.status >= 300) return [];
    // Forme lue DÉFENSIVEMENT : c'est du JSON d'un tiers, et une forme inattendue ne doit pas faire tomber la
    // fiche d'agent entière. Une entrée sans `id` exploitable est simplement écartée.
    const data = (res.json as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return [];
    return data.flatMap((m): ModeleGateway[] => {
      if (typeof m !== 'object' || m === null) return [];
      const o = m as Record<string, unknown>;
      if (typeof o.id !== 'string' || o.id === '') return [];
      const p = typeof o.pricing === 'object' && o.pricing !== null ? (o.pricing as Record<string, unknown>) : undefined;
      return [{
        id: o.id,
        ...(typeof o.type === 'string' ? { type: o.type } : {}),
        ...(Array.isArray(o.supported_parameters)
          ? { supported_parameters: o.supported_parameters.filter((x): x is string => typeof x === 'string') }
          : {}),
        ...(p
          ? {
            pricing: {
              ...(typeof p.input === 'string' || typeof p.input === 'number' ? { input: p.input } : {}),
              ...(typeof p.output === 'string' || typeof p.output === 'number' ? { output: p.output } : {}),
            },
          }
          : {}),
      }];
    });
  } catch {
    // Réseau coupé, échéance atteinte, JSON illisible : tous rendent « je ne sais pas », jamais une panne.
    return [];
  }
}
