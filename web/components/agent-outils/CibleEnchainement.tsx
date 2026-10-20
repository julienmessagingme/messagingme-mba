'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { CibleBloc, CibleChamp, CibleScenario, CibleTag } from '@/components/mba-outils/CiblesOutil';
import {
  BORNES_ENCHAINEMENT, LIBELLES_ETAPE, TYPES_ETAPE, etapeVide, type EtapeSaisie, type TypeEtape,
} from '@/lib/agent-outils';

/**
 * LES ÉTAPES D'UN OUTIL ENCHAÎNÉ (demande de Julien du 2026-10-20 : « me laisser l'ordre »). Une première étape, puis
 * « + Ajouter une étape » pour la suivante ; les flèches changent l'ordre, et l'agent les exécute dans cet ordre.
 *
 * Chaque étape reprend le sélecteur de l'outil simple du même geste (champ, tag, bloc, scénario) : même lecture du
 * mini-CRM et des scénarios publiés, mêmes signalements d'un champ ou d'un scénario disparu.
 *
 * ⚠️ L'ORDRE est jugé par le parent (`manqueDeLEnchainement`), qui le dit sous le formulaire : un scénario ou un transfert
 * en dernier, aucun bloc ni scénario avant une question. L'écran ne déplace rien tout seul : c'est l'administrateur qui range.
 *
 * `questionsSeules` : l'éditeur de « Qualifier et transférer » (demande de Julien du 2026-10-20). Des questions seulement,
 * « + Ajouter une question », et le transfert affiché en dernier sans qu'on puisse le retirer : le serveur l'ajoute.
 */
export function CibleEnchainement({ tenantId, etapes, onEtapes, questionsSeules = false }: {
  tenantId: string;
  etapes: EtapeSaisie[];
  onEtapes: (etapes: EtapeSaisie[]) => void;
  questionsSeules?: boolean;
}) {
  const t = useT();
  const [choix, setChoix] = useState<TypeEtape | ''>('');
  // Une clé stable par étape : la position change quand on déplace, et un sélecteur garde un état local (ses listes lues).
  const [cles, setCles] = useState<number[]>(() => etapes.map((_, i) => i));
  const [prochaine, setProchaine] = useState(etapes.length);

  const changer = (i: number, e: EtapeSaisie): void => onEtapes(etapes.map((x, j) => (j === i ? e : x)));

  const ajouter = (type: TypeEtape): void => {
    if (etapes.length >= BORNES_ENCHAINEMENT.etapes) return;
    onEtapes([...etapes, etapeVide(type)]);
    setCles((c) => [...c, prochaine]);
    setProchaine((n) => n + 1);
    setChoix('');
  };

  const retirer = (i: number): void => {
    onEtapes(etapes.filter((_, j) => j !== i));
    setCles((c) => c.filter((_, j) => j !== i));
  };

  const deplacer = (i: number, sens: -1 | 1): void => {
    const j = i + sens;
    if (j < 0 || j >= etapes.length) return;
    const echange = <T,>(l: T[]): T[] => { const r = [...l]; [r[i], r[j]] = [r[j]!, r[i]!]; return r; };
    onEtapes(echange(etapes));
    setCles(echange);
  };

  return (
    <div className="flex flex-col gap-3" data-testid={questionsSeules ? 'agent-qualification' : 'agent-enchainement'}>
      <p className="text-xs text-ink-500">
        {questionsSeules
          ? t(
            'L’agent demande au contact ce qui lui manque, une seule fois et en un message, range chaque réponse dans son champ, puis passe la conversation dans « À traiter » avec sa dernière phrase. Il transfère même si le contact ne répond pas.',
            'The agent asks the contact for what is missing, once and in one message, stores each answer in its field, then moves the conversation to “To handle” with its last sentence. It hands over even if the contact does not answer.',
          )
          : t(
            'L’agent exécute les étapes dans cet ordre. S’il manque une réponse à une question, il la demande au contact une seule fois, puis exécute tout avec ce qu’il a.',
            'The agent runs the steps in this order. If an answer to a question is missing, it asks the contact once, then runs everything with what it has.',
          )}
      </p>
      {etapes.map((e, i) => (
        <div key={cles[i] ?? i} className="flex flex-col gap-2 rounded-controle border border-ink-200 p-3" data-testid={`agent-etape-${i}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-ink-900">
              {questionsSeules
                ? t(`Question ${i + 1}`, `Question ${i + 1}`)
                : <>{t(`Étape ${i + 1} : `, `Step ${i + 1}: `)}{t(LIBELLES_ETAPE[e.type][0], LIBELLES_ETAPE[e.type][1])}</>}
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
      {questionsSeules && etapes.length < BORNES_ENCHAINEMENT.etapes && (
        <Bouton variante="secondaire" taille="petite" type="button" data-testid="agent-question-ajouter"
          className="self-start" onClick={() => ajouter('demander')}>
          {t('+ Ajouter une question', '+ Add a question')}
        </Bouton>
      )}
      {questionsSeules && (
        <p className="rounded-controle border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-500" data-testid="agent-qualification-fin">
          {t('Puis : la conversation passe dans « À traiter », toujours en dernier.', 'Then: the conversation moves to “To handle”, always last.')}
        </p>
      )}
      {!questionsSeules && etapes.length < BORNES_ENCHAINEMENT.etapes && (
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
    case 'transferer':
      return (
        <p className="text-xs text-ink-500">
          {t(
            'La conversation passe dans « À traiter » : l’agent écrit sa dernière phrase, puis se retire. Un agent qui transfère ainsi ne garde pas « Passer la main à un humain ».',
            'The conversation moves to “To handle”: the agent writes its last sentence, then steps back. An agent that hands over this way does not keep “Hand over to a human”.',
          )}
        </p>
      );
  }
}
