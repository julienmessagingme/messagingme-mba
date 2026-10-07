import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { MetaTemplateClient, CreateTemplateInput, TemplateButton, CarouselCard, TemplateHeader, TemplateSummary } from '../meta/templates';
import type { CampaignStatus } from '../campaign/types';
import { parseParamHints, countTemplateVariables } from '../crm/template';
import type { ParamSource } from '../crm/template';
import { isValidTemplateLanguage } from '../meta/languages';
import { isSendableButtonUrl } from '../meta/button-url';
import { boutonsTracables, appliquerLiens, cleBouton, codeDuLienTrace, rehabillerBoutons } from '../links/rewrite';
import { analyserChampsUrl, porteDesChamps, refusChampsUrl } from '../links/champs-url';
import type { CibleLien, LienTrace } from '../links/tracked-links.pg';
import { espaceVerifie, nonEmpty } from './scope';
import { messageDe } from '../lib/erreur';

export interface TemplateRouteDeps {
  meta: {
    /** Client templates Meta résolu par espace (token de l'espace, repli global en sommeil). */
    templateClientForTenant(tenantId: string): Promise<MetaTemplateClient>;
  };
  repo: {
    /** WABA du tenant (les templates sont au niveau WABA). */
    getTenantWabaId(tenantId: string): Promise<string | null>;
    /** Garde-fou : campagnes actives (draft/running/paused) référençant ce template (name, langue optionnelle). */
    listActiveCampaignsForTemplate(
      tenantId: string,
      templateName: string,
      templateLanguage?: string,
    ): Promise<Array<{ id: string; name: string; status: CampaignStatus; templateLanguage: string }>>;
  };
  /** Pré-check « ce flowId est-il PUBLISHED pour ce tenant ? » avant d'appeler Meta. */
  getPublishedFlow(tenantId: string, flowId: string): Promise<boolean>;
  /** Indices « variable -> champ » posés au design (sélecteur de champ) : persistés pour pré-remplir la
   *  campagne. Best-effort : un échec n'empêche pas le template de se créer. */
  indices: {
    save(tenantId: string, name: string, language: string, hints: Array<{ position: number; source: ParamSource }>): Promise<void>;
    get(tenantId: string, name: string, language: string): Promise<Array<{ position: number; source: ParamSource }>>;
    removeByName(tenantId: string, name: string): Promise<void>;
  };
  /**
   * Les clés des champs de contact déclarés de l'espace : un bouton « Lien » ne peut porter que ceux-là (et les champs
   * de base `CLES_DE_BASE_URL`). Lue seulement quand une adresse de bouton porte un champ `{cle}`.
   */
  champsDeclares(tenantId: string): Promise<string[]>;
  /**
   * Traçage des liens : réserve un code par bouton URL et rend l'adresse de redirection à soumettre à Meta. Son échec
   * laisse partir le template avec les liens saisis : on ne soumet jamais une adresse qu'on ne saurait pas servir.
   * Sauf pour un bouton à champs, qui ne se remplit qu'à notre redirection : son échec REFUSE la soumission.
   */
  tracking: {
    /** Réserve le code du bouton et enregistre sa destination. Rend le code. `avecJeton` décide si l'URL
     *  soumise portera le suffixe variable, et donc si l'envoi devra fournir un composant de bouton. */
    allocate(tenantId: string, cible: CibleLien, destination: string, avecJeton: boolean): Promise<string>;
    liens: {
      /** Meta a accepté : ces liens sont bien ceux que porte le template. */
      confirm(tenantId: string, codes: readonly string[]): Promise<void>;
      /** Ces liens ne sont plus dans le template chez Meta : l'envoi et les mesures cessent de les voir. */
      deconfirmer(tenantId: string, codes: readonly string[]): Promise<void>;
      /** Les liens CONFIRMÉS de ces templates (toutes langues), pour remettre en l'état ce que Meta a refusé. */
      listByTemplates(tenantId: string, noms: readonly string[]): Promise<LienTrace[]>;
    };
    /** Adresse publique d'un code, avec ou sans son suffixe variable. */
    lienDe(code: string, avecJeton: boolean): string;
    /** `adresse de redirection -> destination d'origine`, pour ces templates. Sert au ré-habillage. */
    destinations(tenantId: string, noms: readonly string[]): Promise<Map<string, string>>;
  };
}

/** Persistance best-effort des indices variable->champ : un hoquet DB ne doit pas faire échouer un template
*  déjà créé chez Meta (la propagation se dégrade juste : la campagne ne pré-remplira pas). */
async function saveHintsSafe(deps: TemplateRouteDeps, tenant: string, name: string, language: string, raw: unknown): Promise<void> {
  // Clé absente (undefined) = « ne touche pas aux indices » : un PATCH qui ne concerne pas les variables ne doit
  // pas effacer les indices existants. Seul un tableau explicite (même vide) remplace.
  if (raw === undefined) return;
  const hints = parseParamHints(raw);
  if (hints === null) return; // déjà validé en 400 en amont ; garde défensive
  try {
    await deps.indices.save(tenant, name, language, hints);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('saveParamHints ignoré:', messageDe(err));
  }
}

/**
 * Ce bouton peut-il porter le suffixe variable qui attribue le clic ? Seulement les boutons de premier niveau :
 * `buildTemplateComponents` ne sait adresser qu'un bouton du template, pas celui d'une carte de carousel. Un
 * `{{1}}` sur un bouton de carte rendrait 131008 à chaque envoi, pour toujours (URL figée chez Meta) : ces boutons
 * restent tracés en forme anonyme. On dégrade la mesure, jamais l'envoi.
 */
export const estAttribuable = (cardIndex: number | null): boolean => cardIndex === null;

/**
 * Réserve un lien tracé par bouton URL et rend le template à soumettre. Si quoi que ce soit échoue, on rend le
 * template d'origine (non mesuré plutôt que refusé ou pointant une adresse qu'on ne sait pas servir). Les lignes
 * déjà réservées restent non confirmées, invisibles des mesures, et `allocate` (upsert) les réutilise.
 *
 * 🔴 SAUF SI UN BOUTON PORTE UN CHAMP (`{numero_commande}`) : il ne se remplit qu'au clic, par notre redirection.
 * Soumis tel quel, `{numero_commande}` partirait en clair chez Meta et y resterait figé, un lien cassé pour toujours.
 * Le template est alors refusé, avec une raison lisible (pas une 5xx : Cloudflare en mange le corps).
 */
async function preparerLiens(
  deps: TemplateRouteDeps,
  tenant: string,
  input: CreateTemplateInput,
): Promise<{ aSoumettre: CreateTemplateInput; codes: string[] } | { refus: string }> {
  const cibles = boutonsTracables(input);
  if (cibles.length === 0) return { aSoumettre: input, codes: [] };
  try {
    const liens = new Map<string, string>();
    const codes: string[] = [];
    for (const c of cibles) {
      const avecJeton = estAttribuable(c.cardIndex);
      const code = await deps.tracking.allocate(
        tenant,
        { templateName: input.name, templateLanguage: input.language, cardIndex: c.cardIndex, buttonIndex: c.buttonIndex },
        c.url,
        avecJeton,
      );
      codes.push(code);
      liens.set(cleBouton(c.cardIndex, c.buttonIndex), deps.tracking.lienDe(code, avecJeton));
    }
    return { aSoumettre: appliquerLiens(input, liens), codes };
  } catch (err) {
    const aChamps = cibles.find((c) => porteDesChamps(c.url));
    if (aChamps) {
      // eslint-disable-next-line no-console
      console.error('traçage des liens impossible, template à champs refusé:', messageDe(err));
      return { refus: `le lien de suivi du bouton ${aChamps.buttonIndex + 1} n'a pas pu être préparé, et un bouton qui porte un champ du contact ne peut pas partir sans lui : le template n'a pas été soumis, réessayez dans un instant` };
    }
    // eslint-disable-next-line no-console
    console.error('traçage des liens ignoré (template soumis avec les liens saisis):', messageDe(err));
    return { aSoumettre: input, codes: [] };
  }
}

/** Les liens confirmés de ce template (nom ET langue), au mieux : illisibles, rien à remettre en l'état. */
async function liensConfirmes(deps: TemplateRouteDeps, tenant: string, name: string, language: string): Promise<LienTrace[]> {
  try {
    return (await deps.tracking.liens.listByTemplates(tenant, [name])).filter((l) => l.templateLanguage === language);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('liens tracés du template illisibles avant soumission:', messageDe(err));
    return [];
  }
}

/**
 * Soumet un template (création ou édition) avec ses liens tracés, et laisse `tracked_links` décrire ce que Meta porte
 * VRAIMENT. Cette table seule dit à l'envoi quels boutons attendent le jeton du destinataire (liens confirmés
 * `avec_jeton`) : en retard sur Meta, elle fait refuser CHAQUE envoi (131008 si le composant manque, 132000 s'il est
 * en trop).
 *  - Meta accepte : les liens soumis sont confirmés, et ceux d'avant qui ne sont plus dans le template (bouton retiré
 *    ou déplacé par une édition, adresse soumise sans traçage) sont déconfirmés. Leur code redirige toujours.
 *  - Meta refuse (édition au-delà de son quota, nom déjà pris...) ou le traçage refuse : `allocate` a remis à zéro
 *    la confirmation des boutons qu'il a touchés, alors que Meta garde la version d'avant. On les remet dans leur
 *    état d'avant (même code, même destination, même jeton, confirmés).
 */
async function soumettreAvecLiens<T>(
  deps: TemplateRouteDeps,
  tenant: string,
  input: CreateTemplateInput,
  soumettre: (aSoumettre: CreateTemplateInput) => Promise<T>,
): Promise<{ refus: string } | { res: T }> {
  const avant = await liensConfirmes(deps, tenant, input.name, input.language);
  const restaurer = async (): Promise<void> => {
    if (avant.length === 0) return;
    try {
      const codes: string[] = [];
      for (const l of avant) {
        const cible = { templateName: l.templateName, templateLanguage: l.templateLanguage, cardIndex: l.cardIndex, buttonIndex: l.buttonIndex };
        codes.push(await deps.tracking.allocate(tenant, cible, l.destination, l.avecJeton));
      }
      await deps.tracking.liens.confirm(tenant, codes);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('liens tracés non remis en l’état après un refus:', messageDe(err));
    }
  };

  const prep = await preparerLiens(deps, tenant, input);
  if ('refus' in prep) {
    await restaurer();
    return prep;
  }
  let res: T;
  try {
    res = await soumettre(prep.aSoumettre);
  } catch (err) {
    await restaurer();
    throw err;
  }
  // Au mieux, comme les indices de variables : un hoquet ici dégrade la mesure, il ne casse pas un template déjà soumis.
  if (prep.codes.length > 0) {
    try {
      await deps.tracking.liens.confirm(tenant, prep.codes);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('confirmation des liens tracés ignorée:', messageDe(err));
    }
  }
  // Un code que le template soumis porte encore tel quel (notre lien réaffiché brut, faute de ré-habillage sur un
  // ancien nom d'hôte) reste dans le template chez Meta : il n'est pas périmé.
  const soumis = new Set([...(prep.aSoumettre.buttons ?? []), ...(prep.aSoumettre.carousel?.cards ?? []).flatMap((c) => c.buttons ?? [])]
    .map((b) => (b.type === 'URL' ? codeDuLienTrace(b.url ?? '') : null)));
  const perimes = avant.map((l) => l.code).filter((c) => !prep.codes.includes(c) && !soumis.has(c));
  if (perimes.length > 0) {
    try {
      await deps.tracking.liens.deconfirmer(tenant, perimes);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('liens tracés périmés non déconfirmés:', messageDe(err));
    }
  }
  return { res };
}

/**
 * Les champs du contact dans les adresses de boutons (`src/links/champs-url.ts`) : le refus lisible, ou `null`.
 * Un bouton de premier niveau peut en porter ; un bouton de carte jamais : tracé sans jeton (`estAttribuable`), son
 * champ ne serait jamais rempli. Les champs déclarés de l'espace ne sont lus que si une adresse porte une accolade.
 */
async function refusDesChamps(
  deps: TemplateRouteDeps,
  tenant: string,
  fields: TemplateFields,
): Promise<{ statut: 400 | 422; error: string } | null> {
  for (const [ci, carte] of (fields.carousel?.cards ?? []).entries()) {
    for (const [j, b] of (carte.buttons ?? []).entries()) {
      if (b.type !== 'URL') continue;
      const quoi = `carte ${ci + 1}, bouton ${j + 1}`;
      const a = analyserChampsUrl(b.url ?? '');
      if (!a.ok) return { statut: 400, error: refusChampsUrl(b.url ?? '', [], quoi)! };
      if (a.cles.length > 0) return { statut: 400, error: `${quoi} : un champ du contact ne peut pas être utilisé dans le lien d'une carte de carousel` };
    }
  }
  const urls = (fields.buttons ?? []).map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'URL');
  if (!urls.some(({ b }) => /[{}]/.test(b.url ?? ''))) return null;
  let connues: string[];
  try {
    connues = await deps.champsDeclares(tenant);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('champs de l’espace illisibles:', messageDe(err));
    return { statut: 422, error: 'les champs de contact de l’espace n’ont pas pu être lus pour vérifier les liens : réessayez dans un instant' };
  }
  for (const { b, i } of urls) {
    const refus = refusChampsUrl(b.url ?? '', connues, `bouton ${i + 1}`);
    if (refus) return { statut: 400, error: refus };
  }
  return null;
}

/**
 * Remontre à l'utilisateur les liens qu'il a saisis, là où Meta rend les nôtres. Fait ici, sur la liste, parce
 * que les quatre surfaces qui affichent un template passent par elle, et pas dans `MetaTemplateClient`, qui ne
 * connaît pas nos tables. Au mieux : table indisponible, on rend les templates tels que Meta les donne.
 */
async function rehabillerTemplates(
  deps: TemplateRouteDeps,
  tenant: string,
  templates: TemplateSummary[],
): Promise<TemplateSummary[]> {
  if (templates.length === 0) return templates;
  let parLien: Map<string, string>;
  try {
    parLien = await deps.tracking.destinations(tenant, templates.map((t) => t.name));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ré-habillage des liens tracés ignoré:', messageDe(err));
    return templates;
  }
  if (parLien.size === 0) return templates;
  return templates.map((t) => {
    const boutons = rehabillerBoutons(t.buttons, parLien);
    const cartes = t.carousel?.cards.map((c) => {
      const b = rehabillerBoutons(c.buttons, parLien);
      return b ? { ...c, buttons: b } : c;
    });
    return {
      ...t,
      ...(boutons ? { buttons: boutons } : {}),
      ...(cartes ? { carousel: { cards: cartes } } : {}),
    };
  });
}

const CATEGORIES = new Set(['MARKETING', 'UTILITY']);
/** Statuts qu'un template Meta autorise à éditer (POST /{id}). PENDING/IN_APPEAL non éditables. */
const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

function validButtons(v: unknown): v is TemplateButton[] | undefined {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  const okEach = v.every((b) => {
    const btn = b as { type?: unknown; text?: unknown; url?: unknown; flowId?: unknown };
    if (btn.type === 'QUICK_REPLY') return nonEmpty(btn.text);
    // Même règle d'URL que les boutons de carte : refuser ici évite le message de chemin JSON de Meta.
    if (btn.type === 'URL') return nonEmpty(btn.text) && nonEmpty(btn.url) && isSendableButtonUrl(String(btn.url));
    if (btn.type === 'FLOW') return nonEmpty(btn.text) && nonEmpty(btn.flowId);
    return false;
  });
  if (!okEach) return false;
  // Contrainte Meta : un bouton FLOW est exclusif (impossible de le mélanger à d'autres boutons).
  const hasFlow = v.some((b) => (b as { type?: unknown }).type === 'FLOW');
  return !hasFlow || v.length === 1;
}

/** Champs qui déterminent les components d'un template (partagés create + edit ; name/language exclus). */
type TemplateFields = Pick<CreateTemplateInput, 'category' | 'header' | 'body' | 'example' | 'footer' | 'buttons' | 'carousel'>;

const HEADER_MAX = 60;
const FOOTER_MAX = 60;

/** Valide l'en-tête (texte / média). null = pas d'en-tête. {error} ou {header}. */
function parseHeader(hRaw: unknown): { error: string } | { header?: TemplateHeader } {
  if (hRaw === undefined || hRaw === null) return { header: undefined };
  const hh = hRaw as { format?: unknown; text?: unknown; handle?: unknown; example?: unknown };
  if (hh.format === 'TEXT') {
    if (!nonEmpty(hh.text)) return { error: 'en-tête texte requis' };
    if (hh.text.length > HEADER_MAX) return { error: `en-tête texte trop long (max ${HEADER_MAX})` };
    // V1 : pas de variable dans l'en-tête texte. Le pipeline d'envoi (campagnes + inbox) ne sait pas fournir
    // un paramètre de header -> Meta rejetterait l'envoi (#132000). On bloque à la source (template inenvoyable).
    if (/\{\{\s*\d+\s*\}\}/.test(hh.text)) return { error: 'variable non supportée dans l\'en-tête (V1) : utilise un texte fixe' };
    return { header: { format: 'TEXT', text: hh.text.trim() } };
  }
  if (hh.format === 'IMAGE' || hh.format === 'VIDEO' || hh.format === 'DOCUMENT') {
    if (!nonEmpty(hh.handle)) return { error: 'en-tête média : handle requis (uploader le fichier d\'abord)' };
    return { header: { format: hh.format, handle: hh.handle } };
  }
  return { error: 'en-tête : format invalide (TEXT|IMAGE|VIDEO|DOCUMENT)' };
}

/**
 * Validation synchrone commune à la création et à l'édition : category, body, boutons, carousel, exemples.
 * Renvoie soit une erreur (message + code 400), soit les champs normalisés prêts à builder les components.
 * Le pré-check async « flow publié » (getPublishedFlow) et le WABA restent à la charge de l'appelant.
 */
function parseTemplateFields(b: Record<string, unknown>): { error: string } | { fields: TemplateFields } {
  if (typeof b.category !== 'string' || !CATEGORIES.has(b.category)) return { error: 'category invalide (MARKETING|UTILITY)' };
  if (!nonEmpty(b.body)) return { error: 'body requis' };
  if (!validButtons(b.buttons)) return { error: 'buttons invalides' };

  // Carousel : 2 à 10 cartes, chacune avec une image (handle) et au plus 2 boutons. Règle Meta vérifiée : seule
  // la disposition doit être identique d'une carte à l'autre (nombre, types, ordre) ; libellé et URL peuvent différer.
  let carousel: { cards: CarouselCard[] } | undefined;
  const carRaw = b.carousel;
  if (carRaw !== undefined) {
    const cards = (carRaw as { cards?: unknown }).cards;
    if (!Array.isArray(cards) || cards.length < 2 || cards.length > 10) return { error: 'carousel : entre 2 et 10 cartes' };
    const sig = (c: { buttons?: unknown }) => (Array.isArray(c.buttons) ? c.buttons.map((x) => (x as { type?: string }).type).join(',') : '');
    const firstSig = sig(cards[0] as { buttons?: unknown });
    for (const raw of cards) {
      const c = raw as { headerHandle?: unknown; buttons?: unknown };
      if (!nonEmpty(c.headerHandle)) return { error: 'chaque carte doit avoir une image' };
      if (sig(c) !== firstSig) return { error: 'toutes les cartes doivent avoir les mêmes types de boutons, dans le même ordre (le texte et le lien, eux, peuvent différer)' };
      if (Array.isArray(c.buttons)) {
        if (c.buttons.length > 2) return { error: 'une carte ne peut pas avoir plus de 2 boutons' };
        const carte = cards.indexOf(raw) + 1;
        for (const [j, bt] of c.buttons.entries()) {
          const btn = bt as { type?: string; text?: unknown; url?: unknown };
          if (btn.type === 'QUICK_REPLY' && nonEmpty(btn.text)) continue;
          if (btn.type === 'URL' && nonEmpty(btn.text) && nonEmpty(btn.url)) {
            // Meta refuse une URL qu'il ne sait pas parser avec un message qui désigne un chemin JSON
            // (« ...['cards'][1]['components'][2]['buttons'][1]['url'] is not a valid URI »). On nomme la carte.
            if (!isSendableButtonUrl(String(btn.url))) {
              return { error: `carte ${carte}, bouton ${j + 1} : « ${String(btn.url)} » n'est pas une adresse valide (commence par https://)` };
            }
            continue;
          }
          return { error: `carte ${carte}, bouton ${j + 1} : invalide (réponse rapide ou lien uniquement, texte requis)` };
        }
      }
    }
    carousel = { cards: cards as CarouselCard[] };
  }

  // En-tête (texte / image / vidéo). Ignoré si carousel (le carousel a ses en-têtes par carte).
  const h = parseHeader(b.header);
  if ('error' in h) return { error: h.error };

  // Pied de page (texte court, sans variable).
  let footer: string | undefined;
  if (b.footer !== undefined && b.footer !== null && b.footer !== '') {
    if (!nonEmpty(b.footer)) return { error: 'pied de page invalide' };
    if (b.footer.length > FOOTER_MAX) return { error: `pied de page trop long (max ${FOOTER_MAX})` };
    footer = b.footer.trim();
  }

  // Nb de variables du corps = max des positions {{n}} (`countTemplateVariables` : `{{1}} {{3}}` attend 3 params,
  // sinon 132000). Autant d'exemples, chacun non vide (Meta rejette un exemple vide, 132012).
  const varCount = countTemplateVariables(b.body as string);
  const example = Array.isArray(b.example) ? b.example.map(String) : [];
  if (varCount > 0 && example.length < varCount) {
    return { error: `exemples manquants : ${varCount} variable(s) dans le corps` };
  }
  if (example.some((e) => e.trim() === '')) {
    return { error: 'chaque exemple de variable doit être non vide (Meta rejette un exemple vide)' };
  }

  return {
    fields: {
      category: b.category as 'MARKETING' | 'UTILITY',
      body: b.body as string,
      ...(!carousel && h.header ? { header: h.header } : {}),
      ...(!carousel && footer ? { footer } : {}),
      ...(varCount > 0 ? { example: example.slice(0, varCount) } : {}),
      // Un carousel a ses boutons par carte : on ignore d'éventuels boutons top-level s'il est présent.
      ...(carousel ? { carousel } : Array.isArray(b.buttons) ? { buttons: b.buttons as TemplateButton[] } : {}),
    },
  };
}

/** Pré-check async : si un bouton FLOW est présent, le flow doit être PUBLISHED. true = OK / continuer. */
async function flowButtonOk(deps: TemplateRouteDeps, tenant: string, buttons: TemplateButton[] | undefined): Promise<boolean> {
  const flowBtn = buttons?.find((x) => x.type === 'FLOW');
  if (!flowBtn) return true;
  return deps.getPublishedFlow(tenant, flowBtn.flowId ?? '');
}

/** Routes de templates : liste + création + édition + suppression (soumission à validation Meta). */
export function registerTemplates(app: FastifyInstance, deps: TemplateRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/templates', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const wabaId = await deps.repo.getTenantWabaId(tenant);
    if (!wabaId) return reply.code(200).send({ templates: [] });
    const templates = await (await deps.meta.templateClientForTenant(tenant)).list(wabaId);
    return reply.code(200).send({ templates: await rehabillerTemplates(deps, tenant, templates) });
  });

  app.post('/tenants/:tenantId/templates', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    if (!nonEmpty(b.language)) return reply.code(400).send({ error: 'language requis' });
    // Langue = code Meta valide (whitelist). Le sélecteur front ne propose que des codes valides ; on garde le
    // garde-fou serveur pour un appel API direct (une langue invalide serait rejetée par Meta plus loin, sans message clair).
    if (!isValidTemplateLanguage(b.language)) return reply.code(400).send({ error: 'language non supportée (hors liste WhatsApp)' });
    const parsed = parseTemplateFields(b);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (parseParamHints(b.paramHints) === null) return reply.code(400).send({ error: 'paramHints invalides' });
    const refusChamps = await refusDesChamps(deps, tenant, parsed.fields);
    if (refusChamps) return reply.code(refusChamps.statut).send({ error: refusChamps.error });

    const wabaId = await deps.repo.getTenantWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });
    if (!(await flowButtonOk(deps, tenant, parsed.fields.buttons))) {
      return reply.code(400).send({ error: 'le flow référencé n\'est pas publié' });
    }

    const input: CreateTemplateInput = { name: b.name, language: b.language, ...parsed.fields };

    // Substitution des liens juste avant la soumission : l'utilisateur a saisi son adresse, Meta reçoit la nôtre.
    // La destination est enregistrée avant l'appel à Meta : l'inverse laisserait, en cas de panne entre les deux,
    // un template approuvé pointant un code inexistant (un lien mort dans des messages livrés).
    const client = await deps.meta.templateClientForTenant(tenant);
    const issue = await soumettreAvecLiens(deps, tenant, input, (aSoumettre) => client.create(wabaId, aSoumettre));
    if ('refus' in issue) return reply.code(422).send({ error: issue.refus });
    await saveHintsSafe(deps, tenant, b.name, b.language, b.paramHints);
    return reply.code(201).send(issue.res);
  });

  // Indices variable -> champ d'un template (pour pré-remplir le mapping d'une campagne). Lecture seule.
  app.get('/tenants/:tenantId/templates/:templateName/param-hints', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { templateName } = req.params as { templateName: string };
    const q = req.query as { language?: string };
    if (!nonEmpty(q.language)) return reply.code(400).send({ error: 'language requis (query)' });
    const hints = await deps.indices.get(tenant, decodeURIComponent(templateName), q.language);
    return reply.code(200).send({ hints });
  });

  // Édition d'un template simple (body/boutons/category). Carousel non supporté (header_handle non récupérable).
  app.patch('/tenants/:tenantId/templates/:templateName', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;

    const { templateName } = req.params as { templateName: string };
    const name = decodeURIComponent(templateName);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!nonEmpty(b.language)) return reply.code(400).send({ error: 'language requis' });
    const language = b.language;
    const parsed = parseTemplateFields(b);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (parseParamHints(b.paramHints) === null) return reply.code(400).send({ error: 'paramHints invalides' });
    if (parsed.fields.carousel) return reply.code(422).send({ error: 'édition d\'un carousel non supportée' });
    const refusChamps = await refusDesChamps(deps, tenant, parsed.fields);
    if (refusChamps) return reply.code(refusChamps.statut).send({ error: refusChamps.error });

    const wabaId = await deps.repo.getTenantWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    // 🔴 L'id est résolu côté serveur depuis le WABA de l'espace : l'édition Meta se fait par id global, et un id
    // fourni par le client permettrait d'éditer le template d'un autre espace.
    const existing = (await (await deps.meta.templateClientForTenant(tenant)).list(wabaId)).find((t) => t.name === name && t.language === language);
    if (!existing) return reply.code(404).send({ error: 'template introuvable' });
    if (!existing.id) return reply.code(422).send({ error: 'id du template indisponible' });
    // Anti perte de données : l'édition supprimerait en-tête, pied et carousel (Meta remplace tout, on ne régénère
    // que BODY et BUTTONS). On refuse.
    if (!existing.editable) {
      return reply.code(422).send({ error: existing.isCarousel ? 'édition d\'un carousel non supportée' : 'édition non supportée : ce template a un en-tête ou un pied de page qui serait supprimé' });
    }
    if (!EDITABLE_STATUSES.has(existing.status)) {
      return reply.code(409).send({ error: `template non éditable (statut ${existing.status}) : seuls APPROVED/REJECTED/PAUSED le sont` });
    }

    // Une campagne active utilise ce template : l'éditer le renvoie en PENDING, donc 422 à chaque envoi.
    const active = await deps.repo.listActiveCampaignsForTemplate(tenant, name, language);
    if (active.length > 0) return reply.code(409).send({ error: 'template utilisé par une campagne active', campaigns: active });

    if (!(await flowButtonOk(deps, tenant, parsed.fields.buttons))) {
      return reply.code(400).send({ error: 'le flow référencé n\'est pas publié' });
    }

    // 🔴 Les liens repassent par le traçage, comme à la création. La console réaffiche l'adresse SAISIE
    // (`rehabillerTemplates`) : la renvoyer telle quelle à Meta remplaçait notre lien tracé par l'adresse brute, alors
    // que `tracked_links` le disait toujours confirmé `avec_jeton`, donc chaque envoi ajoutait un composant de bouton
    // que le template n'avait plus. Le code d'un bouton est gardé (upsert par position) : ce qui est déjà parti
    // continue de résoudre, vers la destination à jour.
    const client = await deps.meta.templateClientForTenant(tenant);
    const existingId = existing.id;
    const issue = await soumettreAvecLiens(deps, tenant, { name, language, ...parsed.fields }, (t) => client.update(existingId, {
      category: t.category,
      body: t.body,
      ...(t.header ? { header: t.header } : {}),
      ...(t.footer ? { footer: t.footer } : {}),
      ...(t.example ? { example: t.example } : {}),
      ...(t.buttons ? { buttons: t.buttons } : {}),
    }));
    if ('refus' in issue) return reply.code(422).send({ error: issue.refus });
    await saveHintsSafe(deps, tenant, name, language, b.paramHints);
    return reply.code(200).send({ ...issue.res, status: 'PENDING' });
  });

  // Suppression par nom = toutes les langues chez Meta, donc garde-fou sur toutes les langues (langue omise).
  app.delete('/tenants/:tenantId/templates/:templateName', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;

    const { templateName } = req.params as { templateName: string };
    const name = decodeURIComponent(templateName);

    const active = await deps.repo.listActiveCampaignsForTemplate(tenant, name);
    if (active.length > 0) return reply.code(409).send({ error: 'template utilisé par une campagne active', campaigns: active });

    const wabaId = await deps.repo.getTenantWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });
    const res = await (await deps.meta.templateClientForTenant(tenant)).remove(wabaId, name);
    await deps.indices.removeByName(tenant, name).catch(() => {});
    return reply.code(200).send(res);
  });
}
