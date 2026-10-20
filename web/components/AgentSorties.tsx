'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { inputClsAuto } from '@/lib/ui';
import type { SortieAgent } from '@/lib/api-agent';
import { MAX_SORTIES, normaliserCodeSortie } from '@/lib/partage/sorties-agent';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';

/**
 * L'éditeur des RÈGLES D'ARRÊT d'un agent : la liste de ses sorties.
 *
 * 🔴 LE CODE DEVIENT UN HANDLE D'ARÊTE `sortie:<code>` dans le builder. Il est donc contraint au même
 * alphabet que les noms d'outils, et le serveur refuse tout le reste en 400. Plutôt que de laisser le client
 * découvrir la règle par un message d'erreur, on la lui applique en direct : ce qu'il tape est normalisé sous
 * ses yeux, et le libellé, lui, reste libre. C'est le libellé que le builder affiche.
 *
 * La règle du code elle-même est partagée avec le serveur (`web/lib/partage/sorties-agent.ts`).
 *
 * La case « passe à un humain » (demande de Julien du 2026-10-20) ne change rien à ce que fait la règle : elle dit au
 * serveur que c'est un transfert, pour que l'outil « Qualifier et transférer » ne cohabite pas avec elle. Elle part
 * toujours explicite (cochée ou décochée) : une règle envoyée sans elle garderait son ancienne valeur.
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
        <div key={s.code} data-testid={`agent-sortie-${s.code}`} className="flex items-center gap-2 rounded-controle border border-ink-200 px-3 py-2">
          <span className="shrink-0 rounded-controle bg-ink-100 px-1.5 py-0.5 font-mono text-xs text-ink-500">{s.code}</span>
          <span className="truncate text-sm text-ink-900">{s.label}</span>
          <label className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-ink-500"
            title={t('Cochez si cette règle passe la conversation à un humain : elle ne cohabite pas avec l’outil « Qualifier et transférer ».',
              'Check if this rule hands the conversation over to a human: it cannot coexist with the “Qualify and hand over” tool.')}>
            <input type="checkbox" data-testid={`agent-sortie-humain-${s.code}`} disabled={busy} checked={s.humain === true}
              onChange={(e) => onChange(sorties.map((x) => (x.code === s.code ? { ...x, humain: e.target.checked } : x)))} />
            {t('passe à un humain', 'hands over to a human')}
          </label>
          <button
            data-testid={`agent-sortie-retirer-${s.code}`}
            disabled={busy}
            onClick={() => onChange(sorties.filter((x) => x.code !== s.code))}
            title={t('Retirer cette règle d’arrêt', 'Remove this stop rule')}
            className="shrink-0 rounded-controle px-1.5 text-sm text-danger hover:bg-danger-50 disabled:opacity-40"
          ><Icone nom="fermer" taille="petite" /></button>
        </div>
      ))}
      {plein ? (
        <p className="text-xs text-alerte-800">
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
              <span data-testid="agent-sortie-code-normalise" className="font-mono text-xs text-ink-500">{codeNormalise}</span>
            )}
            {deja && <span className="text-xs text-danger">{t('déjà utilisé', 'already used')}</span>}
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
          <Bouton variante="secondaire"
            data-testid="agent-sortie-ajouter"
            onClick={ajouter}
            disabled={!peutAjouter}
          >
            {t('Ajouter', 'Add')}
          </Bouton>
        </div>
      )}
    </div>
  );
}
