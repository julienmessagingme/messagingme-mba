'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { TitrePage, IntroPage } from '@/components/TitrePage';
import { ParcoursNumero, BoutonPortail } from '@/components/ParcoursNumero';
import { Bouton, classesBouton } from '@/components/Bouton';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { getAccountStatus, type AccountStatusResponse } from '@/lib/api';
import { apiDeLaSession } from '@/lib/api/connexion-numero';
import { CLE_SUITE, enSuiteDeDemarrage, SUITE_DEMARRER } from '@/lib/demarrer';

/**
 * « CONNECTER WHATSAPP » dans la console (lot 3b, spec `docs/superpowers/specs/2026-10-05-numero-fourni-design.md`).
 * Le parcours lui-même vit dans `ParcoursNumero`, partagé avec `/brancher`, la page qu'ouvre le lien de Claude Code
 * (lot 3c) ; celle-ci y ajoute la coquille, la session et l'état du compte.
 */
export default function ConnecterWhatsappPage() {
  return <AppShell active="accueil">{(session) => <ConnecterWhatsapp session={session} />}</AppShell>;
}

function ConnecterWhatsapp({ session }: { session: Session }) {
  const t = useT();
  const tenantId = session.tenantId;
  const isAdmin = session.role === 'admin';
  const [compte, setCompte] = useState<AccountStatusResponse | null>(null);
  const [avertissements, setAvertissements] = useState<string[]>([]);
  const api = useMemo(() => apiDeLaSession(tenantId), [tenantId]);

  const chargerCompte = useCallback(() => {
    getAccountStatus(tenantId).then(setCompte).catch(() => { /* l'écran reste utilisable sans le statut */ });
  }, [tenantId]);
  useEffect(() => { chargerCompte(); }, [chargerCompte]);

  // Une étape du tunnel de la Base (lot 19) : « Plus tard » tant que rien n'est connecté, « Continuer » ensuite, et les
  // deux mènent à la page finale. La mémoire de l'onglet garde la suite à travers le paiement d'un numéro fourni ; la
  // page finale l'efface.
  const [tunnel, setTunnel] = useState(false);
  useEffect(() => {
    let memoire: string | null = null;
    try { memoire = window.sessionStorage.getItem(CLE_SUITE); } catch { /* mémoire indisponible : l'adresse suffit */ }
    const oui = enSuiteDeDemarrage(window.location.search, memoire);
    if (oui) { try { window.sessionStorage.setItem(CLE_SUITE, SUITE_DEMARRER); } catch { /* idem */ } }
    setTunnel(oui);
  }, []);

  const connecte = compte?.hasNumber === true;
  // Connecté avec un numéro fourni payé : l'abonnement se gère encore d'ici (jaune 1 de la relecture de la livraison B).
  // Résilié (lot 4) : un nouveau paiement rend le MÊME numéro, sans refaire la fenêtre de Meta.
  const [statut, setStatut] = useState<string | null>(null);
  const abonne = statut !== null;
  /** Le numéro connecté est-il le numéro fourni ? Seul ce numéro se réabonne (jaune 2 de la relecture du lot 4, A). */
  const [numeroFourniConnecte, setNumeroFourniConnecte] = useState(false);
  const [reabonnement, setReabonnement] = useState<{ enCours: boolean; erreur: string | null }>({ enCours: false, erreur: null });
  const seReabonner = async () => {
    setReabonnement({ enCours: true, erreur: null });
    try { window.location.assign((await api.payer('console')).url); } catch (err) {
      setReabonnement({ enCours: false, erreur: err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong') });
    }
  };
  useEffect(() => {
    if (!connecte || !isAdmin) return;
    api.etat().then((r) => {
      setStatut(r.etat.abonnement?.statut ?? null);
      const fourni = r.etat.fourni?.replace(/\D/g, '') ?? null;
      const chiffres = r.etat.connecte?.chiffres ?? null;
      setNumeroFourniConnecte(fourni !== null && chiffres !== null && (chiffres === '' || chiffres === fourni));
    }).catch(() => {});
  }, [connecte, isAdmin, api]);
  return (
    <div className="mx-auto max-w-formulaire">
      <TitrePage>{t('Connecter WhatsApp', 'Connect WhatsApp')}</TitrePage>
      <IntroPage>{t('Un numéro WhatsApp pour votre espace : le vôtre, ou un numéro que nous vous fournissons.', 'A WhatsApp number for your workspace: yours, or one we provide.')}</IntroPage>

      {connecte ? (
        <div data-testid="numero-connecte" className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
          <div className="text-lg font-semibold text-ink-900">{t('Votre numéro WhatsApp est connecté', 'Your WhatsApp number is connected')}</div>
          <p className="mt-1 text-sm text-ink-500">{compte?.number ?? ''}</p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {tunnel ? (
              <Link href="/demarrer" className={classesBouton('principal', 'petite')} data-testid="numero-continuer">{t('Continuer', 'Continue')}</Link>
            ) : (
              <Link href="/accueil" className="inline-block text-sm font-semibold text-ink-900 underline">{t('Retour à l’accueil', 'Back to home')}</Link>
            )}
            {statut === 'resilie' && numeroFourniConnecte ? (
              <Bouton type="button" taille="petite" enCours={reabonnement.enCours} disabled={reabonnement.enCours} onClick={() => { void seReabonner(); }} data-testid="se-reabonner">
                {t('Se réabonner (3,50 € HT par mois)', 'Renew (€3.50 excl. VAT per month)')}
              </Bouton>
            ) : abonne && <BoutonPortail api={api} />}
            {reabonnement.erreur && <span className="text-xs text-danger-700">{reabonnement.erreur}</span>}
          </div>
        </div>
      ) : !isAdmin ? (
        <p className="mt-6 text-sm text-ink-500">{t('Réservé aux admins de l’espace.', 'Workspace admins only.')}</p>
      ) : (
        <ParcoursNumero
          tenantId={tenantId}
          api={api}
          choixInitial={null}
          retour="console"
          connecte={connecte}
          surConnexion={(av) => { setAvertissements(av); chargerCompte(); }}
        />
      )}

      {tunnel && !connecte && (
        <Link href="/demarrer" className="mt-6 inline-block text-sm font-semibold text-ink-900 underline" data-testid="numero-plus-tard">
          {t('Plus tard', 'Later')}
        </Link>
      )}

      {avertissements.length > 0 && (
        <p data-testid="avertissements-connexion" className="mt-4 rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte-700">
          {t('À savoir', 'Note')} : {avertissements.join(' · ')}
        </p>
      )}
    </div>
  );
}
