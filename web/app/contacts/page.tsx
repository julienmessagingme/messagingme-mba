'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { CsvImport } from '@/components/CsvImport';
import type { Session } from '@/lib/session';
import {
  listContacts,
  queryContacts,
  updateContact,
  listUserFields,
  createUserField,
  listTags,
  contactIdentity,
  bulkContactAction,
  deleteContacts,
  createContact,
  type Contact,
  type UserFieldDef,
  type UserFieldKind,
  type ContactFilters,
  type BulkTarget,
  type BulkAction,
} from '@/lib/api';
import { filtersActive } from '@/lib/contact-filters';
import { ContactFilterPanel } from '@/components/ContactFilterPanel';
import { ContactHistoryPanel } from '@/components/ContactHistoryPanel';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate } from '@/lib/day';
import { inputCls } from '@/lib/ui';
import { fieldValue } from '@/lib/fields';

export default function ContactsPage() {
  return <AppShell active="contacts">{(session) => <ContactsInner session={session} />}</AppShell>;
}

/** Bascule un id dans un Set (retourne un NOUVEAU Set pour React). */
function toggleSet(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

function ContactsInner({ session }: { session: Session }) {
  const t = useT();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'import'>('list');
  const [detail, setDetail] = useState<Contact | null>(null);
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

  // Filtres (mini-CRM). Objet ContactFilters édité par le panneau. La sérialisation vit dans web/lib/contact-filters.
  const [filters, setFilters] = useState<ContactFilters>({});
  const [ajoutOuvert, setAjoutOuvert] = useState(false);
  // Retour d'action positif (ajout d'un contact) : distinct de `error`, qui est rouge.
  const [info, setInfo] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const active = useMemo(() => filtersActive(filters), [filters]);

  // Sélection. 'ids' = cases cochées (`selected`) ; 'all' = tous les correspondants, `excluded` = décochés.
  const [allMode, setAllMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // Action en masse ouverte (modale). null = fermée.
  const [action, setAction] = useState<ActionCrm | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Menu « Rajouter des contacts » : les deux façons d'en ajouter tiennent derrière un seul bouton. */
  const [ajoutMenuOuvert, setAjoutMenuOuvert] = useState(false);

  const LIMIT = 500;
  // Garde anti-course : chaque `load` prend un numéro de séquence ; une réponse périmée (filtre changé entre
  // temps, ou GET rejoué après un 5xx transitoire) est ignorée. Sans ça, une réponse lente d'un filtre ANCIEN
  // pourrait écraser la liste + le total courants, et fausser le compteur montré dans la confirmation de suppression.
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setError(null);
    try {
      if (filtersActive(filters)) {
        const res = await queryContacts(session.tenantId, filters, { limit: LIMIT });
        if (seq !== reqSeq.current) return;
        setContacts(res.contacts);
        setTotal(res.total ?? res.contacts.length);
      } else {
        const { contacts } = await listContacts(session.tenantId, { limit: LIMIT });
        if (seq !== reqSeq.current) return;
        setContacts(contacts);
        // >= cap : total réel inconnu (pas de « tout sélectionner » sûr tant qu'on n'a pas filtré).
        setTotal(contacts.length < LIMIT ? contacts.length : null);
      }
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [session.tenantId, filters]);

  // Debounce sur les filtres (350 ms) : évite un fetch par frappe.
  useEffect(() => {
    setLoading(true);
    const id = setTimeout(() => { void load(); }, 350);
    return () => clearTimeout(id);
  }, [load]);

  // Changement de filtres -> la sélection précédente n'a plus de sens (jeu de résultats différent) : reset.
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);
  useEffect(() => { setAllMode(false); setSelected(new Set()); setExcluded(new Set()); }, [filtersKey]);

  // Définitions user fields + tags existants (fiche + filtres + actions) : chargés une fois.
  useEffect(() => {
    listUserFields(session.tenantId).then(({ fields }) => setUserFields(fields)).catch(() => setUserFields([]));
    listTags(session.tenantId).then(({ tags }) => setTagSuggestions(tags.map((t) => t.tag))).catch(() => setTagSuggestions([]));
  }, [session.tenantId]);

  // Reflète une modif de fiche dans la liste ET la modale, sans recharger toute la liste.
  function onContactUpdated(updated: Contact) {
    setDetail(updated);
    setContacts((list) => list.map((c) => (c.id === updated.id ? updated : c)));
  }
  function onFieldCreated(def: UserFieldDef) {
    setUserFields((defs) => (defs.some((d) => d.key === def.key) ? defs : [...defs, def]));
  }

  // ---- Sélection ----
  const loadedIds = useMemo(() => contacts.map((c) => c.id), [contacts]);
  const isRowChecked = (id: string) => (allMode ? !excluded.has(id) : selected.has(id));
  const selectedCount = allMode ? Math.max((total ?? loadedIds.length) - excluded.size, 0) : selected.size;
  const allLoadedChecked = loadedIds.length > 0 && loadedIds.every((id) => isRowChecked(id));
  const moreThanLoaded = total != null && total > loadedIds.length;

  function toggleRow(id: string) {
    if (allMode) setExcluded((prev) => toggleSet(prev, id));
    else setSelected((prev) => toggleSet(prev, id));
  }
  function toggleHeader() {
    if (allMode) { clearSelection(); return; }
    setSelected(allLoadedChecked ? new Set() : new Set(loadedIds));
  }
  function selectAllMatching() { setAllMode(true); setSelected(new Set()); setExcluded(new Set()); }
  function clearSelection() { setAllMode(false); setSelected(new Set()); setExcluded(new Set()); }

  // Cible d'action : par ids cochés, OU par filtres + exclusions (jamais un payload massif d'UUID).
  const currentTarget = (): BulkTarget => (allMode ? { filters, excludeIds: [...excluded] } : { ids: [...selected] });

  async function onActionDone(affected: number) {
    setAction(null);
    setMenuOpen(false);
    clearSelection();
    await load();
    // Rafraîchit aussi les suggestions de tags (un add_tag a pu créer un nouveau tag).
    listTags(session.tenantId).then(({ tags }) => setTagSuggestions(tags.map((tg) => tg.tag))).catch(() => {});
    void affected;
  }

  if (mode === 'import') {
    return (
      <div className="mx-auto max-w-3xl">
        <button onClick={() => setMode('list')} className="mb-4 text-sm text-brand-600 hover:underline">
          ← {t('Retour aux contacts', 'Back to contacts')}
        </button>
        <CsvImport tenantId={session.tenantId} onImported={() => { void load(); }} />
      </div>
    );
  }

  const countLabel = total != null ? String(total) : `${contacts.length}+`;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Contacts', 'Contacts')} ({countLabel})</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowFilters((s) => !s)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${active ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-600 hover:bg-ink-50'}`}
            data-testid="contacts-toggle-filters"
          >
            {t('Filtres', 'Filters')}{active ? ' •' : ''}
          </button>
          <button onClick={() => void load()} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
          {/* UN seul geste pour ajouter des contacts, et le choix de la façon ensuite. Les deux boutons côte à
              côte donnaient deux actions de même poids, alors qu'on cherche d'abord « en ajouter ». */}
          <div className="relative">
            <button
              onClick={() => setAjoutMenuOuvert((o) => !o)}
              data-testid="contacts-ajouter-menu"
              aria-haspopup="menu"
              aria-expanded={ajoutMenuOuvert}
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
            >
              + {t('Rajouter des contacts', 'Add contacts')}
            </button>
            {ajoutMenuOuvert && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setAjoutMenuOuvert(false)} />
                <div role="menu" className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-ink-200 bg-white py-1 text-sm shadow-lg">
                  {/* Ajout à l'unité : jusqu'ici il fallait fabriquer un fichier CSV pour un seul numéro. */}
                  <button
                    onClick={() => { setAjoutMenuOuvert(false); setAjoutOuvert(true); }}
                    data-testid="contact-ajouter"
                    className="block w-full px-4 py-2 text-left hover:bg-ink-50"
                  >
                    {t('Ajouter un contact', 'Add a contact')}
                  </button>
                  <button
                    onClick={() => { setAjoutMenuOuvert(false); setMode('import'); }}
                    data-testid="contact-importer-csv"
                    className="block w-full px-4 py-2 text-left hover:bg-ink-50"
                  >
                    {t('Importer un CSV', 'Import a CSV')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {info && (
        <p className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-mint-50 px-3 py-2 text-sm text-mint-700" data-testid="contact-info">
          <span>{info}</span>
          <button onClick={() => setInfo(null)} className="text-xs text-mint-700 hover:underline">{t('Fermer', 'Close')}</button>
        </p>
      )}

      {ajoutOuvert && (
        <AjoutContactModal
          tenantId={session.tenantId}
          tagSuggestions={tagSuggestions}
          onClose={() => setAjoutOuvert(false)}
          onDone={(message) => {
            setAjoutOuvert(false);
            setInfo(message);
            void load();
            listTags(session.tenantId).then(({ tags }) => setTagSuggestions(tags.map((tg) => tg.tag))).catch(() => {});
          }}
        />
      )}

      {showFilters && (
        <ContactFilterPanel
          filters={filters}
          onChange={setFilters}
          userFields={userFields}
          tagSuggestions={tagSuggestions}
          onClear={() => setFilters({})}
        />
      )}

      {/* Barre de sélection + action : apparaît dès qu'un contact est coché. */}
      {selectedCount > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-200 bg-brand-50/50 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink-700">
            <span className="font-medium">{t(`${selectedCount} sélectionné(s)`, `${selectedCount} selected`)}</span>
            {!allMode && moreThanLoaded && allLoadedChecked && (
              <button onClick={selectAllMatching} className="text-brand-600 hover:underline" data-testid="contacts-select-all-matching">
                {t(`Sélectionner les ${total} contacts correspondants`, `Select all ${total} matching contacts`)}
              </button>
            )}
            <button onClick={clearSelection} className="text-ink-500 hover:underline">{t('Tout désélectionner', 'Clear selection')}</button>
          </div>
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
              data-testid="contacts-action"
            >
              {t('Action', 'Action')} ▾
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-lg border border-ink-200 bg-white py-1 text-sm shadow-lg">
                  <button onClick={() => { setAction('add_tag'); setMenuOpen(false); }} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Ajouter un tag', 'Add a tag')}</button>
                  <button onClick={() => { setAction('remove_tag'); setMenuOpen(false); }} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Retirer un tag', 'Remove a tag')}</button>
                  <button onClick={() => { setAction('set_field'); setMenuOpen(false); }} className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Ajouter un champ', 'Set a field')}</button>
                  <div className="my-1 border-t border-ink-100" />
                  <button onClick={() => { setAction('optin'); setMenuOpen(false); }} data-testid="contacts-action-optin" className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Passer en opt-in', 'Mark as opted in')}</button>
                  <button onClick={() => { setAction('optout'); setMenuOpen(false); }} data-testid="contacts-action-optout" className="block w-full px-4 py-2 text-left hover:bg-ink-50">{t('Passer en opt-out', 'Mark as opted out')}</button>
                  <div className="my-1 border-t border-ink-100" />
                  <button onClick={() => { setAction('delete'); setMenuOpen(false); }} data-testid="contacts-action-delete" className="block w-full px-4 py-2 text-left text-red-600 hover:bg-red-50">{t('Supprimer', 'Delete')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <ContactsTable
        contacts={contacts}
        loading={loading}
        onSelect={setDetail}
        isRowChecked={isRowChecked}
        onToggleRow={toggleRow}
        onToggleHeader={toggleHeader}
        headerChecked={allMode || allLoadedChecked}
      />

      {action && (
        <BulkActionModal
          action={action}
          tenantId={session.tenantId}
          target={currentTarget()}
          count={selectedCount}
          userFields={userFields}
          tagSuggestions={tagSuggestions}
          onDone={onActionDone}
          onClose={() => setAction(null)}
        />
      )}

      {detail && (
        <ContactDetail
          contact={detail}
          userFields={userFields}
          tagSuggestions={tagSuggestions}
          tenantId={session.tenantId}
          onUpdated={onContactUpdated}
          onFieldCreated={onFieldCreated}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}

/**
 * Ajout d'UN contact à la main. Le mini-CRM ne savait créer que par import CSV : il fallait fabriquer un
 * fichier pour un seul numéro. Réutilise la coquille de `BulkActionModal` (overlay, `inputCls`, pied
 * Annuler/Valider) plutôt qu'une seconde mise en page de modale.
 *
 * Le serveur délègue au MÊME upsert que l'import et l'API publique : le numéro est donc normalisé pareil, et un
 * numéro DÉJÀ connu met le contact à jour. On le DIT, au lieu d'annoncer une création qui n'a pas eu lieu.
 */
function AjoutContactModal({ tenantId, tagSuggestions, onDone, onClose }: {
  tenantId: string;
  tagSuggestions: string[];
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [phone, setPhone] = useState('');
  const [nom, setNom] = useState('');
  const [prenom, setPrenom] = useState('');
  const [email, setEmail] = useState('');
  const [bsuid, setBsuid] = useState('');
  // PLUSIEURS tags : la saisie est un tampon, les tags retenus vivent dans `tags`. Un seul champ texte
  // n'en acceptait qu'un, alors que la route accepte déjà une liste et que la fiche sait en afficher plusieurs.
  const [tags, setTags] = useState<string[]>([]);
  const [tagBuffer, setTagBuffer] = useState('');
  // PRÉ-COCHÉE : un numéro saisi à la main vient de la personne. Décochable pour le cas contraire.
  const [optIn, setOptIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = phone.trim() !== '' && !busy;

  /** Retient le tampon comme tag. Borné et dédupliqué comme côté serveur, pour ne pas promettre autre chose. */
  function ajouterTag(): void {
    const brut = tagBuffer.trim().slice(0, 64);
    if (brut === '') return;
    setTags((prev) => (prev.includes(brut) || prev.length >= 50 ? prev : [...prev, brut]));
    setTagBuffer('');
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // Un tag laissé dans le tampon sans validation compte quand même : sinon on perd en silence ce que
      // l'opérateur vient de taper, juste parce qu'il n'a pas appuyé sur Entrée.
      const tousLesTags = [...new Set(tagBuffer.trim() !== '' ? [...tags, tagBuffer.trim().slice(0, 64)] : tags)];
      // `prenom` et `email` sont des champs SOCLE : la route les matérialise à la première écriture, il n'y a
      // donc rien à créer avant. Les clés vides sont écartées plutôt qu'envoyées à blanc.
      const champs: Record<string, string> = {};
      if (prenom.trim() !== '') champs.prenom = prenom.trim();
      if (email.trim() !== '') champs.email = email.trim();

      const res = await createContact(tenantId, {
        phone: phone.trim(),
        ...(nom.trim() !== '' ? { name: nom.trim() } : {}),
        ...(Object.keys(champs).length > 0 ? { fields: champs } : {}),
        ...(tousLesTags.length > 0 ? { tags: tousLesTags } : {}),
        ...(bsuid.trim() !== '' ? { bsuid: bsuid.trim() } : {}),
        optIn,
      });
      onDone(res.status === 'created'
        ? t('Contact ajouté.', 'Contact added.')
        : t('Ce numéro était déjà dans la liste : le contact a été mis à jour.', 'This number was already in the list: the contact was updated.'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Ajout impossible', 'Could not add'));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold tracking-tight text-ink-900">{t('Ajouter un contact', 'Add a contact')}</h3>
        <p className="mt-1 text-sm text-ink-500">{t('Le numéro suffit. Le reste peut se compléter ensuite sur la fiche.', 'The number is enough. The rest can be filled in later on the record.')}</p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">
              {t('Téléphone', 'Phone')} <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus value={phone} onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }}
              placeholder="+33 6 12 34 56 78" data-testid="ajout-telephone" className={inputCls}
            />
            <p className="mt-1 text-xs text-ink-400">{t('Format libre : le numéro est normalisé comme à l’import.', 'Free format: the number is normalized as on import.')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">{t('Prénom', 'First name')}</label>
              <input value={prenom} onChange={(e) => setPrenom(e.target.value)} data-testid="ajout-prenom" className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">{t('Nom', 'Name')}</label>
              <input value={nom} onChange={(e) => setNom(e.target.value)} data-testid="ajout-nom" className={inputCls} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('E-mail (optionnel)', 'Email (optional)')}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="ajout-email" className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Tags (optionnel)', 'Tags (optional)')}</label>
            {tags.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid="ajout-tags-retenus">
                {tags.map((tg) => (
                  <span key={tg} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                    {tg}
                    <button type="button" onClick={() => setTags((prev) => prev.filter((x) => x !== tg))} aria-label={t('Retirer', 'Remove')} className="text-brand-400 transition hover:text-coral">×</button>
                  </span>
                ))}
              </div>
            )}
            {/* Entrée AJOUTE le tag au lieu de valider le formulaire : sinon saisir un 2e tag envoyait la fiche. */}
            <div className="flex gap-2">
              <input
                list="ajout-tag-suggestions" value={tagBuffer} onChange={(e) => setTagBuffer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ajouterTag(); } }}
                placeholder={t('Un tag, puis Entrée', 'A tag, then Enter')} data-testid="ajout-tag" className={inputCls}
              />
              <button type="button" onClick={ajouterTag} disabled={tagBuffer.trim() === ''} data-testid="ajout-tag-valider"
                className="shrink-0 rounded-lg border border-ink-300 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50">
                {t('Ajouter', 'Add')}
              </button>
            </div>
            <datalist id="ajout-tag-suggestions">{tagSuggestions.map((tg) => <option key={tg} value={tg} />)}</datalist>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Compte WhatsApp / BSUID (optionnel)', 'WhatsApp account / BSUID (optional)')}</label>
            <input value={bsuid} onChange={(e) => setBsuid(e.target.value)} data-testid="ajout-bsuid" className={`${inputCls} font-mono`} />
            <p className="mt-1 text-xs text-ink-400">
              {t("Identifiant WhatsApp d'un client qui n'a pas partagé son numéro. À ne renseigner que si tu l'as.", "WhatsApp identifier for a customer who hasn't shared their number. Only fill this in if you have it.")}
            </p>
          </div>
          {/* Pré-cochée : voir le commentaire de `optIn`. Un contact saisi à la main sans opt-in serait ignoré
              par toutes les campagnes, sans que rien ne l'annonce au moment de la saisie. */}
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} data-testid="ajout-optin" className="mt-0.5 h-4 w-4" />
            <span>{t('Ce contact a donné son accord pour recevoir des messages marketing', 'This contact agreed to receive marketing messages')}</span>
          </label>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-ink-500 hover:text-ink-800 disabled:opacity-50">{t('Annuler', 'Cancel')}</button>
          <button
            onClick={() => void submit()} disabled={!canSubmit} data-testid="ajout-valider"
            className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? t('Ajout…', 'Adding…') : t('Ajouter', 'Add')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Actions en masse du mini-CRM, telles que l'écran les propose.
 *
 * Volontairement distinctes des actions de l'API : le consentement s'expose ici en DEUX entrées de menu
 * (« Passer en opt-in » / « Passer en opt-out ») là où le serveur n'a qu'une action portant une valeur.
 * Faire choisir la valeur dans un menu déroulant aurait ajouté un clic pour rien.
 */
type ActionCrm = 'add_tag' | 'remove_tag' | 'set_field' | 'optin' | 'optout' | 'delete';

/** Modale d'une action en masse : formulaire adapté (tag / champ / consentement / suppression), appelle l'API
 *  avec la cible calculée, puis onDone(affected).
 *
 *  UNE SEULE destruction. Il en a existé deux, une douce qui gardait la conversation et une définitive ;
 *  personne ne veut supprimer un contact à moitié, et la douce laissait le fil dans l'Inbox après coup.
 *  Supprimer efface donc pour de vrai, et exige de taper le mot : le serveur le demande déjà, mais c'est le
 *  client qui l'envoie, donc cette garde-là ne protège que d'une erreur d'API. La saisie est la seule qui
 *  protège l'opérateur, et c'est la seule erreur qui arrive vraiment ici. */
function BulkActionModal({ action, tenantId, target, count, userFields, tagSuggestions, onDone, onClose }: {
  action: ActionCrm;
  tenantId: string;
  target: BulkTarget;
  count: number;
  userFields: UserFieldDef[];
  tagSuggestions: string[];
  onDone: (affected: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [tag, setTag] = useState('');
  const [fieldKey, setFieldKey] = useState(userFields.find((d) => d.key !== 'email')?.key ?? userFields[0]?.key ?? '');
  const [fieldVal, setFieldVal] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titles: Record<ActionCrm, string> = {
    add_tag: t('Ajouter un tag', 'Add a tag'),
    remove_tag: t('Retirer un tag', 'Remove a tag'),
    set_field: t('Ajouter un champ', 'Set a field'),
    optin: t('Passer en opt-in', 'Mark as opted in'),
    optout: t('Passer en opt-out', 'Mark as opted out'),
    delete: t('Supprimer les contacts', 'Delete contacts'),
  };

  const canSubmit = action === 'delete'
    ? confirmation.trim().toUpperCase() === 'SUPPRIMER'
    : action === 'optin' || action === 'optout'
      ? true
      : action === 'set_field'
        ? fieldKey !== '' && fieldVal.trim() !== ''
        : tag.trim() !== '';

  async function submit() {
    if (busy) return; // garde de ré-entrance : un double Entrée (inputs non désactivés) ne double pas l'appel
    setBusy(true);
    setError(null);
    try {
      let affected: number;
      if (action === 'delete') {
        // `purges` = le nombre de PERSONNES supprimées, c'est ce que l'opérateur a demandé ; pas le nombre de
        // messages détruits au passage, qui serait un chiffre spectaculaire et sans rapport avec sa décision.
        affected = (await deleteContacts(tenantId, target)).purges;
      } else {
        const act: BulkAction = action === 'set_field'
          ? { type: 'set_field', key: fieldKey, value: fieldVal.trim() }
          : action === 'optin' || action === 'optout'
            ? { type: 'set_optin', value: action === 'optin' ? 'opted_in' : 'opted_out' }
            : { type: action, tags: [tag.trim()] };
        affected = (await bulkContactAction(tenantId, target, act)).affected;
      }
      onDone(affected);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Action impossible', 'Action failed'));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold tracking-tight text-ink-900">{titles[action]}</h3>
        <p className="mt-1 text-sm text-ink-500">{t(`${count} contact(s) concerné(s).`, `${count} contact(s) affected.`)}</p>

        <div className="mt-4 space-y-3">
          {(action === 'add_tag' || action === 'remove_tag') && (
            <>
              <input list="bulk-tag-suggestions" autoFocus value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }} placeholder={t('Nom du tag', 'Tag name')} className={inputCls} />
              <datalist id="bulk-tag-suggestions">{tagSuggestions.map((tg) => <option key={tg} value={tg} />)}</datalist>
            </>
          )}
          {action === 'set_field' && (
            <div className="flex flex-col gap-2">
              <select value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} className={`${inputCls} bg-white`}>
                {userFields.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
              <input autoFocus value={fieldVal} onChange={(e) => setFieldVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }} placeholder={t('Valeur à poser', 'Value to set')} className={inputCls} />
              <p className="text-xs text-ink-400">{t('La valeur écrase le champ sur tous les contacts sélectionnés.', 'The value overwrites the field on all selected contacts.')}</p>
            </div>
          )}
          {action === 'optin' && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {t(`Les ${count} contact(s) deviennent destinataires de campagne. À n'utiliser que si vous détenez une preuve de leur consentement.`, `The ${count} contact(s) become eligible for campaigns. Only use this if you hold proof of their consent.`)}
            </p>
          )}
          {action === 'optout' && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {t(`Les ${count} contact(s) seront exclus de toute campagne, y compris de celles déjà programmées. Leur fiche et leur historique restent intacts.`, `The ${count} contact(s) will be excluded from every campaign, including already scheduled ones. Their record and history stay intact.`)}
            </p>
          )}
          {action === 'delete' && (
            <>
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {t(`IRRÉVERSIBLE. Pour les ${count} contact(s) : la fiche, la conversation dans l'Inbox, ses messages et son analyse sont détruits. Les compteurs de campagne restent justes, mais plus personne n'est reconnaissable.`, `IRREVERSIBLE. For the ${count} contact(s): the record, the Inbox conversation, its messages and its analysis are destroyed. Campaign counters stay accurate, but nobody is identifiable any more.`)}
              </p>
              <label className="block text-sm text-ink-600">
                {t('Tapez SUPPRIMER pour confirmer', 'Type SUPPRIMER to confirm')}
                <input autoFocus value={confirmation} onChange={(e) => setConfirmation(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }} placeholder="SUPPRIMER" data-testid="suppression-confirm" className={`${inputCls} mt-1`} />
              </label>
            </>
          )}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-ink-500 hover:text-ink-800 disabled:opacity-50">{t('Annuler', 'Cancel')}</button>
          <button
            onClick={() => void submit()}
            disabled={busy || !canSubmit}
            className={`rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 ${action === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-500 hover:bg-brand-600'}`}
            data-testid="bulk-submit"
          >
            {busy ? t('…', '…') : action === 'delete' ? t('Supprimer', 'Delete') : t('Appliquer', 'Apply')}
          </button>
        </div>
      </div>
    </div>
  );
}

// text porte les DEUX langues [fr, en] (résolu au rendu via t(...badge.text)) : cette const vit au niveau
// module, où useT() est inappelable. opt-in / opt-out sont identiques dans les deux langues.
const OPT_IN_LABEL: Record<string, { text: [string, string]; cls: string }> = {
  opted_in: { text: ['opt-in', 'opt-in'], cls: 'bg-emerald-50 text-emerald-700' },
  opted_out: { text: ['opt-out', 'opt-out'], cls: 'bg-red-50 text-red-700' },
  unknown: { text: ['inconnu', 'unknown'], cls: 'bg-ink-100 text-ink-600' },
};

/** WhatsApp ID (wa_id) : la clé de routage WhatsApp = les chiffres du numéro sans « + », sinon le BSUID. */
function waIdOf(c: Contact): string | null {
  if (c.phoneE164) return c.phoneE164.replace(/[^0-9]/g, '');
  return c.bsuid ?? null;
}


function ContactsTable({ contacts, loading, onSelect, isRowChecked, onToggleRow, onToggleHeader, headerChecked }: {
  contacts: Contact[];
  loading: boolean;
  onSelect: (c: Contact) => void;
  isRowChecked: (id: string) => boolean;
  onToggleRow: (id: string) => void;
  onToggleHeader: () => void;
  headerChecked: boolean;
}) {
  const t = useT();
  if (loading) return <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>;
  if (contacts.length === 0)
    return (
      <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
        {t("Aucun contact pour l'instant. Clique « + Rajouter des contacts » pour commencer.", 'No contacts yet. Click "+ Add contacts" to get started.')}
      </div>
    );
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
      <table className="w-full min-w-[920px] text-sm">
        <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th className="w-10 px-4 py-2.5">
              <input type="checkbox" checked={headerChecked} onChange={onToggleHeader} aria-label={t('Tout sélectionner', 'Select all')} data-testid="contacts-select-all" className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-400" />
            </th>
            <th className="px-4 py-2.5 font-medium">{t('Nom', 'Name')}</th>
            <th className="px-4 py-2.5 font-medium">{t('Prénom', 'First name')}</th>
            <th className="px-4 py-2.5 font-medium">{t('Téléphone', 'Phone')}</th>
            <th className="px-4 py-2.5 font-medium">BSUID</th>
            <th className="px-4 py-2.5 font-medium">WhatsApp ID</th>
            <th className="px-4 py-2.5 font-medium">Email</th>
            <th className="px-4 py-2.5 font-medium">Opt-in</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {contacts.map((c) => {
            const badge = OPT_IN_LABEL[c.optInStatus] ?? OPT_IN_LABEL.unknown!;
            const waId = waIdOf(c);
            const checked = isRowChecked(c.id);
            return (
              <tr key={c.id} className={`transition hover:bg-brand-50 ${checked ? 'bg-brand-50/60' : ''}`}>
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={checked} onChange={() => onToggleRow(c.id)} aria-label={t('Sélectionner', 'Select')} className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-400" />
                </td>
                <td className="cursor-pointer px-4 py-2.5 font-medium text-ink-900" onClick={() => onSelect(c)}>{c.profileName ?? <span className="font-normal text-ink-400">-</span>}</td>
                <td className="cursor-pointer px-4 py-2.5" onClick={() => onSelect(c)}>{fieldValue(c, 'prenom') ?? <span className="text-ink-400">-</span>}</td>
                <td className="cursor-pointer px-4 py-2.5 font-mono text-xs" onClick={() => onSelect(c)}>{c.phoneE164 ?? <span className="text-ink-400">-</span>}</td>
                <td className="cursor-pointer px-4 py-2.5 font-mono text-xs" onClick={() => onSelect(c)}>
                  {c.bsuid
                    ? <span className="inline-flex max-w-[160px] items-center gap-1"><span className="truncate" title={c.bsuid}>{c.bsuid}</span></span>
                    : <span className="text-ink-400">-</span>}
                </td>
                <td className="cursor-pointer px-4 py-2.5 font-mono text-xs" onClick={() => onSelect(c)}>
                  {waId
                    ? <span className="inline-flex max-w-[160px] items-center gap-1"><span className="truncate" title={waId}>{waId}</span></span>
                    : <span className="text-ink-400">-</span>}
                </td>
                <td className="cursor-pointer px-4 py-2.5 text-xs text-ink-700" onClick={() => onSelect(c)}>{fieldValue(c, 'email') ?? <span className="text-ink-400">-</span>}</td>
                <td className="cursor-pointer px-4 py-2.5" onClick={() => onSelect(c)}>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{t(...badge.text)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Input adapté au type d'un user field. */
function FieldValueInput({ type, value, onChange }: { type: UserFieldKind; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const cls = 'flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
  if (type === 'boolean') {
    // Valeurs stockées de façon canonique ('true'/'false'). On tolère l'affichage des valeurs héritées
    // ('oui'/'non'/'1'/'0') pour qu'une ancienne fiche reste correctement présélectionnée (pas de backfill).
    const low = value.trim().toLowerCase();
    const display = ['true', 'oui', '1'].includes(low) ? 'true' : ['false', 'non', '0'].includes(low) ? 'false' : '';
    return (
      <select value={display} onChange={(e) => onChange(e.target.value)} className={`${cls} bg-white`}>
        <option value="">-</option>
        <option value="true">{t('oui', 'yes')}</option>
        <option value="false">{t('non', 'no')}</option>
      </select>
    );
  }
  const inputType = type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : type === 'url' ? 'url' : 'text';
  return <input type={inputType} value={value} onChange={(e) => onChange(e.target.value)} className={cls} placeholder={type === 'url' ? 'https://…' : t('valeur', 'value')} />;
}

/**
 * Valeur éditable EN PLACE (Nom, Prénom, champs perso) : affichage + « modifier »/« supprimer » au survol,
 * bascule en input avec ✓/✗. `type` fourni -> input typé (FieldValueInput) ; sinon input texte simple (Nom).
 * `onDelete` absent -> non supprimable. onSave/onDelete renvoient un booléen de succès (reste en édition si échec).
 */
function EditableField({ value, type, mono, busy, editable = true, onSave, onDelete }: {
  value: string;
  type?: UserFieldKind;
  mono?: boolean;
  busy: boolean;
  /** false -> valeur en lecture seule (pas de « modifier ») ; la suppression reste possible si onDelete fourni.
   *  Sert aux champs « orphelins » (sans définition) : les éditer échouerait en 400, mais on peut les retirer. */
  editable?: boolean;
  onSave: (v: string) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const begin = () => { setDraft(value); setEditing(true); };
  const commit = async () => { if (await onSave(draft)) setEditing(false); };
  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        {type ? (
          <FieldValueInput type={type} value={draft} onChange={setDraft} />
        ) : (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false); }}
            className="min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        )}
        <button onClick={() => void commit()} disabled={busy} className="shrink-0 text-brand-600 hover:text-brand-700 disabled:opacity-50" aria-label={t('Enregistrer', 'Save')}>✓</button>
        <button onClick={() => setEditing(false)} className="shrink-0 text-ink-400 hover:text-ink-700" aria-label={t('Annuler', 'Cancel')}>×</button>
      </span>
    );
  }
  return (
    <span className="group flex items-center gap-2">
      <span className={`${mono ? 'font-mono ' : ''}break-words text-ink-900`}>{value !== '' ? value : '-'}</span>
      {editable && (
        <button onClick={begin} data-testid="champ-modifier" className="shrink-0 text-xs text-brand-600 underline decoration-dotted transition hover:text-brand-700" aria-label={t('Modifier', 'Edit')}>{t('modifier', 'edit')}</button>
      )}
      {onDelete && value !== '' && (
        <button onClick={() => void onDelete()} disabled={busy} data-testid="champ-supprimer" className="shrink-0 text-xs text-ink-400 underline decoration-dotted transition hover:text-coral disabled:opacity-50" aria-label={t('Supprimer', 'Delete')}>{t('supprimer', 'delete')}</button>
      )}
    </span>
  );
}

/** Fiche détail d'un contact : attributs, champs perso (libellé + valeur), tags. Éditable : Nom, Prénom, valeurs
 *  de champs (modif/suppression), ajout d'un champ, affecter/retirer un tag. Téléphone + BSUID en lecture seule. */
function ContactDetail({
  contact,
  userFields,
  tagSuggestions,
  tenantId,
  onUpdated,
  onFieldCreated,
  onClose,
}: {
  contact: Contact;
  userFields: UserFieldDef[];
  tagSuggestions: string[];
  tenantId: string;
  onUpdated: (c: Contact) => void;
  onFieldCreated: (def: UserFieldDef) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const badge = OPT_IN_LABEL[contact.optInStatus] ?? OPT_IN_LABEL.unknown!;
  const defByKey = new Map(userFields.map((d) => [d.key, d]));
  // 'prenom' est déjà affiché dans le bloc fixe ci-dessus -> l'exclure de la section Champs (pas de doublon).
  const fieldEntries = Object.entries(contact.fields ?? {}).filter(([k, v]) => k !== 'prenom' && v != null && String(v).trim() !== '');
  const filledKeys = new Set([...fieldEntries.map(([k]) => k), 'prenom']);
  const addable = userFields.filter((d) => !filledKeys.has(d.key));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newTag, setNewTag] = useState('');
  // Création d'un NOUVEAU champ (pas seulement piocher dans l'existant) depuis la fiche.
  const [creatingField, setCreatingField] = useState(false);
  const [cLabel, setCLabel] = useState('');
  const [cType, setCType] = useState<UserFieldKind>('text');
  const [cVal, setCVal] = useState('');
  // Champ déjà créé mais dont la pose de valeur a échoué : on le réutilise au retry (évite un 409).
  const [createdRef, setCreatedRef] = useState<UserFieldDef | null>(null);
  // Onglet courant. L'historique se charge au premier affichage seulement (le panneau fait son propre fetch,
  // et n'est monté que quand l'onglet est actif).
  const [tab, setTab] = useState<'fiche' | 'historique'>('fiche');

  const selectedDef = defByKey.get(newKey);

  async function apply(patch: {
    fields?: Record<string, string>; removeFields?: string[]; addTags?: string[]; removeTags?: string[];
    profileName?: string | null; optInStatus?: 'opted_in' | 'opted_out';
  }) {
    setBusy(true);
    setError(null);
    try {
      const { contact: updated } = await updateContact(tenantId, contact.id, patch);
      onUpdated(updated);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Modification impossible', 'Update failed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Enregistre la valeur d'un champ SOCLE (Prénom). Valeur vide -> on retire la valeur (pas de champ vide).
   *
   * Il y avait ici un contournement : créer le user field avant d'écrire, parce que la route répondait « champ
   * inconnu : prenom » sur un espace neuf. Il ne pouvait PAS marcher, et masquait pourquoi : la création d'un
   * champ dont la clé est celle d'un champ de base est refusée en 409, et le `catch` l'avalait en silence. Le
   * serveur matérialise désormais le champ socle à la première écriture (cf. `src/crm/fields.ts` SOCLE_FIELDS).
   */
  async function saveSocleField(key: string, value: string): Promise<boolean> {
    const v = value.trim();
    return v === '' ? apply({ removeFields: [key] }) : apply({ fields: { [key]: v } });
  }

  async function addField() {
    if (!newKey || newVal.trim() === '') return;
    if (await apply({ fields: { [newKey]: newVal.trim() } })) { setNewKey(''); setNewVal(''); }
  }
  // Crée un nouveau user field (POST) PUIS pose sa valeur sur ce contact, en une fois. Si la pose de
  // valeur échoue (ex. valeur invalide pour le type), on garde le champ créé : un retry corrige juste la
  // valeur sans recréer le champ (donc pas de 409 « existe déjà »).
  async function createAndAddField() {
    const label = cLabel.trim();
    if (label === '' || cVal.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      let def = createdRef && createdRef.label === label ? createdRef : null;
      if (!def) {
        def = await createUserField(tenantId, { label, type: cType });
        onFieldCreated(def);
        setCreatedRef(def);
      }
      const ok = await apply({ fields: { [def.key]: cVal.trim() } });
      if (ok) { setCreatingField(false); setCLabel(''); setCVal(''); setCType('text'); setCreatedRef(null); }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création du champ impossible', 'Failed to create the field'));
    } finally {
      setBusy(false);
    }
  }
  async function addTag() {
    const tag = newTag.trim();
    if (tag === '') return;
    if (await apply({ addTags: [tag] })) setNewTag('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-ink-900">{contact.profileName ?? contactIdentity(contact) ?? '-'}</h3>
            <p className="font-mono text-xs text-ink-400">{contactIdentity(contact) ?? '-'}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>

        <div className="mt-4 flex gap-1 border-b border-ink-100 text-sm">
          {(['fiche', 'historique'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-1.5 transition ${tab === k ? 'border-brand-500 font-medium text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800'}`}
            >
              {k === 'fiche' ? t('Fiche', 'Details') : t('Historique', 'History')}
            </button>
          ))}
        </div>

        {tab === 'historique' ? (
          <ContactHistoryPanel tenantId={tenantId} contactId={contact.id} />
        ) : (
        <>
        <div className="mt-4 grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2 text-sm">
          <span className="text-ink-400">{t('Nom', 'Name')}</span>
          <EditableField value={contact.profileName ?? ''} busy={busy} onSave={(v) => apply({ profileName: v.trim() === '' ? null : v.trim() })} />
          <span className="text-ink-400">{t('Prénom', 'First name')}</span>
          <EditableField value={fieldValue(contact, 'prenom') ?? ''} type="text" busy={busy} onSave={(v) => saveSocleField('prenom', v)} onDelete={() => apply({ removeFields: ['prenom'] })} />
          <span className="text-ink-400">{t('Téléphone', 'Phone')}</span>
          <span className="font-mono text-ink-900" title={t("Le numéro (identité/routage WhatsApp) n'est pas modifiable", "The number (WhatsApp identity/routing) can't be changed")}>{contact.phoneE164 ?? '-'}</span>
          {contact.bsuid && (
            <>
              <span className="text-ink-400">{t('Compte WhatsApp', 'WhatsApp account')}</span>
              <span className="font-mono text-ink-900" title={t("BSUID : identifiant WhatsApp unique d'un client qui n'a pas partagé son numéro (non modifiable)", "BSUID: unique WhatsApp identifier for a customer who hasn't shared their number (not editable)")}>{contact.bsuid}</span>
            </>
          )}
          <span className="text-ink-400">{t('Consentement', 'Consent')}</span>
          {/* Modifiable À LA MAIN, et ce n'est pas du confort : le garde-fou de campagne exige un opt-in
              EXPLICITE pour le marketing, donc un contact « inconnu » est écarté des envois en silence. Sans ce
              réglage sur la fiche, rien ne permettait de le rattraper au cas par cas.
              Pas de retour à « inconnu » : ce statut veut dire « rien n'a jamais été enregistré ». */}
          <span className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{t(...badge.text)}</span>
            {contact.optInStatus !== 'opted_in' && (
              <button onClick={() => void apply({ optInStatus: 'opted_in' })} disabled={busy} data-testid="fiche-optin"
                className="shrink-0 text-xs text-brand-600 underline decoration-dotted transition hover:text-brand-700 disabled:opacity-50">
                {t('passer en opt-in', 'mark opted in')}
              </button>
            )}
            {contact.optInStatus !== 'opted_out' && (
              <button onClick={() => void apply({ optInStatus: 'opted_out' })} disabled={busy} data-testid="fiche-optout"
                className="shrink-0 text-xs text-ink-400 underline decoration-dotted transition hover:text-coral disabled:opacity-50">
                {t('passer en opt-out', 'mark opted out')}
              </button>
            )}
          </span>
          <span className="text-ink-400">{t('Ajouté le', 'Added on')}</span>
          <span className="text-ink-900">{formatDate(contact.createdAt, locale)}</span>
        </div>

        {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Tags</h4>
          <div className="flex flex-wrap items-center gap-1.5">
            {(contact.tags ?? []).map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                {tag}
                <button onClick={() => void apply({ removeTags: [tag] })} disabled={busy} className="text-brand-400 hover:text-coral" aria-label={`${t('Retirer', 'Remove')} ${tag}`}>×</button>
              </span>
            ))}
            {(contact.tags ?? []).length === 0 && <span className="text-sm text-ink-400">{t('Aucun tag.', 'No tags.')}</span>}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              list="tag-suggestions"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addTag(); }}
              placeholder={t('Ajouter un tag…', 'Add a tag…')}
              className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <datalist id="tag-suggestions">{tagSuggestions.map((tag) => <option key={tag} value={tag} />)}</datalist>
            <button onClick={addTag} disabled={busy || newTag.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">{t('Ajouter', 'Add')}</button>
          </div>
        </div>

        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{t('Champs', 'Fields')}</h4>
          {fieldEntries.length === 0 ? (
            <p className="text-sm text-ink-400">{t('Aucun champ perso.', 'No custom fields.')}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-ink-200">
              {fieldEntries.map(([k, v], i) => (
                <div key={k} className={`grid grid-cols-[130px_1fr] items-center gap-3 px-3 py-1.5 text-sm ${i % 2 ? 'bg-ink-50' : 'bg-white'}`}>
                  <span className="truncate text-ink-500">{defByKey.get(k)?.label ?? k}</span>
                  <EditableField
                    value={String(v)}
                    type={defByKey.get(k)?.type ?? 'text'}
                    busy={busy}
                    editable={defByKey.has(k)}
                    onSave={(nv) => (nv.trim() === '' ? apply({ removeFields: [k] }) : apply({ fields: { [k]: nv.trim() } }))}
                    onDelete={() => apply({ removeFields: [k] })}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 space-y-2">
            {addable.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <select value={newKey} onChange={(e) => { setNewKey(e.target.value); setNewVal(''); }} className="rounded-lg border border-ink-300 bg-white px-2 py-2 text-sm text-ink-800">
                  <option value="">{t('Ajouter un champ existant…', 'Add an existing field…')}</option>
                  {addable.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
                {selectedDef && (
                  <>
                    <FieldValueInput type={selectedDef.type} value={newVal} onChange={setNewVal} />
                    <button onClick={addField} disabled={busy || newVal.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">{t('Ajouter', 'Add')}</button>
                  </>
                )}
              </div>
            )}
            {!creatingField ? (
              <button onClick={() => setCreatingField(true)} className="text-sm font-medium text-brand-600 hover:text-brand-700">+ {t('Créer un nouveau champ', 'Create a new field')}</button>
            ) : (
              <div className="space-y-2 rounded-lg border border-brand-200 bg-brand-50/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input value={cLabel} onChange={(e) => setCLabel(e.target.value)} placeholder={t('Nom du champ (ex. Métier)', 'Field name (e.g. Job)')} className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100" />
                  <select value={cType} onChange={(e) => setCType(e.target.value as UserFieldKind)} className="rounded-lg border border-ink-300 bg-white px-2 py-2 text-sm text-ink-800">
                    <option value="text">{t('texte', 'text')}</option>
                    <option value="number">{t('nombre', 'number')}</option>
                    <option value="date">{t('date', 'date')}</option>
                    <option value="datetime">{t('date et heure', 'date & time')}</option>
                    <option value="boolean">{t('oui/non', 'yes/no')}</option>
                    <option value="url">{t('lien', 'link')}</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <FieldValueInput type={cType} value={cVal} onChange={setCVal} />
                  <button onClick={createAndAddField} disabled={busy || cLabel.trim() === '' || cVal.trim() === ''} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">{t('Créer et ajouter', 'Create and add')}</button>
                  <button onClick={() => { setCreatingField(false); setCLabel(''); setCVal(''); setCreatedRef(null); }} className="text-sm text-ink-400 hover:text-ink-700">{t('Annuler', 'Cancel')}</button>
                </div>
              </div>
            )}
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
