import 'dotenv/config';
import { createServer } from 'node:http';
import app, { bootstrapConfiguredAdmins } from './app.js';
import { attachCollaboration } from './collaboration.js';

const port = Number(process.env.PORT ?? 3000);
const server = createServer(app);
attachCollaboration(server);
await bootstrapConfiguredAdmins();
server.listen(port, () => console.log(`API du journal prête sur le port ${port}`));
