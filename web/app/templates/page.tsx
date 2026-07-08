'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listTemplates, createTemplate, type TemplateSummary, type TemplateButtonInput } from '@/lib/api';

export default function TemplatesPage() {
  return <AppShell active="templates">{(session) => <TemplatesInner session={session} />}</AppShell>;
}

const STATUS: Record<string, string> = {
  APPROVED: 'bg-emerald-50 text-emerald-700',
  PENDING: 'bg-amber-50 text-amber-700',
  REJECTED: 'bg-red-50 text-red-700',
};

function TemplatesInner({ session }: { session: Session }) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setTemplates((await listTemplates(session.tenantId)).templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
      <CreateForm tenantId={session.tenantId} onCreated={reload} />
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Templates ({templates.length})</h2>
          <button onClick={reload} className="text-xs text-brand-600 hover:underline">Rafraîchir</button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate-500">Chargement...</p>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
            Aucun template. Crée-en un à gauche (il passe en revue Meta avant d&apos;être utilisable).
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Nom</th>
                  <th className="px-4 py-2.5 font-medium">Catégorie</th>
                  <th className="px-4 py-2.5 font-medium">Langue</th>
                  <th className="px-4 py-2.5 font-medium">Statut</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {templates.map((t) => (
                  <tr key={`${t.name}-${t.language}`} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono text-xs">{t.name}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{t.category?.toLowerCase()}</td>
                    <td className="px-4 py-2.5 text-xs">{t.language}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[t.status] ?? 'bg-slate-100 text-slate-600'}`}>
                        {t.status?.toLowerCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function CreateForm({ tenantId, onCreated }: { tenantId: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'MARKETING' | 'UTILITY'>('MARKETING');
  const [language, setLanguage] = useState('fr');
  const [body, setBody] = useState('');
  const [examples, setExamples] = useState<string[]>([]);
  const [buttons, setButtons] = useState<TemplateButtonInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Nombre de variables {{n}} distinctes dans le corps.
  const varCount = useMemo(() => new Set(body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size, [body]);

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await createTemplate(tenantId, {
        name: name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        category,
        language,
        body,
        ...(varCount > 0 ? { example: examples.slice(0, varCount).map((e) => e || 'exemple') } : {}),
        ...(buttons.length > 0 ? { buttons } : {}),
      });
      setOk(`Template soumis (statut : ${res.status}). Il passe en revue Meta.`);
      setName('');
      setBody('');
      setExamples([]);
      setButtons([]);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = name.trim() !== '' && body.trim() !== '' && !busy;

  return (
    <section className="h-fit rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700">Nouveau template</h2>
      <p className="mt-1 text-xs text-slate-500">Soumis à Meta pour validation (quelques minutes à quelques heures).</p>

      <Field label="Nom (minuscules, sans espaces)">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="promo_ete" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Catégorie">
          <select value={category} onChange={(e) => setCategory(e.target.value as 'MARKETING' | 'UTILITY')} className={inputCls}>
            <option value="MARKETING">marketing</option>
            <option value="UTILITY">utility</option>
          </select>
        </Field>
        <Field label="Langue">
          <input value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls} placeholder="fr" />
        </Field>
      </div>

      <Field label="Corps du message">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          className={inputCls}
          placeholder={'Bonjour {{1}}, voici notre offre 🎉'}
        />
        <p className="mt-1 text-xs text-slate-400">Utilise {'{{1}}'}, {'{{2}}'}... pour les variables (mappées sur les champs contact à la campagne).</p>
      </Field>

      {varCount > 0 && (
        <div className="mt-2">
          <label className="mb-1 block text-sm font-medium text-slate-700">Exemples de variables (requis par Meta)</label>
          <div className="space-y-2">
            {Array.from({ length: varCount }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-8 text-xs text-slate-400">{`{{${i + 1}}}`}</span>
                <input
                  value={examples[i] ?? ''}
                  onChange={(e) => setExamples((x) => { const c = [...x]; c[i] = e.target.value; return c; })}
                  className={`${inputCls} flex-1`}
                  placeholder="ex. Julie"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Boutons</label>
          <div className="flex gap-2 text-xs">
            <button onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '' }])} className="text-brand-600 hover:underline">+ réponse rapide</button>
            <button onClick={() => setButtons([...buttons, { type: 'URL', text: '', url: '' }])} className="text-brand-600 hover:underline">+ lien</button>
          </div>
        </div>
        <div className="space-y-2">
          {buttons.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-16 shrink-0 text-xs text-slate-400">{b.type === 'URL' ? 'lien' : 'réponse'}</span>
              <input
                value={b.text}
                onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                className={`${inputCls} flex-1`}
                placeholder="Texte du bouton"
              />
              {b.type === 'URL' && (
                <input
                  value={b.url ?? ''}
                  onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                  className={`${inputCls} w-28`}
                  placeholder="https://..."
                />
              )}
              <button onClick={() => setButtons(buttons.filter((_, j) => j !== i))} className="shrink-0 text-slate-400 hover:text-red-600" aria-label="Retirer">×</button>
            </div>
          ))}
        </div>
      </div>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {ok && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</p>}

      <button
        onClick={submit}
        disabled={!canSubmit}
        className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {busy ? 'Soumission...' : 'Créer le template'}
      </button>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      {children}
    </div>
  );
}
