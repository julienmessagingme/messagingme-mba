'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { CibleBloc, CibleChamp, CibleScenario, CibleTag } from '@/components/mba-outils/CiblesOutil';
import {
  BORNES_ENCHAINEMENT, LIBELLES_ETAPE, TYPES_ETAPE, etapeVide,
  type CibleEnchainementSaisie, type EtapeSaisie, type TypeEtape,
} from '@/lib/agent-outils';

/**
 * LES ÉTAPES D'UN OUTIL ENCHAÎNÉ (demande de Julien du 2026-10-20 : « me laisser l'ordre »). Une première étape, puis
 * « + Ajouter une étape » pour la suivante ; les flèches changent l'ordre, et l'agent les exécute dans cet ordre.
 *
 * Chaque étape reprend le sélecteur de l'outil simple du même geste (champ, tag, bloc, scénario) : même lecture du
 * mini-CRM et des scénarios publiés, mêmes signalements d'un champ ou d'un scénario disparu.
 *
 * ⚠️ L'ORDRE est jugé par le parent (`manqueDeLEnchainement`), qui le dit sous le formulaire : un scénario en dernier,
 * aucun bloc ni scénario avant une question. L'écran ne déplace rien tout seul : c'est l'administrateur qui range.
 */
export function CibleEnchainement({ tenantId, valeur, onChange }: {
  tenantId: string;
  valeur: CibleEnchainementSaisie;
  onChange: (c: CibleEnchainementSaisie) => void;
}) {
  const t = useT();
  const [choix, setChoix] = useState<TypeEtape | ''>('');
  // Une clé stable par étape : la position change quand on déplace, et un sélecteur garde un état local (ses listes lues).
  const [cles, setCles] = useState<number[]>(() => valeur.etapes.map((_, i) => i));
  const [prochaine, setProchaine] = useState(valeur.etapes.length);
  const etapes = valeur.etapes;

  const changer = (i: number, e: EtapeSaisie): void => onChange({ ...valeur, etapes: etapes.map((x, j) => (j === i ? e : x)) });

  const ajouter = (type: TypeEtape): void => {
    if (etapes.length >= BORNES_ENCHAINEMENT.etapes) return;
    onChange({ ...valeur, etapes: [...etapes, etapeVide(type)] });
    setCles((c) => [...c, prochaine]);
    setProchaine((n) => n + 1);
    setChoix('');
  };

  const retirer = (i: number): void => {
    onChange({ ...valeur, etapes: etapes.filter((_, j) => j !== i) });
    setCles((c) => c.filter((_, j) => j !== i));
  };

  const deplacer = (i: number, sens: -1 | 1): void => {
    const j = i + sens;
    if (j < 0 || j >= etapes.length) return;
    const echange = <T,>(l: T[]): T[] => { const r = [...l]; [r[i], r[j]] = [r[j]!, r[i]!]; return r; };
    onChange({ ...valeur, etapes: echange(etapes) });
    setCles(echange);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="agent-enchainement">
      <p className="text-xs text-ink-500">
        {t(
          'L’agent exécute les étapes dans cet ordre. S’il manque une réponse à une question, il la demande au contact une seule fois, puis exécute tout avec ce qu’il a.',
          'The agent runs the steps in this order. If an answer to a question is missing, it asks the contact once, then runs everything with what it has.',
        )}
      </p>
      {etapes.map((e, i) => (
        <div key={cles[i] ?? i} className="flex flex-col gap-2 rounded-controle border border-ink-200 p-3" data-testid={`agent-etape-${i}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-ink-900">
              {t(`Étape ${i + 1} : `, `Step ${i + 1}: `)}{t(LIBELLES_ETAPE[e.type][0], LIBELLES_ETAPE[e.type][1])}
            </p>
            <div className="flex items-center gap-3 text-xs text-ink-500">
              <button type="button" data-testid={`agent-etape-monter-${i}`} disabled={i === 0} onClick={() => deplacer(i, -1)}
                className="hover:underline disabled:opacity-40" aria-label={t('Monter', 'Move up')}>↑</button>
              <button type="button" data-testid={`agent-etape-descendre-${i}`} disabled={i === etapes.length - 1} onClick={() => deplacer(i, 1)}
                className="hover:underline disabled:opacity-40" aria-label={t('Descendre', 'Move down')}>↓</button>
              <button type="button" data-testid={`agent-etape-retirer-${i}`} onClick={() => retirer(i)} className="hover:underline">
                {t('Retirer', 'Remove')}
              </button>
            </div>
          </div>
          <Etape tenantId={tenantId} etape={e} onChange={(x) => changer(i, x)} />
        </div>
      ))}
      {etapes.length < BORNES_ENCHAINEMENT.etapes && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-500">
            {etapes.length === 0 ? t('Première étape', 'First step') : t('+ Ajouter une étape', '+ Add a step')}
            <select className={`${inputCls} mt-1`} data-testid="agent-etape-ajouter" value={choix}
              onChange={(ev) => {
                const type = TYPES_ETAPE.find((x) => x === ev.target.value);
                if (type) ajouter(type);
                else setChoix('');
              }}>
              <option value="">{t('Choisir…', 'Pick…')}</option>
              {TYPES_ETAPE.map((type) => (
                <option key={type} value={type}>{t(LIBELLES_ETAPE[type][0], LIBELLES_ETAPE[type][1])}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

/** Les réglages d'une étape, selon son type. */
function Etape({ tenantId, etape, onChange }: { tenantId: string; etape: EtapeSaisie; onChange: (e: EtapeSaisie) => void }) {
  const t = useT();
  switch (etape.type) {
    case 'demander':
      return (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-ink-500">
            {t('Ce que l’agent demande', 'What the agent asks')}
            <input className={`${inputCls} mt-1`} data-testid="agent-etape-question" value={etape.question}
              maxLength={BORNES_ENCHAINEMENT.question} placeholder={t('Ex : le prénom du contact', 'E.g. the contact’s first name')}
              onChange={(ev) => onChange({ ...etape, question: ev.target.value })} />
          </label>
          <CibleChamp pour="agent" tenantId={tenantId} champ={etape.champ} valeurs={etape.valeurs}
            onChange={(champ, valeurs) => onChange({ ...etape, champ, valeurs })} />
        </div>
      );
    case 'valeur':
      return (
        <div className="flex flex-col gap-2">
          <CibleChamp pour="agent" sansValeurs tenantId={tenantId} champ={etape.champ} valeurs={[]}
            onChange={(champ) => onChange({ ...etape, champ })} />
          <label className="text-xs text-ink-500">
            {t('Valeur enregistrée', 'Saved value')}
            <input className={`${inputCls} mt-1`} data-testid="agent-etape-valeur" value={etape.valeur}
              maxLength={BORNES_ENCHAINEMENT.valeurFixe} placeholder={t('Ex : lead chaud', 'E.g. hot lead')}
              onChange={(ev) => onChange({ ...etape, valeur: ev.target.value })} />
          </label>
        </div>
      );
    case 'tag':
      return <CibleTag pour="agent" tenantId={tenantId} valeur={etape.tag} onChange={(tag) => onChange({ ...etape, tag })} />;
    case 'urgent':
      return (
        <p className="text-xs text-ink-500">
          {t('La conversation passe dans le dossier « Urgent » de l’équipe.', 'The conversation goes to the team’s “Urgent” folder.')}
        </p>
      );
    case 'bloc':
      return (
        <CibleBloc tenantId={tenantId} workflowId={etape.workflowId} code={etape.code}
          onChange={(workflowId, code) => onChange({ ...etape, workflowId, code })} />
      );
    case 'scenario':
      return (
        <CibleScenario pour="agent" tenantId={tenantId} workflowId={etape.workflowId}
          onChange={(workflowId) => onChange({ ...etape, workflowId })} />
      );
  }
}
