import { STAGES } from "../types";
import type { Feature, Stage } from "../types";

export const STAGE_LABELS: Record<Stage, string> = {
  not_started: "Not started",
  spec: "Spec",
  interfaces: "Interfaces",
  plan: "Plan",
  implementing: "Implementing",
  in_review: "In review",
  merge_ready: "Merge ready",
  merged: "Merged",
};

function FeatureCard({ feature }: { feature: Feature }): JSX.Element {
  return (
    <li className="rounded-md border border-slate-200 bg-white p-2 shadow-sm">
      {feature.pr_url ? (
        <a
          href={feature.pr_url}
          className="break-words text-sm font-medium text-blue-700 underline"
        >
          {feature.name}
        </a>
      ) : (
        <span className="break-words text-sm font-medium text-slate-900">
          {feature.name}
        </span>
      )}
      <p className="mt-1 text-xs text-slate-500">{feature.owner ?? "unassigned"}</p>
      {feature.branch ? (
        <p className="mt-0.5 break-all text-xs text-slate-400">{feature.branch}</p>
      ) : null}
    </li>
  );
}

export function PipelineBoard(props: { features: Feature[] }): JSX.Element {
  const { features } = props;

  return (
    <section aria-label="Pipeline board" className="w-full p-3 sm:p-4">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Pipeline</h2>

      {features.length === 0 ? (
        <p className="mb-3 rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
          No features tracked yet.
        </p>
      ) : null}

      {/* 390px: columns stack vertically; from md up they sit side by side and
          the strip itself scrolls horizontally instead of the page body. */}
      <div className="flex flex-col gap-3 md:flex-row md:gap-4 md:overflow-x-auto md:pb-2">
        {STAGES.map((stage) => {
          const label = STAGE_LABELS[stage];
          const inStage = features.filter((f) => f.stage === stage);
          return (
            <section
              key={stage}
              aria-label={label}
              className="w-full shrink-0 rounded-lg bg-slate-100 p-2 md:w-64"
            >
              <h3 className="mb-2 flex items-center justify-between text-sm font-semibold text-slate-700">
                <span>{label}</span>
                <span className="text-xs font-normal text-slate-500">
                  {inStage.length}
                </span>
              </h3>
              <ul className="flex flex-col gap-2">
                {inStage.map((feature) => (
                  <FeatureCard key={feature.name} feature={feature} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export default PipelineBoard;
