'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { isValidSkillTitle, slugSkillTitle, slugSkillTitleFrappe, SKILL_BODY_MAX, SKILL_DESCRIPTION_MAX, SKILL_TITLE_MAX } from '@/lib/mba-skills';
import { createMbaSkill, deleteMbaSkill, listMbaSkills, updateMbaSkill, type MbaSkill } from '@/lib/api-mba';

/**
 * Les compétences : la personnalité et les procédures de l'agent, en langage naturel.
 *
 * Ce ne sont PAS des outils appelables (ça, ce sont les connecteurs, non branchés ici). `description` dit
 * QUAND appliquer la compétence, `skill` dit QUOI faire.
 */
export function MbaSkillsPanel({ tenantId, phoneNumberId }: { tenantId: string; phoneNumberId: string }) {
  const t = useT();
  const [skills, setSkills] = useState<MbaSkill[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [edition, setEdition] = useState<MbaSkill | null>(null);

  const recharger = useCallback(async (): Promise<void> => {
    const r = await listMbaSkills(tenantId, phoneNumberId);
    setSkills(Array.isArray(r.skills) ? r.skills : []);
    setAgentId(r.agentId);
  }, [tenantId, phoneNumberId]);

  useEffect(() => {
    let vivant = true;
    recharger()
      .catch((e: unknown) => { if (vivant) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [recharger]);

  async function agir(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setErr('');
    try {
      await action();
      await recharger();
      setEdition(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (chargement) return <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  // Seules les compétences exigent un agent créé chez Meta : les autres ressources n'en dépendent pas.
  if (agentId === null) {
    return (
      <MbaNotice kind="warning" testid="mba-skills-no-agent">
        {t(
          'Les compétences attendent que Meta ait créé la configuration de votre agent. Les informations business, la FAQ, les fichiers et les sites sont déjà modifiables en attendant.',
          'Skills wait for Meta to create your agent configuration. Business info, FAQ, files and websites can already be edited in the meantime.',
        )}
      </MbaNotice>
    );
  }

  // Le titre affiché peut porter un tiret final PENDANT la frappe (le séparateur qu'on vient de taper). La
  // validité et l'envoi portent donc sur la forme DÉFINITIVE, pas sur ce qui est à l'écran à l'instant t.
  const titreEnvoye = edition === null ? '' : slugSkillTitle(edition.title);
  const titreValide = edition !== null && isValidSkillTitle(titreEnvoye);

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-skills-error">{err}</MbaNotice>}

      <button
        className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white"
        data-testid="mba-skill-new"
        onClick={() => setEdition({ title: '', description: '', skill: '' })}
      >
        {t('Ajouter une compétence', 'Add a skill')}
      </button>

      <ul className="space-y-2" data-testid="mba-skills-list">
        {skills.map((s) => (
          <li key={s.id ?? s.title} className={`${cardCls} flex items-start justify-between gap-4 p-4`}>
            <div className="min-w-0">
              <p className="font-mono text-sm font-medium text-ink-900">{s.title}</p>
              <p className="mt-1 text-xs text-ink-500">{s.description}</p>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-ink-600">{s.skill}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button className="text-xs font-medium text-brand-600 hover:text-brand-700" onClick={() => setEdition(s)}>
                {t('Modifier', 'Edit')}
              </button>
              <button
                className="text-xs font-medium text-rose-600 hover:text-rose-700"
                onClick={() => {
                  if (s.id === undefined) return;
                  if (!window.confirm(t(`Supprimer la compétence « ${s.title} » ?`, `Delete the skill “${s.title}”?`))) return;
                  void agir(() => deleteMbaSkill(tenantId, phoneNumberId, s.id as string));
                }}
              >
                {t('Supprimer', 'Delete')}
              </button>
            </div>
          </li>
        ))}
        {skills.length === 0 && <li className="text-sm text-ink-500">{t('Aucune compétence pour l’instant.', 'No skills yet.')}</li>}
      </ul>

      {edition !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" role="dialog" aria-modal>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-lg">
            <h3 className="text-sm font-semibold text-ink-900">
              {edition.id === undefined ? t('Nouvelle compétence', 'New skill') : t('Modifier la compétence', 'Edit skill')}
            </h3>

            <label className="mt-4 block">
              <span className="text-sm font-medium text-ink-800">{t('Nom', 'Name')}</span>
              <span className="mt-0.5 block text-xs text-ink-500">
                {t('En minuscules, avec des tirets. Il est mis en forme pendant la saisie.', 'Lowercase with dashes. It is formatted as you type.')}
              </span>
              <input
                className={`${inputCls} mt-1.5 font-mono`}
                maxLength={SKILL_TITLE_MAX}
                data-testid="mba-skill-title"
                value={edition.title}
                onChange={(e) => setEdition({ ...edition, title: slugSkillTitleFrappe(e.target.value) })}
                onBlur={() => setEdition({ ...edition, title: titreEnvoye })}
              />
              {titreEnvoye !== '' && !titreValide && (
                <span className="mt-1 block text-xs text-rose-600" data-testid="mba-skill-title-error">
                  {t('Nom invalide : minuscules, chiffres et tirets uniquement.', 'Invalid name: lowercase, digits and dashes only.')}
                </span>
              )}
            </label>

            <label className="mt-4 block">
              <span className="text-sm font-medium text-ink-800">{t('Quand l’appliquer', 'When to apply it')}</span>
              <span className="mt-0.5 block text-xs text-ink-500">
                {t('Ex. « quand le client demande un remboursement ».', 'E.g. “when the customer asks for a refund”.')}
              </span>
              <input
                className={`${inputCls} mt-1.5`}
                maxLength={SKILL_DESCRIPTION_MAX}
                data-testid="mba-skill-description"
                value={edition.description}
                onChange={(e) => setEdition({ ...edition, description: e.target.value })}
              />
            </label>

            <label className="mt-4 block">
              <span className="text-sm font-medium text-ink-800">{t('Quoi faire', 'What to do')}</span>
              <span className="mt-0.5 block text-xs text-ink-500">
                {t('Les instructions, en français courant.', 'The instructions, in plain language.')}
              </span>
              <textarea
                className={`${inputCls} mt-1.5`}
                rows={8}
                maxLength={SKILL_BODY_MAX}
                data-testid="mba-skill-body"
                value={edition.skill}
                onChange={(e) => setEdition({ ...edition, skill: e.target.value })}
              />
              <span className="mt-1 block text-right text-xs text-ink-400">{edition.skill.length} / {SKILL_BODY_MAX}</span>
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-lg border border-ink-300 px-4 py-2 text-sm" onClick={() => setEdition(null)}>
                {t('Annuler', 'Cancel')}
              </button>
              <button
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                data-testid="mba-skill-save"
                disabled={busy || !titreValide || edition.description.trim() === '' || edition.skill.trim() === ''}
                onClick={() => {
                  const corps = { title: titreEnvoye, description: edition.description.trim(), skill: edition.skill.trim() };
                  void agir(() => (edition.id === undefined
                    ? createMbaSkill(tenantId, phoneNumberId, corps)
                    : updateMbaSkill(tenantId, phoneNumberId, edition.id, corps)));
                }}
              >
                {t('Enregistrer', 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
