/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents_auditedGenerate from "../agents/auditedGenerate.js";
import type * as agents_contentWriter from "../agents/contentWriter.js";
import type * as agents_helpAssistant from "../agents/helpAssistant.js";
import type * as agents_localGeneration from "../agents/localGeneration.js";
import type * as agents_localizer from "../agents/localizer.js";
import type * as agents_pageJobWorker from "../agents/pageJobWorker.js";
import type * as auth from "../auth.js";
import type * as cms_adminPassword from "../cms/adminPassword.js";
import type * as cms_agents from "../cms/agents.js";
import type * as cms_ai from "../cms/ai.js";
import type * as cms_aiAuditLog from "../cms/aiAuditLog.js";
import type * as cms_aiConnections from "../cms/aiConnections.js";
import type * as cms_aiJobs from "../cms/aiJobs.js";
import type * as cms_aiSettings from "../cms/aiSettings.js";
import type * as cms_contentTypes from "../cms/contentTypes.js";
import type * as cms_language from "../cms/language.js";
import type * as cms_languageLifecycle from "../cms/languageLifecycle.js";
import type * as cms_media from "../cms/media.js";
import type * as cms_menus from "../cms/menus.js";
import type * as cms_modules from "../cms/modules.js";
import type * as cms_multilingual from "../cms/multilingual.js";
import type * as cms_openRouterCatalog from "../cms/openRouterCatalog.js";
import type * as cms_owner from "../cms/owner.js";
import type * as cms_pages from "../cms/pages.js";
import type * as cms_passwordRecovery from "../cms/passwordRecovery.js";
import type * as cms_preview from "../cms/preview.js";
import type * as cms_publication from "../cms/publication.js";
import type * as cms_redirects from "../cms/redirects.js";
import type * as cms_relations from "../cms/relations.js";
import type * as cms_revalidate from "../cms/revalidate.js";
import type * as cms_settings from "../cms/settings.js";
import type * as cms_sliceLibrary from "../cms/sliceLibrary.js";
import type * as cms_slices from "../cms/slices.js";
import type * as cms_tags from "../cms/tags.js";
import type * as cms_userPreferences from "../cms/userPreferences.js";
import type * as crons from "../crons.js";
import type * as edition_workflow from "../edition/workflow.js";
import type * as email from "../email.js";
import type * as emailNode from "../emailNode.js";
import type * as http from "../http.js";
import type * as lib_access_owner from "../lib/access/owner.js";
import type * as lib_access_policy from "../lib/access/policy.js";
import type * as lib_agents_contentWriterContract from "../lib/agents/contentWriterContract.js";
import type * as lib_agents_markup from "../lib/agents/markup.js";
import type * as lib_agents_pageContext from "../lib/agents/pageContext.js";
import type * as lib_agents_registry from "../lib/agents/registry.js";
import type * as lib_agents_translationWorkflow from "../lib/agents/translationWorkflow.js";
import type * as lib_ai from "../lib/ai.js";
import type * as lib_aiConfig from "../lib/aiConfig.js";
import type * as lib_aiRateLimit from "../lib/aiRateLimit.js";
import type * as lib_aiValidators from "../lib/aiValidators.js";
import type * as lib_authIpProof from "../lib/authIpProof.js";
import type * as lib_contentTypes_author from "../lib/contentTypes/author.js";
import type * as lib_contentTypes_exposure from "../lib/contentTypes/exposure.js";
import type * as lib_contentTypes_fieldOwnership from "../lib/contentTypes/fieldOwnership.js";
import type * as lib_contentTypes_index from "../lib/contentTypes/index.js";
import type * as lib_contentTypes_inputShapes from "../lib/contentTypes/inputShapes.js";
import type * as lib_contentTypes_job from "../lib/contentTypes/job.js";
import type * as lib_contentTypes_landingPage from "../lib/contentTypes/landingPage.js";
import type * as lib_contentTypes_page from "../lib/contentTypes/page.js";
import type * as lib_contentTypes_post from "../lib/contentTypes/post.js";
import type * as lib_contentTypes_publicProjection from "../lib/contentTypes/publicProjection.js";
import type * as lib_contentTypes_resolve from "../lib/contentTypes/resolve.js";
import type * as lib_contentTypes_routing from "../lib/contentTypes/routing.js";
import type * as lib_contentTypes_schemaShapes from "../lib/contentTypes/schemaShapes.js";
import type * as lib_contentTypes_starterSelection from "../lib/contentTypes/starterSelection.js";
import type * as lib_contentTypes_testimonial from "../lib/contentTypes/testimonial.js";
import type * as lib_contentTypes_types from "../lib/contentTypes/types.js";
import type * as lib_contentTypes_writeShapes from "../lib/contentTypes/writeShapes.js";
import type * as lib_documentReferences from "../lib/documentReferences.js";
import type * as lib_domains_contentEditing from "../lib/domains/contentEditing.js";
import type * as lib_domains_contentModel from "../lib/domains/contentModel.js";
import type * as lib_domains_media from "../lib/domains/media.js";
import type * as lib_domains_publication from "../lib/domains/publication.js";
import type * as lib_email_delivery from "../lib/email/delivery.js";
import type * as lib_email_providerMetadata from "../lib/email/providerMetadata.js";
import type * as lib_email_providerMigration from "../lib/email/providerMigration.js";
import type * as lib_email_providerReadiness from "../lib/email/providerReadiness.js";
import type * as lib_email_providerState from "../lib/email/providerState.js";
import type * as lib_email_readiness from "../lib/email/readiness.js";
import type * as lib_email_successor from "../lib/email/successor.js";
import type * as lib_environment from "../lib/environment.js";
import type * as lib_formPayloads from "../lib/formPayloads.js";
import type * as lib_help_corpus from "../lib/help/corpus.js";
import type * as lib_help_intents from "../lib/help/intents.js";
import type * as lib_help_workflow from "../lib/help/workflow.js";
import type * as lib_language_carryDecisionDigest from "../lib/language/carryDecisionDigest.js";
import type * as lib_language_collection from "../lib/language/collection.js";
import type * as lib_language_defaultMigration from "../lib/language/defaultMigration.js";
import type * as lib_language_disclosure from "../lib/language/disclosure.js";
import type * as lib_language_freshness from "../lib/language/freshness.js";
import type * as lib_language_impactPreview from "../lib/language/impactPreview.js";
import type * as lib_language_lifecycle from "../lib/language/lifecycle.js";
import type * as lib_language_localePrefix from "../lib/language/localePrefix.js";
import type * as lib_language_multilingual from "../lib/language/multilingual.js";
import type * as lib_language_retirement from "../lib/language/retirement.js";
import type * as lib_language_state from "../lib/language/state.js";
import type * as lib_localAiAuditProof from "../lib/localAiAuditProof.js";
import type * as lib_media_imageDimensions from "../lib/media/imageDimensions.js";
import type * as lib_media_usage from "../lib/media/usage.js";
import type * as lib_mediaReferences from "../lib/mediaReferences.js";
import type * as lib_menu from "../lib/menu.js";
import type * as lib_menu_canonical from "../lib/menu/canonical.js";
import type * as lib_menu_canonicalWrite from "../lib/menu/canonicalWrite.js";
import type * as lib_menu_key from "../lib/menu/key.js";
import type * as lib_menu_references from "../lib/menu/references.js";
import type * as lib_menu_validate from "../lib/menu/validate.js";
import type * as lib_modules_lifecycle from "../lib/modules/lifecycle.js";
import type * as lib_modules_state from "../lib/modules/state.js";
import type * as lib_ownerClaim from "../lib/ownerClaim.js";
import type * as lib_pageReferences from "../lib/pageReferences.js";
import type * as lib_pages_home from "../lib/pages/home.js";
import type * as lib_pages_sliceBodyContent from "../lib/pages/sliceBodyContent.js";
import type * as lib_pages_types from "../lib/pages/types.js";
import type * as lib_pilotEnvelope from "../lib/pilotEnvelope.js";
import type * as lib_publishing_checklist from "../lib/publishing/checklist.js";
import type * as lib_publishing_legacyMigration from "../lib/publishing/legacyMigration.js";
import type * as lib_publishing_localeCandidate from "../lib/publishing/localeCandidate.js";
import type * as lib_publishing_locks from "../lib/publishing/locks.js";
import type * as lib_publishing_presence from "../lib/publishing/presence.js";
import type * as lib_publishing_publicationContributions from "../lib/publishing/publicationContributions.js";
import type * as lib_publishing_publicationPolicy from "../lib/publishing/publicationPolicy.js";
import type * as lib_publishing_revisions from "../lib/publishing/revisions.js";
import type * as lib_publishing_scheduling from "../lib/publishing/scheduling.js";
import type * as lib_publishing_search from "../lib/publishing/search.js";
import type * as lib_publishing_snapshots from "../lib/publishing/snapshots.js";
import type * as lib_publishing_staging from "../lib/publishing/staging.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_redirects_disableBlocker from "../lib/redirects/disableBlocker.js";
import type * as lib_richtext_build from "../lib/richtext/build.js";
import type * as lib_richtext_comparison from "../lib/richtext/comparison.js";
import type * as lib_richtext_contracts from "../lib/richtext/contracts.js";
import type * as lib_richtext_emptiness from "../lib/richtext/emptiness.js";
import type * as lib_richtext_pmText from "../lib/richtext/pmText.js";
import type * as lib_richtext_profiles from "../lib/richtext/profiles.js";
import type * as lib_richtext_shape from "../lib/richtext/shape.js";
import type * as lib_richtext_strict from "../lib/richtext/strict.js";
import type * as lib_richtext_transitions from "../lib/richtext/transitions.js";
import type * as lib_richtext_write from "../lib/richtext/write.js";
import type * as lib_semaphore from "../lib/semaphore.js";
import type * as lib_slices_authoringState from "../lib/slices/authoringState.js";
import type * as lib_slices_faqSimple from "../lib/slices/faqSimple.js";
import type * as lib_slices_featuresIconGrid from "../lib/slices/featuresIconGrid.js";
import type * as lib_slices_fields from "../lib/slices/fields.js";
import type * as lib_slices_heroAgency from "../lib/slices/heroAgency.js";
import type * as lib_slices_heroPresentationDefinitions from "../lib/slices/heroPresentationDefinitions.js";
import type * as lib_slices_heroWithImage from "../lib/slices/heroWithImage.js";
import type * as lib_slices_identity from "../lib/slices/identity.js";
import type * as lib_slices_index from "../lib/slices/index.js";
import type * as lib_slices_occurrencePresentation from "../lib/slices/occurrencePresentation.js";
import type * as lib_slices_permissions from "../lib/slices/permissions.js";
import type * as lib_slices_presentationMutations from "../lib/slices/presentationMutations.js";
import type * as lib_slices_presentationRendererInventory from "../lib/slices/presentationRendererInventory.js";
import type * as lib_slices_presentationResolution from "../lib/slices/presentationResolution.js";
import type * as lib_slices_presentations from "../lib/slices/presentations.js";
import type * as lib_slices_primitives from "../lib/slices/primitives.js";
import type * as lib_slices_profile from "../lib/slices/profile.js";
import type * as lib_slices_repeating from "../lib/slices/repeating.js";
import type * as lib_slices_resolve from "../lib/slices/resolve.js";
import type * as lib_slices_richTextBody from "../lib/slices/richTextBody.js";
import type * as lib_slices_sample from "../lib/slices/sample.js";
import type * as lib_slices_validate from "../lib/slices/validate.js";
import type * as lib_slices_walk from "../lib/slices/walk.js";
import type * as lib_urlGuard from "../lib/urlGuard.js";
import type * as lib_versions from "../lib/versions.js";
import type * as menuCanonicalCutover from "../menuCanonicalCutover.js";
import type * as menuReferences from "../menuReferences.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "agents/auditedGenerate": typeof agents_auditedGenerate;
  "agents/contentWriter": typeof agents_contentWriter;
  "agents/helpAssistant": typeof agents_helpAssistant;
  "agents/localGeneration": typeof agents_localGeneration;
  "agents/localizer": typeof agents_localizer;
  "agents/pageJobWorker": typeof agents_pageJobWorker;
  auth: typeof auth;
  "cms/adminPassword": typeof cms_adminPassword;
  "cms/agents": typeof cms_agents;
  "cms/ai": typeof cms_ai;
  "cms/aiAuditLog": typeof cms_aiAuditLog;
  "cms/aiConnections": typeof cms_aiConnections;
  "cms/aiJobs": typeof cms_aiJobs;
  "cms/aiSettings": typeof cms_aiSettings;
  "cms/contentTypes": typeof cms_contentTypes;
  "cms/language": typeof cms_language;
  "cms/languageLifecycle": typeof cms_languageLifecycle;
  "cms/media": typeof cms_media;
  "cms/menus": typeof cms_menus;
  "cms/modules": typeof cms_modules;
  "cms/multilingual": typeof cms_multilingual;
  "cms/openRouterCatalog": typeof cms_openRouterCatalog;
  "cms/owner": typeof cms_owner;
  "cms/pages": typeof cms_pages;
  "cms/passwordRecovery": typeof cms_passwordRecovery;
  "cms/preview": typeof cms_preview;
  "cms/publication": typeof cms_publication;
  "cms/redirects": typeof cms_redirects;
  "cms/relations": typeof cms_relations;
  "cms/revalidate": typeof cms_revalidate;
  "cms/settings": typeof cms_settings;
  "cms/sliceLibrary": typeof cms_sliceLibrary;
  "cms/slices": typeof cms_slices;
  "cms/tags": typeof cms_tags;
  "cms/userPreferences": typeof cms_userPreferences;
  crons: typeof crons;
  "edition/workflow": typeof edition_workflow;
  email: typeof email;
  emailNode: typeof emailNode;
  http: typeof http;
  "lib/access/owner": typeof lib_access_owner;
  "lib/access/policy": typeof lib_access_policy;
  "lib/agents/contentWriterContract": typeof lib_agents_contentWriterContract;
  "lib/agents/markup": typeof lib_agents_markup;
  "lib/agents/pageContext": typeof lib_agents_pageContext;
  "lib/agents/registry": typeof lib_agents_registry;
  "lib/agents/translationWorkflow": typeof lib_agents_translationWorkflow;
  "lib/ai": typeof lib_ai;
  "lib/aiConfig": typeof lib_aiConfig;
  "lib/aiRateLimit": typeof lib_aiRateLimit;
  "lib/aiValidators": typeof lib_aiValidators;
  "lib/authIpProof": typeof lib_authIpProof;
  "lib/contentTypes/author": typeof lib_contentTypes_author;
  "lib/contentTypes/exposure": typeof lib_contentTypes_exposure;
  "lib/contentTypes/fieldOwnership": typeof lib_contentTypes_fieldOwnership;
  "lib/contentTypes/index": typeof lib_contentTypes_index;
  "lib/contentTypes/inputShapes": typeof lib_contentTypes_inputShapes;
  "lib/contentTypes/job": typeof lib_contentTypes_job;
  "lib/contentTypes/landingPage": typeof lib_contentTypes_landingPage;
  "lib/contentTypes/page": typeof lib_contentTypes_page;
  "lib/contentTypes/post": typeof lib_contentTypes_post;
  "lib/contentTypes/publicProjection": typeof lib_contentTypes_publicProjection;
  "lib/contentTypes/resolve": typeof lib_contentTypes_resolve;
  "lib/contentTypes/routing": typeof lib_contentTypes_routing;
  "lib/contentTypes/schemaShapes": typeof lib_contentTypes_schemaShapes;
  "lib/contentTypes/starterSelection": typeof lib_contentTypes_starterSelection;
  "lib/contentTypes/testimonial": typeof lib_contentTypes_testimonial;
  "lib/contentTypes/types": typeof lib_contentTypes_types;
  "lib/contentTypes/writeShapes": typeof lib_contentTypes_writeShapes;
  "lib/documentReferences": typeof lib_documentReferences;
  "lib/domains/contentEditing": typeof lib_domains_contentEditing;
  "lib/domains/contentModel": typeof lib_domains_contentModel;
  "lib/domains/media": typeof lib_domains_media;
  "lib/domains/publication": typeof lib_domains_publication;
  "lib/email/delivery": typeof lib_email_delivery;
  "lib/email/providerMetadata": typeof lib_email_providerMetadata;
  "lib/email/providerMigration": typeof lib_email_providerMigration;
  "lib/email/providerReadiness": typeof lib_email_providerReadiness;
  "lib/email/providerState": typeof lib_email_providerState;
  "lib/email/readiness": typeof lib_email_readiness;
  "lib/email/successor": typeof lib_email_successor;
  "lib/environment": typeof lib_environment;
  "lib/formPayloads": typeof lib_formPayloads;
  "lib/help/corpus": typeof lib_help_corpus;
  "lib/help/intents": typeof lib_help_intents;
  "lib/help/workflow": typeof lib_help_workflow;
  "lib/language/carryDecisionDigest": typeof lib_language_carryDecisionDigest;
  "lib/language/collection": typeof lib_language_collection;
  "lib/language/defaultMigration": typeof lib_language_defaultMigration;
  "lib/language/disclosure": typeof lib_language_disclosure;
  "lib/language/freshness": typeof lib_language_freshness;
  "lib/language/impactPreview": typeof lib_language_impactPreview;
  "lib/language/lifecycle": typeof lib_language_lifecycle;
  "lib/language/localePrefix": typeof lib_language_localePrefix;
  "lib/language/multilingual": typeof lib_language_multilingual;
  "lib/language/retirement": typeof lib_language_retirement;
  "lib/language/state": typeof lib_language_state;
  "lib/localAiAuditProof": typeof lib_localAiAuditProof;
  "lib/media/imageDimensions": typeof lib_media_imageDimensions;
  "lib/media/usage": typeof lib_media_usage;
  "lib/mediaReferences": typeof lib_mediaReferences;
  "lib/menu": typeof lib_menu;
  "lib/menu/canonical": typeof lib_menu_canonical;
  "lib/menu/canonicalWrite": typeof lib_menu_canonicalWrite;
  "lib/menu/key": typeof lib_menu_key;
  "lib/menu/references": typeof lib_menu_references;
  "lib/menu/validate": typeof lib_menu_validate;
  "lib/modules/lifecycle": typeof lib_modules_lifecycle;
  "lib/modules/state": typeof lib_modules_state;
  "lib/ownerClaim": typeof lib_ownerClaim;
  "lib/pageReferences": typeof lib_pageReferences;
  "lib/pages/home": typeof lib_pages_home;
  "lib/pages/sliceBodyContent": typeof lib_pages_sliceBodyContent;
  "lib/pages/types": typeof lib_pages_types;
  "lib/pilotEnvelope": typeof lib_pilotEnvelope;
  "lib/publishing/checklist": typeof lib_publishing_checklist;
  "lib/publishing/legacyMigration": typeof lib_publishing_legacyMigration;
  "lib/publishing/localeCandidate": typeof lib_publishing_localeCandidate;
  "lib/publishing/locks": typeof lib_publishing_locks;
  "lib/publishing/presence": typeof lib_publishing_presence;
  "lib/publishing/publicationContributions": typeof lib_publishing_publicationContributions;
  "lib/publishing/publicationPolicy": typeof lib_publishing_publicationPolicy;
  "lib/publishing/revisions": typeof lib_publishing_revisions;
  "lib/publishing/scheduling": typeof lib_publishing_scheduling;
  "lib/publishing/search": typeof lib_publishing_search;
  "lib/publishing/snapshots": typeof lib_publishing_snapshots;
  "lib/publishing/staging": typeof lib_publishing_staging;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/redirects/disableBlocker": typeof lib_redirects_disableBlocker;
  "lib/richtext/build": typeof lib_richtext_build;
  "lib/richtext/comparison": typeof lib_richtext_comparison;
  "lib/richtext/contracts": typeof lib_richtext_contracts;
  "lib/richtext/emptiness": typeof lib_richtext_emptiness;
  "lib/richtext/pmText": typeof lib_richtext_pmText;
  "lib/richtext/profiles": typeof lib_richtext_profiles;
  "lib/richtext/shape": typeof lib_richtext_shape;
  "lib/richtext/strict": typeof lib_richtext_strict;
  "lib/richtext/transitions": typeof lib_richtext_transitions;
  "lib/richtext/write": typeof lib_richtext_write;
  "lib/semaphore": typeof lib_semaphore;
  "lib/slices/authoringState": typeof lib_slices_authoringState;
  "lib/slices/faqSimple": typeof lib_slices_faqSimple;
  "lib/slices/featuresIconGrid": typeof lib_slices_featuresIconGrid;
  "lib/slices/fields": typeof lib_slices_fields;
  "lib/slices/heroAgency": typeof lib_slices_heroAgency;
  "lib/slices/heroPresentationDefinitions": typeof lib_slices_heroPresentationDefinitions;
  "lib/slices/heroWithImage": typeof lib_slices_heroWithImage;
  "lib/slices/identity": typeof lib_slices_identity;
  "lib/slices/index": typeof lib_slices_index;
  "lib/slices/occurrencePresentation": typeof lib_slices_occurrencePresentation;
  "lib/slices/permissions": typeof lib_slices_permissions;
  "lib/slices/presentationMutations": typeof lib_slices_presentationMutations;
  "lib/slices/presentationRendererInventory": typeof lib_slices_presentationRendererInventory;
  "lib/slices/presentationResolution": typeof lib_slices_presentationResolution;
  "lib/slices/presentations": typeof lib_slices_presentations;
  "lib/slices/primitives": typeof lib_slices_primitives;
  "lib/slices/profile": typeof lib_slices_profile;
  "lib/slices/repeating": typeof lib_slices_repeating;
  "lib/slices/resolve": typeof lib_slices_resolve;
  "lib/slices/richTextBody": typeof lib_slices_richTextBody;
  "lib/slices/sample": typeof lib_slices_sample;
  "lib/slices/validate": typeof lib_slices_validate;
  "lib/slices/walk": typeof lib_slices_walk;
  "lib/urlGuard": typeof lib_urlGuard;
  "lib/versions": typeof lib_versions;
  menuCanonicalCutover: typeof menuCanonicalCutover;
  menuReferences: typeof menuReferences;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  actionRetrier: import("@convex-dev/action-retrier/_generated/component.js").ComponentApi<"actionRetrier">;
  aiPageJobs: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"aiPageJobs">;
};
