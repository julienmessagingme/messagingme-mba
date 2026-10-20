'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, updateWorkflow } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { fromRF, type RFNode, type RFEdge } from '@/lib/workflow-canevas';
import { CADENCE_SCENARIO, CadenceEnregistrement } from '@/lib/cadence-enregistrement';

/**
 * L'ENREGISTREMENT du scénario en cours d'édition : la cadence des envois, le vidage au démontage et à la fermeture
 * d'onglet, l'état affiché par l'indicateur.
 *
 * 🔴 Pourquoi CELUI-CI est extrait (lot 7, 2026-09-01), au même critère que `useCampagneReferences` : c'est une
 * concern COHÉRENTE (un enregistrement, ses garde-fous, son état) qui ne touche AUCUN autre état du builder,
 * et c'est exactement le code que le brouillon/publié vient modifier juste après. Déplacer à l'inverse le
 * canevas ou la sélection obligerait à faire transiter la moitié du composant en paramètres.
 *
 * 🔴 QUAND ENVOYER se décide dans `CadenceEnregistrement` (`cadence-enregistrement.ts`), et c'est là qu'est dit
 * pourquoi : 434 enregistrements en cinq minutes le 2026-10-20, la console entière coupée par le plafond de débit.
 * Ce hook ne fait que lui dire qu'une modification a eu lieu et lui fournir l'envoi.
 *
 * ⚠️ Il n'y a PAS de bouton « Enregistrer » : on sauvegarde ~1,2 s après la dernière édition, au plus une fois toutes
 * les 5 s. Les deux vidages (démontage, `beforeunload`) ne sont donc pas du zèle, ce sont eux qui évitent de perdre
 * les toutes dernières modifications, ce qui serait PIRE qu'un bouton manuel.
 */
/** La pause sur un 429 quand le serveur ne dit pas combien attendre : la fenêtre du plafond par utilisateur. */
const PAUSE_DEBIT_PAR_DEFAUT_MS = 60_000;
/** Un `retry-after` démesuré (un quota « jusqu'à demain ») ne suspend pas l'éditeur des heures : on retente avant. */
const PAUSE_DEBIT_MAX_MS = 120_000;

export interface EnregistrementScenario {
  /** Un PATCH est-il en vol ? */
  enCours: boolean;
  /** Instant du dernier enregistrement RÉUSSI. null = rien n'a encore été enregistré dans cette session. */
  enregistreA: Date | null;
  /** Message d'échec du dernier enregistrement, à afficher avec un « réessayer ». */
  erreur: string | null;
  /** Enregistre TOUT DE SUITE (bouton « réessayer »), sans attendre le délai. */
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

const serialiser = (nodes: RFNode[], edges: RFEdge[]): string => JSON.stringify(fromRF(nodes, edges));

export function useEnregistrementScenario(
  tenantId: string,
  workflowId: string,
  nodes: RFNode[],
  edges: RFEdge[],
  /** Y avait-il déjà un brouillon en attente à l'ouverture ? (`draftGraph !== null` côté serveur) */
  brouillonInitial = false,
  /**
   * Les codes publics que le serveur vient de poser (`nod_…`, par identifiant de bloc), après chaque enregistrement
   * réussi. Un bloc neuf n'en a qu'à partir de là : sans cette remontée, son bouton « copier le code » et le choix de
   * la cible d'un « Aller à » resteraient vides jusqu'à la réouverture du scénario (RC5).
   */
  surCodes?: (codes: Map<string, string>) => void,
): EnregistrementScenario {
  const t = useT();
  const [enCours, setEnCours] = useState(false);
  const [enregistreA, setEnregistreA] = useState<Date | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [aPublier, setAPublier] = useState(brouillonInitial);

  const graphRef = useRef({ nodes, edges });
  useEffect(() => { graphRef.current = { nodes, edges }; }, [nodes, edges]);

  // L'envoi lit ses dépendances par une ref : la cadence est créée UNE fois, et un changement de langue ou de
  // `surCodes` ne doit ni la recréer ni perdre ce qu'elle a en attente.
  const envoyer = async (contenu: string, keepalive: boolean): Promise<void> => {
    const rep = await updateWorkflow(tenantId, workflowId, { graph: JSON.parse(contenu) }, keepalive ? { keepalive: true } : undefined);
    setEnregistreA(new Date());
    if (surCodes && Array.isArray(rep?.graph?.nodes)) {
      const codes = new Map<string, string>();
      for (const n of rep.graph.nodes) if (typeof n.data?.code === 'string' && n.data.code !== '') codes.set(n.id, n.data.code);
      surCodes(codes);
    }
    // Repli `true` si le serveur ne dit rien (backend plus ancien que le front) : on préfère proposer une
    // publication inutile, qui ne coûte rien, à masquer un bouton dont l'écran a besoin.
    setAPublier(typeof rep?.brouillon === 'boolean' ? rep.brouillon : true);
  };
  const envoyerRef = useRef(envoyer);
  useEffect(() => { envoyerRef.current = envoyer; });
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  const cadenceRef = useRef<CadenceEnregistrement | null>(null);
  if (cadenceRef.current === null) {
    // La référence est le scénario tel qu'ouvert : la mesure des blocs au montage ou une sélection n'envoie rien.
    cadenceRef.current = new CadenceEnregistrement({
      lire: () => serialiser(graphRef.current.nodes, graphRef.current.edges),
      envoyer: (contenu, keepalive) => envoyerRef.current(contenu, keepalive),
      pauseApres: (e) => (e instanceof ApiError && e.status === 429 ? Math.min(e.attenteMs ?? PAUSE_DEBIT_PAR_DEFAUT_MS, PAUSE_DEBIT_MAX_MS) : null),
      surEtat: (etat) => {
        setEnCours(etat.enCours);
        // Au départ, l'échec d'avant n'est plus l'état affiché : « réessayer » montre l'envoi, pas l'ancien échec.
        if (etat.enCours) { setErreur(null); return; }
        const e = etat.erreur;
        setErreur(e === null ? null : e instanceof Error ? e.message : tRef.current('Enregistrement impossible', 'Could not save'));
      },
    }, CADENCE_SCENARIO, serialiser(nodes, edges));
  }
  const cadence = cadenceRef.current;

  // Chaque changement de la liste des blocs (édition, mais aussi sélection, mesure, glisser) le signale ; la cadence
  // décide s'il y a quelque chose à envoyer, et quand.
  useEffect(() => { cadence.modifie(); }, [cadence, nodes, edges]);

  // Vidage au démontage + fermeture d'onglet : ce qui reste part tout de suite en `keepalive` (la requête survit au
  // déchargement de la page).
  useEffect(() => {
    const vider = () => { void cadence.maintenant(true); };
    window.addEventListener('beforeunload', vider);
    return () => { window.removeEventListener('beforeunload', vider); vider(); cadence.arreter(); };
  }, [cadence]);

  const enregistrer = useCallback(() => { void cadence.maintenant(); }, [cadence]);
  const enregistrerMaintenant = useCallback(() => cadence.maintenant(), [cadence]);
  const marquerPublie = useCallback(() => { setAPublier(false); }, []);

  return { enCours, enregistreA, erreur, enregistrer, aPublier, enregistrerMaintenant, marquerPublie };
}
