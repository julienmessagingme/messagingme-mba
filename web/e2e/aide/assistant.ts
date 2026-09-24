import type { Page, Route } from '@playwright/test';

/**
 * LE FAUX BACKEND DE L'ASSISTANT DE CAMPAGNE, en un seul exemplaire.
 *
 * 🔴 IL EXISTE PARCE QUE ONZE SPÉCIFICATIONS ONT DÛ CHANGER D'ÉCRAN LE MÊME JOUR. L'ancien formulaire a
 * été retiré le 2026-09-13, et chacune de ces spécifications portait sa propre copie du même faux
 * serveur : onze harnais à retoucher pour un seul déménagement. Il n'y en a plus qu'un.
 *
 * 🔴 IL GARDE UN ÉTAT MUTABLE POUR LES BROUILLONS, ET CE N'EST PAS UN LUXE. Un faux plus PAUVRE que le
 * vrai rend vertes des choses qui ne marchent pas : un faux qui ne garderait que le nom d'un brouillon ne
 * pourrait pas voir que tout le reste de l'écran se perd, ce qui est exactement le défaut signalé par
 * Julien le 2026-09-08.
 *
 * ⚠️ LES CORPS DE REQUÊTE SONT COLLECTÉS (`creations`, `lancements`, `ecritures`) parce que c'est la
 * SEULE chose qui prouve quoi que ce soit : un écran peut afficher des cases, les cocher, compter juste,
 * et n'en rien envoyer. Le lot 7 a trouvé exactement ça.
 */

export const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

export interface Brouillon {
  id: string;
  name: string;
  state: Record<string, unknown>;
  updatedAt: string;
}

export interface Appel {
  method: string;
  url: string;
  body: unknown;
}

export interface Faux {
  /** Les corps des POST /campaigns, dans l'ordre. C'est CE QUI PART. */
  creations: Array<Record<string, unknown>>;
  /** Les lancements : l'identifiant visé, et le corps (qui porte `scheduledAt` sur une programmation). */
  lancements: Array<{ id: string; body: unknown }>;
  /** Les brouillons, état MUTABLE : le faux garde ce qu'on lui écrit. */
  brouillons: Brouillon[];
  /** Tous les appels, pour les cas qui comptent les requêtes (dédoublonnage, sondage). */
  appels: Appel[];
}

export interface Options {
  templates?: unknown[];
  workflows?: unknown[];
  /** Le graphe rendu par `GET /workflows/:id`. */
  graphe?: unknown;
  emailTemplates?: unknown[];
  users?: unknown[];
  agents?: unknown[];
  tags?: unknown[];
  userFields?: unknown[];
  phoneNumbers?: unknown[];
  rcsAgents?: unknown[];
  rcsMessages?: unknown[];
  webhooks?: unknown[];
  contacts?: unknown[];
  /** Le total rendu par `/contacts/count`. Les comptes du récapitulatif le lisent aussi. */
  total?: number;
  /** Les indices d'un modèle (`param-hints`). */
  hints?: unknown[];
  settings?: Record<string, unknown>;
  /** Ce que rend la CRÉATION d'une campagne. Sert aux cas « zéro destinataire » et « avertissement ». */
  creation?: Record<string, unknown>;
  /** Les brouillons déjà en base à l'ouverture. */
  brouillons?: Brouillon[];
  /**
   * Latence simulée sur la CRÉATION d'un brouillon.
   *
   * ⚠️ ELLE SERT À REPRODUIRE LE CAS DE COURSE : une seconde sauvegarde qui part pendant que la première
   * est encore en vol. Sans latence, un faux répond trop vite pour l'exposer, et le test passerait sur une
   * implémentation qui créerait deux brouillons.
   */
  delaiCreationBrouillonMs?: number;
}

const TEMPLATES_DEFAUT = [
  { id: 't1', name: 'promo', language: 'fr', status: 'APPROVED', category: 'MARKETING', body: 'Bonjour', isCarousel: false },
];
const CONTACTS_DEFAUT = [
  { id: 'c1', phoneE164: '+33600000001', profileName: 'Alice', tags: [], fields: {}, optInStatus: 'opted_in' },
  { id: 'c2', phoneE164: '+33600000002', profileName: 'Bob', tags: [], fields: {}, optInStatus: 'opted_in' },
  { id: 'c3', phoneE164: '+33600000003', profileName: 'Chloe', tags: [], fields: {}, optInStatus: 'opted_in' },
];

/** Pose le faux backend. À appeler AVANT `ouvrirAssistant`. */
export async function poserFaux(page: Page, o: Options = {}): Promise<Faux> {
  const faux: Faux = {
    creations: [],
    lancements: [],
    brouillons: o.brouillons ? [...o.brouillons] : [],
    appels: [],
  };
  let n = faux.brouillons.length;
  /**
   * 🔴 COLLECTION MUTABLE : un POST ajoute, donc le GET suivant rend le message neuf.
   *
   * Sans ça, la création d'un message RCS à la volée serait INVÉRIFIABLE : elle RETROUVE le message par
   * DIFFÉRENCE entre deux lectures de la bibliothèque, et un faux serveur qui rend toujours la même liste
   * ferait échouer cette recherche pour une raison qui n'existe qu'en test. C'est la même décision que la
   * fixture des outils de l'agent de Meta, et pour la même raison : un faux immuable rend invérifiable tout
   * ce qui se passe APRÈS une écriture.
   */
  const messagesRcs: unknown[] = [...(o.rcsMessages ?? [])];

  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const chemin = new URL(url).pathname.replace('/api/backend', '');
    const method = req.method();
    let body: unknown = null;
    try { body = req.postDataJSON() ?? null; } catch { body = null; }
    faux.appels.push({ method, url, body });
    const json = (b: unknown, status = 200): Promise<void> =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });

    // --- Brouillons de composition, avec état mutable ---
    if (chemin.includes('/campaign-drafts')) {
      if (method === 'GET') return json({ drafts: faux.brouillons });
      if (method === 'POST') {
        if (o.delaiCreationBrouillonMs) await new Promise((r) => setTimeout(r, o.delaiCreationBrouillonMs));
        n += 1;
        const d: Brouillon = {
          id: `d${n}`,
          name: String((body as { name?: string })?.name ?? ''),
          state: ((body as { state?: Record<string, unknown> })?.state ?? {}),
          updatedAt: '2026-09-13T10:00:00.000Z',
        };
        faux.brouillons.push(d);
        return json({ draft: d }, 201);
      }
      if (method === 'PUT') {
        const id = chemin.split('/').pop()!;
        const d = faux.brouillons.find((x) => x.id === id);
        // 🔴 L'ÉTAT AUSSI, PAS SEULEMENT LE NOM : un faux qui ne garderait que le nom ne pourrait pas voir
        // que tout le reste de l'écran se perd, et c'est précisément le défaut qu'on garde ici.
        if (d) {
          d.name = String((body as { name?: string })?.name ?? d.name);
          d.state = ((body as { state?: Record<string, unknown> })?.state ?? d.state);
        }
        return json({ updated: true });
      }
      if (method === 'DELETE') {
        const id = chemin.split('/').pop()!;
        faux.brouillons = faux.brouillons.filter((x) => x.id !== id);
        return json({ deleted: true });
      }
    }

    // --- Création et lancement ---
    if (method === 'POST' && /\/campaigns$/.test(chemin)) {
      faux.creations.push((body ?? {}) as Record<string, unknown>);
      return json({ campaignId: 'camp-1', recipientCount: 3, skipped: [], ...(o.creation ?? {}) }, 201);
    }
    if (method === 'POST' && /\/campaigns\/[^/]+\/run$/.test(chemin)) {
      const id = chemin.split('/')[2]!;
      faux.lancements.push({ id, body });
      return json({ enqueued: true });
    }

    // --- Référentiels ---
    if (chemin.endsWith('/settings')) {
      return json({
        controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: true, rcsEnabled: true,
        hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true,
        timezone: 'Europe/Paris', businessHours: {},
        ...(o.settings ?? {}),
      });
    }
    if (chemin.includes('/param-hints')) return json({ hints: o.hints ?? [] });
    if (chemin.endsWith('/email-templates')) return json({ templates: o.emailTemplates ?? [] });
    if (chemin.endsWith('/templates')) return json({ templates: o.templates ?? TEMPLATES_DEFAUT });
    if (/\/workflows\/[^/]+$/.test(chemin)) return json({ workflow: { id: 'wf1', name: 'Scénario', graph: o.graphe ?? null } });
    if (chemin.endsWith('/workflows')) return json({ workflows: o.workflows ?? [] });
    if (chemin.endsWith('/users')) return json({ users: o.users ?? [{ id: 'u1', email: 'alice@e2e.test', name: 'Alice', role: 'admin', disabled: false, pending: false }] });
    if (chemin.endsWith('/agents')) return json({ agents: o.agents ?? [] });
    if (chemin.endsWith('/tags')) return json({ tags: o.tags ?? [] });
    if (chemin.includes('/user-fields')) return json({ fields: o.userFields ?? [] });
    if (chemin.includes('/phone-numbers')) return json({ phoneNumbers: o.phoneNumbers ?? [{ id: 'pn1', displayPhoneNumber: '+33525680250', verifiedName: 'Demo' }] });
    if (chemin.endsWith('/rcs-agents')) return json({ agents: o.rcsAgents ?? [{ agentId: 'ag1', brandName: 'Ma marque', status: 'launched' }] });
    if (chemin.endsWith('/rcs-messages')) {
      if (method === 'POST') {
        const b = (body ?? {}) as { name?: string; content?: unknown };
        const neuf = { id: `m-neuf-${messagesRcs.length + 1}`, name: b.name ?? '', content: b.content ?? null, createdAt: '', updatedAt: '' };
        messagesRcs.push(neuf);
        return json({ message: neuf }, 201);
      }
      return json({ messages: messagesRcs });
    }
    if (chemin.includes('/webhooks')) return json({ webhooks: o.webhooks ?? [] });
    if (chemin.includes('/contacts/count')) return json({ total: o.total ?? (o.contacts ?? CONTACTS_DEFAUT).length });
    if (chemin.includes('/contacts')) return json({ contacts: o.contacts ?? CONTACTS_DEFAUT });
    if (chemin.includes('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    if (chemin.endsWith('/campaigns')) return json({ campaigns: [] });
    return json({});
  });
  return faux;
}

export interface Ouverture {
  /** L'étape d'ouverture (`?etape=`). Défaut : `nom`. */
  etape?: 'nom' | 'canal' | 'contenu' | 'audience' | 'recap';
  /** La formule de canal d'ouverture (`?canal=`), pour atteindre une chaîne sans repasser par l'étape 2. */
  canal?: 'whatsapp' | 'rcs' | 'repli';
  troisieme?: 'aucun' | 'email';
  /** L'identifiant d'un brouillon à reprendre (`?brouillon=`). */
  brouillon?: string;
}

/** Ouvre l'assistant à l'étape voulue. `poserFaux` doit avoir été appelé avant. */
export async function ouvrirAssistant(page: Page, o: Ouverture = {}): Promise<void> {
  const q = new URLSearchParams({
    ...(o.etape ? { etape: o.etape } : {}),
    ...(o.canal ? { canal: o.canal } : {}),
    ...(o.troisieme ? { troisieme: o.troisieme } : {}),
    ...(o.brouillon ? { brouillon: o.brouillon } : {}),
  });
  const suffixe = q.toString();
  await page.goto(`/campaigns/nouvelle${suffixe ? `?${suffixe}` : ''}`);
}
