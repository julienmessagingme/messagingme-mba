import { calculerCompletion } from '../completion';
import type { InventaireMba } from './conversation';

/**
 * L'ÉTAT DE L'AGENT CHEZ META, LU EN UN PASSAGE.
 *
 * 🔴 SIX LECTURES, EN PARALLÈLE, ET CHACUNE PEUT ÉCHOUER SEULE. C'est pourquoi elles rendent `null` plutôt
 * que de lever : `calculerCompletion` distingue « pas lu » de « vide », et cette distinction porte tout.
 * Traiter un échec comme un tableau vide afficherait « FAQ à faire » sur un agent qui en a trente, et
 * enverrait le client en écrire une de plus.
 *
 * 🔴 ELLE EST LUE UNE FOIS À L'OUVERTURE, PUIS RELUE AVANT D'APPLIQUER (spec du 2026-09-14), jamais à chaque
 * tour : six appels chez Meta par phrase échangée rendraient la conversation lente et coûteuse, pour une
 * information qui ne bouge pas au rythme d'une phrase. La relecture avant application n'est pas une
 * optimisation, c'est le contrôle de concurrence : les onglets restent utilisables pendant la conversation.
 */

/** Ce que l'assistant a besoin de savoir lire. Sous-ensemble STRICT de `MbaClient`. */
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
   * ⚠️ LE RÉSUMÉ EST CE QUE LE MODÈLE VOIT, et il est volontairement PLAT : des libellés, pas des objets
   * Meta. Lui donner les réponses brutes de l'API ferait entrer des identifiants et des champs internes
   * dans le prompt, qu'il se mettrait à recopier dans ses propositions.
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
