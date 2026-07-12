import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default(""),
  title: text("title").notNull(),
  idea: text("idea").default(""),
  script: text("script").default(""),
  outline: text("outline").default(""),
  status: text("status", {
    enum: ["draft", "processing", "completed"],
  })
    .notNull()
    .default("draft"),
  finalVideoUrl: text("final_video_url"),
  generationMode: text('generation_mode', { enum: ['keyframe', 'reference'] }).notNull().default('keyframe'),
  useProjectPrompts: integer("use_project_prompts").notNull().default(0),
  colorPalette: text("color_palette").default(""),
  worldSetting: text("world_setting").default(""),
  targetDuration: integer("target_duration").default(0),
  bgmUrl: text("bgm_url").default(""),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const episodes = sqliteTable("episodes", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sequence: integer("sequence").notNull(),
  idea: text("idea").default(""),
  script: text("script").default(""),
  outline: text("outline").default(""),
  status: text("status", {
    enum: ["draft", "processing", "completed"],
  })
    .notNull()
    .default("draft"),
  generationMode: text("generation_mode", { enum: ["keyframe", "reference"] })
    .notNull()
    .default("keyframe"),
  description: text("description").default(""),
  keywords: text("keywords").default(""),
  scriptHash: text("script_hash").default(""),
  colorPalette: text("color_palette").default(""),
  targetDuration: integer("target_duration").default(0),
  bgmUrl: text("bgm_url").default(""),
  finalVideoUrl: text("final_video_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").default(""),
  visualHint: text("visual_hint").default(""),
  referenceImage: text("reference_image"),
  referenceImageHistory: text("reference_image_history").default("[]"),
  scope: text("scope", { enum: ["main", "guest"] }).notNull().default("main"),
  performanceStyle: text("performance_style").default(""),
  heightCm: integer("height_cm").default(0),
  bodyType: text("body_type").default("average"),
  isStale: integer("is_stale").notNull().default(0),
  episodeId: text("episode_id").references(() => episodes.id, {
    onDelete: "cascade",
  }),
});

export const episodeCharacters = sqliteTable("episode_characters", {
  id: text("id").primaryKey(),
  episodeId: text("episode_id")
    .notNull()
    .references(() => episodes.id, { onDelete: "cascade" }),
  characterId: text("character_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
});

export const storyboardVersions = sqliteTable("storyboard_versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  versionNum: integer("version_num").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  episodeId: text("episode_id").references(() => episodes.id, {
    onDelete: "cascade",
  }),
});

export const scenes = sqliteTable("scenes", {
  id: text("id").primaryKey(),
  episodeId: text("episode_id")
    .notNull()
    .references(() => episodes.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull().default(""),
  description: text("description").default(""),
  lighting: text("lighting").default(""),
  colorPalette: text("color_palette").default(""),
  sequence: integer("sequence").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Unified per-shot asset table.
 * One row = one generated artifact (image prompt+file, or video file) bound
 * to a specific shot via shot_id. The `type` column discriminates which
 * generation mode it belongs to:
 *   - 'first_frame' / 'last_frame'  → keyframe mode image assets
 *   - 'reference'                   → reference mode image assets
 *   - 'keyframe_video'              → keyframe mode video output
 *   - 'reference_video'             → reference mode video output
 *
 * Versioning: regenerating the same asset inserts a new row with
 * (asset_version + 1, is_active=1) and flips the previous active row to
 * is_active=0. Active row = "current"; older rows = history.
 *
 * Two modes coexist freely on the same shot — they live in different rows
 * with different `type` values and never collide.
 */
export const shotAssets = sqliteTable("shot_assets", {
  id: text("id").primaryKey(),
  shotId: text("shot_id")
    .notNull()
    .references(() => shots.id, { onDelete: "cascade" }),
  type: text("type", {
    enum: [
      "first_frame",
      "last_frame",
      "reference",
      "keyframe_video",
      "reference_video",
    ],
  }).notNull(),
  sequenceInType: integer("sequence_in_type").notNull().default(0),
  assetVersion: integer("asset_version").notNull().default(1),
  isActive: integer("is_active").notNull().default(1),
  prompt: text("prompt").notNull().default(""),
  fileUrl: text("file_url"),
  status: text("status", {
    enum: ["pending", "generating", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
  characters: text("characters"), // JSON array
  modelProvider: text("model_provider"),
  modelId: text("model_id"),
  meta: text("meta"), // JSON
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const shots = sqliteTable("shots", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  prompt: text("prompt").default(""),
  motionScript: text("motion_script"),
  cameraDirection: text("camera_direction").default("static"),
  duration: integer("duration").notNull().default(10),
  videoScript: text("video_script"),
  videoPrompt: text("video_prompt"),
  transitionIn: text("transition_in").default("cut"),
  transitionOut: text("transition_out").default("cut"),
  episodeId: text("episode_id").references(() => episodes.id, {
    onDelete: "cascade",
  }),
  versionId: text("version_id").references(() => storyboardVersions.id, {
    onDelete: "cascade",
  }),
  sceneId: text("scene_id"),
  compositionGuide: text("composition_guide").default(""),
  focalPoint: text("focal_point").default(""),
  depthOfField: text("depth_of_field").default("medium"),
  soundDesign: text("sound_design").default(""),
  musicCue: text("music_cue").default(""),
  costumeOverrides: text("costume_overrides").default(""),
  isStale: integer("is_stale").notNull().default(0),
  status: text("status", {
    enum: ["pending", "generating", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
});

export const dialogues = sqliteTable("dialogues", {
  id: text("id").primaryKey(),
  shotId: text("shot_id")
    .notNull()
    .references(() => shots.id, { onDelete: "cascade" }),
  characterId: text("character_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  audioUrl: text("audio_url"),
  sequence: integer("sequence").notNull().default(0),
  startRatio: text("start_ratio").default("0"),
  endRatio: text("end_ratio").default("1"),
});

export const importLogs = sqliteTable("import_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  step: integer("step").notNull(),
  status: text("status", { enum: ["running", "done", "error"] })
    .notNull()
    .default("running"),
  message: text("message").notNull().default(""),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const promptTemplates = sqliteTable("prompt_templates", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  promptKey: text("prompt_key").notNull(),
  slotKey: text("slot_key"),
  scope: text("scope", { enum: ["global", "project"] }).notNull().default("global"),
  projectId: text("project_id"),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const promptVersions = sqliteTable("prompt_versions", {
  id: text("id").primaryKey(),
  templateId: text("template_id")
    .notNull()
    .references(() => promptTemplates.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const promptPresets = sqliteTable("prompt_presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  userId: text("user_id"),
  promptKey: text("prompt_key").notNull(),
  slots: text("slots", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const characterRelations = sqliteTable("character_relations", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  characterAId: text("character_a_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  characterBId: text("character_b_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  relationType: text("relation_type").notNull().default("neutral"),
  description: text("description").default(""),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const characterCostumes = sqliteTable("character_costumes", {
  id: text("id").primaryKey(),
  characterId: text("character_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("default"),
  description: text("description").default(""),
  referenceImage: text("reference_image"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const moodBoardImages = sqliteTable("mood_board_images", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  imageUrl: text("image_url").notNull(),
  annotation: text("annotation").default(""),
  extractedStyle: text("extracted_style").default(""),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const shotActions = sqliteTable("shot_actions", {
  id: text("id").primaryKey(),
  shotId: text("shot_id")
    .notNull()
    .references(() => shots.id, { onDelete: "cascade" }),
  characterId: text("character_id"),
  bodyPart: text("body_part").default("full_body"),
  motion: text("motion").notNull().default(""),
  startTime: text("start_time").default("0"),
  endTime: text("end_time").default("0"),
  intensity: text("intensity").default("normal"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const promptAbTests = sqliteTable("prompt_ab_tests", {
  id: text("id").primaryKey(),
  promptKey: text("prompt_key").notNull(),
  variantA: text("variant_a").notNull(),
  variantB: text("variant_b").notNull(),
  shotId: text("shot_id"),
  resultAUrl: text("result_a_url"),
  resultBUrl: text("result_b_url"),
  preferred: text("preferred"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  type: text("type", {
    enum: [
      "script_outline",
      "script_parse",
      "character_extract",
      "character_image",
      "shot_split",
      "frame_generate",
      "video_generate",
      "video_assemble",
    ],
  }).notNull(),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
  payload: text("payload", { mode: "json" }),
  result: text("result", { mode: "json" }),
  error: text("error"),
  retries: integer("retries").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
  episodeId: text("episode_id").references(() => episodes.id, {
    onDelete: "cascade",
  }),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default(""),
  name: text("name").notNull(),
  category: text("category", {
    enum: ["script_outline", "script_generate", "script_parse", "character_extract", "shot_split", "keyframe_prompts", "video_prompts", "ref_image_prompts", "ref_video_prompts"],
  }).notNull(),
  platform: text("platform", {
    enum: ["bailian", "dify", "coze"],
  }).notNull().default("bailian"),
  appId: text("app_id").notNull(),
  apiKey: text("api_key").notNull(),
  description: text("description").default(""),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const agentBindings = sqliteTable("agent_bindings", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  category: text("category", {
    enum: ["script_outline", "script_generate", "script_parse", "character_extract", "shot_split", "keyframe_prompts", "video_prompts", "ref_image_prompts", "ref_video_prompts"],
  }).notNull(),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
});

// ============================================================
// v2.0: 本地工作流平台 — 执行后端、工作流供应链、任务与资源
// ============================================================

export const resourcePools = sqliteTable("resource_pools", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  capacity: integer("capacity").notNull().default(1),
  policyJson: text("policy_json", { mode: "json" }).notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const executionBackends = sqliteTable("execution_backends", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  adapterKind: text("adapter_kind").notNull(),
  baseUrl: text("base_url").notNull(),
  topology: text("topology", {
    enum: ["same-host", "container-to-host", "same-host-container", "lan-remote"],
  }).notNull(),
  sharingMode: text("sharing_mode", {
    enum: ["dedicated", "shared"],
  }).notNull(),
  authType: text("auth_type", {
    enum: ["none", "bearer", "header-token", "basic", "mtls"],
  }).notNull(),
  authConfigJson: text("auth_config_json", { mode: "json" }).notNull(),
  tlsConfigJson: text("tls_config_json", { mode: "json" }).notNull(),
  networkPolicyJson: text("network_policy_json", { mode: "json" }).notNull(),
  resourcePoolId: text("resource_pool_id")
    .notNull()
    .references(() => resourcePools.id),
  capabilitiesJson: text("capabilities_json", { mode: "json" }).notNull(),
  environmentFingerprint: text("environment_fingerprint"),
  featureSnapshotJson: text("feature_snapshot_json", { mode: "json" }),
  validatedAtMs: integer("validated_at_ms"),
  enabled: integer("enabled").notNull().default(0),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const workflowPackageRevisions = sqliteTable("workflow_package_revisions", {
  digest: text("digest").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  version: text("version").notNull(),
  capability: text("capability", {
    enum: ["image", "video", "speech", "utility"],
  }).notNull(),
  manifestJson: text("manifest_json", { mode: "json" }).notNull(),
  compiledBindingsJson: text("compiled_bindings_json", { mode: "json" }).notNull(),
  packageLockJson: text("package_lock_json", { mode: "json" }).notNull(),
  packagePath: text("package_path").notNull(),
  workflowSha256: text("workflow_sha256").notNull(),
  environmentLockDigest: text("environment_lock_digest"),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const workflowPackageStates = sqliteTable("workflow_package_states", {
  workflowPackageDigest: text("workflow_package_digest")
    .primaryKey()
    .references(() => workflowPackageRevisions.digest),
  state: text("state", {
    enum: ["installed", "validating", "reviewed", "active", "deprecated", "revoked", "invalid"],
  }).notNull(),
  validationReportJson: text("validation_report_json", { mode: "json" }),
  reviewedBy: text("reviewed_by"),
  reviewedAtMs: integer("reviewed_at_ms"),
  revokedAtMs: integer("revoked_at_ms"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const generationProfileRevisions = sqliteTable("generation_profile_revisions", {
  id: text("id").primaryKey(),
  profileKey: text("profile_key").notNull(),
  revisionNo: integer("revision_no").notNull(),
  revisionDigest: text("revision_digest").notNull().unique(),
  displayName: text("display_name").notNull(),
  capability: text("capability", {
    enum: ["text", "image", "video", "speech", "utility"],
  }).notNull(),
  adapterKind: text("adapter_kind").notNull(),
  executionBackendId: text("execution_backend_id").references(() => executionBackends.id),
  workflowPackageDigest: text("workflow_package_digest").references(() => workflowPackageRevisions.digest),
  configJson: text("config_json", { mode: "json" }).notNull(),
  createdBy: text("created_by"),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const generationProfileStates = sqliteTable("generation_profile_states", {
  generationProfileRevisionId: text("generation_profile_revision_id")
    .primaryKey()
    .references(() => generationProfileRevisions.id),
  enabled: integer("enabled").notNull().default(0),
  visibility: text("visibility", {
    enum: ["admin", "workspace", "project"],
  }).notNull().default("admin"),
  deprecatedAtMs: integer("deprecated_at_ms"),
  revokedAtMs: integer("revoked_at_ms"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const defaultGenerationProfilePointers = sqliteTable("default_generation_profile_pointers", {
  scopeType: text("scope_type", {
    enum: ["global", "workspace", "project", "user"],
  }).notNull(),
  scopeId: text("scope_id").notNull(),
  capability: text("capability", {
    enum: ["text", "image", "video", "speech"],
  }).notNull(),
  generationProfileRevisionId: text("generation_profile_revision_id")
    .notNull()
    .references(() => generationProfileRevisions.id),
  updatedBy: text("updated_by"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const generationJobs = sqliteTable("generation_jobs", {
  id: text("id").primaryKey(),
  businessTaskId: text("business_task_id"),
  projectId: text("project_id"),
  capability: text("capability", {
    enum: ["text", "image", "video", "speech", "utility"],
  }).notNull(),
  status: text("status", {
    enum: ["QUEUED", "RUNNING", "CANCEL_REQUESTED", "SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_ATTENTION"],
  }).notNull().default("QUEUED"),
  executionSnapshotJson: text("execution_snapshot_json", { mode: "json" }).notNull(),
  inputDigest: text("input_digest").notNull(),
  dedupeScope: text("dedupe_scope"),
  currentAttemptId: text("current_attempt_id"),
  currentArtifactId: text("current_artifact_id"),
  claimOwner: text("claim_owner"),
  claimUntilMs: integer("claim_until_ms"),
  claimFencingToken: integer("claim_fencing_token").notNull().default(0),
  cancelRequestedAtMs: integer("cancel_requested_at_ms"),
  needsAttentionReason: text("needs_attention_reason"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  completedAtMs: integer("completed_at_ms"),
});

export const generationAttempts = sqliteTable("generation_attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => generationJobs.id, { onDelete: "cascade" }),
  attemptNo: integer("attempt_no").notNull(),
  phase: text("phase", {
    enum: [
      "CREATED", "LEASED", "PREPARING", "SUBMITTING",
      "SUBMISSION_UNKNOWN", "EXTERNAL_QUEUED", "EXTERNAL_RUNNING",
      "COLLECTING", "COMMITTING", "RETRY_WAIT",
      "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "CANCELLED", "ORPHANED",
    ],
  }).notNull(),
  backendId: text("backend_id")
    .notNull()
    .references(() => executionBackends.id),
  backendFeatureSnapshotJson: text("backend_feature_snapshot_json", { mode: "json" }).notNull(),
  environmentFingerprint: text("environment_fingerprint").notNull(),
  submissionCorrelationId: text("submission_correlation_id").notNull().unique(),
  externalIdStrategy: text("external_id_strategy", {
    enum: ["client-assigned", "server-assigned", "not-applicable"],
  }).notNull(),
  externalJobId: text("external_job_id"),
  externalQueueNumber: integer("external_queue_number"),
  systemOutputPrefix: text("system_output_prefix").notNull(),
  progressSnapshotJson: text("progress_snapshot_json", { mode: "json" }),
  errorClass: text("error_class"),
  errorCode: text("error_code"),
  errorMessageSafe: text("error_message_safe"),
  resourcePoolId: text("resource_pool_id")
    .notNull()
    .references(() => resourcePools.id),
  resourceSlotNo: integer("resource_slot_no").notNull(),
  resourceLeaseToken: text("resource_lease_token").notNull().unique(),
  resourceFencingToken: integer("resource_fencing_token").notNull(),
  submittedAtMs: integer("submitted_at_ms"),
  startedAtMs: integer("started_at_ms"),
  finishedAtMs: integer("finished_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const resourcePoolSlots = sqliteTable("resource_pool_slots", {
  resourcePoolId: text("resource_pool_id")
    .notNull()
    .references(() => resourcePools.id),
  slotNo: integer("slot_no").notNull(),
  ownerAttemptId: text("owner_attempt_id").references(() => generationAttempts.id),
  leaseToken: text("lease_token").unique(),
  fencingToken: integer("fencing_token").notNull().default(0),
  expiresAtMs: integer("expires_at_ms"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const generationArtifacts = sqliteTable("generation_artifacts", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id")
    .notNull()
    .references(() => generationAttempts.id),
  logicalName: text("logical_name").notNull(),
  kind: text("kind", {
    enum: ["image", "video", "audio", "text", "archive"],
  }).notNull(),
  status: text("status", {
    enum: ["STAGING", "COMMITTED", "QUARANTINED", "DELETED"],
  }).notNull(),
  storageKey: text("storage_key").notNull().unique(),
  visibility: text("visibility", {
    enum: ["private-original", "project", "export"],
  }).notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  metadataJson: text("metadata_json", { mode: "json" }).notNull(),
  parentArtifactId: text("parent_artifact_id"),
  committedAtMs: integer("committed_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const generationEvents = sqliteTable("generation_events", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => generationJobs.id, { onDelete: "cascade" }),
  attemptId: text("attempt_id").references(() => generationAttempts.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  severity: text("severity", {
    enum: ["debug", "info", "warning", "error", "security"],
  }).notNull(),
  safePayloadJson: text("safe_payload_json", { mode: "json" }).notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const businessTaskGenerationJobs = sqliteTable("business_task_generation_jobs", {
  businessTaskId: text("business_task_id").notNull(),
  generationJobId: text("generation_job_id")
    .notNull()
    .references(() => generationJobs.id, { onDelete: "cascade" }),
  relationKind: text("relation_kind").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  detailsSafeJson: text("details_safe_json", { mode: "json" }).notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
});

/** 服务端密钥引用：密钥只存服务端，浏览器只传引用 ID */
export const keyReferences = sqliteTable("key_references", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  keyType: text("key_type", {
    enum: ["bearer", "header-token", "basic", "mtls-key"],
  }).notNull(),
  /** 加密存储的密钥值（阶段 B 先用明文，后续接入密钥管理服务） */
  secretValue: text("secret_value").notNull(),
  createdBy: text("created_by"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});
