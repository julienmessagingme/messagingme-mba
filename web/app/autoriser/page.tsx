'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { GoogleButton } from '@/components/GoogleButton';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';
import { Squelette } from '@/components/Squelette';
import { ApiError } from '@/lib/http';
import { useT } from '@/lib/i18n';
import { getSession, type Session } from '@/lib/session';
import {
  adresseDeRetourSure, autoriserParGoogle, autoriserParSession, capacitesAnnoncees, continuerAvecGoogle, estDemandeExpiree,
  ouvrirConsentement, type ChoixOauth, type MarqueClient, type Ouverture,
} from '@/lib/oauth';

/** La politique de confidentialité de messagingme.fr, que la page cite avec la phrase sur Anthropic (spec, section 3). */
const POLITIQUE_DE_CONFIDENTIALITE = 'https://www.messagingme.fr/politique-de-confidentialite/';

/**
 * LE CONSENTEMENT D'UN CLIENT MCP (spec `docs/superpowers/specs/2026-10-03-oauth-mcp-design.md`, section 3, et
 * `2026-10-09-oauth-autres-clients-design.md`, § 5). Le client ouvre `/oauth/authorize` sur l'API, qui vérifie la
 * demande, la signe et redirige ici avec `?demande=`. Claude et Claude Code ont un nom vérifié ; un autre client
 * (ChatGPT, Cursor) montre comment son nom est établi, et un avertissement.
 *
 * 🔴 LE CONSENTEMENT N'EST JAMAIS SAUTÉ. La page montre le client, l'hôte de retour et les droits AVANT tout bouton,
 * et aucun code ne s'émet avant un clic, même pour une personne déjà connectée à la console : notre serveur délègue
 * l'identité à Google, et la spécification MCP exige alors cet écran (« confused deputy »).
 *
 * Sans `AppShell` : on y arrive depuis Claude, souvent sans session. Deux façons de prouver qui l'on est, et le
 * serveur relit le rôle au clic dans les deux cas (seul un admin autorise) :
 * - une session de la console, admin : le bouton direct « Autoriser dans <espace> » ;
 * - « Continuer avec Google » : une preuve signée et la liste des espaces de la personne. Une adresse inconnue y
 *   crée son espace, et la page le dit sous le bouton avant le clic.
 *
 * Au clic, l'API rend l'adresse de retour du client, code compris, et la page y navigue.
 */
export default function AutoriserPage() {
  const t = useT();
  const [demande, setDemande] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [ouverture, setOuverture] = useState<Ouverture | null>(null);
  /** Après « Continuer avec Google » : la preuve et les espaces. `null` = pas encore. */
  const [choix, setChoix] = useState<ChoixOauth | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  /** L'autorisation est accordée et la page part vers Claude. */
  const [partie, setPartie] = useState(false);
  /** Relancé par « Réessayer » quand la demande n'a pas pu être lue (panne, réseau). */
  const [essai, setEssai] = useState(0);

  useEffect(() => {
    // Lu ici et pas au rendu : ni l'adresse ni le stockage du navigateur n'existent côté serveur.
    const lue = new URLSearchParams(window.location.search).get('demande');
    const s = getSession();
    setDemande(lue);
    setSession(s);
    let vivant = true;
    void ouvrirConsentement(lue, s).then((o) => { if (vivant) setOuverture(o); });
    return () => { vivant = false; };
  }, [essai]);

  /**
   * Le clic « Autoriser dans <espace> », quelle que soit la preuve. Le serveur relit le rôle : son refus (403)
   * s'affiche tel quel, c'est l'état « refus ».
   */
  async function autoriser(appel: () => Promise<{ adresse: string }>, direct: boolean): Promise<void> {
    if (ouverture?.etat !== 'prete') return;
    setErreur(null);
    setEnCours(true);
    try {
      const { adresse } = await appel();
      if (!adresseDeRetourSure(adresse, ouverture.demande.hoteDeRetour)) {
        setErreur(t(
          'L’adresse de retour ne correspond pas à celle annoncée : la page ne s’y rend pas. Relancez la connexion depuis votre application.',
          'The return address does not match the one shown: this page will not go there. Start the connection again from your application.',
        ));
        return;
      }
      setPartie(true);
      window.location.assign(adresse);
    } catch (err) {
      if (estDemandeExpiree(err)) {
        setOuverture({ etat: 'expiree' });
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        // Direct : la session de la console a expiré, Google reste possible. Google : la preuve a expiré (5 minutes),
        // on repasse par le bouton.
        if (direct) {
          setOuverture({ ...ouverture, espaceDirect: null });
          setErreur(t('Votre session de la console a expiré : continuez avec Google.', 'Your console session has expired: continue with Google.'));
        } else {
          setChoix(null);
          setErreur(err.message);
        }
        return;
      }
      setErreur(err instanceof Error ? err.message : t('Autorisation impossible', 'Authorization failed'));
    } finally {
      setEnCours(false);
    }
  }

  function parGoogle(idToken: string): void {
    if (demande === null) return;
    setErreur(null);
    setEnCours(true);
    continuerAvecGoogle(demande, idToken)
      .then(setChoix)
      .catch((err: unknown) => {
        if (estDemandeExpiree(err)) setOuverture({ etat: 'expiree' });
        else setErreur(err instanceof Error ? err.message : t('Connexion Google impossible', 'Google sign-in failed'));
      })
      .finally(() => setEnCours(false));
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center px-4 py-12">
      <div className="absolute right-4 top-4">
        <LocaleToggle />
      </div>
      <div className="w-full max-w-md" data-testid="autoriser">
        <Logo className="mx-auto mb-6 h-9 w-auto" />
        {ouverture === null ? (
          <Squelette forme="carte" />
        ) : ouverture.etat === 'absente' ? (
          <EtatFinal testId="autoriser-absente" titre={t('Aucune demande à autoriser', 'No request to authorize')}>
            {t(
              'Cette page s’ouvre depuis votre application (Claude, ChatGPT…), au moment où vous connectez votre espace. Relancez la connexion depuis votre application.',
              'This page opens from your application (Claude, ChatGPT…), when you connect your workspace. Start the connection again from your application.',
            )}
          </EtatFinal>
        ) : ouverture.etat === 'expiree' ? (
          <EtatFinal testId="autoriser-expiree" titre={t('Demande expirée', 'Request expired')}>
            {t(
              'Cette demande d’autorisation a expiré : relancez la connexion depuis votre application.',
              'This authorization request has expired: start the connection again from your application.',
            )}
          </EtatFinal>
        ) : ouverture.etat === 'erreur' ? (
          <EtatFinal testId="autoriser-erreur" titre={t('Demande illisible pour le moment', 'Request unreadable for now')}>
            <span className="block">{ouverture.message}</span>
            <Bouton variante="secondaire" className="mt-4" onClick={() => { setOuverture(null); setEssai((n) => n + 1); }}>
              {t('Réessayer', 'Try again')}
            </Bouton>
          </EtatFinal>
        ) : partie ? (
          <EtatFinal testId="autoriser-partie" titre={t('Autorisation accordée', 'Authorization granted')}>
            {t(
              `Retour vers ${ouverture.demande.client}… Vous pouvez fermer cette page si elle reste affichée.`,
              `Returning to ${ouverture.demande.client}… You can close this page if it stays open.`,
            )}
          </EtatFinal>
        ) : (
          <div className="space-y-5">
            <div className="text-center">
              <TitrePage>
                {t(`${ouverture.demande.client} demande l’accès à votre espace`, `${ouverture.demande.client} is asking for access to your workspace`)}
              </TitrePage>
              <p className="mt-1 text-sm text-ink-500">
                {t('Retour après votre accord :', 'Returns after your approval to:')}{' '}
                <span className="font-mono text-ink-900" data-testid="autoriser-hote">{ouverture.demande.hoteDeRetour}</span>
              </p>
            </div>

            <Provenance client={ouverture.demande.client} marque={ouverture.demande.marque ?? 'epingle'} domaine={ouverture.demande.domaine ?? null} />

            <Capacites
              client={ouverture.demande.client}
              droits={ouverture.demande.droits}
              marque={ouverture.demande.marque ?? 'epingle'}
              domaine={ouverture.demande.domaine ?? null}
            />

            {erreur && <p role="alert" className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700" data-testid="autoriser-refus">{erreur}</p>}

            {choix ? (
              <ChoixEspace
                client={ouverture.demande.client}
                choix={choix}
                enCours={enCours}
                onAutoriser={(tenantId) => { void autoriser(() => autoriserParGoogle(demande ?? '', choix.choix, tenantId), false); }}
                onAutreAdresse={() => { setChoix(null); setErreur(null); }}
              />
            ) : (
              <div className="rounded-carte border border-ink-200 bg-white p-6">
                {ouverture.espaceDirect && (
                  <div>
                    <Bouton
                      className="w-full"
                      enCours={enCours}
                      disabled={enCours}
                      data-testid="autoriser-direct"
                      onClick={() => {
                        const direct = ouverture.espaceDirect;
                        if (direct) void autoriser(() => autoriserParSession(direct.tenantId, demande ?? ''), true);
                      }}
                    >
                      {t(`Autoriser dans ${ouverture.espaceDirect.nom}`, `Authorize in ${ouverture.espaceDirect.nom}`)}
                    </Bouton>
                    {session && (
                      <p className="mt-2 text-center text-xs text-ink-500">
                        {t('Connecté à la console :', 'Signed in to the console:')} {session.email}
                      </p>
                    )}
                  </div>
                )}
                <GoogleButton onError={setErreur} surJeton={parGoogle} separateur={ouverture.espaceDirect !== null} />
                <p className="mt-3 text-center text-xs text-ink-500">
                  {t('Pas encore de compte ? Il sera créé avec votre adresse Google.', 'No account yet? It will be created with your Google address.')}
                </p>
                {/* Un compte à mot de passe (et second facteur) passe par sa connexion habituelle : la session de la
                    console donne alors le bouton direct. La demande vit dix minutes, le temps de revenir. */}
                {!ouverture.espaceDirect && (
                  <p className="mt-2 text-center text-xs text-ink-500" data-testid="autoriser-mot-de-passe">
                    {t('Compte avec mot de passe :', 'Password account:')}{' '}
                    <Link href="/login" target="_blank" rel="noopener" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
                      {t('connectez-vous à la console', 'sign in to the console')}
                    </Link>
                    {t(', puis rechargez cette page.', ', then reload this page.')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

/** Une issue sans bouton d'autorisation : demande absente, expirée, illisible, ou autorisation partie. */
function EtatFinal({ titre, testId, children }: { titre: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="rounded-carte border border-ink-200 bg-white p-6 text-center" data-testid={testId}>
      <TitrePage>{titre}</TitrePage>
      <p className="mt-2 text-sm text-ink-500">{children}</p>
    </div>
  );
}

/**
 * D'OÙ VIENT LE NOM DU CLIENT (lot 15, décision de Julien du 2026-10-09). Claude et Claude Code n'ont rien à
 * signaler : leur nom est recopié par nous. Un autre client montre sa marque, « publié par chatgpt.com » (le domaine de
 * sa fiche prouve l'éditeur) ou « non vérifié » (un nom déclaré à l'enregistrement), et un avertissement : un nom
 * déclaré peut imiter n'importe qui, seule la personne sait si elle vient de lancer cette connexion.
 */
function Provenance({ client, marque, domaine }: { client: string; marque: MarqueClient; domaine: string | null }) {
  const t = useT();
  if (marque === 'epingle') return null;
  return (
    <div className="space-y-1 rounded-controle border border-alerte-300 bg-alerte-50 px-3 py-2 text-sm text-alerte-900" data-testid="autoriser-avertissement">
      <p className="font-medium" data-testid="autoriser-marque">
        {marque === 'domaine' && domaine
          ? t(`${client}, publié par ${domaine}`, `${client}, published by ${domaine}`)
          : t(`${client} (non vérifié)`, `${client} (unverified)`)}
      </p>
      <p>
        {t(
          `Vérifiez que vous venez de lancer cette connexion depuis ${client}. Le nom est déclaré par l’application elle-même${marque === 'domaine' ? '' : ', et nous ne l’avons pas vérifié'}.`,
          `Make sure you have just started this connection from ${client}. The name is declared by the application itself${marque === 'domaine' ? '' : ', and we have not verified it'}.`,
        )}
      </p>
    </div>
  );
}

/**
 * Ce que le client pourra lire et faire, droit par droit, et la phrase sur son éditeur : Anthropic pour Claude, l'éditeur
 * de l'application pour un autre client (lot 15). Les listes suivent les outils du
 * serveur MCP (`lib/mcp-outils.ts`) : lire les conversations, les contacts, les widgets, les scénarios, les membres, les
 * agents IA, leur connaissance et le crédit IA ; répondre dans la fenêtre de 24 h, poser des étiquettes, confier une
 * conversation, créer et modifier des widgets, construire, essayer et activer des agents IA, ouvrir une recharge.
 * 🔴 Le consentement dit l'argent (lot 8a) : un essai d'agent est débité du crédit, et une recharge ouvre un paiement.
 */
function Capacites({ client, droits, marque, domaine }: { client: string; droits: string[]; marque: MarqueClient; domaine: string | null }) {
  const t = useT();
  const { lire, faire } = capacitesAnnoncees(droits);
  return (
    <div className="space-y-3 rounded-carte border border-ink-200 bg-white p-6 text-sm text-ink-900" data-testid="autoriser-droits">
      {lire && (
        <p>
          <span className="font-medium">{t(`${client} pourra lire`, `${client} will be able to read`)}</span>{' '}
          {t(
            'vos conversations, vos contacts, vos widgets WhatsApp, vos scénarios, les membres de votre équipe, vos agents IA et leur connaissance, et le solde du crédit IA.',
            'your conversations, contacts, WhatsApp widgets, scenarios, team members, AI agents and their knowledge, and the AI credit balance.',
          )}
        </p>
      )}
      {faire && (
        <p>
          <span className="font-medium">{t(`${client} pourra`, `${client} will be able to`)}</span>{' '}
          {t(
            'répondre dans une conversation ouverte (fenêtre de 24 h), poser des étiquettes, confier une conversation à un membre, créer et modifier vos widgets WhatsApp, créer, régler, essayer et activer vos agents IA (chaque essai est débité du crédit IA), ajouter, importer ou supprimer leur connaissance, et ouvrir le paiement d’une recharge, que vous réglez vous-même.',
            'reply in an open conversation (24 h window), add tags, assign a conversation to a member, create and edit your WhatsApp widgets, create, configure, try and activate your AI agents (each try is charged to the AI credit), and open a top-up payment, which you complete yourself.',
          )}
        </p>
      )}
      <p className="text-xs text-ink-500">
        {marque === 'epingle'
          ? t(
            'Ces données seront lues par Claude et traitées par Anthropic, qui édite Claude.',
            'This data will be read by Claude and processed by Anthropic, the company behind Claude.',
          )
          : t(
            `Ces données seront lues par ${client} et traitées par son éditeur${domaine ? ` (${domaine})` : ''}.`,
            `This data will be read by ${client} and processed by its publisher${domaine ? ` (${domaine})` : ''}.`,
          )}{' '}
        <a href={POLITIQUE_DE_CONFIDENTIALITE} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
          {t('Notre politique de confidentialité', 'Our privacy policy')}
        </a>
      </p>
    </div>
  );
}

/**
 * Après Google : un bouton par espace où la personne est admin, les autres affichés sans bouton. Le rôle montré ici
 * vient de la réponse du serveur ; il le relit encore au clic.
 */
function ChoixEspace({ client, choix, enCours, onAutoriser, onAutreAdresse }: {
  client: string;
  choix: ChoixOauth;
  enCours: boolean;
  onAutoriser: (tenantId: string) => void;
  onAutreAdresse: () => void;
}) {
  const t = useT();
  const aucunAdmin = choix.espaces.every((e) => !e.admin);
  return (
    <div className="space-y-3 rounded-carte border border-ink-200 bg-white p-6" data-testid="autoriser-espaces">
      {choix.nouveau && (
        <p className="rounded-controle bg-succes-50 px-3 py-2 text-sm text-succes-800" data-testid="autoriser-nouvel-espace">
          {t('Votre espace vient d’être créé, et vous en êtes l’administrateur.', 'Your workspace has just been created, and you are its administrator.')}
        </p>
      )}
      <p className="text-sm text-ink-900">
        {aucunAdmin
          ? t(`Seul un administrateur d’un espace peut y connecter ${client}.`, `Only a workspace administrator can connect ${client} to it.`)
          : t(`Choisissez l’espace où ${client} travaillera.`, `Choose the workspace ${client} will work in.`)}
      </p>
      <ul className="space-y-2">
        {choix.espaces.map((e) => (
          <li key={e.tenantId}>
            {e.admin ? (
              <Bouton className="w-full" enCours={enCours} disabled={enCours} data-testid={`autoriser-espace-${e.tenantId}`} onClick={() => onAutoriser(e.tenantId)}>
                {t(`Autoriser dans ${e.nom}`, `Authorize in ${e.nom}`)}
              </Bouton>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-carte border border-ink-200 px-4 py-3" data-testid={`espace-non-admin-${e.tenantId}`}>
                <span className="text-sm font-medium text-ink-900">{e.nom}</span>
                <span className="text-xs text-ink-500">{t('demandez à un administrateur', 'ask an administrator')}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onAutreAdresse} className="text-xs text-ink-500 underline hover:text-ink-900">
        {t('Utiliser une autre adresse Google', 'Use another Google address')}
      </button>
    </div>
  );
}
