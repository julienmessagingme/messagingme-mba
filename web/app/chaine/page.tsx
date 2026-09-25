'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { ChaineConnexion } from '@/components/ChaineConnexion';
import { ChaineComposeur } from '@/components/ChaineComposeur';
import { ChaineApercu } from '@/components/ChaineApercu';
import { ChainePublications } from '@/components/ChainePublications';
import type { Session } from '@/lib/session';
import { listWorkflows, type WorkflowSummary } from '@/lib/api';
import { estAnnulation } from '@/lib/http';
import { useT, useLocale } from '@/lib/i18n';
import { kickerCls } from '@/lib/ui';
import { texteAvertissement } from '@/lib/chaine-statut';
import type { BrouillonChaine } from '@/lib/chaine-apercu';
import {
  allumerLienChaine, creerLienChaine, demanderActivationChaine, enregistrerConnexionChaine,
  getConnexionChaine, listerConversationsChaine, listerLiensChaine, listerPostsChaine, nomDeLaChaine, publierPostChaine,
  testerConnexionChaine,
  type AvertissementPost, type ConversationsDunLien, type EtatDistant, type LienChaine, type PostChaine,
  type ReponseConnexionChaine,
} from '@/lib/api-chaine';
import { IntroPage, TitrePage } from '@/components/TitrePage';

/**
 * Chaîne : publier à toute une audience un message dont le bouton démarre une conversation.
 *
 * L'écran marie deux choses que la console tenait séparées : la diffusion un-vers-tous (gratuite, vers des
 * abonnés anonymes) et le conversationnel (nos scénarios). Le lien `wa.me` posé dans le post est la
 * charnière : WhatsApp en dessine un bouton, l'abonné qui appuie envoie LA PHRASE du lien, et l'automation
 * compagnon de ce lien, dont c'est le mot-clé, démarre le scénario. (Le texte portait aussi un jeton
 * jusqu'au 2026-09-07 ; il allongeait l'URL pour rien.)
 *
 * 🔴 TOUT CE QUI EST IRRÉVERSIBLE EST À DROITE DE L'ÉCRAN, derrière un aperçu. Un post publié circule pour
 * toujours : il n'y a ni modification ni suppression, seulement l'extinction du lien, qui laisse le post en
 * place avec un bouton devenu muet.
 */
export default function ChainePage() {
  return <AppShell active="chaine">{(session) => <ChaineInner session={session} />}</AppShell>;
}

const BROUILLON_VIDE: BrouillonChaine = { texte: '', imageUrl: '', linkId: '' };

function ChaineInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const [connexion, setConnexion] = useState<ReponseConnexionChaine | null>(null);
  const [liens, setLiens] = useState<LienChaine[]>([]);
  const [phone, setPhone] = useState<string | null>(null);
  const [posts, setPosts] = useState<PostChaine[]>([]);
  const [distant, setDistant] = useState<EtatDistant>('ok');
  const [scenarios, setScenarios] = useState<WorkflowSummary[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [brouillon, setBrouillon] = useState<BrouillonChaine>(BROUILLON_VIDE);
  const [busy, setBusy] = useState(false);
  const [rallumage, setRallumage] = useState<string | null>(null);
  const [avertissements, setAvertissements] = useState<AvertissementPost[]>([]);
  const [succes, setSucces] = useState(false);
  const [conversations, setConversations] = useState<{ parLien: ConversationsDunLien[]; partiel: boolean } | null>(null);

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      const c = await getConnexionChaine(session.tenantId);
      setConnexion(c);
      // Rien d'autre à charger tant qu'aucune chaîne n'est branchée : les trois appels suivants ne
      // rendraient que du vide, et le premier coûterait un aller-retour au fournisseur pour rien.
      if (c.connection === null) return;
      const [l, p, w, conv] = await Promise.all([
        listerLiensChaine(session.tenantId),
        listerPostsChaine(session.tenantId),
        listWorkflows(session.tenantId),
        // ⚠️ CETTE MESURE NE PEUT PAS FAIRE TOMBER L'ÉCRAN. Elle relit des messages : c'est le seul des
        // quatre appels dont l'échec ne prive de rien d'essentiel. Elle rend `null`, et la liste affiche
        // alors les publications SANS compteur, plutôt qu'un zéro qui se lirait « ce bouton n'a rien fait ».
        listerConversationsChaine(session.tenantId).catch(() => null),
      ]);
      // Lecture défensive au bord du réseau : une 200 sans le champ attendu poserait `undefined` dans un
      // état typé tableau, et le premier `.map` démonterait la page entière.
      setLiens(Array.isArray(l?.links) ? l.links : []);
      setPhone(l?.phone ?? null);
      setPosts(Array.isArray(p?.posts) ? p.posts : []);
      setDistant(p?.distant ?? 'ok');
      setScenarios(Array.isArray(w?.workflows) ? w.workflows : []);
      setConversations(Array.isArray(conv?.parLien) ? { parLien: conv.parLien, partiel: conv.partiel === true } : null);
    } catch (err) {
      // Quitter l'écran annule ses requêtes : ce n'est pas une panne, et l'afficher en rouge serait un
      // bandeau d'erreur à chaque navigation.
      if (estAnnulation(err)) return;
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    }
  }, [session.tenantId, t]);

  useEffect(() => { void charger(); }, [charger]);

  const lienChoisi = liens.find((l) => l.id === brouillon.linkId) ?? null;

  async function publier() {
    setBusy(true);
    setErreur(null);
    setAvertissements([]);
    setSucces(false);
    try {
      const r = await publierPostChaine(session.tenantId, {
        text: brouillon.texte.trim(),
        ...(brouillon.imageUrl.trim() !== '' ? { mediaUrl: brouillon.imageUrl.trim() } : {}),
        ...(brouillon.linkId !== '' ? { linkId: brouillon.linkId } : {}),
      });
      // 🔴 Un 201 avec avertissements reste un SUCCÈS : le post est parti. On vide le brouillon dans tous les
      // cas, précisément pour qu'un second appui ne renvoie pas le même message à toute l'audience.
      setBrouillon(BROUILLON_VIDE);
      setSucces(true);
      setAvertissements(r.avertissements ?? []);
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Publication impossible', 'Publish failed'));
    } finally {
      setBusy(false);
    }
  }

  async function rallumer(linkId: string) {
    setRallumage(linkId);
    setErreur(null);
    try {
      await allumerLienChaine(session.tenantId, linkId);
      // L'avertissement disparaît une fois le lien rallumé : le laisser ferait douter que la réparation ait
      // pris, et le rechargement montre l'état réel.
      setAvertissements((a) => a.filter((x) => x !== 'automation_non_allumee'));
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Allumage impossible', 'Could not turn on'));
    } finally {
      setRallumage(null);
    }
  }

  const branchee = connexion !== null && connexion.connection !== null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <p className={kickerCls}>{t('Diffusion', 'Broadcast')}</p>
        <TitrePage className="mt-1">{t('Chaîne', 'Channel')}</TitrePage>
        <IntroPage>
          {t(
            'Publie à tous tes abonnés, gratuitement, et laisse ceux qui veulent parler ouvrir une conversation d’un geste.',
            'Post to all your subscribers, for free, and let those who want to talk open a conversation in one tap.',
          )}
        </IntroPage>
      </header>

      <ChaineConnexion
        etat={connexion}
        erreur={erreur !== null && connexion === null ? erreur : null}
        nbLiens={branchee ? liens.length : null}
        onEnregistrer={async (c) => {
          await enregistrerConnexionChaine(session.tenantId, c);
          await charger();
        }}
        onTester={async () => {
          await testerConnexionChaine(session.tenantId);
          await charger();
        }}
        onDemanderActivation={async (message) => {
          await demanderActivationChaine(session.tenantId, message);
        }}
      />

      {branchee ? (
        <>
          {succes ? (
            <div className="mt-6 rounded-xl bg-succes-50 px-4 py-3" data-testid="chaine-publie">
              <p className="text-sm font-medium text-succes-600">
                {t('Publication envoyée à la chaîne.', 'Post sent to the channel.')}
              </p>
              {/* 🔴 Ces avertissements n'étaient lus par AUCUN écran : un bouton mort ne se voyait que dans
                  les journaux du serveur. Ils arrivent AVEC un succès, jamais avec une erreur. */}
              {avertissements.map((a) => {
                const { texte, reparable } = texteAvertissement(a, locale);
                return (
                  <p
                    key={a}
                    className={`mt-1 text-sm ${reparable ? 'text-danger' : 'text-ink-500'}`}
                    data-testid={`chaine-avertissement-${a}`}
                  >
                    {texte}
                  </p>
                );
              })}
            </div>
          ) : null}

          {erreur !== null && connexion !== null ? (
            <p className="mt-6 rounded-xl bg-danger-50 px-4 py-3 text-sm text-danger" data-testid="chaine-erreur">
              {erreur}
            </p>
          ) : null}

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-ink-200 bg-white p-5">
              <h2 className="mb-4 text-base font-semibold text-ink-900">
                {t('Nouvelle publication', 'New post')}
              </h2>
              <ChaineComposeur
                brouillon={brouillon}
                onChange={setBrouillon}
                liens={liens}
                scenarios={scenarios}
                phone={phone}
                busy={busy}
                onCreerLien={async (input) => {
                  const { link } = await creerLienChaine(session.tenantId, input);
                  // Le lien tout juste créé devient celui du brouillon : c'est ce qu'on venait faire.
                  setLiens((l) => [link, ...l]);
                  setBrouillon((b) => ({ ...b, linkId: link.id }));
                }}
                onPublier={publier}
                tenantId={session.tenantId}
              />
            </div>

            <ChaineApercu
              texte={brouillon.texte}
              imageUrl={brouillon.imageUrl}
              waMeUrl={lienChoisi?.waMeUrl ?? null}
              nomChaine={nomDeLaChaine(connexion)}
            />
          </div>

          <div className="mt-6">
            <ChainePublications
              posts={posts}
              liens={liens}
              scenarios={scenarios}
              conversations={conversations}
              distant={distant}
              erreur={null}
              rallumage={rallumage}
              onRallumer={rallumer}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
