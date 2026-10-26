# Guide de test de l’API

Ce guide décrit l’API telle qu’elle est implémentée et donne au jury un parcours de test reproductible. L’API locale est disponible sur `http://localhost:3000` et l’application web sur `http://localhost:5173`.

## 1. Démarrer les services

Depuis le dossier `application/`, configurez d’abord `ADMIN_EMAILS` et `ADMIN_BOOTSTRAP_PASSWORD` dans `.env` (le mot de passe administrateur doit avoir au moins 12 caractères), puis lancez :

```sh
cp -n .env.example .env
npm install
docker compose up --build -d
```

Dans un autre terminal, toujours depuis `application/` :

```sh
npm run dev:web
```

Vérifiez que l’API et PostgreSQL répondent :

```sh
curl -i http://localhost:3000/health
```

Réponse attendue : `200 OK` et `{"status":"ok"}`. Le worker PDF démarre avec Compose.

## 2. Authentification

Les routes privées utilisent une session dans le cookie HttpOnly `journal_session`. Avec `curl`, conservez ce cookie dans un fichier et renvoyez-le avec `-b`. Les inscriptions publiques créent uniquement un compte rédacteur (`EDITOR`). Le compte administrateur est créé au démarrage à partir des valeurs `.env`.

Créer un compte rédacteur et enregistrer son cookie :

```sh
BASE=http://localhost:3000
COOKIE=/tmp/journal-cookie.txt

curl -i -c "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"name":"Test Jury","email":"jury@example.org","password":"motdepasse-test-123"}' \
  "$BASE/api/auth/register"
```

La réponse attendue est `201 Created`, avec `id`, `name`, `email` et `role: "EDITOR"`. L’adresse doit être nouvelle dans la base. Vérifier la session :

```sh
curl -i -b "$COOKIE" "$BASE/api/auth/me"
```

Pour se connecter à un compte existant (y compris l’administrateur), utilisez `POST /api/auth/login` avec `{"email":"...","password":"..."}` et l’option `-c "$COOKIE"`. Pour fermer la session, appelez `POST /api/auth/logout` avec `-b "$COOKIE" -c "$COOKIE"`.

## 3. Routes disponibles

Sauf mention « publique », les routes ci-dessous nécessitent une session. Les paramètres entre accolades font partie du chemin et doivent être remplacés par les identifiants retournés par l’API.

| Méthode et route | Accès | Corps JSON / résultat |
|---|---|---|
| `GET /health` | Public | État de l’API et de la connexion à la base |
| `POST /api/auth/register` | Public | `{ "name": "...", "email": "...", "password": "..." }` ; crée un rédacteur et ouvre une session |
| `POST /api/auth/login` | Public | `{ "email": "...", "password": "..." }` ; ouvre une session |
| `POST /api/auth/logout` | Session | Ferme la session ; réponse `204` |
| `GET /api/auth/me` | Session | Retourne l’utilisateur connecté et son rôle |
| `POST /api/documents` | Rédacteur | `{ "title": "..." }` ; crée un document |
| `GET /api/documents` | Session | Liste les documents accessibles |
| `GET /api/documents/{documentId}` | Membre du document | Détails et contenu |
| `PUT /api/documents/{documentId}/content` | Membre du document | `{ "content": "...", "baseRevision": 0 }` ; sauvegarde avec contrôle de révision |
| `POST /api/documents/{documentId}/share` | Propriétaire | `{ "email": "compte-existant@example.org", "role": "EDITOR" }` ; réponse `204` |
| `POST /api/documents/{documentId}/versions` | Membre du document | Sans corps ; crée un instantané |
| `GET /api/documents/{documentId}/versions` | Membre du document | Liste l’historique |
| `POST /api/documents/{documentId}/versions/{versionId}/restore` | Propriétaire | Sans corps ; restaure une version comme nouvelle révision |
| `GET /api/credit` | Session | Crédit d’écriture du jour : utilisé, limite et restant |
| `GET /api/notifications` | Session | Notifications de dernier exemplaire adressées au compte |
| `POST /api/documents/{documentId}/links` | Membre du document | `{ "limit": 3, "expiresAt": "2026-12-31T23:59:59.000Z" }` ; `expiresAt` est facultatif |
| `GET /api/links` | Session | Liens créés par l’utilisateur |
| `GET /api/public/links/{token}` | Public | Détails et état du lien de partage |
| `POST /api/public/links/{token}/reservations` | Public | Réserve un exemplaire et démarre la génération PDF |
| `GET /api/public/reservations/{reservationId}` | Public | État du PDF et URL de téléchargement lorsqu’il est prêt |
| `GET /api/public/reservations/{reservationId}/file` | Public | Télécharge le PDF prêt |
| `GET /api/admin/overview` | Administrateur | Indicateurs, documents ouverts en collaboration, liens actifs avec quota restant, comptes et personnes bloquées |
| `POST /api/admin/people/{personId}/blocks` | Administrateur | `{ "reason": "Motif du test", "durationHours": 1 }` |
| `DELETE /api/admin/people/{personId}/blocks` | Administrateur | Lève les suspensions actives ; réponse `204` |

Le partage est réservé au propriétaire et le compte destinataire doit déjà exister. Le propriétaire peut restaurer une version. Les modifications collaboratives sont synchronisées et persistées comme révisions ; un point de restauration est créé explicitement avec `POST /api/documents/{documentId}/versions`. La route HTTP de sauvegarde utilise `baseRevision` pour détecter les modifications concurrentes. L’éditeur de l’application utilise le protocole WebSocket Yjs décrit plus bas.

## 4. Parcours de test rédacteur

Une fois connecté, créer un document :

```sh
curl -i -b "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"title":"Document de démonstration"}' \
  "$BASE/api/documents"
```

Copiez le champ `id` de la réponse et affectez-le à `DOC` dans le terminal :

```sh
DOC='identifiant-retourne-par-API'
curl -i -b "$COOKIE" "$BASE/api/documents/$DOC"
```

Pour tester rapidement une sauvegarde HTTP, reprenez le `revision` retourné par la lecture (généralement `0`) :

```sh
curl -i -b "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"content":"Texte de test du jury","baseRevision":0}' \
  "$BASE/api/documents/$DOC/content"
```

La réponse contient la nouvelle révision. Une sauvegarde répétée avec l’ancienne révision renvoie `409 REVISION_CONFLICT`. L’édition collaborative elle-même se teste dans l’interface : ouvrez le même document dans deux sessions de rédacteur et vérifiez la synchronisation en direct.

Créer et consulter un instantané :

```sh
curl -i -X POST -b "$COOKIE" "$BASE/api/documents/$DOC/versions"
curl -i -b "$COOKIE" "$BASE/api/documents/$DOC/versions"
```

Pour restaurer, copiez un `id` de version depuis la liste puis appelez :

```sh
VERSION='identifiant-de-version'
curl -i -X POST -b "$COOKIE" \
  "$BASE/api/documents/$DOC/versions/$VERSION/restore"
```

La restauration renvoie le document et sa nouvelle révision. Consultez le crédit avec `GET /api/credit`.

## 5. Parcours de test visiteur et PDF

Créer un lien avec trois utilisations :

```sh
curl -i -b "$COOKIE" -H 'Content-Type: application/json' \
  -d '{"limit":3}' "$BASE/api/documents/$DOC/links"
```

Copiez `token` dans `TOKEN` et ouvrez l’URL `url` retournée (ou `http://localhost:5173/share/$TOKEN`) dans une fenêtre privée. L’URL ouvre la vue visiteur. Pour tester le parcours par API, consulter le lien et réserver une utilisation :

```sh
TOKEN='jeton-retourne-par-API'
curl -i "$BASE/api/public/links/$TOKEN"
curl -i -X POST -H 'Idempotency-Key: jury-demande-001' \
  "$BASE/api/public/links/$TOKEN/reservations"
```

La réservation renvoie `202 Accepted` et un identifiant `id`. Interrogez son état jusqu’à `READY` :

```sh
RESERVATION='identifiant-retourne-par-API'
curl -i "$BASE/api/public/reservations/$RESERVATION"
```

Lorsque la réponse contient un `downloadUrl`, ouvrez cette URL ou téléchargez-la :

```sh
curl -L -o document.pdf "$BASE/api/public/reservations/$RESERVATION/file"
```

La génération est asynchrone : un état `QUEUED` ou `PROCESSING` signifie qu’il faut réinterroger le statut après quelques secondes. Une clé `Idempotency-Key` identique rejoue la même réservation sans consommer une utilisation supplémentaire ; utilisez une nouvelle clé pour tester une nouvelle réservation. Quand le quota atteint zéro, une nouvelle réservation renvoie `410 LINK_EXHAUSTED`.

## 6. Parcours de test administrateur

Connectez-vous avec l’adresse et le mot de passe configurés dans `.env`, en stockant la session dans un fichier distinct :

```sh
ADMIN_COOKIE=/tmp/journal-admin-cookie.txt
curl -i -c "$ADMIN_COOKIE" -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.org","password":"mot-de-passe-configure"}' \
  "$BASE/api/auth/login"
curl -i -b "$ADMIN_COOKIE" "$BASE/api/admin/overview"
```

Remplacez les valeurs d’exemple par celles de `.env`. Dans `people`, choisissez un `id` de compte rédacteur pour tester une suspension temporaire :

```sh
PERSON='identifiant-du-redacteur'
curl -i -b "$ADMIN_COOKIE" -H 'Content-Type: application/json' \
  -d '{"reason":"Test de suspension","durationHours":1}' \
  "$BASE/api/admin/people/$PERSON/blocks"
curl -i -X DELETE -b "$ADMIN_COOKIE" \
  "$BASE/api/admin/people/$PERSON/blocks"
```

Un rédacteur qui appelle `/api/admin/overview` doit obtenir `403 ADMIN_REQUIRED`. Une requête privée sans cookie renvoie `401 AUTH_REQUIRED`.

## 7. Édition collaborative WebSocket

L’éditeur utilise `ws://localhost:3000/ws/documents/{documentId}`. La connexion doit inclure le cookie de session `journal_session`, et l’utilisateur doit avoir accès au document. Pour autoriser plusieurs adresses du frontend en local, configurez `WEB_ORIGINS` comme une liste séparée par des virgules, par exemple `http://localhost:5173,http://localhost:5174`. Cette liste est vérifiée pour les requêtes HTTP et WebSocket. Le client Yjs de l’application gère automatiquement l’encodage et l’application des mises à jour.

À l’ouverture, le serveur envoie un message `sync` contenant l’état Yjs encodé en Base64, puis des messages `presence` avec les rédacteurs connectés. Une modification envoyée par le client a cette forme :

```json
{"type":"update","operationId":"UUID-v4-unique","update":"mise-a-jour-Yjs-en-Base64"}
```

Le serveur renvoie `accepted` à l’émetteur avec la révision et le crédit, et diffuse `update` aux sessions connectées. Les états Yjs `awareness` transportent le nom, la position et la sélection du curseur; les autres rédacteurs voient ainsi où chacun écrit. Après cinq refus de dépassement du crédit en cinq minutes, le serveur applique un blocage d’une heure; il est enregistré et visible dans l’administration. Les erreurs sont envoyées sous forme de message `error`.

Une page visiteur peut aussi ouvrir `ws://localhost:3000/ws/public/links/{token}`. Elle reçoit `link-exhausted` dès que le dernier exemplaire est réservé, y compris si la réservation est faite par un autre processus API. Le canal est en lecture seule. Redis Pub/Sub coordonne les mises à jour de document, les curseurs et les alertes entre plusieurs instances API; définissez `REDIS_URL` dans chaque instance. Sans Redis, les notifications fonctionnent à l’intérieur d’une instance seulement.

Pour le test du jury, ouvrez le même document dans deux navigateurs connectés avec des comptes autorisés, puis placez le curseur et saisissez du texte dans l’un. Ouvrez aussi un lien public dans un troisième navigateur, réservez son dernier téléchargement, et vérifiez que la page visiteur affiche immédiatement l’épuisement.

## 8. Erreurs courantes

Les réponses d’erreur sont au format JSON `{ "error": "...", "code": "..." }`. Les corps invalides renvoient `400 VALIDATION_ERROR` avec un tableau `details`; identifiant invalide ou ressource absente renvoie généralement `404`; session manquante `401`; droits insuffisants ou compte bloqué `403`; conflit de révision `409`; lien épuisé ou expiré `410`; crédit d’écriture épuisé `429`. Les options `curl -i` affichent le code HTTP et le corps de réponse.

## Capacité et test de charge

Le canal Redis rend possibles plusieurs processus API, mais la configuration Docker Compose actuelle garde une seule API, une base PostgreSQL et un Redis sans répartition de charge ni réglage de production. Elle ne constitue donc pas une preuve de prise en charge de 15 000 visiteurs et 300 rédacteurs simultanés. Cette capacité doit être mesurée sur l’environnement cible, avec répartition WebSocket, base/Redis dimensionnés, un lien dédié au test et des résultats enregistrés (latence, erreurs, débit, saturation). Ne lancez pas un essai de 15 000 réservations sur un lien réel : chaque réservation consomme une unité de quota.

Ne partagez pas le fichier `.env` ni les mots de passe avec le rapport ou le dépôt. Pour un nouveau test d’inscription, changez l’adresse e-mail : elle doit être unique.
