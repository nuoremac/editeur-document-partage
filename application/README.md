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

Ouvrir `http://localhost:5173`. L’API écoute sur `http://localhost:3000`. Créez un compte rédacteur ou connectez-vous. L’administrateur configuré se connecte avec les identifiants de `.env` et arrive directement sur son tableau de bord. Un visiteur utilise le lien public `/share/<jeton>`.

PostgreSQL et le worker PDF démarrent dans Compose. En développement, les PDF sont enregistrés dans un volume local. Pour S3, renseignez `AWS_REGION` et `S3_BUCKET`; sur EC2, utilisez le rôle IAM de l’instance. Pour SQS, configurez `SQS_PDF_QUEUE_URL`; PostgreSQL reste la file de secours. Pour les e-mails de dernier téléchargement, renseignez `SES_FROM_EMAIL` et accordez au rôle IAM l’autorisation SES nécessaire.

Si l’API tourne avec `npm run dev` hors de Docker, ajoutez `REDIS_URL=redis://localhost:6379` dans `.env` afin d’utiliser le Redis de Compose pour le relais entre instances.

Arrêt : `docker compose down`. Pour supprimer aussi la base et les PDF locaux : `docker compose down -v`.

## Fonctionnalités disponibles

- Comptes avec mot de passe, sessions serveur HttpOnly et rôles rédacteur/administrateur.
- Espace rédacteur : création et édition versionnée des documents, crédit journalier, partage avec un autre compte, historique et restauration, création de liens à quota.
- Édition riche avec Quill, synchronisation simultanée par Yjs/WebSocket, liste des rédacteurs présents et curseurs/sélections en direct.
- Espace visiteur : consultation d’un lien public, réservation atomique d’un exemplaire et récupération du PDF généré en arrière-plan.
- Espace administrateur : indicateurs d’activité, liste des comptes et demandes PDF, suspension temporaire d’un compte.
- Notification par e-mail du créateur quand le quota d’un lien atteint zéro, avec tentatives différées en cas d’échec.
- Contrôle du quota et de l’idempotence des demandes dans PostgreSQL.
- Détection des refus répétés de dépassement du crédit et blocage automatique temporaire après cinq tentatives en cinq minutes.
- Alerte immédiate dans la page visiteur dès qu’un lien perd son dernier téléchargement disponible.
- Redis Pub/Sub pour relayer les éditions, curseurs et alertes entre instances API; Compose démarre Redis en local.

## Tests

Les tests d’intégration utilisent PostgreSQL. Démarrez et migrez la base avant de les lancer :

```sh
docker compose up -d db
npm run migrate --workspace @journal/api
npm test
```

Ils vérifient notamment les réservations concurrentes, les crédits, l’authentification, le refus d’accès administrateur aux comptes rédacteur et la convergence de deux éditions Yjs concurrentes.

## API principale

Le détail des routes, les formats JSON, les réponses attendues et des commandes `curl` pour les parcours rédacteur, visiteur et administrateur sont dans le [guide de test de l’API](API.md). Celui-ci décrit aussi le protocole WebSocket de l’éditeur collaboratif.

## Travail restant

Les intégrations SQS et SES sont optionnelles et demandent une file, une identité AWS et une adresse d’expédition configurées. Le worker conserve la file PostgreSQL comme source durable et solution de secours. Redis coordonne le temps réel entre processus API, mais le Compose fourni n’a qu’une API, un PostgreSQL et un Redis uniques, sans répartiteur de charge ni dimensionnement de production. La capacité de 15 000 visiteurs et 300 rédacteurs simultanés n’est donc pas encore démontrée : il faut déployer l’architecture dimensionnée et exécuter un test de charge instrumenté avant de la revendiquer. Le déploiement AWS complet, l’export PDF avec mise en forme, la vérification d’adresse e-mail et la récupération sécurisée de mot de passe restent aussi à réaliser.
