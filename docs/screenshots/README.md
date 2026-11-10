# OpenShell screenshot assets

This directory contains the approved screenshots of the shipped Windows application. The six product screenshots are the original PNG files supplied by the maintainer.

## Approved assets

| File | Scene | Dimensions |
| --- | --- | ---: |
| `01-workspace-overview.png` | Main workspace: SSH, SFTP and AI | 1600 × 900 |
| `02-split-terminals.png` | Multiple SSH sessions in split panes | 1600 × 900 |
| `03-ai-assistant.png` | Global AI assistant | 1600 × 900 |
| `04-sftp-file-manager.png` | Local and remote SFTP manager | 1600 × 900 |
| `05-native-zmodem-transfer.png` | Native Rust ZMODEM multi-file transfer | 1600 × 900 |
| `06-terminal-ai-database.png` | Terminal AI with MySQL | 1600 × 900 |
| `github-social-preview.png` | GitHub and website social preview | 1280 × 640 |

## Asset handling

- Keep the six approved product screenshots byte-for-byte as supplied.
- Do not redact, blur, crop, retouch, composite, or re-encode these approved images.
- Do not replace the real application interface with generated or mock UI.
- Link to the PNG files directly from the README and the website.
- The website is deployed from the `website/` directory, so it references the repository screenshots through `raw.githubusercontent.com`.
- The social preview is a separate 1280 × 640 PNG under 1 MB. The website uses it for Open Graph and Twitter cards; GitHub repository Social Preview is configured separately in repository settings.

## Public placements

- `01-workspace-overview.png`: README lead image and website hero.
- `02-split-terminals.png`: SSH split-terminal feature.
- `03-ai-assistant.png`: global AI assistant feature.
- `04-sftp-file-manager.png`: SFTP file manager feature.
- `05-native-zmodem-transfer.png`: native ZMODEM feature.
- `06-terminal-ai-database.png`: Terminal AI feature.
- `github-social-preview.png`: website Open Graph / Twitter image and GitHub repository Social Preview upload.

The legacy `02-ssh-sftp.webp` remains in the repository for backward compatibility, but it is no longer used by the current README or website.
