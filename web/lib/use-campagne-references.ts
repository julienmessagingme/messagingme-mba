'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  listTemplates,
  listWorkflows,
  listUserFields,
  listTags,
  getSettings,
  type TemplateSummary,
  type WorkflowSummary,
  type UserFieldDef,
  type TagCount,
} from '@/lib/api';
import { isCampaignEligible } from '@/lib/campaign-eligibility';

/**
 * Les RÉFÉRENCES de l'écran de campagne : ce qui est chargé une fois au montage et que l'utilisateur ne
 * modifie pas (templates, scénarios, champs, tags, réglages de l'espace).
 *
 * 🔴 Pourquoi CELLE-CI est extraite, et pas les autres (lot 6, 2026-08-31). L'audit demande de découper
 * `CampaignCreateForm` (1 686 lignes, 48 états), et prévient dans la même phrase qu'« une extraction
 * mécanique ne réduit pas la complexité d'état ». C'est le critère : ce bloc-ci est une concern COHÉRENTE
 * (un chargement, ses données, son indicateur d'attente) qui n'interagit avec AUCUN des états de saisie du
 * formulaire. Déplacer à l'inverse les zones de rendu, ou l'enregistrement du brouillon, obligerait à passer
 * quinze à vingt états en paramètres : on aurait déplacé la complexité, pas réduite.
 *
 * ⚠️ `onErreur` est une DÉPENDANCE EXPLICITE, pas un état caché. `reloadTemplates` doit pouvoir afficher une
 * erreur dans le formulaire ; lui laisser un `setError` interne créerait un second endroit où l'écran
 * affiche ses erreurs, invisible depuis le formulaire.
 */
export interface ReferencesCampagne {
  /** Templates APPROUVÉS seulement : ne jamais proposer au sélecteur ce qui ne partira pas. */
  templates: TemplateSummary[];
  /** Scénarios LANÇABLES en campagne (ils ouvrent par un template configuré). */
  workflows: WorkflowSummary[];
  /** Nombre TOTAL de scénarios, éligibles ou non : distingue « aucun scénario » de « aucun lançable ». */
  workflowsTotal: number;
  userFields: UserFieldDef[];
  tags: TagCount[];
  /** Le premier chargement est-il en cours ? Pilote les squelettes de l'écran. */
  loadingRefs: boolean;
  hubspotListsEnabled: boolean;
  hubspotPaused: boolean;
  /**
   * Recharge la SEULE liste des templates (après une création en ligne, ou pour vérifier une approbation).
   *
   * Rend la liste COMPLÈTE, statuts non approuvés compris : le filtre est bon pour le sélecteur, mais il
   * effaçait la seule information qu'on venait chercher, si bien que « toujours en revue » et « approuvé »
   * se ressemblaient trait pour trait et que le bouton avait l'air cassé.
   *
   * `silencieux` : l'échec d'un SONDAGE de fond ne doit pas afficher d'erreur de formulaire. L'utilisateur
   * n'a rien demandé, il remplit sa campagne, et un message rouge qui apparaît tout seul toutes les 15 s
   * ferait croire à un problème de SA saisie. Seul le clic explicite parle.
   */
  reloadTemplates: (silencieux?: boolean) => Promise<TemplateSummary[]>;
}

export function useCampagneReferences(tenantId: string, onErreur: (message: string) => void): ReferencesCampagne {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowsTotal, setWorkflowsTotal] = useState(0);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(true);
  const [hubspotListsEnabled, setHubspotListsEnabled] = useState(false);
  const [hubspotPaused, setHubspotPaused] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // getSettings lancé EN PARALLÈLE mais DÉCOUPLÉ du Promise.all (all-or-nothing) : un hoquet sur les
      // réglages ne doit pas vider templates/scénarios ; le toggle HubSpot reste false par défaut.
      const settingsPromise = getSettings(tenantId).catch(() => null);
      try {
        const [tpl, w, uf, tg] = await Promise.all([
          listTemplates(tenantId),
          listWorkflows(tenantId),
          listUserFields(tenantId),
          listTags(tenantId),
        ]);
        if (!alive) return;
        setTemplates(tpl.templates.filter((x) => x.status === 'APPROVED'));
        // Le sélecteur ne propose QUE les scénarios lançables en broadcast (ce qui OUVRE = un template
        // configuré). Un scénario peut légitimement démarrer autrement (formulaire, message rapide) : il
        // reste valide, mais réservé aux déclenchements en fenêtre garantie, donc hors campagne.
        // L'éligibilité vient du SERVEUR (même règle que la garde de création). Repli sur le calcul local tant
        // qu'une API d'avant ne l'envoie pas : deux conteneurs ne redémarrent pas à la même seconde.
        setWorkflows(w.workflows.filter((x) => x.campaignEligible ?? (x.graph ? isCampaignEligible(x.graph) : false)));
        setWorkflowsTotal(w.workflows.length);
        setUserFields(uf.fields);
        setTags(tg.tags);
      } catch {
        // silencieux : l'erreur de création reste affichée si l'envoi échoue
      } finally {
        if (alive) setLoadingRefs(false);
      }
      const cfg = await settingsPromise;
      if (alive && cfg) {
        setHubspotListsEnabled(cfg.hubspotListsEnabled);
        setHubspotPaused(cfg.campaignsPaused);
      }
    })();
    return () => { alive = false; };
  }, [tenantId]);

  const reloadTemplates = useCallback(async (silencieux = false): Promise<TemplateSummary[]> => {
    try {
      const tpl = await listTemplates(tenantId);
      const tous = Array.isArray(tpl?.templates) ? tpl.templates : [];
      setTemplates(tous.filter((x) => x.status === 'APPROVED'));
      return tous;
    } catch (err) {
      if (!silencieux) onErreur(err instanceof Error ? err.message : 'Rafraîchissement impossible');
      return [];
    }
  }, [tenantId, onErreur]);

  return {
    templates, workflows, workflowsTotal, userFields, tags, loadingRefs,
    hubspotListsEnabled, hubspotPaused, reloadTemplates,
  };
}
