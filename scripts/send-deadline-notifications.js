// scripts/send-deadline-notifications.js
//
// Run by the GitHub Actions workflow .github/workflows/daily-deadlines.yml.
// Reads cards + push subscriptions directly from Firestore via its public
// REST API (no service account needed, since the Firestore rules for this
// project allow open read/write under /spaces/{spaceId}/**), then sends a
// push notification — via the standard Web Push protocol — to every device
// subscribed for the configured space, listing the fiches whose deadline
// falls tomorrow (Europe/Paris time).
//
// Required environment variables (set as GitHub repo secrets/variables):
//   FIREBASE_PROJECT_ID   e.g. "bouchereminder"
//   SPACE_CODE            the shared space code used in the app (e.g. "Mars")
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT          e.g. "mailto:toi@example.com"

const webpush = require('web-push');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const SPACE_CODE = process.env.SPACE_CODE;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!PROJECT_ID || !SPACE_CODE || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Variables d\'environnement manquantes (FIREBASE_PROJECT_ID, SPACE_CODE, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY).');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// --- Only actually run at 18h Europe/Paris -------------------------------
// The workflow triggers twice (16:00 and 17:00 UTC) to cover both CET and
// CEST without needing timezone-aware cron (GitHub Actions cron is UTC-only).
// Whichever run lands on 18:00 Paris time proceeds; the other exits quietly.
function parisHourNow() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', hour12: false
  });
  return parseInt(fmt.format(new Date()), 10);
}

function parisDateStringInDays(daysAhead) {
  const now = new Date();
  // shift by daysAhead, then format the Y-M-D as seen in Europe/Paris
  const shifted = new Date(now.getTime() + daysAhead * 86400000);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }); // en-CA -> YYYY-MM-DD
  return fmt.format(shifted);
}

// --- Minimal Firestore REST value parser ----------------------------------
function fsValueToJs(value) {
  if (value == null) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('mapValue' in value) return fsFieldsToObject(value.mapValue.fields || {});
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fsValueToJs);
  if ('timestampValue' in value) return value.timestampValue;
  return null;
}
function fsFieldsToObject(fields) {
  const out = {};
  for (const key of Object.keys(fields || {})) out[key] = fsValueToJs(fields[key]);
  return out;
}

async function fetchCollection(path) {
  const res = await fetch(`${BASE_URL}/${path}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Firestore fetch ${path} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.documents || []).map(doc => ({
    id: doc.name.split('/').pop(),
    ...fsFieldsToObject(doc.fields || {})
  }));
}

async function deleteDoc(path) {
  await fetch(`${BASE_URL}/${path}`, { method: 'DELETE' }).catch(() => {});
}

async function main() {
  const hour = parisHourNow();
  if (hour !== 18) {
    console.log(`Heure actuelle à Paris : ${hour}h — pas 18h, on ne fait rien (l'autre déclenchement du jour s'en chargera).`);
    return;
  }

  const tomorrow = parisDateStringInDays(1);
  console.log(`Recherche des fiches avec deadline = ${tomorrow} dans l'espace « ${SPACE_CODE} »…`);

  const cards = await fetchCollection(`spaces/${encodeURIComponent(SPACE_CODE)}/cards`);
  const dueTomorrow = cards.filter(c => c.deadline === tomorrow && (c.title || '').trim());

  if (dueTomorrow.length === 0) {
    console.log('Aucune fiche avec une deadline demain — aucune notification envoyée.');
    return;
  }

  const titles = dueTomorrow.map(c => '• ' + c.title.trim());
  const payload = JSON.stringify({
    title: `Échéances demain (${dueTomorrow.length})`,
    body: titles.join('\n'),
    url: './index.html'
  });

  const subs = await fetchCollection(`spaces/${encodeURIComponent(SPACE_CODE)}/subscriptions`);
  console.log(`${subs.length} appareil(s) abonné(s) trouvé(s).`);

  let sent = 0;
  for (const subDoc of subs) {
    const sub = subDoc.subscription;
    if (!sub || !sub.endpoint) continue;
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      console.warn(`Échec d'envoi vers un appareil (${err.statusCode || err.message}).`);
      if (err.statusCode === 404 || err.statusCode === 410) {
        // subscription expired / no longer valid — clean it up
        await deleteDoc(`spaces/${encodeURIComponent(SPACE_CODE)}/subscriptions/${subDoc.id}`);
        console.log(`Abonnement expiré supprimé (${subDoc.id}).`);
      }
    }
  }
  console.log(`Notification envoyée à ${sent}/${subs.length} appareil(s) : ${titles.join(' / ')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
