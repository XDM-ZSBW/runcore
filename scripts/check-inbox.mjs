import { restoreSession } from '../dist/auth/identity.js';
import { loadVault } from '../dist/vault/store.js';
import { getCredentialStore, createCredentialStore } from '../dist/credentials/store.js';
import { forceCheckResendInbox } from '../dist/resend/inbox.js';

const session = await restoreSession();
if (!session) { console.log('No session — is Core paired?'); process.exit(1); }

await loadVault(session.sessionKey);

// Hydrate credentials (separate store from vault)
let credStore = getCredentialStore();
if (!credStore) credStore = createCredentialStore('brain');
await credStore.hydrate();

console.log('RELAY_SECRET:', process.env.RELAY_SECRET ? '[set]' : '[not set]');
console.log('RESEND_WORKER_URL:', process.env.RESEND_WORKER_URL ? '[set]' : '[not set]');
console.log('RESEND_API_KEY:', process.env.RESEND_API_KEY ? '[set]' : '[not set]');

const count = await forceCheckResendInbox();
console.log('Processed:', count);
process.exit(0);
