'use client';

import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, useNodesState, useEdgesState, addEdge,
  type Connection, type ReactFlowInstance, type OnConnectEnd,
} from '@xyflow/react';
import {
  listTemplates, listFlows, listTags, listUserFields, listUserFieldUsage, createTag, createUserField, listEmailAccounts, listEmailTemplates, listRcsMessages, publishWorkflow,
  type WorkflowGraph, type WorkflowNodeType, type TemplateSummary, type FlowSummary, type TagCount, type UserFieldDef,
  type EmailAccount, type EmailTemplate, type RcsMessage,
} from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { AgentResume } from '@/lib/api-agent';
import { NODE_META, NODE_ORDER, RCS_NODE_ORDER, EMAIL_NODE_ORDER, AGENT_NODE_ORDER, HTTP_NODE_ORDER, RCS_GATE_TITRE, EMAIL_GATE_TITRE, AGENT_GATE_TITRE, HTTP_GATE_TITRE, nodeMetaOf } from '@/lib/nodeMeta';
import { isCampaignEligible, waitBeforeSessionMessage, sessionMessageAfterRcs, entryNodeOf, canalDOuvertureDuGraphe } from '@/lib/campaign-eligibility';
import { autoLayoutHorizontal } from '@/lib/workflow-layout';
import { EDGE_OPTS, toRF, fromRF, type RFNode, type RFEdge } from '@/lib/workflow-canevas';
import { useEnregistrementScenario } from '@/lib/use-enregistrement-scenario';
import { TemplatesCtx, nodeTypes, edgeTypes } from '@/components/WorkflowNode';
import { ConfigPanel } from '@/components/WorkflowConfigPanel';

function uid(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}-${Date.now()}`);
}

/**
 * Config de départ d'un bloc qu'on vient de créer. Partagée par les TROIS chemins de création (palette, lâcher
 * dans le vide, insertion sur une flèche) : sans ça, un bloc « Action » né d'un chemin démarrait sans
 * `actionKind` et restait un no-op silencieux tant qu'on ne l'ouvrait pas.
 */
function initialDataFor(wfType: WorkflowNodeType): Record<string, unknown> {
  if (wfType === 'action') return { wfType, actionKind: 'add_tag' };
  if (wfType === 'wait') return { wfType, delay: 1, unit: 'hours' };
  // Question : une ligne de menu VIDE au depart, pour que le menu soit visible et evident a remplir.
  // Pas d'echeance par defaut (`timeoutValue: 0`) : une question attend sans limite, comme un message
  // rapide a boutons. Poser un delai que personne n'a demande ferait partir des contacts dans une
  // branche << pas de reponse >> a leur insu.
  // 🔴 AUCUNE ligne au depart. Une ligne vide dessinerait aussitot une sortie non reliee, donc une
  // pastille rouge « ne mene nulle part » sur un bloc que personne n'a encore configure. Une alerte qui
  // s'allume avant la moindre faute apprend a ignorer les alertes. Le panneau propose « + reponse ».
  if (wfType === 'question') return { wfType, body: '', buttonLabel: '', rows: [], timeoutValue: 0, timeoutUnit: 'hours' };
  if (wfType === 'email') return { wfType, emailAccountId: '', templateId: '', to: { kind: 'literal', value: '' } };
  // Bloc agent : aucun agent choisi au départ, et AUCUNE sortie déclarée. Les sorties sont COPIÉES de la
  // fiche au moment du choix (cf. `appliquerAgent`) ; en inventer ici dessinerait des branches que l'agent
  // ne saurait pas emprunter.
  if (wfType === 'agent') return { wfType, agentId: '', agentLabel: '', sorties: [] };
  return { wfType };
}

/**
 * Éditeur visuel d'un workflow (bot builder). Blocs reliés par des flèches drag-and-drop (tirer depuis le
 * point bas d'un bloc vers un autre). +/poubelle sur chaque flèche. Panneau de config par bloc. Le graphe est
 * validé/sanitisé côté serveur au save.
 *
 * 🔴 CE QUI S'ÉDITE ICI EST UN BROUILLON (lot 7, 2026-09-01). L'enregistrement automatique n'atteint plus les
 * contacts : il écrit une version de travail, et seul le bouton « Publier » la met en ligne. Avant ce lot, une
 * retouche partait en production dans la seconde, y compris pour les parcours déjà en cours.
 */
export function WorkflowBuilder({ tenantId, workflowId, initialGraph, brouillonInitial = false, publieLe = null, mbaEnabled = false, rcsEnabled = false, emailEnabled = false, agents = [], membres = null, requetes = null, canalExige, onPublie }: { tenantId: string; workflowId: string;
  /** Ce que l'éditeur ouvre : le brouillon s'il existe, sinon la version en ligne (cf. `grapheEditable`). */
  initialGraph: WorkflowGraph;
  /** Un brouillon non publié attendait-il déjà à l'ouverture ? Pilote l'état initial du bouton « Publier ». */
  brouillonInitial?: boolean;
  /** Date de la dernière mise en ligne (ISO), null si jamais publié. */
  publieLe?: string | null;
  mbaEnabled?: boolean; rcsEnabled?: boolean; emailEnabled?: boolean; /** Agents IA ACTIFS du workspace. `null` = pas encore chargés (ou lecture en échec), `[]` = aucun : la
   *  brique « Agent IA » est grisée dans les deux cas, mais seul `[]` autorise à AFFIRMER qu'un agent n'est
   *  plus actif. */ agents?: AgentResume[] | null;
  /** Membres de l'équipe, pour le sélecteur d'affectation du bloc « passer à un humain ». */
  membres?: Array<{ id: string; name: string | null; email: string }> | null;
  /** Appels déclarés dans Tools > Connecteurs API, pour le bloc « Appel API ». `null` = pas encore chargés. */
  requetes?: Array<{ id: string; label: string; methode: string; chemin: string }> | null;
  /**
   * LE CANAL QUE CE SCÉNARIO DOIT SAVOIR OUVRIR, quand l'éditeur est monté DEPUIS une campagne.
   *
   * 🔴 SANS LUI, LA VÉRIFICATION N'ARRIVE QU'AU RÉCAPITULATIF, c'est-à-dire après avoir construit tout un
   * scénario. Avec lui, la publication refuse tout de suite, en disant par quoi il faut ouvrir. Absent
   * (l'onglet Scénario ordinaire) : aucune exigence, un scénario n'a pas à savoir ouvrir une campagne.
   */
  canalExige?: 'whatsapp' | 'rcs';
  /** Appelé après une publication réussie. Sert à l'hôte qui doit refermer sa fenêtre et choisir le scénario. */
  onPublie?: () => void }) {
  const t = useT();
  const seed = useMemo(() => toRF(initialGraph), [initialGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(seed.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Données de config des blocs.
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [fields, setFields] = useState<UserFieldDef[]>([]);
  /** Combien de fiches ont chaque champ rempli, sur combien en tout. Vide = relévé indisponible. */
  const [usageChamps, setUsageChamps] = useState<{ total: number; parChamp: Record<string, number> } | null>(null);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [rcsMessages, setRcsMessages] = useState<RcsMessage[]>([]);
  useEffect(() => {
    listTemplates(tenantId).then((r) => setTemplates(r.templates.filter((t) => t.status === 'APPROVED'))).catch(() => {});
    listFlows(tenantId).then((r) => setFlows(r.flows.filter((f) => f.status === 'PUBLISHED'))).catch(() => {});
    listTags(tenantId).then((r) => setTags(r.tags)).catch(() => {});
    listUserFields(tenantId).then((r) => setFields(r.fields)).catch(() => {});
    // Combien de fiches ont chaque champ rempli. Best-effort : en cas d'échec, le sélecteur affiche les
    // champs sans compteur, comme avant. Un relevé manquant ne doit pas empêcher de configurer un bloc.
    // Forme VÉRIFIÉE avant d'être posée dans l'état : une réponse inattendue (backend plus ancien, route non
    // montée, repli d'un mock) afficherait « 0/undefined fiches » dans le sélecteur. Même défense que pour
    // `listRcsMessages` juste en dessous.
    listUserFieldUsage(tenantId)
      .then((r) => { if (r && typeof r.total === 'number' && r.parChamp && typeof r.parChamp === 'object') setUsageChamps(r); })
      .catch(() => {});
    listEmailAccounts(tenantId).then((r) => setEmailAccounts(r.accounts)).catch(() => {});
    listEmailTemplates(tenantId).then((r) => setEmailTemplates(r.templates)).catch(() => {});
    // `Array.isArray` : une réponse sans le champ `messages` (backend plus ancien que le front, route non
    // montée) poserait `undefined` dans l'état, et le premier `.filter` ferait tomber TOUT le builder.
    listRcsMessages(tenantId).then((r) => { if (Array.isArray(r.messages)) setRcsMessages(r.messages); }).catch(() => {});
  }, [tenantId]);

  // Persiste un tag saisi inline dans un nœud « ajout de tag » (au blur) -> il apparaît tout de suite dans Contenus >
  // Tags ET dans l'autocomplétion, sans attendre l'enregistrement du workflow (best-effort ; declareTags au save = filet).
  const commitTag = useCallback(async (raw: string) => {
    const clean = raw.trim().slice(0, 64);
    if (!clean || tags.some((t) => t.tag === clean)) return;
    try { await createTag(tenantId, clean); } catch { /* best-effort */ }
    listTags(tenantId).then((r) => setTags(r.tags)).catch(() => {});
  }, [tenantId, tags]);

  /**
   * CRÉER UN CHAMP DE CONTACT SANS QUITTER LE SCÉNARIO (demande de Julien, 2026-09-11 : « il faut que je
   * puisse créer à la volée un nouveau champ, qui se répercutera bien sûr partout où c'est nécessaire, y
   * compris jusqu'au mini-CRM »).
   *
   * 🔴 IL SE RÉPERCUTE PARTOUT PAR CONSTRUCTION, pas par une synchronisation : c'est la MÊME table que le
   * mini-CRM, la même route que l'écran Contenu > Champs. Il n'y a donc rien à propager, et rien qui puisse
   * se désynchroniser. Décalque de `commitTag` juste au-dessus, qui fait le même geste pour un tag.
   *
   * ⚠️ TYPE `text`, ET C'EST UN CHOIX : le bloc JS range ce que sa fonction rend, converti en texte
   * (`enTexte`), et le bloc « Appel API » fait pareil. Proposer un choix de type ici ferait porter à
   * quelqu'un qui écrit un scénario une décision de modèle de données, pour un champ qui recevra du texte.
   * Le type se change ensuite dans Contenu > Champs, qui est fait pour ça.
   *
   * Rend la CLÉ créée (ou `null` si le nom est refusé, typiquement un doublon), pour que l'appelant la
   * sélectionne tout de suite : créer un champ puis devoir le rechercher dans la liste serait à moitié fait.
   */
  const creerChamp = useCallback(async (label: string): Promise<string | null> => {
    const propre = label.trim().slice(0, 64);
    if (propre === '') return null;
    try {
      const cree = await createUserField(tenantId, { label: propre, type: 'text' });
      setFields((prec) => (prec.some((f) => f.key === cree.key) ? prec : [...prec, cree]));
      return cree.key;
    } catch {
      // Un doublon (409) ou un nom réservé : l'appelant l'annonce, on ne devine pas à sa place.
      return null;
    }
  }, [tenantId]);

  // Une seule cible par SORTIE : relier depuis un handle déjà relié remplace l'arête existante de ce
  // (source, sourceHandle) — un bouton mène à un seul bloc suivant.
  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(
    { ...c, id: uid(), ...EDGE_OPTS },
    eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null))),
  )), [setEdges]);

  const addNode = useCallback((wfType: WorkflowNodeType) => {
    const id = uid();
    setNodes((ns) => [...ns, { id, type: 'wf', position: { x: 60 + (ns.length % 4) * 60, y: 60 + ns.length * 30 }, data: initialDataFor(wfType) }]);
    setSelectedId(id);
  }, [setNodes]);

  // Instance React Flow capturée à l'init (pas de ReactFlowProvider parent -> useReactFlow() indisponible) :
  // sert à screenToFlowPosition pour placer le bloc créé au lâcher de flèche.
  const rfRef = useRef<ReactFlowInstance<RFNode, RFEdge> | null>(null);

  // Crée un bloc connecté, du type DÉJÀ choisi par l'utilisateur (le panneau de droite ne type plus).
  // Réplique l'invariant « une seule arête par (source, sourceHandle) » de onConnect.
  const createConnectedNode = useCallback((wfType: WorkflowNodeType, position: { x: number; y: number }, sourceId: string, sourceHandle?: string) => {
    const nid = uid();
    setNodes((ns) => [...ns, { id: nid, type: 'wf', position, data: initialDataFor(wfType) }]);
    setEdges((eds) => addEdge(
      { id: uid(), source: sourceId, target: nid, ...(sourceHandle ? { sourceHandle } : {}), ...EDGE_OPTS },
      eds.filter((e) => !(e.source === sourceId && (e.sourceHandle ?? null) === (sourceHandle ?? null))),
    ));
    setSelectedId(nid);
  }, [setNodes, setEdges]);

  /** Choix de la NATURE d'un bloc en cours de création (lâcher dans le vide, ou + sur une flèche). */
  type Chooser =
    | { kind: 'connect'; x: number; y: number; screenX: number; screenY: number; sourceId: string; sourceHandle?: string }
    | { kind: 'insert'; edgeId: string; screenX: number; screenY: number };
  const [chooser, setChooser] = useState<Chooser | null>(null);

  /** Insère un bloc du type choisi AU MILIEU d'une flèche : source -> nouveau -> cible. */
  const insertOnEdge = useCallback((edgeId: string, wfType: WorkflowNodeType) => {
    setEdges((eds) => {
      const edge = eds.find((e) => e.id === edgeId);
      if (!edge) return eds;
      const src = nodesRef.current.find((n) => n.id === edge.source);
      const tgt = nodesRef.current.find((n) => n.id === edge.target);
      const nid = uid();
      const x = src && tgt ? (src.position.x + tgt.position.x) / 2 : 120;
      const y = src && tgt ? (src.position.y + tgt.position.y) / 2 : 120;
      setNodes((ns) => [...ns, { id: nid, type: 'wf', position: { x, y }, data: initialDataFor(wfType) }]);
      setSelectedId(nid);
      return [
        ...eds.filter((e) => e.id !== edgeId),
        // La moitié AMONT hérite du sourceHandle d'origine ('true'/'false' d'une condition, 'card:i:btn:j' d'un
        // bouton) : sans ça, insérer un bloc sur la branche « Si réunie » la déconnecterait silencieusement.
        { id: uid(), source: edge.source, target: nid, ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}), ...EDGE_OPTS },
        { id: uid(), source: nid, target: edge.target, ...EDGE_OPTS },
      ];
    });
  }, [setEdges, setNodes]);

  /** Applique le type choisi au bloc en attente de création, puis referme la liste. */
  const pickType = useCallback((wfType: WorkflowNodeType) => {
    setChooser((c) => {
      if (!c) return null;
      if (c.kind === 'connect') createConnectedNode(wfType, { x: c.x, y: c.y }, c.sourceId, c.sourceHandle);
      else insertOnEdge(c.edgeId, wfType);
      return null;
    });
  }, [createConnectedNode, insertOnEdge]);

  // Lâcher une flèche dans le VIDE ouvre la liste des natures de bloc à cet endroit ; le bloc n'est créé
  // qu'une fois la nature choisie. Un lâcher sur un handle valide est déjà géré par onConnect (state.isValid)
  // -> on ne double pas. On n'étend que depuis une SORTIE (fromHandle.type source).
  const onConnectEnd = useCallback<OnConnectEnd>((event, state) => {
    if (state.isValid) return;
    const from = state.fromNode;
    const handle = state.fromHandle;
    if (!from || handle?.type !== 'source') return;
    const rf = rfRef.current;
    if (!rf) return;
    const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!pt) return;
    const p = rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
    // On NE DEVINE PLUS le type : on propose la liste. Le panneau de droite ne sert plus qu'à configurer,
    // donc si on choisissait à la place de l'utilisateur, il n'aurait plus aucun moyen de corriger.
    setChooser({ kind: 'connect', x: p.x - 88, y: p.y - 20, screenX: pt.clientX, screenY: pt.clientY, sourceId: from.id, ...(handle.id ? { sourceHandle: handle.id } : {}) });
  }, []);

  // `nodes` lu via une ref pour enregistrer les listeners UNE seule fois (pas de ré-abonnement à chaque drag).
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // Insertion d'un bloc SUR une flèche (+) : on remplace l'arête par source->nouveau->target.
  useEffect(() => {
    // Insérer sur une flèche demande AUSSI la nature du bloc (même raison que le lâcher dans le vide).
    const onInsert = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { edgeId: string; screenX: number; screenY: number };
      setChooser({ kind: 'insert', edgeId: detail.edgeId, screenX: detail.screenX, screenY: detail.screenY });
    };
    const onDelete = (ev: Event) => {
      const edgeId = (ev as CustomEvent).detail as string;
      setEdges((eds) => eds.filter((e) => e.id !== edgeId));
    };
    /**
     * 🔴 Suppression d'une LIGNE de menu d'un bloc Question. Elle ne peut PAS se faire depuis le panneau,
     * parce qu'elle touche aux ARÊTES autant qu'aux données.
     *
     * L'index d'une ligne EST sa sortie (`row:<i>`). Retirer la 2e ligne d'un menu de 3 fait de la 3e la
     * nouvelle ligne 1 : sans remappage, le contact qui choisit « Non » part dans la branche de la réponse
     * SUPPRIMÉE, et la branche de « Non » devient inatteignable. Rien ne le signalerait : la pastille
     * d'orpheline ne regarde que les sorties NON reliées, et celle-ci l'est.
     */
    const onRowDelete = (ev: Event) => {
      const { nodeId, index } = (ev as CustomEvent).detail as { nodeId: string; index: number };
      setNodes((ns) => ns.map((n) => (n.id === nodeId
        ? { ...n, data: { ...n.data, rows: (Array.isArray(n.data.rows) ? (n.data.rows as unknown[]) : []).filter((_, j) => j !== index) } }
        : n)));
      setEdges((eds) => eds
        // L'arête de la ligne supprimée s'en va avec elle : la garder pointerait vers une branche fantôme.
        .filter((e) => !(e.source === nodeId && e.sourceHandle === `row:${index}`))
        // Les lignes SUIVANTES reculent d'un cran : leurs arêtes suivent, sinon elles désignent la voisine.
        .map((e) => {
          if (e.source !== nodeId) return e;
          const m = /^row:(\d+)$/.exec(e.sourceHandle ?? '');
          const j = m ? Number(m[1]) : -1;
          return j > index ? { ...e, sourceHandle: `row:${j - 1}` } : e;
        }));
    };
    /**
     * 🔴 CHANGER (ou effacer) l'agent d'un bloc EMPORTE les arêtes de ses anciennes règles d'arrêt.
     *
     * Sans ça, elles restent en base alors que leur poignée a disparu : invisibles à l'écran, mais bien
     * enregistrées. Et le danger n'est pas cosmétique. Un bloc agent SANS agent est un passe-plat : il suivait
     * la première arête venue, donc typiquement la branche « échec technique » d'un bloc qu'on vient de vider,
     * et y envoyait tous les contacts sans le moindre signal. Le moteur a été durci depuis (arête libre
     * seulement), mais laisser des arêtes fantômes derrière soi reste la faute que la suppression d'une ligne
     * de menu ci-dessus corrige déjà, pour exactement la même raison.
     *
     * Seules les sorties DÉCLARÉES sont concernées : les réservées ne bougent jamais d'un agent à l'autre.
     */
    const onAgentChange = (ev: Event) => {
      const { nodeId, codes } = (ev as CustomEvent).detail as { nodeId: string; codes: string[] };
      const gardes = new Set(codes.map((c) => `sortie:${c}`));
      setEdges((eds) => eds.filter((e) => {
        if (e.source !== nodeId) return true;
        const h = e.sourceHandle ?? '';
        if (!h.startsWith('sortie:')) return true; // réservées et arêtes libres : intactes
        return gardes.has(h);
      }));
    };
    // Suppression d'un bloc via son ✕ : retire le node ET ses arêtes ; déselectionne si c'était lui.
    const onNodeDelete = (ev: Event) => {
      const nodeId = (ev as CustomEvent).detail as string;
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedId((cur) => (cur === nodeId ? null : cur));
    };
    window.addEventListener('wf-edge-insert', onInsert);
    window.addEventListener('wf-edge-delete', onDelete);
    window.addEventListener('wf-node-delete', onNodeDelete);
    window.addEventListener('wf-row-delete', onRowDelete);
    window.addEventListener('wf-agent-change', onAgentChange);
    return () => {
      window.removeEventListener('wf-edge-insert', onInsert);
      window.removeEventListener('wf-edge-delete', onDelete);
      window.removeEventListener('wf-node-delete', onNodeDelete);
      window.removeEventListener('wf-row-delete', onRowDelete);
      window.removeEventListener('wf-agent-change', onAgentChange);
    };
  }, [setEdges, setNodes, setSelectedId]);

  const patchSelected = useCallback((p: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...p } } : n)));
  }, [selectedId, setNodes]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }, [selectedId, setNodes, setEdges]);

  // Enregistrement automatique du scénario : debounce, un seul PATCH en vol, vidage au démontage et à la
  // fermeture d'onglet. Tout est dans `useEnregistrementScenario` (aucun de ces états ne touche le canevas).
  const enregistrement = useEnregistrementScenario(tenantId, workflowId, nodes, edges, brouillonInitial);

  // Mise en ligne. Deux états seulement : en cours, et le message d'échec.
  const [publication, setPublication] = useState<{ enCours: boolean; erreur: string | null }>({ enCours: false, erreur: null });
  /** Le refus d'ouverture, quand l'éditeur est monté depuis une campagne. `null` = rien à signaler. */
  const [refusOuverture, setRefusOuverture] = useState<string | null>(null);
  const [publieA, setPublieA] = useState<string | null>(publieLe);
  const publier = useCallback(async () => {
    /**
     * 🔴 LA GARDE D'OUVERTURE, QUAND L'ÉDITEUR EST MONTÉ DEPUIS UNE CAMPAGNE. Une campagne part sur une
     * audience FROIDE : si son premier envoi n'est pas du canal attendu, Meta refuse la campagne ENTIÈRE,
     * pas un destinataire. Refuser ICI plutôt qu'au récapitulatif évite de construire tout un scénario
     * avant d'apprendre qu'il ne pourra pas servir.
     *
     * ⚠️ Le graphe est relu de `nodes`/`edges` plutôt que du `graphe` mémoïsé : celui-ci est déclaré plus
     * bas, le nommer dans les dépendances de ce `useCallback` le lirait avant son initialisation.
     */
    if (canalExige) {
      const ouvre = canalDOuvertureDuGraphe(fromRF(nodes, edges));
      if (ouvre !== canalExige) {
        setRefusOuverture(canalExige === 'whatsapp'
          ? t('Ce scénario ne commence pas par un modèle WhatsApp : il ne peut pas ouvrir cet étage. Mettez un bloc « Modèle » en premier, avec un modèle approuvé.',
            'This scenario does not start with a WhatsApp template: it cannot open this step. Put a “Template” block first, with an approved template.')
          : t('Ce scénario ne commence pas par un message RCS : il ne peut pas ouvrir cet étage. Mettez un bloc « Message RCS » en premier.',
            'This scenario does not start with an RCS message: it cannot open this step. Put an “RCS message” block first.'));
        return;
      }
      setRefusOuverture(null);
    }
    setPublication({ enCours: true, erreur: null });
    // 🔴 On vide D'ABORD la file d'enregistrement. L'auto-save attend 1,2 s : publier sans ça, juste après une
    // modification, mettrait en ligne le brouillon PRÉCÉDENT, et l'écran affirmerait pourtant « publié ».
    const propre = await enregistrement.enregistrerMaintenant();
    if (!propre) {
      setPublication({ enCours: false, erreur: t('Modifications pas encore enregistrées : rien n’a été publié.', 'Changes not saved yet: nothing was published.') });
      return;
    }
    try {
      const rep = await publishWorkflow(tenantId, workflowId);
      setPublieA(rep.publishedAt);
      enregistrement.marquerPublie();
      setPublication({ enCours: false, erreur: null });
      onPublie?.();
    } catch (err) {
      setPublication({ enCours: false, erreur: err instanceof Error ? err.message : t('Publication impossible', 'Could not publish') });
    }
  }, [tenantId, workflowId, enregistrement, t, canalExige, nodes, edges, onPublie]);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  // Bloc RACINE (sans arête entrante) + éligibilité CAMPAGNE, calculée avec le MÊME helper que le sélecteur de
  // campagne (source unique : `isCampaignEligible`). Depuis le 2026-08-15, la règle porte sur ce qui OUVRE et
  // non sur la racine : « tag -> template » est éligible. L'avertissement reste posé sur la racine, faute d'un
  // bloc fautif unique (l'inéligibilité peut venir d'une branche, d'une attente ou d'une ambiguïté).
  // Mémoïsé : ces calculs ne dépendent QUE du graphe, alors que le composant re-rend aussi sur la
  // sélection, l'ouverture du chooser, le statut de sauvegarde ou l'arrivée des templates.
  const graphe = useMemo(() => fromRF(nodes, edges), [nodes, edges]);
  // `entryNodeOf` porte déjà cette règle (« bloc sans arête entrante, sinon le premier »), elle est testée, et
  // elle sert juste en dessous à juger l'éligibilité : la réécrire ici en ferait une seconde version.
  const rootNodeId = entryNodeOf(graphe)?.id ?? null;
  const campaignEligible = nodes.length === 0 || isCampaignEligible(graphe);
  // Montage qui ne partira JAMAIS : attente >= 24 h puis message hors template. Nommé au constructeur plutôt
  // que découvert par le silence en production. N'empêche PAS l'enregistrement (le builder sauve en continu).
  const montageImpossible = useMemo(() => waitBeforeSessionMessage(graphe), [graphe]);
  // FORMULAIRE derrière un bloc RCS : un WhatsApp Flow n'a pas d'équivalent RCS, il part donc forcément par
  // WhatsApp, où la fenêtre est fermée si l'échange s'est fait en RCS. (Un message rapide, lui, suit le canal
  // du parcours : il n'est plus concerné.) Signalé, jamais interdit.
  const sessionApresRcs = useMemo(() => sessionMessageAfterRcs(graphe), [graphe]);
  const nomDuBloc = (id: string): string => {
    const n = nodes.find((x) => x.id === id);
    const propre = String(n?.data?.name ?? '').trim();
    return propre || t(...nodeMetaOf(((n?.data?.wfType as WorkflowNodeType) ?? 'template')).label);
  };
  /**
   * CE QUE FAIT L'ATTENTE, dit en une phrase juste pour les trois modes.
   *
   * ⚠️ L'avertissement disait « attend 24 h ou plus » et conseillait de « raccourcir l'attente ». Depuis les
   * modes datés (2026-09-08), les deux sont faux : « jusqu'à demain 9 h » peut ne durer que huit heures, et
   * il n'y a rien à raccourcir, c'est le MODE qu'il faut changer. Un texte faux dans un avertissement envoie
   * l'opérateur chercher un réglage qui n'existe pas.
   */
  const attenteDite = (id: string): { quoi: string; remede: string } => {
    const n = nodes.find((x) => x.id === id);
    const mode = String((n?.data as Record<string, unknown> | undefined)?.waitMode ?? 'delai');
    return mode === 'date' || mode === 'heures_ouvrees'
      ? {
        quoi: t('retient le parcours pour une durée qu’on ne connaît pas d’avance', 'holds the parcours for a length not known in advance'),
        remede: t('Remplace ce bloc par un envoi de template, ou repasse l’attente en délai court.', 'Replace that block with a template, or switch the wait back to a short delay.'),
      }
      : {
        quoi: t('attend 24 h ou plus', 'waits 24h or more'),
        remede: t('Remplace ce bloc par un envoi de template, ou raccourcis l’attente.', 'Replace that block with a template, or shorten the wait.'),
      };
  };

  // Auto-arranger : recalcule les positions (couches horizontales) et recadre. Le changement de position est
  // capté par l'auto-save existant (effet sur [nodes, edges]) -> persistance automatique, aucun appel API dédié.
  function autoArrange() {
    const layout = autoLayoutHorizontal(
      nodes.map((n) => ({ id: n.id })),
      edges.map((e) => ({ source: e.source, target: e.target })),
    );
    setNodes((ns) => ns.map((n) => { const p = layout.get(n.id); return p ? { ...n, position: p } : n; }));
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 300 }));
  }

  // Les blocs proposables, DÉRIVÉS des trois listes de `nodeMeta.ts` avec leur grisage. Une seule construction,
  // consommée par la palette ET par le menu du fil : c'est leur divergence qui a rendu email et RCS
  // inatteignables au fil. Ne pas réintroduire une liste écrite à la main ici.
  // Un agent ACTIF au moins : sans lui, le bloc ne pourrait tenir aucune conversation.
  const agentEnabled = (agents ?? []).length > 0;
  // Un appel déclaré au moins : sans lui, le bloc n'aurait rien à désigner.
  const httpEnabled = (requetes ?? []).length > 0;
  const choixBlocs: Array<{ nt: WorkflowNodeType; actif: boolean; titre: string | undefined }> = [
    ...NODE_ORDER.map((nt) => ({ nt, actif: true, titre: undefined })),
    ...RCS_NODE_ORDER.map((nt) => ({ nt, actif: rcsEnabled, titre: rcsEnabled ? undefined : t(...RCS_GATE_TITRE) })),
    ...EMAIL_NODE_ORDER.map((nt) => ({ nt, actif: emailEnabled, titre: emailEnabled ? undefined : t(...EMAIL_GATE_TITRE) })),
    ...AGENT_NODE_ORDER.map((nt) => ({ nt, actif: agentEnabled, titre: agentEnabled ? undefined : t(...AGENT_GATE_TITRE) })),
    ...HTTP_NODE_ORDER.map((nt) => ({ nt, actif: httpEnabled, titre: httpEnabled ? undefined : t(...HTTP_GATE_TITRE) })),
  ];

  return (
    <div className="flex flex-col gap-3 lg:h-full">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-500">{t('+ Créer un bloc :', '+ Create a block:')}</span>
        {NODE_ORDER.map((nt) => (
          <button key={nt} data-testid={`add-node-${nt}`} onClick={() => addNode(nt)} className="rounded-md border border-ink-200 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50">
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        {/* Bloc RCS : GRISÉ + non cliquable tant qu'aucun agent RCS n'est rattaché au tenant. Le canal est
            complet côté outil, mais rien ne peut partir avant qu'un agent soit déposé et approuvé par Google
            et les opérateurs. Le bloc reste visible pour préparer ses scénarios. */}
        {RCS_NODE_ORDER.map((nt) => (
          <button
            key={nt}
            data-testid={`add-node-${nt}`}
            onClick={() => { if (rcsEnabled) addNode(nt); }}
            disabled={!rcsEnabled}
            title={rcsEnabled ? undefined : t(...RCS_GATE_TITRE)}
            className="rounded-md border border-dashed border-ink-200 px-2 py-1 text-xs text-ink-400 disabled:cursor-not-allowed disabled:opacity-60 enabled:text-brand-600 enabled:hover:bg-brand-50"
          >
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        {/* Bloc Email : GRISÉ + non cliquable tant qu'aucune boîte SMTP n'est connectée (menu Compte > Boîtes
            email). Même doctrine que le bloc RCS ci-dessus. */}
        {EMAIL_NODE_ORDER.map((nt) => (
          <button
            key={nt}
            data-testid={`add-node-${nt}`}
            onClick={() => { if (emailEnabled) addNode(nt); }}
            disabled={!emailEnabled}
            title={emailEnabled ? undefined : t(...EMAIL_GATE_TITRE)}
            className="rounded-md border border-dashed border-ink-200 px-2 py-1 text-xs text-ink-400 disabled:cursor-not-allowed disabled:opacity-60 enabled:text-brand-600 enabled:hover:bg-brand-50"
          >
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        {/* Bloc Agent IA : GRISÉ + non cliquable tant qu'aucun agent n'est actif (menu AI Agent). Même
            doctrine que les deux blocs ci-dessus. */}
        {AGENT_NODE_ORDER.map((nt) => (
          <button
            key={nt}
            data-testid={`add-node-${nt}`}
            onClick={() => { if (agentEnabled) addNode(nt); }}
            disabled={!agentEnabled}
            title={agentEnabled ? undefined : t(...AGENT_GATE_TITRE)}
            className="rounded-md border border-dashed border-ink-200 px-2 py-1 text-xs text-ink-400 disabled:cursor-not-allowed disabled:opacity-60 enabled:text-brand-600 enabled:hover:bg-brand-50"
          >
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        {/* Bloc Appel API : GRISÉ tant qu'aucun appel n'est déclaré dans Tools > Connecteurs API. */}
        {HTTP_NODE_ORDER.map((nt) => (
          <button
            key={nt}
            data-testid={`add-node-${nt}`}
            onClick={() => { if (httpEnabled) addNode(nt); }}
            disabled={!httpEnabled}
            title={httpEnabled ? undefined : t(...HTTP_GATE_TITRE)}
            className="rounded-md border border-dashed border-ink-200 px-2 py-1 text-xs text-ink-400 disabled:cursor-not-allowed disabled:opacity-60 enabled:text-brand-600 enabled:hover:bg-brand-50"
          >
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        <button
          onClick={autoArrange}
          disabled={nodes.length === 0}
          className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-600 hover:bg-ink-50 disabled:opacity-40"
          title={t('Aligner les blocs automatiquement (disposition horizontale)', 'Auto-arrange blocks (horizontal layout)')}
          data-testid="workflow-autoarrange"
        >
          ⇥ {t('Auto-arranger', 'Auto-arrange')}
        </button>
        {/* Indicateur d'enregistrement. Il existait déjà, mais placé en FIN de cette rangée, après une douzaine
            de boutons : sur un écran étroit il passait à la ligne et sortait du champ de vision, d'où le doute
            « est-ce que mon scénario est enregistré ». Il est désormais toujours VISIBLE (fond, bordure) et son
            état au repos DIT qu'il n'y a rien à cliquer, au lieu d'un simple « Enregistrement automatique »
            qu'on pouvait lire comme une option à activer. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs" data-testid="workflow-autosave">
          {enregistrement.erreur ? (
            <>
              <span className="font-medium text-coral">⚠ {t('Échec de l’enregistrement', 'Save failed')}</span>
              <button onClick={enregistrement.enregistrer} className="font-medium text-brand-600 hover:underline">{t('réessayer', 'retry')}</button>
            </>
          ) : enregistrement.enCours ? (
            <span className="text-ink-500">{t('Enregistrement…', 'Saving…')}</span>
          ) : enregistrement.enregistreA ? (
            <span className="text-mint-700">✓ {t('Brouillon enregistré à', 'Draft saved at')} {enregistrement.enregistreA.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          ) : (
            // ⚠️ Ce message DISAIT « aucun bouton à cliquer ». Depuis le lot 7 il y en a un, juste à côté, et
            // c'est lui qui met en ligne : promettre le contraire ferait croire qu'éditer suffit.
            <span className="text-ink-500">✓ {t('Brouillon enregistré automatiquement', 'Draft saved automatically')}</span>
          )}
        </div>
        {/* MISE EN LIGNE. Le bouton n'apparaît que s'il y a quelque chose à publier ; sinon on affiche depuis
            quand la version en cours est en ligne, parce que « rien à publier » et « jamais publié » ne sont
            pas la même situation et que la seconde mérite d'être vue. */}
        {enregistrement.aPublier ? (
          <button
            onClick={() => { void publier(); }}
            disabled={publication.enCours}
            data-testid="workflow-publier"
            title={t('Met cette version en ligne. Les parcours en cours basculent dessus, et il n’y a pas de retour arrière.', 'Puts this version live. Runs in progress switch to it, and there is no going back.')}
            className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {publication.enCours ? t('Publication…', 'Publishing…') : t('Publier', 'Publish')}
          </button>
        ) : (
          <span className="shrink-0 rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs text-ink-500" data-testid="workflow-publie">
            {publieA
              ? `${t('En ligne depuis le', 'Live since')} ${new Date(publieA).toLocaleDateString()}`
              : t('En ligne', 'Live')}
          </span>
        )}
        </div>
      </div>

      {refusOuverture !== null && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="refus-ouverture">
          {refusOuverture}
        </div>
      )}

      {publication.erreur && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="workflow-publier-erreur">
          <b>{t('Publication impossible.', 'Could not publish.')}</b> {publication.erreur}
        </div>
      )}

      {montageImpossible && (() => {
        const attente = attenteDite(montageImpossible.waitNodeId);
        return (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <b>{t('Ce montage ne partira pas.', 'This setup will not be sent.')}</b>{' '}
          {t(
            `Le bloc « ${nomDuBloc(montageImpossible.waitNodeId)} » ${attente.quoi}, puis « ${nomDuBloc(montageImpossible.messageNodeId)} » envoie un message hors template. Passé 24 h sans nouveau message du contact, WhatsApp n'accepte plus qu'un template. ${attente.remede}`,
            `Block “${nomDuBloc(montageImpossible.waitNodeId)}” ${attente.quoi}, then “${nomDuBloc(montageImpossible.messageNodeId)}” sends a non-template message. After 24h without a new message from the contact, WhatsApp only accepts templates. ${attente.remede}`,
          )}
        </div>
        );
      })()}

      {sessionApresRcs && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="alerte-session-apres-rcs">
          <b>{t('Ce montage ne partira pas toujours.', 'This setup will not always be sent.')}</b>{' '}
          {t(
            `« ${nomDuBloc(sessionApresRcs.messageNodeId)} » n'existe QUE sur WhatsApp (formulaire ou question), et il est branché derrière le bloc RCS « ${nomDuBloc(sessionApresRcs.rcsNodeId)} ». Il part donc forcément par WhatsApp, qui ne l'accepte que si le contact y a écrit dans les 24 h. Répondre en RCS ne rouvre pas cette fenêtre. Un message rapide, lui, suivrait le canal du parcours.`,
            `“${nomDuBloc(sessionApresRcs.messageNodeId)}” only exists on WhatsApp (form or question), and it is wired after the RCS block “${nomDuBloc(sessionApresRcs.rcsNodeId)}”. It can only go out over WhatsApp, which accepts it only if the contact wrote there within 24h. Replying on RCS does not reopen that window. A quick message would follow the run channel.`,
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1 lg:flex-row">
        {/* `data-canevas-edition` : c'est ce qui donne aux points de liaison leur zone de prise (globals.css).
            Mesuré le 2026-08-28 : sans elle, la tolérance de visée est de ±2 px sur un point de 5,7 px. */}
        <div data-canevas-edition className="h-[70vh] overflow-hidden rounded-2xl border border-ink-200 bg-[#f3f4f6] lg:h-auto lg:min-h-0 lg:flex-1">
          <TemplatesCtx.Provider value={templates}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onInit={(inst) => { rfRef.current = inst; }}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={EDGE_OPTS}
            // Rayon d'accrochage élargi : par défaut il faut lâcher la flèche à 20 px du petit point d'entrée
            // du bloc visé, sinon rien ne se passe et l'éditeur a l'air cassé. Lâcher SUR le bloc suffit.
            connectionRadius={60}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#cbd5e1" gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
          </TemplatesCtx.Provider>
          {/* Choix de la NATURE du bloc qu'on vient de créer. Consomme les TROIS listes de la palette, avec les
              MÊMES grisages : n'en lire qu'une rendait `email` et `rcs_message` inatteignables dès qu'on créait
              un bloc en tirant un fil, alors qu'ils étaient bien dans la palette. C'est ce qui s'est produit
              quand ces deux canaux ont été ajoutés (palette mise à jour, ce menu-ci oublié).
              Le grisage doit suivre, pas disparaître : proposer un envoi sans agent RCS ni boîte SMTP derrière,
              c'est promettre un envoi qui finira en erreur (cf. la doctrine dans `nodeMeta.ts`). */}
          {chooser && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setChooser(null)} />
              <div
                data-testid="node-type-chooser"
                className="fixed z-50 w-52 rounded-xl border border-ink-200 bg-white p-1.5 shadow-lg"
                // Bornée à la fenêtre : lâcher une flèche en bas ou à droite du canevas sortait la liste de
                // l'écran, donc rendait le bloc impossible à choisir. La hauteur est DÉRIVÉE du nombre
                // d'entrées : la valeur en dur d'avant était calibrée pour 7 et débordait dès qu'on en ajoutait.
                style={{
                  left: Math.max(8, Math.min(chooser.screenX, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 220)),
                  top: Math.max(8, Math.min(chooser.screenY, (typeof window !== 'undefined' ? window.innerHeight : 800) - (40 + choixBlocs.length * 30))),
                }}
              >
                <p className="px-2 py-1 text-[11px] font-medium text-ink-500">{t('Quel bloc ?', 'Which block?')}</p>
                {choixBlocs.map(({ nt, actif, titre }) => (
                  <button
                    key={nt}
                    data-testid={`node-type-${nt}`}
                    onClick={() => { if (actif) pickType(nt); }}
                    disabled={!actif}
                    title={titre}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-700 transition disabled:cursor-not-allowed disabled:text-ink-400 disabled:opacity-60 enabled:hover:bg-brand-50"
                  >
                    <span>{NODE_META[nt].emoji}</span>
                    <span>{t(...NODE_META[nt].label)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm lg:w-[280px] lg:shrink-0 lg:overflow-y-auto">
          {!selected ? (
            <p className="text-sm text-ink-400">{t("Clique un bloc pour le configurer. Tire une flèche depuis le point d'un bloc : lâche sur un autre bloc pour relier, ou dans le vide pour créer un nouveau bloc. Le ✕ en coin d'un bloc le supprime.", "Click a block to configure it. Drag an arrow from a block's dot: drop it on another block to connect, or in empty space to create a new block. The ✕ in a block's corner deletes it.")}</p>
          ) : (
            <ConfigPanel node={selected} tenantId={tenantId} isRoot={selected.id === rootNodeId} campaignEligible={campaignEligible} onPatch={patchSelected} onDelete={deleteSelected} templates={templates} flows={flows} tags={tags} fields={fields} usageChamps={usageChamps} emailAccounts={emailAccounts} emailTemplates={emailTemplates} rcsMessages={rcsMessages} agents={agents} membres={membres} requetes={requetes} onCommitTag={commitTag} onCreerChamp={creerChamp} />
          )}
        </div>
      </div>
    </div>
  );
}
