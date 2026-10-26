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

## Déploiement sur une instance AWS EC2

Le fichier `compose.production.yml` démarre PostgreSQL, Redis, l’API, le worker PDF, le frontend compilé et Caddy. Caddy sert le frontend, transmet `/api`, `/health` et `/ws` à l’API et demande automatiquement un certificat HTTPS. Les ports PostgreSQL, Redis et API ne sont pas publiés sur Internet. Cette configuration vise une instance unique de démonstration ; elle ne fournit ni haute disponibilité ni preuve de capacité pour 15 000 visiteurs simultanés.

Sur EC2, installez Docker Engine et le plugin Docker Compose, clonez le dépôt puis, depuis le dossier `application`, créez le fichier secret local :

```sh
cp .env.production.example .env.production
openssl rand -hex 32
```

Utilisez des valeurs différentes générées par `openssl rand -hex 32` pour `POSTGRES_PASSWORD` et `REDIS_PASSWORD`. Choisissez également un mot de passe administrateur distinct d’au moins 12 caractères. Complétez `APP_DOMAIN`, `ACME_EMAIL`, `ADMIN_EMAILS`, `AWS_REGION` et `S3_BUCKET`, puis protégez le fichier avec `chmod 600 .env.production`. Le fichier `.env.production` est ignoré par Git et Docker : ne le commitez jamais.

Avant le démarrage, créez un enregistrement DNS `A` vers l’adresse publique EC2 et autorisez les ports entrants 80 et 443 dans le groupe de sécurité. Autorisez le port 22 uniquement depuis votre adresse IP. Attachez à EC2 un rôle IAM donnant à l’application les droits nécessaires sur le bucket privé S3 et, si utilisée, la file SQS. N’ajoutez aucune clé AWS au fichier d’environnement ; le SDK utilise le rôle de l’instance. Pour les conteneurs, réglez les options de métadonnées de l’instance de façon à autoriser l’accès IMDSv2 depuis Docker.

Vérifiez la configuration puis construisez et démarrez les services :

```sh
docker compose --env-file .env.production -f compose.production.yml config
docker compose --env-file .env.production -f compose.production.yml up --build -d
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs -f api caddy pdf-worker
```

Le certificat HTTPS ne sera émis que lorsque le DNS pointe vers EC2 et que les ports 80/443 sont joignables. Testez ensuite l’inscription, la connexion administrateur, l’édition collaborative, le partage public et le téléchargement PDF. Chiffrez également le volume EBS de l’instance. Les volumes Docker assurent la persistance lors d’un redémarrage, mais ne remplacent pas une sauvegarde.

Le script `scripts/backup-production-db.sh` exporte PostgreSQL en format restaurable et envoie l’archive dans `s3://<bucket>/backups/postgresql/`. Installez AWS CLI sur EC2, accordez au rôle IAM `s3:PutObject` sur ce préfixe, puis testez le script manuellement avant de le planifier. Une sauvegarde n’est utile que si sa restauration est vérifiée ; configurez aussi une règle de cycle de vie S3 pour supprimer les anciennes archives selon la durée de conservation choisie.

SES reste optionnel. Pour envoyer des e-mails à des destinataires réels, vérifiez l’identité d’expédition et demandez la sortie de sandbox SES dans la région configurée.

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

La configuration de déploiement EC2 est fournie, mais les ressources AWS, le DNS, le rôle IAM, SES et les sauvegardes planifiées doivent être configurés dans le compte avant la mise en ligne. Cette architecture à instance unique ne fournit pas de haute disponibilité et ne démontre pas la capacité de 15 000 visiteurs et 300 rédacteurs simultanés ; un déploiement dimensionné et un test de charge instrumenté seront nécessaires avant de revendiquer ces niveaux. L’export PDF avec mise en forme, la vérification d’adresse e-mail et la récupération sécurisée de mot de passe restent également à réaliser.
