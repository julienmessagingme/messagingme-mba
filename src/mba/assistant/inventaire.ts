import { calculerCompletion } from '../completion';
import type { InventaireMba } from './conversation';

/**
 * L'état de l'agent chez Meta, lu en un passage, à chaque tour de l'assistant. Six lectures en parallèle, chacune
 * pouvant échouer seule : elles rendent `null` plutôt que de lever, car `calculerCompletion` distingue « pas lu »
 * de « vide » (traiter un échec comme vide afficherait « FAQ à faire » sur un agent qui en a trente).
 * Le contrôle de concurrence à l'application est Meta lui-même : une FAQ supprimée entre-temps échoue en 404,
 * que `raisonLisible` traduit ; une relecture de plus laisserait la même fenêtre.
 */

/** Ce que l'assistant a besoin de savoir lire, sous-ensemble strict de `MbaClient`. */
export interface ClientMbaLecture {
  getSettings(p: string): Promise<unknown>;
  getBusinessInfo(p: string): Promise<unknown>;
  listFaqs(p: string): Promise<unknown[]>;
  listSkills(p: string, agentId: string): Promise<unknown[]>;
  listWebsites(p: string): Promise<unknown[]>;
  listFiles(p: string): Promise<unknown[]>;
}

/** `null` si la lecture échoue : l'appelant distingue « pas lu » de « vide ». */
async function ouNull<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch { return null; }
}

export async function lireInventaireMba(
  client: ClientMbaLecture,
  phoneNumberId: string,
  agentId: string,
): Promise<InventaireMba> {
  const [settings, businessInfo, faqs, skills, websites, files] = await Promise.all([
    ouNull(client.getSettings(phoneNumberId)),
    ouNull(client.getBusinessInfo(phoneNumberId)),
    ouNull(client.listFaqs(phoneNumberId)),
    ouNull(client.listSkills(phoneNumberId, agentId)),
    ouNull(client.listWebsites(phoneNumberId)),
    ouNull(client.listFiles(phoneNumberId)),
  ]);

  const completion = calculerCompletion({
    settings: settings as never,
    businessInfo: businessInfo as never,
    faqs: faqs as never,
    skills: skills as never,
    websites: websites as never,
    files: files as never,
  });

  /**
   * Le résumé est ce que le modèle voit, volontairement plat (des libellés) : les réponses brutes de l'API feraient
   * entrer des identifiants et des champs internes qu'il recopierait dans ses propositions.
   */
  const b = (businessInfo ?? {}) as Record<string, unknown>;
  return {
    completion,
    resume: {
      description: typeof b.business_description === 'string' ? b.business_description : '',
      faqs: ((faqs ?? []) as Array<Record<string, unknown>>)
        .map((f) => String(f.question ?? '')).filter((q) => q !== ''),
      competences: ((skills ?? []) as Array<Record<string, unknown>>)
        .map((s) => ({ nom: String(s.name ?? ''), etat: String(s.status ?? 'inconnu') })),
      sites: ((websites ?? []) as Array<Record<string, unknown>>)
        .map((w) => ({ url: String(w.url ?? ''), pages: Number(w.pages_crawled ?? 0) })),
      fichiers: ((files ?? []) as Array<Record<string, unknown>>)
        .map((f) => String(f.name ?? f.file_name ?? '')).filter((n) => n !== ''),
      enService: ((settings ?? {}) as { rollout?: { enabled?: boolean } }).rollout?.enabled === true,
    },
  };
}
