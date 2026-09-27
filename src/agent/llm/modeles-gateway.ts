import type { HttpGet } from '../../lib/http-get';
import type { ModeleGateway } from '../modeles';

/**
 * Le catalogue du Vercel AI Gateway, lu chez lui : ce qui existe encore et ce que ça coûte. Le choix des
 * modèles se fait dans `src/agent/modeles.ts`.
 *
 * 🔴 Il répond en dollars par jeton (`"0.00000007"`), pas par million : la conversion vit en un seul endroit,
 * `prixParMillion`. Une lecture en échec rend une liste vide, jamais une exception : le menu propose alors
 * nos modèles sans tarif.
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
    // Lu défensivement : c'est du JSON d'un tiers, une forme inattendue ne doit pas faire tomber la fiche
    // d'agent. Une entrée sans `id` exploitable est écartée.
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
