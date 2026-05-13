# hetzner-auto-rescale

Pollt die Hetzner Cloud API und rescaled markierte Server automatisch auf den ersten verfügbaren Typ aus einer priorisierten Liste, sobald dieser im Datacenter des Servers `available_for_migration` ist.

> [!WARNING]
> **Disclaimer**
>
> Dieses Projekt steht in **keinerlei Verbindung zu Hetzner Online GmbH oder Hetzner Cloud**. Es ist ein rein privates Tool, das die öffentliche Hetzner Cloud API von außen anspricht. „Hetzner" ist hier ausschließlich beschreibend gemeint.
>
> Das Projekt ist außerdem **komplett gevibed** — also größtenteils mit einem LLM zusammengeschoben statt klassisch ausentwickelt. Es gibt keine Tests, keine produktionsreife Härtung und keine Garantie, dass es in Edge-Cases das Richtige tut. Vor produktivem Einsatz: Code lesen, mit `DRY_RUN=true` testen und im Zweifel selber Hand anlegen. Nutzung auf eigene Verantwortung.

## Konfiguration per Label

Statt feste IDs/Target-Listen in ENV-Vars zu hinterlegen, liest der Service die Konfiguration aus einem Label am Server in der Hetzner Console:

| Label                              | Bedeutung                                                                |
|------------------------------------|---------------------------------------------------------------------------|
| `hetzner-auto-rescale/targets`     | Priorisierte Liste der gewünschten Ziel-Server-Typen, durch `_` getrennt |

Beispielwert: `ccx33_ccx23` (versuche `ccx33`, fallback `ccx23`).

> Hetzner-Label-Werte dürfen nur `[a-zA-Z0-9_.-]` enthalten, daher als Separator `_` (anpassbar über `TARGETS_SEPARATOR`).

Der Service iteriert über **alle** Server im Projekt mit diesem Label-Key. Ein einzelner Container kann also beliebig viele Server verwalten — einfach Label setzen, Container läuft schon.

## Ablauf

In jedem Poll-Intervall:
1. Hetzner API nach allen Servern mit dem Label-Key fragen (`label_selector`)
2. Pro Server: Datacenter-Availability prüfen
3. Falls ein Ziel-Typ verfügbar ist:
   - Server-Status merken (`running` / `off`)
   - Falls `running`: `poweroff` → auf Action-Erfolg warten
   - `change_type` mit `upgrade_disk: false` (damit später Downgrades möglich bleiben)
   - Falls vorher `running`: `poweron`
   - **Label am Server entfernen**, damit dieser Server nicht erneut behandelt wird
   - Notification senden (siehe unten)
4. Wenn ein Server bereits an einem Ziel-Typ hängt: Label wird sofort entfernt

Der Service läuft dauerhaft und pollt weiter, auch wenn aktuell kein Server markiert ist. Schlägt eine Iteration fehl (z. B. API-Hänger), wird sie geloggt und beim nächsten Intervall neu versucht.

## Notifications

Notifications werden an folgenden Stellen ausgelöst:

- **Beim Start** des Services (einmaliger Test, abschaltbar via `NOTIFY_ON_START=false`)
- **Bei erfolgreichem Rescale** eines Servers
- **Bei Fehlern** während des Pollings oder Rescales — mit Cooldown gegen Spam (`ERROR_NOTIFY_COOLDOWN_SECONDS`, default 1800s pro identischer Fehlermeldung+Kontext)

Unterstützte Kanäle (beliebig kombinierbar; ohne Konfiguration kein Versand):

| Kanal | Aktivierung | Authentifizierung |
|-------|-------------|--------------------|
| [ntfy](https://ntfy.sh) | `NTFY_TOPIC` (+ optional `NTFY_SERVER` für self-hosted) | `NTFY_TOKEN` oder `NTFY_USER`+`NTFY_PASSWORD` |
| [Pushover](https://pushover.net) | `PUSHOVER_TOKEN` (App-API-Token) + `PUSHOVER_USER` (User/Group-Key) | über die beiden Werte selbst | 

## Typen

Der HTTP-Client wird typsicher aus der gepflegten OpenAPI-Spezifikation [MaximilianKoestler/hcloud-openapi](https://github.com/MaximilianKoestler/hcloud-openapi) generiert (`pnpm generate`). Es gibt kein offizielles Hetzner-Node-SDK; das ist der saubere Mittelweg.

## ENV-Konfiguration

Siehe `.env.example`. Pflicht: `HCLOUD_TOKEN`. Optional u. a. `LABEL_KEY`, `TARGETS_SEPARATOR`, `POLL_INTERVAL_SECONDS`, `NTFY_TOPIC`, `NTFY_TOKEN`, `DRY_RUN`.

## Lokal entwickeln

```bash
pnpm install
pnpm generate     # OpenAPI-Spec ziehen und TS-Typen generieren
pnpm typecheck
pnpm dev
```

## Mit Docker

Auf deinem Server reicht das `docker-compose.yml` aus diesem Repo (oder einfach manuell anlegen) plus eine `.env`:

```bash
mkdir hetzner-auto-rescale && cd hetzner-auto-rescale
curl -fsSLO https://raw.githubusercontent.com/patrickhilker/hetzner-auto-rescale/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/patrickhilker/hetzner-auto-rescale/main/.env.example
mv .env.example .env
# .env ausfüllen (HCLOUD_TOKEN reicht für den ersten Test)
docker compose up -d
docker compose logs -f
```

Das Compose-File zieht das fertige Image aus dem GitHub Container Registry (`ghcr.io/patrickhilker/hetzner-auto-rescale:latest`, multi-arch amd64+arm64) und läuft mit `restart: unless-stopped`. Bei jedem `docker compose up` wird durch `pull_policy: always` automatisch die aktuelle Version gezogen.

Builds passieren via GitHub Actions automatisch für jeden Push auf `main` (Tags: `latest`, `main`, `sha-<short>`) und für Release-Tags wie `v1.2.3`.

Alternativ ohne Compose:

```bash
docker run -d --name hetzner-auto-rescale --restart unless-stopped \
  --env-file .env ghcr.io/patrickhilker/hetzner-auto-rescale:latest
```
