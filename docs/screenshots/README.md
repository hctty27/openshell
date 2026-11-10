# OpenShell screenshot refresh

This folder contains real screenshots of the shipped Windows application. Do not use generated or composited mock interfaces.

## Capture baseline

- Capture from the current stable Windows build after confirming the feature works.
- Use a 1600 × 900 (16:9) application window where possible.
- Prefer WebP, quality 82–88, with a target of 300–450 KB per image.
- Keep the complete application frame visible for the main overview; crop only when a detail view needs a closer look.
- Use a dedicated demo server and synthetic file names. Remove real hostnames, IP addresses, usernames, file paths, tokens, API keys, database contents, and personal data.
- Keep the same application theme, window size, and scale across the set.
- Do not add fake UI, fake progress, fabricated model output, or unsupported feature claims.

## Required capture set

| File | Scene | What it should prove |
| --- | --- | --- |
| `01-workspace-overview.webp` | Main workspace | Session tree, SSH tabs, terminal, and overall application layout |
| `02-split-terminals.webp` | Split workspace | Two real SSH sessions in horizontal or vertical split view |
| `03-ai-assistant.webp` | Global AI assistant | Configured model label, selected SSH session(s), and a short non-sensitive task/result |
| `04-sftp-file-manager.webp` | SFTP manager | Local and remote panes, multi-selection, and transfer queue |
| `05-native-zmodem-transfer.webp` | Transfer center | Real multi-file `rz` / `sz` transfer with file names, sizes, and progress |
| `06-terminal-ai-database.webp` | Terminal AI | A safe read-only interaction in MySQL, Redis, PostgreSQL (`psql`), or Python |

## Where each image is used

- `01-workspace-overview.webp`: README first screenshot and website hero.
- `02-split-terminals.webp`, `03-ai-assistant.webp`, `04-sftp-file-manager.webp`, `05-native-zmodem-transfer.webp`, `06-terminal-ai-database.webp`: README feature gallery and website showcase.
- GitHub repository Social Preview: a separate 1280 × 640 PNG/JPG/GIF under 1 MB. Prefer the approved workspace screenshot with a concise brand treatment; this image is uploaded in repository Settings and is separate from the website's `og:image`.

## Current status

The existing `02-ssh-sftp.webp` is retained so current README and website links do not break. It was added on 2026-10-26 and predates the recent v1.0 feature and UI updates. Replace its references only after the new real screenshots have been captured and reviewed. Do not rename or remove it before all public references have moved.
