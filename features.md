# features.md — fonctionnel

Statut : 🔲 pas commencé · 🚧 en cours · ✅ live

## Les 2 parcours North Star

- 🔲 **Ton site → ton agent** (cible < 15 min) : connexion du numéro → l'agent MBA crawle le
  site + FAQ + persona → test → activation avec garde-fous.
- 🔲 **Ton fichier → ta campagne** (cible < 30 min) : import CSV opt-in → choix d'un template →
  envoi (MM Lite marketing / Cloud API utility) → réponses absorbées par l'agent.

## Briques

- 🔲 **Onboarding guidé** : connexion du numéro (embedded signup), + option « on te fournit le
  numéro » (pool). Les étapes Meta qui font abandonner, prises en charge.
- 🔲 **Contacts / opt-in** : import CSV, preuve d'opt-in, STOP/opt-out, tags. Identité
  E.164 OU BSUID.
- 🔲 **Templates** : création, soumission, suivi d'approbation, gestion des rejets.
- 🔲 **Agent MBA** : knowledge auto (site/FAQ/fichiers), persona, on/off, audience.
- 🔲 **Campagnes** : envoi MM Lite / Cloud API, garde-fous par défaut (pacing, fréquence,
  coupure sur quality rating).
- 🔲 **Inbox minimal + rôles** : conversations en handoff, réponse humaine, bouton « rendre la
  main à l'agent ». 2 rôles : admin / agent. Bornes strictes (pas d'assignation auto, pas de
  queues, pas de CRM).
- 🔲 **Rapport mensuel auto** : score agent (agent-eval) + stats campagnes.
- 🚧 **Webhook receiver** : ingestion, statuts, handovers, BSUID-native. (Loop 1)

## Hors périmètre (discipline anti-tailor-made)

Pas de flow builder, pas de connecteurs MBA custom en V1, pas de multicanal, pas de segments
avancés, pas d'A/B testing. Voir le cadrage pour la liste complète.
