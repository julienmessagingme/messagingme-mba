'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { saveSession, pageDArrivee, type Session } from '@/lib/session';
import { getMe, getEspaces, changerEspace, type EspaceDuCompte } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { Icone } from '@/components/Icone';

/** Initiales pour la pastille (nom si dispo, sinon partie locale de l'email). */
function initials(email: string): string {
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : local.slice(0, 2);
  return s.toUpperCase();
}

/** Le libellé d'un rôle. Un manager n'est pas un agent : il affecte les conversations et lit la conformité. */
function libelleRole(role: string, t: (fr: string, en: string) => string): string {
  if (role === 'admin') return t('Administrateur', 'Administrator');
  if (role === 'manager') return t('Manager', 'Manager');
  if (role === 'agent') return t('Agent', 'Agent');
  return role;
}

/**
 * Menu « Compte » en dropdown, à droite du header. Clic-dehors + Échap pour fermer. Items rôle-aware :
 * admin -> Compte (gestion équipe), Abonnement + Billing (désactivés, câblage Stripe hors lot), Déconnexion ;
 * agent -> Déconnexion seule. Pour tous, « Changer d'espace » juste au-dessus de Déconnexion quand l'adresse en ouvre
 * plusieurs, et le nom de l'espace actuel en tête. Tailwind pur, aucune dépendance.
 */
export function AccountMenu({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isAdmin = session.role === 'admin';
  const t = useT();
  const { locale, setLocale } = useLocale();
  /**
   * L'adresse ouvre-t-elle l'exploitation ? Demandé au serveur (`/me`) à la première ouverture du menu, jamais
   * deviné ici. Un confort d'accès : `/ops` a sa propre garde, et ce lien n'ouvre rien à lui seul.
   */
  const [exploitation, setExploitation] = useState(false);
  /**
   * Les espaces de l'adresse (RC3), lus à la première ouverture comme `/me`, jamais à chaque page. `[]` tant qu'ils ne
   * sont pas lus, et pour toujours si la lecture échoue (API d'avant la route) : l'entrée n'apparaît simplement pas.
   */
  const [espaces, setEspaces] = useState<EspaceDuCompte[]>([]);
  const [bascule, setBascule] = useState<string | null>(null);
  const [erreurBascule, setErreurBascule] = useState<string | null>(null);
  const demande = useRef(false);

  useEffect(() => {
    if (!open || demande.current || session.observation) return;
    demande.current = true;
    getMe(session.tenantId).then((m) => setExploitation(m.exploitation === true)).catch(() => {});
    getEspaces(session.tenantId).then(setEspaces).catch(() => {});
  }, [open, session.tenantId, session.observation]);

  const actuel = espaces.find((e) => e.actuel);
  const autres = espaces.filter((e) => !e.actuel);

  /**
   * Basculer : la session neuve REMPLACE l'ancienne, puis un rechargement complet vers la page d'arrivée de CE rôle,
   * pour qu'aucun état de l'ancien espace ne survive en mémoire (listes, compteurs, brouillons).
   */
  async function basculer(cible: string): Promise<void> {
    setBascule(cible);
    setErreurBascule(null);
    try {
      const r = await changerEspace(session.tenantId, cible);
      saveSession({ token: r.token, email: r.user.email, role: r.user.role, tenantId: r.user.tenantId });
      window.location.assign(pageDArrivee(r.user.role));
    } catch (e) {
      setBascule(null);
      setErreurBascule(e instanceof Error ? e.message : t('Changement d’espace impossible.', 'Could not switch workspace.'));
    }
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const disabledItem = (label: string) => (
    <div className="flex cursor-not-allowed items-center justify-between px-3 py-2 text-sm text-ink-500" title={t('Bientôt disponible', 'Coming soon')}>
      {label}
      <span className="rounded-controle bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">{t('bientôt', 'soon')}</span>
    </div>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="menu-compte"
        className="flex items-center gap-2 rounded-controle border border-ink-200 py-1 pl-1 pr-2 text-sm text-ink-900 transition-colors duration-150 hover:bg-ink-50"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{initials(session.email)}</span>
        <span className="hidden max-w-[160px] truncate sm:inline">{session.email}</span>
        <Icone nom="deplier" taille="petite" className={`text-ink-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-carte border border-ink-200 bg-white py-1 shadow-mm-md" role="menu">
          <div className="border-b border-ink-100 px-3 py-2">
            <div className="truncate text-sm font-medium text-ink-900">{session.email}</div>
            {actuel && <div className="truncate text-xs text-ink-700" data-testid="menu-espace-actuel">{actuel.tenantName}</div>}
            <div className="text-xs text-ink-500">{libelleRole(session.role, t)}</div>
          </div>
          {/* Langue de l'interface (FR/EN), mémorisée par navigateur. */}
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <span className="text-xs text-ink-500">{t('Langue', 'Language')}</span>
            <div className="inline-flex overflow-hidden rounded-controle border border-ink-200 text-xs">
              {(['fr', 'en'] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => setLocale(l)}
                  aria-pressed={locale === l}
                  className={`px-2 py-0.5 font-medium transition-colors duration-150 ${locale === l ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-ink-50'}`}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {/* La page personnelle (mot de passe, double authentification), pour tous les rôles. Absente en
              observation : cette session n'a pas d'identité à elle. */}
          {!session.observation && (
            <Link href="/compte" onClick={() => setOpen(false)} data-testid="menu-mon-compte" className="block px-3 py-2 text-sm text-ink-900 hover:bg-ink-50">{t('Mon compte', 'My account')}</Link>
          )}
          {exploitation && (
            <Link href="/ops" onClick={() => setOpen(false)} data-testid="menu-exploitation" className="block px-3 py-2 text-sm text-ink-900 hover:bg-ink-50">{t('Exploitation', 'Operations')}</Link>
          )}
          {isAdmin && (
            <>
              <Link href="/admin" onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-ink-900 hover:bg-ink-50">{t('Compte & équipe', 'Account & team')}</Link>
              <Link href="/settings/email" onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-ink-900 hover:bg-ink-50">{t('Boîtes email', 'Email accounts')}</Link>
              {disabledItem(t('Abonnement', 'Subscription'))}
              {disabledItem(t('Billing', 'Billing'))}
            </>
          )}
          {/* Changer d'espace : seulement si l'adresse en ouvre un autre. Aucune preuve redemandée (décision de Julien) :
              la connexion propose déjà ces espaces-là avec cette preuve-là. */}
          {autres.length > 0 && (
            <div className="border-t border-ink-100 py-1" data-testid="menu-changer-espace">
              <div className="px-3 py-1 text-xs text-ink-500">{t('Changer d’espace', 'Switch workspace')}</div>
              {autres.map((e) => (
                <button
                  key={e.tenantId}
                  onClick={() => void basculer(e.tenantId)}
                  disabled={bascule !== null}
                  data-testid={`menu-espace-${e.tenantId}`}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-ink-900 hover:bg-ink-50 disabled:cursor-wait disabled:opacity-60"
                >
                  <span className="truncate">{e.tenantName}</span>
                  <span className="shrink-0 text-xs text-ink-500">{bascule === e.tenantId ? t('Ouverture…', 'Opening…') : libelleRole(e.role, t)}</span>
                </button>
              ))}
              {erreurBascule && <p className="px-3 py-1 text-xs text-danger" role="alert">{erreurBascule}</p>}
            </div>
          )}
          <button onClick={onLogout} className="block w-full border-t border-ink-100 px-3 py-2 text-left text-sm text-danger hover:bg-ink-50">{t('Déconnexion', 'Log out')}</button>
        </div>
      )}
    </div>
  );
}
