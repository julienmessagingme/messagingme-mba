'use client';

import { useEffect, useMemo, useState } from 'react';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { TitrePage, IntroPage } from '@/components/TitrePage';
import { Squelette } from '@/components/Squelette';
import { ParcoursNumero } from '@/components/ParcoursNumero';
import { useT } from '@/lib/i18n';
import { lireLien, CLE_JETON_LIEN, type LienLu } from '@/lib/lien-numero';
import { apiDuLien, LienRefuse } from '@/lib/api/connexion-numero';

/**
 * « /brancher » (lot 3c, spec `docs/superpowers/specs/2026-10-06-lien-attente-abonnement-design.md`) : la connexion du
 * numéro WhatsApp, ouverte par le lien que donne Claude Code. 🔴 LE CLIENT NE PASSE JAMAIS PAR LA CONSOLE (décision de
 * Julien du 2026-10-06) : pas de coquille, pas de session, seulement le jeton du lien.
 *
 * Le jeton voyage après le `#` : le navigateur ne l'envoie à aucun serveur, il n'apparaît dans aucun journal ni dans
 * aucun en-tête `Referer`. La page le range dans l'onglet (`sessionStorage`), l'efface de la barre d'adresse, et
 * l'envoie en Bearer sur chaque appel ; le serveur le vérifie à chaque fois (`adminOuLien`).
 */
export default function BrancherPage() {
  const t = useT();
  /** `undefined` : pas encore lu ; `null` : aucun lien utilisable. */
  const [lien, setLien] = useState<{ jeton: string; lu: LienLu } | null | undefined>(undefined);
  const [refuse, setRefuse] = useState(false);
  const [connecte, setConnecte] = useState(false);
  const [avertissements, setAvertissements] = useState<string[]>([]);

  useEffect(() => {
    let jeton = window.location.hash.slice(1);
    if (jeton) {
      try { window.sessionStorage.setItem(CLE_JETON_LIEN, jeton); } catch { /* onglet sans stockage : le jeton vit en mémoire */ }
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      try { jeton = window.sessionStorage.getItem(CLE_JETON_LIEN) ?? ''; } catch { jeton = ''; }
    }
    const lu = jeton ? lireLien(jeton) : null;
    setLien(lu ? { jeton, lu } : null);
  }, []);

  const api = useMemo(() => (lien ? apiDuLien(lien.lu.tenantId, lien.jeton) : null), [lien]);

  // L'état de la connexion, relu toutes les trois secondes jusqu'à la connexion : c'est lui qui dit « connecté », et
  // un 401 (lien expiré, révoqué, forgé) fait redemander le lien.
  useEffect(() => {
    if (!api || connecte || refuse) return undefined;
    let vivant = true;
    const lire = () => {
      api.etat().then((r) => { if (vivant && r.etat.connecte) setConnecte(true); }).catch((err: unknown) => {
        if (vivant && err instanceof LienRefuse) setRefuse(true);
      });
    };
    lire();
    const minuterie = setInterval(lire, 3_000);
    return () => { vivant = false; clearInterval(minuterie); };
  }, [api, connecte, refuse]);

  return (
    <main className="relative flex min-h-screen items-start justify-center px-4 py-12">
      <div className="absolute right-4 top-4"><LocaleToggle /></div>
      <div className="w-full max-w-formulaire">
        <Logo className="mx-auto mb-6 h-9 w-auto" />
        <TitrePage>{t('Connecter WhatsApp', 'Connect WhatsApp')}</TitrePage>
        {lien === undefined ? (
          <Squelette forme="carte" />
        ) : lien === null || refuse || !api ? (
          <p data-testid="brancher-sans-lien" className="mt-6 rounded-carte border border-ink-200 bg-white p-5 text-sm text-ink-700">
            {t(
              'Ce lien a expiré ou ne vaut plus. Redemandez-le à Claude, dans Claude Code : il vous en donnera un nouveau.',
              'This link has expired or is no longer valid. Ask Claude for a new one, in Claude Code.',
            )}
          </p>
        ) : connecte ? (
          <div data-testid="brancher-connecte" className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
            <div className="text-lg font-semibold text-ink-900">{t('Votre numéro WhatsApp est connecté', 'Your WhatsApp number is connected')}</div>
            <p className="mt-1 text-sm text-ink-500">{t('C’est bon, retournez dans Claude Code.', 'All set, go back to Claude Code.')}</p>
          </div>
        ) : (
          <>
            <IntroPage>{t('La connexion de votre numéro WhatsApp, ouverte par Claude Code.', 'Your WhatsApp number connection, opened by Claude Code.')}</IntroPage>
            <ParcoursNumero
              tenantId={lien.lu.tenantId}
              api={api}
              choixInitial={lien.lu.mode}
              connecte={connecte}
              // « Connecté » vient de l'état relu, pas de la fin de la fenêtre : un compte relié sans numéro n'est pas connecté.
              surConnexion={setAvertissements}
            />
          </>
        )}
        {avertissements.length > 0 && (
          <p data-testid="avertissements-connexion" className="mt-4 rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte-700">
            {t('À savoir', 'Note')} : {avertissements.join(' · ')}
          </p>
        )}
      </div>
    </main>
  );
}
