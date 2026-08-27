# Aureole — End User Licence Agreement (DRAFT)

> ## ⚠️ This is an unreviewed draft. It is not legal advice.
>
> No lawyer has read this document. It was drafted by an AI agent from a written
> brief ([[13 - Licence and EULA]]) and it has not been checked for
> enforceability, for consistency with consumer-protection law in any country, or
> for fitness for any purpose. **Do not publish it, do not ship it, and do not
> take a payment against it** until a qualified lawyer has reviewed it.
>
> `agent-workspace/LICENSE` remains the operative file and still reads
> *"UNLICENSED — all rights reserved"*. This draft does **not** replace it.
> The open questions at the bottom are not decoration; several of them are
> blockers.

**Draft version:** 0.1 · **Drafted:** 2026-08-26 · **Status:** unreviewed

---

## 0. What this document is, and what it is not

This is a licence for **software you run on your own computer**. It covers the
Aureole desktop application and the vault files, templates and conventions that
ship with it.

It is **not** terms of service for any hosted service. Aureole's paid tier is a
service operated on the Licensor's servers, and no part of this licence grants
any right to it, describes it, or governs it. See §8.

### The four things this licence does

| # | | Where |
|---|---|---|
| 1 | You may download, use, and **resell unmodified copies**, including commercially | §2, §3 |
| 2 | You may **not** modify the application source or the shipped template files as distributed, or redistribute modified versions | §4 |
| 3 | Copyright is **retained in full** by the Licensor; all rights not granted are reserved | §6 |
| 4 | Anything **you or your agent creates** is yours, and is not a derivative work of the Software | §5 |

Clause 4 is not optional politeness. Without it, clause 4's absence would make
the product's own core loop — an agent writing new skill files derived from the
shipped templates — a breach of clause 2 committed by every ordinary user.

---

## 1. Definitions

- **"Licensor"** — [LICENSOR LEGAL NAME — NOT SETTLED], the copyright holder in
  the Software. See open question A.
- **"Software"** — the Aureole desktop application in source or compiled form,
  together with the vault structure, templates, skills, conventions and
  documentation distributed with it, **excluding** the Excluded Assets (§7) and
  the Third-Party Components (§7).
- **"Shipped Template Files"** — the template, skill, convention and structural
  files distributed as part of the Software, **in the form in which they are
  distributed**.
- **"Your Content"** — anything created, written, generated or assembled by you,
  or by a software agent acting on your behalf, while using the Software. Defined
  in full in §5.
- **"Agent"** — an AI coding or authoring agent (for example Claude Code, Codex
  or Gemini) that you direct, that runs under your control, and whose output is
  produced at your instruction.
- **"Unmodified Copy"** — a byte-identical copy of a release of the Software as
  the Licensor distributed it, including this licence file, the `NOTICE` file and
  all attribution notices.
- **"Service"** — any hosted, networked or account-based capability operated by
  the Licensor. See §8.

---

## 2. Licence grant

Subject to your compliance with this licence, the Licensor grants you a
worldwide, royalty-free, non-exclusive, perpetual licence to:

**(a) Use.** Install and run the Software on any number of machines you own or
control, for any purpose, personal or commercial, with no account and no fee.

**(b) Copy and redistribute.** Reproduce and distribute **Unmodified Copies** of
the Software to anyone, by any medium.

**(c) Sell.** Charge whatever you like for an Unmodified Copy, and keep the
proceeds. Commercial resale is expressly permitted.

**(d) Use privately without limit.** Read the source, study it, run it, and
create Your Content with it, as described in §5.

This licence is granted automatically to every recipient of an Unmodified Copy,
directly from the Licensor. A reseller passes on the Software; they do not grant
the licence and cannot vary it (§3(c)).

---

## 3. Conditions on redistribution and resale

The rights in §2(b) and §2(c) apply **only** to Unmodified Copies, and only if
you meet all of the following:

**(a) Ship it whole.** This licence file, the `NOTICE` file, all copyright
notices and all attribution must travel with every copy, unaltered.

**(b) Change nothing.** No additions, no removals, no patches, no rebranding, no
repackaging that alters the contents. Bundling an Unmodified Copy inside a larger
distribution (an installer, an image, a package index) is permitted provided the
Software itself is unaltered and this licence is presented to the recipient.

**(c) Grant nothing you do not have.** You may not offer warranties, support
commitments, indemnities or any other undertaking **on the Licensor's behalf**,
and you may not represent that the Licensor endorses, supports or is party to
your sale. You may offer your own support, in your own name, at your own risk and
expense, and you must make clear it is yours.

**(d) Do not imply affiliation.** Reselling the Software does not make you a
partner, agent, distributor or authorised reseller of the Licensor, and you may
not say or imply that it does. Naming the product accurately — "this is Aureole"
— is permitted and expected; see §6(c) on trade marks.

**(e) Do not resell the Service.** The Service is not part of the Software and
you have no right to sell, resell, bundle, proxy or provide access to it (§8).

---

## 4. Restrictions — no derivative works

Except to the extent that applicable law grants you a right that cannot lawfully
be excluded (see open question F), you may **not**:

**(a)** modify, adapt, translate, patch or otherwise alter the source code or
compiled code of the Software;

**(b)** modify the Shipped Template Files **as distributed** — that is, you may
not alter, replace or delete them and then redistribute the result as the
Software or as a version of it;

**(c)** distribute, publish, sell, sublicense or make available any modified
version of the Software, in source or compiled form;

**(d)** create and distribute a fork, derivative product, competing product or
white-label version built from the Software's code;

**(e)** remove, obscure or alter any copyright, attribution, licence or
`NOTICE` text.

**What §4 does not restrict — read §5 before concluding you have breached it.**
§4 restricts what you may *redistribute*. It does not restrict what you *do* on
your own machine with your own vault, and it does not touch anything you or your
Agent create. Local use, filling in templates, generating new files and building
your own systems are the intended, licensed use of the product.

---

## 5. Your Content — the carve-out

**This is the clause that makes the product legal to use.** It is deliberately
broad and it is intended to be read in the user's favour.

> **The templates, skills, conventions and structure shipped with the Software
> are provided to be filled in, extended, and generated from. Any note, skill,
> file or structure created by you, or by an Agent acting on your behalf, is your
> own property and is not a derivative work of the Software.**

Without limiting that:

**(a) You own it.** You retain all right, title and interest in Your Content. The
Licensor claims no ownership, no licence and no interest in it, and receives no
copy of it.

**(b) Generating from the templates is licensed use, not modification.** Pointing
an Agent at the vault, having it read the shipped templates, skills and
conventions, having it interview you, and having it **write new files onto disk
that follow, extend or are derived from those templates** is the intended
operation of the Software. It is expressly permitted by §2(a) and (d) and is
expressly outside §4. It requires no further permission and no attribution.

**(c) Filling in a template is not modifying it.** Creating a new file from a
shipped template, copying a shipped skill and rewriting it for your own use,
extending a shipped convention, or generating a hundred new skill files in the
shape the Software describes — none of these are modifications of the Shipped
Template Files within the meaning of §4(b), because §4(b) concerns the shipped
files **as distributed**, not what you make from them.

**(d) Editing your own copy is permitted.** You may change, delete or replace any
file in your own installation, including the Shipped Template Files, for your own
use. §4 restricts **redistributing** an altered Software; it does not require you
to keep your own copy pristine. What you may not do is hand the altered result to
someone else as the Software.

**(e) You may distribute Your Content freely.** Under any terms you choose,
commercially or not, with no obligation to the Licensor. Your Content is not
subject to this licence. The only limit is that you may not distribute the
Software's own code or Shipped Template Files under cover of calling them Your
Content.

**(f) The Licensor takes no responsibility for Your Content**, including anything
an Agent produces at your direction. Agents make mistakes; you are responsible
for reviewing what runs on your machine and what you publish. See §10.

---

## 6. Ownership and reservation of rights

**(a) All rights reserved.** The Software is licensed, not sold. The Licensor
retains all copyright and all other intellectual property rights in it. **All
rights not expressly granted in §2 are reserved to the Licensor.**

**(b) Source availability is not a grant.** The Software's source may be publicly
readable. Publishing source does not place it in the public domain, does not make
it open source, and does not grant any right beyond §2. In particular, the ability
to read, clone or fork the source on a code-hosting platform is a function of that
platform and confers no licence to modify or redistribute a modified version
(§4). See open question B — this is a live conflict.

**(c) Trade marks.** No right is granted in "Aureole" or in any Licensor name,
logo or branding, other than the right to identify the Software accurately when
exercising §2(b) and §2(c). You may say you are selling Aureole. You may not
brand your business, product or domain as Aureole or as anything confusingly
similar. See open question C.

**(d) No patent grant.** This licence grants no patent rights, expressly or by
implication. See open question D.

---

## 7. What this licence does not cover

**(a) Third-Party Components.** The Software bundles open-source packages listed
in the `NOTICE` file (Electron, React, d3-force, lucide-react and others, under
the MIT, ISC and Apache-2.0 licences). **Those components are governed by their
own licences, not by this one.** Nothing in this licence — in particular nothing
in §4 — restricts any right you have under those licences with respect to those
components. Where this licence and a component's own licence conflict as to that
component, the component's licence prevails. Their notices must be preserved
under §3(a).

**(b) Excluded Assets.** The artwork and signature assets in
`src/renderer/assets/` are a third party's original work. They are **not** covered
by this licence and **no right in them is granted here**. See `docs/ARTWORK.md`.
Their rights holder's permission has not been settled, and the current documented
default position is that the repository and any build containing them must not be
distributed. **This is unresolved and is a blocker on §2(b) and §2(c) — see open
question G.**

---

## 8. The paid tier is a service, and this licence does not cover it

The free tier is software, licensed to you here. The paid tier is a **service the
Licensor operates**, and it is governed by separate service terms, not by this
document. **The dividing line is not "sync" — it is whether the Licensor's server
is in the middle.**

| | Free — covered by this licence | Paid — a service, separate terms |
|---|---|---|
| **Sync** | LocalSend over your own network. No account, no server. | Sync away from your own network. |
| **Compute** | Your machine, your own Agent. | Cloud — your vault keeps working while your machine is off. |
| **Integration** | — | API / plugin access to the vault via the Licensor's backend. |
| **Everything else** | All local features. | — |

**(a) No service is licensed here.** Nothing in this document grants access to,
or any right in, the Licensor's servers, accounts, APIs or hosted capabilities.
The Service requires an account and acceptance of separate terms.

**(b) The free tier needs no account and never expires.** The licence in §2 is
perpetual and unconditional on payment. There is no activation, no licence key,
no phone-home and no expiry.

**(c) What happens when a paid trial or subscription lapses — nothing breaks.**
This is a deliberate commitment and it is stated here so it binds:

> When a trial period or paid subscription ends, **the Software keeps working**.
> Your vault still opens. Your files stay on your disk, unencrypted and in open
> formats. Local-network sync still works. Every local feature keeps working, with
> no reduction, no nag and no read-only mode. **Only access to the Licensor's
> servers stops** — off-network sync, cloud compute and backend integration.

The Licensor will not use this licence, an update, or a change to the Service to
disable, degrade or gate the free tier of the Software on a running installation.

---

## 9. Term and termination

**(a)** This licence is perpetual and takes effect when you first obtain a copy.

**(b)** It terminates automatically if you breach §3 or §4 and do not cure the
breach within 30 days of becoming aware of it. On termination you must stop
distributing the Software; your right to continue **using** copies already
installed, and your ownership of Your Content under §5, are not affected.

**(c)** Reinstatement, cure periods, and whether a first-time inadvertent breach
should terminate anything at all are matters for review — see open question H.

**(d)** §5 (Your Content), §6 (Ownership), §7 (Exclusions), §10 and §11 survive
termination.

---

## 10. No warranty

**The Software is provided "as is", without warranty of any kind**, express or
implied, including the implied warranties of merchantability, fitness for a
particular purpose, title and non-infringement. The Licensor does not warrant
that it will be error-free, uninterrupted, secure, or that it will not lose data.

**Agents write to your disk.** The Software is designed to be operated by AI
agents that create, modify and delete files in your vault. Automated file
operations can destroy work. You are responsible for your own backups and for
reviewing what an Agent does. The Licensor is not responsible for anything an
Agent does at your direction.

Where applicable law does not allow the exclusion of an implied warranty, that
exclusion does not apply to you, and the remaining exclusions stand.

---

## 11. Limitation of liability

To the maximum extent permitted by law, the Licensor is not liable for any
indirect, incidental, special, consequential, exemplary or punitive damages, or
for lost profits, lost revenue, lost data or lost goodwill, arising out of or
relating to the Software or this licence, on any theory of liability, even if
advised of the possibility.

The Licensor's total aggregate liability is limited to the greater of the amount
you paid the Licensor for the Software (which for the free tier is **nil**) and
[CAP AMOUNT — NOT SETTLED].

**Nothing in this licence limits liability for death or personal injury caused by
negligence, for fraud, or for anything else that cannot lawfully be limited.**
The precise carve-outs depend on the governing law, which has not been chosen —
see open question E.

---

## 12. Governing law and jurisdiction

> **⚠️ NOT SETTLED. Deliberately left blank rather than guessed.**
>
> `[GOVERNING LAW — TO BE DETERMINED WITH A LAWYER]`
> `[JURISDICTION / VENUE — TO BE DETERMINED WITH A LAWYER]`

This choice is not cosmetic. It determines whether §4's no-derivatives
restriction is enforceable at all, whether §10 and §11 survive consumer-protection
rules, and what a reseller in another country is actually bound by. See open
question E.

---

## 13. General

**(a) Entire agreement.** This licence is the entire agreement between you and
the Licensor as to the Software, and supersedes any prior understanding as to it.
It does not cover the Service (§8), the Third-Party Components or the Excluded
Assets (§7).

**(b) Severability.** If any provision is held unenforceable, it is severed and
the rest stands.

**(c) No waiver.** A failure to enforce any provision is not a waiver of it.

**(d) Changes.** The Licensor may licence future releases under different terms.
**A copy you already have stays under the licence it shipped with**; new terms
apply only to versions released under them.

---

Copyright © 2026 [LICENSOR LEGAL NAME — NOT SETTLED]. All rights reserved.

---
---

# Open questions for a lawyer

Ordered: blockers first, then drafting questions. **Items 1 and 2 are the two
conflicts flagged in the brief and are explicitly not the drafting agent's to
resolve. Item 3 was found while drafting and appears to be a third blocker of
the same kind.**

## 🔴 Blockers — resolve before anything is published

### 1. BLOCKER — "clones or forks" contradicts §4

**Where:** `Fate/Roadmap/08 - Product Definition and Decisions.md`, Decision 4 —
*"the download is a **GitHub repository the user clones or forks**"*. Decision 3
repeats the framing (*"The user will download or even fork my GitHub
repository"*).

**Conflict:** on GitHub, **fork means modify and republish**. A fork is a public,
modifiable, redistributable copy under the forker's account. §4(a), (c) and (d)
of this draft prohibit exactly that. Under this licence "fork" can only ever mean
"clone in order to use", which is not what the word means to the audience being
invited to do it.

**Consequence if unresolved:** two public documents contradict each other, and
the contradiction favours the user — an invitation to fork is arguably a licence
to fork, and it undermines §4 at precisely the point §4 is meant to bite.

**Not resolved here.** Decision 4's wording is a product decision, not a drafting
one. Either the wording changes, or §4 changes to permit forks under stated
conditions. Someone must choose.

### 2. BLOCKER — the vault template repo is MIT, which is the opposite of §4

**Where:** `Fate/Vault Template (Public Repo).md` line 114 — `License: MIT.`

**Conflict:** MIT permits modification, relicensing and redistribution of
modified versions without restriction. That is the direct negation of clause 2 /
§4 of this draft. If the shipped templates and conventions exist in both repos,
**a user can take the MIT copy and lawfully do everything this licence forbids.**
§4 would be unenforceable in practice as to that material.

**Note:** these are legitimately **two different products** — Aureole is the app,
the vault template is a separate repo — and they may reasonably carry different
licences. But it has to be a decision, not an accident, and the boundary must be
drawn file by file: any file present in both repos effectively takes the more
permissive licence.

**Not resolved here.**

### 3. 🔴 BLOCKER — found while drafting: the artwork cannot be redistributed at all

**Where:** `docs/ARTWORK.md`, and `NOTICE.md` §"Not covered here".

**Conflict:** §2(b) and §2(c) of this draft grant everyone the right to
redistribute and resell copies of the Software. But `ARTWORK.md` records that the
artwork and signature assets in `src/renderer/assets/` are a third party's work,
used with **informal personal permission, not licensed**, with five open
questions unanswered including *"If this app is ever shared, packaged, or
published, does her permission travel with it?"* Its stated default position is:
*"Do not publish this repository, distribute a build containing these assets, or
reuse them in another project."*

**Consequence:** a redistribution-and-resale licence cannot ship on a repository
whose most legally-exposed asset is documented as non-distributable. §7(b)
excludes the assets from the licence grant, which protects the licence — but it
does not solve the problem, because the assets are still **in** the build and
**in** git history. Every reseller exercising §2(c) would be distributing them.

**Also:** the signature is a real person's handwritten signature, reproduced as an
image in a public git repository, in a product that other people are being
licensed to sell commercially. That warrants specific advice.

**Not resolved here.** Either get written permission covering commercial
redistribution by third parties, or remove the assets (and rewrite git history)
before §2(b)/§2(c) can be honoured.

## Drafting and legal questions

**A. Who is the Licensor?** The current `LICENSE` and `NOTICE` say *"Copyright (c)
2026 Nathan"* — a first name. A EULA needs a named legal person or entity that can
sue and be sued. Individual or a company? Which jurisdiction is it in? This blocks
§1, §12 and the copyright line.

**B. Is source-available compatible with the distribution channel?** §6(b) asserts
that publishing source grants no right to modify. That is legally orthodox, but
GitHub's Terms of Service grant every user the right to **view and fork** any
public repository. Does hosting there constitute a licence to fork notwithstanding
§4 and notwithstanding a `LICENSE` file that says otherwise? Directly compounds
blocker 1. If the answer is "yes", the distribution channel has to change or §4
has to.

**C. Trade mark.** "Aureole" is verified free on npm; that is not a trade mark
search. Should it be registered, and in which classes and territories? §6(c)
reserves it, but reserving an unregistered mark while licensing strangers to sell
the product under that name is a weak position. What must a reseller be required
to say, and what must they be forbidden from saying?

**D. Patents.** §6(d) grants none, following the brief's reasoning for rejecting
CC BY-ND (Creative Commons licences have no patent grant, which is a real gap for
software). Is silence the right answer, or should there be an express
non-assertion covenant for ordinary use? An implied licence may arise from the
resale grant regardless.

**E. 🔴 Governing law and jurisdiction — deliberately not guessed.** §12 is a
blank placeholder by instruction. This is the single highest-leverage unanswered
question in the document, because it determines: whether §4's no-derivatives
restriction is enforceable at all; whether §10 and §11 survive consumer-protection
statutes; whether a EULA presented after download (no click-wrap, no acceptance
step) forms a contract; and what binds a reseller in another country. **Do not
guess this, and do not let anyone fill it in without advice.**

**F. Rights that cannot be excluded.** §4 opens with a carve-out for
non-excludable statutory rights. In several jurisdictions users have
non-waivable rights to decompile for interoperability, to make backups, or to
modify for personal use. Which apply, and does §4 need to name them?

**G. Does clause 4 (§5) do what it needs to?** This is the clause the product
depends on and the one most worth a careful read. Specific concerns:
- Is a file generated by an agent from a shipped template a **derivative work** as
  a matter of copyright law, regardless of what §5 says? A contract can grant a
  licence; it cannot always redefine what a derivative work is.
- Does §5 correctly disclaim any Licensor interest in Your Content, or does the
  broad reservation in §6(a) undercut it?
- §5(d) permits editing your own copy while §4(b) forbids modifying the Shipped
  Template Files. Is that boundary — *modify locally, yes; redistribute the
  modification, no* — expressed clearly enough to survive a dispute?
- Is the AI-output ownership position sound where the output's copyright status
  is itself unsettled in most jurisdictions?

**H. Termination.** §9(b) auto-terminates on uncured breach. Is 30 days right? Is
automatic termination proportionate for an inadvertent breach — someone who
reposts a copy having missed a notice file? Should there be reinstatement?

**I. Formation.** There is no click-wrap, no acceptance step and no installer
dialogue. The licence is a file in a repository. Is a user bound by it? Is a
**reseller's customer** bound by it, given the licence is stated (§2) to flow
directly from the Licensor? If acceptance is needed, where does it go, and does
adding it break the "no account, no friction" promise in §8(b)?

**J. Resale in practice.** §3(c) forbids a reseller from making commitments on the
Licensor's behalf. Is that enough protection when a reseller takes money from a
customer for free software and the customer then complains to the Licensor? Should
resellers be required to disclose that the Software is available free of charge?
This is a consumer-law question in several jurisdictions.

**K. The service boundary.** §8 separates licensed software from an operated
service. Separate service terms, a privacy policy and — if payment is taken —
consumer contract terms will be needed. `docs/TERMS.md` currently states there is
deliberately no terms-of-service document *"because there is no operator, no
account, no hosted service"*. **That document becomes wrong the moment the paid
tier exists**, and its own "When this stops being true" list already says so. It
must be rewritten with a lawyer before the paid tier ships.

**L. Is the §8(c) commitment binding, and should it be?** "When your subscription
lapses, nothing breaks" is stated as a licence term rather than marketing. That is
deliberate — it is a genuine differentiator. Confirm it is enforceable as drafted,
and confirm the Licensor is content to be bound by it, because §8(c) is difficult
to walk back once published.
