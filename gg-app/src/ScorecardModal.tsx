import { Modal } from "./Modal";
import type { ProgressSnapshot } from "./agent";

interface ScorecardModalProps {
  snapshot: ProgressSnapshot;
  onClose: () => void;
}

function fmt(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Soft-scale a stat onto 0–100 for its mini bar. Log curve so early numbers
 *  still show a visible sliver and huge numbers don't need a huge max. */
function statPercent(value: number, softMax: number): number {
  if (value <= 0) return 0;
  const p = Math.log1p(value) / Math.log1p(softMax);
  return Math.max(4, Math.min(100, Math.round(p * 100)));
}

interface StatRow {
  label: string;
  value: string;
  percent: number;
}

/** RPG character-card scorecard: rank header, level + XP bar, stat bars. */
export function ScorecardModal({ snapshot, onClose }: ScorecardModalProps): React.ReactElement {
  const stats: StatRow[] = [
    {
      label: "Streak",
      value: `${snapshot.streak.current}d`,
      percent: statPercent(snapshot.streak.current, 30),
    },
    {
      label: "Prompts",
      value: fmt(snapshot.totals.prompts),
      percent: statPercent(snapshot.totals.prompts, 5000),
    },
    {
      label: "Commits",
      value: fmt(snapshot.totals.commits),
      percent: statPercent(snapshot.totals.commits, 2000),
    },
    {
      label: "Lines shipped",
      value: fmt(snapshot.totals.linesShipped),
      percent: statPercent(snapshot.totals.linesShipped, 500000),
    },
  ];
  return (
    <Modal
      title={
        <span className={`scorecard-rank rank-fx-${snapshot.effectId}`}>{snapshot.rankName}</span>
      }
      onClose={onClose}
      className="scorecard-modal"
    >
      <div className="scorecard">
        <div className="scorecard-tier">{snapshot.tierName} tier</div>

        <div className="scorecard-level">
          <span className="scorecard-level-num">{snapshot.level}</span>
          <div className="scorecard-level-meter">
            <div className="scorecard-level-row">
              <span>Level</span>
              <span>
                {fmt(snapshot.xpIntoLevel)} / {fmt(snapshot.xpForLevel)} XP · {snapshot.percent}%
              </span>
            </div>
            <div className="scorecard-bar" aria-hidden="true">
              <span style={{ width: `${snapshot.percent}%` }} />
            </div>
          </div>
        </div>

        <div className="scorecard-divider" aria-hidden="true" />

        <div className="scorecard-stats">
          {stats.map((stat) => (
            <div className="scorecard-stat" key={stat.label}>
              <span className="scorecard-stat-label">{stat.label}</span>
              <div className="scorecard-stat-bar">
                <span style={{ width: `${stat.percent}%` }} />
              </div>
              <b>{stat.value}</b>
            </div>
          ))}
        </div>

        <div className="scorecard-footer">
          <span>Member since</span>
          <b>{dateLabel(snapshot.memberSince)}</b>
        </div>
      </div>
    </Modal>
  );
}
