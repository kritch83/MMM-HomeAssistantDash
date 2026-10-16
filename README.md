# MMM-HomeAssistantDash

A [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) module that **mirrors a Home Assistant dashboard**. It reads the dashboard's own layout from Home Assistant, draws its cards in MagicMirror style (white on black), and keeps every value live over HA's WebSocket API.

Change the dashboard in Home Assistant and the mirror follows; there's no list of entities to keep in sync in `config.js`.

## How it works

```
browser (MMM-HomeAssistantDash.js)  ⇄  node_helper.js  ⇄  Home Assistant /api/websocket
                                       ├ lovelace/config                → which cards, which entities
                                       ├ subscribe_entities             → live states (pushed, not polled)
                                       ├ recorder/statistics_during_period → chart data
                                       └ lovelace_updated / hourly-statistics events → redraw / refresh
```

The access token stays on the server side: MagicMirror sends the browser `**SECRET_HA_TOKEN**`, and only the node_helper sees the real value.

## Requirements

- MagicMirror² 2.38 or newer (Node.js 22+)
- Home Assistant with the dashboard you want to show

## 1. Create a Home Assistant user for the mirror

The mirror only reads, so give it its own non-admin login:

1. **Settings → People → Add person**: name it `mirror`, turn on **Allow login**, leave **Administrator** off. Optionally turn on **Can only log in from the local network**.
2. Log in as `mirror` (a private browser window is easiest), open **Profile → Security → Long-lived access tokens → Create token**, and copy the token.

## 2. Install on the mirror

The repository is private, so the Pi needs read access to it before it can clone. Pick one of the two options below.

### Option A: deploy key (recommended)

A deploy key gives the Pi read-only access to this one repository and nothing else on your GitHub account.

On the Pi, create a key and print its public half:

```bash
ssh-keygen -t ed25519 -N "" -C "magicmirror" -f ~/.ssh/mmm_homeassistantdash
cat ~/.ssh/mmm_homeassistantdash.pub
```

On GitHub, open the repository's **Settings → Deploy keys → Add deploy key**, paste the key, and leave **Allow write access** off.

Back on the Pi, tell SSH to use that key for this repository by adding this to `~/.ssh/config`:

```
Host github-mmm-had
  HostName github.com
  User git
  IdentityFile ~/.ssh/mmm_homeassistantdash
  IdentitiesOnly yes
```

Then clone through that host alias. The first connection asks you to confirm GitHub's host key; answer `yes`.

```bash
cd ~/MagicMirror/modules && git clone git@github-mmm-had:kritch83/MMM-HomeAssistantDash.git
```

### Option B: GitHub CLI

Simpler, but `gh auth login` gives the Pi access to everything your GitHub account can reach, not just this repository.

```bash
sudo apt install gh
gh auth login
cd ~/MagicMirror/modules && gh repo clone kritch83/MMM-HomeAssistantDash
```

### Install the dependencies

Either way, finish with:

```bash
cd ~/MagicMirror/modules/MMM-HomeAssistantDash && npm install --omit=dev
```

### Updating later

```bash
cd ~/MagicMirror/modules/MMM-HomeAssistantDash && git pull && npm install --omit=dev
```

Then restart MagicMirror (for example `pm2 restart MagicMirror` if you run it with pm2).

## 3. Configure

Put the token in `~/MagicMirror/config/config.env` (create the file if needed):

```
SECRET_HA_TOKEN=paste-the-token-here
```

Add the module to `~/MagicMirror/config/config.js`:

```js
{
	module: "MMM-HomeAssistantDash",
	position: "middle_center",
	config: {
		url: "http://10.0.0.16:8123",
		token: "${SECRET_HA_TOKEN}",
		dashboard: "dashboard-ev",
		columns: 2,
		width: "760px"
	}
},
```

Restart MagicMirror.

### Options

| Option | Default | Description |
|---|---|---|
| `url` | `http://homeassistant.local:8123` | Home Assistant base URL. |
| `token` | `""` | Long-lived access token. Use `"${SECRET_HA_TOKEN}"` with `config.env` as above. |
| `dashboard` | `"lovelace"` | The dashboard's URL path, the part after the host: `http://10.0.0.16:8123/dashboard-ev/0` → `dashboard-ev`. `lovelace` is the default Overview. |
| `view` | `0` | View index (the `/0` in the URL) or the view's `path`. |
| `columns` | `1` | Sections side by side. `1` stacks them (good for side regions); `2`–`4` for `middle_center`, `lower_third`, `bottom_bar`. A section's own *column span* is kept up to this number. |
| `width` | `null` | CSS width of the module, e.g. `"760px"`. |
| `hideDefaultHeadings` | `true` | Hide section headings still named "New section". |
| `statsRefreshMinutes` | `15` | Fallback refresh for charts. HA also tells the module when new hourly statistics exist. `0` disables the timer. |
| `updateThrottleMs` | `1000` | Redraw at most this often while values stream in. |

## Supported cards

| Card | On the mirror |
|---|---|
| `heading` | Section heading (MagicMirror header style). |
| `tile`, `entity`, `sensor` | Icon, name and state, formatted with the entity's display precision (e.g. 9.576 → `9.58 kWh`). Tile toggles are shown as state only; the mirror never changes anything in HA. |
| `gauge`, `custom:modern-circular-gauge` | Ring gauge with min/max (numbers or entity ids), decimals, unit, colors, severity/segments, and the modern-circular-gauge's inner `secondary` ring. |
| `statistics-graph` | Bar or line chart using the card's `days_to_show`, `period` and `stat_types`. `sum` is plotted relative to the start of the window, exactly like HA does. For energy per day, set the card's statistic type to **Change** in HA. |
| `entities`, `glance` | List of rows. |
| `vertical-stack`, `horizontal-stack`, `grid`, `conditional` | Their cards are drawn in place. |
| Anything else with an `entity`/`entities` | Drawn as simple rows. Cards without entities (markdown, etc.) are skipped and listed in the MagicMirror log. |

Sections, masonry and panel views all work. Auto-generated dashboards (strategies) need **Take control** in HA first.

## Troubleshooting

| Message on the mirror | Fix |
|---|---|
| `Home Assistant rejected the access token.` | Create a new token for the `mirror` user. The module deliberately does **not** retry, so a bad token can't get the mirror's IP banned by HA's `ip_ban_enabled`. Restart MagicMirror after fixing it. |
| `No access token…` | `config.env` is missing `SECRET_HA_TOKEN`, or `token` in `config.js` isn't `"${SECRET_HA_TOKEN}"`. Secrets don't work with `cors: "allowAll"`. |
| `Dashboard "…" not found, or it has never been edited.` | Check the `dashboard` url path. A UI dashboard that was never edited has no stored config yet; edit and save it once. |
| `Lost connection to Home Assistant, reconnecting…` | Values dim while HA is unreachable and recover by themselves. |

## Development

```bash
npm install
npm test                                     # unit tests + a fake HA WebSocket server
node --env-file=.env.local scripts/probe.js  # check the real HA from the command line
node test/helpers/fake-ha.js 8124 dev-token  # fake HA with a simulated charging session
```

`scripts/probe.js` reads `SECRET_HA_TOKEN` (and optionally `HA_URL`) from the environment, prints the parsed layout, current states and chart series, and never prints the token. `.env.local` is git-ignored.

| File | Role |
|---|---|
| `MMM-HomeAssistantDash.js` | MagicMirror module: config, socket messages, throttled redraws. |
| `renderers.js` | Draws cards, SVG gauges and charts in the browser. |
| `node_helper.js` | One HA session per module instance; forwards layout/states/stats. |
| `lib/session.js` | HA side: layout, entity subscription, statistics, reconnects. |
| `lib/layout.js` | Lovelace config → normalized cards + entity list (pure). |
| `lib/entities.js` | Applies `subscribe_entities` diffs (pure). |
| `lib/stats.js` | Statistics request/series shaping (pure). |
| `lib/connection.js` | Shared WebSocket connections per (url, token). |
