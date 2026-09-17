# Brand & License Clearance (owner decision gate)

Sanitized pre-public-release record. This document records what was and
was not established; it does **not** make a legal conclusion and does **not**
authorize a rename or a license choice on the owner's behalf.

Initial pre-screen search date: 2026-09-06 (exact-name pre-screen +
candidate shortlist). Official USPTO comparative screen (section 4)
subsequently completed and recorded here.

## Canonical brand decision state

Single authoritative machine-readable brand state. Every other section of
this document and every report must reference this state and must not
repeat candidate names or order.

```
FINAL_BRAND                 = MailGable
BRAND_GATE                  = RESOLVED (owner decision, 2026-09-15)
FINAL_BRAND_STATUS          = PRELIMINARY_SEARCH_CLEAR

REJECTED                    = MailPerch, Inboxwright, InboxFoundry
FORMER_PROVISIONAL_BRAND    = MailPerch

OWNER_BRAND_SELECTION       = COMPLETE
LEGAL_CONCLUSION            = NONE
```

Rationale:

* **MailGable** is the owner-selected final brand (2026-09-15). Machine screen
  record: GitHub exact repository/user search 0/0, npm/PyPI/crates.io 404,
  Docker Hub namespace unregistered, `.com/.dev/.app/.io` available (RDAP),
  no exact-name web product signal, no exact USPTO signal. Component-level
  note: the standalone word **Gable** is used by unrelated third-party
  products (a workplace platform with mailroom tooling at `gable.to`, and a
  registered signage mark at `gablecompany.com`) — a similarity-search
  signal, not a legal conclusion.
* **Inboxstead** is the engineering first candidate. The completed official
  USPTO comparative screen found zero exact records and no material signal;
  no related-field software/email signal was found. Engineering status is
  therefore LOW-REVIEW / NO_MATERIAL_SIGNAL_FOUND — not a legal clearance.
* **MailDory** is the counsel-review alternative, not an auto-select
  candidate. The standalone component **DORY** is actively used by live
  software/SaaS products (five live serials recorded in section 4), which is
  a similarity-search signal. Engineering risk: HIGH-REVIEW.
* **Inboxwright** is rejected: completed common-law research found active
  related-field use around email/inbox management. Do not recommend.
* **InboxFoundry** is rejected: related-field signal (email-marketing
  podcast/community) and `inboxfoundry.com` registered.
* **MailPerch** (former provisional brand) carries an exact-name commercial
  conflict signal: a live primary email product uses the name
  (`getmailperch.com`, © 2026). Do not publish v0.1.0 under it by default.
* **Courierquill** remains reserve only; no new screen has been performed.

## Rejected names (not screened further)

| Name | Reason |
| :--- | :--- |
| MailPerch | exact-name commercial email conflict signal |
| Inboxwright | active related-field use around email/inbox management (common-law) |
| InboxFoundry | related-field signal: email-marketing podcast/community; `inboxfoundry.com` registered |
| Poststead | active email/digest product |
| Letterdock | active digital-address/mail-related service |
| Ternbox | existing unrelated historical identity/name usage |
| Mailwright / MailWeave / Inboxweave | GitHub exact/similar repository collisions |

## Candidate screening matrix (historical evidence only)

Candidates were screened on: GitHub exact name (repos/descriptions/users),
general web exact name, domain availability (RDAP), and package ecosystems
(npm / PyPI / Docker Hub). The official USPTO comparative screen is recorded
separately in section 4. This table is historical research evidence; the
current engineering state is the Canonical brand decision state above.

| Candidate | GitHub | Web | Domains | Packages | Semantic fit | Risk |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Inboxstead | NONE | no meaningful hits | `inboxstead.com` REGISTERED; .dev/.app AVAILABLE | NONE | good (inbox + stead) | LOW-REVIEW / NO MATERIAL SIGNAL FOUND |
| MailDory | NONE (only an unrelated GitHub user `maildoryza`) | no meaningful hits (DORY component has active software use — a similarity-search signal) | `maildory.com` NOT_FOUND_IN_REGISTRY (authoritative Verisign RDAP 404); .dev/.app/.io AVAILABLE | NONE | good (mail + dory, pronounceable) | HIGH-REVIEW (counsel-review option only) |
| Courierquill | NONE | — | — | — | good | RESERVE ONLY |
| Inboxwright | NONE | related-field use around email/inbox management | — | — | good | REJECTED / DO NOT RECOMMEND |
| InboxFoundry | NONE | related-field signal: "Inbox Foundry" email-marketing podcast/community; `inboxfoundry.com` REGISTERED | .dev/.app AVAILABLE | NONE | good | REJECTED |

## Official trademark pre-screen (USPTO / WIPO)

### USPTO — completed comparative screen

The official USPTO Trademark Search is an interactive browser interface; it
is never inferred from web indexing. The comparative screen for the
engineering first candidate and the counsel-review alternative has been
completed and recorded below. Query set: exact-name queries
(`INBOXSTEAD`, `MAIL DORY`, `MAILDORY`, `DORY`, `DORY MAIL`) plus
similar-sounding/appearance/meaning/commercial-impression passes across
related goods/services (software, SaaS, cloud, database, developer,
communications, email software, email management, email delivery, mailbox
software, online software services — not a single class).

```
USPTO_SCREEN_POLICY    = REQUIRED_BEFORE_FINAL_US_BRAND_SELECTION
USPTO_EXECUTION_STATE  = COMPLETED

INBOXSTEAD_EXACT_USPTO = 0 RECORDS
INBOXSTEAD_USPTO_RESULT = NO_MATERIAL_SIGNAL
INBOXSTEAD_RELATED_SOFTWARE_EMAIL_SIGNAL = NONE MATERIAL FOUND

MAILDORY_EXACT_USPTO  = 0 RECORDS
MAILDORY_USPTO_RESULT = REVIEW_SIGNAL
MAILDORY_ENGINEERING_RISK = HIGH-REVIEW
```

The five already-confirmed live DORY software/SaaS USPTO serials (evidence
of active related-field DORY use, not a legal conclusion):

```
DORY_LIVE_SERIALS = 97891770, 79335323, 99395763, 88871643, 98361363
```

Correct engineering interpretation:

* **Inboxstead** — preferred engineering candidate
* **MailDory** — counsel-review alternative; do not auto-select
* `LEGAL_CONCLUSION = NONE`

This document does **not** state: TRADEMARK CLEAR, LEGAL SAFE, USPTO
APPROVED, or GUARANTEED REGISTRABLE.

### WIPO

```
WIPO_SCREEN_POLICY     = RECOMMENDED_ADDITIONAL_SIGNAL
WIPO_RELEASE_BLOCKING  = NO_FOR_US_FOCUSED_RELEASE
                         (YES_IF_INTERNATIONAL_COMMERCIAL_LAUNCH_OR_OWNER_REQUIRED)
WIPO_EXECUTION_STATE   = AUTOMATION_BLOCKED / OWNER_BROWSER_OPTIONAL
```

WIPO Global Brand Database presents a bot-protection challenge to automated
clients; no WIPO result has been invented. The basic WIPO screen is
recommended for international signal but is not a mandatory blocker for a
US-focused open-source publication.

## License

The owner selected **Apache-2.0** (2026-09-15). The canonical Apache License
2.0 text is installed as the root `LICENSE` (unmodified), and `package.json`
carries `"license": "Apache-2.0"`. No `NOTICE` file is added because no
third-party notices require one.

```
FINAL_LICENSE                      = Apache-2.0
LICENSE_INSTALLED                  = true (root LICENSE, canonical text)
ENGINEERING_LICENSE_RECOMMENDATION = Apache-2.0
ALTERNATIVE                        = MIT
LICENSE_RELEASE_GATE               = RESOLVED (owner decision, 2026-09-15)
```

| License | Factual distinction |
| :--- | :--- |
| MIT | permissive, very short/simple, copyright + permission notice preservation, no express patent-license section comparable to Apache-2.0 |
| Apache-2.0 | permissive, explicit contributor patent grant, patent termination provision, attribution/change-notice obligations |

Technical recommendation for this project (permissive infrastructure
software): **Apache-2.0** (explicit patent grant). MIT remains valid when
minimal licensing text is the higher priority. Both are permissive; neither
is "more open" than the other.

### Dependency license audit (for either permissive choice)

Direct dependencies: `postal-mime` (MIT-0), `typescript` (Apache-2.0),
`vitest` (MIT), `@cloudflare/vitest-plugin` (MIT), `@playwright/test`
(Apache-2.0), `wrangler` (MIT OR Apache-2.0). All permissive; no direct
dependency imposes incompatible redistribution terms.

Note: transitive dev-tooling binaries of the `sharp` image library
(`@img/sharp-*`, LGPL-3.0-OR-LATER) are pulled in by Wrangler's development
tooling. `sharp` is **not** a dependency of MailGable itself, and these
binaries are not distributed as part of the product; verify before any
vendoring or distribution that would include them.

### Gate

```
LICENSE_RELEASE_GATE = RESOLVED
```

Apache-2.0 is installed. Before publication, verify GitHub license detection
(`gh api repos/XiantingWu/MailGable/license` → `spdx_id != null`). Do not
paraphrase license text; do not invent a NOTICE file unless actual notices
exist.

## Owner decision packet

A. **Brand** — **RESOLVED**: owner selected **MailGable** (2026-09-15). The
   earlier engineering candidates (Inboxstead, MailDory, Courierquill) are
   retained as historical research only. `MailPerch` remains rejected as a
   public brand (exact-name commercial email product conflict signal). The
   canonical repository was renamed `XiantingWu/MailPerch` →
   `XiantingWu/MailGable` and the source tree was rebuilt as a single root
   commit.

B. **License** — **RESOLVED**: `Apache-2.0` selected by the owner
   (2026-09-15); canonical text installed as the root `LICENSE`, with
   `package.json` carrying the same SPDX id. The dependency audit above shows
   compatibility with both permissive candidates.

C. **Live environment** — **NOT_APPLICABLE_TO_CODE_SHARING_RELEASE**: this
   repository's public release is a code-sharing release. It attests source
   cleanliness, reproducible install/build/test status, repository security
   posture, and license/branding/documentation consistency — it does not
   attest any current production deployment, Cloudflare resource state,
   live-domain health, or provider entitlement. The existing
   live-validation tooling (`scripts/live-validation.mjs`,
   `docs/LIVE_VALIDATION_*`) remains available as an optional operator track.

D. **Publication** — the candidate is always derived at qualification time
   from the exact current main HEAD (`git rev-parse HEAD`); it is never
   hard-coded into tracked documentation, because any edit that recorded it
   would immediately become stale. For a tagged release the gate proves
   `HEAD == origin/main == release-tag SHA`.
   Visibility change (private → public), security-feature enablement, the
   repository ruleset, and the v0.1.0 tag/release all require explicit owner
   authorization and are not performed automatically.

## Repository metadata

Current metadata is incomplete (description/homepage/topics/license unset).
GitHub topics are public even for private repositories, so positioning
metadata must not be added until the owner is ready for it to be public.

Suggested description (concept only, pending brand):

> Self-hosted domain mailbox on Cloudflare with durable D1/R2 archival and
> pluggable outbound delivery.