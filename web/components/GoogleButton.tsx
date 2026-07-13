'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthConfig, loginWithGoogle } from '@/lib/api';
import { saveSession } from '@/lib/session';

// GIS (Google Identity Services) : typage minimal du global injecté par le script Google.
interface GisCredentialResponse {
  credential?: string;
}
interface GisId {
  initialize(cfg: { client_id: string; callback: (r: GisCredentialResponse) => void }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GisId } };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** Charge le script GIS une seule fois (idempotent), résout quand `window.google.accounts.id` est prêt. */
function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script Google indisponible')));
      return;
    }
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('script Google indisponible'));
    document.head.appendChild(s);
  });
}

/**
 * Bouton « Se connecter avec Google » (GIS). Récupère le client_id via /auth/config : si Google est désactivé
 * (client_id vide côté serveur) le bouton ne s'affiche pas (pas de 500, pas de blocage). Sur credential : vérif
 * serveur du jeton (POST /auth/google) puis session + redirection (agent -> inbox, admin -> dashboard). Un nouvel
 * email crée un espace côté serveur -> toujours admin -> dashboard.
 */
export function GoogleButton({ onError }: { onError?: (msg: string) => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  // Ref pour garder onError stable : évite de re-déclencher l'effet (et re-render du bouton) à chaque render parent.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // null = pas encore su ; '' = Google désactivé -> pas de bouton ; sinon le client_id.
  const [clientId, setClientId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAuthConfig()
      .then((cfg) => {
        if (!cancelled) setClientId(cfg.googleEnabled ? cfg.googleClientId : '');
      })
      .catch(() => {
        if (!cancelled) setClientId('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!clientId) return; // vide (désactivé) ou pas encore chargé
    let cancelled = false;
    loadGis()
      .then(() => {
        if (cancelled || !ref.current) return;
        const id = window.google?.accounts?.id;
        if (!id) return;
        id.initialize({
          client_id: clientId,
          callback: (resp) => {
            const idToken = resp.credential;
            if (!idToken) {
              onErrorRef.current?.('Réponse Google vide, réessaie.');
              return;
            }
            loginWithGoogle(idToken)
              .then((res) => {
                saveSession({ token: res.token, email: res.user.email, role: res.user.role, tenantId: res.user.tenantId });
                // Nouvel espace -> onboarding (connecter le numéro), comme le signup email ; sinon inbox (agent) / dashboard.
                router.replace(res.isNew ? '/accueil' : res.user.role === 'agent' ? '/inbox' : '/dashboard');
              })
              .catch((err) => onErrorRef.current?.(err instanceof Error ? err.message : 'Connexion Google impossible'));
          },
        });
        id.renderButton(ref.current, { theme: 'outline', size: 'large', width: 320, text: 'continue_with', logo_alignment: 'center' });
      })
      .catch(() => onErrorRef.current?.('Google indisponible pour le moment.'));
    return () => {
      cancelled = true;
    };
  }, [clientId, router]);

  if (!clientId) return null; // pas encore chargé, ou Google désactivé -> rien

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-3 text-xs text-ink-400">
        <span className="h-px flex-1 bg-ink-200" />
        ou
        <span className="h-px flex-1 bg-ink-200" />
      </div>
      <div ref={ref} className="flex justify-center" />
    </div>
  );
}
