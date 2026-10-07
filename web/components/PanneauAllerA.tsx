'use client';

import { useEffect, useMemo, useState } from 'react';
import { listNodes, listWorkflows, type NodeListItem, type WorkflowSummary } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { nodeMetaOf } from '@/lib/nodeMeta';
import type { RFNode } from '@/lib/workflow-canevas';

/**
 * LE PANNEAU DU BLOC « ALLER À » (RC5, livraison B). La cible se choisit de deux façons, au choix de Julien : un
 * sélecteur (le scénario, puis le bloc, par son nom et son type), ou un code collé (`nod_…`, copié depuis la carte d'un
 * bloc). Les deux écrivent la même chose : `cible`, le code, et `cibleLibelle`, le nom que la carte affiche.
 *
 * 🔴 D'OÙ VIENNENT LES BLOCS PROPOSÉS, et c'est la règle du moteur et de la publication :
 * - CE scénario : ses blocs tels qu'on les édite (le brouillon, celui qu'on publiera), qui ont déjà leur code ;
 * - un AUTRE scénario : ses blocs PUBLIÉS (`GET /nodes`), les seuls qu'un contact peut atteindre. Un bloc du seul
 *   brouillon d'à côté n'est pas proposé : la publication le refuserait.
 */

const CODE_BLOC_RE = /^nod_[0-9a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;
const cls = 'w-full rounded-controle border border-ink-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

interface BlocChoisissable { code: string; nom: string; type: string }

export function PanneauAllerA({ tenantId, workflowId, nodeId, data, blocsDuScenario, onPatch }: {
  tenantId: string;
  /** Le scénario qu'on édite. Absent : le constructeur est monté sans scénario connu, seul le code collé reste. */
  workflowId: string | undefined;
  /** Ce bloc « Aller à » : il ne peut pas se viser lui-même. */
  nodeId: string;
  data: Record<string, unknown>;
  blocsDuScenario: RFNode[];
  onPatch: (p: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [scenarios, setScenarios] = useState<WorkflowSummary[] | null>(null);
  const [publies, setPublies] = useState<NodeListItem[] | null>(null);
  useEffect(() => {
    // Lectures défensives : une réponse sans le champ attendu (serveur plus ancien) laisse la liste vide, jamais l'écran
    // par terre. Le code collé reste utilisable dans tous les cas.
    listWorkflows(tenantId).then((r) => setScenarios(Array.isArray(r.workflows) ? r.workflows : [])).catch(() => setScenarios([]));
    listNodes(tenantId).then((r) => setPublies(Array.isArray(r.nodes) ? r.nodes : [])).catch(() => setPublies([]));
  }, [tenantId]);

  const libelleType = (type: string): string => t(...nodeMetaOf(type).label);
  const ici = useMemo<BlocChoisissable[]>(() => blocsDuScenario
    .filter((n) => n.id !== nodeId && typeof n.data.code === 'string' && CODE_BLOC_RE.test(n.data.code))
    .map((n) => ({
      code: String(n.data.code),
      nom: String(n.data.name ?? '').trim() || libelleType(String(n.data.wfType ?? '')),
      type: String(n.data.wfType ?? ''),
    })),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `libelleType` ne dépend que de la langue
  [blocsDuScenario, nodeId, t]);
  const ailleurs = (wfId: string): BlocChoisissable[] => (publies ?? [])
    .filter((b) => b.workflowId === wfId && b.workflowId !== workflowId && b.code !== null)
    .map((b) => ({ code: b.code as string, nom: b.name || b.summary || libelleType(b.type), type: b.type }));

  const cible = String(data.cible ?? '').trim();
  /** Où vit le code visé : dans ce scénario, sinon dans un bloc publié d'un autre. `null` = introuvable d'ici. */
  const trouve = useMemo(() => {
    if (cible === '') return null;
    const i = ici.find((b) => b.code === cible);
    if (i) return { scenario: workflowId ?? '', nomScenario: null as string | null, bloc: i };
    const a = (publies ?? []).find((b) => b.code === cible && b.workflowId !== workflowId);
    return a ? { scenario: a.workflowId, nomScenario: a.workflowName, bloc: { code: cible, nom: a.name || a.summary || libelleType(a.type), type: a.type } } : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `libelleType` ne dépend que de la langue
  }, [cible, ici, publies, workflowId]);

  const [scenarioChoisi, setScenarioChoisi] = useState<string>(workflowId ?? '');
  // Le sélecteur se cale sur le scénario de la cible quand on la découvre (listes chargées, code collé), pas à chaque
  // rendu : sinon déplacer un bloc ramènerait le sélecteur sous les yeux de celui qui parcourt un autre scénario.
  const scenarioDeLaCible = trouve?.scenario ?? null;
  useEffect(() => { if (scenarioDeLaCible !== null) setScenarioChoisi(scenarioDeLaCible); }, [scenarioDeLaCible]);

  const libelleDe = (bloc: BlocChoisissable, nomScenario: string | null): string => (nomScenario ? `${nomScenario}, ${bloc.nom}` : bloc.nom);
  const autres = (scenarios ?? []).filter((s) => s.id !== workflowId).sort((a, b) => a.name.localeCompare(b.name));
  const nomDuChoisi = autres.find((s) => s.id === scenarioChoisi)?.name ?? null;
  const proposes = scenarioChoisi === workflowId ? ici : ailleurs(scenarioChoisi);
  const charge = scenarios !== null && publies !== null;

  /** Le code collé : sa cible est nommée si on la connaît, sinon la carte montrera le code lui-même. */
  const coller = (brut: string): void => {
    const code = brut.trim();
    const i = ici.find((b) => b.code === code);
    const a = i ? null : (publies ?? []).find((b) => b.code === code && b.workflowId !== workflowId);
    const libelle = i ? i.nom : a ? `${a.workflowName}, ${a.name || a.summary || libelleType(a.type)}` : '';
    onPatch({ cible: code, cibleLibelle: libelle });
  };

  return (
    <div className="space-y-3" data-testid="panneau-aller-a">
      <p className="text-xs leading-snug text-ink-500">
        {t('Le contact continue sur le bloc choisi, dans ce scénario ou dans un autre. Ses réponses déjà données restent sur sa fiche. Dans un autre scénario, c’est sa version publiée qui joue.',
          'The contact continues on the chosen block, in this scenario or another one. Answers already given stay on their record. In another scenario, its published version plays.')}
      </p>
      {workflowId !== undefined && (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">{t('Scénario', 'Scenario')}</label>
            <select data-testid="aller-a-scenario" value={scenarioChoisi} onChange={(e) => setScenarioChoisi(e.target.value)} className={cls}>
              <option value={workflowId}>{t('Ce scénario', 'This scenario')}</option>
              {autres.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">{t('Bloc', 'Block')}</label>
            <select
              data-testid="aller-a-bloc"
              value={proposes.some((b) => b.code === cible) ? cible : ''}
              onChange={(e) => {
                const b = proposes.find((x) => x.code === e.target.value);
                if (b) onPatch({ cible: b.code, cibleLibelle: libelleDe(b, scenarioChoisi === workflowId ? null : nomDuChoisi) });
              }}
              className={cls}
            >
              <option value="">{t('Choisir…', 'Choose…')}</option>
              {proposes.map((b) => <option key={b.code} value={b.code}>{`${b.nom} (${libelleType(b.type)})`}</option>)}
            </select>
            {charge && proposes.length === 0 && (
              <p className="mt-1 text-xs text-ink-500">
                {scenarioChoisi === workflowId
                  ? t('Aucun autre bloc enregistré ici. Un bloc tout juste ajouté reçoit son code à l’enregistrement, dans un instant.',
                    'No other saved block here. A block you just added gets its code when saved, in a moment.')
                  : t('Ce scénario n’a aucun bloc publié : publiez-le d’abord.', 'This scenario has no published block: publish it first.')}
              </p>
            )}
          </div>
        </>
      )}
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-500">{t('Ou le code du bloc', 'Or the block code')}</label>
        <input
          data-testid="aller-a-code"
          value={cible}
          onChange={(e) => coller(e.target.value)}
          className={`${cls} font-mono text-xs`}
          placeholder="nod_…"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-ink-500">{t('Le code se copie depuis le bouton en haut à gauche de chaque bloc.', 'Copy a code from the button at the top left of each block.')}</p>
      </div>
      {cible === '' ? (
        <p className="rounded-controle border border-alerte-300 bg-alerte-50 px-2.5 py-2 text-xs text-alerte-800" data-testid="aller-a-sans-cible">
          {t('Choisissez le bloc où aller : sans lui, la publication est refusée.', 'Choose the block to go to: without it, publishing is refused.')}
        </p>
      ) : charge && !trouve ? (
        <p className="rounded-controle border border-alerte-300 bg-alerte-50 px-2.5 py-2 text-xs text-alerte-800" data-testid="aller-a-inconnu">
          {t('Ce code ne désigne aucun bloc de ce scénario, ni un bloc publié d’un autre scénario de l’espace : la publication sera refusée.',
            'This code matches no block of this scenario, nor a published block of another scenario in the workspace: publishing will be refused.')}
        </p>
      ) : trouve ? (
        <p className="text-xs text-ink-900" data-testid="aller-a-cible">
          → {libelleDe(trouve.bloc, trouve.nomScenario)}
        </p>
      ) : null}
    </div>
  );
}
