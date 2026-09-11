# GeoGuesser: party edition

A GeoGuessr-style pub quiz round. Teams guess where each photo was taken by dropping a pin on a map. The closest team wins each round.

## Run it

```bash
npm install
npm start
```

The terminal prints the addresses, for example:

```
This computer:    http://localhost:3000
Same network:     http://192.168.1.23:3000
Presenter screen: http://localhost:3000/display.html
```

## On the night

1. Go to `http://localhost:3000` and log in as **kawaiifreak97**. That takes you to the admin page.
2. Add your photos. For each one: drop in the image, set the location (click the map, paste `lat, lng`, or let it read the photo's GPS), give it a description for the reveal, then drag the rounds into order.
3. Click **Open presenter screen**, move that window to the big monitor and press ⛶ (or `F`) for fullscreen.
4. Teams scan the QR code on the monitor (or type the URL) and enter a team name.
5. Press **Space** on the presenter screen (or click the button at the top) to start the game and to go to each next round.

During a round the monitor shows the photo and a countdown. Teams drop a pin and submit. A pin dropped but not submitted still counts when time runs out. The round ends early once every team has locked in. After each round the monitor shows everyone's pins, the real spot, the distances, and who won the point.

## Hosted on Render (free)

The live site runs on Render's free plan from the GitHub repo, so phones can join on mobile data or any Wi-Fi. Code changes go live with `npm run deploy`, which commits and pushes. Render redeploys in about 2 minutes.

## Game templates + Firebase

The admin page has a **Game** dropdown with New, Duplicate, Rename and Delete. Each game is its own ordered set of photo rounds, and the selected game is the one that plays when you press Start.

Games, settings and photos are stored in **Firebase Firestore** when a Firebase key is present. That works on the free Spark plan, and photos are split into chunks under Firestore's 1 MB limit. Without a key, everything is stored in local files instead. Render's free plan wipes those whenever it restarts, so connect Firebase before adding rounds on the live site.

Setup:

1. https://console.firebase.google.com: open your project (or add one).
2. **Build > Firestore Database > Create database**. Choose production mode and a location near you, e.g. `australia-southeast1`. The locked-down production rules are fine, because only the server talks to Firebase.
3. **Project settings (⚙) > Service accounts > Generate new private key**. Save the file as `firebase-service-account.json` in this folder. It's gitignored; never commit it.
4. On Render, open the service, go to **Environment > Secret Files > Add**. Name it `firebase-service-account.json`, paste the file's contents and save. The site restarts using Firebase.

The server log and the admin page ("Saved in Firebase ✓") show which storage is in use. Scores and teams are only kept in memory during a game, which is fine for one evening.

**Free instances sleep after 15 minutes with no visitors.** Open the site about a minute before the quiz so it's awake. While people are playing it stays up.

## Notes

- **Internet:** map tiles load from the internet.
- **Street map key:** CARTO's street map needs a free key from https://carto.com/basemaps/apikey. Paste it into admin → Settings → "Street map key" on your laptop, then run `npm run deploy`. Or set `CARTO_KEY` in the Render service's Environment tab. The satellite view needs no key.
- **iPhone photos:** use JPG, not HEIC. HEIC doesn't display in most browsers.
- Everything is saved in `data/` and `uploads/`. If the server restarts mid-game, scores are kept. To start fresh, delete `data/game.json`.
- The same team name on a second phone joins the same team. Refreshing the page keeps you in the game.
