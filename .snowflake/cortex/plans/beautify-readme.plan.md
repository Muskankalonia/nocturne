# Plan: Beautify README.md

## Context

The existing README is technically thorough (778 lines) but lacks visual appeal and quick-start guidance. The repo also has content not reflected in the README: a Next.js dashboard (`nocturne_dashboard/`), architecture docs, scripts, examples, CI, and step 16.

The user provided a logo at `assets/nocturne-logo.png` and wants a Quickstart section (clone to first result in under 5 commands).

## Implementation Steps

### 1. Save the logo and reference it

Place the logo at `assets/nocturne-logo.png`. At the top of the README, center it with:

```markdown
<p align="center">
  <img src="assets/nocturne-logo.png" alt="Nocturne" width="400">
</p>
```

### 2. New header block (replaces bare `# Nocturne`)

```markdown
<p align="center">
  <img src="assets/nocturne-logo.png" alt="Nocturne" width="400">
</p>

<h3 align="center">Dark-web breach intelligence, from crawl to analyst dashboard</h3>

<p align="center">
  Bounded Tor crawler &rarr; GCS landing &rarr; Snowflake AI pipeline &rarr; Next.js console
</p>
```

### 3. Table of Contents

Clickable anchor links to all major sections. Placed immediately after the header.

### 4. Quickstart section (5 commands)

Target audience: someone who cloned the repo and wants to see end-to-end output fast.

```markdown
## Quickstart

```bash
git clone https://github.com/Muskankalonia/nocturne.git && cd nocturne
python -m venv .venv && .venv/Scripts/activate && pip install -r requirements.txt
docker build -t nocturne-crawler:local . && docker run --rm -v "$PWD/output:/tmp/scraped_pages" -e MAX_DEPTH=0 -e MAX_PAGES=1 nocturne-crawler:local
pip install -r snowflake/requirements.txt && cp .env.example .env  # fill credentials
python deploy_pipeline.py
```

This crawls one page locally, then deploys the full Snowflake pipeline against your landing data.
```

### 5. Updated repository layout tree

Add: `assets/`, `nocturne_dashboard/`, `scripts/`, `examples/`, `plans/`, `.github/workflows/`, `architecture.md`, and `snowflake/16_dashboard_interface.sql`.

### 6. Architecture section (new, after repo layout)

Short paragraph + inline mermaid diagram of the 5-stage flow (Collect -> Land -> Cascade -> Score -> Serve), with a link to `architecture.md` for the full deep-dive.

### 7. Dashboard section (new)

Brief mention of the Next.js analyst console with a quick-start command and pointer to `nocturne_dashboard/README.md`.

### 8. Add step 16 to the Snowflake pipeline table

| 16 | `16_dashboard_interface.sql` | Creates views and interfaces consumed by the analyst dashboard. |

### 9. Formatting pass

- Horizontal rules (`---`) between major sections
- Wrap long GCP deploy steps (1-7) and optional scheduling in `<details>` blocks
- Consistent single blank lines between sections
- Remove double blank lines

### 10. Footer

- Contributing stub ("PRs welcome. Open an issue first for non-trivial changes.")
- License placeholder
- Quick links to architecture.md, nocturne_dashboard/README.md

## Verification

- Open the rewritten README on GitHub (or preview locally with `grip`) and confirm:
  - Logo renders centered
  - TOC links resolve
  - Mermaid diagram renders
  - `<details>` blocks collapse/expand
  - No broken relative links

## Critical Files

- [README.md](README.md) - The file being rewritten
- [assets/nocturne-logo.png](assets/nocturne-logo.png) - Logo to be saved from user's image
- [architecture.md](architecture.md) - Referenced for the architecture deep-link
- [nocturne_dashboard/README.md](nocturne_dashboard/README.md) - Referenced for dashboard section
- [snowflake/16_dashboard_interface.sql](snowflake/16_dashboard_interface.sql) - Step 16 to add to table
