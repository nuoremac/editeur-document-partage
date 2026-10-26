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

## Déploiement AWS sur plusieurs instances EC2

Une fois l’instance Edge déployée et configurée, l’application est accessible à l’adresse **http://16.171.5.130**. Cette adresse IP publique est temporaire : AWS peut la remplacer si l’instance Edge est arrêtée puis redémarrée. Pour conserver une adresse stable, associez une Elastic IP à l’instance Edge. L’accès actuel est en HTTP ; le HTTPS nécessitera un nom de domaine contrôlé par le projet et un certificat valide.

Le déploiement sépare les composants sur cinq EC2 pour attribuer un rôle IAM seulement aux hôtes qui en ont besoin :

Pour cette architecture, utilisez les quatre fichiers `compose.production-edge.yml`, `compose.production-app.yml`, `compose.production-worker.yml` et `compose.production-data.yml`. `compose.production.yml` est l’ancienne configuration monohôte conservée comme référence.

- **EC2 Edge** : Caddy et frontend statique ; aucun rôle IAM applicatif. Pour l’accès temporaire par IP, Caddy sert l’application en HTTP.
- **EC2 API** : API HTTP et WebSocket ; rôle limité à la lecture des PDF dans S3 et à l’envoi des travaux dans SQS.
- **EC2 Worker** : génération PDF et notifications ; rôle limité à l’écriture des PDF, à la consommation de la file SQS et à l’envoi SES (si activé).
- **EC2 Données** : PostgreSQL et Redis ; aucun rôle IAM applicatif.
- **EC2 Sauvegarde** : exécution planifiée de `pg_dump` et envoi vers S3 ; rôle limité à l’écriture sous `backups/postgresql/`.

Cette séparation est au niveau des instances EC2 : tous les processus d’une même instance peuvent obtenir les droits du rôle associé. C’est pourquoi l’instance de sauvegarde est séparée de la base et l’instance Edge n’a pas de rôle applicatif. Aucun identifiant AWS permanent ne doit être créé ou placé dans le code, Git, les fichiers `.env` ou les User Data. Les SDK et AWS CLI utilisent les identifiants temporaires des rôles d’instance.

### Règles réseau à configurer

Créez les instances dans le même VPC. Seule l’instance Edge reçoit les connexions publiques. Les instances privées ont tout de même besoin d’un chemin sortant pour télécharger les images et joindre S3/SQS : configurez un NAT ou les endpoints VPC nécessaires, en tenant compte du coût du NAT. Pour un essai sans NAT, un sous-réseau public avec des groupes de sécurité strictement limités peut simplifier l’accès sortant ; ne donnez alors aucune règle entrante publique aux hôtes backend. Configurez les groupes de sécurité ainsi :

| Groupe de sécurité | Entrées autorisées |
| --- | --- |
| Edge | TCP 80 et 443 depuis Internet ; SSH uniquement depuis votre IP `/32` ou Session Manager |
| API | TCP 3000 depuis le groupe Edge uniquement ; administration limitée |
| Worker | aucune entrée publique ; administration limitée |
| Données | TCP 5432 depuis les groupes API, Worker et Sauvegarde ; TCP 6379 depuis API et Worker ; administration limitée |
| Sauvegarde | aucune entrée publique ; administration limitée |

Ne rendez jamais PostgreSQL, Redis ou le port 3000 accessibles depuis Internet. Utilisez des volumes EBS chiffrés, activez IMDSv2 et activez MFA pour les identités humaines. Dans S3, bloquez l’accès public et activez le chiffrement. Utilisez une file SQS dédiée au PDF, avec une file DLQ si possible.

### Créer les rôles IAM

Créez trois rôles de confiance EC2 à partir de `aws/iam/ec2-trust-policy.example.json` et attachez-les respectivement à API, Worker et Sauvegarde. Les exemples de politiques à personnaliser sont :

- `aws/iam/ec2-api-permissions.example.json` pour l’API ;
- `aws/iam/ec2-worker-permissions.example.json` pour le worker ;
- `aws/iam/ec2-backup-permissions.example.json` pour l’instance de sauvegarde.

Remplacez les ARN fictifs par ceux de vos ressources réelles. Si SES n’est pas activé, retirez son instruction de la politique Worker. L’instance Edge n’a pas besoin de droits AWS applicatifs. Si vous choisissez Session Manager pour administrer les EC2, ajoutez uniquement le rôle d’administration AWS requis pour ce service, séparément des permissions applicatives. N’attachez jamais `AdministratorAccess`.

### Préparer les fichiers de configuration

Clonez le dépôt sur chacune des cinq EC2 et installez Docker Engine avec le plugin Compose. Sur l’instance de sauvegarde, installez aussi AWS CLI. Dans `application/`, créez le fichier local correspondant au rôle de la machine :

```sh
# Sur Edge
cp .env.production-edge.example .env.production-edge

# Sur API
cp .env.production-app.example .env.production-app

# Sur Worker
cp .env.production-worker.example .env.production-worker

# Sur Données
cp .env.production-data.example .env.production-data

# Sur Sauvegarde
cp .env.production-backup.example .env.production-backup
```

Remplacez les adresses d’exemple par les adresses privées fixes des EC2, complétez le domaine, l’adresse e-mail, les ARN/URL AWS et choisissez des secrets forts. Les paramètres PostgreSQL doivent être identiques sur API, Worker, Données et Sauvegarde ; le mot de passe Redis est nécessaire sur Données et API. Générez les secrets avec `openssl rand -hex 32`, protégez les fichiers avec `chmod 600 .env.production-*` et ne les commitez jamais. Utilisez une méthode sûre pour les transmettre aux hôtes concernés.

### Démarrer les composants

Depuis `application/`, lancez la commande correspondant à chaque instance :

```sh
# EC2 Données
docker compose --env-file .env.production-data -f compose.production-data.yml up --build -d

# EC2 API (après le démarrage de PostgreSQL et Redis)
docker compose --env-file .env.production-app -f compose.production-app.yml up --build -d

# EC2 Worker
docker compose --env-file .env.production-worker -f compose.production-worker.yml up --build -d

# EC2 Sauvegarde : pas de service permanent à démarrer
# Elle exécute scripts/backup-production-db.sh selon la planification choisie.

# EC2 Edge : l’application est accessible en HTTP sur http://16.171.5.130
docker compose --env-file .env.production-edge -f compose.production-edge.yml up --build -d
```

Les ports 5432 et 6379 sont liés à l’adresse privée de l’instance Données ; le groupe de sécurité doit aussi limiter ces flux aux instances API et Worker. Le port 3000 est lié à l’adresse privée de l’instance API et n’accepte que le groupe Edge. Caddy termine TLS sur Edge et transmet `/api`, `/health` et `/ws` à l’API privée. Vérifiez les services avec `docker compose ... ps` et les journaux de chaque hôte.

### Sauvegarde PostgreSQL

Sur l’EC2 Sauvegarde, créez `.env.production-backup` depuis son modèle puis exécutez `scripts/backup-production-db.sh`. Le script se connecte à PostgreSQL par son adresse privée, lance `pg_dump` dans un conteneur client et envoie le flux vers S3 avec le rôle limité de cette instance. Planifiez-le avec cron après l’avoir testé manuellement. Testez aussi une restauration réelle avant de considérer les sauvegardes fiables.

SES est facultatif. Pour envoyer des e-mails à de vraies adresses, vérifiez l’identité d’expédition et demandez la sortie du bac à sable SES dans la région choisie. Les coûts EC2, stockage, transferts, S3, SQS et SES varient avec la région et l’usage : surveillez AWS Budgets et les crédits avant de laisser les instances tourner. Cette architecture répartit les droits, mais ne constitue pas à elle seule une preuve de haute disponibilité ni de capacité à 15 000 visiteurs et 300 rédacteurs simultanés.

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

Les fichiers de déploiement multi-EC2 sont fournis, mais les ressources AWS, le DNS, les groupes de sécurité, les rôles IAM, SES et la planification des sauvegardes doivent être configurés dans le compte avant la mise en ligne. Cette architecture ne fournit pas à elle seule de haute disponibilité ni de preuve de capacité à 15 000 visiteurs et 300 rédacteurs simultanés ; un déploiement dimensionné et un test de charge instrumenté seront nécessaires avant de revendiquer ces niveaux. L’export PDF avec mise en forme, la vérification d’adresse e-mail et la récupération sécurisée de mot de passe restent également à réaliser.
