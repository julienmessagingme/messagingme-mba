import type { CampaignStatus } from '../campaign/types';
import type { ParamSource } from '../crm/template';
import { analyserChampsUrl } from '../../web/lib/partage/champs-url';
import { porteDesChamps, refusChampsUrl } from '../links/champs-url';
import { appliquerLiens, boutonsTracables, cleBouton, codeDuLienTrace, rehabillerBoutons } from '../links/rewrite';
import type { CibleLien, LienTrace } from '../links/tracked-links.pg';
import { messageDe } from '../lib/erreur';
import type { ClientModeles, CreateTemplateInput, TemplateButton, TemplateSummary, StatutModele } from '../meta/templates';

/** Les écritures et lectures nécessaires au cycle de vie d'un modèle WhatsApp. */
export interface DepsGestionModeles {
  meta: {
    /** Client de modèles résolu par espace : Meta Cloud ou 360dialog. */
    templateClientForTenant(tenantId: string): Promise<ClientModeles>;
  };
  repo: {
    /** WABA de l'espace ; les modèles vivent au niveau du compte WhatsApp. */
    getTenantWabaId(tenantId: string): Promise<string | null>;
    /** Campagnes actives qui utilisent ce modèle. */
    listActiveCampaignsForTemplate(
      tenantId: string,
      templateName: string,
      templateLanguage?: string,
    ): Promise<Array<{ id: string; name: string; status: CampaignStatus; templateLanguage: string }>>;
  };
  getPublishedFlow(tenantId: string, flowId: string): Promise<boolean>;
  indices: {
    save(tenantId: string, name: string, language: string, hints: Array<{ position: number; source: ParamSource }>): Promise<void>;
    get(tenantId: string, name: string, language: string): Promise<Array<{ position: number; source: ParamSource }>>;
    removeByName(tenantId: string, name: string): Promise<void>;
  };
  champsDeclares(tenantId: string): Promise<string[]>;
  tracking: {
    allocate(tenantId: string, cible: CibleLien, destination: string, avecJeton: boolean): Promise<string>;
    liens: {
      confirm(tenantId: string, codes: readonly string[]): Promise<void>;
      deconfirmer(tenantId: string, codes: readonly string[]): Promise<void>;
      listByTemplates(tenantId: string, noms: readonly string[]): Promise<LienTrace[]>;
    };
    lienDe(code: string, avecJeton: boolean): string;
    destinations(tenantId: string, noms: readonly string[]): Promise<Map<string, string>>;
  };
}

/** Champs déjà validés par l'adapter appelant, communs à la création et à l'édition. */
export type ChampsModele = Pick<CreateTemplateInput, 'category' | 'header' | 'body' | 'example' | 'footer' | 'buttons' | 'carousel' | 'ttlSecondes'>;
export type IndicesModele = Array<{ position: number; source: ParamSource }>;

type CampagneActive = Awaited<ReturnType<DepsGestionModeles['repo']['listActiveCampaignsForTemplate']>>[number];

export type RefusGestionModele = {
  statut: 400 | 404 | 409 | 422;
  error: string;
  campaigns?: CampagneActive[];
};

export type IssueCreationModele =
  | { statut: 400 | 422; error: string; motif: 'champs' | 'compte' | 'flow' | 'liens' }
  | { res: { id: string; status: string; category: string } };

export type IssueModificationModele =
  | { refus: RefusGestionModele }
  | { res: { success: boolean; status: 'PENDING' } };

export type IssueSuppressionModele =
  | { refus: RefusGestionModele }
  | { res: { success: boolean } };

export type LectureStatutsModele =
  | { compteLie: false }
  | { compteLie: true; statuts: StatutModele[] };

/** Les boutons de premier niveau seuls peuvent recevoir le suffixe qui attribue le clic. */
export const estAttribuable = (cardIndex: number | null): boolean => cardIndex === null;

async function enregistrerIndices(
  deps: DepsGestionModeles,
  tenant: string,
  name: string,
  language: string,
  hints: IndicesModele | undefined,
): Promise<void> {
  if (hints === undefined) return;
  try {
    await deps.indices.save(tenant, name, language, hints);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('saveParamHints ignoré:', messageDe(err));
  }
}

async function preparerLiens(
  deps: DepsGestionModeles,
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

async function liensConfirmes(deps: DepsGestionModeles, tenant: string, name: string, language: string): Promise<LienTrace[]> {
  try {
    return (await deps.tracking.liens.listByTemplates(tenant, [name])).filter((l) => l.templateLanguage === language);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('liens tracés du template illisibles avant soumission:', messageDe(err));
    return [];
  }
}

/**
 * Soumet une création ou une édition en gardant `tracked_links` aligné sur ce que porte réellement le fournisseur.
 * Les compensations sont best-effort : un modèle accepté ne redevient jamais un échec HTTP à cause de la mesure.
 */
async function soumettreAvecLiens<T>(
  deps: DepsGestionModeles,
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
  if (prep.codes.length > 0) {
    try {
      await deps.tracking.liens.confirm(tenant, prep.codes);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('confirmation des liens tracés ignorée:', messageDe(err));
    }
  }
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

/** Refus lisible des champs de contact utilisés dans les adresses de boutons, ou `null`. */
async function refusDesChamps(
  deps: DepsGestionModeles,
  tenant: string,
  fields: ChampsModele,
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

async function rehabillerTemplates(
  deps: DepsGestionModeles,
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

async function flowPublie(deps: DepsGestionModeles, tenant: string, buttons: TemplateButton[] | undefined): Promise<boolean> {
  const flowBtn = buttons?.find((x) => x.type === 'FLOW');
  if (!flowBtn) return true;
  return deps.getPublishedFlow(tenant, flowBtn.flowId ?? '');
}

/** Vérifications qui doivent précéder une création, y compris avant le dépôt d'un en-tête distant. */
async function preparerCreationModele(
  deps: DepsGestionModeles,
  tenant: string,
  input: CreateTemplateInput,
): Promise<{ wabaId: string } | { refus: Exclude<IssueCreationModele, { res: unknown }> }> {
  const refusChamps = await refusDesChamps(deps, tenant, input);
  if (refusChamps) return { refus: { ...refusChamps, motif: 'champs' } };
  const wabaId = await deps.repo.getTenantWabaId(tenant);
  if (!wabaId) {
    return { refus: { statut: 400, error: 'aucun WABA pour ce tenant', motif: 'compte' } };
  }
  if (!(await flowPublie(deps, tenant, input.buttons))) {
    return { refus: { statut: 400, error: 'le flow référencé n\'est pas publié', motif: 'flow' } };
  }
  return { wabaId };
}

/** Vérifications qui doivent précéder un éventuel dépôt d'en-tête distant. */
export async function verifierCreationModele(
  deps: DepsGestionModeles,
  tenant: string,
  input: CreateTemplateInput,
): Promise<Exclude<IssueCreationModele, { res: unknown }> | null> {
  const preparation = await preparerCreationModele(deps, tenant, input);
  return 'refus' in preparation ? preparation.refus : null;
}

/** Création commune à la console, à la porte publique et à MCP. */
export async function creerUnModele(
  deps: DepsGestionModeles,
  tenant: string,
  input: CreateTemplateInput,
  paramHints?: IndicesModele,
): Promise<IssueCreationModele> {
  const preparation = await preparerCreationModele(deps, tenant, input);
  if ('refus' in preparation) return preparation.refus;
  const client = await deps.meta.templateClientForTenant(tenant);
  const issue = await soumettreAvecLiens(deps, tenant, input, (aSoumettre) => client.create(preparation.wabaId, aSoumettre));
  if ('refus' in issue) return { statut: 422, error: issue.refus, motif: 'liens' };
  await enregistrerIndices(deps, tenant, input.name, input.language, paramHints);
  return { res: issue.res };
}

/** Liste du fournisseur, avec les adresses saisies remises à la place de nos liens de redirection. */
export async function listerModeles(deps: DepsGestionModeles, tenant: string): Promise<TemplateSummary[]> {
  const wabaId = await deps.repo.getTenantWabaId(tenant);
  if (!wabaId) return [];
  const templates = await (await deps.meta.templateClientForTenant(tenant)).list(wabaId);
  return rehabillerTemplates(deps, tenant, templates);
}

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

/** Édition complète d'une langue, avec garde des campagnes et compensation des liens suivis. */
export async function modifierUnModele(
  deps: DepsGestionModeles,
  tenant: string,
  name: string,
  language: string,
  fields: ChampsModele,
  paramHints?: IndicesModele,
): Promise<IssueModificationModele> {
  if (fields.carousel) return { refus: { statut: 422, error: 'édition d\'un carousel non supportée' } };
  const refusChamps = await refusDesChamps(deps, tenant, fields);
  if (refusChamps) return { refus: refusChamps };
  const wabaId = await deps.repo.getTenantWabaId(tenant);
  if (!wabaId) return { refus: { statut: 400, error: 'aucun WABA pour ce tenant' } };

  const client = await deps.meta.templateClientForTenant(tenant);
  const existing = (await client.list(wabaId)).find((t) => t.name === name && t.language === language);
  if (!existing) return { refus: { statut: 404, error: 'template introuvable' } };
  if (!existing.id) return { refus: { statut: 422, error: 'id du template indisponible' } };
  if (!existing.editable) {
    return { refus: { statut: 422, error: existing.isCarousel ? 'édition d\'un carousel non supportée' : 'édition non supportée : ce template a un en-tête ou un pied de page qui serait supprimé' } };
  }
  if (!EDITABLE_STATUSES.has(existing.status)) {
    return { refus: { statut: 409, error: `template non éditable (statut ${existing.status}) : seuls APPROVED/REJECTED/PAUSED le sont` } };
  }
  const active = await deps.repo.listActiveCampaignsForTemplate(tenant, name, language);
  if (active.length > 0) return { refus: { statut: 409, error: 'template utilisé par une campagne active', campaigns: active } };
  if (!(await flowPublie(deps, tenant, fields.buttons))) {
    return { refus: { statut: 400, error: 'le flow référencé n\'est pas publié' } };
  }

  const issue = await soumettreAvecLiens(deps, tenant, { name, language, ...fields }, (t) => client.update(existing.id!, {
    category: t.category,
    body: t.body,
    ...(t.header ? { header: t.header } : {}),
    ...(t.footer ? { footer: t.footer } : {}),
    ...(t.example ? { example: t.example } : {}),
    ...(t.buttons ? { buttons: t.buttons } : {}),
    ...(t.ttlSecondes !== undefined ? { ttlSecondes: t.ttlSecondes } : {}),
  }));
  if ('refus' in issue) return { refus: { statut: 422, error: issue.refus } };
  await enregistrerIndices(deps, tenant, name, language, paramHints);
  return { res: { ...issue.res, status: 'PENDING' } };
}

/** Suppression de toutes les langues d'un nom, refusée tant qu'une campagne active l'utilise. */
export async function supprimerUnModele(
  deps: DepsGestionModeles,
  tenant: string,
  name: string,
): Promise<IssueSuppressionModele> {
  const active = await deps.repo.listActiveCampaignsForTemplate(tenant, name);
  if (active.length > 0) return { refus: { statut: 409, error: 'template utilisé par une campagne active', campaigns: active } };
  const wabaId = await deps.repo.getTenantWabaId(tenant);
  if (!wabaId) return { refus: { statut: 400, error: 'aucun WABA pour ce tenant' } };
  const res = await (await deps.meta.templateClientForTenant(tenant)).remove(wabaId, name);
  await deps.indices.removeByName(tenant, name).catch(() => {});
  return { res };
}

/** Statuts bruts d'un nom, avec un état explicite quand aucun compte n'est relié. */
export async function lireStatutsModele(
  deps: DepsGestionModeles,
  tenant: string,
  name: string,
): Promise<LectureStatutsModele> {
  const wabaId = await deps.repo.getTenantWabaId(tenant);
  if (!wabaId) return { compteLie: false };
  return {
    compteLie: true,
    statuts: await (await deps.meta.templateClientForTenant(tenant)).statutsDuNom(wabaId, name),
  };
}
