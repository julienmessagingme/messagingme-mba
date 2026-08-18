'use client';

/**
 * Assistant de création d'une campagne : source des destinataires, contenu (template WhatsApp, scénario ou
 * message RCS), association des variables, débit et programmation.
 *
 * Extrait de `app/campaigns/page.tsx` : ce formulaire y pesait ~1000 lignes et une quarantaine d'états, et
 * absorbait chaque nouvelle fonctionnalité (RCS, planification, création de template en ligne), au point de
 * rendre la page illisible. Même geste que TemplateForm, CsvImport ou ContactFilterPanel avant lui.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { TemplatePreview } from '@/components/TemplatePreview';
import { CsvImport } from '@/components/CsvImport';
import { HubspotListImport } from '@/components/HubspotListImport';
import { TemplateForm, type CreatedTemplate } from '@/components/TemplateForm';
import { ContactFilterPanel } from '@/components/ContactFilterPanel';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import {
  createCampaign,
  runCampaign,
  listTemplates,
  listWorkflows,
  listUserFields,
  listTags,
  listRcsAgents,
  queryContacts,
  countContacts,
  contactIdsForFilters,
  getTemplateHints,
  getSettings,
  getCampaign,
  contactIdentity,
  type UserFieldDef,
  type CreateCampaignInput,
  type RecipientCounts,
  type PhoneNumber,
  type RcsAgent,
  type TemplateParam,
  type TemplateSummary,
  type Contact,
  type ImportReport,
  type ContactFilters,
  type TagCount,
  type CampaignDetail,
  type WorkflowSummary,
} from '@/lib/api';
import { SYSTEM_FIELDS, customFieldsOnly, isSystemFieldKey, systemFieldExample } from '@/lib/fields';
import { filtersActive } from '@/lib/contact-filters';
import { firstTemplateOf, isCampaignEligible } from '@/lib/campaign-eligibility';
interface VarRow {
  /** Option choisie dans le sélecteur : 'sys:<key>' (champ de base), 'field:<key>' (champ perso), ou 'literal'. */
  sel: string;
  /** Valeur saisie (uniquement pour 'literal'). */
  value: string;
}

/** Option choisie -> ParamSource envoyée au backend. */
function selToSource(sel: string, value: string): TemplateParam['source'] {
  if (sel === 'now') return { type: 'now' };
  if (sel === 'literal') return { type: 'literal', value };
  if (sel.startsWith('sys:')) {
    const f = SYSTEM_FIELDS.find((s) => `sys:${s.key}` === sel);
    return f ? f.source : { type: 'attribute', key: 'name' };
  }
  return { type: 'field', key: sel.slice('field:'.length) };
}

/** ParamSource (indice de template stocké) -> option à présélectionner. `customFields` = les champs perso RÉELS :
 *  un indice vers un champ inexistant (ex. indice périmé « nom » d'un champ supprimé) retombe sur « Nom » : sinon
 *  le `<select>` afficherait la 1re option (« Nom ») tout en gardant en interne un `sel` fantôme qui saute le contact. */
function selForSource(s: TemplateParam['source'], customFields: UserFieldDef[]): string {
  if (s.type === 'now') return 'now';
  if (s.type === 'literal') return 'literal';
  if (s.type === 'attribute') return `sys:${s.key ?? 'name'}`;
  const key = s.key ?? '';
  if (isSystemFieldKey(key)) return `sys:${key}`; // prenom/email = champ système
  return customFields.some((f) => f.key === key) ? `field:${key}` : 'sys:name';
}

export function CampaignCreateForm({ tenantId, numbers, onCreated, onBusyChange }: { tenantId: string; numbers: PhoneNumber[]; onCreated: () => void; onBusyChange?: (busy: boolean) => void }) {
  const t = useT();
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'marketing' | 'utility'>('marketing');
  const [templateName, setTemplateName] = useState('');
  const [templateLanguage, setTemplateLanguage] = useState('fr');
  const [vars, setVars] = useState<VarRow[]>([]);
  // Quoi envoyer : un template direct, un workflow (bot builder), OU un message RCS.
  // Le RCS est un CANAL, pas une forme de contenu WhatsApp : il n'a ni numéro Meta, ni template à faire
  // approuver, ni variables à mapper. Il vit ici parce que c'est la même question posée à l'opérateur
  // (« que veux-tu leur envoyer ? ») et que dupliquer l'assistant pour un seul champ de plus serait pire.
  const [mode, setMode] = useState<'template' | 'workflow' | 'rcs'>('template');
  const [rcsAgentId, setRcsAgentId] = useState('');
  const [rcsText, setRcsText] = useState('');
  const [rcsAgents, setRcsAgents] = useState<RcsAgent[]>([]);
  const [workflowId, setWorkflowId] = useState('');
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  // Nombre TOTAL de scénarios du tenant, avant le filtre d'éligibilité campagne : sans lui, « aucun scénario »
  // s'afficherait alors qu'il en existe (mais qu'aucun ne démarre par un template), message faux et déroutant.
  const [workflowsTotal, setWorkflowsTotal] = useState(0);
  // Message bloquant si le workflow choisi n'OUVRE pas par un envoi de template (pas de cible au mapping).
  const [wfError, setWfError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // Débit d'envoi (« vitesse du canon ») : jauge TOUJOURS active, 1..80 messages/min (plafond WhatsApp), défaut 60.
  // On protège la réputation du numéro d'entrée de jeu plutôt que d'envoyer au max par défaut.
  const [ratePerMinute, setRatePerMinute] = useState<number>(60);
  // Lancement rapatrié sur l'écran (étape 2) : idle -> creating -> launching (avec polling inline) -> done|error.
  // Programmation : idle -> creating -> scheduled (pas de polling, le worker déclenche l'envoi à l'échéance).
  const [launch, setLaunch] = useState<{
    phase: 'idle' | 'creating' | 'launching' | 'scheduled' | 'done' | 'error';
    campaignId?: string;
    detail?: CampaignDetail;
    message?: string;
  }>({ phase: 'idle' });
  // Timing du lancement (étape 2) : 'now' = envoi immédiat, 'later' = programmation à une date/heure future.
  const [timing, setTiming] = useState<'now' | 'later'>('now');
  // Date/heure choisie pour la programmation, en HEURE LOCALE (valeur brute d'un <input datetime-local>).
  // Convertie en ISO UTC absolu (new Date(...).toISOString()) seulement au moment de l'action.
  const [scheduledLocal, setScheduledLocal] = useState('');
  // Anti-course : ne pas appliquer les indices d'un template si l'utilisateur en a choisi un autre entre-temps.
  const chooseSeq = useRef(0);
  // Garde de démontage : le mini-polling du lancement est une boucle async hors cycle React -> on l'arrête si
  // l'utilisateur quitte l'écran (retour liste) pour ne pas continuer à fetch/setState sur un composant démonté.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Références chargées une fois (indépendamment du polling des campagnes) : templates, scénarios, champs, tags.
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  // Création d'un template SANS quitter la campagne en cours. `submittedTemplate` retient ce qui vient d'être
  // soumis : le formulaire se referme, mais la confirmation doit survivre pour expliquer l'attente Meta.
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [submittedTemplate, setSubmittedTemplate] = useState<CreatedTemplate | null>(null);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(true);

  // --- Zone Destinataires : source + filtres du mini-CRM ---
  const [source, setSource] = useState<'crm' | 'file' | 'hubspot'>('crm');
  // Toggle « Campagnes via données HubSpot » (réglé sur l'accueil) : gate le 3e bouton de source.
  const [hubspotListsEnabled, setHubspotListsEnabled] = useState(false);
  // Campagnes via listes HubSpot en pause (F3-b, flag tenant campaignsPaused) : on grise la source HubSpot pour ne
  // pas envoyer l'admin vers un panneau vide pendant la pause.
  const [hubspotPaused, setHubspotPaused] = useState(false);
  // Filtres de la source CRM : UN objet ContactFilters, édité par le composant PARTAGÉ ContactFilterPanel
  // (même moteur de recherche que le mini-CRM, pas de 2e implémentation parallèle).
  const [filters, setFilters] = useState<ContactFilters>({});
  // Résultats : liste affichée (<= 500), total réel (compteur), sélection ciblée.
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Récap non bloquant après un import fichier (N importés + tag posé) : affiché dans la zone Destinataires.
  const [importMsg, setImportMsg] = useState<{ n: number; tags: string[] } | null>(null);
  // Import CSV (source fichier) en vol : gèle les boutons de source (changer de source démonterait CsvImport).
  const [importBusy, setImportBusy] = useState(false);
  // Anti-course : n'appliquer qu'une réponse à jour (une plus récente peut la doubler entre-temps).
  const reqSeq = useRef(0);

  useEffect(() => {
    if (!phoneNumberId && numbers[0]) setPhoneNumberId(numbers[0].id);
  }, [numbers, phoneNumberId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // getSettings lancé EN PARALLÈLE mais DÉCOUPLÉ du Promise.all (all-or-nothing) : un hoquet sur les réglages
      // ne doit pas vider templates/scénarios ; le toggle HubSpot reste false par défaut. `.catch(->null)` isole l'échec.
      const settingsPromise = getSettings(tenantId).catch(() => null);
      try {
        const [tpl, w, uf, tg] = await Promise.all([listTemplates(tenantId), listWorkflows(tenantId), listUserFields(tenantId), listTags(tenantId)]);
        if (!alive) return;
        setTemplates(tpl.templates.filter((x) => x.status === 'APPROVED'));
        // Le sélecteur ne propose QUE les scénarios lançables en broadcast (ce qui OUVRE = un template configuré). Depuis
        // le Lot D, un scénario peut légitimement démarrer autrement (formulaire, message rapide) : il reste
        // valide, mais réservé aux déclenchements en fenêtre garantie, donc hors campagne. Même filtre APPROVED
        // que les templates : ne jamais proposer ce qui ne partira pas.
        setWorkflows(w.workflows.filter((x) => isCampaignEligible(x.graph)));
        setWorkflowsTotal(w.workflows.length);
        setUserFields(uf.fields);
        setTags(tg.tags);
      } catch {
        // silencieux : l'erreur de création reste affichée si l'envoi échoue
      } finally {
        if (alive) setLoadingRefs(false);
      }
      const cfg = await settingsPromise;
      if (alive && cfg) { setHubspotListsEnabled(cfg.hubspotListsEnabled); setHubspotPaused(cfg.campaignsPaused); }
    })();
    return () => { alive = false; };
  }, [tenantId]);

  // Recharge la SEULE liste des templates (après une création inline, ou pour vérifier une approbation Meta).
  // Même filtre APPROVED que le chargement initial : le select ne doit jamais proposer un template inenvoyable.
  const reloadTemplates = useCallback(async () => {
    try {
      const tpl = await listTemplates(tenantId);
      setTemplates(tpl.templates.filter((x) => x.status === 'APPROVED'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rafraîchissement impossible');
    }
  }, [tenantId]);

  // Rechargement DEBOUNCÉ (350 ms) de la liste + du compteur quand les filtres changent (source 'crm' seulement).
  // Au rechargement, on re-coche tous les contacts chargés (comportement « tout ciblé » par défaut).
  useEffect(() => {
    if (source !== 'crm') { setCountLoading(false); return; }
    const f = filters;
    setCountLoading(true);
    const timer = setTimeout(() => {
      const seq = ++reqSeq.current;
      void (async () => {
        try {
          const [q, c] = await Promise.all([queryContacts(tenantId, f, { limit: 500 }), countContacts(tenantId, f)]);
          if (seq !== reqSeq.current || !mountedRef.current) return; // réponse périmée ou écran quitté
          setContacts(q.contacts);
          setTotal(c.total);
          setSelected(new Set(q.contacts.map((x) => x.id)));
          setCountLoading(false);
        } catch {
          if (seq !== reqSeq.current || !mountedRef.current) return;
          setCountLoading(false); // erreur silencieuse : on garde l'affichage précédent
        }
      })();
    }, 350);
    return () => clearTimeout(timer);
  }, [source, tenantId, filters]);

  const selectedTemplate = templates.find((tpl) => tpl.name === templateName);
  // Valeurs d'aperçu par variable (échantillon lisible selon le mapping) pour la miniature WhatsApp.
  const previewExamples = vars.map((v) =>
    v.sel === 'literal' ? (v.value.trim() || '…')
      : v.sel.startsWith('sys:') ? systemFieldExample(v.sel.slice('sys:'.length))
      : `[${v.sel.slice('field:'.length) || 'champ'}]`,
  );

  // Charge les variables d'un template (corps -> nb de {{n}}) et pré-remplit chaque ligne via les indices posés au
  // design (hints). Réutilisé par le mode template DIRECT et par le 1er template d'un workflow. Ne touche NI la
  // catégorie NI le nom de campagne (le workflow choisit sa catégorie à part).
  async function loadTemplateVars(nm: string, language: string) {
    const tpl = templates.find((x) => x.name === nm);
    const n = new Set((tpl?.body ?? '').match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
    // Défaut immédiat : chaque variable -> Nom. On affine ensuite avec les indices posés à la création du template.
    setVars(Array.from({ length: n }, () => ({ sel: 'sys:name', value: '' })));
    if (n === 0) return;
    const seq = ++chooseSeq.current;
    try {
      const { hints } = await getTemplateHints(tenantId, nm, language);
      if (seq !== chooseSeq.current) return; // un autre template/workflow a été choisi entre-temps
      if (hints.length === 0) return;
      setVars((prev) => {
        if (prev.length !== n) return prev;
        const rows = [...prev];
        for (const h of hints) {
          const i = h.position - 1;
          if (i < 0 || i >= n) continue;
          rows[i] = { sel: selForSource(h.source, userFields), value: h.source.type === 'literal' ? (h.source.value ?? '') : '' };
        }
        return rows;
      });
    } catch { /* pas d'indices -> on garde le défaut */ }
  }

  async function chooseTemplate(nm: string) {
    setTemplateName(nm);
    const tpl = templates.find((x) => x.name === nm);
    if (!tpl) { setVars([]); return; }
    setTemplateLanguage(tpl.language);
    setCategory((tpl.category ?? '').toUpperCase() === 'MARKETING' ? 'marketing' : 'utility');
    if (name.trim() === '') setName(nm);
    await loadTemplateVars(nm, tpl.language);
  }

  // Choix d'un workflow : on VÉRIFIE qu'il OUVRE par un envoi de template (sinon le mapping n'a pas de cible ->
  // message bloquant, comme côté serveur), puis on remonte ce template + ses variables dans le MÊME sélecteur que
  // le mode direct. Le mapping collecté part avec la campagne (résolu par contact, contacts sans la valeur sautés).
  async function chooseWorkflow(id: string) {
    setWorkflowId(id);
    setWfError(null);
    setTemplateName('');
    setVars([]);
    if (id === '') return;
    const wf = workflows.find((w) => w.id === id);
    if (!wf) return;
    // Le template à paramétrer est celui qui OUVRE, pas forcément le bloc d'entrée : un tag ou une action
    // peuvent le précéder sans rien envoyer. Chercher sur l'entrée rendrait '' et perdrait le mapping.
    const entry = firstTemplateOf(wf.graph);
    const tplName = entry ? String(entry.data.templateName ?? '').trim() : '';
    if (!entry || tplName === '') {
      setWfError(t("Ce scénario n'ouvre pas par un envoi de template : il ne peut pas partir en campagne.", 'This scenario does not open by sending a template: it cannot run as a campaign.'));
      return;
    }
    const language = String(entry.data.language ?? 'fr');
    setTemplateName(tplName);
    setTemplateLanguage(language);
    await loadTemplateVars(tplName, language);
  }

  // Bascule template <-> workflow : on repart d'un état propre (variables/erreurs/choix précédents) pour ne pas
  // mélanger le mapping d'un template direct avec celui du 1er template d'un workflow.
  /**
   * Agents RCS chargés À LA DEMANDE, quand l'opérateur choisit le canal, et une seule fois.
   *
   * Pas au chargement de l'écran, et ce n'est pas cosmétique : la plupart des campagnes sont WhatsApp, cette
   * requête serait inutile 9 fois sur 10. Elle décalait surtout le timing de la page au point de faire tomber
   * des specs E2E existants (aperçu de carousel, filtre des scénarios), qui passaient pourtant seuls. Une
   * requête qu'on n'a pas besoin de faire est aussi une requête qui ne peut rien casser.
   */
  const [rcsAgentsLoaded, setRcsAgentsLoaded] = useState(false);
  async function chargerAgentsRcs() {
    if (rcsAgentsLoaded) return;
    setRcsAgentsLoaded(true);
    const res = await listRcsAgents(tenantId).catch(() => null);
    // `Array.isArray` : une réponse sans le champ `agents` (front déployé avant l'API) poserait `undefined`
    // dans l'état, et le rendu suivant planterait sur `rcsAgents.length`. Route absente = liste vide.
    if (res && Array.isArray(res.agents)) setRcsAgents(res.agents);
  }

  /**
   * Motifs des contacts ÉCARTÉS, ventilés. Les écarts ont deux causes qui n'appellent pas la même correction :
   * une variable de template sans valeur sur la fiche, ou un contact sans opt-in sur une campagne marketing.
   * Les confondre envoie l'opérateur corriger des fiches alors que le problème est le consentement.
   *
   * UNE SEULE implémentation, partagée par le brouillon, le lancement direct et la programmation. Les deux
   * derniers portaient un texte FIGÉ sur « la variable du template » : faux pour un skip d'opt-in, et
   * structurellement toujours faux en RCS, qui n'a aucune variable (mapping vide -> `missing_variable`
   * impossible). L'opérateur était renvoyé vers une action qui n'existe pas.
   */
  function detailEcartes(skipped: Array<{ reason: string }>): string {
    const sansOptIn = skipped.filter((x) => x.reason === 'not_opted_in').length;
    const sansVariable = skipped.length - sansOptIn;
    return [
      sansVariable > 0 ? t(`${sansVariable} sans valeur pour une variable du template`, `${sansVariable} missing a template variable value`) : '',
      sansOptIn > 0 ? t(`${sansOptIn} sans opt-in (une campagne marketing l'exige)`, `${sansOptIn} without opt-in (a marketing campaign requires it)`) : '',
    ].filter(Boolean).join(t(', ', ', '));
  }

  /** Message d'échec « personne à qui envoyer », avec la correction qui correspond VRAIMENT au motif. */
  function messageAucunDestinataire(skipped: Array<{ reason: string }>): string {
    const detail = detailEcartes(skipped);
    const correction = skipped.every((x) => x.reason === 'not_opted_in')
      ? t('Ces contacts n\'ont pas donné leur consentement : passe la campagne en « Utility » si elle relève du service, ou choisis d\'autres contacts.', 'These contacts have not consented: switch the campaign to "Utility" if it is a service message, or choose other contacts.')
      : t('Corrige la source de la variable ou les fiches, ou passe la campagne en « Utility » si elle relève du service.', 'Fix the variable source or the records, or switch the campaign to "Utility" if it is a service message.');
    return t(
      `Aucun destinataire : les ${skipped.length} contact(s) sélectionné(s) ont été écartés (${detail}). ${correction}`,
      `No recipients: all ${skipped.length} selected contact(s) were skipped (${detail}). ${correction}`,
    );
  }

  function chooseMode(m: 'template' | 'workflow' | 'rcs') {
    if (m === 'rcs') void chargerAgentsRcs();
    setMode(m);
    setWfError(null);
    setVars([]);
    setTemplateName('');
    setWorkflowId('');
  }

  // Bascule de source. Pour les sources non implémentées, on vide la sélection (donc étape 2 désactivée).
  // Un changement manuel de source referme le récap d'import (il ne concerne plus l'écran affiché).
  function chooseSource(s: 'crm' | 'file' | 'hubspot') {
    setSource(s);
    setImportMsg(null);
    if (s !== 'crm') setSelected(new Set());
  }

  // Après un import fichier : les contacts sont dans le CRM, taggés. On CIBLE ces contacts en posant leur(s)
  // tag(s) comme seul filtre et en vidant tout le reste, pour que le compteur/liste (étape Destinataires) ne
  // montrent qu'eux. tagMode 'or' si plusieurs tags (au moins un), 'and' sinon.
  function applyImportedTags(tags: string[]) {
    // Cible les importés : leur(s) tag(s) comme SEUL filtre, tout le reste vidé (tagMode 'or' si plusieurs).
    setFilters(tags.length > 1 ? { tags, tagMode: 'or' } : { tags });
  }

  // Callback de CsvImport (source fichier) : on pivote sur la source CRM filtrée par le(s) tag(s) de l'import.
  // L'effet debouncé de la liste se redéclenche (filtres changés) et re-coche les contacts chargés -> `selected`
  // contient les importés, l'étape 2 devient accessible. N = contacts réellement posés (créés + mis à jour).
  function handleImported({ report, tags }: { report: ImportReport; tags: string[] }) {
    applyImportedTags(tags);
    setSource('crm');
    setImportMsg({ n: report.created + report.updated, tags });
  }
  function toggleContact(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  // « Tout sélectionner (N) » : résout côté serveur TOUS les ids correspondants (au-delà des 500 affichés).
  async function selectAllMatching() {
    try {
      const { ids } = await contactIdsForFilters(tenantId, filters);
      if (!mountedRef.current) return;
      setSelected(new Set(ids));
    } catch { /* silencieux */ }
  }
  // Un filtre est actif dès qu'une clé est posée -> distingue « aucun résultat » de « aucun contact du tout ».
  const hasActiveFilters = filtersActive(filters);
  // Le récap d'import n'est PERTINENT que tant que le filtre affiché == exactement les tags importés (rien
  // d'autre). Dès que l'utilisateur touche un filtre, la sélection diverge des importés -> on masque le récap.
  const importMsgFresh = importMsg !== null
    && (filters.tags?.length ?? 0) === importMsg.tags.length
    && importMsg.tags.every((tg) => filters.tags?.includes(tg))
    // tagMode DOIT aussi matcher ce qu'a posé applyImportedTags ('or' si plusieurs tags, absent sinon) : sans
    // ça, basculer le ET/OU rétrécit la requête mais laisserait le bandeau « importés » affiché à tort.
    && (importMsg.tags.length > 1 ? filters.tagMode === 'or' : !filters.tagMode)
    && !filters.optIn && !filters.phonePrefix && !filters.phoneContains && !filters.nameSearch
    && !(filters.tagsExclude?.length) && !(filters.fieldFilters?.length);

  function toParamMapping(): TemplateParam[] {
    return vars.map((v, i) => ({ position: i + 1, source: selToSource(v.sel, v.value) }));
  }

  // Payload de création partagé par le brouillon (submit) et le lancement direct (createAndLaunch).
  function buildCreateInput(): CreateCampaignInput {
    // Débit TOUJOURS choisi (jauge, défaut 60) : on envoie systématiquement le plafond 1..80.
    // Campagne RCS : ni numéro Meta, ni template, ni variables. Le message part tel qu'il est écrit.
    if (mode === 'rcs') {
      return {
        phoneNumberId: '', name, category, channel: 'rcs',
        rcsAgentId, rcsMessage: { kind: 'text', text: rcsText.trim() },
        contactIds: [...selected], ratePerMinute,
      };
    }
    return mode === 'workflow'
      ? { phoneNumberId, name, category, workflowId, paramMapping: toParamMapping(), contactIds: [...selected], ratePerMinute }
      : { phoneNumberId, name, category, templateName, templateLanguage, paramMapping: toParamMapping(), contactIds: [...selected], ratePerMinute };
  }

  // Remise à zéro pour « Nouvelle campagne » après un lancement réussi (sans quitter l'écran de création).
  function resetForm() {
    setName('');
    setTemplateName('');
    setVars([]);
    setWorkflowId('');
    // Le message RCS se vide comme le contenu WhatsApp. L'agent NON, par symétrie avec `phoneNumberId` :
    // c'est l'expéditeur, il ne change pas d'une campagne à l'autre. Sans ce vidage, un opérateur qui
    // enchaîne deux campagnes RCS retrouve le texte de la précédente pré-rempli et peut le renvoyer sans le voir.
    setRcsText('');
    setWfError(null);
    setError(null);
    setOk(null);
    setRatePerMinute(60); // retour au débit par défaut (jauge à 60/min)
    setTiming('now');
    setScheduledLocal('');
    setLaunch({ phase: 'idle' });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await createCampaign(tenantId, buildCreateInput());
      // 0 destinataire = TOUS sautés (la variable du template n'a aucune valeur sur les fiches choisies) : la campagne
      // serait vide et « Lancer » n'enverrait à personne. Avertissement ROUGE + on RESTE sur le formulaire (pas de
      // navigation, pas de reset) pour corriger la source de la variable ou les fiches. Cf. bug « ça n'envoie à personne ».
      // Les écarts ont DEUX motifs, qui n'appellent pas la même correction : une variable de template sans
      // valeur sur la fiche, ou un contact sans opt-in sur une campagne marketing. Les confondre envoyait
      // l'opérateur corriger des fiches alors que le problème était le consentement.
      const detail = detailEcartes(res.skipped);

      if (res.recipientCount === 0) {
        setError(messageAucunDestinataire(res.skipped));
        return; // le finally remet busy à false
      }
      // L'envoi part quand même aux valides ; les écartés sont NOMMÉS avec leur motif.
      const skippedMsg = res.skipped.length > 0
        ? t(` ${res.skipped.length} contact(s) écartés (${detail}).`, ` ${res.skipped.length} contact(s) skipped (${detail}).`)
        : '';
      setOk(t(
        `Campagne créée : ${res.recipientCount} destinataire(s).${skippedMsg} Clique « Lancer » pour envoyer.`,
        `Campaign created: ${res.recipientCount} recipient(s).${skippedMsg} Click "Launch" to send.`,
      ));
      setName('');
      setTemplateName('');
      setVars([]);
      setWorkflowId('');
      setWfError(null);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible', 'Creation failed'));
    } finally {
      setBusy(false);
    }
  }

  // Créer PUIS lancer sur place (étape 2), sans repasser par la liste. Mini-polling inline (6 tours / 2s) pour
  // voir les statuts évoluer, comme CampaignsInner.run(). L'utilisateur reste sur l'écran pour voir le résultat.
  async function createAndLaunch() {
    setError(null);
    setOk(null);
    setLaunch({ phase: 'creating' });
    try {
      const res = await createCampaign(tenantId, buildCreateInput());
      // 0 destinataire = tous sautés : même avertissement ROUGE que le brouillon, on NE lance PAS et on reste.
      if (res.recipientCount === 0) {
        setError(messageAucunDestinataire(res.skipped));
        setLaunch({ phase: 'idle' });
        return;
      }
      setLaunch({ phase: 'launching', campaignId: res.campaignId });
      await runCampaign(res.campaignId);
      let detail: CampaignDetail | undefined;
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!mountedRef.current) return; // écran quitté pendant le polling -> on cesse tout (fetch + setState)
        detail = await getCampaign(tenantId, res.campaignId);
        if (!mountedRef.current) return;
        setLaunch({ phase: 'launching', campaignId: res.campaignId, detail });
      }
      const sent = detail?.counts.sent ?? 0;
      const failed = detail?.counts.failed ?? 0;
      setLaunch({
        phase: 'done',
        campaignId: res.campaignId,
        detail,
        message: t(`Campagne lancée : ${sent} envoyés / ${failed} échecs.`, `Campaign launched: ${sent} sent / ${failed} failures.`),
      });
    } catch (err) {
      setLaunch({ phase: 'error', message: err instanceof Error ? err.message : t('Lancement impossible', 'Launch failed') });
    }
  }

  // Créer PUIS programmer un lancement futur (étape 2, timing 'later'). Pas de polling : on confirme la
  // programmation et on laisse le worker déclencher l'envoi à l'échéance. La date locale saisie est convertie
  // en ISO UTC absolu ici, au moment de l'action.
  async function createAndSchedule() {
    const scheduledISO = new Date(scheduledLocal).toISOString();
    setError(null);
    setOk(null);
    setLaunch({ phase: 'creating' });
    try {
      const res = await createCampaign(tenantId, buildCreateInput());
      // 0 destinataire = tous sautés : même avertissement ROUGE que le brouillon, on NE programme PAS et on reste.
      if (res.recipientCount === 0) {
        setError(messageAucunDestinataire(res.skipped));
        setLaunch({ phase: 'idle' });
        return;
      }
      const r = await runCampaign(res.campaignId, scheduledISO);
      if (!mountedRef.current) return; // écran quitté entre-temps -> on cesse tout setState
      const when = new Date(r.scheduledAt ?? scheduledISO).toLocaleString();
      setLaunch({
        phase: 'scheduled',
        campaignId: res.campaignId,
        message: t(`Campagne planifiée le ${when}.`, `Campaign scheduled for ${when}.`),
      });
    } catch (err) {
      setLaunch({ phase: 'error', message: err instanceof Error ? err.message : t('Programmation impossible', 'Scheduling failed') });
    }
  }

  // Le sélecteur garantit une source valide (champ de base ou champ perso réel) : seul « Texte fixe » exige
  // une valeur saisie. On bloque l'envoi tant qu'un texte fixe est vide (sinon 400 côté backend).
  const varsComplete = vars.every((v) => (v.sel === 'literal' ? v.value.trim() !== '' : true));
  // Workflow : prêt si un workflow valide est choisi (il OUVRE par un template, donc pas de wfError) ET le mapping de ses
  // variables est complet. Le 1er template sans variable a vars=[] -> varsComplete=true.
  const contentReady = mode === 'rcs'
    ? (rcsAgentId !== '' && rcsText.trim() !== '')
    : mode === 'workflow'
      ? (workflowId !== '' && wfError === null && varsComplete)
      : (templateName !== '' && varsComplete);
  // Nommer la campagne est un PRÉALABLE (étape 0) : tant que c'est vide, les zones Destinataires/Message sont grisées.
  const nameSet = name.trim() !== '';
  // Étape 1 prête = ce qui active l'étape 2 (indépendant du busy/launch en cours).
  // Le numéro Meta n'est exigé que sur WhatsApp : une campagne RCS part d'un agent de marque.
  const step1Ready = (mode === 'rcs' || phoneNumberId !== '') && nameSet && contentReady && selected.size > 0;
  const canSubmit = step1Ready && !busy;
  // Lancement en cours (création + polling) : verrouille les boutons des deux étapes. Couvre aussi la phase
  // 'creating' de la programmation (créer + programmer), donc le retour liste est gelé pendant l'opération.
  const launching = launch.phase === 'creating' || launch.phase === 'launching';
  // Validation UI de la programmation : date renseignée, valide, et STRICTEMENT dans le futur (au rendu).
  const scheduledDate = timing === 'later' && scheduledLocal ? new Date(scheduledLocal) : null;
  const scheduledValid = scheduledDate !== null && !Number.isNaN(scheduledDate.getTime()) && scheduledDate.getTime() > Date.now();
  // Remonte l'état « lancement en cours » au parent (fige le retour liste pendant creating/launching).
  useEffect(() => { onBusyChange?.(launching); }, [launching, onBusyChange]);

  return (
    <div className="space-y-6">
      {/* ÉTAPE 1 : Préparation : nom + les 3 zones existantes (contenu inchangé, juste déplacé ici). */}
      <section className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t('Étape 1', 'Step 1')}</p>
        <h2 className="mt-0.5 text-base font-semibold tracking-tight text-ink-900">{t('Préparation', 'Preparation')}</h2>
        <p className="mt-1 text-xs text-ink-500">{t('Choisis un template approuvé et les contacts.', 'Choose an approved template and contacts.')}</p>

      {/* ÉTAPE 0 : nommer la campagne AVANT tout. Tant que c'est vide, les zones Destinataires/Message sont grisées. */}
      <div className="mt-4">
        <label className="mb-1 block text-sm font-medium text-ink-700">
          {t('Nom de la campagne (interne)', 'Campaign name (internal)')} <span className="text-red-500">*</span>
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="campaign-name"
          autoFocus
          className={`${inputCls} max-w-md ${!nameSet ? 'border-brand-400 ring-2 ring-brand-100' : ''}`}
          placeholder={t('Promo été', 'Summer promo')}
        />
        {!nameSet && <p className="mt-1 text-xs text-brand-600">{t('Donne un nom à ta campagne pour continuer.', 'Name your campaign to continue.')}</p>}
      </div>

      {/* Expéditeur : bandeau PLEINE LARGEUR au-dessus des 2 zones (le numéro est en général unique).
          En RCS l'expéditeur n'est pas un numéro mais un AGENT DE MARQUE : le sélecteur change de nature,
          il ne se contente pas d'être masqué. */}
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-ink-50/30 px-4 py-3">
        <h3 className="text-sm font-semibold text-ink-800">{t('Expéditeur', 'Sender')}</h3>
        {mode === 'rcs' ? (
          rcsAgents.length === 0 ? (
            <p className="text-xs text-amber-700" data-testid="rcs-no-agent">
              {t("Aucun agent RCS pour ce workspace. Le canal RCS n'est pas encore configuré.", 'No RCS agent for this workspace. The RCS channel is not configured yet.')}
            </p>
          ) : (
            <select value={rcsAgentId} onChange={(e) => setRcsAgentId(e.target.value)} data-testid="rcs-agent-select" className={`${inputCls} max-w-xs`}>
              <option value="">{t('Choisir un agent…', 'Choose an agent…')}</option>
              {rcsAgents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.brandName}{a.status !== 'launched' ? ` (${t('non lancé', 'not launched')})` : ''}
                </option>
              ))}
            </select>
          )
        ) : numbers.length === 0 ? (
          <p className="text-xs text-amber-700">{t('Aucun numéro provisionné pour ce tenant.', 'No number provisioned for this tenant.')}</p>
        ) : numbers.length === 1 ? (
          <span className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-800">
            <span className="font-medium">{numbers[0]!.displayPhoneNumber ?? numbers[0]!.id}</span>
            {numbers[0]!.verifiedName && <span className="ml-2 text-xs text-ink-400">{numbers[0]!.verifiedName}</span>}
          </span>
        ) : (
          <select value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} className={`${inputCls} max-w-xs`}>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayPhoneNumber ?? n.id} {n.verifiedName ? `(${n.verifiedName})` : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Destinataires + Message : 2 colonnes PLEINE LARGEUR. Grisées tant que la campagne n'a pas de nom (étape 0). */}
      <div className={`mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 ${!nameSet ? 'pointer-events-none select-none opacity-40' : ''}`} aria-disabled={!nameSet}>
        {/* ZONE 2 : Destinataires : source (liste CRM / fichier / HubSpot) + filtres du mini-CRM */}
        <div className="rounded-xl border border-ink-200 p-4">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium text-ink-700">{t('Destinataires', 'Recipients')}</label>
          {/* Y = total réel (compteur serveur), pas le nombre de contacts affichés. */}
          {source === 'crm' && total !== null && (
            <span className="text-xs text-ink-400">{selected.size} / {total} {t('sélectionnés', 'selected')}</span>
          )}
        </div>

        {/* Sélecteur de SOURCE des destinataires (segmenté, comme le toggle template/scénario). */}
        <div className="mb-3 inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-sm">
          {/* Boutons de source gelés pendant un import en vol (changer de source démonterait CsvImport et sa
              requête, la sélection pivoterait sur un état obsolète). */}
          <button type="button" disabled={importBusy} onClick={() => chooseSource('crm')} className={`rounded-md px-2.5 py-1 disabled:opacity-40 ${source === 'crm' ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}>
            📇 {t('Liste de contacts', 'Contact list')}
          </button>
          <button type="button" disabled={importBusy} onClick={() => chooseSource('file')} className={`rounded-md px-2.5 py-1 disabled:opacity-40 ${source === 'file' ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}>
            📄 {t('Import fichier', 'File import')}
          </button>
          <button
            type="button"
            disabled={importBusy || !hubspotListsEnabled || hubspotPaused}
            onClick={() => chooseSource('hubspot')}
            title={
              hubspotPaused
                ? t("Synchronisation HubSpot en pause. Réactive-la sur l'accueil.", 'HubSpot sync is paused. Re-enable it on the home page.')
                : hubspotListsEnabled ? undefined : t('Active « Campagnes via données HubSpot » sur l\'accueil', 'Enable "Campaigns from HubSpot data" on the home page')
            }
            className={`rounded-md px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${source === 'hubspot' ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
          >
            🔗 {t('HubSpot', 'HubSpot')}
          </button>
        </div>

        {source === 'file' ? (
          <CsvImport tenantId={tenantId} requireTag onImported={handleImported} onBusyChange={setImportBusy} />
        ) : source === 'hubspot' ? (
          <HubspotListImport tenantId={tenantId} onImported={handleImported} onBusyChange={setImportBusy} />
        ) : loadingRefs ? (
          <p className="text-xs text-ink-400">{t('Chargement des contacts...', 'Loading contacts...')}</p>
        ) : (
          <div>
            {/* Récap d'import (non bloquant) : rappelle N importés + le(s) tag(s) posé(s), qui filtrent la liste.
                Masqué dès que l'utilisateur modifie un filtre (le récap ne décrit plus la sélection affichée). */}
            {importMsgFresh && importMsg && (
              <div className="mb-2 flex items-start justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                <span>
                  <b>{importMsg.n}</b> {t('contact(s) importé(s) et taggé(s)', 'contact(s) imported and tagged')} « {importMsg.tags.join(', ')} ». {t('Ils sont sélectionnés ci-dessous.', 'They are selected below.')}
                </span>
                <button type="button" onClick={() => setImportMsg(null)} className="shrink-0 leading-none text-emerald-500 hover:text-emerald-800" aria-label={t('Fermer', 'Close')}>×</button>
              </div>
            )}
            {/* Recherche/filtres : composant PARTAGÉ avec le mini-CRM (une seule implémentation, pas deux moteurs). */}
            <div className="mb-2">
              <ContactFilterPanel
                filters={filters}
                onChange={setFilters}
                userFields={userFields}
                tagSuggestions={tags.map((tc) => tc.tag)}
                onClear={() => setFilters({})}
              />
            </div>

            {/* Compteur live (débounce) + contrôles de sélection sur gros volumes. */}
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700">
                {countLoading || total === null ? t('… contacts', '… contacts') : t(`${total} contact(s) correspondent`, `${total} contact(s) match`)}
              </span>
              {total !== null && total > contacts.length && (
                <>
                  <span className="text-ink-400">{t(`${contacts.length} affichés sur ${total} au total`, `${contacts.length} shown of ${total} total`)}</span>
                  <button type="button" onClick={selectAllMatching} className="rounded-lg border border-brand-300 bg-brand-50 px-2 py-0.5 font-medium text-brand-700 hover:bg-brand-100">
                    {t(`Tout sélectionner (${total})`, `Select all (${total})`)}
                  </button>
                </>
              )}
              <button type="button" onClick={() => setSelected(new Set())} className="rounded-lg border border-ink-300 px-2 py-0.5 text-ink-600 hover:bg-ink-50">{t('Vider', 'Clear')}</button>
            </div>

            {/* Liste des contacts correspondants (<= 500 affichés) : cocher/décocher affine la sélection. */}
            <div className="max-h-[22rem] divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
              {contacts.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-ink-50">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleContact(c.id)} className="accent-brand-500" />
                  <span className="truncate text-sm">{c.profileName ?? contactIdentity(c)}</span>
                  {(c.tags ?? []).slice(0, 3).map((tag) => (
                    <span key={tag} className="shrink-0 rounded bg-brand-50 px-1 text-[10px] text-brand-700">{tag}</span>
                  ))}
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-400">{c.phoneE164 ?? <span title={t('Compte WhatsApp (sans numéro)', 'WhatsApp account (no number)')}>{c.bsuid}</span>}</span>
                  {c.optInStatus === 'opted_out' && <span className="shrink-0 rounded bg-red-50 px-1 text-[10px] text-red-600">opt-out</span>}
                </label>
              ))}
              {contacts.length === 0 && (
                <p className="px-2.5 py-3 text-xs text-ink-400">
                  {countLoading ? t('Chargement…', 'Loading…')
                    : hasActiveFilters ? t('Aucun contact ne correspond aux filtres.', 'No contact matches the filters.')
                    : t("Aucun contact joignable. Importe des contacts dans l'onglet Contacts.", 'No reachable contact. Import contacts in the Contacts tab.')}
                </p>
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-400">{t('Les contacts opt-out sont ignorés automatiquement pour le marketing.', 'Opted-out contacts are automatically skipped for marketing.')}</p>
          </div>
        )}
      </div>

        {/* ZONE 3 : Message : un template direct OU un scénario (bot builder) */}
        <div className="rounded-xl border border-ink-200 p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink-800">{t('Message', 'Message')}</h3>
          <div className="mt-1">
        <label className="mb-1 block text-sm font-medium text-ink-700">{t('Que veux-tu leur envoyer ?', 'What do you want to send them?')}</label>
        <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-sm">
          {([
            { m: 'template', label: t('Un template', 'A template'), tip: t('Privilégiez cela pour l’envoi d’un message simple avec un ou des boutons (CTA) qui pointent vers des URL. Si le client répond, le Meta Business Agent prend le relais.', 'Best for sending a simple message with one or more buttons (CTA) that point to URLs. If the customer replies, the Meta Business Agent takes over.') },
            { m: 'workflow', label: t('Un scénario', 'A scenario'), tip: t('Privilégiez cette méthode pour enchaîner plusieurs étapes : envoi d’un template PUIS d’autres éléments (ajout d’un tag, d’un champ, envoi d’un formulaire, ...).', 'Best for chaining several steps: sending a template THEN other elements (adding a tag, a field, sending a form, ...).') },
            { m: 'rcs', label: t('Un message RCS', 'An RCS message'), tip: t('Autre CANAL : le message part sous votre agent de marque, sans template à faire approuver et sans fenêtre de 24 h. Seuls les contacts joignables en RCS sont servis, les autres sont comptés « ignorés ».', 'A different CHANNEL: the message goes out under your brand agent, with no template to get approved and no 24h window. Only contacts reachable on RCS are served, the others are counted as skipped.') },
          ] as const).map(({ m, label, tip }) => (
            <span key={m} className="group relative">
              <button type="button" onClick={() => chooseMode(m)} className={`rounded-md px-3 py-1 ${mode === m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}>{label}</button>
              <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-64 -translate-x-1/2 rounded-lg bg-ink-900 px-3 py-2 text-xs font-normal leading-snug text-white shadow-lg group-hover:block">{tip}</span>
            </span>
          ))}
        </div>
      </div>

      {mode === 'rcs' ? (
        <Field label={t('Message RCS', 'RCS message')}>
          <textarea
            value={rcsText}
            onChange={(e) => setRcsText(e.target.value)}
            rows={5}
            maxLength={3072}
            data-testid="rcs-message"
            placeholder={t('Votre message…', 'Your message…')}
            className={inputCls}
          />
          <p className="mt-1 text-[11px] text-ink-400">
            {t('Pas de template ni de variables : le message part tel quel, sous votre agent de marque.', 'No template and no variables: the message goes out as written, under your brand agent.')}
          </p>
          <p className="mt-1 text-[11px] text-amber-700">
            {t('Les contacts non joignables en RCS ne reçoivent RIEN et sont comptés « ignorés » dans le rapport. Pour les rattraper, passez par un scénario avec un bloc RCS et sa sortie « Non joignable ».', 'Contacts not reachable on RCS receive NOTHING and are counted as skipped in the report. To catch them, use a scenario with an RCS block and its “Not reachable” output.')}
          </p>
        </Field>
      ) : mode === 'template' ? (
        <>
          <Field label={t('Template', 'Template')}>
            {loadingRefs ? (
              <p className="text-xs text-ink-400">{t('Chargement des templates...', 'Loading templates...')}</p>
            ) : templates.length === 0 ? (
              <p className="text-xs text-amber-700">{t("Aucun template approuvé. Crée-en un dans l'onglet Templates et attends la validation Meta.", 'No approved template. Create one in the Templates tab and wait for Meta approval.')}</p>
            ) : (
              <select value={templateName} onChange={(e) => { void chooseTemplate(e.target.value); }} className={inputCls}>
                <option value="">{t('Choisir un template...', 'Choose a template...')}</option>
                {templates.map((tpl) => (
                  <option key={`${tpl.name}-${tpl.language}`} value={tpl.name}>
                    {tpl.name} ({tpl.language}, {tpl.category?.toLowerCase()})
                  </option>
                ))}
              </select>
            )}
            {selectedTemplate?.body && (
              <div className="mt-3">
                <TemplatePreview template={selectedTemplate} examples={previewExamples} />
              </div>
            )}

            {/* Créer un template sans quitter la campagne. Modèle : la création inline d'un formulaire depuis le
                sélecteur de bouton FLOW, écran Templates. Une différence CHANGE tout ici : un template neuf revient
                PENDING, or ce select ne liste que les APPROVED. On ne l'injecte donc PAS dans la liste (il serait
                sélectionnable et inenvoyable, l'échec arriverait plus tard chez Meta, illisible). On affiche à la
                place ce qui vient de se passer, et on NOMME l'attente : le bouton n'a jamais l'air cassé. */}
            {!loadingRefs && !creatingTemplate && !submittedTemplate && (
              <button type="button" onClick={() => setCreatingTemplate(true)} className="mt-2 text-xs text-brand-600 hover:underline">
                ＋ {t('Créer un nouveau template', 'Create a new template')}
              </button>
            )}
            {submittedTemplate && (
              <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-4">
                <p className="text-sm font-medium text-ink-900">
                  {t('Template', 'Template')} « {submittedTemplate.name} » {t('soumis', 'submitted')} ({t('statut', 'status')} : {submittedTemplate.status}).
                </p>
                <p className="mt-1 text-xs text-ink-600">
                  {t(
                    "Il passe en revue chez Meta. Il apparaîtra dans cette liste une fois approuvé : une campagne ne peut partir qu'avec un template déjà approuvé.",
                    'It goes through Meta review. It will show up in this list once approved: a campaign can only run with an already-approved template.',
                  )}
                </p>
                <div className="mt-2 flex items-center gap-3">
                  <button type="button" onClick={() => { void reloadTemplates(); }} className="text-xs text-brand-600 hover:underline">
                    {t('Rafraîchir la liste', 'Refresh the list')}
                  </button>
                  <button type="button" onClick={() => setSubmittedTemplate(null)} className="text-xs text-ink-500 hover:underline">
                    {t('Fermer', 'Close')}
                  </button>
                </div>
              </div>
            )}
            {creatingTemplate && (
              <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-4">
                <TemplateForm
                  tenantId={tenantId}
                  onCreated={(created) => { setCreatingTemplate(false); if (created) setSubmittedTemplate(created); }}
                />
                <button type="button" onClick={() => setCreatingTemplate(false)} className="mt-2 text-xs text-ink-500 hover:underline">
                  {t('Annuler', 'Cancel')}
                </button>
              </div>
            )}
          </Field>

          <VarsEditor vars={vars} setVars={setVars} fields={userFields} />
        </>
      ) : (
        <>
          <Field label={t("Catégorie (pour l'opt-in)", 'Category (for opt-in)')}>
            <select value={category} onChange={(e) => setCategory(e.target.value as 'marketing' | 'utility')} className={inputCls}>
              <option value="marketing">{t('Marketing (opt-in requis)', 'Marketing (opt-in required)')}</option>
              <option value="utility">{t('Utility', 'Utility')}</option>
            </select>
          </Field>
          <Field label={t('Scénario', 'Scenario')}>
            {workflows.length === 0 ? (
              <p className="text-xs text-amber-700" data-testid="wf-none">
                {workflowsTotal === 0
                  ? t('Aucun scénario. Crée-en un dans le menu « Scénario » à gauche.', 'No scenario. Create one from the "Scenario" menu on the left.')
                  : t(
                      "Aucun scénario utilisable en campagne : une campagne part sur une audience froide, donc le PREMIER message envoyé doit être un template configuré (un tag, une action ou une condition avant lui ne posent aucun problème). Tes autres scénarios restent utilisables quand le contact vient d'écrire.",
                      'No scenario usable in a campaign: a campaign targets a cold audience, so the FIRST message sent must be a configured template (a tag, an action or a condition before it is fine). Your other scenarios remain usable when the contact has just written.',
                    )}
              </p>
            ) : (
              <select value={workflowId} onChange={(e) => { void chooseWorkflow(e.target.value); }} className={inputCls}>
                <option value="">{t('Choisir un scénario…', 'Choose a scenario…')}</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} ({w.graph.nodes.length} {w.graph.nodes.length > 1 ? t('blocs', 'blocks') : t('bloc', 'block')})</option>
                ))}
              </select>
            )}
            {/* Le workflow doit OUVRIR par un envoi de template : c'est lui qui porte les variables à associer. */}
            {wfError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{wfError}</p>}
            {!wfError && selectedTemplate?.body && (
              <div className="mt-3">
                <p className="mb-1 text-xs text-ink-500">{t('1er template envoyé par le scénario :', 'First template sent by the scenario:')} <b>{templateName}</b></p>
                {/* Le 1er bloc du scénario peut être un CAROUSEL : on montre alors ses vraies cartes, pas un
                    encadré de texte qui ne dit rien de ce que le contact recevra. */}
                <TemplatePreview template={selectedTemplate} examples={previewExamples} />
              </div>
            )}
          </Field>

          {/* Association des variables du 1er template du scénario (même sélecteur que pour un template direct). */}
          {!wfError && <VarsEditor vars={vars} setVars={setVars} fields={userFields} />}
        </>
      )}
        </div>
      </div>

      {/* Débit d'envoi : jauge TOUJOURS active (défaut 60/min, réglable 1..80). Grisée tant que la campagne n'a pas de nom.
          Placée après le grid pour disposer de la sélection (durée estimée sur selected.size). */}
      <div className={`mt-4 rounded-xl border border-ink-200 p-4 ${!nameSet ? 'pointer-events-none select-none opacity-40' : ''}`} aria-disabled={!nameSet}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-ink-700">{t("Débit d'envoi", 'Sending rate')}</h3>
          <span className="shrink-0 text-sm font-semibold text-ink-800">{ratePerMinute} {t('messages / min', 'messages / min')}</span>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={80}
            step={1}
            value={ratePerMinute}
            onChange={(e) => setRatePerMinute(Number(e.target.value))}
            data-testid="campaign-rate"
            className="flex-1 accent-brand-500"
          />
        </div>
        {selected.size > 0 && (
          <p className="mt-2 text-xs text-ink-500">
            {t(`~${Math.ceil(selected.size / ratePerMinute)} min pour envoyer ${selected.size} message(s)`, `~${Math.ceil(selected.size / ratePerMinute)} min to send ${selected.size} message(s)`)}
          </p>
        )}
        <p className="mt-2 text-[11px] text-ink-400">
          {t('Défaut 60/min. Plafond 80/min (limite WhatsApp) ; baisser le débit protège la réputation du numéro.', 'Default 60/min. Cap 80/min (WhatsApp limit); lowering the rate protects the number reputation.')}
        </p>
      </div>

      {/* Avertissements de préparation : restent en bas de l'étape 1 (variables incomplètes, erreur de création). */}
      {!varsComplete && <p className="mt-3 text-xs text-amber-600">{t('Complète les valeurs des variables (champ perso / texte fixe).', 'Complete the variable values (custom field / fixed text).')}</p>}
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </section>

      {/* ÉTAPE 2 (Lancement) : grisée tant que l'étape 1 n'est pas prête. Le lancement « maintenant » s'exécute ici. */}
      <section className={`rounded-2xl border border-ink-200 bg-white p-6 shadow-sm transition ${step1Ready ? '' : 'opacity-60'}`} aria-disabled={!step1Ready}>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t('Étape 2', 'Step 2')}</p>
        <h2 className="mt-0.5 text-base font-semibold tracking-tight text-ink-900">{t('Lancement', 'Launch')}</h2>

        {!step1Ready ? (
          <p className="mt-1 text-xs text-ink-500">{t("Complète l'étape 1 pour activer le lancement.", 'Complete step 1 to enable launching.')}</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-700">{t(`Prêt à lancer à ${selected.size} destinataire(s).`, `Ready to launch to ${selected.size} recipient(s).`)}</p>

            {/* Timing : lancer maintenant OU programmer un envoi futur. 'later' révèle un sélecteur date/heure. */}
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-ink-700">{t('Quand ?', 'When?')}</label>
              <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-sm">
                {([
                  ['now', t('Maintenant', 'Now')],
                  ['later', t('Plus tard', 'Later')],
                ] as const).map(([val, label]) => (
                  <button
                    type="button"
                    key={val}
                    onClick={() => setTiming(val)}
                    disabled={launching}
                    className={`rounded-md px-3 py-1 disabled:opacity-40 ${timing === val ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {timing === 'later' && (
                <div className="mt-3">
                  <input
                    type="datetime-local"
                    value={scheduledLocal}
                    onChange={(e) => setScheduledLocal(e.target.value)}
                    disabled={launching}
                    className={`${inputCls} max-w-xs disabled:opacity-40`}
                  />
                  <p className="mt-1 text-xs text-ink-500">{t('Le lancement partira automatiquement à cette date/heure.', 'The launch will go out automatically at this date/time.')}</p>
                  {scheduledLocal !== '' && !scheduledValid && (
                    <p className="mt-1 text-xs text-amber-600">{t('Choisis une date et une heure dans le futur.', 'Choose a date and time in the future.')}</p>
                  )}
                </div>
              )}
            </div>

            {/* Progression / résultat du lancement inline (compteurs rafraîchis par le polling). */}
            {launch.phase !== 'idle' && (
              <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50/40 p-4 text-sm">
                {launch.phase === 'creating' && <p className="text-ink-600">{t('Création de la campagne...', 'Creating the campaign...')}</p>}
                {launch.phase === 'launching' && (
                  <div>
                    <div className="flex items-center gap-1.5 text-ink-600">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                      {t('Envoi en cours...', 'Sending...')}
                    </div>
                    {launch.detail && <LaunchCounts counts={launch.detail.counts} />}
                  </div>
                )}
                {launch.phase === 'done' && (
                  <div>
                    <p className="font-medium text-emerald-800">{launch.message}</p>
                    {launch.detail && <LaunchCounts counts={launch.detail.counts} />}
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => onCreated()}
                        className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
                      >
                        {t('Voir dans les campagnes', 'View in campaigns')}
                      </button>
                      <button
                        type="button"
                        onClick={resetForm}
                        className="rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
                      >
                        {t('Nouvelle campagne', 'New campaign')}
                      </button>
                    </div>
                  </div>
                )}
                {launch.phase === 'scheduled' && (
                  <div>
                    <p className="font-medium text-violet-800">{launch.message}</p>
                    <p className="mt-1 text-xs text-ink-500">{t('Elle partira automatiquement à la date prévue. Tu peux annuler la planification depuis la liste.', 'It will go out automatically at the scheduled time. You can cancel the schedule from the list.')}</p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => onCreated()}
                        className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
                      >
                        {t('Voir dans les campagnes', 'View in campaigns')}
                      </button>
                      <button
                        type="button"
                        onClick={resetForm}
                        className="rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
                      >
                        {t('Nouvelle campagne', 'New campaign')}
                      </button>
                    </div>
                  </div>
                )}
                {launch.phase === 'error' && <p className="text-red-700">{launch.message}</p>}
              </div>
            )}

            {/* Boutons d'action : masqués une fois le lancement/programmation terminé (les boutons de suite prennent
                le relais). Le bouton primaire dépend du timing : « Créer et lancer » (now) ou « Créer et planifier »
                (later, actif seulement si la date est dans le futur). Le brouillon reste disponible dans les deux cas. */}
            {launch.phase !== 'done' && launch.phase !== 'scheduled' && (
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                {timing === 'now' ? (
                  <button
                    type="button"
                    onClick={createAndLaunch}
                    disabled={!canSubmit || launching}
                    className="flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {launch.phase === 'creating' ? t('Création...', 'Creating...') : launch.phase === 'launching' ? t('Lancement...', 'Launching...') : t('Créer et lancer', 'Create and launch')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={createAndSchedule}
                    disabled={!canSubmit || launching || !scheduledValid}
                    className="flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {launch.phase === 'creating' ? t('Programmation...', 'Scheduling...') : t('Créer et planifier', 'Create and schedule')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSubmit || launching}
                  className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
                >
                  {busy ? t('Création...', 'Creating...') : t('Créer le brouillon (lancer plus tard)', 'Create draft (launch later)')}
                </button>
              </div>
            )}
            {ok && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</p>}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Compteurs sent/failed/pending/skipped d'une campagne. Servent au lancement en ligne (étape 2) ET à la liste
 * des campagnes, qui en recopiait le JSX au lieu de l'appeler : `className` absorbe le seul écart entre les
 * deux (marge et nuance de gris).
 */
export function LaunchCounts({ counts, className = 'mt-2 text-xs text-ink-600' }: { counts: RecipientCounts; className?: string }) {
  const t = useT();
  return (
    <p className={className}>
      <b className="text-emerald-700">{counts.sent}</b> {t('envoyés', 'sent')}
      {counts.failed > 0 && <> · <b className="text-red-700">{counts.failed}</b> {t('échecs', 'failures')}</>}
      {counts.pending > 0 && <> · {counts.pending} {t('en attente', 'pending')}</>}
      {counts.skipped > 0 && <> · {counts.skipped} {t('ignorés', 'skipped')}</>}
    </p>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-sm font-medium text-ink-700">{label}</label>
      {children}
    </div>
  );
}

/** Sélecteur d'association des variables d'un template : chaque variable pointe vers un champ de BASE (Nom, Prénom,
 *  Téléphone, BSUID, WhatsApp ID, Email), un CHAMP PERSO réel (Contenu > Champs) ou un TEXTE FIXE. Plus de clé tapée
 *  à la main -> plus de mapping vers un champ inexistant. Partagé par le mode template direct et le 1er template d'un
 *  workflow. Rien à afficher si le template n'a pas de variable. */
function VarsEditor({ vars, setVars, fields }: { vars: VarRow[]; setVars: React.Dispatch<React.SetStateAction<VarRow[]>>; fields: UserFieldDef[] }) {
  const t = useT();
  if (vars.length === 0) return null;
  const custom = customFieldsOnly(fields);
  // Ids d'options valides : sert de filet -> si un `sel` n'y est pas (ex. champ perso supprimé), on l'affiche
  // explicitement (« à re-sélectionner ») au lieu de laisser le <select> montrer la 1re option en douce.
  const validIds = new Set<string>([...SYSTEM_FIELDS.map((f) => `sys:${f.key}`), ...custom.map((f) => `field:${f.key}`), 'literal', 'now']);
  return (
    <div className="mt-3">
      <label className="mb-1 block text-sm font-medium text-ink-700">{t('Variables', 'Variables')} ({vars.length})</label>
      <div className="space-y-2">
        {vars.map((v, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-8 shrink-0 text-xs text-ink-400">{`{{${i + 1}}}`}</span>
            <select
              value={v.sel}
              onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, sel: e.target.value } : x)))}
              className={`${inputCls} flex-1`}
            >
              {!validIds.has(v.sel) && <option value={v.sel}>{t('⚠ champ à re-sélectionner', '⚠ field to re-select')}</option>}
              <optgroup label={t('Champs de base', 'Base fields')}>
                {SYSTEM_FIELDS.map((f) => <option key={f.key} value={`sys:${f.key}`}>{f.label}</option>)}
              </optgroup>
              {custom.length > 0 && (
                <optgroup label={t('Mes champs', 'My fields')}>
                  {custom.map((f) => <option key={f.key} value={`field:${f.key}`}>{f.label}</option>)}
                </optgroup>
              )}
              <optgroup label={t('Autre', 'Other')}>
                <option value="now">{t('Date du jour (auto)', "Today's date (auto)")}</option>
                <option value="literal">{t('Texte fixe', 'Fixed text')}</option>
              </optgroup>
            </select>
            {v.sel === 'literal' && (
              <input
                value={v.value}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                className={`${inputCls} w-32`}
                placeholder={t('valeur', 'value')}
              />
            )}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-ink-400">
        {t("D'où vient chaque variable. « Mes champs » = tes champs de Contenu > Champs. Un contact sans la valeur choisie est sauté (et signalé).", 'Where each variable comes from. "My fields" = your fields from Content > Fields. A contact without the chosen value is skipped (and flagged).')}
      </p>
    </div>
  );
}
