# Karaoke App

A simple karaoke queue for live band karaoke nights.

- **Display screen**: shows the current singer and song on a big monitor, a scrolling ticker of who's up next, and QR codes for the song list and for tipping the band.
- **Admin console**: add singers and their songs, move singers up or down in the queue, remove singers, and click **Next Singer** to bring the next person on stage.

When adding new singer and song title, it will save it onto `queue.json`.

Completed performances are saved to `history.csv`.

## Requirements

- [Node.js](https://nodejs.org) (download and install the LTS version)

## How to run

1. Open a terminal and go to the app folder:
   ```
   cd karaoke-app
   ```
2. Set up the project (first time only):
   ```
   npm init -y
   npm install express
   ```
3. Start the app:
   ```
   node server.js
   ```
4. Open in your browser:
   - Admin console: http://localhost:3000
   - Display screen: http://localhost:3000/?view=display (or click **Open Public Display Screen** in the admin console)

   Drag the display screen to your big monitor and make it full screen.

5. To stop the app, press `Ctrl+C` in the terminal.

## Alternate start up (auto-restart with nodemon)

[nodemon](https://nodemon.io) restarts the app automatically whenever you edit `server.js`, which is handy while making changes.

1. Install Express:
   ```
   npm install express
   ```
2. Install nodemon (first time only):
   ```
   npm install -g nodemon
   ```
3. Start the app:
   ```
   nodemon server.js
   ```

Tip: the app saves the queue to `queue.json` every time it changes, which makes nodemon restart the app. To avoid that, start it with:
```
nodemon --ignore queue.json server.js
```

## Using another device (iPad, phone)

Devices on the same Wi-Fi network can open the app at `http://<your-computer's-IP-address>:3000`.

## Example Screenshots

### Admin Console

![Admin Console](./images/admin_console.png)

### Public Display

![Public Display](./images/public_display.png)