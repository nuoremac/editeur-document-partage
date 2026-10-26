# Déploiement AWS de l’application Atelier

Ce guide documente le déploiement multi-EC2 dans la région AWS Europe (Stockholm), `eu-north-1`. Il décrit les choix appliqués et l’état réel de l’installation. Les fichiers `.env` contiennent des secrets et ne doivent jamais être ajoutés à Git.

## État actuel

- Cinq instances EC2 Amazon Linux 2023 ont été créées : Edge, API, Worker, Données et Sauvegarde. Elles appartiennent au même VPC.
- Les groupes de sécurité séparent le trafic public, applicatif et base de données. PostgreSQL et Redis ne doivent pas être accessibles depuis Internet.
- Des rôles IAM distincts sont associés aux instances API, Worker et Sauvegarde. Edge et Données n’ont pas de permission AWS applicative.
- Docker et Compose sont installés sur API et Worker. Sur AL2023, Compose et Buildx ont été ajoutés comme plugins CLI système.
- PostgreSQL 16 est installé directement sur Données et écoute sur son adresse privée. Redis 6 (`redis6`) est également installé nativement.
- La file SQS `atelier-pdf` utilise le chiffrement géré par SQS. Le bucket S3 doit rester privé.
- Le mode HTTP par IP est configuré en attendant l’obtention d’un domaine. L’IP publique Edge actuellement communiquée est `16.171.5.130`, soit `http://16.171.5.130` lorsque le frontend Edge est démarré.
- L’API n’est pas encore validée comme opérationnelle : lors du dernier contrôle, l’image s’est construite, mais le conteneur redémarrait pendant la migration avec `TypeError: Invalid URL` pour `DATABASE_URL`. Corriger le mot de passe/URL PostgreSQL puis vérifier le healthcheck avant de poursuivre.

Une adresse IPv4 publique EC2 attribuée automatiquement peut changer après un arrêt/redémarrage. Une Elastic IP permet de conserver une adresse stable. Le mode HTTP n’apporte pas le chiffrement TLS ; le HTTPS nécessitera un domaine contrôlé par le projet et un certificat.

## Architecture

| Instance | Fonction | Accès AWS |
|---|---|---|
| Edge | Frontend statique et reverse proxy Caddy | Aucun accès applicatif |
| API | API HTTP/WebSocket, PostgreSQL et SQS | Rôle limité à SQS et S3 |
| Worker | Traitement PDF et notifications | Rôle limité à SQS, S3 et éventuellement SES |
| Données | PostgreSQL et Redis | Aucun accès applicatif |
| Sauvegarde | `pg_dump` planifié et envoi S3 | Rôle limité au préfixe de sauvegarde S3 |

Les composants communiquent par adresses privées. Seule Edge reçoit du trafic entrant public : TCP 80 (et 443 quand HTTPS sera configuré). L’API reçoit TCP 3000 depuis le groupe Edge. Données reçoit TCP 5432 depuis API, Worker et Sauvegarde, et TCP 6379 depuis API. SSH doit être limité à l’adresse IP d’administration ; ne pas exposer les ports 3000, 5432 ou 6379 à Internet.

## Préparation AWS

1. Choisir la région `eu-north-1` et créer un VPC avec les sous-réseaux nécessaires. Les instances doivent partager le VPC ; les hôtes qui téléchargent des images Docker ou appellent S3/SQS ont besoin d’un accès sortant.
2. Créer les groupes de sécurité Edge, API, Worker, Données et Sauvegarde avec les seules règles nécessaires décrites ci-dessus.
3. Créer les rôles IAM de confiance EC2. Adapter les politiques exemples dans [`application/aws/iam`](../application/aws/iam/) aux vrais ARN du compte, de la file et du bucket. Ne pas attacher `AdministratorAccess` et ne pas créer de clés d’accès IAM permanentes pour les applications.
4. Créer un bucket S3 privé dans `eu-north-1`, avec blocage d’accès public et chiffrement activés. Créer la file SQS PDF avec chiffrement géré par SQS et, idéalement, une file DLQ.
5. Créer les cinq instances Amazon Linux 2023. Associer à chacune son groupe de sécurité et son rôle IAM correspondant. Activer IMDSv2 et le chiffrement EBS. Conserver la clé SSH `.pem` hors du dépôt.
6. Affecter une adresse privée stable à Données. L’IP privée de la base configurée pendant ce déploiement est `172.31.44.252`. Les exemples de configuration doivent utiliser les adresses privées réellement attribuées au compte.

## Installation des services sur les instances

### Docker et outils de build

Docker/Compose sont nécessaires sur API, Worker et Edge (frontend/Caddy dans Compose). Sur Sauvegarde, Docker est nécessaire au script existant qui lance `pg_dump` dans un conteneur. Données utilise ici des services natifs et ne lance pas `compose.production-data.yml`.

Sur Amazon Linux 2023, installer Docker puis le démarrer :

```sh
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo docker run hello-world
```

Compose et Buildx doivent être présents comme plugins du client Docker. Vérifier :

```sh
sudo docker compose version
sudo docker buildx version
```

Si nécessaire, suivre les instructions officielles Docker pour installer ces plugins dans `/usr/local/lib/docker/cli-plugins/`. Les binaires installés manuellement ne se mettent pas à jour automatiquement.

### PostgreSQL sur Données

Installer PostgreSQL 16, initialiser le cluster et l’activer :

```sh
sudo dnf install -y postgresql16-server
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
```

Créer le rôle applicatif et sa base. Dans cette installation, le rôle est `atelier_app` et la base `atelier` :

```sh
sudo -u postgres psql
```

Dans `psql` :

```text
CREATE ROLE atelier_app LOGIN PASSWORD 'secret-fort';
CREATE DATABASE atelier OWNER atelier_app;
```

Pour une installation interactive et sans mettre le secret dans l’historique, préférer `\\password atelier_app` après création du rôle. Configurer ensuite `listen_addresses` avec `localhost` et l’IP privée de Données, puis ajouter dans `pg_hba.conf` une règle `scram-sha-256` limitée à l’IP privée de l’API (et aux adresses Worker/Sauvegarde nécessaires). Recharger PostgreSQL et tester depuis API avec `psql`.

Si un mot de passe contient des caractères réservés aux URL, l’encoder correctement dans `DATABASE_URL`. Une alternative pratique est un secret hexadécimal généré avec `openssl rand -hex 32`, à configurer à la fois sur PostgreSQL et dans les fichiers d’environnement applicatifs.

### Redis sur Données

Installer Redis fourni par AL2023 :

```sh
sudo dnf install -y redis6
```

Configurer `/etc/redis6/redis6.conf` avec l’IP privée de Données et un mot de passe fort :

```conf
bind 127.0.0.1 IP_PRIVEE_DATA
protected-mode yes
requirepass SECRET_REDIS
```

Activer le service, puis tester avec `redis6-cli` depuis API. La réponse à `PING`, après authentification, doit être `PONG`. Le secret doit correspondre à `REDIS_PASSWORD` dans les configurations API/Worker selon le rôle utilisé.

## Variables et fichiers secrets

Créer un fichier local par rôle depuis les modèles de `application/` : `.env.production-app`, `.env.production-worker`, `.env.production-edge` et `.env.production-backup`. Le fichier `.env.production-data` du dépôt correspond à un déploiement de PostgreSQL/Redis en conteneurs ; **ne pas l’utiliser pour l’installation native décrite dans ce guide**.

Renseigner les adresses privées, `POSTGRES_DB=atelier`, `POSTGRES_USER=atelier_app`, les mots de passe, l’adresse administrateur, le bucket, l’URL SQS et `AWS_REGION=eu-north-1`. Les secrets PostgreSQL doivent être identiques sur API, Worker et Sauvegarde. Fixer les permissions des fichiers :

```sh
chmod 600 .env.production-*
```

Pour l’accès IP temporaire, régler dans les fichiers API et Edge :

```env
APP_DOMAIN=IP_PUBLIQUE_EDGE
APP_SCHEME=http
```

Sur API, `API_PRIVATE_IP` est l’adresse privée de l’instance API ; sur Edge, c’est la même adresse privée d’API utilisée comme upstream. Ne jamais commiter ces fichiers ou transmettre les secrets dans un message ou un journal.

## Déploiement des conteneurs

Depuis la racine du dépôt sur chaque hôte, récupérer la branche `main` et entrer dans `application/`. Copier uniquement le fichier d’environnement correspondant à cet hôte par un canal SSH/SCP sécurisé. Exemple API :

```sh
cd /opt/atelier/application
sudo docker compose --env-file .env.production-app -f compose.production-app.yml config -q
sudo docker compose --env-file .env.production-app -f compose.production-app.yml up --build -d
sudo docker compose --env-file .env.production-app -f compose.production-app.yml ps
sudo docker compose --env-file .env.production-app -f compose.production-app.yml logs --tail=100 api
```

Le healthcheck API est `http://IP_PRIVEE_API:3000/health`. Une fois API saine, déployer Worker puis Edge avec les fichiers Compose correspondants. Edge doit servir `http://IP_PUBLIQUE_EDGE` en HTTP et transférer `/api`, `/health` et `/ws` vers API. Le navigateur ne doit pas accéder directement au port 3000.

Ne pas lancer `compose.production-data.yml` sur Données tant que l’architecture reste en installation native : ce fichier démarrerait un autre PostgreSQL isolé dans un conteneur.

## Sauvegardes et vérifications finales

Installer AWS CLI v2 sur Sauvegarde si nécessaire, vérifier que son rôle ne peut écrire que sous `backups/postgresql/`, puis lancer `application/scripts/backup-production-db.sh` manuellement avant de le planifier. Tester une restauration réelle. Vérifier aussi l’état de l’API, du worker et de l’edge, l’envoi et la consommation d’un message SQS, la génération/récupération d’un PDF depuis S3 et l’accès navigateur via l’IP Edge.

L’instance API avait construit son image mais redémarrait avec `TypeError: Invalid URL` pendant la migration. Après correction de `DATABASE_URL`, confirmer que `docker compose ps` indique `Up` et que `/health` réussit avant de présenter l’application comme déployée.

## Liens AWS et Docker

- [Rôles IAM pour EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html)
- [Adresses publiques EC2 et Elastic IP](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-instance-addressing.html)
- [Chiffrement côté serveur SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html)
- [Installation du plugin Docker Compose](https://docs.docker.com/compose/install/linux/)
- [Installation de Docker Buildx](https://github.com/docker/buildx#manual-download)
