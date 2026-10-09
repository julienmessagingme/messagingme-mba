'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  creerAdresseEvenements, essaiAdresseEvenements, journalAdresseEvenements, listerAdressesEvenements, modifierAdresseEvenements,
  rejouerEchecsEvenements, rejouerEnvoiEvenements, supprimerAdresseEvenements, tournerSecretEvenements,
  type AdresseEvenements, type EnvoiEvenements, type ListeAdressesEvenements,
} from '@/lib/api/evenements';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';

/**
 * DÉVELOPPEURS > WEBHOOKS SORTANTS (lot 12, livraison A, spec `docs/superpowers/specs/2026-10-08-webhooks-sortants-design.md`) :
 * les adresses de l'application du client, les événements qu'elles reçoivent, leur secret, leur journal.
 *
 * Le secret n'existe en clair QUE dans la réponse de création ou de rotation : la modale l'affiche avant tout
 * rechargement, et la liste ne le rend jamais. Réservé aux admins (le serveur refuse les autres, lecture comprise).
 */
export default function WebhooksSortantsPage() {
  return <AppShell active="webhooks-sortants">{(session) => <WebhooksSortants session={session} />}</AppShell>;
}

function useLibelles() {
  const t = useT();
  return {
    'message.received': t('Message reçu', 'Message received'),
    'message.delivered': t('Message livré', 'Message delivered'),
    'message.read': t('Message lu', 'Message read'),
    'message.failed': t('Message en échec', 'Message failed'),
    'link.clicked': t('Lien cliqué', 'Link clicked'),
    'contact.opted_out': t('Désabonnement', 'Opt-out'),
    'conversation.analyzed': t('Conversation analysée', 'Conversation analyzed'),
    'contact.risk_changed': t('Risque de désengagement', 'Disengagement risk'),
    'template.status_changed': t('Validation d’un modèle', 'Template review'),
    test: t('Essai', 'Test'),
  } as Record<string, string>;
}

function WebhooksSortants({ session }: { session: Session }) {
  const t = useT();
  const confirmer = useConfirmation();
  const libelles = useLibelles();
  const [liste, setListe] = useState<ListeAdressesEvenements | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [occupe, setOccupe] = useState(false);
  // Le secret en clair : seulement ici, le temps de la modale.
  const [secret, setSecret] = useState<{ titre: string; valeur: string } | null>(null);
  const [ouvert, setOuvert] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const l = await listerAdressesEvenements(session.tenantId);
      setListe(l);
      setTypes((avant) => (avant.size === 0 ? new Set(l.typesParDefaut) : avant));
    } catch (err) {
      setErreur(erreurDeChargement(err, t));
    }
  }, [session.tenantId, t]);
  useEffect(() => { void charger(); }, [charger]);

  const actives = liste?.adresses.filter((a) => a.active).length ?? 0;
  const plafond = liste !== null && liste.limite !== null && actives >= liste.limite;

  async function creer() {
    setOccupe(true);
    setErreur(null);
    try {
      const r = await creerAdresseEvenements(session.tenantId, { url: url.trim(), description: description.trim(), types: [...types] });
      // La modale D'ABORD : c'est le seul instant où le secret existe en clair.
      setSecret({ titre: t('Adresse créée', 'Address created'), valeur: r.secret });
      setUrl('');
      setDescription('');
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Création impossible', 'Creation failed'));
    } finally {
      setOccupe(false);
    }
  }

  async function agir(geste: () => Promise<unknown>) {
    setErreur(null);
    try {
      await geste();
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Une erreur est survenue', 'Something went wrong'));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <TitrePage>{t('Webhooks sortants', 'Outgoing webhooks')}</TitrePage>
        <IntroPage>
          {t(
            'Votre application reçoit en direct ce qui se passe sur WhatsApp : chaque événement part en POST vers votre adresse, signé (Standard Webhooks), et il est renvoyé pendant 24 h tant qu’elle ne répond pas 2xx.',
            'Your app receives what happens on WhatsApp as it happens: each event is POSTed to your address, signed (Standard Webhooks), and retried for 24 h until it answers 2xx.',
          )}{' '}
          <Link href="/developers/api/webhooks" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
            {t('Format et vérification de la signature', 'Format and signature verification')}
          </Link>
        </IntroPage>
      </div>

      {erreur && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="evt-erreur">{erreur}</p>}

      <div className="rounded-carte border border-ink-200 bg-white p-5">
        <div className="mb-3 text-sm font-medium text-ink-900">{t('Nouvelle adresse', 'New address')}</div>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.exemple.fr/webhooks/messagingme" className={inputCls} data-testid="evt-url" />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('Description (facultative)', 'Description (optional)')} className={`${inputCls} mt-2`} maxLength={200} />
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {(liste?.types ?? []).map((ty) => (
            <label key={ty} className="flex items-center gap-2 text-sm text-ink-900">
              <input
                type="checkbox" checked={types.has(ty)} className="h-4 w-4 rounded-controle border-ink-300" data-testid={`evt-type-${ty}`}
                onChange={() => setTypes((avant) => { const s = new Set(avant); if (s.has(ty)) s.delete(ty); else s.add(ty); return s; })}
              />
              <span>{libelles[ty] ?? ty}</span>
              <span className="font-mono text-xs text-ink-500">{ty}</span>
            </label>
          ))}
        </div>
        <Bouton enCours={occupe} className="mt-3" data-testid="evt-creer"
          disabled={occupe || plafond || !url.trim().startsWith('https://') || types.size === 0 || liste?.chiffrementPret === false}
          onClick={() => { void creer(); }}
        >
          {t('Créer l’adresse', 'Create address')}
        </Bouton>
        {plafond && (
          <p className="mt-2 text-sm text-ink-500" data-testid="evt-limite">
            {t(
              `Votre offre permet ${liste!.limite} adresse${liste!.limite! > 1 ? 's' : ''} active${liste!.limite! > 1 ? 's' : ''} : mettez-en une en pause, ou `,
              `Your plan allows ${liste!.limite} active address${liste!.limite! > 1 ? 'es' : ''}: pause one, or `,
            )}
            <Link href="/offre" className="font-medium text-brand-600 underline underline-offset-2">{t('passez en Pro', 'upgrade to Pro')}</Link>.
          </p>
        )}
      </div>

      {liste === null ? (
        <Squelette forme="lignes" className="px-5 py-6" />
      ) : liste.adresses.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucune adresse : créez-en une ci-dessus.', 'No address yet: create one above.')}</p>
      ) : (
        <div className="space-y-4">
          {liste.adresses.map((a) => (
            <CarteAdresse
              key={a.id} adresse={a} tenantId={session.tenantId} ouvert={ouvert === a.id} libelles={libelles}
              basculer={() => setOuvert((o) => (o === a.id ? null : a.id))}
              agir={agir}
              montrerSecret={(valeur) => setSecret({ titre: t('Nouveau secret', 'New secret'), valeur })}
              confirmer={confirmer}
            />
          ))}
        </div>
      )}

      {secret && (
        <Modale titre={secret.titre} fermeture="boutons" onClose={() => setSecret(null)}>
          <p className="mt-1 text-sm text-ink-500">
            {t(
              'Le secret de signature, montré une seule fois : rangez-le dans une variable d’environnement de votre application (jamais dans le code) pour vérifier l’en-tête webhook-signature.',
              'The signing secret, shown only once: store it in an environment variable of your app (never in the code) to verify the webhook-signature header.',
            )}
          </p>
          <pre className="mt-3 overflow-x-auto rounded-controle bg-ink-50 px-3 py-2 font-mono text-xs text-ink-900" data-testid="evt-secret">{secret.valeur}</pre>
          <div className="mt-4 flex justify-end gap-2">
            <Bouton variante="secondaire" onClick={() => { void navigator.clipboard?.writeText(secret.valeur); }}>{t('Copier', 'Copy')}</Bouton>
            <Bouton onClick={() => setSecret(null)}>{t('J’ai copié le secret', 'I copied the secret')}</Bouton>
          </div>
        </Modale>
      )}
    </div>
  );
}

function CarteAdresse({ adresse: a, tenantId, ouvert, libelles, basculer, agir, montrerSecret, confirmer }: {
  adresse: AdresseEvenements;
  tenantId: string;
  ouvert: boolean;
  libelles: Record<string, string>;
  basculer: () => void;
  agir: (geste: () => Promise<unknown>) => Promise<void>;
  montrerSecret: (valeur: string) => void;
  confirmer: ReturnType<typeof useConfirmation>;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [essai, setEssai] = useState<{ livre: boolean; code: number | null; reponse: string } | null>(null);
  const [essaiEnCours, setEssaiEnCours] = useState(false);
  const fmt = (iso: string) => `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}`;

  async function essayer() {
    setEssaiEnCours(true);
    setEssai(null);
    await agir(async () => setEssai(await essaiAdresseEvenements(tenantId, a.id)));
    setEssaiEnCours(false);
  }

  async function tourner() {
    const ok = await confirmer({
      titre: t('Renouveler le secret', 'Rotate the secret'),
      message: t(
        'Un nouveau secret est créé. L’ancien signe encore pendant 24 h, le temps de mettre à jour votre application.',
        'A new secret is created. The old one keeps signing for 24 h, while you update your app.',
      ),
      confirmer: t('Renouveler', 'Rotate'),
    });
    if (!ok) return;
    await agir(async () => montrerSecret((await tournerSecretEvenements(tenantId, a.id)).secret));
  }

  async function supprimer() {
    const ok = await confirmer({
      titre: t('Supprimer l’adresse', 'Delete the address'),
      message: t('L’adresse et son journal sont supprimés, et les envois en attente ne partiront pas.', 'The address and its log are deleted, and pending deliveries will not be sent.'),
      confirmer: t('Supprimer', 'Delete'),
    });
    if (ok) await agir(() => supprimerAdresseEvenements(tenantId, a.id));
  }

  return (
    <div className="rounded-carte border border-ink-200 bg-white" data-testid="evt-adresse">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <div className="break-all font-mono text-sm text-ink-900">{a.url}</div>
          {a.description && <div className="text-sm text-ink-500">{a.description}</div>}
          <div className="mt-1 text-xs text-ink-500">
            {a.active ? t('Active', 'Active') : <span className="font-medium text-alerte-700">{t('En pause', 'Paused')}</span>}
            {' · '}{a.types.map((ty) => libelles[ty] ?? ty).join(', ')}
          </div>
          <div className="mt-1 text-xs text-ink-500">
            {a.derniereLivraisonLe ? `${t('Dernière livraison', 'Last delivery')} : ${fmt(a.derniereLivraisonLe)}` : t('Aucune livraison', 'No delivery yet')}
            {a.enReessai > 0 && <span className="text-alerte-700"> · {a.enReessai} {t('en cours de réessai', 'being retried')}</span>}
            {a.echecs > 0 && <span className="text-danger-700"> · {a.echecs} {t('en échec', 'failed')}</span>}
            {a.ancienSecretJusqua && <span> · {t('ancien secret valide jusqu’au', 'old secret valid until')} {fmt(a.ancienSecretJusqua)}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Bouton variante="secondaire" taille="petite" enCours={essaiEnCours} data-testid="evt-essai" onClick={() => { void essayer(); }}>
            {t('Envoyer un essai', 'Send a test')}
          </Bouton>
          <Bouton variante="secondaire" taille="petite" onClick={() => { void agir(() => modifierAdresseEvenements(tenantId, a.id, { active: !a.active })); }}>
            {a.active ? t('Mettre en pause', 'Pause') : t('Réactiver', 'Resume')}
          </Bouton>
          <Bouton variante="secondaire" taille="petite" onClick={() => { void tourner(); }}>{t('Renouveler le secret', 'Rotate secret')}</Bouton>
          <Bouton variante="secondaire" taille="petite" data-testid="evt-journal" onClick={basculer}>{ouvert ? t('Masquer le journal', 'Hide log') : t('Journal', 'Log')}</Bouton>
          <Bouton variante="discret" taille="petite" onClick={() => { void supprimer(); }}>{t('Supprimer', 'Delete')}</Bouton>
        </div>
      </div>
      {essai && (
        <p className={`border-t border-ink-100 px-5 py-2 text-sm ${essai.livre ? 'text-succes-700' : 'text-danger-700'}`} data-testid="evt-essai-issue">
          {essai.livre
            ? t(`Essai livré (HTTP ${essai.code}).`, `Test delivered (HTTP ${essai.code}).`)
            : t(`Essai refusé${essai.code !== null ? ` (HTTP ${essai.code})` : ''} : ${essai.reponse || 'sans réponse'}`, `Test refused${essai.code !== null ? ` (HTTP ${essai.code})` : ''}: ${essai.reponse || 'no answer'}`)}
        </p>
      )}
      {ouvert && <Journal tenantId={tenantId} adresseId={a.id} libelles={libelles} agir={agir} />}
    </div>
  );
}

function Journal({ tenantId, adresseId, libelles, agir }: {
  tenantId: string; adresseId: string; libelles: Record<string, string>; agir: (geste: () => Promise<unknown>) => Promise<void>;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [envois, setEnvois] = useState<EnvoiEvenements[] | null>(null);
  const [deplie, setDeplie] = useState<string | null>(null);
  const [depuis, setDepuis] = useState('');
  const [rejoues, setRejoues] = useState<number | null>(null);
  const fmt = (iso: string) => `${formatDate(iso, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} ${hourMin(iso, locale)}`;

  const [erreurJournal, setErreurJournal] = useState<string | null>(null);
  // 🔴 Le journal se charge LUI-MÊME, sur des dépendances stables. Passé par `agir` (recréé à chaque rendu du parent,
  // qui recharge la liste), l'effet se relançait sans fin : cent lectures en une seconde et demie, puis 429 sur toute
  // la console de l'admin (relecture du lot 12, tenu par `e2e/webhooks-sortants.spec.ts`).
  const charger = useCallback(async () => {
    try {
      setEnvois((await journalAdresseEvenements(tenantId, adresseId)).envois);
    } catch (err) {
      setErreurJournal(erreurDeChargement(err, t));
    }
  }, [tenantId, adresseId, t]);
  useEffect(() => { void charger(); }, [charger]);

  const STATUT: Record<EnvoiEvenements['statut'], string> = {
    en_cours: t('en cours', 'pending'), livre: t('livré', 'delivered'), echec: t('en échec', 'failed'),
  };

  return (
    <div className="border-t border-ink-100 px-5 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-500">{t('Rejouer les échecs depuis', 'Replay failures since')}</span>
        <input type="datetime-local" value={depuis} onChange={(e) => setDepuis(e.target.value)} className={`${inputCls} w-auto`} />
        <Bouton variante="secondaire" taille="petite" disabled={depuis === ''}
          onClick={() => { void agir(async () => { setRejoues((await rejouerEchecsEvenements(tenantId, adresseId, new Date(depuis).toISOString())).rejoues); await charger(); }); }}
        >
          {t('Rejouer', 'Replay')}
        </Bouton>
        {rejoues !== null && <span className="text-ink-500">{rejoues} {t('envoi(s) relancé(s)', 'delivery(ies) restarted')}</span>}
      </div>
      {erreurJournal ? (
        <p className="text-sm text-danger-700">{erreurJournal}</p>
      ) : envois === null ? (
        <Squelette forme="lignes" />
      ) : envois.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucun envoi pour l’instant.', 'No delivery yet.')}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-100 text-xs text-ink-500">
            <tr>
              <th className="py-2 pr-3 font-medium">{t('Date', 'Date')}</th>
              <th className="py-2 pr-3 font-medium">{t('Événement', 'Event')}</th>
              <th className="py-2 pr-3 font-medium">{t('Statut', 'Status')}</th>
              <th className="py-2 pr-3 font-medium">{t('Tentatives', 'Attempts')}</th>
              <th className="py-2 pr-3 font-medium">HTTP</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {envois.map((e) => (
              <FragmentEnvoi key={e.id}>
                <tr className="cursor-pointer border-b border-ink-50" data-testid="evt-envoi" onClick={() => setDeplie((d) => (d === e.id ? null : e.id))}>
                  <td className="py-2 pr-3 text-ink-500">{fmt(e.creeLe)}</td>
                  <td className="py-2 pr-3 text-ink-900">{libelles[e.type] ?? e.type}</td>
                  <td className={`py-2 pr-3 ${e.statut === 'echec' ? 'text-danger-700' : e.statut === 'livre' ? 'text-ink-900' : 'text-alerte-700'}`}>
                    {STATUT[e.statut]}{e.statut === 'en_cours' && e.prochainEssaiLe ? ` (${t('prochain essai', 'next attempt')} ${hourMin(e.prochainEssaiLe, locale)})` : ''}
                  </td>
                  <td className="py-2 pr-3 text-ink-500">{e.tentatives}</td>
                  <td className="py-2 pr-3 text-ink-500">{e.dernierCode ?? '-'}</td>
                  <td className="py-2 text-right">
                    {(e.statut !== 'en_cours' || orphelin(e)) && e.type !== 'test' && (
                      <button className="text-xs text-brand-600 hover:underline" onClick={(ev) => { ev.stopPropagation(); void agir(async () => { await rejouerEnvoiEvenements(tenantId, e.id); await charger(); }); }}>
                        {t('Rejouer', 'Replay')}
                      </button>
                    )}
                  </td>
                </tr>
                {deplie === e.id && (
                  <tr className="border-b border-ink-50">
                    <td colSpan={6} className="py-2">
                      <div className="text-xs text-ink-500">{t('Envoyé', 'Sent')}</div>
                      <pre className="mt-1 max-h-64 overflow-auto rounded-controle bg-ink-50 px-3 py-2 font-mono text-xs text-ink-900">{lisible(e.corps)}</pre>
                      {e.derniereReponse && (
                        <>
                          <div className="mt-2 text-xs text-ink-500">{t('Dernière réponse', 'Last response')}</div>
                          <pre className="mt-1 max-h-40 overflow-auto rounded-controle bg-ink-50 px-3 py-2 font-mono text-xs text-ink-900">{e.derniereReponse}</pre>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </FragmentEnvoi>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FragmentEnvoi({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * Un envoi « en cours » dont l'essai a plus de 15 minutes de retard : son job s'est perdu, il se rejoue. Même règle
 * que le serveur (`ORPHELIN_SQL`, `src/evenements/store.pg.ts`).
 */
function orphelin(e: EnvoiEvenements): boolean {
  return e.statut === 'en_cours' && Date.parse(e.prochainEssaiLe ?? e.creeLe) < Date.now() - 15 * 60_000;
}

/** Le corps envoyé, indenté pour la lecture ; tel quel s'il n'est pas du JSON. */
function lisible(corps: string): string {
  try {
    return JSON.stringify(JSON.parse(corps), null, 2);
  } catch {
    return corps;
  }
}
