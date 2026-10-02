'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import {
  filtreAnalyseParDefaut, libelleOperateurAnalyse, libelleValeurAnalyse, type ChampFiltrable, type OperateurAnalyse,
} from '@/lib/champs-fiche';

/** Un filtre sur la dernière analyse, dans la forme du fil : celle d'un `fieldFilters` comme d'une clause Condition. */
export interface FiltreAnalyseSaisi { key: string; op: string; value: string }
/** Ce que l'éditeur rend : toujours un opérateur que le champ connaît. */
export interface FiltreAnalyseValide { key: string; op: OperateurAnalyse; value: string }

/**
 * L'éditeur d'UN filtre sur la dernière analyse d'une fiche : le champ, l'opérateur, la valeur. Partagé par le
 * panneau de filtres des contacts (liste et ciblage de campagne) et le bloc Condition d'un scénario, qui
 * appliquent la même sémantique côté serveur (`src/crm/filtre-fiche.ts`).
 *
 * 🔴 Il ne produit que des filtres que le serveur accepte : changer de champ ou d'opérateur repart d'une valeur
 * valide, un choix multiple garde toujours au moins une case, une note reste entre 0 et 10. Le serveur refuse le
 * reste en 400 plutôt que de l'ignorer, et c'est ce refus qu'on évite de montrer pendant la saisie.
 *
 * 🔴 La valeur cochée d'office (la première de la liste) est REMPLACÉE au premier clic, pas complétée. Sans ça,
 * cliquer « Négatif » donnait « Positif ou Négatif » : un « le sentiment devient négatif » ainsi créé ne partait
 * jamais (Julien, 2026-10-02). Les clics suivants ajoutent ou retirent, comme avant.
 *
 * Rend des contrôles FRÈRES : c'est le parent qui décide de la disposition (en ligne ou empilée).
 */
export function EditeurFiltreAnalyse({ champs, filtre, onChange, sel, inp }: {
  champs: readonly ChampFiltrable[];
  filtre: FiltreAnalyseSaisi;
  onChange: (f: FiltreAnalyseValide) => void;
  sel: string;
  inp: string;
}) {
  const t = useT();
  // Un clic a-t-il déjà eu lieu sur les choix de ce champ et de cet opérateur ? Remis à zéro quand l'un des deux change.
  const [touche, setTouche] = useState(false);
  useEffect(() => { setTouche(false); }, [filtre.key, filtre.op]);
  const champ = champs.find((c) => c.cle === filtre.key);
  const langue = (l: readonly [string, string]) => t(l[0], l[1]);

  if (!champ) {
    // Un filtre posé que la liste ne décrit pas (API plus ancienne, accès refusé) : on le montre tel quel, pour qu'on
    // le voie et qu'on puisse le retirer, sans prétendre savoir l'éditer.
    return <span className="text-xs text-ink-500" data-testid="filtre-analyse-inconnu">{filtre.key} {filtre.op} {filtre.value}</span>;
  }
  const op = (champ.operateurs as readonly string[]).includes(filtre.op) ? (filtre.op as OperateurAnalyse) : champ.operateurs[0]!;
  const choisis = filtre.value.split(',').filter((v) => v !== '');
  const basculer = (code: string) => {
    const parDefaut = filtreAnalyseParDefaut(champ, op).value;
    const suivants = !touche && filtre.value === parDefaut && code !== parDefaut
      ? [code]
      : choisis.includes(code) ? choisis.filter((c) => c !== code) : [...choisis, code];
    setTouche(true);
    if (suivants.length === 0) return; // au moins une case : un choix vide serait refusé par le serveur
    onChange({ key: filtre.key, op, value: champ.valeurs.filter((v) => suivants.includes(v)).join(',') });
  };
  const nombre = (brut: string, min: number, max: number) => {
    const n = Math.round(Number(brut));
    if (!Number.isFinite(n)) return;
    onChange({ key: filtre.key, op, value: String(Math.min(max, Math.max(min, n))) });
  };

  return (
    <>
      <select
        value={champ.cle}
        onChange={(e) => { const c = champs.find((x) => x.cle === e.target.value); if (c) onChange(filtreAnalyseParDefaut(c)); }}
        className={sel}
        data-testid="filtre-analyse-champ"
      >
        {champs.map((c) => <option key={c.cle} value={c.cle}>{langue(c.libelle)}</option>)}
      </select>
      <select
        value={op}
        onChange={(e) => onChange(filtreAnalyseParDefaut(champ, e.target.value as OperateurAnalyse))}
        className={sel}
        data-testid="filtre-analyse-operateur"
      >
        {champ.operateurs.map((o) => <option key={o} value={o}>{libelleOperateurAnalyse(o, champ.nature, t)}</option>)}
      </select>
      {op === 'in' && (
        <div className="flex flex-wrap gap-1" data-testid="filtre-analyse-choix">
          {champ.valeurs.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => basculer(code)}
              aria-pressed={choisis.includes(code)}
              className={`rounded-controle px-2 py-0.5 text-xs font-medium transition-colors duration-150 ${choisis.includes(code) ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-500 hover:bg-ink-200'}`}
            >
              {libelleValeurAnalyse(champ.cle, code, t)}
            </button>
          ))}
        </div>
      )}
      {(op === 'gte' || op === 'lte') && (
        <input
          type="number" min={0} max={10} step={1} value={filtre.value}
          onChange={(e) => nombre(e.target.value, 0, 10)}
          className={inp} aria-label={t('Note de 0 à 10', 'Score from 0 to 10')} data-testid="filtre-analyse-note"
        />
      )}
      {op === 'newer_than_days' && (
        <label className="flex items-center gap-1.5 text-xs text-ink-500">
          <input
            type="number" min={1} max={3650} step={1} value={filtre.value}
            onChange={(e) => nombre(e.target.value, 1, 3650)}
            className={inp} data-testid="filtre-analyse-jours"
          />
          {t('jours', 'days')}
        </label>
      )}
    </>
  );
}
