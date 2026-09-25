'use client';

import { useEffect, useRef, useState } from 'react';
import { getEsConfig, completeEmbeddedSignup, type EsConfig } from '@/lib/api';
import { loadFbSdk } from '@/lib/fb-sdk';
import { useT } from '@/lib/i18n';

/**
 * LA CONNEXION D'UN NUMÉRO (Embedded Signup de Meta), partagée par la zone « Connecter ton compte WhatsApp » de
 * l'Accueil et par l'interrupteur « Numéro WhatsApp » du bloc « Canaux et services ».
 *
 * Sortie telle quelle de `ConnectNumberZone` (2026-09-25) : l'interrupteur rallumé sur un espace sans numéro
 * lance « la connexion actuelle » (plan du 2026-09-25), et la recopier aurait fait deux fenêtres Meta à tenir
 * alignées, dont une qui aurait raté le prochain correctif.
 *
 * 🔴 UNE SEULE INSTANCE PAR PAGE : elle porte l'écoute des messages de la fenêtre Meta, et les identifiants qui
 * arrivent par là. Deux instances les captureraient chacune de leur côté.
 */
export interface ConnexionNumero {
  /** `null` = configuration pas encore lue. `enabled: false` = pas de configuration d'inscription sur l'instance. */
  cfg: EsConfig | null;
  busy: boolean;
  error: string | null;
  connect(): Promise<void>;
}

/** Attend qu'une valeur apparaisse (session info postMessage), sinon null au timeout. */
function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      const v = get();
      if (v !== undefined) { clearInterval(t); resolve(v); }
      else if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(null); }
    }, 200);
  });
}

/**
 * Point d'entrée de l'**Embedded Signup Meta** (Tech Provider). Le geste ouvre la popup Meta (SDK FB +
 * config_id) ; la popup renvoie (1) un `code` échangeable (TTL 30 s, via le callback FB.login) et (2) `waba_id` +
 * `phone_number_id` (via postMessage `WA_EMBEDDED_SIGNUP`). On poste les trois au backend qui échange, rattache
 * et abonne. Si META_ES_CONFIG_ID n'est pas posé côté serveur, `cfg.enabled` est faux et rien ne s'ouvre.
 */
export function useConnexionNumero(tenantId: string, onConnected: (avertissements: string[]) => void): ConnexionNumero {
  const t = useT();
  const [cfg, setCfg] = useState<EsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // waba_id / phone_number_id arrivent par postMessage, PAS par le callback FB.login -> stash dans une ref.
  const idsRef = useRef<{ wabaId: string; phoneNumberId: string } | undefined>(undefined);

  useEffect(() => {
    getEsConfig(tenantId).then(setCfg).catch(() => setCfg({ enabled: false, appId: '', configId: '', graphVersion: '' }));
  }, [tenantId]);

  useEffect(() => {
    // Origine ANCRÉE sur la frontière de point : accepte www./business.facebook.com, REJETTE evilfacebook.com
    // (endsWith('facebook.com') l'aurait laissé passer -> injection d'ids forgés via postMessage).
    const FB_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*facebook\.com$/;
    const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined);
    /** Contenu d'un message, en texte, pour la trace de diagnostic. Ne throw jamais (données arbitraires). */
    const brut = (v: unknown): string => {
      if (typeof v === 'string') return v;
      try { return JSON.stringify(v) ?? String(v); } catch { return '[non sérialisable]'; }
    };
    function onMsg(e: MessageEvent) {
      // ⚠️ Trace AVANT les trois filtres ci-dessous. Ils retournent en SILENCE (origine, JSON illisible,
      // étiquette inattendue), ce qui rendait impossible de distinguer « Meta n'a rien envoyé » de « Meta a
      // envoyé quelque chose qu'on a jeté ». Cette confusion a coûté un aller-retour de diagnostic sur un
      // embarquement bloqué (2026-08-17) : sans cette trace, on cherche du côté de Meta un défaut qui est chez
      // nous, ou l'inverse. On ne journalise QUE ce qui vient de Facebook ou parle d'Embedded Signup, pour ne
      // pas noyer la console dans les messages des extensions du navigateur.
      const texte = brut(e.data);
      if (FB_ORIGIN.test(e.origin) || texte.includes('WA_EMBEDDED')) {
        // eslint-disable-next-line no-console
        console.info('[ES] message reçu | origine =', e.origin, '| contenu =', texte.slice(0, 400));
      }
      if (typeof e.origin !== 'string' || !FB_ORIGIN.test(e.origin)) return;
      // `e.data` peut être une CHAÎNE JSON (SDK) OU déjà un objet selon le canal -> on gère les deux.
      let d: { type?: string; event?: string; data?: Record<string, unknown> } & Record<string, unknown>;
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data as typeof d);
      } catch { return; /* message non-JSON du SDK */ }
      if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return;
      // eslint-disable-next-line no-console
      console.info('[ES] message', d.event, d.data ?? d);
      // On capture les ids dès qu'ils sont présents, QUEL QUE SOIT l'event (FINISH, etc.), et qu'ils soient
      // envoyés en string OU en number (Meta n'est pas constant) -> plus de « popup n'a rien renvoyé » à tort.
      const p = (d.data ?? d) as { waba_id?: unknown; phone_number_id?: unknown };
      const wabaId = asStr(p.waba_id);
      const phoneNumberId = asStr(p.phone_number_id);
      if (wabaId && phoneNumberId) {
        idsRef.current = { wabaId, phoneNumberId };
        // eslint-disable-next-line no-console
        console.info('[ES] ids capturés', wabaId, phoneNumberId);
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  async function connect() {
    if (!cfg?.enabled || busy) return;
    setBusy(true);
    setError(null);
    idsRef.current = undefined;
    try {
      await loadFbSdk(cfg.appId, cfg.graphVersion, t);
      window.FB!.login(
        (resp) => {
          void (async () => {
            try {
              const code = resp?.authResponse?.code;
              if (typeof code !== 'string' || code === '') {
                setError(t('Connexion Meta annulée ou refusée.', 'Meta connection cancelled or denied.'));
                return;
              }
              // La session info (waba/numéro) peut arriver juste après le callback : on lui laisse 6 s.
              //
              // Son ABSENCE n'est plus une erreur. Meta ne l'émet que lorsque la popup exécute vraiment les
              // étapes de configuration : un client qui rouvre un parcours DÉJÀ abouti n'obtient qu'un code, et
              // se retrouvait alors bloqué définitivement, sans aucun recours (mesuré le 2026-08-17). On envoie
              // donc le code seul, et le serveur retrouve le compte et le numéro à partir du token.
              const ids = await waitFor(() => idsRef.current, 6000);
              const res = await completeEmbeddedSignup(tenantId, { code, ...(ids ?? {}) });
              // Les avertissements REMONTENT : la zone de connexion est démontée dès que l'espace a un numéro,
              // donc les garder ici reviendrait à les effacer au moment de les afficher.
              onConnected(res.warnings ?? []);
            } catch (err) {
              setError(err instanceof Error ? err.message : t('Connexion impossible', 'Connection failed'));
            } finally {
              setBusy(false);
            }
          })();
        },
        { config_id: cfg.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Connexion impossible', 'Connection failed'));
      setBusy(false);
    }
  }

  return { cfg, busy, error, connect };
}
