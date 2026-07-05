'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  listCampaigns,
  getCampaign,
  listPhoneNumbers,
  createCampaign,
  runCampaign,
  type CampaignSummary,
  type CampaignDetail,
  type PhoneNumber,
  type TemplateParam,
} from '@/lib/api';

export default function CampaignsPage() {
  return <AppShell active="campagnes">{(session) => <CampaignsInner session={session} />}</AppShell>;
}

const STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: 'brouillon', cls: 'bg-slate-100 text-slate-600' },
  running: { text: 'en cours', cls: 'bg-blue-50 text-blue-700' },
  paused: { text: 'en pause', cls: 'bg-amber-50 text-amber-700' },
  completed: { text: 'terminée', cls: 'bg-emerald-50 text-emerald-700' },
  failed: { text: 'échec', cls: 'bg-red-50 text-red-700' },
  pending: { text: 'en attente', cls: 'bg-slate-100 text-slate-600' },
  sending: { text: 'envoi', cls: 'bg-blue-50 text-blue-700' },
  sent: { text: 'envoyé', cls: 'bg-slate-100 text-slate-700' },
  skipped: { text: 'ignoré', cls: 'bg-amber-50 text-amber-700' },
  // Statuts de livraison Meta
  delivered: { text: 'délivré', cls: 'bg-blue-50 text-blue-700' },
  read: { text: 'lu', cls: 'bg-emerald-50 text-emerald-700' },
};
function Badge({ status }: { status: string }) {
  const s = STATUS[status] ?? { text: status, cls: 'bg-slate-100 text-slate-600' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.text}</span>;
}

function CampaignsInner({ session }: { session: Session }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [c, n] = await Promise.all([listCampaigns(session.tenantId), listPhoneNumbers(session.tenantId)]);
      setCampaigns(c.campaigns);
      setNumbers(n.phoneNumbers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openDetail(id: string) {
    try {
      setDetail(await getCampaign(session.tenantId, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Détail indisponible');
    }
  }

  async function run(id: string) {
    setError(null);
    try {
      await runCampaign(id);
      await reload();
      if (detail?.id === id) await openDetail(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lancement impossible');
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <CreateForm tenantId={session.tenantId} numbers={numbers} onCreated={reload} />
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Campagnes ({campaigns.length})</h2>
          <button onClick={reload} className="text-xs text-brand-600 hover:underline">Rafraîchir</button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {detail && <DetailPanel detail={detail} onClose={() => setDetail(null)} />}

        {loading ? (
          <p className="text-sm text-slate-500">Chargement...</p>
        ) : campaigns.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
            Aucune campagne. Crée-en une à gauche.
          </div>
        ) : (
          <ul className="space-y-2">
            {campaigns.map((c) => (
              <li key={c.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Badge status={c.status} />
                      <span className="text-xs text-slate-400">{c.category}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      template {c.templateName} ({c.templateLanguage}) · {c.counts.total} destinataires
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      <b className="text-emerald-700">{c.counts.sent}</b> envoyés
                      {c.counts.failed > 0 && <> · <b className="text-red-700">{c.counts.failed}</b> échecs</>}
                      {c.counts.pending > 0 && <> · {c.counts.pending} en attente</>}
                      {c.counts.skipped > 0 && <> · {c.counts.skipped} ignorés</>}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <button
                      onClick={() => run(c.id)}
                      className="rounded-lg bg-brand-500 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-600"
                    >
                      Lancer
                    </button>
                    <button onClick={() => openDetail(c.id)} className="text-xs text-brand-600 hover:underline">
                      Détails
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DetailPanel({ detail, onClose }: { detail: CampaignDetail; onClose: () => void }) {
  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{detail.name}</span>
          <Badge status={detail.status} />
        </div>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-700">Fermer</button>
      </div>
      {detail.recipients.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-500">Aucun destinataire.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Téléphone</th>
              <th className="px-4 py-2 font-medium">Envoi</th>
              <th className="px-4 py-2 font-medium">Livraison</th>
              <th className="px-4 py-2 font-medium">Détail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {detail.recipients.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 font-mono text-xs">{r.toE164}</td>
                <td className="px-4 py-2"><Badge status={r.status} /></td>
                <td className="px-4 py-2">{r.deliveryStatus ? <Badge status={r.deliveryStatus} /> : <span className="text-xs text-slate-400">-</span>}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{r.deliveryError ?? r.error ?? r.messageId ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface VarRow {
  source: 'name' | 'phone' | 'field' | 'literal';
  key: string;
  value: string;
}

function CreateForm({ tenantId, numbers, onCreated }: { tenantId: string; numbers: PhoneNumber[]; onCreated: () => void }) {
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'marketing' | 'utility'>('marketing');
  const [templateName, setTemplateName] = useState('');
  const [templateLanguage, setTemplateLanguage] = useState('fr');
  const [vars, setVars] = useState<VarRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (!phoneNumberId && numbers[0]) setPhoneNumberId(numbers[0].id);
  }, [numbers, phoneNumberId]);

  function toParamMapping(): TemplateParam[] {
    return vars.map((v, i) => {
      const position = i + 1;
      if (v.source === 'name') return { position, source: { type: 'attribute', key: 'name' } };
      if (v.source === 'phone') return { position, source: { type: 'attribute', key: 'phone' } };
      if (v.source === 'field') return { position, source: { type: 'field', key: v.key } };
      return { position, source: { type: 'literal', value: v.value } };
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await createCampaign(tenantId, {
        phoneNumberId,
        name,
        category,
        templateName,
        templateLanguage,
        paramMapping: toParamMapping(),
      });
      setOk(`Campagne créée : ${res.recipientCount} destinataires.`);
      setName('');
      setTemplateName('');
      setVars([]);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = phoneNumberId !== '' && name.trim() !== '' && templateName.trim() !== '' && !busy;

  return (
    <section className="h-fit rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700">Nouvelle campagne</h2>

      <Field label="Numéro expéditeur">
        {numbers.length === 0 ? (
          <p className="text-xs text-amber-700">Aucun numéro provisionné pour ce tenant.</p>
        ) : (
          <select value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} className={inputCls}>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayPhoneNumber ?? n.id} {n.verifiedName ? `(${n.verifiedName})` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Nom de la campagne">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Promo été" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Catégorie">
          <select value={category} onChange={(e) => setCategory(e.target.value as 'marketing' | 'utility')} className={inputCls}>
            <option value="marketing">marketing</option>
            <option value="utility">utility</option>
          </select>
        </Field>
        <Field label="Langue">
          <input value={templateLanguage} onChange={(e) => setTemplateLanguage(e.target.value)} className={inputCls} placeholder="fr" />
        </Field>
      </div>

      <Field label="Nom du template">
        <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} className={inputCls} placeholder="promo_ete" />
      </Field>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Variables du template</label>
          <button onClick={() => setVars([...vars, { source: 'name', key: '', value: '' }])} className="text-xs text-brand-600 hover:underline">
            + variable
          </button>
        </div>
        {vars.length === 0 && <p className="text-xs text-slate-400">Aucune variable. {'{{1}}'}, {'{{2}}'}... dans l&apos;ordre.</p>}
        <div className="space-y-2">
          {vars.map((v, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-8 shrink-0 text-xs text-slate-400">{`{{${i + 1}}}`}</span>
              <select
                value={v.source}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, source: e.target.value as VarRow['source'] } : x)))}
                className={`${inputCls} flex-1`}
              >
                <option value="name">Nom du contact</option>
                <option value="phone">Téléphone</option>
                <option value="field">Champ perso</option>
                <option value="literal">Texte fixe</option>
              </select>
              {v.source === 'field' && (
                <input
                  value={v.key}
                  onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                  className={`${inputCls} w-24`}
                  placeholder="clé (ex ville)"
                />
              )}
              {v.source === 'literal' && (
                <input
                  value={v.value}
                  onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  className={`${inputCls} w-24`}
                  placeholder="valeur"
                />
              )}
              <button onClick={() => setVars(vars.filter((_, j) => j !== i))} className="shrink-0 text-slate-400 hover:text-red-600" aria-label="Retirer">
                ×
              </button>
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
        {busy ? 'Création...' : 'Créer la campagne'}
      </button>
    </section>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      {children}
    </div>
  );
}
