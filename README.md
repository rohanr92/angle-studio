# Angle Studio

A small local tool that turns 1–2 reference product photos into a full set of
e-commerce angle shots (front, back, side, 3/4, top-down, detail close-up —
fully editable) using **Freepik's Nano Banana Pro API**, at 4:5 / 2K by
default (Nordstrom's standard).

## 1. Install

```bash
cd freepik-angle-studio
npm install
```

Requires Node 18+.

## 2. Add your API key

A `.env` file is already included with the key you shared, so it will run
out of the box. If you ever need to change it:

```
FREEPIK_API_KEY=your_key_here
```

**Security note:** that key was pasted in plain text in our chat, so
consider rotating it from your [Freepik dashboard](https://www.freepik.com/developers/dashboard)
once you're set up, and never commit `.env` to a public repo — it's already
in `.gitignore`.

The `FREEPIK_WEBHOOK_SECRET` in `.env` isn't used yet — this tool polls
Freepik for task status instead of receiving webhooks, since polling doesn't
need a public URL. If you later want instant webhook-based updates instead
of polling, you'd expose this server with something like `ngrok` and add a
`/api/webhook` route that verifies that secret.

## 3. Run it

```bash
npm start
```

Open **http://localhost:5050**.

## 4. Use it

1. **The brief** — one sentence describing the product and look (background,
   lighting, style). You don't need to mention angles here.
2. **Angle set** — edit the default six angle chips (Front, Back, Side,
   3/4, Top-Down, Detail Close-up), remove any, or add your own.
3. **Reference product** — drop in 1–2 real photos of the product. Every
   angle is generated from these, so the AI keeps the same product.
4. **Output spec** — model, aspect ratio (4:5 is Nordstrom's default), and
   resolution (2K by default — Nano Banana Pro also supports 1K and 4K if
   you want to change `resolutionSelect`'s options later).
5. Press **Develop set**. Each angle is requested independently, so frames
   fill in on the contact sheet as they finish rather than all at once.
6. Download images individually, or **Download all (.zip)** once at least
   one frame is done.

## How it talks to Freepik

- `POST /v1/ai/text-to-image/{model}` creates a generation task, passing
  your reference photos as base64 in `reference_images` plus your prompt,
  `aspect_ratio`, and `resolution`.
- The server polls `GET /v1/ai/text-to-image/{model}/{task_id}` every ~2.5s
  until the task is `COMPLETED` (or `FAILED`), then returns the image URL
  to the browser.
- `model` can be `nano-banana-pro` (default, highest quality) or
  `nano-banana-pro-flash` (faster/cheaper) — pick either from the Model
  dropdown.

Reference: https://docs.freepik.com/api-reference/text-to-image

## If a generation fails

The failed frame will show the error Freepik returned (bad API key, out of
credits, rate limited, etc.) right on its contact-sheet cell — no need to
check the terminal, though the full error is also logged there.

## Project structure

```
freepik-angle-studio/
├─ server.js          Express backend — talks to Freepik, zips downloads
├─ public/
│  ├─ index.html       UI shell
│  ├─ style.css         Contact-sheet styling
│  └─ app.js            Frontend logic
├─ .env                 Your API key (gitignored)
├─ .env.example
└─ package.json
```
