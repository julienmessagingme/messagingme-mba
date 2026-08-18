'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputClsAuto } from '@/lib/ui';
import { Toggle } from './Toggle';
import { MbaNotice } from './MbaNotice';
import { patchMbaSettings, putMbaRollout, type MbaStatus, type MbaSettings } from '@/lib/api-mba';

/**
 * Vue d'ensemble : l'état réel de l'agent chez Meta, son allumage, et les réglages qui décident de son
 * comportement global (audience, interdits de langage, relances).
 */
export function MbaOverviewPanel({ tenantId, phoneNumberId, status, onChange }: {
  tenantId: string;
  phoneNumberId: string;
  status: MbaStatus;
  /** Remonte les réglages fraîchement écrits pour que la page reste la source de vérité. */
  onChange: (settings: MbaSettings) => void;
}) {
  const t = useT();
  const s = status.settings;
  const allume = s?.rollout?.enabled === true;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [nouvelInterdit, setNouvelInterdit] = useState('');
  const interdits = s?.never_say_phrases ?? [];

  async function appliquer(action: () => Promise<MbaSettings>): Promise<void> {
    setBusy(true);
    setErr('');
    try {
      onChange(await action());
    } catch (e) {
      // Le message vient tel quel de Meta (le serveur le relaie en 422 avec son `detail`), et il porte souvent
      // la marche à suivre exacte. Le remplacer par un « une erreur est survenue » perdrait l'essentiel.
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * L'allumage n'est PAS symétrique, et Meta le documente : éteindre arrête l'agent sur TOUTES les
   * conversations, y compris celles en cours ; rallumer ne le remet que sur les NOUVELLES. Les fils coupés ne
   * repartent jamais seuls. On le dit avant, pas après.
   */
  function basculerAllumage(): void {
    const message = allume
      ? t(
          'Éteindre l’agent arrête ses réponses sur TOUTES les conversations, y compris celles en cours. En le rallumant, il ne reprendra que les NOUVELLES conversations : les fils coupés resteront à traiter par un humain. Continuer ?',
          'Turning the agent off stops its replies on ALL conversations, including ongoing ones. When you turn it back on, it only picks up NEW conversations: the interrupted threads will need a human. Continue?',
        )
      : t(
          'Allumer l’agent : il répondra aux NOUVELLES conversations de l’audience choisie. Continuer ?',
          'Turn the agent on: it will answer NEW conversations from the selected audience. Continue?',
        );
    if (!window.confirm(message)) return;
    void appliquer(() => putMbaRollout(tenantId, phoneNumberId, !allume));
  }

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-overview-error">{err}</MbaNotice>}

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">{t('État de l’agent', 'Agent state')}</h3>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-500">{t('Ouvert par Meta', 'Opened by Meta')}</dt>
            <dd className="font-medium text-ink-900">{status.eligible ? t('Oui', 'Yes') : t('Non', 'No')}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">{t('Configuration créée', 'Configuration created')}</dt>
            <dd className="font-medium text-ink-900" data-testid="mba-onboarded">
              {status.onboarded ? t('Oui', 'Yes') : t('Pas encore', 'Not yet')}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">{t('Identifiant d’agent', 'Agent id')}</dt>
            <dd className="font-mono text-xs text-ink-700">{status.agentId ?? '—'}</dd>
          </div>
        </dl>
        {!status.onboarded && (
          <p className="mt-3 text-xs leading-relaxed text-ink-600">
            {t(
              'Vous pouvez déjà remplir les informations, la FAQ, les fichiers et les sites : ils n’attendent pas la création de l’agent. Seules les compétences l’exigent.',
              'You can already fill in the business info, FAQ, files and websites: they don’t wait for the agent to be created. Only skills require it.',
            )}
          </p>
        )}
      </section>

      <section className={cardCls}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{t('Agent actif', 'Agent on')}</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-600">
              {t(
                'Éteindre agit tout de suite sur toutes les conversations. Rallumer ne reprend que les nouvelles : ce n’est pas un interrupteur symétrique.',
                'Turning off acts immediately on all conversations. Turning back on only resumes new ones: this is not a symmetric switch.',
              )}
            </p>
          </div>
          <Toggle checked={allume} onChange={basculerAllumage} disabled={busy} testid="mba-rollout-toggle" />
        </div>
      </section>

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">{t('Audience', 'Audience')}</h3>
        <p className="mt-1 text-xs text-ink-600">
          {t('Qui l’agent a le droit de gérer.', 'Who the agent is allowed to handle.')}
        </p>
        <select
          className={`${inputClsAuto} mt-3 bg-white`}
          data-testid="mba-audience"
          disabled={busy}
          value={s?.ai_audience ?? 'EVERYONE'}
          onChange={(e) => {
            const aiAudience = e.target.value === 'ALLOWLISTED_ONLY' ? 'ALLOWLISTED_ONLY' : 'EVERYONE';
            void appliquer(() => patchMbaSettings(tenantId, phoneNumberId, { aiAudience }));
          }}
        >
          <option value="EVERYONE">{t('Tout le monde', 'Everyone')}</option>
          <option value="ALLOWLISTED_ONLY">{t('Liste d’autorisation uniquement', 'Allowlisted only')}</option>
        </select>
      </section>

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">{t('Ce que l’agent ne doit jamais dire', 'What the agent must never say')}</h3>
        <p className="mt-1 text-xs text-ink-600">
          {t('Des formulations bannies, mot pour mot.', 'Banned phrasings, word for word.')}
        </p>
        <ul className="mt-3 space-y-2">
          {interdits.map((phrase) => (
            <li key={phrase} className="flex items-center justify-between gap-3 rounded-lg border border-ink-100 px-3 py-2 text-sm">
              <span className="text-ink-800">{phrase}</span>
              <button
                className="shrink-0 text-xs font-medium text-rose-600 hover:text-rose-700"
                disabled={busy}
                onClick={() => void appliquer(() => patchMbaSettings(tenantId, phoneNumberId, { neverSay: interdits.filter((p) => p !== phrase) }))}
              >
                {t('Retirer', 'Remove')}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <input
            className={inputClsAuto + ' flex-1'}
            data-testid="mba-neversay-input"
            value={nouvelInterdit}
            placeholder={t('Ex. « c’est garanti »', 'E.g. “it’s guaranteed”')}
            onChange={(e) => setNouvelInterdit(e.target.value)}
          />
          <button
            className="shrink-0 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            data-testid="mba-neversay-add"
            disabled={busy || nouvelInterdit.trim() === ''}
            onClick={() => {
              const phrase = nouvelInterdit.trim();
              setNouvelInterdit('');
              void appliquer(() => patchMbaSettings(tenantId, phoneNumberId, { neverSay: [...interdits, phrase] }));
            }}
          >
            {t('Ajouter', 'Add')}
          </button>
        </div>
      </section>

      <section className={cardCls}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{t('Relances', 'Follow-ups')}</h3>
            <p className="mt-1 text-xs text-ink-600">
              {t('L’agent relance une conversation restée sans suite.', 'The agent follows up on a conversation left hanging.')}
            </p>
          </div>
          <Toggle
            checked={s?.followup?.enabled === true}
            disabled={busy}
            testid="mba-followup-toggle"
            onChange={() => void appliquer(() => patchMbaSettings(tenantId, phoneNumberId, { followupEnabled: s?.followup?.enabled !== true }))}
          />
        </div>
      </section>
    </div>
  );
}
