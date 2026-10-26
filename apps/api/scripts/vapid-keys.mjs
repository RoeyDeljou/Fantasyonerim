// Prints a fresh VAPID key pair for web push: `npm run vapid -w @fant/api`.
// Put the values in VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (keep the private key secret).
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
process.stdout.write(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
