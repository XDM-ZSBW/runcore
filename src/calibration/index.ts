export {
  type AutonomyLevel,
  type VisibilityLevel,
  type EscalationSpeed,
  type VerbosityLevel,
  type ProactivityLevel,
  type PacePreference,
  type JoyFrequency,
  type CalibrationThresholds,
  type DotThresholds,
  type CalibrationSource,
  type CalibrationResult,
  type CalibrationDelta,
  type RecalibrationTriggerConfig,
  type CalibrationPhase,
  type CalibrationState,
  type CalibrationDimension,
  type CalibrationQuestion,
  type CalibrationInterpretation,
  type ArchetypeCalibrationStyle,
  type ArchetypeCalibrationProfile,
  DEFAULT_THRESHOLDS,
  DEFAULT_DOT_THRESHOLDS,
  DEFAULT_TRIGGER_CONFIG,
  ARCHETYPE_PROFILES,
} from "./types.js";

export {
  initCalibrationStore,
  saveCalibration,
  getCurrentCalibration,
  getCalibrationHistory,
  getLatestVersion,
  computeDelta,
  buildCalibrationResult,
  isCalibrated,
  saveTriggerCounters,
  loadTriggerCounters,
  type TriggerCounters,
} from "./store.js";

export {
  ONBOARDING_QUESTIONS,
  JOY_BASELINE_QUESTION,
  interpretResponse,
  buildConfirmation,
  deriveThresholds,
  applySeedBaseline,
  getQuestionsForDimensions,
  mergeWithDefaults,
} from "./conversation.js";

export {
  CalibrationRunner,
  type CalibrationListener,
  type CalibrationEvent,
  type JoyHistoryProvider,
  type JoyEntry,
} from "./runner.js";
