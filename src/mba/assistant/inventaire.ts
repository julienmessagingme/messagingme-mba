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
 * 🔴 ELLE EST LUE À CHAQUE TOUR, ET CE TEXTE DISAIT L'INVERSE (corrigé par la revue globale du 2026-09-15).
 * Il annonçait « une fois à l'ouverture, puis relue avant d'appliquer, jamais à chaque tour » : les deux
 * moitiés étaient fausses. `POST /mba/assistant` l'appelle à chaque phrase, et `/appliquer` ne l'appelle pas
 * du tout. Une justification fausse inscrite à côté du code est pire qu'aucune, parce qu'elle sera recopiée.
 *
 * ⚠️ ET LE COMPORTEMENT RÉEL EST LE BON, c'est le texte qui était à reprendre. Les six lectures sont
 * PARALLÈLES, donc un aller-retour, sur un geste déclenché par un humain qui tape : la conversation voit
 * toujours l'état frais, ce dont elle a besoin puisque les onglets restent utilisables pendant qu'elle dure.
 *
 * 🔴 LE CONTRÔLE DE CONCURRENCE À L'APPLICATION N'EST PAS UNE RELECTURE, C'EST META LUI-MÊME. Si un autre
 * administrateur supprime la FAQ entre la proposition et le clic, l'écriture échoue chez Meta en 404 et
 * `raisonLisible` rend « Cet élément n'existe plus chez Meta : quelqu'un l'a peut-être supprimé entre-temps ».
 * Une relecture de plus juste avant n'ajouterait rien : elle laisserait la même fenêtre entre elle et l'appel.
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
