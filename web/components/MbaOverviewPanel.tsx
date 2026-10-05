'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputClsAuto } from '@/lib/ui';
import { Toggle } from './Toggle';
import { MbaNotice } from './MbaNotice';
import { patchMbaSettings, putMbaRollout, type MbaStatus, type MbaSettings, type SelectionMessagePassage } from '@/lib/api-mba';
import { Bouton } from '@/components/Bouton';
import { useConfirmation } from '@/components/Confirmation';
import { lireRepondeurIa } from '@/lib/api-agent';
import { avertissementAllumageMeta } from '@/lib/repondeur';

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
   * Le choix ACTIF chez Meta. Meta le relit quand il a été posé (`handoff.message_selection`, mesuré le 2026-10-02 sur
   * le numéro MessagingMe) ; absent, il n'a jamais été choisi, et c'est le texte standard de Meta qui part.
   * ⚠️ Une première version de cet écran affirmait l'inverse (« Meta ne relit pas ce choix ») : c'était une mesure faite
   * sur un numéro où rien n'avait encore été choisi.
   */
  const [selection, setSelection] = useState<SelectionMessagePassage | null>(s?.handoff?.message_selection ?? null);
  /** Le texte tel que Meta le porte : c'est lui qui part, pas ce qu'on a tapé sans l'enregistrer. */
  const [texteEnregistre, setTexteEnregistre] = useState(s?.handoff?.message ?? '');
  const [texteCustom, setTexteCustom] = useState(s?.handoff?.message ?? '');
  /**
   * « Notre texte » coché ICI et pas encore enregistré : cocher n'envoie rien, on rédige d'abord. Sans ça, le clic
   * envoyait aussitôt le texte du champ, vide ou ancien, et on ne pouvait pas écrire.
   */
  const [redaction, setRedaction] = useState(false);
  const [texteConfirme, setTexteConfirme] = useState(false);
  const coche: SelectionMessagePassage | null = redaction ? 'CUSTOM' : selection;

  function choisirPassage(cle: SelectionMessagePassage): void {
    setTexteConfirme(false);
    if (cle === 'CUSTOM') {
      setRedaction(true);
      return;
    }
    setRedaction(false);
    void appliquer(async () => {
      const r = await patchMbaSettings(tenantId, phoneNumberId, { handoffMessageSelection: cle });
      setSelection(cle);
      return r;
    });
  }

  function enregistrerTexte(): void {
    const texte = texteCustom.trim();
    void appliquer(async () => {
      const r = await patchMbaSettings(tenantId, phoneNumberId, { handoffMessageSelection: 'CUSTOM', handoffMessage: texte });
      setSelection('CUSTOM');
      setRedaction(false);
      // Relu dans la réponse : ce qui s'affiche « enregistré » est ce que Meta porte, pas ce qu'on a cru envoyer.
      const relu = r.handoff?.message ?? texte;
      setTexteEnregistre(relu);
      setTexteCustom(relu);
      setTexteConfirme(relu === texte);
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
    if (busy) return;
    /**
     * 🔴 ALLUMER RETIRE L'AGENT IA RÉPONDEUR DE CE RÔLE (lot 5 ; relecture de la livraison A, J7) : une seule voix, le
     * serveur le remet à nul dans l'instruction même qui allume (`setMbaEnabled`, appelée par la route `rollout`). La
     * confirmation le dit en le nommant, lu au moment du geste ; une lecture ratée n'ajoute rien et n'empêche rien.
     * Occupé dès la lecture, comme l'Accueil (relecture de la livraison B, JB8) : un double clic ouvrirait sinon deux
     * confirmations, donc deux bascules.
     */
    setBusy(true);
    const repondeurRetire = allume ? null : avertissementAllumageMeta(await lireRepondeurIa(tenantId).catch(() => null), t);
    const message = allume
      ? t(
          'Éteindre l’agent arrête ses réponses sur toutes les conversations, y compris celles en cours. En le rallumant, il ne reprendra que les nouvelles conversations : les fils coupés resteront à traiter par un humain. Continuer ?',
          'Turning the agent off stops its replies on all conversations, including ongoing ones. When you turn it back on, it only picks up new conversations: the interrupted threads will need a human. Continue?',
        )
      : `${repondeurRetire !== null ? `${repondeurRetire} ` : ''}${t(
          'Allumer l’agent : il répondra aux nouvelles conversations que la plateforme lui confie, quand un client écrit sans qu’un scénario ni un membre de l’équipe ne lui réponde. Continuer ?',
          'Turn the agent on: it will answer the new conversations the platform hands over to it, when a customer writes and no scenario or team member answers. Continue?',
        )}`;
    if (!(await confirmer({ titre: allume ? t('Éteindre l’agent', 'Turn the agent off') : t('Allumer l’agent', 'Turn the agent on'), message: message, confirmer: allume ? t('Éteindre', 'Turn off') : t('Allumer', 'Turn on') }))) {
      setBusy(false);
      return;
    }
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
          {/* `min-w-0` et `break-all` : l'identifiant de Meta est une longue chaîne sans espace, et une cellule de grille ne
              se rétrécit pas sous la largeur de son contenu. Sans eux, il sortait du cadre. */}
          <div className="min-w-0">
            <dt className="text-xs text-ink-500">{t('Identifiant d’agent', 'Agent id')}</dt>
            <dd className="break-all font-mono text-xs text-ink-900">{status.agentId ?? t('pas encore créé', 'not created yet')}</dd>
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

      {/* L'interrupteur seul, comme sur l'Accueil (Julien, 2026-10-02) : les deux écrivent la même chose, Meta puis notre
          drapeau. Ce que l'allumage a d'asymétrique est dit dans la confirmation, au moment du geste. */}
      <section className={cardCls}>
        <div className="flex items-center gap-3">
          <Toggle checked={allume} onChange={basculerAllumage} disabled={busy} testid="mba-rollout-toggle" title={t('Agent de Meta', 'Meta’s agent')} />
          <span className="text-sm font-medium text-ink-900" data-testid="mba-rollout-etat">
            {allume ? t('Activé', 'Enabled') : t('Désactivé', 'Disabled')}
          </span>
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
            {t('Aucun choix n’a encore été fait : c’est le texte standard de Meta qui part, en anglais.',
              'No choice made yet: Meta’s standard text is sent, in English.')}
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
                checked={coche === cle}
                disabled={busy}
                onChange={() => choisirPassage(cle)}
              />
              {libelle}
            </label>
          ))}
        </div>
        {/* La zone de rédaction n'existe que pour « Notre texte » : les deux autres choix n'ont rien à écrire. */}
        {coche === 'CUSTOM' && (
          <div className="mt-3 space-y-2">
            <textarea
              className={`${inputClsAuto} w-full`}
              rows={3}
              value={texteCustom}
              onChange={(e) => { setTexteCustom(e.target.value); setTexteConfirme(false); }}
              placeholder={t('Je transmets votre demande à un membre de l’équipe. Il vous répond ici même, dans cette conversation.', 'I am passing your request to a team member. They will reply right here, in this conversation.')}
              aria-label={t('Notre texte', 'Our own text')}
              data-testid="mba-passage-texte"
              disabled={busy}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Bouton
                disabled={busy || texteCustom.trim() === '' || (selection === 'CUSTOM' && !redaction && texteCustom.trim() === texteEnregistre)}
                data-testid="mba-passage-enregistrer"
                onClick={enregistrerTexte}
              >
                {t('Enregistrer ce texte', 'Save this text')}
              </Bouton>
              {redaction && (
                <span className="text-xs text-ink-500" data-testid="mba-passage-a-enregistrer">
                  {t('Pas encore enregistré : rien ne change chez Meta tant que vous n’avez pas cliqué.',
                    'Not saved yet: nothing changes at Meta until you click.')}
                </span>
              )}
              {texteConfirme && (
                <span className="text-xs text-succes-700" data-testid="mba-passage-enregistre">
                  {t('Enregistré chez Meta.', 'Saved at Meta.')}
                </span>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
