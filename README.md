# GeoGuesser: party edition

A GeoGuessr-style pub quiz round. Teams guess where each photo was taken by dropping a pin on a map. The closest team wins each round.

**Live site:** https://geoguesser-4zqa.onrender.com. Everything happens there. Games, photos and settings are saved in Firebase, so nothing is lost when the site restarts.

## Setting up a game

1. Go to the live site and log in as **kawaiifreak97**. That opens the admin page.
2. Under **Saved games**, pick a game or type a name and click **Create new game**.
3. In the editor (**Editing: <name>**), add photos. For each one, set the spot: click the map, paste `lat, lng` from Google Maps, or let it read the photo's GPS data. Add a description for the reveal, then drag the rounds into order. Everything saves automatically.
4. Use **Duplicate** to base a new game on an existing one, and **Rename** or **Delete** to tidy up.

## On the night

1. Open the live site about a minute early. Render's free plan sleeps after 15 minutes idle and takes about a minute to wake.
2. Log in as admin, select the game to play, then click **Open presenter screen**. Put it on the big monitor and press ⛶ (or `F`) for fullscreen.
3. Teams scan the QR code on the monitor (or type the URL) and enter a team name, one phone per team.
4. Press **Space** on the presenter screen (or click its top button) to start and to move through each round.

During a round the monitor shows the photo and a countdown. Teams drop a pin and submit. A pin dropped but not submitted still counts when time runs out. The round ends early once every team has locked in. After each round the monitor shows everyone's pins, the real spot, the distances, and who won the point.

## How it's hosted

- **Render** (free plan) runs the app from this GitHub repo and redeploys automatically on every push to `main`.
- **Firebase Firestore** (free Spark plan, project `geoguesser-17225`) stores games, settings and photos. Photos are split into chunks under Firestore's 1 MB limit. Only the server talks to Firebase, using the service-account key. On Render it's a Secret File named `firebase-service-account.json`; it is gitignored and never committed.
- **Maps:** CARTO street map (free key, saved in settings) plus Esri satellite imagery (no key).
- Scores and teams live in the server's memory during a game, which is fine for one evening.

## Notes

- **iPhone photos:** use JPG, not HEIC; HEIC doesn't display in most browsers. Photos are shrunk to about 2000px on upload.
- The same team name on a second phone joins the same team. Refreshing the page keeps you in the game.
- If the Firebase key ever leaks: in Firebase, go to **Project settings → Service accounts**, delete the key, generate a new one, and replace the Render secret file.
