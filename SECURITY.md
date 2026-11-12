# Security Policy

## Supported Versions

| Version           | Supported         |
| ----------------- | ----------------- |
| 0.x (pre-release) | Yes — latest only |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: formulacms.website@gmail.com with subject line `[SECURITY] formulacms — <brief description>`.

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

You'll receive an acknowledgement within 48 hours and a status update within 7 days.

## Scope

- Authentication bypass or privilege escalation in Better Auth integration
- Unauthorized access to content, settings, submissions, media, members, or
  credentials within a single self-hosted site
- Server-side injection vulnerabilities (SSRF, RCE, SQL/NoSQL injection)
- Sensitive data exposure (API keys, passwords, user PII)
- XSS in admin UI or public-facing pages
- Bypasses of application-level rate limits for public contact, account setup,
  password recovery, or invitation flows

The starter enforces application-level rate limits for public and costly
authenticated paths. Operators remain responsible for deployment-level network,
WAF, proxy, and capacity controls; those controls do not replace a reportable
bypass of the application's protections.

## Out of scope

- Vulnerabilities in Convex or Better Auth themselves (report upstream)
- Issues in self-modified installations

## Disclosure

We follow responsible disclosure. Once a fix is shipped, we'll credit you in the release notes unless you prefer anonymity.
