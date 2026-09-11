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

The live site runs on Render's free plan from the GitHub repo, so phones can join on mobile data or any Wi-Fi.

**Render's free disk is wiped whenever the server restarts or sleeps.** So set up rounds on your laptop, not on the live site:

1. `npm start`, open `http://localhost:3000`, log in as admin and add, edit or reorder rounds.
2. `npm run deploy` commits the photos and rounds and pushes them. Render redeploys automatically in about 2 minutes.

The live admin page shows a warning banner as a reminder. Scores and teams are only kept in memory during the game, which is fine for one evening.

**Free instances sleep after 15 minutes with no visitors.** Open the site about a minute before the quiz so it's awake. While people are playing it stays up.

## Notes

- **Internet:** map tiles load from the internet.
- **iPhone photos:** use JPG, not HEIC. HEIC doesn't display in most browsers.
- Everything is saved in `data/` and `uploads/`. If the server restarts mid-game, scores are kept. To start fresh, delete `data/game.json`.
- The same team name on a second phone joins the same team. Refreshing the page keeps you in the game.
