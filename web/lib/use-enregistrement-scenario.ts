'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { updateWorkflow } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fromRF, type RFNode, type RFEdge } from '@/lib/workflow-canevas';

/**
 * L'ENREGISTREMENT du scénario en cours d'édition : le debounce, la sérialisation d'un seul PATCH en vol, le
 * vidage au démontage et à la fermeture d'onglet, l'état affiché par l'indicateur.
 *
 * 🔴 Pourquoi CELUI-CI est extrait (lot 7, 2026-09-01), au même critère que `useCampagneReferences` : c'est une
 * concern COHÉRENTE (un enregistrement, ses garde-fous, son état) qui ne touche AUCUN autre état du builder,
 * et c'est exactement le code que le brouillon/publié vient modifier juste après. Déplacer à l'inverse le
 * canevas ou la sélection obligerait à faire transiter la moitié du composant en paramètres.
 *
 * ⚠️ Il n'y a PAS de bouton « Enregistrer » : on sauvegarde ~1,2 s après la dernière édition. Les deux vidages
 * (démontage, `beforeunload`) ne sont donc pas du zèle, ce sont eux qui évitent de perdre les toutes dernières
 * modifications, ce qui serait PIRE qu'un bouton manuel.
 */
export interface EnregistrementScenario {
  /** Un PATCH est-il en vol ? */
  enCours: boolean;
  /** Instant du dernier enregistrement RÉUSSI. null = rien n'a encore été enregistré dans cette session. */
  enregistreA: Date | null;
  /** Message d'échec du dernier enregistrement, à afficher avec un « réessayer ». */
  erreur: string | null;
  /** Enregistre TOUT DE SUITE (bouton « réessayer »), sans attendre le debounce. */
  enregistrer: () => void;
  /** Reste-t-il un brouillon non publié ? C'est la RÉPONSE DU SERVEUR au dernier enregistrement, pas une
   *  déduction locale : un enregistrement identique au publié ne laisse aucun brouillon derrière lui. */
  aPublier: boolean;
  /**
   * Vide la file d'enregistrement et dit si TOUT est bien parti. À appeler AVANT de publier : sans ça, un
   * clic sur « Publier » dans la seconde qui suit une modification mettrait en ligne le brouillon PRÉCÉDENT,
   * celui d'avant la dernière frappe, et personne ne le verrait.
   */
  enregistrerMaintenant: () => Promise<boolean>;
  /** L'appelant vient de publier : plus rien n'est en attente. */
  marquerPublie: () => void;
}

export function useEnregistrementScenario(
  tenantId: string,
  workflowId: string,
  nodes: RFNode[],
  edges: RFEdge[],
  /** Y avait-il déjà un brouillon en attente à l'ouverture ? (`draftGraph !== null` côté serveur) */
  brouillonInitial = false,
): EnregistrementScenario {
  const t = useT();
  const [enCours, setEnCours] = useState(false);
  const [enregistreA, setEnregistreA] = useState<Date | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [aPublier, setAPublier] = useState(brouillonInitial);

  const graphRef = useRef({ nodes, edges });
  useEffect(() => { graphRef.current = { nodes, edges }; }, [nodes, edges]);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);

  const doSave = useCallback(async (keepalive = false): Promise<void> => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    // Sérialise : un seul PATCH en vol. Si un save tourne déjà, on marque « sale » et il re-sauvera à la fin avec
    // le graphe le plus récent (évite qu'un PATCH plus ancien réponde après et écrase une version plus récente).
    if (savingRef.current) { dirtyRef.current = true; return; }
    savingRef.current = true;
    dirtyRef.current = false;
    setEnCours(true);
    setErreur(null);
    let echoue = false;
    try {
      const rep = await updateWorkflow(tenantId, workflowId, { graph: fromRF(graphRef.current.nodes, graphRef.current.edges) }, keepalive ? { keepalive: true } : undefined);
      setEnregistreA(new Date());
      // Repli `true` si le serveur ne dit rien (backend plus ancien que le front) : on préfère proposer une
      // publication inutile, qui ne coûte rien, à masquer un bouton dont l'écran a besoin.
      setAPublier(typeof rep?.brouillon === 'boolean' ? rep.brouillon : true);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
      dirtyRef.current = true; // laisse une chance au prochain debounce / au bouton « réessayer »
      echoue = true;
    } finally {
      setEnCours(false);
      savingRef.current = false;
    }
    // Des modifs arrivées PENDANT le save -> re-sauver UNE fois avec le graphe le plus récent.
    //
    // ⚠️ JAMAIS après un ÉCHEC. Le drapeau « sale » est alors posé par l'échec lui-même, donc relancer ici
    // bouclait à l'infini, sans aucun délai, sur toute erreur persistante (session expirée en tête), et même
    // après démontage du composant. C'est le bouton « réessayer » et le prochain debounce qui reprennent.
    if (dirtyRef.current && !echoue) void doSave(keepalive);
  }, [tenantId, workflowId, t]);

  // doSave via une ref : la planification du debounce ne dépend QUE de [nodes, edges] (pas de doSave), pour ne pas
  // relancer une sauvegarde au simple changement de langue (doSave dépend de `t`).
  const doSaveRef = useRef(doSave);
  useEffect(() => { doSaveRef.current = doSave; }, [doSave]);

  // Planifie une sauvegarde debounce à chaque édition. Skip le rendu INITIAL (chargement du graphe) : on ne
  // sauvegarde pas tant que l'utilisateur n'a rien touché.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    dirtyRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void doSaveRef.current(); }, 1200);
  }, [nodes, edges]);

  // Flush au démontage + fermeture d'onglet : si des modifs sont en attente, on sauvegarde tout de suite en
  // `keepalive` (la requête survit au déchargement de la page).
  useEffect(() => {
    const flush = () => { if (dirtyRef.current) void doSaveRef.current(true); };
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, []);

  const enregistrer = useCallback(() => { void doSaveRef.current(); }, []);

  /**
   * Attend que la file soit vide, puis rend `true` si tout est bien enregistré.
   *
   * La boucle d'attente n'est pas du zèle : `doSave` REND LA MAIN TOUT DE SUITE quand un PATCH est déjà en
   * vol (il se contente de marquer « sale »). L'appeler et l'attendre ne prouverait donc rien dans ce cas
   * précis. Bornée à 4 s pour ne jamais bloquer un bouton sur une requête qui traîne.
   */
  const enregistrerMaintenant = useCallback(async (): Promise<boolean> => {
    for (let garde = 0; garde < 100 && savingRef.current; garde += 1) {
      await new Promise((r) => { setTimeout(r, 40); });
    }
    if (dirtyRef.current) await doSaveRef.current();
    return !dirtyRef.current;
  }, []);

  const marquerPublie = useCallback(() => { setAPublier(false); }, []);

  return { enCours, enregistreA, erreur, enregistrer, aPublier, enregistrerMaintenant, marquerPublie };
}
