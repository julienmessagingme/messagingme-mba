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
import { versMessageRcs, versBrouillonRcs, maxTexteRcs, MAX_BOUTONS_CARTE, MAX_BOUTONS_RCS } from '@/lib/rcs';
import { boutonPret } from '@/lib/rcs-boutons';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import {
  createCampaign,
  createCampaignDraft,
  updateCampaignDraft,
  deleteCampaignDraft,
  type CampaignDraft,
  runCampaign,
  listTemplates,
  listWorkflows,
  getWorkflow,
  listUserFields,
  listTags,
  listRcsAgents,
  listRcsMessages,
  queryContacts,
  countContacts,
  getTemplateHints,
  getSettings,
  getCampaign,
  contactIdentity,
  listWebhooks,
  type WebhookEntrant,
  type UserFieldDef,
  type CreateCampaignInput,
  type RecipientCounts,
  type PhoneNumber,
  type RcsAgent,
  type RcsMessage,
  type RcsSuggestion,
  type TemplateParam,
  type TemplateSummary,
  type Contact,
  type ImportReport,
  type ContactFilters,
  type TagCount,
  type CampaignDetail,
  type WorkflowSummary,
} from '@/lib/api';
import { SYSTEM_FIELDS, customFieldsOnly, isSystemFieldKey, systemFieldExample, varCountOf } from '@/lib/fields';
import { filtersActive } from '@/lib/contact-filters';
import { firstTemplateOf } from '@/lib/campaign-eligibility';
import { useCampagneReferences } from '@/lib/use-campagne-references';
/**
 * D'où viennent les destinataires. `crm` et `file` désignent une liste FIGÉE ; `hubspot` aussi, ailleurs.
 * `webhook` est d'une autre nature : il n'y a pas de liste du tout, les destinataires arrivent au fil de
 * l'eau et la campagne reste ouverte jusqu'à ce qu'on l'arrête.
 */
type SourceDestinataires = 'crm' | 'file' | 'hubspot' | 'webhook';

/** Les deux sources rangées derrière le bouton « Autre » (elles ne servent pas au cas courant). */
const SOURCES_AUTRES: readonly SourceDestinataires[] = ['hubspot', 'webhook'];

function estSourceDestinataires(v: unknown): v is SourceDestinataires {
  return v === 'crm' || v === 'file' || v === 'hubspot' || v === 'webhook';
}

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

/**
 * Délai avant qu'un changement de l'écran parte dans le brouillon.
 *
 * Assez court pour qu'un aller-retour dans un autre onglet ne perde rien, assez long pour que cocher dix
 * contacts ne fasse pas dix écritures : le plafond de débit des routes authentifiées est partagé avec tout
 * le reste de la console.
 */
const DELAI_SAUVEGARDE_MS = 1200;

export function CampaignCreateForm({ tenantId, numbers, onCreated, onBusyChange, rcsEnabled = false, draft }: { tenantId: string; numbers: PhoneNumber[]; onCreated: () => void; onBusyChange?: (busy: boolean) => void; rcsEnabled?: boolean; draft?: CampaignDraft }) {
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
  const [rcsImage, setRcsImage] = useState('');
  const [rcsBoutons, setRcsBoutons] = useState<RcsSuggestion[]>([]);
  const [rcsAgents, setRcsAgents] = useState<RcsAgent[]>([]);
  const [rcsMessages, setRcsMessages] = useState<RcsMessage[]>([]);
  const [workflowId, setWorkflowId] = useState('');
  // Nombre TOTAL de scénarios du tenant, avant le filtre d'éligibilité campagne : sans lui, « aucun scénario »
  // s'afficherait alors qu'il en existe (mais qu'aucun ne démarre par un template), message faux et déroutant.
  // Message bloquant si le workflow choisi n'OUVRE pas par un envoi de template (pas de cible au mapping).
  const [wfError, setWfError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Références de l'écran (templates, scénarios, champs, tags, réglages), extraites dans leur propre concern
   * (lot 6, 2026-08-31). C'était un chargement cohérent qui n'interagit avec aucun état de SAISIE : huit
   * états, un effet et un rechargement en moins ici. Les zones de rendu et l'enregistrement du brouillon,
   * eux, ne s'extraient pas de cette façon (ils liraient quinze à vingt états), cf. `use-campagne-references`.
   */
  const {
    templates, workflows, workflowsTotal, userFields, tags, loadingRefs,
    hubspotListsEnabled, hubspotPaused, reloadTemplates,
  } = useCampagneReferences(tenantId, setError);
  const [ok, setOk] = useState<string | null>(null);
  // Débit d'envoi (« vitesse du canon ») : jauge TOUJOURS active, 1..80 messages/min (plafond WhatsApp), défaut 60.
  // On protège la réputation du numéro d'entrée de jeu plutôt que d'envoyer au max par défaut.
  const [ratePerMinute, setRatePerMinute] = useState<number>(60);
  // Lancement rapatrié sur l'écran (étape 2) : idle -> creating -> launching (avec polling inline) -> error.
  //
  // ⚠️ Cet état ne porte QUE les phases où l'écran travaille. Le RÉSULTAT vit dans `dernierEnvoi`, et c'est
  // tout le sujet d'un bug vécu le 2026-08-19 : les phases terminales `done`/`scheduled` masquaient les
  // boutons d'action alors que le formulaire restait éditable. Un opérateur qui enchaînait une 2e campagne la
  // saisissait devant un écran ne proposant plus que « Nouvelle campagne », lequel effaçait sa saisie sans
  // rien lancer. Séparer le travail en cours du résultat rend cet état impossible.
  const [launch, setLaunch] = useState<{
    phase: 'idle' | 'creating' | 'launching' | 'error';
    campaignId?: string;
    detail?: CampaignDetail;
    message?: string;
  }>({ phase: 'idle' });
  /**
   * Résultat du DERNIER envoi, indépendant du formulaire. Purement informatif : le formulaire est déjà remis à
   * neuf quand ceci s'affiche, donc on peut enchaîner immédiatement sans effacer quoi que ce soit.
   */
  const [dernierEnvoi, setDernierEnvoi] = useState<{
    kind: 'lance' | 'planifie';
    message: string;
    campaignId: string;
    detail?: CampaignDetail;
  } | null>(null);
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
  // Création d'un template SANS quitter la campagne en cours. `submittedTemplate` retient ce qui vient d'être
  // soumis : le formulaire se referme, mais la confirmation doit survivre pour expliquer l'attente Meta.
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [submittedTemplate, setSubmittedTemplate] = useState<CreatedTemplate | null>(null);
  /** Une vérification de statut est en vol. Sert à ce qu'un clic produise TOUJOURS quelque chose à l'écran. */
  const [verifEnCours, setVerifEnCours] = useState(false);

  /**
   * Brouillon de COMPOSITION : l'identifiant du brouillon qui porte cette campagne en cours d'écriture.
   * `null` = rien n'est encore enregistré.
   *
   * 🔴 Une REF, pas un état : un état React n'est visible qu'au rendu suivant, or deux sorties du champ
   * rapprochées liraient alors toutes les deux `null` et créeraient DEUX brouillons pour une seule campagne.
   * La ref porte la valeur à l'instant même.
   */
  const draftIdRef = useRef<string | null>(draft?.id ?? null);
  /** Sauvegarde en vol, pour enchaîner au lieu de doubler (même raison que ci-dessus). */
  const sauvegardeEnCours = useRef<Promise<void> | null>(null);
  const [brouillonEnregistre, setBrouillonEnregistre] = useState(false);
  /**
   * 🔴 LE BROUILLON EST ABANDONNÉ : plus aucune sauvegarde, même déjà programmée.
   *
   * Sans cette marque, la sauvegarde automatique rejouerait APRÈS la suppression : la campagne est lancée, le
   * brouillon est retiré, puis une minuterie encore en vol le RECRÉE, sans identifiant, donc en double dans
   * la liste. Une ref et non un état : la minuterie doit lire la valeur à l'instant même.
   */
  const brouillonAbandonne = useRef(false);

  // --- Zone Destinataires : source + filtres du mini-CRM ---
  //
  // Quatre sources, deux familles. Les deux premières (liste du CRM, import de fichier) désignent une liste
  // FIGÉE. Les deux autres vivent derrière « Autre » : HubSpot (une liste, ailleurs) et le webhook, qui est
  // d'une autre nature puisqu'il n'y a AUCUNE liste, seulement des arrivants au fil de l'eau.
  const [source, setSource] = useState<SourceDestinataires>('crm');
  // Toggle « Campagnes via données HubSpot » (réglé sur l'accueil) : gate le 3e bouton de source.
  // Campagnes via listes HubSpot en pause (F3-b, flag tenant campaignsPaused) : on grise la source HubSpot pour ne
  // pas envoyer l'admin vers un panneau vide pendant la pause.
  // Source WEBHOOK : l'adresse choisie, et les adresses disponibles. Chargées PARESSEUSEMENT (à la première
  // ouverture du panneau) : la majorité des campagnes ne sont pas au fil de l'eau, elles n'ont pas à payer
  // cet appel. `null` = pas encore chargées, ce qui n'est pas la même chose que « aucune adresse ».
  const [webhookId, setWebhookId] = useState('');
  const [webhooks, setWebhooks] = useState<WebhookEntrant[] | null>(null);
  const [webhooksErreur, setWebhooksErreur] = useState(false);
  // Filtres de la source CRM : UN objet ContactFilters, édité par le composant PARTAGÉ ContactFilterPanel
  // (même moteur de recherche que le mini-CRM, pas de 2e implémentation parallèle).
  const [filters, setFilters] = useState<ContactFilters>({});
  // Résultats : liste affichée (<= 500), total réel (compteur), sélection ciblée.
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * « Tout ce qui correspond aux filtres », par INTENTION plutôt que par liste d'identifiants.
   *
   * 🔴 C'est ce qui retire le piège des grosses sélections. « Tout sélectionner » rapatriait jusqu'à 100 000
   * identifiants dans le navigateur puis les renvoyait tous dans la requête, plafonnée à 1 Mo : la création
   * échouait vers 25 000 contacts, donc bien AVANT la limite que l'écran annonçait, et sans rien dire.
   * Même modèle que les actions en masse du mini-CRM (`allMode` + `excluded`), et même cible envoyée au
   * serveur, pour que les deux écrans visent exactement la même chose.
   */
  const [toutFiltre, setToutFiltre] = useState(false);
  const [exclus, setExclus] = useState<Set<string>>(new Set());
  // Récap non bloquant après un import fichier (N importés + tag posé) : affiché dans la zone Destinataires.
  const [importMsg, setImportMsg] = useState<{ n: number; tags: string[] } | null>(null);
  // Import CSV (source fichier) en vol : gèle les boutons de source (changer de source démonterait CsvImport).
  const [importBusy, setImportBusy] = useState(false);
  // Anti-course : n'appliquer qu'une réponse à jour (une plus récente peut la doubler entre-temps).
  const reqSeq = useRef(0);
  /**
   * 🔴 UNE SÉLECTION RESTAURÉE NE DOIT PAS ÊTRE ÉCRASÉE PAR LE PREMIER CHARGEMENT. Julien, le 2026-09-08 :
   * « si je ferme le site et que je reviens, il faut à nouveau que je sélectionne les personnes ».
   *
   * Le chargement de la liste RECOCHE tout par défaut (c'est le bon comportement quand les filtres bougent :
   * on vient de changer d'ensemble). Mais à la reprise d'un brouillon, il tombait juste après la restauration
   * et effaçait ce qu'on venait de rendre. Ce drapeau ne vaut QUE pour ce premier chargement : dès que
   * l'utilisateur touche un filtre, le comportement normal reprend.
   *
   * ⚠️ Il PORTE les identifiants plutôt que d'être un booléen : le chargement en a besoin pour confronter la
   * sélection restaurée à ce qui existe encore, et les lire depuis l'état obligerait à mettre `selected` dans
   * les dépendances de l'effet, qui se relancerait alors à chaque coche.
   */
  const selectionRestauree = useRef<Set<string> | null>(null);
  /**
   * Combien de contacts de la sélection restaurée ont DISPARU (supprimés, ou sortis des filtres depuis).
   * `null` = rien à signaler. Se taire ferait revenir l'opérateur sur une campagne qui vise moins de monde
   * qu'il ne l'a laissée, sans que rien ne l'explique.
   */
  const [selectionReduite, setSelectionReduite] = useState<number | null>(null);

  useEffect(() => {
    if (!phoneNumberId && numbers[0]) setPhoneNumberId(numbers[0].id);
  }, [numbers, phoneNumberId]);



  /**
   * Redemande à Meta où en est le template qu'on vient de soumettre, et REPORTE son statut à l'écran.
   *
   * C'est le geste qui manquait : le statut affiché était celui figé à la création, et le bouton
   * « Rafraîchir » ne rafraîchissait que le sélecteur fermé au-dessus. On rechargeait donc bien, mais dans
   * une zone que l'écran n'affichait pas.
   */
  const verifierTemplateSoumis = useCallback(async (silencieux = false) => {
    if (!submittedTemplate) return;
    const soumis = submittedTemplate;
    setVerifEnCours(true);
    try {
      const tous = await reloadTemplates(silencieux);
      const ligne = tous.find((x) => x.name === soumis.name && x.language === soumis.language);
      if (ligne && ligne.status !== soumis.status) {
        setSubmittedTemplate({ ...soumis, status: ligne.status });
      }
    } finally {
      setVerifEnCours(false);
    }
  }, [submittedTemplate, reloadTemplates]);

  /**
   * Sondage du statut tant que la revue Meta est en cours : on ne fait pas attendre le client devant un
   * bouton qu'il faut penser à cliquer.
   *
   * 15 s, l'intervalle déjà retenu pour la liste de l'inbox, et le même garde-fou de visibilité : un onglet
   * en arrière-plan n'appelle rien. Trois conditions d'arrêt, toutes portées par l'état existant : statut
   * terminal atteint, panneau fermé (`submittedTemplate` repasse à null), écran quitté (nettoyage de l'effet).
   *
   * ⚠️ Chaque tour est un vrai appel à Meta. C'est acceptable ici parce que le panneau ne vit que le temps de
   * la revue et se referme d'un clic, mais ce n'est pas un patron à recopier ailleurs sans y repenser.
   */
  useEffect(() => {
    // BORNE AU MODE : le panneau n'existe que dans la branche « Template ». Sans cette garde, le sondage
    // continuait de battre apres une bascule vers Scenario ou RCS, et la selection automatique finissait par
    // s'executer sur un ecran qui ne montre plus rien de ce contexte, en ecrasant la categorie au passage.
    if (mode !== 'template') return;
    const statut = submittedTemplate?.status;
    if (!statut) return;
    // Statut DEJA terminal : rien a sonder, mais la liste des templates, elle, n'a peut-etre jamais ete
    // rechargee (Meta approuve parfois un utilitaire sur-le-champ). Une seule relecture, silencieuse, sinon
    // le template approuve n'apparait pas dans le selecteur et la selection automatique ne trouve rien.
    if (statut === 'APPROVED' || statut === 'REJECTED') { void reloadTemplates(true); return; }
    const tick = () => { if (document.visibilityState === 'visible') void verifierTemplateSoumis(true); };
    const id = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [mode, submittedTemplate?.status, verifierTemplateSoumis, reloadTemplates]);

  /**
   * Le template soumis vient d'être approuvé : on le choisit pour la campagne, ce que l'opérateur allait
   * faire à la main.
   *
   * Passer par un EFFET n'est pas cosmétique : `chooseTemplate` lit l'état `templates` par fermeture.
   * L'appeler dans la foulée de `setTemplates` lirait l'ANCIENNE liste, n'y trouverait pas le template et
   * viderait les variables sans la moindre erreur visible.
   */
  useEffect(() => {
    if (mode !== 'template') return; // meme borne que le sondage : hors de cette branche, rien a selectionner
    if (submittedTemplate?.status !== 'APPROVED') return;
    if (templateName !== '') return; // ne JAMAIS écraser un choix fait pendant l'attente
    if (!templates.some((x) => x.name === submittedTemplate.name)) return;
    void chooseTemplate(submittedTemplate.name);
    // `chooseTemplate` est une fonction du corps du composant, redéfinie à chaque rendu : la mettre en
    // dépendance relancerait l'effet en boucle. Les vraies entrées sont le statut et la liste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, submittedTemplate, templates, templateName]);

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
          // Normalisé AVANT d'entrer dans l'état. Une réponse 200 sans le champ `contacts` (version d'API en
          // retard, route qui rend `{}`) posait `undefined` dans un état typé tableau : le `.length` du rendu
          // jetait, et React démontait TOUT l'écran de création, pas seulement la liste. Le `catch` ci-dessous
          // n'y peut rien, il n'y a aucune erreur réseau dans ce cas.
          const liste = Array.isArray(q?.contacts) ? q.contacts : [];
          setContacts(liste);
          // `null` et NON `liste.length` : `total` est deja type `number | null`, et l'ecran sait rendre
          // l'inconnu. Deduire un total des lignes ramenees inventerait un chiffre plafonne par la limite
          // de la requete, qu'on afficherait comme une verite.
          setTotal(typeof c?.total === 'number' ? c.total : null);
          const restauree = selectionRestauree.current;
          if (restauree) {
            // Une seule fois : le prochain changement de filtres reprend le comportement « tout coché ».
            selectionRestauree.current = null;
            // ⚠️ On BORNE la sélection restaurée à ce qui existe encore. Garder un identifiant disparu
            // ferait mentir le compteur, et viser quelqu'un qui ne correspond plus aux filtres.
            const vivants = new Set(liste.filter((x) => restauree.has(x.id)).map((x) => x.id));
            setSelected(vivants);
            setSelectionReduite(restauree.size > vivants.size ? restauree.size - vivants.size : null);
          } else {
            setSelected(new Set(liste.map((x) => x.id)));
          }
          // 🔴 Les filtres ont changé, donc les EXCLUSIONS ne veulent plus rien dire : elles désignaient des
          // contacts d'un autre ensemble. Les garder retirerait des gens que l'utilisateur n'a jamais vus
          // dans cette nouvelle sélection, et le compteur afficherait un nombre plus petit sans raison
          // visible. Le mode « tout ce qui correspond », lui, RESTE : il suit les filtres, c'est son sens.
          setExclus(new Set());
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
  // Nom vérifié du numéro courant, pour que l'aperçu porte le nom de l'entreprise qui va vraiment envoyer.
  // Un effet au montage choisit deja le premier numero, y compris sur un espace mono-numero : la valeur est
  // donc quasiment toujours definie ici, et `PhoneFrame` ne resout par lui-meme que sur les ecrans qui ne
  // chargent pas les numeros (Templates, Inbox).
  const senderName = numbers.find((n) => n.id === phoneNumberId)?.verifiedName ?? undefined;
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
    const n = varCountOf(tpl?.body);
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
    // 🔴 Le GRAPHE est chargé ICI, à la demande, et plus dans la liste. La liste n'en porte plus : elle
    // renvoyait deux graphes complets par scénario pour afficher des noms. Un aller-retour au moment où
    // l'opérateur CHOISIT son scénario est très largement préférable à N graphes à chaque ouverture d'écran.
    let graphe = wf.graph;
    if (!graphe) {
      try {
        graphe = (await getWorkflow(tenantId, id)).workflow.graph;
      } catch {
        setWfError(t('Ce scénario n’a pas pu être lu. Réessaie.', 'This scenario could not be read. Try again.'));
        return;
      }
    }
    // Le template à paramétrer est celui qui OUVRE, pas forcément le bloc d'entrée : un tag ou une action
    // peuvent le précéder sans rien envoyer. Chercher sur l'entrée rendrait '' et perdrait le mapping.
    const entry = graphe ? firstTemplateOf(graphe) : null;
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
    const [res, msgs] = await Promise.all([
      listRcsAgents(tenantId).catch(() => null),
      listRcsMessages(tenantId).catch(() => null),
    ]);
    if (msgs && Array.isArray(msgs.messages)) setRcsMessages(msgs.messages);
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
    // Le panneau du template soumis appartient a la branche « Template » : le laisser vivre ailleurs, c'est
    // garder un sondage et une selection automatique actifs sur un ecran qui ne les montre plus.
    setSubmittedTemplate(null);
    setCreatingTemplate(false);
  }

  // Bascule de source. Pour les sources non implémentées, on vide la sélection (donc étape 2 désactivée).
  // Un changement manuel de source referme le récap d'import (il ne concerne plus l'écran affiché).
  function chooseSource(s: SourceDestinataires) {
    setSource(s);
    setImportMsg(null);
    if (s !== 'crm') setSelected(new Set());
    /**
     * 🔴 Changer de source OUBLIE le mode « tout ce qui correspond », toujours, même en revenant sur le CRM.
     *
     * Sans ça : on clique « Tout sélectionner » sur le CRM (filtres vides = tout l'espace), on bascule sur
     * « Import fichier », et l'écran montre un widget d'upload vide pendant que l'état retient encore la
     * cible du CRM. Le bandeau qui annonce ce mode et le compteur ne sont rendus que dans la branche CRM :
     * plus rien à l'écran ne dit ce qui est visé, mais « Prêt à lancer à N » reste affiché, et créer enverrait
     * les ANCIENS filtres. Une campagne partirait à tout l'espace alors que l'opérateur croit viser son
     * fichier. C'est exactement l'accident que ce lot existe pour fermer, déplacé d'un cran.
     */
    setToutFiltre(false);
    setExclus(new Set());
    // Quitter la source webhook OUBLIE l'adresse choisie : la laisser posée ferait partir une campagne « au
    // fil de l'eau » alors que l'opérateur a sous les yeux une liste de contacts cochés.
    if (s !== 'webhook') setWebhookId('');
  }

  // Adresses disponibles, chargées à la PREMIÈRE ouverture du panneau webhook seulement. Un échec n'est pas
  // silencieux : sans adresse affichée ET sans message, l'écran laisserait croire qu'il n'y en a aucune.
  useEffect(() => {
    if (source !== 'webhook' || webhooks !== null) return;
    let vivant = true;
    (async () => {
      try {
        const { webhooks: liste } = await listWebhooks(tenantId);
        if (!vivant) return;
        const actives = Array.isArray(liste) ? liste.filter((w) => w.enabled) : [];
        setWebhooks(actives);
        // Adresse d'un brouillon repris, supprimée ou désactivée depuis : le sélecteur l'afficherait VIDE
        // alors que l'état la porte encore, et la campagne partirait sur une adresse morte (400 serveur).
        setWebhookId((id) => (id !== '' && !actives.some((w) => w.id === id) ? '' : id));
      } catch {
        if (vivant) { setWebhooks([]); setWebhooksErreur(true); }
      }
    })();
    return () => { vivant = false; };
  }, [source, webhooks, tenantId]);

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
    // En mode « tout ce qui correspond », décocher une ligne l'EXCLUT ; on ne reconstruit jamais la liste.
    if (toutFiltre) {
      setExclus((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
      return;
    }
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  /** « Tout sélectionner (N) » : on retient l'INTENTION, on ne rapatrie plus aucun identifiant. */
  function selectAllMatching() {
    setToutFiltre(true);
    setSelected(new Set());
    setExclus(new Set());
  }
  function viderSelection() {
    setToutFiltre(false);
    setSelected(new Set());
    setExclus(new Set());
  }
  /** Une ligne affichée est-elle retenue ? En mode « tout », tout l'est sauf ce qui a été exclu. */
  const estRetenu = (id: string): boolean => (toutFiltre ? !exclus.has(id) : selected.has(id));
  /**
   * Combien de destinataires, réellement. En mode « tout ce qui correspond », c'est le total SERVEUR moins
   * les exclusions : le navigateur ne connaît pas la liste, il connaît son cardinal. Toutes les phrases de
   * l'écran (durée estimée, « prêt à lancer à N ») lisent ce nombre, plus `selected.size`, qui vaudrait zéro.
   */
  const nbDestinataires = toutFiltre ? Math.max(0, (total ?? 0) - exclus.size) : selected.size;

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
    // Comment les destinataires sont DÉSIGNÉS, et c'est l'un ou l'autre : une liste figée, ou une adresse qui
    // les amènera au fil de l'eau. Envoyer les deux est refusé par le serveur, et à juste titre : ce serait
    // laisser croire que la liste va partir alors que seule l'adresse compte.
    // Trois façons de désigner les destinataires, et une seule part : une adresse (fil de l'eau), une
    // INTENTION (filtres + exclusions), ou une liste explicite. Le serveur refuse d'en recevoir deux.
    const cible: Pick<CreateCampaignInput, 'contactIds' | 'contactTarget' | 'webhookId'> = auFilDeLEau
      ? { webhookId }
      : toutFiltre
        ? { contactTarget: { filters, excludeIds: [...exclus] } }
        : { contactIds: [...selected] };
    // Débit TOUJOURS choisi (jauge, défaut 60) : on envoie systématiquement le plafond 1..80.
    // Campagne RCS : ni numéro Meta, ni template, ni variables. Le message part tel qu'il est écrit.
    if (mode === 'rcs') {
      return {
        phoneNumberId: '', name, category, channel: 'rcs',
        rcsAgentId,
        // MÊME constructeur que la bibliothèque (`web/lib/rcs.ts`) : c'est lui qui décide TEXTE ou CARTE
        // selon qu'il y a un visuel, et qui écarte les boutons sans libellé (le serveur refuserait la
        // création entière pour une ligne qu'un opérateur a juste oublié de remplir).
        rcsMessage: versMessageRcs({ text: rcsText, imageUrl: rcsImage, suggestions: rcsBoutons }),
        ...cible, ratePerMinute,
      };
    }
    return mode === 'workflow'
      ? { phoneNumberId, name, category, workflowId, paramMapping: toParamMapping(), ...cible, ratePerMinute }
      : { phoneNumberId, name, category, templateName, templateLanguage, paramMapping: toParamMapping(), ...cible, ratePerMinute };
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
    // 🔴 L'ABANDON EST LEVÉ ICI, et l'oublier coûterait cher : `retirerBrouillon` pose la marque pour qu'une
    // minuterie en vol ne recrée pas le brouillon qu'on vient de supprimer. Sans cette remise à zéro, un
    // opérateur qui ENCHAÎNE une seconde campagne (flux prévu, cf. `dernierEnvoi`) n'aurait plus jamais de
    // brouillon enregistré de toute la session, et sans le moindre signe.
    brouillonAbandonne.current = false;
  }

  /**
   * Ce qu'on garde d'un brouillon : les CHOIX de l'utilisateur, et rien d'autre. Les listes chargées
   * (templates, workflows, contacts, agents RCS) se rechargent seules et n'ont donc rien à faire ici : les
   * figer les rendrait périmées à la reprise, ce qui est pire que de les relire.
   */
  function etatDuFormulaire(): Record<string, unknown> {
    return {
      category, mode, source, webhookId,
      phoneNumberId, templateName, templateLanguage, vars,
      workflowId, rcsAgentId, rcsText, rcsImage,
      ratePerMinute, timing, scheduledLocal,
      /**
       * 🔴 LES DESTINATAIRES AUSSI (2026-09-08). Ils manquaient, et c'est le travail le plus long de l'écran :
       * Julien revenait sur son brouillon et devait tout recocher. Les filtres sont indispensables au reste :
       * sans eux, la reprise recharge « tous les contacts » et la sélection restaurée ne désigne plus rien.
       *
       * ⚠️ Les identifiants sont bornés par construction : la liste affichée est plafonnée à 500, et on ne
       * peut cocher que ce qui est affiché. Le mode « tout ce qui correspond » ne stocke AUCUN identifiant,
       * c'est justement son intérêt (cf. `toutFiltre`) : il garde l'intention et ses exclusions.
       */
      filters,
      selected: [...selected],
      toutFiltre,
      exclus: [...exclus],
    };
  }

  /**
   * Enregistre le brouillon : création au premier nom, mise à jour ensuite. Le nom vide n'enregistre RIEN,
   * sinon quitter le champ sans rien écrire créerait un brouillon fantôme.
   *
   * Best-effort et SILENCIEUX en cas d'échec : perdre un brouillon est ennuyeux, mais afficher une erreur
   * rouge au milieu de la saisie d'un nom le serait davantage. Le formulaire reste utilisable tel quel.
   */
  async function enregistrerBrouillon(): Promise<void> {
    const nom = name.trim();
    if (nom === '' || brouillonAbandonne.current) return;
    const etat = etatDuFormulaire();
    // Sérialisé sur la sauvegarde précédente : sans cette file, deux sorties de champ rapprochées partiraient
    // en parallèle, toutes deux sans identifiant, et créeraient deux brouillons pour une seule campagne.
    const suite = (sauvegardeEnCours.current ?? Promise.resolve()).then(async () => {
      try {
        if (draftIdRef.current === null) {
          const { draft: cree } = await createCampaignDraft(tenantId, nom, etat);
          draftIdRef.current = cree.id;
        } else {
          await updateCampaignDraft(tenantId, draftIdRef.current, nom, etat);
        }
        setBrouillonEnregistre(true);
      } catch {
        /* un brouillon qui ne s'enregistre pas ne doit pas interrompre la saisie */
      }
    });
    sauvegardeEnCours.current = suite;
    await suite;
  }

  /**
   * 🔴 LE BROUILLON SUIT TOUT L'ÉCRAN, PLUS SEULEMENT LE NOM (2026-09-08).
   *
   * Julien : « la campagne est enregistrée mais il faut à nouveau que je sélectionne les personnes ». La
   * cause n'était pas seulement que les destinataires manquaient de l'état enregistré : la sauvegarde ne
   * partait QU'AU MOMENT où le champ du nom perdait le focus. Or le nom est la PREMIÈRE chose qu'on tape :
   * le brouillon photographiait donc un écran encore vide, et tout ce qui venait ensuite (le template, les
   * destinataires, le débit, la programmation) n'était jamais enregistré. Un seul déclencheur, placé au
   * début, ne pouvait rien capturer d'autre que le début.
   *
   * ⚠️ L'état est SÉRIALISÉ à chaque rendu plutôt que suivi champ par champ, et c'est délibéré : une liste de
   * dépendances tenue à la main dériverait dès qu'on ajoute un champ au formulaire, et la sauvegarde
   * cesserait de le suivre sans que rien ne le signale. Le coût est une sérialisation par frappe, invisible
   * devant le rendu lui-même.
   *
   * ⚠️ Le délai n'est pas de la coquetterie : sans lui, cocher dix contacts ferait dix écritures, et le
   * plafond de débit des routes authentifiées est partagé avec tout le reste de la console.
   */
  const etatSerialise = JSON.stringify(etatDuFormulaire());
  useEffect(() => {
    if (name.trim() === '' || brouillonAbandonne.current) return;
    const timer = setTimeout(() => { void enregistrerBrouillon(); }, DELAI_SAUVEGARDE_MS);
    return () => clearTimeout(timer);
    // `etatSerialise` porte TOUT ce qui est enregistré : c'est la seule dépendance qui ne dérive pas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etatSerialise, name]);

  /**
   * Reprise d'un brouillon : on réapplique les choix, en tolérant l'absence de chaque champ. L'état vient de
   * la base et a pu être écrit par une version antérieure du formulaire : un champ manquant garde sa valeur
   * par défaut plutôt que de casser l'écran.
   */
  useEffect(() => {
    if (!draft) return;
    const s = draft.state ?? {};
    const txt = (k: string): string | undefined => (typeof s[k] === 'string' ? (s[k] as string) : undefined);
    setName(draft.name);
    if (txt('category') === 'marketing' || txt('category') === 'utility') setCategory(txt('category') as 'marketing' | 'utility');
    if (txt('mode') === 'template' || txt('mode') === 'workflow' || txt('mode') === 'rcs') setMode(txt('mode') as 'template' | 'workflow' | 'rcs');
    if (estSourceDestinataires(txt('source'))) setSource(txt('source') as SourceDestinataires);
    if (txt('webhookId') !== undefined) setWebhookId(txt('webhookId')!);
    if (txt('phoneNumberId') !== undefined) setPhoneNumberId(txt('phoneNumberId')!);
    if (txt('templateName') !== undefined) setTemplateName(txt('templateName')!);
    if (txt('templateLanguage') !== undefined) setTemplateLanguage(txt('templateLanguage')!);
    if (txt('workflowId') !== undefined) setWorkflowId(txt('workflowId')!);
    if (txt('rcsAgentId') !== undefined) setRcsAgentId(txt('rcsAgentId')!);
    if (txt('rcsText') !== undefined) setRcsText(txt('rcsText')!);
    if (txt('rcsImage') !== undefined) setRcsImage(txt('rcsImage')!);
    if (txt('scheduledLocal') !== undefined) setScheduledLocal(txt('scheduledLocal')!);
    if (txt('timing') === 'now' || txt('timing') === 'later') setTiming(txt('timing') as 'now' | 'later');
    if (typeof s.ratePerMinute === 'number') setRatePerMinute(s.ratePerMinute);
    if (Array.isArray(s.vars)) setVars(s.vars as VarRow[]);
    // Les DESTINATAIRES. `filters` d'abord : c'est lui qui décide quelle liste sera chargée, donc ce à quoi
    // la sélection restaurée sera confrontée.
    if (s.filters && typeof s.filters === 'object' && !Array.isArray(s.filters)) setFilters(s.filters as ContactFilters);
    if (s.toutFiltre === true) setToutFiltre(true);
    if (Array.isArray(s.exclus)) setExclus(new Set((s.exclus as unknown[]).filter((x): x is string => typeof x === 'string')));
    if (Array.isArray(s.selected)) {
      const ids = (s.selected as unknown[]).filter((x): x is string => typeof x === 'string');
      setSelected(new Set(ids));
      // La marque est posée même pour une liste VIDE : « je n'ai coché personne » est un choix, et le
      // chargement qui suit le remplacerait par « tout le monde ».
      selectionRestauree.current = new Set(ids);
    }
    // Une seule fois, à l'ouverture : ce sont des valeurs INITIALES, pas une synchronisation continue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Le brouillon a rempli son office dès que la vraie campagne existe : on le retire pour ne pas laisser un
   * doublon dans la liste. Best-effort : un brouillon qui survit est visible et supprimable à la main, alors
   * qu'une erreur ici masquerait le succès de la campagne.
   */
  async function retirerBrouillon(): Promise<void> {
    // AVANT d'attendre quoi que ce soit : une minuterie de sauvegarde automatique peut être en vol, et elle
    // recréerait le brouillon juste après sa suppression.
    brouillonAbandonne.current = true;
    // On attend la sauvegarde en vol : supprimer pendant une création laisserait le brouillon derrière soi,
    // créé juste après la suppression.
    await (sauvegardeEnCours.current ?? Promise.resolve());
    const id = draftIdRef.current;
    if (id === null) return;
    try {
      await deleteCampaignDraft(tenantId, id);
      draftIdRef.current = null;
      setBrouillonEnregistre(false);
    } catch {
      /* voir plus haut */
    }
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

      // ⚠️ 0 destinataire n'a pas le même sens selon la source. Sur une liste, c'est l'alerte rouge : tout a
      // été sauté et rien ne partira. Sur une campagne AU FIL DE L'EAU, c'est l'état NORMAL de départ, les
      // destinataires n'existent pas encore. La confondre avec un échec bloquerait la seule création valide.
      if (res.recipientCount === 0 && !auFilDeLEau) {
        setError(messageAucunDestinataire(res.skipped));
        return; // le finally remet busy à false
      }
      if (auFilDeLEau) {
        setOk(t(
          'Campagne au fil de l\'eau créée. Clique « Lancer » : elle prendra ensuite chaque contact qui arrive par cette adresse.',
          'Continuous campaign created. Click "Launch": it will then take every contact arriving through this address.',
        ));
        setName('');
        setTemplateName('');
        setVars([]);
        setWorkflowId('');
        setWfError(null);
        await retirerBrouillon();
        onCreated();
        return;
      }
      // L'envoi part quand même aux valides ; les écartés sont NOMMÉS avec leur motif.
      const skippedMsg = res.skipped.length > 0
        ? t(` ${res.skipped.length} contact(s) écartés (${detail}).`, ` ${res.skipped.length} contact(s) skipped (${detail}).`)
        : '';
      // Avertissement de PALIER (lot 7) : dit avant le lancement ce que Meta refusera après. Il arrive rédigé
      // par le serveur, qui est le seul à connaître le palier du numéro ; l'écran ne le reformule pas.
      const palierMsg = res.avertissement ? ` ${res.avertissement}` : '';
      setOk(t(
        `Campagne créée : ${res.recipientCount} destinataire(s).${skippedMsg}${palierMsg} Clique « Lancer » pour envoyer.`,
        `Campaign created: ${res.recipientCount} recipient(s).${skippedMsg}${palierMsg} Click "Launch" to send.`,
      ));
      setName('');
      setTemplateName('');
      setVars([]);
      setWorkflowId('');
      setWfError(null);
      // La campagne existe : le brouillon n'a plus lieu d'être, sinon la liste montrerait les deux.
      await retirerBrouillon();
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
    setDernierEnvoi(null); // le résultat affiché est celui de l'envoi PRÉCÉDENT : il ne survit pas au suivant
    setLaunch({ phase: 'creating' });
    try {
      const res = await createCampaign(tenantId, buildCreateInput());
      // 0 destinataire = tous sautés : même avertissement ROUGE que le brouillon, on NE lance PAS et on reste.
      // Sauf au fil de l'eau, où naître vide est l'état normal (cf. `submit`).
      if (res.recipientCount === 0 && !auFilDeLEau) {
        setError(messageAucunDestinataire(res.skipped));
        setLaunch({ phase: 'idle' });
        return;
      }
      setLaunch({ phase: 'launching', campaignId: res.campaignId });
      await runCampaign(res.campaignId);
      // Une campagne au fil de l'eau n'a RIEN à envoyer au lancement : sonder ses compteurs six fois de suite
      // n'apprendrait rien à personne. On confirme qu'elle est ouverte, et elle vit sa vie.
      if (auFilDeLEau) {
        setDernierEnvoi({
          kind: 'lance',
          campaignId: res.campaignId,
          message: t(
            "Campagne ouverte : chaque contact qui arrive par cette adresse recevra le message. Arrête-la depuis la liste des campagnes.",
            'Campaign open: every contact arriving through this address will get the message. Stop it from the campaign list.',
          ),
        });
        resetForm();
        return;
      }
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
      setDernierEnvoi({
        kind: 'lance',
        campaignId: res.campaignId,
        ...(detail ? { detail } : {}),
        message: t(`Campagne lancée : ${sent} envoyés / ${failed} échecs.`, `Campaign launched: ${sent} sent / ${failed} failures.`),
      });
      // Remise à neuf IMMÉDIATE : c'est ce qui permet d'enchaîner une autre campagne sans trace de celle-ci.
      // `resetForm` repasse `launch` en idle, donc les boutons d'action redeviennent actifs.
      resetForm();
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
    setDernierEnvoi(null);
    setLaunch({ phase: 'creating' });
    try {
      const res = await createCampaign(tenantId, buildCreateInput());
      // 0 destinataire = tous sautés : même avertissement ROUGE que le brouillon, on NE programme PAS et on
      // reste. Au fil de l'eau, naître vide est normal : la programmation dit juste QUAND l'adresse s'ouvre.
      if (res.recipientCount === 0 && !auFilDeLEau) {
        setError(messageAucunDestinataire(res.skipped));
        setLaunch({ phase: 'idle' });
        return;
      }
      const r = await runCampaign(res.campaignId, scheduledISO);
      if (!mountedRef.current) return; // écran quitté entre-temps -> on cesse tout setState
      const when = new Date(r.scheduledAt ?? scheduledISO).toLocaleString();
      setDernierEnvoi({
        kind: 'planifie',
        campaignId: res.campaignId,
        message: t(`Campagne planifiée le ${when}.`, `Campaign scheduled for ${when}.`),
      });
      resetForm();
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
    // Le plafond de texte CHANGE quand on ajoute un visuel (2000 au lieu de 3072, borne du champ description
    // chez smsmode). Un texte déjà saisi ne se raccourcit pas tout seul : sans ce contrôle, ajouter une image
    // à la fin ferait échouer la création avec un « content invalide » que personne ne saurait relier à ça.
    ? (rcsAgentId !== '' && rcsText.trim() !== '' && rcsText.length <= maxTexteRcs(rcsImage) && rcsBoutons.every(boutonPret))
    : mode === 'workflow'
      ? (workflowId !== '' && wfError === null && varsComplete)
      : (templateName !== '' && varsComplete);
  // Nommer la campagne est un PRÉALABLE (étape 0) : tant que c'est vide, les zones Destinataires/Message sont grisées.
  const nameSet = name.trim() !== '';
  // --- Sources rangées sous « Autre » ---
  // HubSpot n'est PROPOSÉ que si le connecteur est activé sur l'accueil : sinon il n'apparaît pas du tout.
  const hubspotDisponible = hubspotListsEnabled;
  const sourceAutre = SOURCES_AUTRES.includes(source);
  // Campagne AU FIL DE L'EAU : pas de liste, une adresse. C'est ce booléen, et pas `selected.size`, qui dit
  // si les destinataires sont désignés.
  const auFilDeLEau = source === 'webhook';
  const webhookChoisi = webhooks?.find((w) => w.id === webhookId) ?? null;
  const destinatairesPrets = auFilDeLEau ? webhookId !== '' : nbDestinataires > 0;

  // Étape 1 prête = ce qui active l'étape 2 (indépendant du busy/launch en cours).
  // Le numéro Meta n'est exigé que sur WhatsApp : une campagne RCS part d'un agent de marque.
  const step1Ready = (mode === 'rcs' || phoneNumberId !== '') && nameSet && contentReady && destinatairesPrets;
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
          onBlur={() => { void enregistrerBrouillon(); }}
          data-testid="campaign-name"
          autoFocus
          className={`${inputCls} max-w-md ${!nameSet ? 'border-brand-400 ring-2 ring-brand-100' : ''}`}
          placeholder={t('Promo été', 'Summer promo')}
        />
        {brouillonEnregistre && (
          <p className="mt-1 text-xs text-ink-400" data-testid="draft-saved">
            {t('Brouillon enregistré : tu peux quitter cet écran et reprendre plus tard.', 'Draft saved: you can leave and come back later.')}
          </p>
        )}
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
            <span className="text-xs text-ink-400">{nbDestinataires} / {total} {t('sélectionnés', 'selected')}</span>
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
          {/* « Autre » regroupe les sources qui ne servent pas au cas courant. Cliquer dessus ouvre la
              deuxième ligne et choisit la PREMIÈRE source disponible, pour ne jamais laisser un onglet actif
              sans panneau en dessous. */}
          <button
            type="button"
            disabled={importBusy}
            onClick={() => chooseSource(hubspotDisponible && !hubspotPaused ? 'hubspot' : 'webhook')}
            data-testid="campaign-source-autre"
            className={`rounded-md px-2.5 py-1 disabled:opacity-40 ${sourceAutre ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
          >
            ⋯ {t('Autre', 'Other')}
          </button>
        </div>

        {/* Deuxième ligne, visible seulement sous « Autre ».
            HubSpot n'apparaît PAS quand le connecteur est éteint sur l'accueil (demande de Julien du
            2026-08-26) : un bouton grisé pour une intégration qu'on n'a pas est du bruit, pas une information. */}
        {sourceAutre && (
          <div className="mb-3 flex flex-wrap gap-2 text-sm" data-testid="campaign-source-autre-panel">
            {hubspotDisponible && (
              <button
                type="button"
                disabled={importBusy || hubspotPaused}
                onClick={() => chooseSource('hubspot')}
                title={hubspotPaused ? t("Synchronisation HubSpot en pause. Réactive-la sur l'accueil.", 'HubSpot sync is paused. Re-enable it on the home page.') : undefined}
                data-testid="campaign-source-hubspot"
                className={`rounded-lg border px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${source === 'hubspot' ? 'border-brand-300 bg-brand-50 font-medium text-brand-700' : 'border-ink-200 text-ink-600 hover:bg-ink-50'}`}
              >
                🔗 {t('HubSpot', 'HubSpot')}
              </button>
            )}
            <button
              type="button"
              disabled={importBusy}
              onClick={() => chooseSource('webhook')}
              data-testid="campaign-source-webhook"
              className={`rounded-lg border px-2.5 py-1 disabled:opacity-40 ${source === 'webhook' ? 'border-brand-300 bg-brand-50 font-medium text-brand-700' : 'border-ink-200 text-ink-600 hover:bg-ink-50'}`}
            >
              🪝 {t('Webhook', 'Webhook')}
            </button>
          </div>
        )}

        {source === 'file' ? (
          <CsvImport tenantId={tenantId} requireTag onImported={handleImported} onBusyChange={setImportBusy} />
        ) : source === 'hubspot' ? (
          <HubspotListImport tenantId={tenantId} onImported={handleImported} onBusyChange={setImportBusy} />
        ) : source === 'webhook' ? (
          <div className="space-y-2">
            <p className="text-xs text-ink-500">
              {t(
                "Aucune liste ici : la campagne reste ouverte, et chaque contact qui arrive par cette adresse reçoit le message dans la foulée. Elle envoie à partir de son lancement, pas aux contacts déjà arrivés avant.",
                'No list here: the campaign stays open, and every contact arriving through this address gets the message right away. It sends from its launch onwards, not to contacts that arrived before.',
              )}
            </p>
            {webhooks === null ? (
              <p className="text-xs text-ink-400">{t('Chargement des adresses…', 'Loading addresses…')}</p>
            ) : webhooksErreur ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {t('Impossible de charger les adresses. Réessaie dans un instant.', 'Could not load the addresses. Try again in a moment.')}
              </p>
            ) : webhooks.length === 0 ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t('Aucune adresse active. Crée-la dans Tools > Webhooks, puis reviens ici.', 'No active address. Create one in Tools > Webhooks, then come back here.')}
              </p>
            ) : (
              <>
                <label className="block text-xs font-medium text-ink-600" htmlFor="campaign-webhook">{t('Adresse (Tools > Webhooks)', 'Address (Tools > Webhooks)')}</label>
                <select
                  id="campaign-webhook"
                  value={webhookId}
                  onChange={(e) => setWebhookId(e.target.value)}
                  data-testid="campaign-webhook-select"
                  className={inputCls}
                >
                  <option value="">{t('Choisir une adresse…', 'Choose an address…')}</option>
                  {webhooks.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
                {/* Le consentement est la SEULE condition qui peut tout écarter en silence : une campagne
                    marketing n'envoie qu'aux contacts opt-in, et un webhook qui ne l'affirme pas produit des
                    arrivants « consentement inconnu ». Ils seront inscrits et marqués écartés, jamais perdus,
                    mais autant le dire avant de lancer. */}
                {webhookChoisi && category === 'marketing' && !webhookChoisi.optIn && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="campaign-webhook-optin">
                    {t(
                      "Cette adresse n'affirme pas le consentement des contacts qu'elle crée. Sur une campagne marketing, ces contacts seront écartés. Coche le consentement dans Tools > Webhooks, ou passe la campagne en « Utility ».",
                      'This address does not assert consent for the contacts it creates. On a marketing campaign they will be skipped. Tick consent in Tools > Webhooks, or switch the campaign to "Utility".',
                    )}
                  </p>
                )}
                {webhookChoisi && !webhookChoisi.createContact && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="campaign-webhook-creation">
                    {t(
                      "Cette adresse ne crée pas les contacts inconnus : seuls ceux qui existent déjà dans le CRM seront touchés.",
                      'This address does not create unknown contacts: only those already in the CRM will be reached.',
                    )}
                  </p>
                )}
              </>
            )}
          </div>
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
            {/* 🔴 La sélection reprise a MAIGRI depuis. On le DIT : revenir sur un brouillon qui vise moins de
                monde qu'on ne l'a laissé, sans explication, est pire que de tout recocher, parce qu'on ne
                s'en aperçoit pas. */}
            {selectionReduite !== null && (
              <div data-testid="selection-reduite" className="mb-2 flex items-start justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span>
                  {t(
                    `${selectionReduite} contact(s) de votre sélection ne sont plus là (supprimés, ou sortis de ces filtres depuis). Le reste est bien resté coché.`,
                    `${selectionReduite} contact(s) from your selection are gone (deleted, or no longer matching these filters). The rest is still selected.`,
                  )}
                </span>
                <button type="button" onClick={() => setSelectionReduite(null)} className="shrink-0 leading-none text-amber-500 hover:text-amber-800" aria-label={t('Fermer', 'Close')}>×</button>
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
              <button type="button" onClick={viderSelection} className="rounded-lg border border-ink-300 px-2 py-0.5 text-ink-600 hover:bg-ink-50">{t('Vider', 'Clear')}</button>
            </div>

            {/* Le mode « tout ce qui correspond » doit se VOIR : sans cette ligne, l'écran montre 500 cases
                cochées et rien ne dit que la campagne en vise beaucoup plus. */}
            {toutFiltre && (
              <div data-testid="campagne-cible-filtre" className="mb-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-800">
                {t(
                  `Les ${nbDestinataires} contacts qui correspondent aux filtres sont visés, y compris ceux qui ne sont pas affichés ci-dessous. Décocher une ligne l'exclut.`,
                  `All ${nbDestinataires} contacts matching the filters are targeted, including those not shown below. Unticking a row excludes it.`,
                )}
              </div>
            )}

            {/* Liste des contacts correspondants (<= 500 affichés) : cocher/décocher affine la sélection. */}
            <div className="max-h-[22rem] divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
              {contacts.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-ink-50">
                  <input type="checkbox" checked={estRetenu(c.id)} onChange={() => toggleContact(c.id)} className="accent-brand-500" />
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
            { m: 'workflow', label: t('Un scénario', 'A scenario'), tip: t('Privilégiez cette méthode pour enchaîner plusieurs étapes : envoi d’un template PUIS d’autres éléments (ajout d’une étiquette, d’un champ, envoi d’un formulaire, ...).', 'Best for chaining several steps: sending a template THEN other elements (adding a tag, a field, sending a form, ...).') },
            { m: 'rcs', label: t('Un message RCS', 'An RCS message'), tip: t('Autre CANAL : le message part sous votre agent de marque, sans template à faire approuver et sans fenêtre de 24 h. Seuls les contacts joignables en RCS sont servis, les autres sont comptés « ignorés ».', 'A different CHANNEL: the message goes out under your brand agent, with no template to get approved and no 24h window. Only contacts reachable on RCS are served, the others are counted as skipped.') },
          ] as const).map(({ m, label, tip }) => {
            // Le RCS reste VISIBLE mais éteint tant qu'aucun agent n'est rattaché au tenant : rien ne peut
            // partir avant qu'un agent soit déposé et approuvé par Google et les opérateurs. L'infobulle dit
            // pourquoi, plutôt que de laisser l'opérateur cliquer sur un canal qui échouerait à l'envoi.
            const eteint = m === 'rcs' && !rcsEnabled;
            const aide = eteint ? t('Disponible quand votre agent RCS sera déposé et validé', 'Available once your RCS agent is filed and approved') : tip;
            return (
              <span key={m} className="group relative">
                <button
                  type="button"
                  data-testid={`campaign-mode-${m}`}
                  onClick={() => { if (!eteint) chooseMode(m); }}
                  disabled={eteint}
                  className={`rounded-md px-3 py-1 disabled:cursor-not-allowed disabled:text-ink-400 disabled:opacity-60 ${mode === m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
                >
                  {label}
                </button>
                <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-64 -translate-x-1/2 rounded-lg bg-ink-900 px-3 py-2 text-xs font-normal leading-snug text-white shadow-lg group-hover:block">{aide}</span>
              </span>
            );
          })}
        </div>
      </div>

      {mode === 'rcs' ? (
        <Field label={t('Message RCS', 'RCS message')}>
          <select
            value=""
            data-testid="rcs-campaign-library"
            onChange={(e) => {
              const m = rcsMessages.find((x) => x.id === e.target.value);
              // COPIE : la campagne garde le message tel qu'il était au moment de sa création. Modifier la
              // bibliothèque ensuite ne réécrit pas une campagne déjà partie.
              const b = versBrouillonRcs(m?.content ?? null);
              if (b) { setRcsText(b.text); setRcsImage(b.imageUrl); setRcsBoutons(b.suggestions); }
            }}
            className={`${inputCls} mb-2 max-w-xs bg-white`}
          >
            <option value="">{rcsMessages.length === 0 ? t('Aucun message enregistré', 'No saved message') : t('Partir d’un message enregistré…', 'Start from a saved message…')}</option>
            {rcsMessages.filter((m) => versBrouillonRcs(m.content) !== null).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div className="mb-2">
            <ChampImageHebergee tenantId={tenantId} valeur={rcsImage} onChange={setRcsImage} testIdPrefix="rcs-campagne" />
          </div>
          <ChampCorpsVariables
            valeur={rcsText}
            onChange={setRcsText}
            fields={userFields}
            testId="rcs-message"
            max={maxTexteRcs(rcsImage)}
          />
          <div className="mt-2">
            <RcsButtonsEditor
              boutons={rcsBoutons}
              onChange={setRcsBoutons}
              // Avec un visuel, les boutons partent DANS la carte : pleine largeur, empilés, 4 au maximum.
              // Sans visuel, ce sont des pastilles sous la bulle, 11 au maximum. Le plafond suit le format.
              max={rcsImage.trim() !== '' ? MAX_BOUTONS_CARTE : MAX_BOUTONS_RCS}
              dateFields={userFields}
              testIdPrefix="rcs-campagne"
            />
          </div>
          <p className="mt-1 text-[11px] text-ink-400">
            {t('Aucun template à faire approuver : le message part tel qu’il est écrit, sous votre agent de marque. Les variables {{champ}} du texte sont remplacées par la fiche de chaque contact.', 'No template to get approved: the message goes out as written, under your brand agent. The {{field}} variables in the text are filled in from each contact.')}
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
                <TemplatePreview template={selectedTemplate} examples={previewExamples} {...(senderName ? { senderName } : {})} />
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
              <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-4" data-testid="template-soumis">
                {submittedTemplate.status === 'APPROVED' ? (
                  <>
                    <p className="text-sm font-medium text-ink-900">
                      ✅ {t(`Template « ${submittedTemplate.name} » approuvé par Meta.`, `Template “${submittedTemplate.name}” approved by Meta.`)}
                    </p>
                    {/* La phrase suit l'état RÉEL, pas le statut. La sélection automatique s'abstient quand un
                        autre template a été choisi pendant l'attente : dire « il est sélectionné » dans ce cas
                        précis, c'est mentir exactement là où la garde a été écrite pour protéger le choix. */}
                    <p className="mt-1 text-xs text-ink-600">
                      {templateName === submittedTemplate.name
                        ? t('Il est sélectionné pour cette campagne, vous pouvez continuer.', 'It is selected for this campaign, you can carry on.')
                        : t('Choisissez-le dans la liste ci-dessus pour l’utiliser.', 'Pick it from the list above to use it.')}
                    </p>
                  </>
                ) : submittedTemplate.status === 'REJECTED' ? (
                  <>
                    <p className="text-sm font-medium text-ink-900">
                      ⛔ {t(`Template « ${submittedTemplate.name} » refusé par Meta.`, `Template “${submittedTemplate.name}” rejected by Meta.`)}
                    </p>
                    <p className="mt-1 text-xs text-ink-600">
                      {/* Le motif du refus n'est pas récupéré par la liste : ne pas prétendre l'expliquer ici. */}
                      {t(
                        "Le motif est indiqué par Meta dans l'écran Templates. Corrigez-le là-bas, ou créez-en un autre.",
                        'Meta gives the reason on the Templates screen. Fix it there, or create another one.',
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-ink-900">
                      {t(`Template « ${submittedTemplate.name} » soumis (statut : ${submittedTemplate.status}).`,
                        `Template “${submittedTemplate.name}” submitted (status: ${submittedTemplate.status}).`)}
                    </p>
                    <p className="mt-1 text-xs text-ink-600">
                      {t(
                        "Il passe en revue chez Meta. On vérifie automatiquement et il sera sélectionné dès qu'il est approuvé : rien à faire, vous pouvez préparer le reste de la campagne.",
                        'It goes through Meta review. We check automatically and it gets selected as soon as it is approved: nothing to do, you can prepare the rest of the campaign.',
                      )}
                    </p>
                  </>
                )}
                <div className="mt-2 flex items-center gap-3">
                  {submittedTemplate.status !== 'APPROVED' && submittedTemplate.status !== 'REJECTED' && (
                    <button
                      type="button"
                      onClick={() => { void verifierTemplateSoumis(); }}
                      disabled={verifEnCours}
                      className="text-xs text-brand-600 hover:underline disabled:text-ink-400 disabled:no-underline"
                      data-testid="verifier-statut"
                    >
                      {verifEnCours ? t('Vérification…', 'Checking…') : t('Vérifier maintenant', 'Check now')}
                    </button>
                  )}
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
                  // Cet écran est en DEUX COLONNES : ce formulaire n'a ici qu'une demi-page, et son aperçu
                  // de 300 px fixes ne laissait que 26 px aux champs à 1280 px de large.
                  colonneEtroite
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
                      "Aucun scénario utilisable en campagne : une campagne part sur une audience froide, donc le PREMIER message envoyé doit être un template configuré (un tag, une action ou une condition avant lui ne posent aucun problème). Tes autres scénarios restent utilisables quand le contact vient d'écrire. Un scénario jamais PUBLIÉ n'apparaît pas non plus ici : c'est la version en ligne qui part en campagne.",
                      'No scenario usable in a campaign: a campaign targets a cold audience, so the FIRST message sent must be a configured template (a tag, an action or a condition before it is fine). Your other scenarios remain usable when the contact has just written. A scenario that was never PUBLISHED does not show up here either: a campaign sends the live version.',
                    )}
              </p>
            ) : (
              <select value={workflowId} onChange={(e) => { void chooseWorkflow(e.target.value); }} className={inputCls}>
                <option value="">{t('Choisir un scénario…', 'Choose a scenario…')}</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} ({w.nodeCount ?? 0} {(w.nodeCount ?? 0) > 1 ? t('blocs', 'blocks') : t('bloc', 'block')})</option>
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
                <TemplatePreview template={selectedTemplate} examples={previewExamples} {...(senderName ? { senderName } : {})} />
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
          Placée après le grid pour disposer de la sélection (durée estimée sur le nombre de destinataires). */}
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
        {nbDestinataires > 0 && (
          <p className="mt-2 text-xs text-ink-500">
            {t(`~${Math.ceil(nbDestinataires / ratePerMinute)} min pour envoyer ${nbDestinataires} message(s)`, `~${Math.ceil(nbDestinataires / ratePerMinute)} min to send ${nbDestinataires} message(s)`)}
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
      {/* Résultat du dernier envoi. Le formulaire est DÉJÀ remis à neuf : ce panneau n'est qu'un accusé de
          réception, il ne bloque rien et se ferme. Pas de bouton « Nouvelle campagne », qui laissait
          croire qu'il fallait une action pour repartir alors que l'écran était déjà prêt. */}
      {dernierEnvoi && (
        <div
          data-testid="campagne-dernier-envoi"
          className={`mt-4 rounded-xl border p-4 text-sm ${dernierEnvoi.kind === 'lance' ? 'border-emerald-200 bg-emerald-50/60' : 'border-violet-200 bg-violet-50/60'}`}
        >
          <div className="flex items-start justify-between gap-3">
            <p className={`font-medium ${dernierEnvoi.kind === 'lance' ? 'text-emerald-800' : 'text-violet-800'}`}>{dernierEnvoi.message}</p>
            <button
              type="button"
              onClick={() => setDernierEnvoi(null)}
              aria-label={t('Fermer', 'Close')}
              data-testid="campagne-fermer-resultat"
              className="shrink-0 text-ink-400 transition hover:text-ink-700"
            >
              ✕
            </button>
          </div>
          {dernierEnvoi.detail && <LaunchCounts counts={dernierEnvoi.detail.counts} />}
          {dernierEnvoi.kind === 'planifie' && (
            <p className="mt-1 text-xs text-ink-500">{t('Elle partira automatiquement à la date prévue. Tu peux annuler la planification depuis la liste.', 'It will go out automatically at the scheduled time. You can cancel the schedule from the list.')}</p>
          )}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => onCreated()}
              className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
            >
              {t('Voir dans les campagnes', 'View in campaigns')}
            </button>
          </div>
        </div>
      )}

      <section className={`rounded-2xl border border-ink-200 bg-white p-6 shadow-sm transition ${step1Ready ? '' : 'opacity-60'}`} aria-disabled={!step1Ready}>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t('Étape 2', 'Step 2')}</p>
        <h2 className="mt-0.5 text-base font-semibold tracking-tight text-ink-900">{t('Lancement', 'Launch')}</h2>

        {!step1Ready ? (
          <p className="mt-1 text-xs text-ink-500">{t("Complète l'étape 1 pour activer le lancement.", 'Complete step 1 to enable launching.')}</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-700">
              {auFilDeLEau
                ? t(
                    `Prêt à ouvrir sur « ${webhookChoisi?.name ?? ''} » : les contacts arriveront au fil de l'eau.`,
                    `Ready to open on “${webhookChoisi?.name ?? ''}”: contacts will arrive continuously.`,
                  )
                : t(`Prêt à lancer à ${nbDestinataires} destinataire(s).`, `Ready to launch to ${nbDestinataires} recipient(s).`)}
            </p>

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
                {launch.phase === 'error' && <p className="text-red-700">{launch.message}</p>}
              </div>
            )}

            {/* Boutons d'action : TOUJOURS présents. Ils ont été masqués après un lancement, et c'est ce qui a
                produit le bug du 2026-08-19 : le formulaire restait éditable sans plus offrir de quoi lancer.
                Le bouton primaire dépend du timing : « Créer et lancer » (now) ou « Créer et planifier »
                (later, actif seulement si la date est dans le futur). Le brouillon reste dispo dans les deux cas. */}
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
                {SYSTEM_FIELDS.map((f) => <option key={f.key} value={`sys:${f.key}`}>{t(...f.label)}</option>)}
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
