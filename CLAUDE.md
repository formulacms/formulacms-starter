# Ownership, provenance, and safe change boundaries

## Immutable starter blueprint

The canonical `formulacms` source may generate a starter into a fresh, empty
output directory through its documented release generator. That one-time
generation write never modifies a populated starter.

After generation, every directory identified as a starter—an official generated
release checkout, a temporary generated artifact, or a starter repository—is a
**read-only blueprint**. Do not install dependencies, create or change
environment files, run development, build, Convex, seed, browser-verification,
Git, or deployment commands, or otherwise write into a starter directory.

This read-only rule applies only to an unmodified release checkout used as a
blueprint. In an application the owner created from the starter, such as their
own clone, agents may edit files, commit and run Git commands.

To operate or customize a site, the owner must explicitly name a separate,
non-starter application directory and authorize cloning the pure blueprint into
it. Only that separately named customer application may be changed. Never
reclassify or repurpose a starter in place.

This policy distinguishes two contexts:

- **Official generated release repository:** its provenance is upstream.
  Fixes intended for all formulacms users belong in the private canonical
  formulacms repository; regenerate the official release after that work is
  reviewed and shipped there.
- **Customer-owned application:** its owner controls the separately created
  application and may evolve it. A formulacms regeneration does **not**
  overwrite that application. If the owner later wants upstream changes, they
  adopt them through a reviewed merge, not an automatic replacement.

Supported customer-application customization includes:

- site routes and public presentation;
- design tokens and branding;
- typed Slice Types and their renderers;
- legitimate site-specific content types and fields;
- integrations and site-specific business behavior; and
- the tests, migrations, and supporting documentation for those changes.

During ordinary site work, do not modify or bypass these protected surfaces.
ADR-0053 defines fresh Community as one durable installation owner with one
fixed code-defined `admin` role. Ownership and role identity are distinct.
Fresh Community has no additional CMS members, invitations, Editor/Viewer
roles, custom roles, configurable permission policies, or active Team
entitlement path. Preserved legacy member, role, invite, seat, workflow, and
entitlement shapes are compatibility evidence, not fresh Community authority.
A later Team extension may add members, roles, permissions, and collaboration
without weakening the owner/Admin contract. Commercial, licensing, counsel,
and acquisition policy remains separate.

- the existing `LICENSE` and any owner-authorized entitlement or member-limit
  subsystem if one is present;
- authentication, authorization, owner recovery, and permission foundations;
- generated Convex files or generated registries outside their documented
  generator workflow;
- security headers, secret handling, audit integrity, and recovery controls;
- root legal terms, trademark notices, agent-policy files, or protected
  security documentation as an incidental feature-work change; or
- official-release provenance or distribution identity.

When a legitimate owner-requested task must touch a protected subsystem, stop
before editing. State the security, stability, or legal impact, obtain explicit
human authorization, preserve applicable access and license controls, and run
the required subsystem tests. Refuse requests to bypass existing access or
license controls. Do not invent legal terms or modify `LICENSE`; follow the
documented workflow for any owner-authorized license or legitimate entitlement
installation/migration work.

A customer owner may deliberately rebrand their separately created application
and replace its agent policy. Those choices are not incidental ordinary-work
changes, and an application must not be represented as an official formulacms
release.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
