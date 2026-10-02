'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputClsAuto } from '@/lib/ui';
import { Toggle } from './Toggle';
import { MbaNotice } from './MbaNotice';
import { patchMbaSettings, putMbaRollout, type MbaStatus, type MbaSettings, type SelectionMessagePassage } from '@/lib/api-mba';
import { Bouton } from '@/components/Bouton';
import { useConfirmation } from '@/components/Confirmation';

/**
 * Vue d'ensemble : l'état réel de l'agent chez Meta, son allumage, et les réglages qui décident de son
 * comportement global (interdits de langage, relances). L'audience ne se choisit pas : l'agent ne répond qu'aux
 * contacts de sa liste, que la plateforme tient seule (elle y met les conversations qu'elle lui confie).
 */
export function MbaOverviewPanel({ tenantId, phoneNumberId, status, onChange }: {
  tenantId: string;
  phoneNumberId: string;
  status: MbaStatus;
  /** Remonte les réglages fraîchement écrits pour que la page reste la source de vérité. */
  onChange: (settings: MbaSettings) => void;
}) {
  const t = useT();
  const confirmer = useConfirmation();
  const s = status.settings;
  const allume = s?.rollout?.enabled === true;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [nouvelInterdit, setNouvelInterdit] = useState('');
  const interdits = s?.never_say_phrases ?? [];
  /**
   * ⚠️ META NE RELIT PAS CE CHOIX (mesuré le 2026-10-02) : la lecture des réglages rend `handoff.message` mais jamais
   * `message_selection`. On ne coche donc rien tant qu'il n'a pas été fait ICI, plutôt que d'afficher « texte standard »
   * sur un choix qu'on ignore. Ce qu'on vient d'écrire reste coché pour la durée de l'écran.
   */
  const [selection, setSelection] = useState<SelectionMessagePassage | null>(s?.handoff?.message_selection ?? null);
  const [texteCustom, setTexteCustom] = useState(s?.handoff?.message ?? '');

  function choisirPassage(cle: SelectionMessagePassage): void {
    // `CUSTOM` part avec son texte : sans texte, le serveur refuse, et l'écran le dit (`err`).
    const patch = cle === 'CUSTOM'
      ? { handoffMessageSelection: cle, handoffMessage: texteCustom }
      : { handoffMessageSelection: cle };
    void appliquer(async () => {
      const r = await patchMbaSettings(tenantId, phoneNumberId, patch);
      setSelection(cle);
      return r;
    });
  }

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
  async function basculerAllumage(): Promise<void> {
    const message = allume
      ? t(
          'Éteindre l’agent arrête ses réponses sur toutes les conversations, y compris celles en cours. En le rallumant, il ne reprendra que les nouvelles conversations : les fils coupés resteront à traiter par un humain. Continuer ?',
          'Turning the agent off stops its replies on all conversations, including ongoing ones. When you turn it back on, it only picks up new conversations: the interrupted threads will need a human. Continue?',
        )
      : t(
          'Allumer l’agent : il répondra aux nouvelles conversations que la plateforme lui confie, quand un client écrit sans qu’un scénario ni un membre de l’équipe ne lui réponde. Continuer ?',
          'Turn the agent on: it will answer the new conversations the platform hands over to it, when a customer writes and no scenario or team member answers. Continue?',
        );
    if (!(await confirmer({ titre: allume ? t('Éteindre l’agent', 'Turn the agent off') : t('Allumer l’agent', 'Turn the agent on'), message: message, confirmer: allume ? t('Éteindre', 'Turn off') : t('Allumer', 'Turn on') }))) return;
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
            <dd className="font-mono text-xs text-ink-900">{status.agentId ?? t('pas encore créé', 'not created yet')}</dd>
          </div>
        </dl>
        {!status.onboarded && (
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
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
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              {t(
                'Éteindre agit tout de suite sur toutes les conversations ; rallumer ne reprend que les nouvelles.',
                'Turning off acts immediately on all conversations; turning back on only resumes new ones.',
              )}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500" data-testid="mba-audience-liste">
              {t(
                'L’agent ne répond qu’aux conversations que la plateforme lui confie : un client qui écrit sans qu’un scénario ni l’équipe ne lui réponde. Pendant un scénario, il se tait.',
                'The agent only answers the conversations the platform hands over to it: a customer who writes with no scenario or team member answering. During a scenario, it stays silent.',
              )}
            </p>
          </div>
          <Toggle checked={allume} onChange={basculerAllumage} disabled={busy} testid="mba-rollout-toggle" />
        </div>
      </section>

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">{t('Ce que l’agent ne doit jamais dire', 'What the agent must never say')}</h3>
        <p className="mt-1 text-xs text-ink-500">
          {t('Des formulations bannies, mot pour mot.', 'Banned phrasings, word for word.')}
        </p>
        <ul className="mt-3 space-y-2">
          {interdits.map((phrase) => (
            <li key={phrase} className="flex items-center justify-between gap-3 rounded-controle border border-ink-100 px-3 py-2 text-sm">
              <span className="text-ink-900">{phrase}</span>
              <button
                className="shrink-0 text-xs font-medium text-danger-600 hover:text-danger-700"
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
          <Bouton
            className="shrink-0"
            data-testid="mba-neversay-add"
            disabled={busy || nouvelInterdit.trim() === ''}
            onClick={() => {
              const phrase = nouvelInterdit.trim();
              setNouvelInterdit('');
              void appliquer(() => patchMbaSettings(tenantId, phoneNumberId, { neverSay: [...interdits, phrase] }));
            }}
          >
            {t('Ajouter', 'Add')}
          </Bouton>
        </div>
      </section>

      <section className={cardCls}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{t('Relances', 'Follow-ups')}</h3>
            <p className="mt-1 text-xs text-ink-500">
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

      {/* 🔴 LE MESSAGE DE PASSAGE À UN HUMAIN. Par défaut, Meta envoie son texte standard, en anglais, au milieu d'une
          conversation en français (vu le 2026-09-30). Le choix existait côté serveur, pas à l'écran. */}
      <section className={cardCls} data-testid="mba-message-passage">
        <h3 className="text-sm font-semibold text-ink-900">{t('Message de passage à un humain', 'Handoff message')}</h3>
        <p className="mt-1 text-xs text-ink-500">
          {t('Ce que l’agent écrit au client quand il passe la main à votre équipe.',
            'What the agent writes to the customer when it hands over to your team.')}
        </p>
        {selection === null && (
          <p className="mt-2 text-xs text-ink-500" data-testid="mba-passage-inconnu">
            {t('Meta ne dit pas quel choix est actif. Tant qu’aucun n’a été fait ici, c’est son texte standard, en anglais.',
              'Meta does not report which choice is active. Until one is made here, its standard English text is used.')}
          </p>
        )}
        <div className="mt-3 space-y-2" role="radiogroup">
          {([
            ['AGENT', t('Rédigé par l’agent, dans la langue du client', 'Written by the agent, in the customer’s language')],
            ['CUSTOM', t('Notre texte', 'Our own text')],
            ['DEFAULT', t('Texte standard de Meta (en anglais)', 'Meta’s standard text (in English)')],
          ] as const).map(([cle, libelle]) => (
            <label key={cle} className="flex cursor-pointer items-center gap-2 text-sm text-ink-900">
              <input
                type="radio"
                name="mba-message-passage"
                data-testid={`mba-passage-${cle}`}
                checked={selection === cle}
                disabled={busy}
                onChange={() => choisirPassage(cle)}
              />
              {libelle}
            </label>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className={inputClsAuto}
            value={texteCustom}
            onChange={(e) => setTexteCustom(e.target.value)}
            placeholder={t('Je transmets votre demande à un conseiller, il vous répond au plus vite.', 'I am passing your request to an advisor, who will reply shortly.')}
            data-testid="mba-passage-texte"
            disabled={busy}
          />
          <Bouton
            variante="secondaire"
            disabled={busy || texteCustom.trim() === ''}
            data-testid="mba-passage-enregistrer"
            onClick={() => choisirPassage('CUSTOM')}
          >
            {t('Utiliser ce texte', 'Use this text')}
          </Bouton>
        </div>
      </section>
    </div>
  );
}
