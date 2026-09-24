import type { Page, Route } from '@playwright/test';

/**
 * Harnais des E2E de la configuration MBA : session admin posée AVANT tout script (sinon `AppShell` redirige
 * vers /login), puis interception de `/api/backend/**` avec des fixtures. Aucun backend ni base n'est requis,
 * comme pour les E2E d'accueil et de paramètres.
 *
 * Chaque appel intercepté est enregistré dans `calls` : c'est ce qui permet de vérifier ce que l'écran ENVOIE
 * (le corps exact d'un PATCH, l'absence d'un appel qui ne devrait pas partir), et pas seulement ce qu'il rend.
 */

export const TENANT = 't-e2e';
export const PN = 'PN1';
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: TENANT };

export interface Appel {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

export interface MbaFixtures {
  /** Compte : `hasNumber:false` pour tester l'écran sans numéro. */
  account?: Record<string, unknown>;
  /** `GET .../mba/:pn/status`. */
  status?: Record<string, unknown>;
  /** Réglages TENANT (`GET .../settings`) : passage de main, délai de reprise, horaires. */
  reglagesTenant?: Record<string, unknown>;
  businessInfo?: Record<string, unknown>;
  faqs?: Array<Record<string, unknown>>;
  skills?: Array<Record<string, unknown>>;
  agentId?: string | null;
  websites?: Array<Record<string, unknown>>;
  files?: Array<Record<string, unknown>>;
  /**
   * Le fil de l assistant. Par defaut : VIDE, avec son message d accueil.
   *
   * Sans cette route, la fixture retombait sur son `json({})` final et le panneau tombait sur
   * `f.messages.length` : c est pour cette raison que l onglet Assistant n avait aucun test d interface.
   */
  assistant?: { messages?: unknown[]; accueil?: string | null; total?: number; budgetEpuise?: boolean };
  allowlist?: Array<Record<string, unknown>>;
  preview?: Record<string, unknown>;
  importResult?: Record<string, unknown>;
  testReply?: Record<string, unknown>;
  /** Court-circuite le routage par défaut. Rendre `true` si l'appel a été traité. */
  custom?: (route: Route, method: string, url: string, body: Record<string, unknown> | null) => Promise<boolean>;
}

const compteParDefaut = {
  hasNumber: true,
  phoneNumberId: PN,
  number: '+33 5 25 68 03 01',
  // ⚠️ `verifiedName` NOURRIT LE TITRE DE L'EN-TÊTE de l'écran de réglage. Sans lui, les six suites MBA
  // liraient le titre de repli (« Paramètres du Meta Business Agent »), donc aucune ne verrait l'agent nommé.
  verifiedName: 'Boutique Test',
  quality: 'GREEN',
  numberStatus: 'CONNECTED',
  hubspotConnected: false,
  hubspotPausedAt: null,
  hubspotPortal: { connected: false },
  status: { dot: 'green', label: 'Compte opérationnel', reason: 'Numéro connecté.' },
};

const statutParDefaut = {
  phoneNumberId: PN,
  eligible: true,
  onboarded: true,
  agentId: 'AG1',
  settings: { agent_id: 'AG1', channel: 'whatsapp', rollout: { enabled: false }, ai_audience: 'EVERYONE', never_say_phrases: [], followup: { enabled: false } },
};

export async function mockMba(page: Page, f: MbaFixtures = {}): Promise<Appel[]> {
  const calls: Appel[] = [];
  // Collections MUTABLES : un POST ajoute, un DELETE retire. Un faux backend qui rendrait toujours la même
  // liste rendrait invérifiable tout ce qui se passe APRÈS une écriture (l'écran relit-il ? affiche-t-il la
  // nouvelle entrée ?), et un test écrit contre un tel faux prouverait moins qu'il n'en a l'air.
  const collections: Record<string, Array<Record<string, unknown>>> = {
    faq: [...(f.faqs ?? [])],
    skills: [...(f.skills ?? [])],
    websites: [...(f.websites ?? [])],
    files: [...(f.files ?? [])],
    allowlist: [...(f.allowlist ?? [])],
  };
  /** Applique l'écriture à la collection et rend l'entité créée ou modifiée. */
  const ecrire = (nom: string, method: string, url: string, entree: Record<string, unknown>): Record<string, unknown> => {
    const liste = collections[nom] as Array<Record<string, unknown>>;
    const id = url.split('?')[0]!.split('/').pop() ?? '';
    if (method === 'DELETE') {
      const i = liste.findIndex((e) => e.id === id);
      if (i >= 0) liste.splice(i, 1);
      return { deleted: id };
    }
    if (method === 'PUT') {
      const i = liste.findIndex((e) => e.id === id);
      const maj = { ...(liste[i] ?? {}), ...entree, id };
      if (i >= 0) liste[i] = maj; else liste.push(maj);
      return maj;
    }
    liste.push(entree);
    return entree;
  };
  // Réglages et informations business MUTABLES, pour la même raison que les collections : sans état, un écran
  // qui n'affiche jamais le résultat de ce qu'il vient d'écrire passerait tous les tests.
  // `settings: null` explicite (numéro pas encore onboardé) doit être RESPECTÉ : c'est un état réel de l'API.
  let settings: Record<string, unknown> | null = f.status && 'settings' in f.status
    ? (f.status.settings as Record<string, unknown> | null)
    : { ...statutParDefaut.settings };
  const businessInfo: Record<string, unknown> = { ...(f.businessInfo ?? {}) };
  const reglagesTenant: Record<string, unknown> = {
    mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false,
    controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {},
    ...f.reglagesTenant,
  };

  /** Applique un PATCH de réglages du VOCABULAIRE DE LA CONSOLE vers celui de Meta, comme le vrai serveur. */
  const appliquerSettings = (patch: Record<string, unknown>): Record<string, unknown> => {
    const courant: Record<string, unknown> = { ...(settings ?? { agent_id: 'AG1', channel: 'whatsapp' }) };
    if (patch.aiAudience !== undefined) courant.ai_audience = patch.aiAudience;
    if (patch.neverSay !== undefined) courant.never_say_phrases = patch.neverSay;
    if (patch.followupEnabled !== undefined) courant.followup = { ...(courant.followup as object ?? {}), enabled: patch.followupEnabled };
    if (patch.enabled !== undefined) courant.rollout = { ...(courant.rollout as object ?? {}), enabled: patch.enabled };
    settings = courant;
    return courant;
  };

  /** Fusion du patch à plat vers la forme imbriquée de Meta, comme `fusionnerBusinessInfo` côté serveur. */
  const appliquerBusinessInfo = (patch: Record<string, unknown>): Record<string, unknown> => {
    const champs: Record<string, string> = {
      description: 'business_description', paymentMethod: 'payment_method', returnPolicy: 'return_policy',
      purchaseInfo: 'purchase_info', deliveryAndShipping: 'delivery_and_shipping',
    };
    for (const [depuis, vers] of Object.entries(champs)) if (patch[depuis] !== undefined) businessInfo[vers] = patch[depuis];
    if (patch.contact !== undefined) {
      businessInfo.contact_info = { ...(businessInfo.contact_info as object ?? {}), ...(patch.contact as object) };
    }
    return businessInfo;
  };

  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);

  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();
    let body: Record<string, unknown> | null = null;
    try { body = (req.postDataJSON() ?? null) as Record<string, unknown> | null; } catch { body = null; }
    calls.push({ method, url, body });

    const json = (b: unknown, status = 200): Promise<void> =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });

    if (f.custom && (await f.custom(route, method, url, body))) return;

    if (url.includes('/account-status')) return json({ ...compteParDefaut, ...f.account });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });

    // --- Surface MBA, par ressource. Les chemins les plus longs d'abord.
    if (url.includes('/mba/')) {
      if (url.includes('/faq/preview')) return json(f.preview ?? { source: 'csv', total: 0, aCreer: [], aMettreAJour: [], inchangees: 0 });
      if (url.includes('/faq/import')) {
        const res = f.importResult ?? { source: 'csv', created: 0, updated: 0, unchanged: 0, remaining: 0, ids: { created: [], updated: [] }, failed: null };
        // 207 = import interrompu. Le front doit le lire comme un succès HTTP et regarder `failed`.
        return json(res, (res as { failed?: unknown }).failed ? 207 : 200);
      }
      // ⚠️ AVANT LES BRANCHES COURTES. Le routage se fait par `includes` et non par égalité : une branche
      // courte posée plus haut attraperait un chemin plus long qui la contient.
      // AVANT `/messages` : le chemin de l assistant ne le contient pas, mais l ordre de ce bloc est
      // explicitement par longueur decroissante, et une branche d assistant ajoutee plus bas passerait
      // apres `/status` qui, lui, est un prefixe de rien mais teste par `includes`.
      if (url.includes('/mba/assistant')) {
        const a = f.assistant ?? {};
        return json({
          messages: a.messages ?? [],
          accueil: a.accueil === undefined ? 'Dites-moi ce que vous voulez regler.' : a.accueil,
          total: a.total ?? (a.messages ?? []).length,
          budgetEpuise: a.budgetEpuise ?? false,
        });
      }
      if (url.includes('/messages')) return json({ messages: 412, jours: 30 });
      if (url.includes('/completion')) {
        // 🔴 UNE OBLIGATOIRE EN `inconnue` EST DANS LA FIXTURE EXPRÈS : sans elle, aucun test ne voit la
        // liste grise des signalements, et c'est exactement comme ça qu'elle a pu disparaître de l'écran
        // sans que rien ne crie (revue finale du 2026-09-23). Elle porte ici sa VRAIE cause, une lecture qui
        // a échoué chez Meta ; le moyen de paiement tenait ce rôle jusqu'au 2026-09-24, il n'est plus une
        // tâche du tout. `connecteurs` y est aussi : `inconnue` mais FACULTATIF, donc l'en-tête ne doit PAS
        // l'afficher.
        return json({
          taches: [
            { cle: 'business_info', requise: true, etat: 'faite' },
            { cle: 'faq', requise: true, etat: 'a_faire', raison: 'Aucune question enregistrée.' },
            { cle: 'competences', requise: true, etat: 'inconnue', raison: 'Lecture impossible chez Meta pour l’instant.' },
            { cle: 'connecteurs', requise: false, etat: 'inconnue', raison: 'Pas encore piloté depuis Engage Me.' },
          ],
          faites: 1, total: 2, indeterminees: 1,
        });
      }
      if (url.includes('/status')) return json({ ...statutParDefaut, ...f.status, settings });
      if (url.includes('/business-info')) {
        return json(method === 'GET' ? businessInfo : appliquerBusinessInfo(body ?? {}));
      }
      if (url.includes('/rollout') || url.endsWith('/settings')) return json(appliquerSettings(body ?? {}));
      if (url.includes('/skills')) {
        if (method === 'GET') return json({ skills: collections.skills, agentId: f.agentId === undefined ? 'AG1' : f.agentId });
        return json(ecrire('skills', method, url, { id: 's-neuf', ...(body ?? {}) }), method === 'POST' ? 201 : 200);
      }
      if (url.includes('/faq')) {
        if (method === 'GET') return json({ faqs: collections.faq, count: (collections.faq as unknown[]).length });
        return json(ecrire('faq', method, url, { id: 'f-neuf', ...(body ?? {}) }), method === 'POST' ? 201 : 200);
      }
      if (url.includes('/websites')) {
        if (method === 'GET') return json({ websites: collections.websites });
        return json(ecrire('websites', method, url, { id: 'w-neuf', ...(body ?? {}) }), method === 'POST' ? 201 : 200);
      }
      if (url.includes('/files')) {
        if (method === 'GET') return json({ files: collections.files });
        return json(ecrire('files', method, url, { id: 'file-neuf', file_name: (body ?? {}).fileName, indexationInconnue: true }), method === 'POST' ? 201 : 200);
      }
      if (url.includes('/allowlist')) {
        if (method === 'GET') return json({ allowlist: collections.allowlist });
        return json(ecrire('allowlist', method, url, { id: 'a-neuf', consumer_phone_number: (body ?? {}).phone }), method === 'POST' ? 201 : 200);
      }
      if (url.includes('/test')) return json(f.testReply ?? { agent_response: 'Bonjour, comment puis-je aider ?', conversation_id: 'conv-1' });
    }

    // Réglages TENANT (hors surface MBA). L'écran Activation les lit ET les écrit : ils sont donc mutables
    // ici aussi, sinon un écran qui n'affiche jamais ce qu'il vient d'enregistrer passerait le test.
    if (url.includes('/settings/mba-handoff')) {
      reglagesTenant.mbaHandoffMode = ((body ?? {}).mode ?? null) as string | null;
      return json({ mbaHandoffMode: reglagesTenant.mbaHandoffMode, appliqueChezMeta: true });
    }
    if (url.includes('/settings/control-handback')) {
      reglagesTenant.controlHandbackSeconds = ((body ?? {}).seconds ?? null) as number | null;
      return json({ controlHandbackSeconds: reglagesTenant.controlHandbackSeconds });
    }
    if (url.includes('/settings')) return json(reglagesTenant);
    return json({});
  });

  return calls;
}

/** Appels MBA d'une méthode donnée dont l'URL contient `fragment`. */
export function appelsMba(calls: Appel[], method: string, fragment: string): Appel[] {
  return calls.filter((c) => c.method === method && c.url.includes('/mba/') && c.url.includes(fragment));
}
