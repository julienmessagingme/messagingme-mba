'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputClsAuto } from '@/lib/ui';
import type { SortieAgent } from '@/lib/api-agent';
import { MAX_SORTIES, normaliserCodeSortie } from '@/lib/agent-sorties';

/**
 * L'éditeur des RÈGLES D'ARRÊT d'un agent : la liste de ses sorties.
 *
 * 🔴 LE CODE DEVIENT UN HANDLE D'ARÊTE `sortie:<code>` dans le builder. Il est donc contraint au même
 * alphabet que les noms d'outils, et le serveur refuse tout le reste en 400. Plutôt que de laisser le client
 * découvrir la règle par un message d'erreur, on la lui applique en direct : ce qu'il tape est normalisé sous
 * ses yeux, et le libellé, lui, reste libre. C'est le libellé que le builder affiche.
 *
 * La règle du code elle-même vit dans `web/lib/agent-sorties.ts`, avec son test de parité serveur.
 */
export function CodeSortieInput({ sorties, busy, onChange }: {
  sorties: SortieAgent[];
  busy: boolean;
  onChange: (s: SortieAgent[]) => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');

  const codeNormalise = normaliserCodeSortie(code);
  const deja = sorties.some((s) => s.code === codeNormalise);
  const plein = sorties.length >= MAX_SORTIES;
  const peutAjouter = !busy && !plein && !deja && codeNormalise !== '' && label.trim() !== '';

  function ajouter() {
    if (!peutAjouter) return;
    onChange([...sorties, { code: codeNormalise, label: label.trim().slice(0, 60) }]);
    setCode('');
    setLabel('');
  }

  return (
    <div className="flex flex-col gap-3">
      {sorties.length === 0 && (
        <p className="text-xs text-ink-500">
          {t(
            'Aucune règle d’arrêt : l’agent ne sortira que par les sorties automatiques du bloc (pas de réponse, aucune source, plafond, échec, transfert).',
            'No stop rule: the agent will only leave through the block’s automatic outputs (no reply, no source, cap, failure, handover).',
          )}
        </p>
      )}
      {sorties.map((s) => (
        <div key={s.code} data-testid={`agent-sortie-${s.code}`} className="flex items-center gap-2 rounded-lg border border-ink-200 px-3 py-2">
          <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600">{s.code}</span>
          <span className="truncate text-sm text-ink-800">{s.label}</span>
          <button
            data-testid={`agent-sortie-retirer-${s.code}`}
            disabled={busy}
            onClick={() => onChange(sorties.filter((x) => x.code !== s.code))}
            title={t('Retirer cette règle d’arrêt', 'Remove this stop rule')}
            className="ml-auto shrink-0 rounded px-1.5 text-sm text-coral hover:bg-red-50 disabled:opacity-40"
          >
            ✕
          </button>
        </div>
      ))}
      {plein ? (
        <p className="text-xs text-amber-800">
          {t(
            `Douze règles d’arrêt, c’est le maximum : au-delà, le bloc devient illisible et l’agent choisit mal.`,
            `Twelve stop rules is the maximum: beyond that the block becomes unreadable and the agent picks badly.`,
          )}
        </p>
      ) : (
        <div className="flex flex-wrap items-start gap-2">
          <div className="flex flex-col gap-1">
            <input
              data-testid="agent-sortie-code"
              className={`${inputClsAuto} w-44 font-mono`}
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') ajouter(); }}
              placeholder={t('code', 'code')}
            />
            {/* Le code normalisé est montré DÈS qu'il diffère de la saisie : le client comprend la règle en
                la voyant s'appliquer, plutôt qu'en lisant un refus après coup. */}
            {codeNormalise !== code.trim() && codeNormalise !== '' && (
              <span data-testid="agent-sortie-code-normalise" className="font-mono text-[11px] text-ink-500">{codeNormalise}</span>
            )}
            {deja && <span className="text-[11px] text-coral">{t('déjà utilisé', 'already used')}</span>}
          </div>
          <input
            data-testid="agent-sortie-label"
            className={`${inputClsAuto} w-56`}
            value={label}
            disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ajouter(); }}
            placeholder={t('ce que ça veut dire', 'what it means')}
          />
          <button
            data-testid="agent-sortie-ajouter"
            onClick={ajouter}
            disabled={!peutAjouter}
            className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
          >
            {t('Ajouter', 'Add')}
          </button>
        </div>
      )}
    </div>
  );
}
