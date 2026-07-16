'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listUserFields, createUserField, updateUserField, deleteUserField, type UserFieldDef, type UserFieldKind } from '@/lib/api';
import { SYSTEM_FIELDS, customFieldsOnly, systemFieldCode } from '@/lib/fields';
import { useT } from '@/lib/i18n';

export default function FieldsPage() {
  return <AppShell active="fields">{(session) => <FieldsInner session={session} />}</AppShell>;
}

function FieldsInner({ session }: { session: Session }) {
  const t = useT();
  const TYPES: { value: UserFieldKind; label: string }[] = [
    { value: 'text', label: t('Texte', 'Text') },
    { value: 'number', label: t('Nombre', 'Number') },
    { value: 'date', label: t('Date', 'Date') },
    { value: 'boolean', label: t('Oui/Non', 'Yes/No') },
    { value: 'url', label: t('Lien', 'Link') },
  ];
  const [fields, setFields] = useState<UserFieldDef[]>([]);
  const [tenantCode, setTenantCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<UserFieldKind>('text');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listUserFields(session.tenantId);
      setFields(res.fields);
      setTenantCode(res.tenantCode ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Édition locale optimiste : on modifie la ligne dans le state, on persiste au blur/changement.
  function patchLocal(key: string, patch: Partial<UserFieldDef>) {
    setFields((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }
  async function save(f: UserFieldDef, patch: { label?: string; type?: UserFieldKind }) {
    setSavingKey(f.key);
    setError(null);
    try {
      await updateUserField(session.tenantId, f.key, patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Enregistrement impossible', 'Failed to save'));
      await load(); // resync en cas d'échec
    } finally {
      setSavingKey(null);
    }
  }
  async function create() {
    const label = newLabel.trim();
    if (!label) return;
    setError(null);
    try {
      await createUserField(session.tenantId, { label, type: newType });
      setNewLabel('');
      setNewType('text');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible (ce champ existe peut-être déjà)', 'Could not create (this field may already exist)'));
    }
  }

  async function remove(f: UserFieldDef) {
    if (!window.confirm(t(
      `Supprimer le champ « ${f.label} » (clé ${f.key}) ?\nLes valeurs déjà saisies sur les contacts sont conservées.`,
      `Delete the field "${f.label}" (key ${f.key})?\nValues already entered on contacts are kept.`,
    ))) return;
    setError(null);
    try {
      await deleteUserField(session.tenantId, f.key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Failed to delete'));
    }
  }

  const custom = customFieldsOnly(fields);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Champs', 'Fields')}</h2>
        <p className="mt-1 text-sm text-ink-500">{t('Les champs de base sont toujours là (non supprimables). Ajoute tes propres champs, ou modifie leur libellé/type. La clé technique est verrouillée (référencée par les campagnes et les valeurs des contacts).', 'The base fields are always present (they cannot be deleted). Add your own fields, or change their label/type. The technical key is locked (referenced by campaigns and contact values).')}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* Champs de BASE (système) : toujours présents, non supprimables. Utilisables comme variables de template. */}
      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">
          {t('Champs de base', 'Base fields')}
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-500">{t('système', 'system')}</span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {SYSTEM_FIELDS.map((f) => (
              <tr key={f.key} className="border-b border-ink-50 last:border-0">
                <td className="px-5 py-2.5"><code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs text-ink-500">{f.key}</code>{tenantCode && <div className="mt-0.5 font-mono text-[10px] text-ink-300" title={t('Code public (API)', 'Public code (API)')}>{systemFieldCode(tenantCode, f.key)}</div>}</td>
                <td className="px-5 py-2.5 font-medium text-ink-800">{f.label}</td>
                <td className="px-5 py-2.5 text-right text-xs text-ink-400">{t('non supprimable', 'not deletable')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder={t('Libellé du nouveau champ (ex. Code postal)…', 'New field label (e.g. Postal code)…')}
          className="min-w-[200px] flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <select value={newType} onChange={(e) => setNewType(e.target.value as UserFieldKind)} className="rounded-lg border border-ink-300 bg-white px-2 py-2 text-sm text-ink-800">
          {TYPES.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
        <button onClick={create} disabled={newLabel.trim() === ''} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">{t('Créer un champ', 'Create a field')}</button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Mes champs', 'My fields')} ({custom.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : custom.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t("Aucun champ perso. Crée-en un ci-dessus, ou ils apparaissent à l'import CSV (colonnes personnalisées) ou via un formulaire.", 'No custom fields. Create one above, or they appear on CSV import (custom columns) or via a form.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">{t('Clé', 'Key')}</th>
                <th className="px-5 py-2 font-medium">{t('Libellé', 'Label')}</th>
                <th className="px-5 py-2 font-medium">{t('Type', 'Type')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {custom.map((f) => (
                <tr key={f.key} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3"><code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs text-ink-500">{f.key}</code>{f.code && <div className="mt-0.5 font-mono text-[10px] text-ink-300" title={t('Code public (API)', 'Public code (API)')}>{f.code}</div>}</td>
                  <td className="px-5 py-3">
                    <input
                      value={f.label}
                      onChange={(e) => patchLocal(f.key, { label: e.target.value })}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v) void save(f, { label: v }); }}
                      className="w-full rounded-lg border border-ink-300 px-2 py-1 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                  </td>
                  <td className="px-5 py-3">
                    <select
                      value={f.type}
                      onChange={(e) => { const type = e.target.value as UserFieldKind; patchLocal(f.key, { type }); void save(f, { type }); }}
                      className="rounded-lg border border-ink-300 bg-white px-2 py-1 text-sm text-ink-800"
                    >
                      {TYPES.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      {savingKey === f.key && <span className="text-xs text-ink-400">…</span>}
                      <button onClick={() => void remove(f)} className="text-coral hover:text-coral/80">{t('Supprimer', 'Delete')}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
