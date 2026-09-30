// Model-quality history (ADRs 0025 and 0026): the scores of scheduled live evaluation runs,
// followed per series. A series is one model, its grader, one role version and one task.

export interface QualityRunPoint {
  runId: string;
  runAt: string;
  trials: number;
  /** 0 to 1. */
  passRate: number;
  /** 0 to 1. */
  meanScore: number;
}

export type QualitySeriesStatus = 'NEW' | 'STEADY' | 'IMPROVED' | 'REGRESSED';

export interface QualitySeries {
  provider: string;
  model: string;
  judgeModel: string;
  /** Role version, `<blueprint id>@<version>`. */
  blueprint: string;
  task: string;
  /** Oldest first. */
  runs: QualityRunPoint[];
  latest: QualityRunPoint;
  /** The earlier runs' trials pooled, or null when this is the series' first run. */
  baseline: { runs: number; passRate: number; meanScore: number } | null;
  status: QualitySeriesStatus;
  /** Why a series regressed, such as `pass rate 100% → 33%`. */
  reasons: string[];
}

/** `GET /api/catalog/v1/quality`. */
export interface ModelQualityOverview {
  /** Results from runs at or after this instant are included. */
  since: string;
  /** When the latest results were imported, or null before any. */
  lastImportedAt: string | null;
  series: QualitySeries[];
}
