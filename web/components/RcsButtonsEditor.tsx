'use client';

import type { RcsSuggestion, UserFieldDef } from '@/lib/api';
import {
  KINDS_BOUTON, LIBELLE_KIND, AIDE_KIND, nouveauBouton, type KindBouton,
} from '@/lib/rcs-boutons';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * Éditeur des boutons d'un message RCS, partagé par les TROIS écrans qui en composent : la bibliothèque
 * (Contenu > Messages RCS), l'assistant de campagne et le bloc de scénario.
 *
 * Il existe parce que les trois avaient chacun leur copie, déjà divergentes sur les valeurs par défaut, et
 * qu'ajouter trois formes de bouton dans trois copies aurait garanti trois comportements différents pour la
 * même saisie.
 */
export function RcsButtonsEditor({
  boutons, onChange, max = 11, dateFields = [], compact = false, testIdPrefix = 'rcs',
}: {
  boutons: RcsSuggestion[];
  onChange: (boutons: RcsSuggestion[]) => void;
  max?: number;
  /** Champs « date et heure » du contact, proposés comme source d'un rendez-vous. Vide -> saisie fixe seule. */
  dateFields?: UserFieldDef[];
  /** Rendu resserré, pour le panneau étroit du builder. */
  compact?: boolean;
  testIdPrefix?: string;
}) {
  const t = useT();
  const cls = compact ? `${inputCls} bg-white` : inputCls;

  const maj = (i: number, patch: Partial<RcsSuggestion>) =>
    onChange(boutons.map((b, j) => (j === i ? ({ ...b, ...patch } as RcsSuggestion) : b)));

  const changerKind = (i: number, kind: KindBouton) => {
    const b = boutons[i]!;
    onChange(boutons.map((x, j) => (j === i ? nouveauBouton(kind, { text: b.text, postbackData: b.postbackData }) : x)));
  };

  return (
    <div>
      <div className="space-y-2">
        {boutons.map((b, i) => (
          <div key={i} className="rounded-lg border border-ink-200 p-2">
            <div className="flex items-center gap-1.5">
              <select
                value={b.kind}
                onChange={(e) => changerKind(i, e.target.value as KindBouton)}
                data-testid={`${testIdPrefix}-bouton-kind-${i}`}
                className={`${inputCls} ${compact ? 'max-w-[9rem]' : 'max-w-[11rem]'} bg-white`}
              >
                {KINDS_BOUTON.map((k) => <option key={k} value={k}>{t(...LIBELLE_KIND[k])}</option>)}
              </select>
              <input
                value={b.text}
                maxLength={25}
                onChange={(e) => maj(i, { text: e.target.value })}
                className={cls}
                placeholder={t('Libellé du bouton', 'Button label')}
              />
              <button
                type="button"
                onClick={() => onChange(boutons.filter((_, j) => j !== i))}
                className="shrink-0 text-ink-400 hover:text-coral"
                aria-label={t('Retirer', 'Remove')}
              >
                ×
              </button>
            </div>

            {b.kind === 'openUrl' && (
              <input value={b.url} onChange={(e) => maj(i, { url: e.target.value })} className={`${cls} mt-1.5`} placeholder="https://" />
            )}

            {b.kind === 'dial' && (
              <input value={b.phoneNumber} onChange={(e) => maj(i, { phoneNumber: e.target.value })} className={`${cls} mt-1.5`} placeholder="+33…" />
            )}

            {b.kind === 'calendar' && (
              <div className="mt-1.5 space-y-1.5">
                <input
                  value={b.title}
                  maxLength={100}
                  onChange={(e) => maj(i, { title: e.target.value })}
                  data-testid={`${testIdPrefix}-bouton-titre-${i}`}
                  className={cls}
                  placeholder={t('Titre du rendez-vous', 'Appointment title')}
                />
                <ChampDate
                  valeur={b.startAt}
                  onChange={(v) => maj(i, { startAt: v })}
                  dateFields={dateFields}
                  libelle={t('Début', 'Start')}
                  testId={`${testIdPrefix}-bouton-debut-${i}`}
                  cls={cls}
                />
                <ChampDate
                  valeur={b.endAt}
                  onChange={(v) => maj(i, { endAt: v })}
                  dateFields={dateFields}
                  libelle={t('Fin', 'End')}
                  testId={`${testIdPrefix}-bouton-fin-${i}`}
                  cls={cls}
                />
              </div>
            )}

            {b.kind === 'showLocation' && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="number"
                  step="any"
                  value={Number.isFinite(b.latitude) ? b.latitude : ''}
                  onChange={(e) => maj(i, { latitude: Number(e.target.value) })}
                  className={cls}
                  placeholder={t('Latitude (48.8566)', 'Latitude (48.8566)')}
                />
                <input
                  type="number"
                  step="any"
                  value={Number.isFinite(b.longitude) ? b.longitude : ''}
                  onChange={(e) => maj(i, { longitude: Number(e.target.value) })}
                  className={cls}
                  placeholder={t('Longitude (2.3522)', 'Longitude (2.3522)')}
                />
                <input
                  value={b.label ?? ''}
                  maxLength={100}
                  onChange={(e) => maj(i, { label: e.target.value })}
                  className={cls}
                  placeholder={t('Nom du lieu', 'Place name')}
                />
              </div>
            )}

            {t(...AIDE_KIND[b.kind]) !== '' && (
              <p className="mt-1 text-[11px] text-ink-400">{t(...AIDE_KIND[b.kind])}</p>
            )}
          </div>
        ))}
      </div>

      {boutons.length < max && (
        <button
          type="button"
          data-testid={`${testIdPrefix}-message-add-button`}
          onClick={() => onChange([...boutons, nouveauBouton('reply', { text: '', postbackData: '' })])}
          className="mt-1.5 text-xs text-brand-600 hover:underline"
        >
          + {t('bouton', 'button')}
        </button>
      )}
    </div>
  );
}

/**
 * Une date-heure de rendez-vous : fixe, ou prise dans la fiche du contact.
 *
 * Le mode « champ du contact » ne propose QUE les champs de type « date et heure ». Un champ « date » seule
 * ne porte pas d'heure : il produirait une valeur que le provider refuse, donc un bouton qui tombe, pour une
 * raison que personne ne pourrait deviner depuis cet écran.
 */
function ChampDate({
  valeur, onChange, dateFields, libelle, testId, cls,
}: {
  valeur: string;
  onChange: (v: string) => void;
  dateFields: UserFieldDef[];
  libelle: string;
  testId: string;
  cls: string;
}) {
  const t = useT();
  const estVariable = /^\{\{\s*[\w.-]+\s*\}\}$/.test(valeur);
  const champs = dateFields.filter((f) => f.type === 'datetime');

  return (
    <div className="flex items-center gap-1.5">
      <span className="w-12 shrink-0 text-[11px] text-ink-500">{libelle}</span>
      {champs.length > 0 && (
        <select
          value={estVariable ? 'champ' : 'fixe'}
          onChange={(e) => onChange(e.target.value === 'champ' ? `{{${champs[0]!.key}}}` : '')}
          className={`${inputCls} max-w-[8.5rem] bg-white`}
          data-testid={`${testId}-mode`}
        >
          <option value="fixe">{t('Date fixe', 'Fixed date')}</option>
          <option value="champ">{t('Champ contact', 'Contact field')}</option>
        </select>
      )}
      {estVariable ? (
        <select
          value={valeur.replace(/[{}\s]/g, '')}
          onChange={(e) => onChange(`{{${e.target.value}}}`)}
          className={`${inputCls} bg-white`}
          data-testid={testId}
        >
          {champs.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      ) : (
        <input
          type="datetime-local"
          value={valeur}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          data-testid={testId}
        />
      )}
    </div>
  );
}
