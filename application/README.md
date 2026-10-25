# Journal collaboratif

Application de rédaction et de publication de documents partagés, avec espaces dédiés au rédacteur, au visiteur et à l’administrateur.

## Démarrage local

Prérequis : Node.js 22+, npm 10+ et Docker Compose. Dans `.env`, remplacez `ADMIN_EMAILS` par l’adresse administrateur et définissez un mot de passe secret d’au moins 12 caractères dans `ADMIN_BOOTSTRAP_PASSWORD`. L’API crée ce compte au démarrage; les inscriptions publiques ne peuvent pas attribuer le rôle administrateur.

```sh
cp .env.example .env
# Modifier ADMIN_EMAILS dans .env
npm install
docker compose up --build -d
npm run dev:web
```

Ouvrir `http://localhost:5173`. L’API écoute sur `http://localhost:3000`. Créez un compte rédacteur ou connectez-vous. L’administrateur configuré se connecte avec les identifiants de `.env`, puis ouvre `/admin`. Un visiteur utilise le lien public `/share/<jeton>`.

PostgreSQL et le worker PDF démarrent dans Compose. En développement, les PDF sont enregistrés dans un volume local. Pour S3, renseignez `AWS_REGION` et `S3_BUCKET`; sur EC2, utilisez le rôle IAM de l’instance. Pour SQS, configurez `SQS_PDF_QUEUE_URL`; PostgreSQL reste la file de secours. Pour les e-mails de dernier téléchargement, renseignez `SES_FROM_EMAIL` et accordez au rôle IAM l’autorisation SES nécessaire.

Arrêt : `docker compose down`. Pour supprimer aussi la base et les PDF locaux : `docker compose down -v`.

## Fonctionnalités disponibles

- Comptes avec mot de passe, sessions serveur HttpOnly et rôles rédacteur/administrateur.
- Espace rédacteur : création et édition versionnée des documents, crédit journalier, partage avec un autre compte, historique et restauration, création de liens à quota.
- Édition riche avec Quill, synchronisation simultanée par Yjs/WebSocket et indication des rédacteurs connectés.
- Espace visiteur : consultation d’un lien public, réservation atomique d’un exemplaire et récupération du PDF généré en arrière-plan.
- Espace administrateur : indicateurs d’activité, liste des comptes et demandes PDF, suspension temporaire d’un compte.
- Notification par e-mail du créateur quand le quota d’un lien atteint zéro, avec tentatives différées en cas d’échec.
- Contrôle du quota et de l’idempotence des demandes dans PostgreSQL.

## Tests

Les tests d’intégration utilisent PostgreSQL. Démarrez et migrez la base avant de les lancer :

```sh
docker compose up -d db
npm run migrate --workspace @journal/api
npm test
```

Ils vérifient notamment les réservations concurrentes, les crédits, l’authentification, le refus d’accès administrateur aux comptes rédacteur et la convergence de deux éditions Yjs concurrentes.

## API principale

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` — comptes et sessions.
- `/api/documents` — documents accessibles et sauvegardes avec contrôle de révision.
- `/api/documents/:id/share` — partage avec un compte existant.
- `/api/documents/:id/versions` et `/api/documents/:id/versions/:versionId/restore` — historique et restauration.
- `/api/credit` — crédit d’écriture du jour.
- `/api/documents/:id/links`, `/api/links` — liens publics et quotas.
- `/api/public/links/:token` et `/api/public/reservations/:id` — parcours visiteur et statut PDF.
- `/api/admin/overview` et `/api/admin/people/:id/blocks` — opérations réservées au rôle administrateur.

## Travail restant

Les intégrations SQS et SES sont optionnelles et demandent une file, une identité AWS et une adresse d’expédition configurées. Le worker conserve la file PostgreSQL comme source durable et solution de secours. La collaboration utilise l’état en mémoire d’un serveur WebSocket; une diffusion partagée entre plusieurs instances sera nécessaire pour le passage à l’échelle. L’observabilité, le déploiement AWS complet, l’export PDF avec mise en forme et le test de charge de 15 000 visiteurs restent à réaliser. Avant une mise en production, il faudra aussi ajouter la vérification d’adresse e-mail, une procédure sécurisée de récupération de mot de passe et exécuter les tests sur une base PostgreSQL accessible.
