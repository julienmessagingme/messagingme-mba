import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Guard } from '../auth/middleware';
import { MbaClient, fusionnerBusinessInfo, modifierSettings } from '../mba/client';
import type { BusinessInfo, Faq, Skill } from '../mba/client';
import { extraireDepuisCsv, extraireDepuisHtml, extraireDepuisJson, normaliser, planifierImport } from '../mba/faq-import';
import type { FaqRow } from '../mba/faq-import';
import { normalizePhone } from '../crm/phone';
import { isSendableButtonUrl } from '../meta/button-url';
import { urlRecuperable } from '../lib/page-distante';
import type { PageDistante } from '../lib/page-distante';
import { espaceVerifie, nonEmpty } from './scope';
import { calculerCompletion } from '../mba/completion';
import { appliquerActivation, EtatMetaIllisible, MetaARefuse } from '../mba/activation';

/**
 * Configuration du Meta Business Agent depuis la console : base de connaissance (informations business, FAQ,
 * fichiers, sites), compétences, réglages, liste d'autorisation et bac à sable. Groupe admin (ces routes écrivent
 * la connaissance publique de la marque).
 * 🔴 La surface MBA est indexée par numéro : `phoneNumberBelongsToTenant` est ici le vrai contrôle d'isolation,
 * sans lui un admin piloterait l'agent du numéro d'un autre client en changeant l'id dans l'URL.
 */

export interface MbaRouteDeps {
  /**
   * L'historique des réglages (les fixtures qui ne l'observent pas passent `historiqueMuet`). 🔴 Chez Meta, une
   * suppression est définitive : la ligne écrite ici est le seul exemplaire du contenu effacé.
   */
  journaliserSuppression(tenantId: string, ligne: {
    element: 'faq' | 'competence' | 'site' | 'fichier';
    cible: string;
    libelle: string;
    avant: unknown;
    acteurId: string | null;
  }): Promise<void>;
  /** Client MBA du tenant (token résolu par tenant, repli global en sommeil). */
  clientFor(tenantId: string): Promise<MbaClient>;
  /**
   * Numéro Meta de l'espace, résolu côté serveur. `null` = aucun numéro connecté. C'est ce qui permet la route
   * d'activation, la seule de ce module qui ne reçoit pas le numéro du navigateur.
   */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Écrit notre drapeau `tenant_settings.mba_enabled`. */
  ecrireDrapeauMba(tenantId: string, enabled: boolean): Promise<void>;
  /** Le numéro appartient-il à ce tenant ? Contrôle d'isolation, en base. */
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  /** Récupère une page pour l'import de FAQ depuis une URL. Injecté pour rester testable sans réseau. */
  fetchUrl?(url: string): Promise<PageDistante>;
  /**
   * Les messages écrits par l'agent de Meta, depuis toujours (`PgStatsStore.messagesEcritsParMba`). Par espace et
   * non par numéro : `conversations` n'a pas de `phone_number_id`. Un espace à deux numéros verrait la somme.
   */
  messagesEcrits(tenantId: string): Promise<number>;
}

/** Au-delà, ce n'est plus un import de FAQ : Meta prévient qu'« a few hundred » dégrade déjà les réponses. */
const MAX_IMPORT = 500;

/**
 * Extensions acceptées par Meta (liste du schéma : `.txt` et `.md` en sont absents). Recopiée côté navigateur
 * (`web/lib/mba-files.ts`) ; `tests/web-mba-parity.test.ts` casse si les deux divergent.
 */
export const EXTENSIONS_FICHIER: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
/** `.jpeg` est la même chose que `.jpg` côté Meta ; on accepte les deux à l'écriture du nom. */
const EXTENSIONS_EQUIVALENTES: Record<string, string[]> = { jpg: ['jpg', 'jpeg'] };
/** Meta accepte 100 Mo. Le corps transite en base64 (+33 %) : on plafonne plus bas, avec un message explicite. */
export const MAX_FICHIER = 20 * 1024 * 1024;

const DATA_URL_RE = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i;
/** Titre de skill : minuscules, chiffres et tirets, sans tiret aux extrémités. Règle Meta, refusée en 400 sinon. */
export const TITRE_SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TITRE_SKILL_MAX = 64;
export const DESCRIPTION_SKILL_MAX = 1024;
export const CORPS_SKILL_MAX = 20000;

/**
 * Les quatre règles ci-dessous sont recopiées côté navigateur (`web/lib/mba-files.ts`, `web/lib/mba-skills.ts`)
 * pour refuser tout de suite ce que Meta refusera. En fonctions pures pour que `tests/web-mba-parity.test.ts`
 * pose la même table de cas aux deux implémentations.
 */

/** Le nom du fichier porte-t-il l'extension qui correspond à son type déclaré ? */
export function extensionCoherente(fileName: string, mime: string): boolean {
  const attendue = EXTENSIONS_FICHIER[mime.toLowerCase()];
  if (attendue === undefined) return false;
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  return (EXTENSIONS_EQUIVALENTES[attendue] ?? [attendue]).includes(ext);
}

export function tailleFichierOk(octets: number): boolean {
  return octets > 0 && octets <= MAX_FICHIER;
}

export function titreSkillValide(titre: string): boolean {
  return titre.length > 0 && titre.length <= TITRE_SKILL_MAX && TITRE_SKILL_RE.test(titre);
}

/** Contexte commun à toutes les routes : tenant vérifié, numéro vérifié, client prêt. null = déjà répondu. */
async function contexte(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: MbaRouteDeps,
): Promise<{ tenant: string; pn: string; client: MbaClient } | null> {
  const tenant = espaceVerifie(req);
  const { phoneNumberId } = req.params as { phoneNumberId: string };
  if (!(await deps.phoneNumberBelongsToTenant(phoneNumberId, tenant))) {
    await reply.code(404).send({ error: 'numéro inconnu pour ce tenant' });
    return null;
  }
  return { tenant, pn: phoneNumberId, client: await deps.clientFor(tenant) };
}

/**
 * Supprime un élément de l'agent de Meta (FAQ, compétence, site, fichier) et journalise ce qu'il contenait.
 * Le contenu est lu avant de supprimer, seule fenêtre où il existe encore (Meta ne rend plus un objet parti).
 * Au mieux : si la lecture de la liste échoue, on supprime quand même et on journalise l'identifiant seul. Le
 * journal vient après la suppression ; `libelle` et `champ` composent la ligne lisible (« FAQ : <question> »).
 */
async function supprimerAvecTrace(
  deps: MbaRouteDeps,
  tenant: string,
  acteurId: string | null,
  o: {
    element: 'faq' | 'competence' | 'site' | 'fichier';
    cible: string;
    libelle: string;
    champ: string;
    lister: () => Promise<ReadonlyArray<{ id?: string }>>;
    supprimer: () => Promise<unknown>;
  },
): Promise<void> {
  const avant = (await o.lister().catch(() => [])).find((x) => x.id === o.cible);
  await o.supprimer();
  await deps.journaliserSuppression(tenant, {
    element: o.element, cible: o.cible,
    libelle: `${o.libelle} : ${String((avant as Record<string, unknown> | undefined)?.[o.champ] ?? o.cible)}`,
    avant: avant ?? { id: o.cible }, acteurId,
  });
}

/**
 * `agent_id` de la configuration courante, lu à chaque fois. Les skills l'exigent explicitement : sans lui,
 * Meta écrit sous « les settings les plus récemment créés », donc potentiellement sous une configuration qui
 * n'est pas celle qu'on croit piloter. null = numéro pas encore onboardé côté Meta.
 */
async function agentIdDe(client: MbaClient, pn: string): Promise<string | null> {
  const s = await client.getSettings(pn);
  return typeof s?.agent_id === 'string' ? s.agent_id : null;
}

/** Chaîne bornée, ou undefined si absente. `null` (effacement explicite) est distingué de l'absence. */
function champTexte(v: unknown, max: number): { error: string } | { valeur: string | undefined } {
  if (v === undefined) return { valeur: undefined };
  if (v === null) return { valeur: '' };
  if (typeof v !== 'string') return { error: 'texte attendu' };
  if (v.length > max) return { error: `texte trop long (max ${max} caractères)` };
  return { valeur: v };
}

/** Extraction des Q/R d'un corps de requête : `items`, `csv` (texte collé ou fichier) ou `url`. */
async function extraire(
  corps: Record<string, unknown>,
  deps: MbaRouteDeps,
): Promise<{ error: string; code: number } | { lignes: FaqRow[]; source: string }> {
  if (Array.isArray(corps.items)) {
    return { lignes: extraireDepuisJson(corps.items), source: 'items' };
  }

  if (nonEmpty(corps.csv)) {
    return { lignes: extraireDepuisCsv(corps.csv), source: 'csv' };
  }

  if (nonEmpty(corps.url)) {
    if (!deps.fetchUrl) return { error: 'import depuis une URL indisponible', code: 503 };
    if (!urlRecuperable(corps.url)) return { error: 'URL invalide ou non autorisée (http(s) et hôte public attendus)', code: 400 };
    let page: PageDistante;
    try {
      page = await deps.fetchUrl(corps.url.trim());
    } catch (err) {
      return { error: `page injoignable : ${err instanceof Error ? err.message : 'erreur réseau'}`, code: 422 };
    }
    if (page.status >= 400) return { error: `la page a répondu HTTP ${page.status}`, code: 422 };
    const type = page.contentType.toLowerCase();
    if (type.includes('json')) {
      try {
        return { lignes: extraireDepuisJson(JSON.parse(page.body)), source: 'url (json)' };
      } catch {
        return { error: 'la page annonce du JSON mais il est illisible', code: 422 };
      }
    }
    if (type.includes('csv') || type.includes('plain')) return { lignes: extraireDepuisCsv(page.body), source: 'url (csv)' };
    return { lignes: extraireDepuisHtml(page.body), source: 'url (html)' };
  }

  return { error: 'source requise : items, csv ou url', code: 400 };
}

export function registerMba(app: FastifyInstance, deps: MbaRouteDeps, garde: Guard): void {
  const g = { preHandler: garde };
  const base = '/tenants/:tenantId/mba/:phoneNumberId';

  // ---------- État général ----------

  /**
   * « Où en est la configuration », en une lecture (sémantique de l'écran de Meta, « 4 of 5 tasks completed »).
   * Six lectures en `allSettled` : une route de Meta en erreur ne prive pas l'écran des autres. Un échec devient
   * `null`, que `calculerCompletion` traduit en « pas lu », jamais en « à faire ». Sans agent créé, les
   * compétences n'existent pas : `null` aussi.
   */
  app.get(`${base}/completion`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const settings = await ctx.client.getSettings(ctx.pn).catch(() => null);
    const agentId = typeof settings?.agent_id === 'string' ? settings.agent_id : null;
    const [bi, faqs, skills, sites, fichiers] = await Promise.all([
      ctx.client.getBusinessInfo(ctx.pn).catch(() => null),
      ctx.client.listFaqs(ctx.pn).catch(() => null),
      agentId ? ctx.client.listSkills(ctx.pn, agentId).catch(() => null) : Promise.resolve(null),
      ctx.client.listWebsites(ctx.pn).catch(() => null),
      ctx.client.listFiles(ctx.pn).catch(() => null),
    ]);
    return reply.code(200).send(calculerCompletion({
      settings, businessInfo: bi, faqs, skills, websites: sites, files: fichiers,
    }));
  });

  /**
   * Combien de messages l'agent de Meta a écrits, depuis toujours. `messages: null` quand on ne sait pas, jamais
   * 0 : un zéro affirmerait que l'agent n'a parlé à personne.
   */
  app.get(`${base}/messages`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    return reply.code(200).send({ messages: await deps.messagesEcrits(ctx.tenant) });
  });

  /**
   * Ce que l'écran affiche à l'ouverture : l'agent est-il ouvert par Meta sur ce numéro, et dans quel état.
   * `eligible` et `settings` sont lus séparément parce qu'ils échouent séparément : un numéro éligible mais
   * pas encore onboardé renvoie `settings: null`, ce qui n'est pas une erreur mais une étape.
   */
  app.get(`${base}/status`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const eligible = await ctx.client.isEligible(ctx.pn).catch(() => false);
    const settings = eligible ? await ctx.client.getSettings(ctx.pn).catch(() => null) : null;
    return reply.code(200).send({
      phoneNumberId: ctx.pn,
      eligible,
      onboarded: settings !== null,
      agentId: typeof settings?.agent_id === 'string' ? settings.agent_id : null,
      settings,
    });
  });

  /**
   * Réglages : seules les clés reconnues sont modifiables, le reste de l'objet est repassé tel quel par
   * `modifierSettings` (le PUT de Meta est un remplacement complet). L'allumage n'est pas ici : action à
   * conséquence asymétrique (éteindre coupe tous les fils, rallumer ne reprend que les nouveaux), elle a sa route.
   */
  app.patch(`${base}/settings`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (b.aiAudience !== undefined) {
      if (b.aiAudience !== 'EVERYONE' && b.aiAudience !== 'ALLOWLISTED_ONLY') {
        return reply.code(400).send({ error: "aiAudience invalide ('EVERYONE' | 'ALLOWLISTED_ONLY')" });
      }
      patch.ai_audience = b.aiAudience;
    }
    if (b.neverSay !== undefined) {
      if (!Array.isArray(b.neverSay) || !b.neverSay.every((p) => nonEmpty(p))) {
        return reply.code(400).send({ error: 'neverSay invalide (tableau de textes non vides)' });
      }
      patch.never_say_phrases = (b.neverSay as string[]).map((p) => p.trim());
    }
    if (b.followupEnabled !== undefined) {
      if (typeof b.followupEnabled !== 'boolean') return reply.code(400).send({ error: 'followupEnabled invalide (booléen)' });
      patch.followup = { enabled: b.followupEnabled };
    }
    // Passage de main. Les trois champs vont dans le même sous-objet : `modifierSettings` fusionne `handoff`
    // avec l'existant, donc n'envoyer qu'un champ ici ne détruit pas les deux autres.
    const handoff: Record<string, unknown> = {};
    if (b.handoffEnabled !== undefined) {
      if (typeof b.handoffEnabled !== 'boolean') return reply.code(400).send({ error: 'handoffEnabled invalide (booléen)' });
      handoff.enabled = b.handoffEnabled;
    }
    if (b.handoffMessage !== undefined) {
      if (!nonEmpty(b.handoffMessage)) return reply.code(400).send({ error: 'handoffMessage invalide (texte non vide)' });
      handoff.message = (b.handoffMessage as string).trim();
    }
    if (b.handoffMessageSelection !== undefined) {
      if (b.handoffMessageSelection !== 'DEFAULT' && b.handoffMessageSelection !== 'AGENT' && b.handoffMessageSelection !== 'CUSTOM') {
        return reply.code(400).send({ error: "handoffMessageSelection invalide ('DEFAULT' | 'AGENT' | 'CUSTOM')" });
      }
      // `CUSTOM` sans texte laisserait l'agent annoncer un transfert avec on ne sait quelle phrase. On exige le
      // texte dans le même appel plutôt que d'aller relire l'existant : la règle est prévisible.
      if (b.handoffMessageSelection === 'CUSTOM' && handoff.message === undefined) {
        return reply.code(400).send({ error: 'handoffMessage requis avec handoffMessageSelection CUSTOM' });
      }
      handoff.message_selection = b.handoffMessageSelection;
    }
    if (Object.keys(handoff).length > 0) patch.handoff = handoff;
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'aucun réglage à modifier' });

    await modifierSettings(ctx.client, ctx.pn, patch);
    return reply.code(200).send(await ctx.client.getSettings(ctx.pn));
  });

  /**
   * Allumage / extinction, route séparée. Meta documente l'asymétrie : `false` arrête l'agent sur toutes les
   * conversations, y compris en cours ; `true` ne le remet que sur les nouvelles. L'écran doit le dire avant.
   */
  app.put(`${base}/rollout`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const enabled = (req.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled requis (booléen)' });
    await modifierSettings(ctx.client, ctx.pn, { rollout: { enabled } });
    return reply.code(200).send(await ctx.client.getSettings(ctx.pn));
  });

  // ---------- Informations business ----------

  app.get(`${base}/business-info`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    return reply.code(200).send(await ctx.client.getBusinessInfo(ctx.pn));
  });

  /**
   * PATCH et non PUT, volontairement : côté Meta la ressource est en remplacement complet, et `fusionnerBusinessInfo`
   * relit l'existant avant d'écrire. L'écran n'envoie donc que ce qu'il modifie sans risquer d'effacer le reste.
   */
  app.patch(`${base}/business-info`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const champs: Array<[keyof BusinessInfo, string]> = [
      ['business_description', 'description'],
      ['payment_method', 'paymentMethod'],
      ['return_policy', 'returnPolicy'],
      ['purchase_info', 'purchaseInfo'],
      ['delivery_and_shipping', 'deliveryAndShipping'],
    ];
    const patch: BusinessInfo = {};
    for (const [cible, clef] of champs) {
      const r = champTexte(b[clef], 5000);
      if ('error' in r) return reply.code(400).send({ error: `${clef} : ${r.error}` });
      if (r.valeur !== undefined) (patch as Record<string, unknown>)[cible] = r.valeur;
    }

    const contact = b.contact;
    if (contact !== undefined) {
      if (typeof contact !== 'object' || contact === null || Array.isArray(contact)) {
        return reply.code(400).send({ error: 'contact invalide (objet attendu)' });
      }
      const c = contact as Record<string, unknown>;
      const sortie: Record<string, string> = {};
      for (const clef of ['email', 'hours_of_operation', 'address'] as const) {
        const r = champTexte(c[clef], 1000);
        if ('error' in r) return reply.code(400).send({ error: `contact.${clef} : ${r.error}` });
        if (r.valeur !== undefined) sortie[clef] = r.valeur;
      }
      patch.contact_info = sortie;
    }

    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'aucun champ à modifier' });
    return reply.code(200).send(await fusionnerBusinessInfo(ctx.client, ctx.pn, patch));
  });

  // ---------- FAQ ----------

  app.get(`${base}/faq`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const faqs = await ctx.client.listFaqs(ctx.pn);
    // Compteur remonté explicitement : Meta dégrade en silence au-delà de quelques centaines d'entrées, il
    // faut que l'écran puisse le montrer en permanence plutôt que de le découvrir dans la qualité des réponses.
    return reply.code(200).send({ faqs, count: Array.isArray(faqs) ? faqs.length : 0 });
  });

  /** Question et réponse sont toutes deux obligatoires, à la création comme à la modification (schéma Meta). */
  function lireFaq(body: unknown): { error: string } | { faq: Faq } {
    const b = (body ?? {}) as Record<string, unknown>;
    if (!nonEmpty(b.question)) return { error: 'question requise' };
    if (!nonEmpty(b.answer)) return { error: 'answer requise' };
    return { faq: { question: b.question.trim(), answer: b.answer.trim() } };
  }

  app.post(`${base}/faq`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const lu = lireFaq(req.body);
    if ('error' in lu) return reply.code(400).send({ error: lu.error });
    return reply.code(201).send(await ctx.client.createFaq(ctx.pn, lu.faq));
  });

  app.put(`${base}/faq/:faqId`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const lu = lireFaq(req.body);
    if ('error' in lu) return reply.code(400).send({ error: lu.error });
    const { faqId } = req.params as { faqId: string };
    return reply.code(200).send(await ctx.client.updateFaq(ctx.pn, faqId, lu.faq));
  });

  app.delete(`${base}/faq/:faqId`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const { faqId } = req.params as { faqId: string };
    await supprimerAvecTrace(deps, ctx.tenant, req.auth?.userId ?? null, {
      element: 'faq', cible: faqId, libelle: 'FAQ', champ: 'question',
      lister: () => ctx.client.listFaqs(ctx.pn),
      supprimer: () => ctx.client.deleteFaq(ctx.pn, faqId),
    });
    return reply.code(200).send({ deleted: faqId });
  });

  /**
   * Aperçu d'un import, sans aucune écriture chez Meta. Étape obligatoire : la FAQ n'a ni suppression en lot ni
   * corbeille, on montre donc d'abord ce qui serait créé, mis à jour et laissé tel quel.
   */
  app.post(`${base}/faq/preview`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const extrait = await extraire((req.body ?? {}) as Record<string, unknown>, deps);
    if ('error' in extrait) return reply.code(extrait.code).send({ error: extrait.error });
    const lignes = normaliser(extrait.lignes);
    if (lignes.length === 0) {
      return reply.code(422).send({ error: 'aucune paire question/réponse trouvée dans cette source', source: extrait.source });
    }
    if (lignes.length > MAX_IMPORT) {
      return reply.code(422).send({ error: `${lignes.length} questions trouvées, maximum ${MAX_IMPORT} par import`, source: extrait.source });
    }
    const plan = planifierImport(await ctx.client.listFaqs(ctx.pn), lignes);
    return reply.code(200).send({ source: extrait.source, total: lignes.length, ...plan });
  });

  /**
   * Applique l'import. Meta n'a pas de création en lot : N appels séquentiels (concurrence 1, le 429 est le risque
   * principal). Arrêt à la première erreur en rendant ce qui a été appliqué : le plan étant calculé par comparaison,
   * relancer reprend là où ça s'est arrêté.
   */
  app.post(`${base}/faq/import`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const extrait = await extraire((req.body ?? {}) as Record<string, unknown>, deps);
    if ('error' in extrait) return reply.code(extrait.code).send({ error: extrait.error });
    const lignes = normaliser(extrait.lignes);
    if (lignes.length === 0) return reply.code(422).send({ error: 'aucune paire question/réponse trouvée dans cette source' });
    if (lignes.length > MAX_IMPORT) {
      return reply.code(422).send({ error: `${lignes.length} questions trouvées, maximum ${MAX_IMPORT} par import` });
    }

    const plan = planifierImport(await ctx.client.listFaqs(ctx.pn), lignes);
    const cree: string[] = [];
    const misAJour: string[] = [];
    // Compté à part des identifiants : Meta n'est pas tenu de renvoyer un `id`, et une entrée bel et bien
    // créée dont l'id manque ne doit pas être recomptée comme « restant à faire » au prochain passage.
    let creees = 0;
    let echec: { question: string; error: string } | null = null;

    for (const f of plan.aCreer) {
      try {
        const r = await ctx.client.createFaq(ctx.pn, f);
        creees += 1;
        if (r.id !== undefined) cree.push(r.id);
      } catch (err) {
        echec = { question: f.question, error: err instanceof Error ? err.message : 'erreur inconnue' };
        break;
      }
    }
    if (!echec) {
      for (const f of plan.aMettreAJour) {
        try {
          await ctx.client.updateFaq(ctx.pn, f.id, f);
          misAJour.push(f.id);
        } catch (err) {
          echec = { question: f.question, error: err instanceof Error ? err.message : 'erreur inconnue' };
          break;
        }
      }
    }

    return reply.code(echec ? 207 : 200).send({
      source: extrait.source,
      created: creees,
      updated: misAJour.length,
      unchanged: plan.inchangees,
      remaining: plan.aCreer.length - creees + (plan.aMettreAJour.length - misAJour.length),
      ids: { created: cree, updated: misAJour },
      failed: echec,
    });
  });

  // ---------- Skills (personnalité et procédures, pas du tool calling) ----------

  app.get(`${base}/skills`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const agentId = await agentIdDe(ctx.client, ctx.pn);
    if (agentId === null) return reply.code(200).send({ skills: [], agentId: null });
    return reply.code(200).send({ skills: await ctx.client.listSkills(ctx.pn, agentId), agentId });
  });

  function lireSkill(body: unknown): { error: string } | { skill: Skill } {
    const b = (body ?? {}) as Record<string, unknown>;
    if (!nonEmpty(b.title)) return { error: 'title requis' };
    const title = b.title.trim().toLowerCase();
    if (title.length > TITRE_SKILL_MAX) return { error: `title trop long (max ${TITRE_SKILL_MAX} caractères)` };
    if (!titreSkillValide(title)) return { error: 'title invalide (minuscules, chiffres et tirets, ex. « politique-de-retour »)' };
    if (!nonEmpty(b.description)) return { error: 'description requise (elle dit QUAND appliquer la compétence)' };
    if (b.description.length > DESCRIPTION_SKILL_MAX) return { error: `description trop longue (max ${DESCRIPTION_SKILL_MAX} caractères)` };
    if (!nonEmpty(b.skill)) return { error: 'skill requis (les instructions elles-mêmes)' };
    if (b.skill.length > CORPS_SKILL_MAX) return { error: `skill trop long (max ${CORPS_SKILL_MAX} caractères)` };
    return { skill: { title, description: b.description.trim(), skill: b.skill.trim() } };
  }

  app.post(`${base}/skills`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const lu = lireSkill(req.body);
    if ('error' in lu) return reply.code(400).send({ error: lu.error });
    const agentId = await agentIdDe(ctx.client, ctx.pn);
    if (agentId === null) return reply.code(409).send({ error: "l'agent n'est pas encore configuré sur ce numéro" });
    return reply.code(201).send(await ctx.client.createSkill(ctx.pn, agentId, lu.skill));
  });

  app.put(`${base}/skills/:skillId`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const lu = lireSkill(req.body);
    if ('error' in lu) return reply.code(400).send({ error: lu.error });
    const { skillId } = req.params as { skillId: string };
    return reply.code(200).send(await ctx.client.updateSkill(ctx.pn, skillId, lu.skill));
  });

  app.delete(`${base}/skills/:skillId`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const { skillId } = req.params as { skillId: string };
    await supprimerAvecTrace(deps, ctx.tenant, req.auth?.userId ?? null, {
      element: 'competence', cible: skillId, libelle: 'Compétence', champ: 'name',
      lister: () => ctx.client.listSkills(ctx.pn, ctx.pn),
      supprimer: () => ctx.client.deleteSkill(ctx.pn, skillId),
    });
    return reply.code(200).send({ deleted: skillId });
  });

  // ---------- Sites web ----------

  app.get(`${base}/websites`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    return reply.code(200).send({ websites: await ctx.client.listWebsites(ctx.pn) });
  });

  /**
   * L'URL est validée ici : le schéma Meta est un simple `string`, et une adresse sans `https://` y part en 400
   * générique. Autant refuser en nommant le problème.
   */
  app.post(`${base}/websites`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const url = (req.body as { url?: unknown } | null)?.url;
    if (!nonEmpty(url) || !isSendableButtonUrl(url)) {
      return reply.code(400).send({ error: 'url invalide (adresse complète attendue, ex. https://www.exemple.fr)' });
    }
    return reply.code(201).send(await ctx.client.createWebsite(ctx.pn, url.trim()));
  });

  app.delete(`${base}/websites/:websiteId`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const { websiteId } = req.params as { websiteId: string };
    await supprimerAvecTrace(deps, ctx.tenant, req.auth?.userId ?? null, {
      element: 'site', cible: websiteId, libelle: 'Site', champ: 'url',
      lister: () => ctx.client.listWebsites(ctx.pn),
      supprimer: () => ctx.client.deleteWebsite(ctx.pn, websiteId),
    });
    return reply.code(200).send({ deleted: websiteId });
  });

  // ---------- Fichiers de connaissance ----------

  app.get(`${base}/files`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    return reply.code(200).send({ files: await ctx.client.listFiles(ctx.pn) });
  });

  /**
   * Upload d'un document (data URL base64, comme la route média). `file_name` est séparé du binaire côté Meta, et
   * rien ne garantit qu'il déduise le type : on impose une extension cohérente avec le type MIME déclaré, sinon
   * l'ingestion peut échouer en silence.
   */
  app.post(`${base}/files`, { ...g, bodyLimit: 28 * 1024 * 1024 }, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!nonEmpty(b.fileName)) return reply.code(400).send({ error: 'fileName requis' });
    if (!nonEmpty(b.dataUrl)) return reply.code(400).send({ error: 'dataUrl requis' });
    const m = DATA_URL_RE.exec(b.dataUrl);
    if (!m) return reply.code(400).send({ error: 'dataUrl invalide (data URL base64 attendue)' });

    const mime = (m[1] ?? '').toLowerCase();
    const attendue = EXTENSIONS_FICHIER[mime];
    if (attendue === undefined) {
      return reply.code(400).send({ error: 'format non accepté par Meta (pdf, doc, docx, png, jpg, csv, xlsx)' });
    }
    const nom = b.fileName.trim();
    if (!extensionCoherente(nom, mime)) {
      return reply.code(400).send({ error: `le nom du fichier doit finir par .${attendue} pour correspondre à son contenu` });
    }

    const octets = Buffer.from(m[2] ?? '', 'base64');
    if (octets.length === 0) return reply.code(400).send({ error: 'fichier vide' });
    if (!tailleFichierOk(octets.length)) {
      return reply.code(400).send({ error: `fichier trop lourd (max ${Math.round(MAX_FICHIER / 1024 / 1024)} Mo)` });
    }
    const cree = await ctx.client.uploadFile(ctx.pn, nom, new Blob([octets], { type: mime }));
    // Un 201 de Meta veut dire « fichier reçu », pas « contenu exploitable » : aucun champ n'expose
    // l'indexation. L'écran doit le dire au lieu de laisser croire que la connaissance est en place.
    return reply.code(201).send({ ...cree, indexationInconnue: true });
  });

  app.delete(`${base}/files/:fileId`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const { fileId } = req.params as { fileId: string };
    await supprimerAvecTrace(deps, ctx.tenant, req.auth?.userId ?? null, {
      element: 'fichier', cible: fileId, libelle: 'Document', champ: 'name',
      lister: () => ctx.client.listFiles(ctx.pn),
      supprimer: () => ctx.client.deleteFile(ctx.pn, fileId),
    });
    return reply.code(200).send({ deleted: fileId });
  });

  // ---------- Liste d'autorisation ----------

  app.get(`${base}/allowlist`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    return reply.code(200).send({ allowlist: await ctx.client.listAllowlist(ctx.pn) });
  });

  app.post(`${base}/allowlist`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const brut = (req.body as { phone?: unknown } | null)?.phone;
    if (!nonEmpty(brut)) return reply.code(400).send({ error: 'phone requis' });
    const { e164, error } = normalizePhone(brut);
    if (!e164) return reply.code(400).send({ error: error ?? 'numéro invalide' });
    // Déjà présent -> succès idempotent : le bouton « ajouter » ne doit pas échouer sur un doublon.
    const deja = await ctx.client.listAllowlist(ctx.pn);
    const connu = (Array.isArray(deja) ? deja : []).find((e) => normalizePhone(e.consumer_phone_number ?? '').e164 === e164);
    if (connu) return reply.code(200).send(connu);
    return reply.code(201).send(await ctx.client.addToAllowlist(ctx.pn, e164));
  });

  app.delete(`${base}/allowlist/:entryId`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const { entryId } = req.params as { entryId: string };
    await ctx.client.removeFromAllowlist(ctx.pn, entryId);
    return reply.code(200).send({ deleted: entryId });
  });

  // ---------- Bac à sable ----------

  /**
   * Joue un message contre l'agent sans destinataire réel et sans l'allumer. Meta écrit deux fois dans sa doc
   * que les jetons consommés ici ne sont pas facturés : c'est le seul moyen honnête de vérifier une
   * configuration avant de l'exposer à un client.
   */
  app.post(`${base}/test`, g, async (req, reply) => {
    const ctx = await contexte(req, reply, deps);
    if (!ctx) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!nonEmpty(b.message)) return reply.code(400).send({ error: 'message requis' });
    if (b.message.length > 4096) return reply.code(400).send({ error: 'message trop long (max 4096 caractères)' });
    const conversationId = nonEmpty(b.conversationId) ? b.conversationId : undefined;
    return reply.code(200).send(await ctx.client.test(ctx.pn, b.message.trim(), conversationId));
  });

  /**
   * Allumer ou éteindre l'agent de Meta en un appel, décidé côté serveur. `PUT .../rollout` exige que le navigateur
   * connaisse le numéro et l'éligibilité : ici il envoie une intention et reçoit ce qui a été fait. Le corps reste
   * `{ enabled }` : y ajouter `phoneNumberId` rouvrirait l'arbitrage côté navigateur.
   */
  app.put('/tenants/:tenantId/mba-activation', g, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = (req.body ?? {}) as { enabled?: unknown };
    if (typeof b.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled booléen requis' });
    const numeroDuTenant = deps.numeroDuTenant;
    const ecrireDrapeauMba = deps.ecrireDrapeauMba;
    try {
      const r = await appliquerActivation({
        numeroDuTenant: (t) => numeroDuTenant(t),
        eligible: async (t, pn) => (await deps.clientFor(t)).isEligible(pn),
        // `modifierSettings` relit puis n'écrit que `rollout` : un modèle typé fermé effacerait `never_say_phrases`,
        // `followup` et tout champ que Meta ajouterait.
        ecrireChezMeta: async (t, pn, enabled) => {
          await modifierSettings(await deps.clientFor(t), pn, { rollout: { enabled } });
        },
        ecrireDrapeau: (t, enabled) => ecrireDrapeauMba(t, enabled),
      }, tenant, b.enabled);
      return reply.code(200).send(r);
    } catch (err) {
      /**
       * 4xx, jamais 5xx (Cloudflare remplacerait le corps). Les deux cas se distinguent à l'écran : « on n'a pas pu
       * demander » se réessaie, « Meta a refusé » se diagnostique.
       */
      if (err instanceof EtatMetaIllisible) {
        // eslint-disable-next-line no-console
        console.error(`mba-activation: état illisible (${tenant}):`, err.message);
        return reply.code(409).send({ error: 'L’état de l’agent chez Meta n’a pas pu être lu. Rien n’a été changé, réessayez dans un instant.' });
      }
      if (err instanceof MetaARefuse) {
        // eslint-disable-next-line no-console
        console.error(`mba-activation: Meta a refusé (${tenant}):`, err.message);
        return reply.code(409).send({ error: 'Meta a refusé de changer l’état de l’agent. Rien n’a été changé de notre côté.' });
      }
      throw err;
    }
  });
}
