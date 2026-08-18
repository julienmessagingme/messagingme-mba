'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { MbaFaqImportPanel } from './MbaFaqImportPanel';
import { createMbaFaq, deleteMbaFaq, listMbaFaqs, updateMbaFaq, type MbaFaq } from '@/lib/api-mba';

/**
 * La FAQ de l'agent : saisie une par une, plus le chargement en lot (panneau dédié).
 *
 * Le compteur est affiché en permanence pour une raison précise : Meta prévient qu'au-delà de « quelques
 * centaines » d'entrées, l'agent trouve moins bien la bonne réponse, et cette dégradation est SILENCIEUSE.
 * Sans compteur visible, elle ne se découvre que dans la qualité des réponses, des semaines plus tard.
 */

const SEUIL_ALERTE = 200;

export function MbaFaqPanel({ tenantId, phoneNumberId }: { tenantId: string; phoneNumberId: string }) {
  const t = useT();
  const [faqs, setFaqs] = useState<MbaFaq[]>([]);
  const [chargement, setChargement] = useState(true);
  const [err, setErr] = useState('');
  const [edition, setEdition] = useState<{ id?: string; question: string; answer: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [recherche, setRecherche] = useState('');
  const [importOuvert, setImportOuvert] = useState(false);

  const recharger = useCallback(async (): Promise<void> => {
    const { faqs: liste } = await listMbaFaqs(tenantId, phoneNumberId);
    setFaqs(Array.isArray(liste) ? liste : []);
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

  function supprimer(faq: MbaFaq): void {
    if (faq.id === undefined) return;
    // Chez Meta, un DELETE est irréversible : ni corbeille, ni archivage, ni suppression en lot.
    const ok = window.confirm(t(
      `Supprimer définitivement « ${faq.question} » ? Meta n’a pas de corbeille : cette question sera perdue.`,
      `Permanently delete “${faq.question}”? Meta has no trash: this question will be lost.`,
    ));
    if (!ok) return;
    void agir(() => deleteMbaFaq(tenantId, phoneNumberId, faq.id as string));
  }

  // Recherche et tri côté client : l'API ne propose ni filtre, ni tri, ni pagination.
  const filtrees = recherche.trim() === ''
    ? faqs
    : faqs.filter((f) => `${f.question} ${f.answer}`.toLowerCase().includes(recherche.trim().toLowerCase()));

  if (chargement) return <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-faq-error">{err}</MbaNotice>}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-700" data-testid="mba-faq-count">
          {t(`${faqs.length} question${faqs.length > 1 ? 's' : ''}`, `${faqs.length} question${faqs.length > 1 ? 's' : ''}`)}
        </span>
        <button
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white"
          data-testid="mba-faq-new"
          onClick={() => setEdition({ question: '', answer: '' })}
        >
          {t('Ajouter une question', 'Add a question')}
        </button>
        <button
          className="rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-800"
          data-testid="mba-faq-import-open"
          onClick={() => setImportOuvert((v) => !v)}
        >
          {importOuvert ? t('Fermer l’import', 'Close import') : t('Charger en lot', 'Bulk load')}
        </button>
        <input
          className={`${inputCls} ml-auto max-w-xs`}
          data-testid="mba-faq-search"
          placeholder={t('Rechercher…', 'Search…')}
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
        />
      </div>

      {faqs.length >= SEUIL_ALERTE && (
        <MbaNotice kind="warning" testid="mba-faq-too-many">
          {t(
            `Au-delà de quelques centaines de questions, l’agent trouve moins bien la bonne réponse, et Meta ne signale rien. Mieux vaut fusionner ou retirer les questions rares que d’empiler.`,
            `Beyond a few hundred questions, the agent finds the right answer less reliably, and Meta gives no warning. Better to merge or remove rare questions than to pile them up.`,
          )}
        </MbaNotice>
      )}

      {importOuvert && (
        <MbaFaqImportPanel
          tenantId={tenantId}
          phoneNumberId={phoneNumberId}
          onImported={() => { void recharger(); }}
        />
      )}

      <ul className="space-y-2" data-testid="mba-faq-list">
        {filtrees.map((faq) => (
          <li key={faq.id ?? faq.question} className={`${cardCls} flex items-start justify-between gap-4 p-4`}>
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink-900">{faq.question}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-600">{faq.answer}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                className="text-xs font-medium text-brand-600 hover:text-brand-700"
                onClick={() => setEdition({ ...(faq.id !== undefined ? { id: faq.id } : {}), question: faq.question, answer: faq.answer })}
              >
                {t('Modifier', 'Edit')}
              </button>
              <button className="text-xs font-medium text-rose-600 hover:text-rose-700" onClick={() => supprimer(faq)}>
                {t('Supprimer', 'Delete')}
              </button>
            </div>
          </li>
        ))}
        {filtrees.length === 0 && (
          <li className="text-sm text-ink-500">
            {faqs.length === 0
              ? t('Aucune question pour l’instant.', 'No questions yet.')
              : t('Aucune question ne correspond.', 'No question matches.')}
          </li>
        )}
      </ul>

      {edition !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" role="dialog" aria-modal>
          <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-lg">
            <h3 className="text-sm font-semibold text-ink-900">
              {edition.id === undefined ? t('Nouvelle question', 'New question') : t('Modifier la question', 'Edit question')}
            </h3>
            <label className="mt-4 block">
              <span className="text-sm font-medium text-ink-800">{t('Question', 'Question')}</span>
              <span className="mt-0.5 block text-xs text-ink-500">
                {t('Écrivez-la comme vos clients la posent, et un seul sujet par question.', 'Write it the way your customers ask it, one topic per question.')}
              </span>
              <input
                className={`${inputCls} mt-1.5`}
                data-testid="mba-faq-question"
                value={edition.question}
                onChange={(e) => setEdition({ ...edition, question: e.target.value })}
              />
            </label>
            <label className="mt-4 block">
              <span className="text-sm font-medium text-ink-800">{t('Réponse', 'Answer')}</span>
              <span className="mt-0.5 block text-xs text-ink-500">
                {t('Complète et autoportante : l’agent la lit seule, sans les autres.', 'Complete and self-contained: the agent reads it alone, without the others.')}
              </span>
              <textarea
                className={`${inputCls} mt-1.5`}
                rows={5}
                data-testid="mba-faq-answer"
                value={edition.answer}
                onChange={(e) => setEdition({ ...edition, answer: e.target.value })}
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-lg border border-ink-300 px-4 py-2 text-sm" onClick={() => setEdition(null)}>
                {t('Annuler', 'Cancel')}
              </button>
              <button
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                data-testid="mba-faq-save"
                disabled={busy || edition.question.trim() === '' || edition.answer.trim() === ''}
                onClick={() => {
                  const corps = { question: edition.question.trim(), answer: edition.answer.trim() };
                  void agir(() => (edition.id === undefined
                    ? createMbaFaq(tenantId, phoneNumberId, corps)
                    : updateMbaFaq(tenantId, phoneNumberId, edition.id, corps)));
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
