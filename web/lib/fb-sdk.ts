'use client';

/**
 * LE SDK JS DE FACEBOOK, CHARGÉ À LA DEMANDE ET UNE SEULE FOIS.
 *
 * 🔴 EXTRAIT ICI PARCE QUE `fbSdkLoading` EST UN SINGLETON DE MODULE (2026-09-23). Deux écrans ouvrent
 * désormais une fenêtre Meta : l'inscription WhatsApp (accueil) et la connexion publicitaire. Recopier ce
 * chargeur aurait donné DEUX promesses de chargement et DEUX `FB.init` sur la même page, ce qui n'est pas
 * un défaut de style mais une course : le second `init` écrase la configuration du premier.
 *
 * ⚠️ `FB.init` prend l'app ID et la version, pas la CONFIGURATION : c'est `FB.login` qui reçoit le
 * `config_id`. Les deux écrans partagent donc la même app et ne divergent qu'au moment du login.
 */

declare global {
  interface Window {
    FB?: {
      init(opts: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
      login(cb: (resp: FbLoginResponse) => void, opts: Record<string, unknown>): void;
    };
  }
}

export interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}

let fbSdkLoading: Promise<void> | null = null;

export function loadFbSdk(appId: string, version: string, t: (fr: string, en?: string) => string): Promise<void> {
  if (window.FB) return Promise.resolve();
  if (fbSdkLoading) return fbSdkLoading;
  fbSdkLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.defer = true;
    s.onload = () => {
      if (!window.FB) { fbSdkLoading = null; reject(new Error(t('SDK Facebook indisponible', 'Facebook SDK unavailable'))); return; }
      window.FB.init({ appId, autoLogAppEvents: false, xfbml: false, version });
      resolve();
    };
    s.onerror = () => { fbSdkLoading = null; reject(new Error(t('chargement du SDK Facebook impossible (bloqueur de pub ?)', 'could not load the Facebook SDK (ad blocker?)'))); };
    document.head.appendChild(s);
  });
  return fbSdkLoading;
}
