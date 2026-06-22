import { memo } from "react";
import { Icon } from "../icons.js";
import {
  LIFECYCLE_DOT,
  LIFECYCLE_LABEL,
  type Lifecycle,
} from "../lifecycle.js";

/** One repo's row in the passive module rail: its name, durable lifecycle state
 * (the colored dot), a numberless viewed-progress bar, and whether its module is
 * currently collapsed (drives the caret). `progress` is the viewed fraction 0..1. */
export interface RailModule {
  repo: string;
  state: Lifecycle;
  progress: number;
  collapsed: boolean;
}

// Rollup segment + tally order. The lifecycle's resting order is
// idle → in-progress → ready → archived; the workspace bar reads the most-settled
// states first (ready, then in-progress, then the untouched/done bookends) so the
// fill grows left as the workspace advances.
const ROLLUP_ORDER: Lifecycle[] = ["ready", "in-progress", "idle", "archived"];

/**
 * The passive module-nav rail atop the sidebar in the stacked (N≥2) layout.
 * Read-only wayfinding: each row jumps to its module and shows that module's
 * lifecycle dot + viewed progress; the footer rolls the whole workspace into one
 * proportional bar + tally. It never drives scroll-focus — the module scroll-spy
 * owns the active repo, so a row click just scrolls there, exactly like a sidebar
 * repo click. Rendered only at N≥2; at N=1 the parent omits it, keeping that
 * layout byte-identical to the pre-modules-view sidebar.
 */
export const ModuleRail = memo(function ModuleRail({
  modules,
  activeRepo,
  onSelect,
  onCollapseAll,
  onExpandAll,
}: {
  modules: RailModule[];
  activeRepo: string;
  onSelect: (repo: string) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  const total = modules.length;
  const allCollapsed = total > 0 && modules.every((m) => m.collapsed);

  const counts = new Map<Lifecycle, number>();
  for (const m of modules) counts.set(m.state, (counts.get(m.state) ?? 0) + 1);
  const tally = ROLLUP_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => ({
    state: s,
    count: counts.get(s) ?? 0,
  }));

  return (
    <div className="module-rail">
      <div className="mr-title">
        <span>Modules · {total}</span>
        <button
          type="button"
          className="mr-collapse"
          onClick={allCollapsed ? onExpandAll : onCollapseAll}
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>

      {modules.map((m) => {
        const here = m.repo === activeRepo;
        return (
          <button
            key={m.repo}
            type="button"
            className={`mr-row${here ? " here" : ""}`}
            aria-current={here ? "true" : undefined}
            // The dot is aria-hidden, so name the lifecycle state here — a bare
            // `title` on a button with text content is ignored by screen readers.
            aria-label={`${m.repo}, ${LIFECYCLE_LABEL[m.state]}`}
            title={`${m.repo} — ${LIFECYCLE_LABEL[m.state]}`}
            onClick={() => onSelect(m.repo)}
          >
            <span className="mr-top">
              <Icon
                name={m.collapsed ? "chevron-right" : "chevron-down"}
                size={12}
                className="mr-caret"
              />
              <span className="mr-name">{m.repo}</span>
              <span
                className={`mr-dot ${LIFECYCLE_DOT[m.state]}`}
                aria-hidden="true"
              />
            </span>
            <span className="mr-bar" aria-hidden="true">
              <i
                style={{
                  width: `${Math.max(0, Math.min(100, Math.round(m.progress * 100)))}%`,
                }}
              />
            </span>
          </button>
        );
      })}

      {total > 0 && (
        <div className="mr-rollup">
          <div className="rollup-label">Workspace</div>
          <div className="rollup-bar" aria-hidden="true">
            {tally.map((t) => (
              <span
                key={t.state}
                className={`rb ${LIFECYCLE_DOT[t.state]}`}
                style={{ width: `${(t.count / total) * 100}%` }}
              />
            ))}
          </div>
          <div className="rollup-tally">
            {tally.map((t) => (
              <span key={t.state} className="tally-row">
                <span
                  className={`swatch ${LIFECYCLE_DOT[t.state]}`}
                  aria-hidden="true"
                />
                {t.count} {LIFECYCLE_LABEL[t.state].toLowerCase()}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
