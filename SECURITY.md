# Security

Kairos Kit runs on the user's own Mac and keeps the user's career record in a
local folder. It reads text it does not control (job postings, application
forms, web pages) and writes documents that go out under the user's name. How
it is protected is described in [docs/architecture.md](docs/architecture.md#controls).

## Reporting a problem

Please report a vulnerability privately through GitHub: **Security › Report a
vulnerability** on this repository. Do not open a public issue for it.

Include what you did, what happened, and the commit you tested. This is a
personal project maintained by one person, and there is no bounty.

## In scope

- A job posting, form or web page that gets a fact into the user's record, a
  document or a form without the user's approval.
- Reading or sending a file outside the documents the user gave the kit.
- Reaching the dashboard, its API or the extension's endpoints from another
  website or another computer.
- A link that makes the kit fetch an address on the user's computer or local
  network.
- Personal data in this repository.

## Known limits

These are known and accepted for a single-user tool on the user's own Mac.

- **The data folder is not encrypted by the kit.** It relies on the macOS
  account and FileVault. `install.sh` creates it readable by the user only, and
  warns when an existing folder is readable by other accounts.
- **Claude Code's own permissions are the user's.** The kit cannot stop the user
  from approving a tool call, or from setting a hook that answers Kairos's save
  confirmations automatically. The confirmations need a Claude Code version
  that supports MCP elicitation; without it, nothing is saved.
- **Other programs running as the user** can read the data folder and the token
  files, and change it between the kit's checks and its writes. The kit does
  not defend against software already on the computer.
- **A job site's page can read what is filled** into its form before you
  submit. The fill uses only values from your profile, but a hostile site
  could still read them. Fill forms only on job sites you trust.
- **Cover letters** are checked for made-up numbers, not for every claim. Read
  each letter before you use it.
- **Link checks resolve the name once.** A host whose address changes between
  the check and the request is not caught.
- **Dependencies.** The kit takes npm's non-breaking security fixes on every
  release. An advisory that needs a breaking upgrade stays listed by
  `npm audit` until that upgrade is done.
- **The daily search** stores a Claude Code token for unattended runs in
  `~/.config/kairos/claude-oauth-token`; the getting-started guide has the user
  make it readable by them only.
