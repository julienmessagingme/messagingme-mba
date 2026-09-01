'use client';

import { createContext, useContext, useEffect, useRef } from 'react';
import {
  Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, useEdges, useUpdateNodeInternals,
  type NodeProps, type EdgeProps, type NodeTypes, type EdgeTypes,
} from '@xyflow/react';
import type { TemplateSummary, WorkflowNodeType } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { AGENT_SORTIES_RESERVEES, nodeMetaOf } from '@/lib/nodeMeta';
import { carouselOutputs } from '@/lib/carousel-outputs';
import { SORTIE_LIBRE } from '@/lib/workflow-sorties';
import { ouvreUneSortie } from '@/lib/rcs-boutons';
import { sortiesDuBloc, type EmailRecipientData } from '@/lib/workflow-canevas';

/**
 * Ce qui est DESSINÉ sur le canevas : la carte d'un bloc et la flèche entre deux blocs.
 *
 * Sorti de `WorkflowBuilder.tsx` le 2026-09-01 (lot 7). Ces deux composants ne parlent au builder que par les
 * props de React Flow et par des `CustomEvent` sur `window` (`wf-node-delete`, `wf-edge-insert`...) : ils ne
 * partagent aucun état avec lui, c'est ce qui rend l'extraction sûre. Le contrat des événements est LE point
 * de couplage restant, il est décrit à chaque `dispatchEvent` ci-dessous et écouté dans le builder.
 */

function summaryOf(data: Record<string, unknown>, t: (fr: string, en?: string) => string): string {
  const wfType = data.wfType as WorkflowNodeType;
  if (wfType === 'template') return (data.templateName as string) || t('choisir un template…', 'choose a template…');
  if (wfType === 'quick_message') return (data.body as string)?.trim() || t('message + réponses rapides…', 'message + quick replies…');
  if (wfType === 'rcs_message') return (data.text as string)?.trim() || t('écrire le message RCS…', 'write the RCS message…');
  if (wfType === 'flow') return (data.flowName as string) || t('choisir un formulaire…', 'choose a form…');
  if (wfType === 'question') {
    const q = (data.body as string)?.trim() ?? '';
    if (q === '') return t('écrire la question…', 'write the question…');
    const n = Array.isArray(data.rows) ? (data.rows as Array<{ title?: string }>).filter((r) => (r?.title ?? '').trim() !== '').length : 0;
    return n === 0 ? q : `${q} (${n} ${t('choix', 'choices')})`;
  }
  if (wfType === 'tag') return (data.tag as string) ? `+ ${data.tag as string}` : t('choisir un tag…', 'choose a tag…');
  if (wfType === 'field') {
    const label = data.fieldLabel as string;
    if (!label) return t('choisir un champ…', 'choose a field…');
    return data.valueKind === 'now' ? `${label} = ${t('maintenant', 'now')}` : `${label} = ${(data.value as string) || '…'}`;
  }
  if (wfType === 'action') {
    const kind = data.actionKind as string;
    const tag = (data.tag as string) ?? '';
    const label = (data.fieldLabel as string) ?? '';
    if (kind === 'add_tag') return tag ? `+ ${tag}` : t('ajouter un tag…', 'add a tag…');
    if (kind === 'remove_tag') return tag ? `− ${tag}` : t('retirer un tag…', 'remove a tag…');
    if (kind === 'set_field') return !label ? t('mettre à jour un champ…', 'update a field…') : data.valueKind === 'now' ? `${label} = ${t('maintenant', 'now')}` : `${label} = ${(data.value as string) || '…'}`;
    if (kind === 'clear_field') return label ? `${label} ${t('(vidé)', '(cleared)')}` : t('vider un champ…', 'clear a field…');
    return t('choisir une action…', 'choose an action…');
  }
  if (wfType === 'wait') {
    const n = Number(data.delay ?? 0);
    const u = String(data.unit ?? 'hours');
    if (!Number.isFinite(n) || n <= 0) return t('durée à choisir…', 'set a duration…');
    const lib = u === 'minutes' ? t('min', 'min') : u === 'days' ? t('j', 'd') : t('h', 'h');
    return `${t('attendre', 'wait')} ${n} ${lib}`;
  }
  if (wfType === 'condition') {
    const n = Array.isArray(data.clauses) ? data.clauses.length : 0;
    if (n === 0) return t('définir une condition…', 'set a condition…');
    const m = data.match === 'any' ? t('au moins une', 'at least one') : t('toutes', 'all');
    return n === 1 ? t(`${m} de 1 condition`, `${m} of 1 condition`) : t(`${m} de ${n} conditions`, `${m} of ${n} conditions`);
  }
  if (wfType === 'email') {
    // Lit les DEUX formes de `data.to` (objet avant le 2026-08-25, liste depuis) : un ancien bloc afficherait
    // sinon « configurer l'envoi » alors qu'il envoie parfaitement.
    const dests: EmailRecipientData[] = Array.isArray(data.to)
      ? (data.to as EmailRecipientData[])
      : [(data.to as EmailRecipientData | undefined) ?? {}];
    const lisibles = dests
      .map((r) => (r.kind === 'field' ? (r.field ? `{{${r.field}}}` : '') : (r.value ?? '')))
      .filter((x) => x !== '');
    if (!data.emailAccountId || !data.templateId || lisibles.length === 0) return t('configurer l’envoi…', 'configure the send…');
    // Au-delà d'un destinataire, on nomme le 1er (celui du « À ») et on compte les autres : trois adresses
    // entières déborderaient de la carte du bloc.
    const reste = lisibles.length - 1;
    return reste === 0
      ? `${t('Mail vers', 'Email to')} ${lisibles[0]}`
      : `${t('Mail vers', 'Email to')} ${lisibles[0]} +${reste}`;
  }
  if (wfType === 'agent') {
    const label = String(data.agentLabel ?? '').trim();
    return label === '' ? t('choisir un agent IA…', 'choose an AI agent…') : label;
  }
  // MBA : pré-câblage inerte, le sous-titre le rappelle (le bloc ne fait rien tant que MBA n'est pas actif).
  return t('la conversation arrive en inbox', 'the conversation lands in the inbox');
}

/**
 * Templates À JOUR, servis aux blocs pour dessiner l'aperçu du message.
 *
 * Pourquoi un contexte et pas les données du bloc : l'aperçu a besoin des IMAGES des cartes, et leurs URL
 * Meta EXPIRENT. Les écrire dans le graphe (que `fromRF` sérialise tel quel) donnerait des vignettes mortes
 * au bout de quelques heures. Le graphe ne garde donc que ce qui est stable (nom des sorties, libellés), et
 * le visuel est relu à chaque affichage.
 */
export const TemplatesCtx = createContext<TemplateSummary[]>([]);

/** Bloc du workflow : carré gris clair, handle cible (haut). Un bloc `template` montre l'APERÇU du message et
 *  expose UNE SORTIE PAR BOUTON quick-reply (handle à droite de la ligne, reliable) ; les boutons URL/formulaire
 *  sont montrés grisés, non reliables (ils sortent de WhatsApp). Les autres blocs ont une seule sortie (bas). */
function WFNode({ id, data, selected }: NodeProps) {
  const t = useT();
  const templates = useContext(TemplatesCtx);
  const updateNodeInternals = useUpdateNodeInternals();
  const wfType = (data.wfType as WorkflowNodeType) ?? 'template';
  const meta = nodeMetaOf(wfType); // tolérant : un type pas encore connu du front (ex. condition) -> repli neutre
  // Un template CAROUSEL n'a aucun bouton de premier niveau : ses boutons vivent dans les cartes, et chacun
  // vaut une sortie (10 cartes x 2 boutons = 20 destinations). `templateCards` sert UNIQUEMENT à dessiner ces
  // sorties : le moteur d'envoi ne lit que `templateButtons`, qui reste vide pour un carousel (sinon on
  // émettrait des boutons de premier niveau que ce template n'a pas, et Meta refuserait l'envoi).
  type NodeButton = { type?: string; text?: string; handle?: string; cardIndex?: number };
  // Aperçu du message : lu sur le template VIVANT (les URL d'image expirent, cf. TemplatesCtx).
  const live = wfType === 'template' && data.templateName ? templates.find((x) => x.name === data.templateName) : undefined;
  const liveCards = live?.carousel?.cards ?? [];
  const showCarousel = liveCards.length > 0;
  // Sorties : celles enregistrées dans le bloc, sinon DÉDUITES du template vivant. Ce repli évite d'avoir à
  // re-sélectionner son template dans chaque scénario déjà construit pour voir apparaître les sorties.
  const stored: NodeButton[] = wfType === 'template' && Array.isArray(data.templateCards) ? (data.templateCards as NodeButton[]) : [];
  const cards: NodeButton[] = stored.length > 0 ? stored : showCarousel ? carouselOutputs(live) : [];
  const buttons: NodeButton[] = cards.length > 0
    ? cards
    : wfType === 'template' && Array.isArray(data.templateButtons)
      ? (data.templateButtons as NodeButton[])
      : wfType === 'rcs_message' && Array.isArray(data.suggestions)
        // Seuls les boutons RÉPONSE se relient : les cinq autres formes sortent de la conversation ou agissent
        // sur le téléphone, et ne renvoient rien au scénario. `ouvreUneSortie` est la MÊME règle que celle du
        // panneau de configuration : une seule définition, sinon un bouton afficherait une sortie qu'il
        // n'alimente jamais.
        ? (data.suggestions as Array<Record<string, unknown>>)
          .filter((b) => b && ouvreUneSortie(b as { kind: string }))
          .map((b): NodeButton => ({ type: 'QUICK_REPLY', text: String(b.text ?? '') }))
      : wfType === 'quick_message' && Array.isArray(data.quickReplies)
        ? (data.quickReplies as unknown[]).map((q): NodeButton => ({ type: 'QUICK_REPLY', text: String(q ?? '') }))
        : [];
  const hasQR = buttons.some((b) => b.type === 'QUICK_REPLY');
  // Le visuel du bloc, montré dans la miniature. MÊME champ pour le message rapide et le message RCS (un seul
  // téléversement, un seul champ d'écran), donc une seule lecture ici.
  const visuel = String(data.imageUrl ?? '').trim();
  // 🔴 Sorties RELIÉES de ce bloc. Un bouton proposé au contact mais branché sur rien est un TROU DE
  // MONTAGE : il tape, et il ne reçoit rien. Vécu par Julien le 2026-08-25, invisible à l'écran comme à
  // l'exécution. On le signale ICI, sur la ligne du bouton, là où la flèche se tire.
  //
  // On lit les arêtes plutôt que de recalculer les handles : le nom d'une sortie est déjà établi quelques
  // lignes plus bas, au moment de dessiner sa poignée. Une seconde définition finirait par diverger et
  // signalerait des boutons parfaitement branchés.
  const aretes = useEdges();
  const reliees = new Set(aretes.filter((e) => e.source === id).map((e) => e.sourceHandle ?? ''));
  // Extrémité de la flèche SÉLECTIONNÉE. Lu ici plutôt que passé par un contexte : `useEdges` est déjà
  // appelé juste au-dessus, et React Flow tient la sélection dans ces mêmes arêtes. Une flèche peut boucler
  // sur son bloc (source == target) : « départ » l'emporte alors, c'est le bout qu'on cherche en premier.
  const flecheChoisie = aretes.find((e) => e.selected);
  const extremite = flecheChoisie?.source === id ? 'depart' : flecheChoisie?.target === id ? 'arrivee' : null;
  // La sortie LIBRE (« toute autre réponse ») n'est volontairement pas concernée : la laisser non reliée est
  // un choix documenté (le parcours s'arrête et l'agent reprend), pas un oubli.
  const orpheline = (h: string): boolean => !reliees.has(h);
  const TITRE_ORPHELINE = t(
    'Ce bouton ne mène nulle part : le contact peut le taper et ne rien recevoir. Tire une flèche depuis ce point.',
    'This button leads nowhere: the contact can tap it and get nothing back. Drag an arrow from this dot.',
  );
  const isCondition = wfType === 'condition';
  const isRcs = wfType === 'rcs_message';
  const isQuestion = wfType === 'question';
  const isAgent = wfType === 'agent';
  // Les règles d'arrêt COPIÉES de la fiche au moment du choix de l'agent. Le bloc est ainsi auto-suffisant :
  // le graphe se lit et se route sans aller relire la table des agents.
  const agentSorties = isAgent ? sortiesDuBloc(data) : [];
  // Lignes du MENU d'un bloc Question, lues défensivement : `data` est du JSON libre, et un scénario
  // enregistré par une version antérieure ne doit jamais faire tomber l'éditeur.
  const questionRows: Array<{ title: string }> = isQuestion && Array.isArray(data.rows)
    ? (data.rows as Array<{ title?: unknown }>).map((r) => ({ title: String(r?.title ?? '') }))
    : [];
  // La sortie « pas de réponse » n'est dessinée QUE si un délai est posé. Sans délai elle ne partirait
  // jamais : l'afficher promettrait une branche morte, et quelqu'un finirait par la relier.
  const questionDelai = isQuestion && Number(data.timeoutValue ?? 0) > 0;
  // Sous un aperçu de carousel, on ne liste QUE ce qui se relie : les boutons lien sont déjà visibles dans
  // l'aperçu, les répéter ici doublerait la hauteur du bloc pour des lignes sur lesquelles on ne peut rien
  // tirer. Hors carousel il n'y a pas d'aperçu, donc on les garde pour le contexte.
  const outputRows = showCarousel ? buttons.filter((b) => b.type === 'QUICK_REPLY') : buttons;

  // 🔴 UNE POIGNÉE QUE REACT FLOW N'A PAS MESURÉE NE SE RELIE PAS, ET RIEN NE LE DIT.
  //
  // Lu dans la source installée (@xyflow/system 0.0.79). React Flow garde les positions des poignées EN
  // CACHE (`node.internals.handleBounds`) et ne les remesure que si la taille EXTÉRIEURE du bloc a changé
  // (`dimensionChanged`) ou si on le lui ordonne (`updateNodeInternals`). Or, au tout début d'un glisser :
  //
  //     const fromHandleInternal = getHandle(nodeId, handleType, handleId, nodeLookup, connectionMode);
  //     if (!fromHandleInternal) { return; }
  //
  // `getHandle` cherche dans le CACHE. Une poignée présente à l'écran mais absente du cache fait sortir
  // `onPointerDown` en silence : le point se voit, se survole, et le glisser ne commence JAMAIS. C'est le
  // « certains boutons de réponses restent rouge et je ne peux pas les relier » de Julien (2026-08-28), et
  // c'est aussi pourquoi passer par l'inbox et revenir répare : le remontage vide le cache, donc remesure.
  //
  // 🔴 CE QUE LA SIGNATURE ÉCRITE À LA MAIN NE POUVAIT PAS VOIR. Elle listait ce qu'on avait l'INTENTION de
  // dessiner, et deux cas divergeaient déjà du DOM réel :
  //   - une ligne de menu au libellé VIDE compte dans `rows` mais ne dessine AUCUNE poignée ; taper son
  //     libellé en ajoute une sans changer la liste des `row:i`, ni la hauteur du bloc ;
  //   - un bouton qui passe de « lien » à « réponse rapide » garde son `btn:i` et gagne une poignée.
  // Dans les deux cas la poignée naissait morte. Le défaut n'est donc pas dans la liste, il est dans le fait
  // d'en tenir une à la main : elle doit reproduire le JSX, et elle finit toujours par s'en écarter.
  //
  // On lit donc la MÊME chose que React Flow : les poignées réellement dans le DOM, dans leur ordre. La
  // dérive devient impossible par construction, et tout ce qu'on ajoutera plus tard est couvert d'avance.
  // (Un déplacement de poignée à taille de bloc CONSTANTE reste hors de portée, mais React Flow le couvre
  // déjà : toute ligne qui grandit change la hauteur du bloc, et son observateur de taille remesure.)
  const hote = useRef<HTMLDivElement>(null);
  const poigneesMesurees = useRef<string | null>(null);
  useEffect(() => {
    // Volontairement SANS tableau de dépendances : la seule source fiable est le DOM après rendu, et aucune
    // valeur de `data` ne le résume. Le garde-fou est la comparaison ci-dessous, pas la liste de React.
    const el = hote.current;
    if (!el) return;
    const signature = Array.from(el.querySelectorAll('.react-flow__handle'))
      .map((h) => h.getAttribute('data-handleid') ?? '')
      .join(',');
    if (signature === poigneesMesurees.current) return;
    poigneesMesurees.current = signature;
    updateNodeInternals(id);
  });

  return (
    <div
      ref={hote}
      className={`relative ${showCarousel ? 'w-52' : 'w-44'} rounded-xl border bg-ink-50 shadow-sm transition ${
        selected ? 'border-brand-500 ring-2 ring-brand-100' : extremite ? 'border-brand-400 ring-2 ring-brand-100' : 'border-ink-300'
      }`}
    >
      {/* Bout de la flèche sélectionnée. L'étiquette est nécessaire en plus de l'anneau : les deux bouts se
          ressembleraient sinon, or la question posée est justement « lequel est le départ ». */}
      {extremite && (
        <span
          data-testid={`wf-extremite-${extremite}`}
          className="absolute -top-2 left-2 z-10 rounded-full bg-brand-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide text-white shadow"
        >
          {extremite === 'depart' ? t('départ', 'from') : t('arrivée', 'to')}
        </span>
      )}
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-400" />
      {/* Suppression directe du bloc (sans passer par le menu de droite). nodrag + stopPropagation : ne déclenche ni
          le drag ni la sélection du bloc. Même pattern que le ✕ des arêtes (CustomEvent -> listener parent). */}
      <button
        className="nodrag absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-[11px] text-coral shadow hover:bg-red-50"
        title={t('Supprimer le bloc', 'Delete block')}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('wf-node-delete', { detail: id })); }}
      >✕</button>
      <div className="flex items-center gap-1.5 rounded-t-xl border-b border-ink-200 bg-white px-2 py-1">
        <span className="text-xs">{meta.emoji}</span>
        <span className="truncate text-[11px] font-semibold text-ink-800">{String(data.name ?? '').trim() || t(...meta.label)}</span>
      </div>
      <div className="truncate px-2 py-1.5 text-[11px] text-ink-500">{summaryOf(data, t)}</div>
      {/* 🔴 LE VISUEL SE VOIT SUR LE BLOC, pas seulement dans le panneau de droite. Demandé par Julien le
          2026-08-28 : « je veux voir cette photo dans la miniature du node ». Un scénario se relit d'un coup
          d'œil sur le canevas, et un bloc qui porte une image sans le montrer oblige à ouvrir chaque bloc
          pour savoir lequel l'a. Même champ (`imageUrl`) pour le message rapide et le message RCS, donc un
          seul aperçu ici. `no-referrer` comme pour les cartes de carousel : l'hébergeur du client n'a pas à
          savoir d'où on regarde. */}
      {visuel !== '' && (
        <div className="border-t border-ink-200 p-1.5" style={{ backgroundColor: '#efeae2' }}>
          <div className="flex h-16 w-full items-center justify-center overflow-hidden rounded bg-ink-100 text-[9px] text-ink-400">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={visuel}
              alt={t('Visuel du message', 'Message image')}
              referrerPolicy="no-referrer"
              data-testid="node-visuel"
              className="h-full w-full object-cover"
              // Une adresse morte (visuel supprimé, CDN du client tombé) laisserait un cadre cassé : on
              // efface l'image et le cadre gris reste, ce qui dit « il y a un visuel, il ne se charge pas ».
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        </div>
      )}
      {showCarousel ? (
        // Aperçu CAROUSEL : bulle d'introduction puis les cartes, EMPILÉES et défilables. Les afficher côte à
        // côte rendrait le bloc large comme 10 cartes ; ici il garde sa taille et on fait défiler.
        <div className="border-t border-ink-200 p-1.5" style={{ backgroundColor: '#efeae2' }}>
          {String(live?.body ?? '').trim() && (
            <div className="mb-1 rounded rounded-tl-none bg-white px-1.5 py-1 text-[9px] leading-snug text-ink-700 shadow-sm">
              <span className="line-clamp-2">{live?.body}</span>
            </div>
          )}
          {/* `nowheel` : la molette fait défiler les cartes au lieu de zoomer le canevas (classe React Flow). */}
          <div className="nowheel max-h-32 space-y-1.5 overflow-y-auto pr-0.5">
            {liveCards.map((card, ci) => (
              <div key={ci} className="overflow-hidden rounded bg-white shadow-sm">
                <div className="flex h-14 w-full items-center justify-center bg-ink-100 text-[9px] text-ink-400">
                  {card.mediaUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.mediaUrl} alt={`${t('Carte', 'Card')} ${ci + 1}`} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  ) : (
                    t('image', 'image')
                  )}
                </div>
                {String(card.body ?? '').trim() && (
                  <div className="px-1.5 py-1 text-[9px] leading-snug text-ink-700"><span className="line-clamp-2">{card.body}</span></div>
                )}
                {/* Les boutons sont montrés ICI pour l'aperçu, mais les POINTS DE LIAISON sont plus bas, hors
                    de la zone qui défile : une poignée sortie du cadre est mesurée à sa position de mise en
                    page (jusqu'à ~600 px sous le bloc, mesuré), et la flèche partirait dans le vide. */}
                {(card.buttons ?? []).map((b, bi) => (
                  <div key={bi} className={`flex items-center gap-1 border-t border-ink-100 px-1.5 py-1 text-[9px] ${b.type === 'QUICK_REPLY' ? 'font-medium text-[#00a5f4]' : 'text-ink-400'}`}>
                    <span className="shrink-0">{b.type === 'QUICK_REPLY' ? '↩︎' : '🔗'}</span>
                    <span className="truncate">{b.text?.trim() || (b.type === 'QUICK_REPLY' ? t('Réponse', 'Reply') : t('Lien', 'Link'))}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {isAgent ? (
        // Bloc AGENT : ses sorties sont les seules façons d'en RESSORTIR. Il n'a pas de sortie libre : tant
        // que l'agent tient la conversation, la réponse du contact lui revient à LUI, elle ne fait pas
        // avancer le parcours. Deux familles, dans cet ordre : les règles d'arrêt déclarées par le client
        // (les plus parlantes), puis les sorties que la plateforme pose toujours.
        <div className="border-t border-ink-200">
          {agentSorties.map((s) => {
            const h = `sortie:${s.code}`;
            return (
              <div key={h} className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] text-ink-700 first:border-t-0">
                <span className="shrink-0">➜</span>
                <span className="truncate">{s.label}</span>
                {orpheline(h) && <span data-testid={`sortie-orpheline-${h}`} className="shrink-0 text-coral" title={TITRE_ORPHELINE}>⚠</span>}
                <Handle type="source" id={h} position={Position.Right} className={`!h-2.5 !w-2.5 !border-2 !border-white ${orpheline(h) ? '!bg-coral' : '!bg-brand-500'}`} title={orpheline(h) ? TITRE_ORPHELINE : t(`Relier « ${s.label} »`, `Connect “${s.label}”`)} />
              </div>
            );
          })}
          {AGENT_SORTIES_RESERVEES.map((s) => (
            <div key={s.handle} className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-amber-700 first:border-t-0">
              <span className="shrink-0">{s.emoji}</span>
              <span className="truncate">{t(...s.label)}</span>
              <Handle type="source" id={s.handle} position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-amber-500" title={t(...s.aide)} />
            </div>
          ))}
        </div>
      ) : isQuestion ? (
        // Bloc QUESTION : une sortie par ligne du menu, la sortie LIBRE (le contact écrit au lieu de
        // choisir), et l'échéance « pas de réponse » quand un délai est posé. Les trois coexistent : un
        // menu n'empêche pas d'écrire, et le silence est un troisième cas, distinct des deux autres.
        <div className="border-t border-ink-200">
          {questionRows.map((r, i) => {
            // Une ligne au libellé VIDE n'est jamais envoyée (`sendList` l'écarte) : elle ne doit donc pas
            // offrir de poignée, sinon on relierait une branche que le contact ne pourra jamais prendre.
            const vide = r.title.trim() === '';
            return (
              <div key={`row${i}`} className={`relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] first:border-t-0 ${vide ? 'text-ink-400' : 'text-ink-700'}`}>
                <span className="shrink-0">☰</span>
                <span className="truncate">{vide ? t('réponse à écrire…', 'answer to write…') : r.title}</span>
                {!vide && orpheline(`row:${i}`) && <span data-testid={`sortie-orpheline-row:${i}`} className="shrink-0 text-coral" title={TITRE_ORPHELINE}>⚠</span>}
                {vide ? (
                  <span className="absolute right-[-5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border border-white bg-ink-300" title={t('Ligne sans libellé : elle ne partira pas', 'Row without a label: it will not be sent')} />
                ) : (
                  <Handle type="source" id={`row:${i}`} position={Position.Right} className={`!h-2.5 !w-2.5 !border-2 !border-white ${orpheline(`row:${i}`) ? '!bg-coral' : '!bg-brand-500'}`} title={orpheline(`row:${i}`) ? TITRE_ORPHELINE : t(`Relier « ${r.title} »`, `Connect “${r.title}”`)} />
                )}
              </div>
            );
          })}
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] text-ink-700">
            <span className="shrink-0">✎</span>
            <span className="truncate">{t('Toute autre réponse', 'Any other reply')}</span>
            {/* 🔴 La poignée porte un NOM (`libre`), traduit en « aucune poignée » à l'enregistrement. Sans nom,
                React Flow ancrait cette flèche sur la PREMIÈRE ligne du menu. Voir `lib/workflow-sorties.ts`. */}
            <Handle type="source" id={SORTIE_LIBRE} position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-500" title={t('Le contact écrit au lieu de choisir dans le menu', 'The contact writes instead of picking from the menu')} />
          </div>
          {questionDelai && (
            <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-amber-700">
              <span className="shrink-0">⏱</span>
              <span className="truncate">{t('Pas de réponse', 'No reply')}</span>
              <Handle type="source" id="timeout" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-amber-500" title={t('Le contact n’a pas répondu dans le délai', 'The contact did not reply within the delay')} />
            </div>
          )}
        </div>
      ) : isRcs ? (
        // Bloc RCS : les DEUX dimensions coexistent, et il ne faut pas que l'une masque l'autre.
        // « Envoyé » et « Non joignable » qualifient la LIVRAISON du message ; les boutons qualifient la
        // RÉPONSE du contact. Un bloc avec boutons doit donc afficher les deux séries de sorties, sinon la
        // cascade de repli disparaîtrait de l'écran dès qu'on ajoute un bouton.
        <div className="border-t border-ink-200">
          {outputRows.filter((b) => b.type === 'QUICK_REPLY').map((b, i) => (
            <div key={`qr${i}`} className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] text-ink-700 first:border-t-0">
              <span className="shrink-0">↩︎</span>
              <span className="truncate">{b.text || t('Réponse', 'Reply')}</span>
              {orpheline(`btn:${i}`) && <span data-testid={`sortie-orpheline-btn:${i}`} className="shrink-0 text-coral" title={TITRE_ORPHELINE}>⚠</span>}
              <Handle type="source" id={`btn:${i}`} position={Position.Right} className={`!h-2.5 !w-2.5 !border-2 !border-white ${orpheline(`btn:${i}`) ? '!bg-coral' : '!bg-brand-500'}`} title={orpheline(`btn:${i}`) ? TITRE_ORPHELINE : t(`Relier « ${b.text} »`, `Connect "${b.text}"`)} />
            </div>
          ))}
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-emerald-700">
            <span className="shrink-0">✓</span>
            <span className="truncate">{t('Envoyé', 'Sent')}</span>
            <Handle type="source" id="sent" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-emerald-500" title={t('Le message RCS est parti', 'The RCS message was sent')} />
          </div>
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-coral">
            <span className="shrink-0">✕</span>
            <span className="truncate">{t('Non joignable en RCS', 'Not reachable on RCS')}</span>
            <Handle type="source" id="unreachable" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-coral" title={t('Le contact n’est pas joignable en RCS : brancher un repli', 'Contact not reachable on RCS: connect a fallback')} />
          </div>
        </div>
      ) : hasQR ? (
        // Au moins un bouton quick-reply -> une SORTIE par bouton (QR = handle reliable à droite ; URL/flow grisé).
        <div className="border-t border-ink-200">
          {outputRows.map((b, i) => {
            const isQR = b.type === 'QUICK_REPLY';
            const icon = b.type === 'URL' ? '🔗' : b.type === 'FLOW' ? '📋' : '↩︎';
            const fallback = b.type === 'URL' ? t('Lien', 'Link') : b.type === 'FLOW' ? t('Formulaire', 'Form') : t('Réponse', 'Reply');
            return (
              <div key={i} className={`relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] first:border-t-0 ${isQR ? 'text-ink-700' : 'text-ink-400'}`}>
                <span className="shrink-0">{icon}</span>
                {b.cardIndex !== undefined && <span className="shrink-0 rounded bg-ink-200 px-1 text-[9px] font-medium text-ink-600">C{b.cardIndex + 1}</span>}
                <span className="truncate">{b.text || fallback}</span>
                {isQR ? (
                  // Le nom de la sortie DOIT être celui que l'envoi pose en payload, sinon le tap ne retrouve
                  // pas sa branche : `handle` vient du template (carousel), sinon l'index du bouton.
                  <>
                    {orpheline(b.handle ?? `btn:${i}`) && <span data-testid={`sortie-orpheline-${b.handle ?? `btn:${i}`}`} className="shrink-0 text-coral" title={TITRE_ORPHELINE}>⚠</span>}
                    <Handle type="source" id={b.handle ?? `btn:${i}`} position={Position.Right} className={`!h-2.5 !w-2.5 !border-2 !border-white ${orpheline(b.handle ?? `btn:${i}`) ? '!bg-coral' : '!bg-brand-500'}`} title={orpheline(b.handle ?? `btn:${i}`) ? TITRE_ORPHELINE : t(`Relier « ${b.text || fallback} »`, `Connect “${b.text || fallback}”`)} />
                  </>
                ) : (
                  <span className="absolute right-[-5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border border-white bg-ink-300" title={t('Bouton URL / formulaire : sort de WhatsApp, non reliable', 'URL / form button: leaves WhatsApp, not connectable')} />
                )}
              </div>
            );
          })}
          {/* Sortie LIBRE : l'arête ENREGISTRÉE ne porte aucun sourceHandle, et c'est elle que l'exécuteur suit
              quand le contact ÉCRIT au lieu de taper un bouton. Non reliée, une réponse hors boutons termine le
              parcours et rend la parole à l'agent : c'est voulu, mais il faut pouvoir choisir. */}
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] text-ink-700">
            <span className="shrink-0">✎</span>
            <span className="truncate">{t('Toute autre réponse', 'Any other reply')}</span>
            {/* 🔴 MÊME couleur que les autres sorties. Elle était grise, et Julien en a conclu le 2026-08-26
                qu'elle n'était pas reliable : sur un bloc où tous les autres points sont bleus, un point gris
                se lit comme désactivé.
                🔴 Et le 2026-08-28 on a trouvé pourquoi il avait raison sur le fond : sans NOM de poignée,
                React Flow ancrait la flèche de cette sortie sur la ligne de la PREMIÈRE réponse rapide. On la
                reliait, et elle s'affichait ailleurs, là où une flèche partait déjà. Voir
                `lib/workflow-sorties.ts`. */}
            <Handle type="source" id={SORTIE_LIBRE} position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-500" title={t('Le contact écrit au lieu de taper un bouton : relie ce point pour prévoir ce cas', 'The contact writes instead of tapping a button: connect this dot to handle that case')} />
          </div>
        </div>
      ) : isCondition ? (
        // Node condition : DEUX sorties fixes, à droite. Les id 'true'/'false' sont ceux que le moteur route
        // (engine.walk). Chaque sortie se relie à un bloc différent.
        <div className="border-t border-ink-200">
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-emerald-700 first:border-t-0">
            <span className="shrink-0">✓</span>
            <span className="truncate">{t('Si réunie', 'If met')}</span>
            <Handle type="source" id="true" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-emerald-500" title={t('Si la condition est réunie', 'If the condition is met')} />
          </div>
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-coral first:border-t-0">
            <span className="shrink-0">✕</span>
            <span className="truncate">{t('Sinon', 'Otherwise')}</span>
            <Handle type="source" id="false" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-coral" title={t('Sinon (condition non réunie)', 'Otherwise (condition not met)')} />
          </div>
        </div>
      ) : (
        // Aucun quick-reply (0 bouton, ou seulement URL/formulaire) -> une seule sortie bas (le bloc peut
        // quand même mener au suivant après réponse). Les boutons URL/flow sont montrés grisés pour contexte.
        <>
          {buttons.length > 0 && (
            <div className="border-t border-ink-200">
              {buttons.map((b, i) => (
                <div key={i} className="flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] text-ink-400 first:border-t-0">
                  <span className="shrink-0">{b.type === 'URL' ? '🔗' : '📋'}</span>
                  <span className="truncate">{b.text || (b.type === 'URL' ? t('Lien', 'Link') : t('Formulaire', 'Form'))}</span>
                </div>
              ))}
            </div>
          )}
          {/* La sortie unique d'un bloc sans branche EST la sortie libre : même nom de poignée, donc une arête
              enregistrée sans poignée s'y rattache quel que soit le type de bloc. */}
          <Handle type="source" id={SORTIE_LIBRE} position={Position.Bottom} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-500" title={t('Tirer une flèche', 'Drag an arrow')} />
        </>
      )}
    </div>
  );
}

/**
 * Arête courbée avec, au milieu, une poubelle (supprimer) et un + (insérer un bloc entre les deux).
 *
 * SÉLECTIONNÉE, elle passe au bleu de marque et s'épaissit. Sur un scénario chargé, les flèches se croisent
 * et se recouvrent : en cliquer une était le seul moyen de la désigner, mais rien à l'écran ne disait
 * LAQUELLE on venait de désigner, donc ni d'où elle partait ni où elle allait. Le surlignage répond à ça, et
 * les deux blocs qu'elle relie s'annoncent « départ » / « arrivée » (cf. `WFNode`), parce que la couleur
 * seule ne suffit pas quand les deux bouts sont hors de l'écran.
 */
function WFEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected }: EdgeProps) {
  const t = useT();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        // `brand-500` de la palette (tailwind.config), en dur parce qu'un attribut SVG `stroke` ne lit pas
        // une classe Tailwind. Épaissie aussi : sur fond gris clair, la couleur seule se voit mal.
        style={selected ? { stroke: '#0080D6', strokeWidth: 3.5 } : { stroke: '#94a3b8', strokeWidth: 2 }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button onClick={(ev) => window.dispatchEvent(new CustomEvent('wf-edge-insert', { detail: { edgeId: id, screenX: ev.clientX, screenY: ev.clientY } }))} title={t('Insérer un bloc', 'Insert a block')} className="flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-xs text-brand-600 shadow hover:bg-brand-50">+</button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('wf-edge-delete', { detail: id }))} title={t('Supprimer la flèche', 'Delete arrow')} className="flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-[11px] text-coral shadow hover:bg-red-50">✕</button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const nodeTypes: NodeTypes = { wf: WFNode };
export const edgeTypes: EdgeTypes = { wf: WFEdge };
