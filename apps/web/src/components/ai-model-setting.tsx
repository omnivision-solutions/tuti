"use client";

import { cn } from "cn";
import { useId, useOptimistic, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { SettingRow } from "@/components/settings-card";
import { Input } from "@/components/ui/input";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import type { AiModelSettingProps } from "@/lib/ai-model-setting";
import { costLabel, costPerUse } from "@/lib/model-tiers";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";
import { saveAiModel } from "@/server/ai-models";

/**
 * A settings page's "AI model" (docs/plan.md, AI models by role): one level for a group of roles, saved as it's chosen;
 * Custom lists a model for each role. Its props come from `aiModelSetting` on the server. A level the plan doesn't
 * include looks like any other and opens the upgrade prompt, saving nothing.
 */
export function AiModelSetting({ projectSlug, group, saved, used, levels, summary, notice, roles, listed, creditsPerDollar }: AiModelSettingProps) {
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(used);
  // The last prompt opened stays while the dialog closes.
  const [prompt, setPrompt] = useState<UpgradePrompt | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const id = useId();

  /** Whether it was saved. */
  const save = (input: Parameters<typeof saveAiModel>[1], level?: typeof used) =>
    new Promise<boolean>((resolve) =>
      startTransition(async () => {
        if (level) {
          setShown(level);
        }
        const result = await saveAiModel(projectSlug, input);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success("AI model saved");
        }
        resolve(!result.error);
      }),
    );

  return (
    <div>
      <SettingRow label={<span id={`${id}-label`}>AI model</span>} description={summary}>
        {/* ponytail: each segment is a tab stop; arrow keys between them (roving focus) if anyone asks. */}
        <div role="radiogroup" aria-labelledby={`${id}-label`} className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-muted-foreground @min-[34rem]/settings:flex @min-[34rem]/settings:w-fit">
          {levels.map(({ level, name, upgrade }) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={shown === level}
              aria-describedby={upgrade ? `${id}-${level}` : undefined}
              // Not `disabled` while it saves: the segment just chosen would lose focus.
              aria-disabled={pending || undefined}
              onClick={() => {
                if (pending) {
                  return;
                }
                if (upgrade) {
                  setPrompt(upgrade);
                  setUpgrading(true);
                } else if (level !== saved) {
                  // The one in use but not the one saved (Balanced, standing in for a level the plan lacks) can be chosen too.
                  save({ levels: { [group]: level } }, level);
                }
              }}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                shown === level && "bg-background text-foreground shadow-sm",
              )}
            >
              {name}
            </button>
          ))}
        </div>
        {levels.map(
          ({ level, upgrade }) =>
            upgrade && (
              <span key={level} id={`${id}-${level}`} hidden>
                {upgrade.title}
              </span>
            ),
        )}
      </SettingRow>
      {(notice || shown === "custom") && (
        <div className="-mt-1 flex flex-col gap-3 px-4 pb-4 text-sm @min-[34rem]/settings:px-5">
          {notice && <p className="text-muted-foreground">{notice}</p>}
          {shown === "custom" && (
            <div className="flex flex-col gap-3 border-l pl-4">
              {roles.map((role) => (
                <RoleModel key={role.role} {...role} listed={role.agent ? listed.filter((model) => model.tools) : listed} creditsPerDollar={creditsPerDollar} onPick={(model) => save({ [role.role]: model })} />
              ))}
            </div>
          )}
        </div>
      )}
      {prompt && <UpgradeDialog prompt={prompt} open={upgrading} onOpenChange={setUpgrading} />}
    </div>
  );
}

/** One role's model under Custom: an id from the endpoint's list, or typed; saved when one is picked from the list, a typed one on Enter or leaving the box. Empty is the server's own. */
function RoleModel({
  role,
  label,
  model,
  default: fallback,
  listed,
  creditsPerDollar,
  onPick,
}: AiModelSettingProps["roles"][number] & Pick<AiModelSettingProps, "listed" | "creditsPerDollar"> & { onPick: (model: string) => Promise<boolean> }) {
  const [value, setValue] = useState(model);
  // What was last sent, so picking from the list and then leaving the box saves once.
  const sent = useRef(model);
  const id = useId();
  const pick = async (next: string) => {
    if (next.trim() !== sent.current) {
      sent.current = next.trim();
      // One the server refused can be sent again.
      if (!(await onPick(next.trim())) && sent.current === next.trim()) {
        sent.current = model;
      }
    }
  };
  const price = costLabel(costPerUse(role, listed.find((listing) => listing.id === (value.trim() || fallback))), creditsPerDollar);
  return (
    <div className="flex flex-col gap-1.5 @min-[34rem]/settings:flex-row @min-[34rem]/settings:items-center @min-[34rem]/settings:gap-4">
      <label htmlFor={id} className="w-24 shrink-0 font-medium">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Input
          id={id}
          list={`${id}-models`}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            // Chosen from the list (browsers mark it so, or don't mark it at all), not typed: an id typed may be the start of a longer one.
            const how = (event.nativeEvent as InputEvent).inputType;
            if ((how === undefined || how === "insertReplacementText") && listed.some((listing) => listing.id === event.target.value)) {
              void pick(event.target.value);
            }
          }}
          onBlur={() => void pick(value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void pick(value);
            }
          }}
          placeholder={fallback}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id={`${id}-models`}>
          {listed.map((listing) => (
            <option key={listing.id} value={listing.id}>
              {listing.name}
            </option>
          ))}
        </datalist>
        {price && <p className="text-xs text-muted-foreground">{price}</p>}
      </div>
    </div>
  );
}
